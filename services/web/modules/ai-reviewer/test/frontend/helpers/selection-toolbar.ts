import { act } from "@testing-library/react";

import {
  dispatchAiReviewerSelectionAction,
  isAiReviewerSelectionToolbarBusy,
} from "../../../frontend/js/services/selection-toolbar-events";
import type { EditorSelectionSessionAction } from "../../../frontend/js/services/editor-selection-session";

export function runSelectionAction(action: EditorSelectionSessionAction) {
  let handled = false;
  act(() => {
    handled = dispatchAiReviewerSelectionAction(action);
  });
  return handled;
}

export function isSelectionToolbarBusy() {
  return isAiReviewerSelectionToolbarBusy();
}
