import type {
  AgentEvent,
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
      status: "applied" | "rejected" | "cancelled" | "error";
    }
  | {
      status: "conflict";
      code: EditorSuggestionApplicationConflictCode;
    };

export type SelectionWorkspaceState = {
  status: SelectionWorkspaceStatus;
  generation: number;
  requestId: string | null;
  session: EditorSelectionSession | null;
  text: string;
  findings: Finding[];
  suggestions: ProposedSuggestion[];
  suggestionDecisions: Readonly<
    Record<string, SelectionSuggestionDecision | undefined>
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
  requestId: null,
  session: null,
  text: "",
  findings: [],
  suggestions: [],
  suggestionDecisions: {},
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
      requestId: action.requestId,
      session: null,
      text: "",
      findings: [],
      suggestions: [],
      suggestionDecisions: {},
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
      session: action.session,
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
      };
    }
    if (action.event.type === "suggestion") {
      return {
        ...state,
        suggestions: [...state.suggestions, action.event.suggestion],
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
      Object.prototype.hasOwnProperty.call(
        state.suggestionDecisions,
        action.suggestionId,
      ) ||
      suggestion == null ||
      suggestion.requestId !== state.requestId ||
      state.session.request.requestId !== state.requestId
    ) {
      return state;
    }
    return {
      ...state,
      suggestionDecisions: {
        ...state.suggestionDecisions,
        [action.suggestionId]: action.decision,
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
