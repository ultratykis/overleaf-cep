export const AI_REVIEWER_COMMENT_ACTION_EVENT = "ai-reviewer:comment-action";
export const AI_REVIEWER_COMMENT_ACTION_READY_EVENT =
  "ai-reviewer:comment-action-ready";
export const AI_REVIEWER_COMMENT_ACTION_BUSY_EVENT =
  "ai-reviewer:comment-action-busy";

let commentActionBusy = false;

export function dispatchAiReviewerCommentAction(threadId: string) {
  const event = new CustomEvent(AI_REVIEWER_COMMENT_ACTION_EVENT, {
    cancelable: true,
    detail: { threadId },
  });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

export function dispatchAiReviewerCommentActionBusy(busy: boolean) {
  commentActionBusy = busy;
  window.dispatchEvent(
    new CustomEvent(AI_REVIEWER_COMMENT_ACTION_BUSY_EVENT, {
      detail: { busy },
    }),
  );
}

export function isAiReviewerCommentActionBusy() {
  return commentActionBusy;
}
