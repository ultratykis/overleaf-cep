import type { EditorSelectionSessionContext } from "./editor-selection-session";
import { FetchError } from "@/infrastructure/fetch-json";

const mongoIdentifierPattern = /^[0-9a-f]{24}$/;

export type PostAiReviewerCommentInput = {
  projectId: string;
  documentId: string;
  from: number;
  to: number;
  text: string;
  content: string;
};

export type PostAiReviewerCommentResult = {
  commentId: string;
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

export type CreateAiReviewerCommentPosterOptions = {
  projectId: string;
  getContext: () => EditorSelectionSessionContext;
  generateCommentId: () => string;
  reserveProvenance: (
    projectId: string,
    commentId: string,
  ) => Promise<{ commentId: string; created: boolean }>;
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

    const initialAnchor = readLiveAnchor(input, getContext);
    if (initialAnchor == null) {
      throw postingError(
        "AI_REVIEWER_COMMENT_RANGE_STALE",
        "The document range no longer matches the reviewed text.",
      );
    }

    let commentId: string;
    try {
      commentId = generateCommentId();
    } catch {
      throw postingError(
        "AI_REVIEWER_COMMENT_POST_FAILED",
        "The comment identifier could not be created.",
      );
    }
    if (!mongoIdentifierPattern.test(commentId)) {
      throw postingError(
        "AI_REVIEWER_COMMENT_POST_FAILED",
        "The comment identifier is invalid.",
      );
    }

    let reservation: { commentId: string; created: boolean };
    try {
      reservation = await reserveProvenance(projectId, commentId);
    } catch {
      throw postingError(
        "AI_REVIEWER_COMMENT_PROVENANCE_FAILED",
        "AI-assisted provenance could not be reserved.",
      );
    }
    if (reservation.commentId !== commentId) {
      throw postingError(
        "AI_REVIEWER_COMMENT_PROVENANCE_FAILED",
        "AI-assisted provenance returned the wrong comment identifier.",
      );
    }

    const rollbackReservation = async () => {
      if (!reservation.created) {
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

let registeredPoster:
  | {
      token: symbol;
      post: AiReviewerCommentPoster;
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

export function resetAiReviewerCommentPosterForTests() {
  registeredPoster = undefined;
}
