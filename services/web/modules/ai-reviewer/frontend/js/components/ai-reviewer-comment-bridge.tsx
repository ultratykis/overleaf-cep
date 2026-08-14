import { useConnectionContext } from "@/features/ide-react/context/connection-context";
import useSocketListener from "@/features/ide-react/hooks/use-socket-listener";
import { useProjectContext } from "@/shared/context/project-context";
import getMeta from "@/utils/meta";
import RangesTracker from "@overleaf/ranges-tracker";
import { useCallback, useEffect, useMemo, useRef } from "react";

import type { ThreadId } from "../../../../../types/review-panel/review-panel";
import { useEditorSelectionSessionContext } from "../hooks/use-editor-selection-session-context";
import {
  loadAiReviewerCommentProvenance,
  lookupAiReviewerCommentProvenance,
  mergeAiReviewerCommentProvenance,
  confirmAiReviewerReplyProvenance,
  recordAiReviewerCommentProvenance,
  releaseAiReviewerCommentProvenance,
  reserveAiReviewerCommentProvenance,
  reserveAiReviewerReplyProvenance,
} from "../services/ai-reviewer-comment-provenance";
import {
  createAiReviewerCommentPoster,
  createAiReviewerReplyPoster,
  registerAiReviewerCommentPoster,
  registerAiReviewerReplyPoster,
} from "../services/ai-reviewer-comment-posting";

type AiReviewerHostAddComment = (
  pos: number,
  text: string,
  content: string,
  threadId?: ThreadId,
  validateRange?: () => boolean,
) => Promise<ThreadId>;

type AiReviewerCommentBridgeProps = {
  addComment: AiReviewerHostAddComment;
  addMessage: (threadId: ThreadId, content: string) => Promise<void>;
};

type PendingReply = {
  threadId: string;
  content: string;
  resolve: (messageId: string) => void;
  reject: (error: unknown) => void;
  timeout: number;
};

function EnabledAiReviewerCommentBridge({
  addComment,
  addMessage,
}: AiReviewerCommentBridgeProps) {
  const { projectId } = useProjectContext();
  const { socket } = useConnectionContext();
  const getContext = useEditorSelectionSessionContext();
  const pendingReplies = useRef(new Set<PendingReply>());

  const refreshProvenance = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const commentIds = await loadAiReviewerCommentProvenance(
          projectId,
          signal,
        );
        mergeAiReviewerCommentProvenance(projectId, commentIds);
      } catch {
        // Provenance labels are best-effort reads of shared comment metadata.
      }
    },
    [projectId],
  );

  useEffect(() => {
    const abortController = new AbortController();
    void refreshProvenance(abortController.signal);
    return () => {
      abortController.abort();
    };
  }, [refreshProvenance]);

  useSocketListener(
    socket,
    "new-comment",
    useCallback(() => {
      void refreshProvenance();
    }, [refreshProvenance]),
  );

  useSocketListener(
    socket,
    "new-comment",
    useCallback(
      (threadId: string, comment: { id?: unknown; content?: unknown }) => {
        const pending = [...pendingReplies.current].find(
          (entry) =>
            entry.threadId === threadId && entry.content === comment.content,
        );
        if (pending == null || typeof comment.id !== "string") {
          return;
        }
        pendingReplies.current.delete(pending);
        window.clearTimeout(pending.timeout);
        pending.resolve(comment.id);
      },
      [],
    ),
  );

  const addReply = useCallback(
    (threadId: string, content: string) =>
      new Promise<string>((resolve, reject) => {
        const pending: PendingReply = {
          threadId,
          content,
          resolve,
          reject,
          timeout: 0,
        };
        const fail = (error: unknown) => {
          if (!pendingReplies.current.delete(pending)) {
            return;
          }
          window.clearTimeout(pending.timeout);
          reject(error);
        };
        pending.timeout = window.setTimeout(
          () => fail(new TypeError("Reply confirmation was not received")),
          5_000,
        );
        pendingReplies.current.add(pending);
        void addMessage(threadId as ThreadId, content).catch(fail);
      }),
    [addMessage],
  );

  useEffect(
    () => () => {
      for (const pending of pendingReplies.current) {
        window.clearTimeout(pending.timeout);
        pending.reject(
          new DOMException("Comment bridge unmounted", "AbortError"),
        );
      }
      pendingReplies.current.clear();
    },
    [],
  );

  const poster = useMemo(
    () =>
      createAiReviewerCommentPoster({
        projectId,
        getContext,
        generateCommentId: () => RangesTracker.generateId(),
        lookupProvenance: lookupAiReviewerCommentProvenance,
        reserveProvenance: reserveAiReviewerCommentProvenance,
        releaseProvenance: releaseAiReviewerCommentProvenance,
        addComment: async (from, text, content, commentId, validateRange) => {
          const postedCommentId = await addComment(
            from,
            text,
            content,
            commentId as ThreadId,
            validateRange,
          );
          return postedCommentId;
        },
        recordProvenance: recordAiReviewerCommentProvenance,
      }),
    [addComment, getContext, projectId],
  );

  const replyPoster = useMemo(
    () =>
      createAiReviewerReplyPoster({
        projectId,
        generateCommentId: () => RangesTracker.generateId(),
        lookupProvenance: lookupAiReviewerCommentProvenance,
        reserveProvenance: reserveAiReviewerReplyProvenance,
        confirmProvenance: confirmAiReviewerReplyProvenance,
        releaseProvenance: releaseAiReviewerCommentProvenance,
        addReply,
        recordProvenance: recordAiReviewerCommentProvenance,
      }),
    [addReply, projectId],
  );

  useEffect(() => registerAiReviewerCommentPoster(poster), [poster]);
  useEffect(() => registerAiReviewerReplyPoster(replyPoster), [replyPoster]);

  return null;
}

export default function AiReviewerCommentBridge(
  props: AiReviewerCommentBridgeProps,
) {
  if (getMeta("ol-ExposedSettings").aiReviewerEnabled !== true) {
    return null;
  }
  return <EnabledAiReviewerCommentBridge {...props} />;
}
