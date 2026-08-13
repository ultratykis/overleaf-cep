import { act } from "@testing-library/react";

import {
  AI_REVIEWER_SELECTION_TOOLBAR_BUSY_EVENT,
  dispatchAiReviewerSelectionAction,
} from "../../../frontend/js/extensions/selection-tooltip";
import type { EditorSelectionSessionAction } from "../../../frontend/js/services/editor-selection-session";

let busy = false;
window.addEventListener(AI_REVIEWER_SELECTION_TOOLBAR_BUSY_EVENT, (event) => {
  busy = (event as CustomEvent<{ busy?: boolean }>).detail?.busy === true;
});

export function runSelectionAction(action: EditorSelectionSessionAction) {
  let handled = false;
  act(() => {
    handled = dispatchAiReviewerSelectionAction(action);
  });
  return handled;
}

export function isSelectionToolbarBusy() {
  return busy;
}
