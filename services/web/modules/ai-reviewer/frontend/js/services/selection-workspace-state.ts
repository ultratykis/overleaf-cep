import type {
  AgentEvent,
  AgentRequest,
  Finding,
  ProposedSuggestion,
} from "../../../shared/contract-types";
import type {
  EditorSelectionSession,
  EditorSelectionSessionConflictCode,
} from "./editor-selection-session";
import type { EditorSuggestionApplicationConflictCode } from "./editor-suggestion-application";

export type SelectionWorkspaceStatus =
  | "idle"
  | "capturing"
  | "streaming"
  | "finalizing"
  | "completed"
  | "conflict"
  | "cancelled"
  | "error";

export type SelectionSuggestionDecision =
  | {
      status: "applied" | "discarded" | "cancelled" | "error";
    }
  | {
      status: "conflict";
      code: EditorSuggestionApplicationConflictCode;
    };

export type FindingArtifactStatus = "unresolved" | "discarded";

export type SuggestionArtifactStatus =
  | "unresolved"
  | "applied"
  | "discarded"
  | "conflict";

export type SelectionWorkspaceState = {
  status: SelectionWorkspaceStatus;
  generation: number;
  createdOrder: number;
  requestId: string | null;
  scopeKind: AgentRequest["scope"]["kind"] | null;
  request: AgentRequest | null;
  session: EditorSelectionSession | null;
  text: string;
  findings: Finding[];
  suggestions: ProposedSuggestion[];
  findingStatuses: Readonly<Record<string, FindingArtifactStatus | undefined>>;
  suggestionStatuses: Readonly<
    Record<string, SuggestionArtifactStatus | undefined>
  >;
  suggestionConflictCodes: Readonly<
    Record<string, EditorSuggestionApplicationConflictCode | undefined>
  >;
  conflict: EditorSelectionSessionConflictCode | null;
  error: string | null;
};

type BoundAction = {
  generation: number;
  requestId: string;
};

export type SelectionWorkspaceAction =
  | (BoundAction & {
      type: "begin";
      status: "capturing" | "streaming";
      scopeKind?: AgentRequest["scope"]["kind"];
      createdOrder?: number;
    })
  | (BoundAction & {
      type: "request";
      request: AgentRequest;
    })
  | (BoundAction & {
      type: "session";
      session: EditorSelectionSession;
    })
  | (BoundAction & {
      type: "event";
      event: AgentEvent;
    })
  | (BoundAction & {
      type: "completed";
    })
  | (BoundAction & {
      type: "suggestion-decision";
      suggestionId: string;
      decision: SelectionSuggestionDecision;
    })
  | (BoundAction & {
      type: "discard-finding";
      findingId: string;
    })
  | (BoundAction & {
      type: "discard-suggestion";
      suggestionId: string;
    })
  | (BoundAction & {
      type: "conflict";
      conflict: EditorSelectionSessionConflictCode;
    })
  | (BoundAction & {
      type: "cancelled";
    })
  | (BoundAction & {
      type: "error";
      error: string;
    });

export const initialSelectionWorkspaceState: SelectionWorkspaceState = {
  status: "idle",
  generation: 0,
  createdOrder: 0,
  requestId: null,
  scopeKind: null,
  request: null,
  session: null,
  text: "",
  findings: [],
  suggestions: [],
  findingStatuses: {},
  suggestionStatuses: {},
  suggestionConflictCodes: {},
  conflict: null,
  error: null,
};

function isBoundToState(state: SelectionWorkspaceState, action: BoundAction) {
  return (
    state.generation === action.generation &&
    state.requestId === action.requestId
  );
}

export function reduceSelectionWorkspaceState(
  state: SelectionWorkspaceState,
  action: SelectionWorkspaceAction,
): SelectionWorkspaceState {
  if (action.type === "begin") {
    return {
      status: action.status,
      generation: action.generation,
      createdOrder: action.createdOrder ?? action.generation,
      requestId: action.requestId,
      scopeKind: action.scopeKind ?? null,
      request: null,
      session: null,
      text: "",
      findings: [],
      suggestions: [],
      findingStatuses: {},
      suggestionStatuses: {},
      suggestionConflictCodes: {},
      conflict: null,
      error: null,
    };
  }

  if (!isBoundToState(state, action)) {
    return state;
  }

  if (action.type === "session") {
    if (state.status !== "capturing") {
      return state;
    }
    return {
      ...state,
      status: "streaming",
      scopeKind: action.session.request.scope.kind,
      request: action.session.request,
      session: action.session,
    };
  }

  if (action.type === "request") {
    if (
      state.status !== "streaming" ||
      action.request.requestId !== state.requestId
    ) {
      return state;
    }
    return {
      ...state,
      scopeKind: action.request.scope.kind,
      request: action.request,
    };
  }

  if (action.type === "event") {
    if (
      state.status !== "streaming" ||
      action.event.requestId !== state.requestId
    ) {
      return state;
    }

    if (action.event.type === "text.delta") {
      return {
        ...state,
        text: `${state.text}${action.event.delta}`,
      };
    }
    if (action.event.type === "finding") {
      return {
        ...state,
        findings: [...state.findings, action.event.finding],
        findingStatuses: {
          ...state.findingStatuses,
          [action.event.finding.id]: "unresolved",
        },
      };
    }
    if (action.event.type === "suggestion") {
      return {
        ...state,
        suggestions: [...state.suggestions, action.event.suggestion],
        suggestionStatuses: {
          ...state.suggestionStatuses,
          [action.event.suggestion.id]: "unresolved",
        },
      };
    }
    if (action.event.type === "completed") {
      return {
        ...state,
        status: "finalizing",
      };
    }
    if (action.event.type === "error") {
      return {
        ...state,
        status: "error",
        error: action.event.error.message,
      };
    }
    return state;
  }

  if (action.type === "completed") {
    if (state.status !== "finalizing") {
      return state;
    }
    return {
      ...state,
      status: "completed",
    };
  }

  if (action.type === "suggestion-decision") {
    const suggestion = state.suggestions.find(
      (candidate) => candidate.id === action.suggestionId,
    );
    if (
      state.status !== "completed" ||
      state.session == null ||
      suggestion == null ||
      suggestion.requestId !== state.requestId ||
      state.session.request.requestId !== state.requestId ||
      state.suggestionStatuses[action.suggestionId] !== "unresolved"
    ) {
      return state;
    }
    if (
      action.decision.status === "cancelled" ||
      action.decision.status === "error"
    ) {
      return state;
    }
    return {
      ...state,
      suggestionStatuses: {
        ...state.suggestionStatuses,
        [action.suggestionId]: action.decision.status,
      },
      suggestionConflictCodes:
        action.decision.status === "conflict"
          ? {
              ...state.suggestionConflictCodes,
              [action.suggestionId]: action.decision.code,
            }
          : state.suggestionConflictCodes,
    };
  }

  if (action.type === "discard-finding") {
    const finding = state.findings.find(
      (candidate) => candidate.id === action.findingId,
    );
    if (
      state.status !== "completed" ||
      finding == null ||
      finding.requestId !== state.requestId ||
      state.findingStatuses[action.findingId] !== "unresolved"
    ) {
      return state;
    }
    return {
      ...state,
      findingStatuses: {
        ...state.findingStatuses,
        [action.findingId]: "discarded",
      },
    };
  }

  if (action.type === "discard-suggestion") {
    const suggestion = state.suggestions.find(
      (candidate) => candidate.id === action.suggestionId,
    );
    const currentStatus = state.suggestionStatuses[action.suggestionId];
    if (
      state.status !== "completed" ||
      suggestion == null ||
      suggestion.requestId !== state.requestId ||
      (currentStatus !== "unresolved" && currentStatus !== "conflict")
    ) {
      return state;
    }
    return {
      ...state,
      suggestionStatuses: {
        ...state.suggestionStatuses,
        [action.suggestionId]: "discarded",
      },
      suggestionConflictCodes: {
        ...state.suggestionConflictCodes,
        [action.suggestionId]: undefined,
      },
    };
  }

  if (action.type === "conflict") {
    return {
      ...state,
      status: "conflict",
      conflict: action.conflict,
      error: null,
    };
  }

  if (action.type === "cancelled") {
    return {
      ...state,
      status: "cancelled",
      conflict: null,
      error: null,
    };
  }

  return {
    ...state,
    status: "error",
    conflict: null,
    error: action.error,
  };
}

export type ReviewWorkspaceState = {
  runs: SelectionWorkspaceState[];
};

export const initialReviewWorkspaceState: ReviewWorkspaceState = {
  runs: [],
};

export function reduceReviewWorkspaceState(
  state: ReviewWorkspaceState,
  action: SelectionWorkspaceAction,
): ReviewWorkspaceState {
  if (action.type === "begin") {
    return {
      runs: [
        ...state.runs,
        reduceSelectionWorkspaceState(initialSelectionWorkspaceState, action),
      ],
    };
  }

  let changed = false;
  const runs = state.runs.map((run) => {
    if (
      run.generation !== action.generation ||
      run.requestId !== action.requestId
    ) {
      return run;
    }
    const next = reduceSelectionWorkspaceState(run, action);
    changed ||= next !== run;
    return next;
  });
  return changed ? { runs } : state;
}
