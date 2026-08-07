// @ts-check

import { WorkspaceRevisionSchema } from "../../shared/contracts.mjs";
import {
  AiReviewerExternalAgentSessionConflictError,
  AiReviewerExternalAgentSessionNotFoundError,
  AiReviewerExternalAgentSessionValidationError,
} from "./ExternalAgentSessionStore.mjs";
import { authenticatedUserId } from "./RequestScopeReader.mjs";

/** @import { Request, Response } from "express" */

const ERRORS = Object.freeze({
  invalid: Object.freeze({
    code: "AI_EXTERNAL_SESSION_INVALID",
    message: "The external AI reviewer session request is invalid.",
    retryable: false,
  }),
  notFound: Object.freeze({
    code: "AI_EXTERNAL_SESSION_NOT_FOUND",
    message: "The external AI reviewer session could not be found.",
    retryable: false,
  }),
  changed: Object.freeze({
    code: "AI_EXTERNAL_SESSION_CHANGED",
    message: "The external AI reviewer session changed. Reload and try again.",
    retryable: true,
  }),
  intermediate: Object.freeze({
    code: "AI_EXTERNAL_SESSION_INTERMEDIATE_STATE",
    message:
      "The external AI reviewer session has an unfinished operation. Reload before trying again.",
    retryable: true,
  }),
  failed: Object.freeze({
    code: "AI_EXTERNAL_SESSION_FAILED",
    message: "The external AI reviewer session request failed.",
    retryable: true,
  }),
});

const OPERATION_TIMEOUT_MS = 10_000;

/** @param {unknown} value */
function identifier(value) {
  try {
    const parsed = /** @type {any} */ (value)?.toString?.();
    if (
      typeof parsed !== "string" ||
      parsed.length === 0 ||
      parsed.length > 200
    ) {
      throw new AiReviewerExternalAgentSessionValidationError();
    }
    return parsed;
  } catch (error) {
    if (error instanceof AiReviewerExternalAgentSessionValidationError) {
      throw error;
    }
    throw new AiReviewerExternalAgentSessionValidationError();
  }
}

/** @param {Request} request */
function requestScope(request) {
  return {
    userId: authenticatedUserId(request),
    projectId: identifier(request.params.project_id),
    clientSessionId: identifier(request.params.agent_session_id),
  };
}

/** @param {Request} request */
function requestRevision(request) {
  const body = request.body;
  const parsed = WorkspaceRevisionSchema.safeParse(body?.revision);
  if (
    body == null ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).join(",") !== "revision" ||
    !parsed.success
  ) {
    throw new AiReviewerExternalAgentSessionValidationError();
  }
  return parsed.data;
}

/** @param {any} session */
function publicSession(session) {
  return Object.freeze({
    agentSessionId: session.clientSessionId,
    mode: session.mode,
    status: session.status,
    lastActivityAt: session.lastActivityAt.toISOString(),
    stateBytes: session.stateBytes,
    revision: session.revision,
    operationInProgress: session.operationClaim != null,
  });
}

/** @param {Response} response @param {number} status @param {keyof typeof ERRORS} kind */
function sendError(response, status, kind) {
  return response.status(status).json({ error: ERRORS[kind] });
}

/** @param {unknown} error @param {Response} response */
function handleError(error, response) {
  if (error instanceof AiReviewerExternalAgentSessionNotFoundError) {
    return sendError(response, 404, "notFound");
  }
  if (error instanceof AiReviewerExternalAgentSessionConflictError) {
    return sendError(response, 409, "changed");
  }
  if (error instanceof AiReviewerExternalAgentSessionValidationError) {
    return sendError(response, 400, "invalid");
  }
  return sendError(response, 500, "failed");
}

/**
 * @param {{
 *   sessionStore: any,
 *   runnerClient: any,
 *   enabled?: boolean,
 *   operationTimeoutSignalFactory?: () => AbortSignal,
 * }} dependencies
 */
export function createExternalAgentSessionController({
  sessionStore,
  runnerClient,
  enabled = true,
  operationTimeoutSignalFactory = () =>
    AbortSignal.timeout(OPERATION_TIMEOUT_MS),
}) {
  /**
   * @param {"resolve" | "reopen"} type
   * @param {Request} request
   * @param {Response} response
   */
  async function changeState(type, request, response) {
    let claimed = false;
    try {
      const scope = requestScope(request);
      const revision = requestRevision(request);
      const session = await sessionStore.load(scope);
      if (session.operationClaim != null) {
        return sendError(response, 409, "intermediate");
      }
      const claim = await sessionStore.claim({
        ...scope,
        type,
        expectedRevision: revision,
        expectedThreadId: session.threadId,
      });
      claimed = true;
      const result = await runnerClient[
        type === "resolve" ? "archive" : "unarchive"
      ](
        {
          stateRootKey: claim.stateRootKey,
          threadId: claim.threadId,
        },
        {
          signal: operationTimeoutSignalFactory(),
        },
      );
      const completed = await sessionStore.finalize({
        ...scope,
        type,
        claimId: claim.operationClaim.id,
        expectedRevision: claim.revision,
        stateBytes: result.stateBytes,
      });
      return response.json(publicSession(completed));
    } catch (error) {
      if (claimed) {
        // The runner may already have changed persistent thread state. Keep
        // the Mongo claim as a quarantine instead of guessing an inverse.
        return sendError(response, 409, "intermediate");
      }
      return handleError(error, response);
    }
  }

  return {
    /** @param {Request} request @param {Response} response */
    async getSession(request, response) {
      if (!enabled) return sendError(response, 404, "notFound");
      try {
        return response.json(
          publicSession(await sessionStore.load(requestScope(request))),
        );
      } catch (error) {
        return handleError(error, response);
      }
    },

    /** @param {Request} request @param {Response} response */
    async resolveSession(request, response) {
      if (!enabled) return sendError(response, 404, "notFound");
      return await changeState("resolve", request, response);
    },

    /** @param {Request} request @param {Response} response */
    async reopenSession(request, response) {
      if (!enabled) return sendError(response, 404, "notFound");
      return await changeState("reopen", request, response);
    },
  };
}
