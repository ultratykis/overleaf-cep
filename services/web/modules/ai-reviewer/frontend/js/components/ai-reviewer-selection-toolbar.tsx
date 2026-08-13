import {
  useCodeMirrorStateContext,
  useCodeMirrorViewContext,
} from "@/features/source-editor/components/codemirror-context";
import { getTooltip } from "@codemirror/view";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom";
import { useTranslation } from "react-i18next";

import { useEditorSelectionPreview } from "../hooks/use-editor-selection-preview";
import { useEditorSelectionSessionContext } from "../hooks/use-editor-selection-session-context";
import type { EditorSelectionSessionAction } from "../services/editor-selection-session";
import {
  AI_REVIEWER_SELECTION_TOOLBAR_BUSY_EVENT,
  AI_REVIEWER_SELECTION_TOOLBAR_READY_EVENT,
  aiReviewerSelectionActions,
  aiReviewerSelectionTooltipStateField,
  dispatchAiReviewerSelectionAction,
} from "../extensions/selection-tooltip";
import { AiReviewerTooltipIconButton } from "./ai-reviewer-tooltip-icon-button";

import "../../stylesheets/ai-reviewer.scss";

function openAiReviewerPanel() {
  window.dispatchEvent(
    new CustomEvent("ui:select-rail-tab", {
      detail: { tab: "ai-reviewer", open: true },
    }),
  );
}

export function AiReviewerSelectionToolbarActions({
  disabled,
  onAction,
}: {
  disabled: boolean;
  onAction: (action: EditorSelectionSessionAction) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {aiReviewerSelectionActions.map(({ action, icon, labelKey }) => {
        const label = t(labelKey);
        return (
          <AiReviewerTooltipIconButton
            key={action}
            id={`ai-reviewer-selection-action-${action}`}
            label={label}
            icon={icon}
            disabled={disabled}
            onClick={() => onAction(action)}
          />
        );
      })}
    </>
  );
}

export default function AiReviewerSelectionToolbar() {
  const { t } = useTranslation();
  const state = useCodeMirrorStateContext();
  const view = useCodeMirrorViewContext();
  const getSelectionContext = useEditorSelectionSessionContext();
  const selectionPreview = useEditorSelectionPreview(getSelectionContext);
  const tooltip = state.field(
    aiReviewerSelectionTooltipStateField,
    false,
  )?.tooltip;
  const [busy, setBusy] = useState(false);
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

  if (tooltip == null || selectionPreview == null) {
    return null;
  }
  const tooltipView = getTooltip(view, tooltip);
  if (tooltipView == null) {
    return null;
  }
  const scopeLabel = t("ai_reviewer_selection_scope_descriptor", {
    ...selectionPreview,
    count: selectionPreview.wordCount,
  });

  return ReactDOM.createPortal(
    <div
      className="ai-reviewer-selection-toolbar"
      role="toolbar"
      aria-label={scopeLabel}
      title={scopeLabel}
      onMouseDown={(event) => event.preventDefault()}
    >
      <AiReviewerSelectionToolbarActions
        disabled={busy || pendingAction != null}
        onAction={runAction}
      />
    </div>,
    tooltipView.dom,
  );
}
