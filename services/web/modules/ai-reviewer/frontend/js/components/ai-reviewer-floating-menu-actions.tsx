import { useCodeMirrorStateContext } from "@/features/source-editor/components/codemirror-context";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useEditorSelectionPreview } from "../hooks/use-editor-selection-preview";
import { useEditorSelectionSessionContext } from "../hooks/use-editor-selection-session-context";
import type {
  EditorSelectionSessionAction,
  EditorSelectionSessionContext,
} from "../services/editor-selection-session";
import {
  AI_REVIEWER_SELECTION_TOOLBAR_BUSY_EVENT,
  AI_REVIEWER_SELECTION_TOOLBAR_READY_EVENT,
  aiReviewerSelectionActions,
  dispatchAiReviewerSelectionAction,
  isAiReviewerSelectionToolbarBusy,
} from "../services/selection-toolbar-events";
import { AiReviewerTooltipIconButton } from "./ai-reviewer-tooltip-icon-button";

import "../../stylesheets/ai-reviewer.scss";

function openAiReviewerPanel() {
  window.dispatchEvent(
    new CustomEvent("ui:select-rail-tab", {
      detail: { tab: "ai-reviewer", open: true },
    }),
  );
}

export function AiReviewerFloatingMenuActions({
  getSelectionContext,
}: {
  getSelectionContext: () => EditorSelectionSessionContext;
}) {
  const { t } = useTranslation();
  const state = useCodeMirrorStateContext();
  const selectionPreview = useEditorSelectionPreview(getSelectionContext);
  const [busy, setBusy] = useState(isAiReviewerSelectionToolbarBusy);
  const [pendingAction, setPendingAction] =
    useState<EditorSelectionSessionAction | null>(null);
  const pendingActionRef = useRef(pendingAction);
  pendingActionRef.current = pendingAction;

  useEffect(() => {
    const handleBusy = (event: Event) => {
      setBusy((event as CustomEvent<{ busy?: boolean }>).detail?.busy === true);
    };
    const handleReady = () => {
      const action = pendingActionRef.current;
      if (action != null && dispatchAiReviewerSelectionAction(action)) {
        pendingActionRef.current = null;
        setPendingAction(null);
      }
    };
    window.addEventListener(
      AI_REVIEWER_SELECTION_TOOLBAR_BUSY_EVENT,
      handleBusy,
    );
    window.addEventListener(
      AI_REVIEWER_SELECTION_TOOLBAR_READY_EVENT,
      handleReady,
    );
    return () => {
      window.removeEventListener(
        AI_REVIEWER_SELECTION_TOOLBAR_BUSY_EVENT,
        handleBusy,
      );
      window.removeEventListener(
        AI_REVIEWER_SELECTION_TOOLBAR_READY_EVENT,
        handleReady,
      );
    };
  }, []);

  const runAction = useCallback((action: EditorSelectionSessionAction) => {
    if (!dispatchAiReviewerSelectionAction(action)) {
      pendingActionRef.current = action;
      setPendingAction(action);
    }
    openAiReviewerPanel();
  }, []);

  if (state.selection.main.empty || selectionPreview == null) {
    return null;
  }
  const scopeLabel = t("ai_reviewer_selection_scope_descriptor", {
    ...selectionPreview,
    count: selectionPreview.wordCount,
  });

  return (
    <span
      className="ai-reviewer-floating-menu-actions"
      role="toolbar"
      aria-label={scopeLabel}
      title={scopeLabel}
      onMouseDown={(event) => event.preventDefault()}
    >
      {aiReviewerSelectionActions.map(({ action, icon, labelKey }) => (
        <AiReviewerTooltipIconButton
          key={action}
          id={`ai-reviewer-selection-action-${action}`}
          label={t(labelKey)}
          icon={icon}
          buttonClassName="editor-floating-menu-button"
          tooltipPlacement="right"
          disabled={busy || pendingAction != null}
          onClick={() => runAction(action)}
        />
      ))}
    </span>
  );
}

export default function AiReviewerFloatingMenuActionsContainer() {
  const getSelectionContext = useEditorSelectionSessionContext();
  return (
    <AiReviewerFloatingMenuActions getSelectionContext={getSelectionContext} />
  );
}
