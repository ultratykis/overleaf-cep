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
  pausedUntil: number | null;
};

let enabled = false;
let pausedUntil: number | null = null;
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

export function adoptLegacyInlineCompletionEnabled(
  persisted: boolean | undefined,
): boolean | undefined {
  try {
    const adopted =
      persisted === undefined &&
      globalThis.localStorage?.getItem(INLINE_COMPLETION_STORAGE_KEY) === "true"
        ? true
        : persisted;
    globalThis.localStorage?.removeItem(INLINE_COMPLETION_STORAGE_KEY);
    return adopted;
  } catch {
    return persisted;
  }
}

export function getInlineCompletionState(): InlineCompletionState {
  return {
    enabled,
    pausedUntil,
    ...availability,
  };
}

function dispatchStateChange() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(AI_REVIEWER_INLINE_COMPLETION_STATE_EVENT));
  }
}

export function setInlineCompletionEnabled(nextEnabled: boolean) {
  // The panel owns persistence; this shared state only connects it to the
  // editor extension in the current page.
  enabled = nextEnabled;
  dispatchStateChange();
}

export function publishInlineCompletionPause(nextPausedUntil: number | null) {
  pausedUntil = nextPausedUntil;
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
