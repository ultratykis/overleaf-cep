import type { EditorSelectionSessionContext } from "./editor-selection-session";
import { FetchError } from "@/infrastructure/fetch-json";

const mongoIdentifierPattern = /^[0-9a-f]{24}$/;

export type PostAiReviewerCommentInput = {
  projectId: string;
  runId: string;
  artifactId: string;
  documentId: string;
  from: number;
  to: number;
  text: string;
  content: string;
};

export type PostAiReviewerCommentResult = {
  commentId: string;
};

export type PostAiReviewerReplyInput = {
  projectId: string;
  runId: string;
  artifactId: string;
  threadId: string;
  content: string;
};

export type AiReviewerCommentPostingErrorCode =
  | "AI_REVIEWER_COMMENT_HOST_UNAVAILABLE"
  | "AI_REVIEWER_COMMENT_POST_UNCERTAIN"
  | "AI_REVIEWER_COMMENT_POST_FAILED"
  | "AI_REVIEWER_COMMENT_PROVENANCE_FAILED"
  | "AI_REVIEWER_COMMENT_RANGE_STALE"
  | "AI_REVIEWER_COMMENT_REQUEST_INVALID";

export class AiReviewerCommentPostingError extends Error {
  readonly code: AiReviewerCommentPostingErrorCode;

  constructor(code: AiReviewerCommentPostingErrorCode, message: string) {
    super(message);
    this.name = "AiReviewerCommentPostingError";
    this.code = code;
  }
}

export type AiReviewerCommentPoster = (
  input: PostAiReviewerCommentInput,
) => Promise<PostAiReviewerCommentResult>;

export type AiReviewerReplyPoster = (
  input: PostAiReviewerReplyInput,
) => Promise<PostAiReviewerCommentResult>;

export type CreateAiReviewerCommentPosterOptions = {
  projectId: string;
  getContext: () => EditorSelectionSessionContext;
  generateCommentId: () => string;
  lookupProvenance: (
    projectId: string,
    runId: string,
    artifactId: string,
  ) => Promise<{ commentId: string; confirmed: boolean } | null>;
  reserveProvenance: (
    projectId: string,
    commentId: string,
    runId: string,
    artifactId: string,
  ) => Promise<{ commentId: string; created: boolean; confirmed: boolean }>;
  releaseProvenance: (projectId: string, commentId: string) => Promise<void>;
  addComment: (
    from: number,
    text: string,
    content: string,
    commentId: string,
    validateRange: () => boolean,
  ) => Promise<string>;
  recordProvenance: (projectId: string, commentId: string) => void;
};

type ReplyReservation = {
  commentId: string;
  confirmed: boolean;
  threadId?: string;
  messageId?: string | null;
};

export type CreateAiReviewerReplyPosterOptions = {
  projectId: string;
  generateCommentId: () => string;
  lookupProvenance: (
    projectId: string,
    runId: string,
    artifactId: string,
  ) => Promise<ReplyReservation | null>;
  reserveProvenance: (
    projectId: string,
    commentId: string,
    runId: string,
    artifactId: string,
    threadId: string,
  ) => Promise<ReplyReservation & { created: boolean }>;
  confirmProvenance: (
    projectId: string,
    commentId: string,
    runId: string,
    artifactId: string,
    threadId: string,
    messageId: string,
  ) => Promise<ReplyReservation>;
  releaseProvenance: (projectId: string, commentId: string) => Promise<void>;
  addReply: (threadId: string, content: string) => Promise<string>;
  recordProvenance: (projectId: string, commentId: string) => void;
};

type LiveAnchor = {
  currentDocument: NonNullable<
    EditorSelectionSessionContext["currentDocument"]
  >;
  view: NonNullable<EditorSelectionSessionContext["view"]>;
};

function postingError(
  code: AiReviewerCommentPostingErrorCode,
  message: string,
) {
  return new AiReviewerCommentPostingError(code, message);
}

function isRangeStaleError(error: unknown) {
  try {
    return (
      typeof error === "object" &&
      error != null &&
      "code" in error &&
      error.code === "AI_REVIEWER_COMMENT_RANGE_STALE"
    );
  } catch {
    return false;
  }
}

function isClearHostRejection(error: unknown) {
  return (
    error instanceof FetchError &&
    error.response != null &&
    error.response.status >= 400 &&
    error.response.status < 500
  );
}

function validateInput(input: PostAiReviewerCommentInput) {
  if (
    !mongoIdentifierPattern.test(input.projectId) ||
    !mongoIdentifierPattern.test(input.documentId) ||
    typeof input.runId !== "string" ||
    input.runId.length === 0 ||
    input.runId.length > 200 ||
    typeof input.artifactId !== "string" ||
    input.artifactId.length === 0 ||
    input.artifactId.length > 200 ||
    !Number.isSafeInteger(input.from) ||
    !Number.isSafeInteger(input.to) ||
    input.from < 0 ||
    input.to < input.from ||
    input.to - input.from !== input.text.length ||
    input.content.trim().length === 0
  ) {
    throw postingError(
      "AI_REVIEWER_COMMENT_REQUEST_INVALID",
      "The AI-assisted comment request is invalid.",
    );
  }
}

function validateReplyInput(input: PostAiReviewerReplyInput) {
  if (
    !mongoIdentifierPattern.test(input.projectId) ||
    !mongoIdentifierPattern.test(input.threadId) ||
    typeof input.runId !== "string" ||
    input.runId.length === 0 ||
    input.runId.length > 200 ||
    typeof input.artifactId !== "string" ||
    input.artifactId.length === 0 ||
    input.artifactId.length > 200 ||
    input.content.trim().length === 0
  ) {
    throw postingError(
      "AI_REVIEWER_COMMENT_REQUEST_INVALID",
      "The AI-assisted reply request is invalid.",
    );
  }
}

function readLiveAnchor(
  input: PostAiReviewerCommentInput,
  getContext: () => EditorSelectionSessionContext,
): LiveAnchor | null {
  let context: EditorSelectionSessionContext;
  try {
    context = getContext();
  } catch {
    return null;
  }

  const { currentDocument, currentDocumentId, view } = context;
  if (
    context.projectId !== input.projectId ||
    currentDocumentId !== input.documentId ||
    currentDocument == null ||
    currentDocument.doc_id !== input.documentId ||
    view == null ||
    input.to > view.state.doc.length
  ) {
    return null;
  }

  try {
    if (view.state.sliceDoc(input.from, input.to) !== input.text) {
      return null;
    }
  } catch {
    return null;
  }

  return {
    currentDocument,
    view,
  };
}

export function createAiReviewerCommentPoster({
  projectId,
  getContext,
  generateCommentId,
  lookupProvenance,
  reserveProvenance,
  releaseProvenance,
  addComment,
  recordProvenance,
}: CreateAiReviewerCommentPosterOptions): AiReviewerCommentPoster {
  return async (input) => {
    validateInput(input);
    if (input.projectId !== projectId) {
      throw postingError(
        "AI_REVIEWER_COMMENT_HOST_UNAVAILABLE",
        "The comment host is not available for this project.",
      );
    }

    let reservation: {
      commentId: string;
      created: boolean;
      confirmed: boolean;
    } | null;
    try {
      const existing = await lookupProvenance(
        projectId,
        input.runId,
        input.artifactId,
      );
      reservation = existing == null ? null : { ...existing, created: false };
    } catch {
      throw postingError(
        "AI_REVIEWER_COMMENT_PROVENANCE_FAILED",
        "AI-assisted provenance could not be read.",
      );
    }
    if (
      reservation != null &&
      !mongoIdentifierPattern.test(reservation.commentId)
    ) {
      throw postingError(
        "AI_REVIEWER_COMMENT_PROVENANCE_FAILED",
        "AI-assisted provenance returned an invalid comment identifier.",
      );
    }
    if (reservation?.confirmed === true) {
      recordProvenance(projectId, reservation.commentId);
      return { commentId: reservation.commentId };
    }

    const initialAnchor = readLiveAnchor(input, getContext);
    if (initialAnchor == null) {
      // Any claim reaching here belongs to an earlier attempt, so it stays:
      // that attempt may have posted without confirming, and dropping the
      // claim would let a later attempt post the duplicate again.
      throw postingError(
        "AI_REVIEWER_COMMENT_RANGE_STALE",
        "The document range no longer matches the reviewed text.",
      );
    }

    if (reservation == null) {
      let generatedCommentId: string;
      try {
        generatedCommentId = generateCommentId();
      } catch {
        throw postingError(
          "AI_REVIEWER_COMMENT_POST_FAILED",
          "The comment identifier could not be created.",
        );
      }
      if (!mongoIdentifierPattern.test(generatedCommentId)) {
        throw postingError(
          "AI_REVIEWER_COMMENT_POST_FAILED",
          "The comment identifier is invalid.",
        );
      }

      try {
        reservation = await reserveProvenance(
          projectId,
          generatedCommentId,
          input.runId,
          input.artifactId,
        );
      } catch {
        throw postingError(
          "AI_REVIEWER_COMMENT_PROVENANCE_FAILED",
          "AI-assisted provenance could not be reserved.",
        );
      }
      if (
        !mongoIdentifierPattern.test(reservation.commentId) ||
        (reservation.created && reservation.commentId !== generatedCommentId)
      ) {
        throw postingError(
          "AI_REVIEWER_COMMENT_PROVENANCE_FAILED",
          "AI-assisted provenance returned the wrong comment identifier.",
        );
      }
      if (reservation.confirmed) {
        recordProvenance(projectId, reservation.commentId);
        return { commentId: reservation.commentId };
      }
    }
    const commentId = reservation.commentId;
    const claimedHere = reservation.created;

    const rollbackReservation = async () => {
      // Only release a claim this attempt created. A claim carried over from
      // an earlier attempt may already have a comment behind it, because that
      // attempt ended without confirmation. Releasing it would let the next
      // attempt mint a second identifier and post the duplicate this claim
      // exists to prevent. Keeping it costs nothing: the claim pins the
      // identifier, it never blocks posting.
      if (!claimedHere) {
        return;
      }
      try {
        await releaseProvenance(projectId, commentId);
      } catch {
        // A failed rollback must not hide the posting or stale-range error.
      }
    };

    const liveAnchor = readLiveAnchor(input, getContext);
    if (
      liveAnchor == null ||
      liveAnchor.currentDocument !== initialAnchor.currentDocument ||
      liveAnchor.view !== initialAnchor.view
    ) {
      await rollbackReservation();
      throw postingError(
        "AI_REVIEWER_COMMENT_RANGE_STALE",
        "The document changed while the comment was being prepared.",
      );
    }

    let postedCommentId: string;
    try {
      const validateRange = () => {
        const finalAnchor = readLiveAnchor(input, getContext);
        return (
          finalAnchor != null &&
          finalAnchor.currentDocument === initialAnchor.currentDocument &&
          finalAnchor.view === initialAnchor.view
        );
      };
      postedCommentId = await addComment(
        input.from,
        input.text,
        input.content,
        commentId,
        validateRange,
      );
    } catch (error) {
      if (isRangeStaleError(error)) {
        await rollbackReservation();
        throw postingError(
          "AI_REVIEWER_COMMENT_RANGE_STALE",
          "The document changed before the comment range was attached.",
        );
      }
      if (isClearHostRejection(error)) {
        await rollbackReservation();
        throw postingError(
          "AI_REVIEWER_COMMENT_POST_FAILED",
          "The comment request was rejected.",
        );
      }
      throw postingError(
        "AI_REVIEWER_COMMENT_POST_UNCERTAIN",
        "The comment response could not be confirmed.",
      );
    }
    if (postedCommentId !== commentId) {
      await rollbackReservation();
      throw postingError(
        "AI_REVIEWER_COMMENT_POST_FAILED",
        "The comment host returned the wrong comment identifier.",
      );
    }

    recordProvenance(projectId, commentId);
    return { commentId };
  };
}

export function createAiReviewerReplyPoster({
  projectId,
  generateCommentId,
  lookupProvenance,
  reserveProvenance,
  confirmProvenance,
  releaseProvenance,
  addReply,
  recordProvenance,
}: CreateAiReviewerReplyPosterOptions): AiReviewerReplyPoster {
  return async (input) => {
    validateReplyInput(input);
    if (input.projectId !== projectId) {
      throw postingError(
        "AI_REVIEWER_COMMENT_HOST_UNAVAILABLE",
        "The comment host is not available for this project.",
      );
    }

    let reservation: (ReplyReservation & { created: boolean }) | null;
    try {
      const existing = await lookupProvenance(
        projectId,
        input.runId,
        input.artifactId,
      );
      reservation = existing == null ? null : { ...existing, created: false };
    } catch {
      throw postingError(
        "AI_REVIEWER_COMMENT_PROVENANCE_FAILED",
        "AI-assisted provenance could not be read.",
      );
    }
    if (reservation != null) {
      if (
        !mongoIdentifierPattern.test(reservation.commentId) ||
        reservation.threadId !== input.threadId
      ) {
        throw postingError(
          "AI_REVIEWER_COMMENT_PROVENANCE_FAILED",
          "AI-assisted provenance belongs to a different comment target.",
        );
      }
      if (reservation.confirmed) {
        if (
          reservation.messageId == null ||
          !mongoIdentifierPattern.test(reservation.messageId)
        ) {
          throw postingError(
            "AI_REVIEWER_COMMENT_PROVENANCE_FAILED",
            "AI-assisted provenance returned an invalid reply identifier.",
          );
        }
        recordProvenance(projectId, reservation.messageId);
        return { commentId: reservation.messageId };
      }
      // A reply has no client-chosen host identifier. Retrying an uncertain
      // claim would create a second message, so keep the claim and do not send.
      throw postingError(
        "AI_REVIEWER_COMMENT_POST_UNCERTAIN",
        "The reply response could not be confirmed.",
      );
    }

    let commentId: string;
    try {
      commentId = generateCommentId();
    } catch {
      throw postingError(
        "AI_REVIEWER_COMMENT_POST_FAILED",
        "The provenance identifier could not be created.",
      );
    }
    if (!mongoIdentifierPattern.test(commentId)) {
      throw postingError(
        "AI_REVIEWER_COMMENT_POST_FAILED",
        "The provenance identifier is invalid.",
      );
    }
    try {
      reservation = await reserveProvenance(
        projectId,
        commentId,
        input.runId,
        input.artifactId,
        input.threadId,
      );
    } catch {
      throw postingError(
        "AI_REVIEWER_COMMENT_PROVENANCE_FAILED",
        "AI-assisted provenance could not be reserved.",
      );
    }
    if (
      reservation.commentId !== commentId ||
      reservation.threadId !== input.threadId
    ) {
      throw postingError(
        "AI_REVIEWER_COMMENT_PROVENANCE_FAILED",
        "AI-assisted provenance returned the wrong reply target.",
      );
    }
    if (reservation.confirmed) {
      if (
        reservation.messageId == null ||
        !mongoIdentifierPattern.test(reservation.messageId)
      ) {
        throw postingError(
          "AI_REVIEWER_COMMENT_PROVENANCE_FAILED",
          "AI-assisted provenance returned an invalid reply identifier.",
        );
      }
      recordProvenance(projectId, reservation.messageId);
      return { commentId: reservation.messageId };
    }
    if (!reservation.created) {
      throw postingError(
        "AI_REVIEWER_COMMENT_POST_UNCERTAIN",
        "The reply response could not be confirmed.",
      );
    }

    const rollbackReservation = async () => {
      try {
        await releaseProvenance(projectId, commentId);
      } catch {
        // A failed rollback must not hide the definite host rejection.
      }
    };

    let messageId: string;
    try {
      messageId = await addReply(input.threadId, input.content);
    } catch (error) {
      if (isClearHostRejection(error)) {
        await rollbackReservation();
        throw postingError(
          "AI_REVIEWER_COMMENT_POST_FAILED",
          "The reply request was rejected.",
        );
      }
      throw postingError(
        "AI_REVIEWER_COMMENT_POST_UNCERTAIN",
        "The reply response could not be confirmed.",
      );
    }
    if (!mongoIdentifierPattern.test(messageId)) {
      throw postingError(
        "AI_REVIEWER_COMMENT_POST_UNCERTAIN",
        "The reply response could not be confirmed.",
      );
    }
    try {
      const confirmed = await confirmProvenance(
        projectId,
        commentId,
        input.runId,
        input.artifactId,
        input.threadId,
        messageId,
      );
      if (
        !confirmed.confirmed ||
        confirmed.threadId !== input.threadId ||
        confirmed.messageId !== messageId
      ) {
        throw new TypeError("Invalid reply provenance confirmation");
      }
    } catch {
      throw postingError(
        "AI_REVIEWER_COMMENT_PROVENANCE_FAILED",
        "AI-assisted reply provenance could not be confirmed.",
      );
    }
    recordProvenance(projectId, messageId);
    return { commentId: messageId };
  };
}

let registeredPoster:
  | {
      token: symbol;
      post: AiReviewerCommentPoster;
    }
  | undefined;

let registeredReplyPoster:
  | {
      token: symbol;
      post: AiReviewerReplyPoster;
    }
  | undefined;

export function registerAiReviewerCommentPoster(post: AiReviewerCommentPoster) {
  const token = Symbol("ai-reviewer-comment-poster");
  registeredPoster = { token, post };

  return () => {
    if (registeredPoster?.token === token) {
      registeredPoster = undefined;
    }
  };
}

export async function postAiReviewerComment(
  input: PostAiReviewerCommentInput,
): Promise<PostAiReviewerCommentResult> {
  const poster = registeredPoster?.post;
  if (poster == null) {
    throw postingError(
      "AI_REVIEWER_COMMENT_HOST_UNAVAILABLE",
      "The comment host is not available.",
    );
  }
  return poster(input);
}

export function registerAiReviewerReplyPoster(post: AiReviewerReplyPoster) {
  const token = Symbol("ai-reviewer-reply-poster");
  registeredReplyPoster = { token, post };
  return () => {
    if (registeredReplyPoster?.token === token) {
      registeredReplyPoster = undefined;
    }
  };
}

export async function postAiReviewerReply(
  input: PostAiReviewerReplyInput,
): Promise<PostAiReviewerCommentResult> {
  const poster = registeredReplyPoster?.post;
  if (poster == null) {
    throw postingError(
      "AI_REVIEWER_COMMENT_HOST_UNAVAILABLE",
      "The comment host is not available.",
    );
  }
  return poster(input);
}

export function resetAiReviewerCommentPosterForTests() {
  registeredPoster = undefined;
  registeredReplyPoster = undefined;
}
