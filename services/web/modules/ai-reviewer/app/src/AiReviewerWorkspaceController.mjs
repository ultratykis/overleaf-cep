// @ts-check

import {
  AiReviewerWorkspaceConflictError,
  AiReviewerWorkspaceLimitError,
  AiReviewerWorkspaceValidationError,
} from "./AiReviewerWorkspaceStore.mjs";
import { WorkspaceRevisionSchema } from "../../shared/contracts.mjs";

/** @import { Request, Response } from "express" */

const ERRORS = {
  invalid: {
    code: "AI_REVIEWER_WORKSPACE_INVALID",
    message: "The AI reviewer workspace is invalid.",
  },
  limit: {
    code: "AI_REVIEWER_WORKSPACE_LIMIT_REACHED",
    message: "Delete a discussion before adding more saved discussion content.",
  },
  conflict: {
    code: "AI_REVIEWER_WORKSPACE_CHANGED",
    message:
      "The saved review workspace changed in another session. Reload before continuing.",
  },
  failed: {
    code: "AI_REVIEWER_WORKSPACE_FAILED",
    message: "The AI reviewer workspace request failed.",
  },
};

/**
 * @param {unknown} input
 * @returns {string}
 */
function identifier(input) {
  try {
    const value = /** @type {any} */ (input)?.toString?.();
    if (typeof value !== "string" || value.length === 0 || value.length > 200) {
      throw new AiReviewerWorkspaceValidationError();
    }
    return value;
  } catch (error) {
    if (error instanceof AiReviewerWorkspaceValidationError) {
      throw error;
    }
    throw new AiReviewerWorkspaceValidationError();
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

/**
 * @param {unknown} error
 * @param {Response} response
 */
function handleError(error, response) {
  if (error instanceof AiReviewerWorkspaceLimitError) {
    return sendError(response, 409, "limit");
  }
  if (error instanceof AiReviewerWorkspaceConflictError) {
    return sendError(response, 409, "conflict");
  }
  if (error instanceof AiReviewerWorkspaceValidationError) {
    return sendError(response, 400, "invalid");
  }
  return sendError(response, 500, "failed");
}

/** @param {{ workspaceStore: any }} dependencies */
export function createAiReviewerWorkspaceController({ workspaceStore }) {
  /**
   * @param {Request} request
   * @param {Response} response
   */
  async function getWorkspace(request, response) {
    try {
      const { userId, projectId } = requestScope(request);
      const snapshot = await workspaceStore.load(userId, projectId);
      return response.json(snapshot);
    } catch (error) {
      return handleError(error, response);
    }
  }

  /**
   * @param {Request} request
   * @param {Response} response
   */
  async function saveWorkspace(request, response) {
    try {
      const { userId, projectId } = requestScope(request);
      const body = request.body;
      const revision = WorkspaceRevisionSchema.safeParse(body?.revision);
      if (
        typeof body !== "object" ||
        body == null ||
        Array.isArray(body) ||
        Object.keys(body).sort().join(",") !== "revision,workspace" ||
        !revision.success
      ) {
        throw new AiReviewerWorkspaceValidationError();
      }
      const snapshot = await workspaceStore.save(
        userId,
        projectId,
        body.workspace,
        revision.data,
      );
      return response.json(snapshot);
    } catch (error) {
      return handleError(error, response);
    }
  }

  /**
   * @param {Request} request
   * @param {Response} response
   */
  async function deleteDiscussion(request, response) {
    try {
      const { userId, projectId } = requestScope(request);
      const discussionId = identifier(request.params.discussion_id);
      const snapshot = await workspaceStore.deleteDiscussion(
        userId,
        projectId,
        discussionId,
      );
      return response.json(snapshot);
    } catch (error) {
      return handleError(error, response);
    }
  }

  /**
   * @param {Request} request
   * @param {Response} response
   */
  async function deleteWorkspace(request, response) {
    try {
      const { userId, projectId } = requestScope(request);
      const snapshot = await workspaceStore.deleteWorkspace(userId, projectId);
      return response.json(snapshot);
    } catch (error) {
      return handleError(error, response);
    }
  }

  return {
    getWorkspace,
    saveWorkspace,
    deleteDiscussion,
    deleteWorkspace,
  };
}
