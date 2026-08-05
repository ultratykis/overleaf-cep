import type {
  AgentEvent,
  AgentRequest,
  Finding,
  ToolCall,
  UnresolvedSuggestion,
  WorkspaceRun,
} from "../../../shared/contract-types";

// A request without a scope is project-wide, so the panel has no scope kind to
// name for it.
export type ReviewScopeKind = NonNullable<AgentRequest["scope"]>["kind"];
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

export type FindingArtifactStatus = "unresolved" | "discarded" | "posted";

export type SuggestionArtifactStatus =
  | "unresolved"
  | "applied"
  | "discarded"
  | "conflict"
  | "posted";

export type SelectionWorkspaceState = {
  status: SelectionWorkspaceStatus;
  generation: number;
  createdOrder: number;
  requestId: string | null;
  scopeKind: ReviewScopeKind | null;
  request: AgentRequest | null;
  provider: string | null;
  model: string | null;
  group: WorkspaceRun["group"] | null;
  subject: string | null;
  session: EditorSelectionSession | null;
  text: string;
  toolCalls: ToolCall[];
  findings: Finding[];
  suggestions: UnresolvedSuggestion[];
  findingStatuses: Readonly<Record<string, FindingArtifactStatus | undefined>>;
  suggestionStatuses: Readonly<
    Record<string, SuggestionArtifactStatus | undefined>
  >;
  suggestionConflictCodes: Readonly<
    Record<string, EditorSuggestionApplicationConflictCode | undefined>
  >;
  conflict: EditorSelectionSessionConflictCode | null;
  error: string | null;
  errorCode: string | null;
};

type BoundAction = {
  generation: number;
  requestId: string;
};

export type SelectionWorkspaceAction =
  | (BoundAction & {
      type: "begin";
      status: "capturing" | "streaming";
      scopeKind?: ReviewScopeKind;
      createdOrder?: number;
      group?: WorkspaceRun["group"];
    })
  | (BoundAction & {
      type: "request";
      request: AgentRequest;
    })
  | (BoundAction & {
      type: "group";
      group: NonNullable<WorkspaceRun["group"]>;
    })
  | (BoundAction & {
      type: "session";
      session: EditorSelectionSession;
    })
  | (BoundAction & {
      type: "rebind-session";
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
      type: "post-finding";
      findingId: string;
    })
  | (BoundAction & {
      type: "discard-suggestion";
      suggestionId: string;
    })
  | (BoundAction & {
      type: "post-suggestion";
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
      errorCode: string;
    });

export type ReviewWorkspaceAction =
  | SelectionWorkspaceAction
  | {
      type: "hydrate";
      runs: readonly WorkspaceRun[];
    }
  | {
      type: "retain-runs";
      generations: readonly number[];
    };

export const initialSelectionWorkspaceState: SelectionWorkspaceState = {
  status: "idle",
  generation: 0,
  createdOrder: 0,
  requestId: null,
  scopeKind: null,
  request: null,
  provider: null,
  model: null,
  group: null,
  subject: null,
  session: null,
  text: "",
  toolCalls: [],
  findings: [],
  suggestions: [],
  findingStatuses: {},
  suggestionStatuses: {},
  suggestionConflictCodes: {},
  conflict: null,
  error: null,
  errorCode: null,
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
      provider: null,
      model: null,
      group: action.group ?? null,
      subject: null,
      session: null,
      text: "",
      toolCalls: [],
      findings: [],
      suggestions: [],
      findingStatuses: {},
      suggestionStatuses: {},
      suggestionConflictCodes: {},
      conflict: null,
      error: null,
      errorCode: null,
    };
  }

  if (!isBoundToState(state, action)) {
    return state;
  }

  if (action.type === "group") {
    return {
      ...state,
      group: action.group,
    };
  }

  if (action.type === "session") {
    if (state.status !== "capturing") {
      return state;
    }
    return {
      ...state,
      status: "streaming",
      scopeKind: action.session.request.scope?.kind ?? null,
      request: action.session.request,
      session: action.session,
    };
  }

  if (action.type === "rebind-session") {
    if (
      state.status !== "completed" ||
      state.request == null ||
      action.session.request !== state.request
    ) {
      return state;
    }
    return {
      ...state,
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
      scopeKind: action.request.scope?.kind ?? null,
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

    if (action.event.type === "started") {
      return {
        ...state,
        provider: action.event.provider,
        model: action.event.model,
      };
    }
    if (action.event.type === "text.delta") {
      return {
        ...state,
        text: `${state.text}${action.event.delta}`,
      };
    }
    if (action.event.type === "subject") {
      return {
        ...state,
        subject: action.event.subject,
      };
    }
    // A tool line is the only trace of the agent's reading that the panel is
    // allowed to show, so it is kept in arrival order.
    if (action.event.type === "tool.call") {
      return {
        ...state,
        toolCalls: [...state.toolCalls, action.event.call],
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
        errorCode: action.event.error.code,
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

  if (action.type === "post-finding") {
    const finding = state.findings.find(
      (candidate) => candidate.id === action.findingId,
    );
    if (
      state.status !== "completed" ||
      finding == null ||
      finding.artifactKind !== "finding" ||
      finding.requestId !== state.requestId ||
      state.findingStatuses[action.findingId] !== "unresolved"
    ) {
      return state;
    }
    return {
      ...state,
      findingStatuses: {
        ...state.findingStatuses,
        [action.findingId]: "posted",
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

  if (action.type === "post-suggestion") {
    const suggestion = state.suggestions.find(
      (candidate) => candidate.id === action.suggestionId,
    );
    if (
      state.status !== "completed" ||
      suggestion == null ||
      suggestion.requestId !== state.requestId ||
      state.suggestionStatuses[action.suggestionId] !== "unresolved"
    ) {
      return state;
    }
    return {
      ...state,
      suggestionStatuses: {
        ...state.suggestionStatuses,
        [action.suggestionId]: "posted",
      },
    };
  }

  if (action.type === "conflict") {
    return {
      ...state,
      status: "conflict",
      conflict: action.conflict,
      error: null,
      errorCode: null,
    };
  }

  if (action.type === "cancelled") {
    return {
      ...state,
      status: "cancelled",
      conflict: null,
      error: null,
      errorCode: null,
    };
  }

  return {
    ...state,
    status: "error",
    conflict: null,
    error: action.error,
    errorCode: action.errorCode,
  };
}

export type ReviewWorkspaceState = {
  runs: SelectionWorkspaceState[];
};

export const initialReviewWorkspaceState: ReviewWorkspaceState = {
  runs: [],
};

function hydrateWorkspaceRun(run: WorkspaceRun): SelectionWorkspaceState {
  return {
    status: "completed",
    generation: run.generation,
    createdOrder: run.createdOrder,
    requestId: run.request.requestId,
    scopeKind: run.request.scope?.kind ?? null,
    request: run.request,
    provider: run.provider ?? null,
    model: run.model ?? null,
    group: run.group ?? null,
    subject: run.subject ?? null,
    session: null,
    text: run.text,
    // Tool lines belong to the live stream; a reloaded run only keeps what the
    // workspace contract stores.
    toolCalls: [],
    findings: run.findings.map((entry) => entry.artifact),
    suggestions: run.suggestions.map((entry) => ({
      ...entry.artifact,
      status: "unresolved",
    })),
    findingStatuses: Object.fromEntries(
      run.findings.map((entry) => [entry.artifact.id, entry.status]),
    ),
    suggestionStatuses: Object.fromEntries(
      run.suggestions.map((entry) => [
        entry.artifact.id,
        entry.artifact.status,
      ]),
    ),
    suggestionConflictCodes: Object.fromEntries(
      run.suggestions
        .filter((entry) => entry.conflictCode != null)
        .map((entry) => [entry.artifact.id, entry.conflictCode]),
    ),
    conflict: null,
    error: null,
    errorCode: null,
  };
}

export function reduceReviewWorkspaceState(
  state: ReviewWorkspaceState,
  action: ReviewWorkspaceAction,
): ReviewWorkspaceState {
  if (action.type === "hydrate") {
    return {
      runs: action.runs.map(hydrateWorkspaceRun),
    };
  }
  if (action.type === "retain-runs") {
    const retainedGenerations = new Set(action.generations);
    const runs = state.runs.filter((run) =>
      retainedGenerations.has(run.generation),
    );
    return runs.length === state.runs.length ? state : { runs };
  }
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
