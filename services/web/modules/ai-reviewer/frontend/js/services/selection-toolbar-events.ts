import type { EditorSelectionSessionAction } from "./editor-selection-session";

export const AI_REVIEWER_SELECTION_ACTION_EVENT =
  "ai-reviewer:selection-action";
export const AI_REVIEWER_SELECTION_TOOLBAR_READY_EVENT =
  "ai-reviewer:selection-toolbar-ready";
export const AI_REVIEWER_SELECTION_TOOLBAR_BUSY_EVENT =
  "ai-reviewer:selection-toolbar-busy";

export const aiReviewerSelectionActions: ReadonlyArray<{
  action: EditorSelectionSessionAction;
  instruction: string;
  icon: string;
  labelKey:
    | "ai_reviewer_action_review"
    | "ai_reviewer_action_rewrite"
    | "ai_reviewer_action_shorten";
}> = [
  {
    action: "review",
    instruction: "Review the selected phrase.",
    icon: "rate_review",
    labelKey: "ai_reviewer_action_review",
  },
  {
    action: "rewrite",
    instruction: "Rewrite the selected phrase.",
    icon: "edit",
    labelKey: "ai_reviewer_action_rewrite",
  },
  {
    action: "shorten",
    instruction: "Shorten the selected phrase.",
    icon: "compress",
    labelKey: "ai_reviewer_action_shorten",
  },
];

let selectionToolbarBusy = false;

export function isAiReviewerSelectionAction(
  value: unknown,
): value is EditorSelectionSessionAction {
  return aiReviewerSelectionActions.some(({ action }) => action === value);
}

export function dispatchAiReviewerSelectionAction(
  action: EditorSelectionSessionAction,
) {
  const event = new CustomEvent(AI_REVIEWER_SELECTION_ACTION_EVENT, {
    cancelable: true,
    detail: { action },
  });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

export function dispatchAiReviewerSelectionToolbarBusy(busy: boolean) {
  selectionToolbarBusy = busy;
  window.dispatchEvent(
    new CustomEvent(AI_REVIEWER_SELECTION_TOOLBAR_BUSY_EVENT, {
      detail: { busy },
    }),
  );
}

export function isAiReviewerSelectionToolbarBusy() {
  return selectionToolbarBusy;
}
