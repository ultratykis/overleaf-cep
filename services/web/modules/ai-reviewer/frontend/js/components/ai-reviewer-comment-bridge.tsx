import { useConnectionContext } from "@/features/ide-react/context/connection-context";
import useSocketListener from "@/features/ide-react/hooks/use-socket-listener";
import { useProjectContext } from "@/shared/context/project-context";
import getMeta from "@/utils/meta";
import RangesTracker from "@overleaf/ranges-tracker";
import { useCallback, useEffect, useMemo } from "react";

import type { ThreadId } from "../../../../../types/review-panel/review-panel";
import { useEditorSelectionSessionContext } from "../hooks/use-editor-selection-session-context";
import {
  loadAiReviewerCommentProvenance,
  lookupAiReviewerCommentProvenance,
  mergeAiReviewerCommentProvenance,
  recordAiReviewerCommentProvenance,
  releaseAiReviewerCommentProvenance,
  reserveAiReviewerCommentProvenance,
} from "../services/ai-reviewer-comment-provenance";
import {
  createAiReviewerCommentPoster,
  registerAiReviewerCommentPoster,
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
};

function EnabledAiReviewerCommentBridge({
  addComment,
}: AiReviewerCommentBridgeProps) {
  const { projectId } = useProjectContext();
  const { socket } = useConnectionContext();
  const getContext = useEditorSelectionSessionContext();

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

  useEffect(() => registerAiReviewerCommentPoster(poster), [poster]);

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
