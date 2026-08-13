import {
  EditorState,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  showTooltip,
  type Tooltip,
  type TooltipView,
} from "@codemirror/view";

import type { EditorSelectionSessionAction } from "../services/editor-selection-session";

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
  window.dispatchEvent(
    new CustomEvent(AI_REVIEWER_SELECTION_TOOLBAR_BUSY_EVENT, {
      detail: { busy },
    }),
  );
}

const mouseDownEffect = StateEffect.define();
const mouseUpEffect = StateEffect.define();
const mouseDownStateField = StateField.define<boolean>({
  create() {
    return false;
  },
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(mouseDownEffect)) {
        return true;
      }
      if (effect.is(mouseUpEffect)) {
        return false;
      }
    }
    return value;
  },
});

export const aiReviewerSelectionTooltipStateField = StateField.define<{
  tooltip: Tooltip | null;
}>({
  create() {
    return { tooltip: null };
  },
  update(field, transaction) {
    if (transaction.state.selection.main.empty) {
      return { tooltip: null };
    }

    if (
      !transaction.effects.some((effect) => effect.is(mouseUpEffect)) &&
      transaction.annotation(Transaction.userEvent) !== "select" &&
      transaction.annotation(Transaction.userEvent) !== "select.pointer"
    ) {
      return transaction.selection ? { tooltip: null } : field;
    }

    return {
      tooltip: buildTooltip(
        transaction.state,
        transaction.state.field(mouseDownStateField),
      ),
    };
  },
  provide: (field) =>
    showTooltip.compute([field], (state) => state.field(field).tooltip),
});

function buildTooltip(state: EditorState, hidden: boolean): Tooltip {
  const selection = state.selection.main;
  const lineAtHead = state.doc.lineAt(selection.head);
  const startsNextLine =
    selection.from !== selection.to &&
    lineAtHead.from === selection.head &&
    state.doc.lineAt(selection.from).number !== lineAtHead.number;

  return {
    pos: startsNextLine ? selection.head - 1 : selection.head,
    above: true,
    create: hidden ? createHiddenTooltipView : createVisibleTooltipView,
  };
}

function createTooltipView(hidden: boolean): TooltipView {
  const dom = document.createElement("div");
  dom.className = "ai-reviewer-selection-tooltip-container";
  dom.style.display = hidden ? "none" : "block";
  return {
    dom,
    overlap: true,
    // Add-comment uses 8px. The larger offset keeps both tooltips distinct
    // even for a backward selection, where the core tooltip is also above.
    offset: { x: 0, y: 48 },
  };
}

const createHiddenTooltipView = () => createTooltipView(true);
const createVisibleTooltipView = () => createTooltipView(false);

const aiReviewerSelectionTooltipTheme = EditorView.baseTheme({
  ".ai-reviewer-selection-tooltip-container.cm-tooltip": {
    backgroundColor: "transparent",
    border: "none",
    zIndex: 1,
  },
});

export function extension(): Extension {
  let mouseUpListener: (() => void) | null = null;
  const removeMouseUpListener = () => {
    if (mouseUpListener != null) {
      document.removeEventListener("mouseup", mouseUpListener);
      mouseUpListener = null;
    }
  };

  return [
    aiReviewerSelectionTooltipTheme,
    aiReviewerSelectionTooltipStateField,
    mouseDownStateField,
    EditorView.domEventHandlers({
      mousedown: (_event, view) => {
        removeMouseUpListener();
        mouseUpListener = () => {
          removeMouseUpListener();
          view.dispatch({ effects: mouseUpEffect.of(null) });
        };
        view.dispatch({ effects: mouseDownEffect.of(null) });
        document.addEventListener("mouseup", mouseUpListener);
      },
    }),
  ];
}
