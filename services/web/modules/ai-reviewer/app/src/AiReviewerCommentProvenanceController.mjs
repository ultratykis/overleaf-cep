// @ts-check

import { AiReviewerCommentProvenanceValidationError } from "./AiReviewerCommentProvenanceStore.mjs";

/** @import { Request, Response } from "express" */

const ERRORS = {
  invalid: {
    code: "AI_REVIEWER_COMMENT_PROVENANCE_INVALID",
    message: "The AI-assisted comment provenance identifier is invalid.",
  },
  failed: {
    code: "AI_REVIEWER_COMMENT_PROVENANCE_FAILED",
    message: "The AI-assisted comment provenance request failed.",
  },
};

/**
 * @param {Response} response
 * @param {number} status
 * @param {keyof typeof ERRORS} kind
 */
function sendError(response, status, kind) {
  return response.status(status).json({ error: ERRORS[kind] });
}

/**
 * @param {unknown} error
 * @param {Response} response
 */
function handleError(error, response) {
  if (error instanceof AiReviewerCommentProvenanceValidationError) {
    return sendError(response, 400, "invalid");
  }
  return sendError(response, 500, "failed");
}

/** @param {{ provenanceStore: any }} dependencies */
export function createAiReviewerCommentProvenanceController({
  provenanceStore,
}) {
  /**
   * @param {Request} request
   * @param {Response} response
   */
  async function getCommentProvenance(request, response) {
    try {
      const commentIds = await provenanceStore.list(request.params.project_id);
      return response.json({ commentIds });
    } catch (error) {
      return handleError(error, response);
    }
  }

  /**
   * @param {Request} request
   * @param {Response} response
   */
  async function markCommentProvenance(request, response) {
    try {
      const result = await provenanceStore.mark(
        request.params.project_id,
        request.params.comment_id,
      );
      return response.json(result);
    } catch (error) {
      return handleError(error, response);
    }
  }

  /**
   * @param {Request} request
   * @param {Response} response
   */
  async function deleteCommentProvenance(request, response) {
    try {
      await provenanceStore.unmark(
        request.params.project_id,
        request.params.comment_id,
      );
      return response.status(204).end();
    } catch (error) {
      return handleError(error, response);
    }
  }

  return {
    getCommentProvenance,
    markCommentProvenance,
    deleteCommentProvenance,
  };
}
