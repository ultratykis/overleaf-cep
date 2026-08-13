export const AI_REVIEWER_INLINE_COMPLETION_STATE_EVENT =
  "ai-reviewer:inline-completion-state";
export const INLINE_COMPLETION_STORAGE_KEY = "ai-reviewer:inline-completion";

export type InlineCompletionAvailability = {
  hasLocalConnection: boolean;
  selectedConnectionClassification: "local" | "remote" | null;
  selectedConnectionId: string | null;
  selectedModel: string | null;
};

export type InlineCompletionState = InlineCompletionAvailability & {
  enabled: boolean;
};

let availability: InlineCompletionAvailability = {
  hasLocalConnection: false,
  selectedConnectionClassification: null,
  selectedConnectionId: null,
  selectedModel: null,
};

export function inlineCompletionGate({
  enabled,
  hasLocalConnection,
  selectedConnectionClassification,
}: Pick<
  InlineCompletionState,
  "enabled" | "hasLocalConnection" | "selectedConnectionClassification"
>): "off" | "no-local" | "remote" | "active" {
  if (!enabled) return "off";
  if (!hasLocalConnection) return "no-local";
  return selectedConnectionClassification === "local" ? "active" : "remote";
}

export function isInlineCompletionEnabled() {
  try {
    return (
      globalThis.localStorage?.getItem(INLINE_COMPLETION_STORAGE_KEY) === "true"
    );
  } catch {
    return false;
  }
}

export function getInlineCompletionState(): InlineCompletionState {
  return {
    enabled: isInlineCompletionEnabled(),
    ...availability,
  };
}

function dispatchStateChange() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(AI_REVIEWER_INLINE_COMPLETION_STATE_EVENT));
  }
}

export function setInlineCompletionEnabled(enabled: boolean) {
  try {
    // ponytail: local-only preference for now; move to server-side persistence when settings sync is needed.
    globalThis.localStorage?.setItem(
      INLINE_COMPLETION_STORAGE_KEY,
      String(enabled),
    );
  } catch {
    // An unavailable storage backend leaves the safe default off.
  }
  dispatchStateChange();
}

export function publishInlineCompletionAvailability(
  nextAvailability: InlineCompletionAvailability,
) {
  availability = nextAvailability;
  dispatchStateChange();
}

export function subscribeToInlineCompletionState(listener: () => void) {
  window.addEventListener(AI_REVIEWER_INLINE_COMPLETION_STATE_EVENT, listener);
  return () =>
    window.removeEventListener(
      AI_REVIEWER_INLINE_COMPLETION_STATE_EVENT,
      listener,
    );
}
