import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ThreadId } from "../../../../../types/review-panel/review-panel";
import {
  AI_REVIEWER_COMMENT_ACTION_BUSY_EVENT,
  AI_REVIEWER_COMMENT_ACTION_READY_EVENT,
  dispatchAiReviewerCommentAction,
  isAiReviewerCommentActionBusy,
} from "../services/comment-action-events";
import { AiReviewerTooltipIconButton } from "./ai-reviewer-tooltip-icon-button";

import "../../stylesheets/ai-reviewer.scss";

function openAiReviewerPanel() {
  window.dispatchEvent(
    new CustomEvent("ui:select-rail-tab", {
      detail: { tab: "ai-reviewer", open: true },
    }),
  );
}

export default function AiReviewerCommentActions({
  commentId,
}: {
  commentId: ThreadId;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(isAiReviewerCommentActionBusy);
  const [pendingThreadId, setPendingThreadId] = useState<ThreadId | null>(null);
  const pendingThreadIdRef = useRef(pendingThreadId);
  pendingThreadIdRef.current = pendingThreadId;

  useEffect(() => {
    const handleBusy = (event: Event) => {
      setBusy((event as CustomEvent<{ busy?: boolean }>).detail?.busy === true);
    };
    const handleReady = () => {
      const threadId = pendingThreadIdRef.current;
      if (threadId != null && dispatchAiReviewerCommentAction(threadId)) {
        pendingThreadIdRef.current = null;
        setPendingThreadId(null);
      }
    };
    window.addEventListener(AI_REVIEWER_COMMENT_ACTION_BUSY_EVENT, handleBusy);
    window.addEventListener(
      AI_REVIEWER_COMMENT_ACTION_READY_EVENT,
      handleReady,
    );
    return () => {
      window.removeEventListener(
        AI_REVIEWER_COMMENT_ACTION_BUSY_EVENT,
        handleBusy,
      );
      window.removeEventListener(
        AI_REVIEWER_COMMENT_ACTION_READY_EVENT,
        handleReady,
      );
    };
  }, []);

  const runAction = useCallback(() => {
    if (!dispatchAiReviewerCommentAction(commentId)) {
      pendingThreadIdRef.current = commentId;
      setPendingThreadId(commentId);
    }
    openAiReviewerPanel();
  }, [commentId]);

  return (
    <AiReviewerTooltipIconButton
      id={`ai-reviewer-comment-action-${commentId}`}
      label={t("ai_reviewer_action_ask_ai")}
      icon="smart_toy"
      disabled={busy || pendingThreadId != null}
      onClick={runAction}
    />
  );
}
