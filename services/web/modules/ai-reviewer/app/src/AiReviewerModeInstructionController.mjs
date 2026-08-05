// @ts-check

import {
  AiReviewerModeInstructionConflictError,
  AiReviewerModeInstructionValidationError,
} from "./AiReviewerModeInstructionStore.mjs";
import { WorkspaceRevisionSchema } from "../../shared/contracts.mjs";

/** @import { Request, Response } from "express" */

const ERRORS = {
  invalid: {
    code: "AI_REVIEWER_MODE_INSTRUCTIONS_INVALID",
    message: "The AI reviewer perspectives are invalid.",
  },
  conflict: {
    code: "AI_REVIEWER_MODE_INSTRUCTIONS_CHANGED",
    message:
      "The AI reviewer perspectives changed in another session. Reload before continuing.",
  },
  failed: {
    code: "AI_REVIEWER_MODE_INSTRUCTIONS_FAILED",
    message: "The AI reviewer perspectives request failed.",
  },
};

/** @param {unknown} input */
function identifier(input) {
  try {
    const value = /** @type {any} */ (input)?.toString?.();
    if (typeof value !== "string" || value.length === 0 || value.length > 200) {
      throw new AiReviewerModeInstructionValidationError();
    }
    return value;
  } catch (error) {
    if (error instanceof AiReviewerModeInstructionValidationError) {
      throw error;
    }
    throw new AiReviewerModeInstructionValidationError();
  }
}

/** @param {Request} request */
function requestScope(request) {
  return {
    userId: identifier(/** @type {any} */ (request.user)?._id),
    projectId: identifier(request.params.project_id),
  };
}

/**
 * @param {Response} response
 * @param {number} status
 * @param {keyof typeof ERRORS} kind
 */
function sendError(response, status, kind) {
  return response.status(status).json({ error: ERRORS[kind] });
}

/** @param {unknown} error @param {Response} response */
function handleError(error, response) {
  if (error instanceof AiReviewerModeInstructionConflictError) {
    return sendError(response, 409, "conflict");
  }
  if (error instanceof AiReviewerModeInstructionValidationError) {
    return sendError(response, 400, "invalid");
  }
  return sendError(response, 500, "failed");
}

/** @param {{ modeInstructionStore: any }} dependencies */
export function createAiReviewerModeInstructionController({
  modeInstructionStore,
}) {
  return {
    /** @param {Request} request @param {Response} response */
    async getModeInstructions(request, response) {
      try {
        const { userId, projectId } = requestScope(request);
        return response.json(
          await modeInstructionStore.load(userId, projectId),
        );
      } catch (error) {
        return handleError(error, response);
      }
    },

    /** @param {Request} request @param {Response} response */
    async saveModeInstructions(request, response) {
      try {
        const { userId, projectId } = requestScope(request);
        const body = request.body;
        const revision = WorkspaceRevisionSchema.safeParse(body?.revision);
        if (
          typeof body !== "object" ||
          body == null ||
          Array.isArray(body) ||
          Object.keys(body).sort().join(",") !== "instructions,revision" ||
          !revision.success
        ) {
          throw new AiReviewerModeInstructionValidationError();
        }
        return response.json(
          await modeInstructionStore.save(
            userId,
            projectId,
            body.instructions,
            revision.data,
          ),
        );
      } catch (error) {
        return handleError(error, response);
      }
    },
  };
}
