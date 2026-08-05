// @ts-check

import { AgentGatewayAbortError, AgentGatewayError } from "./AgentGateway.mjs";
import {
  parseAiReviewerProviderConfig,
  parseAiReviewerProviderConfigUpdate,
  publicAiReviewerProviderConfig,
} from "./AiReviewerProviderConfig.mjs";

/** @import { Request, Response } from 'express' */

const ERRORS = Object.freeze({
  invalid: Object.freeze({
    code: "AI_PROVIDER_CONFIGURATION_INVALID",
    category: "configuration",
    message: "The AI provider configuration is invalid.",
    retryable: false,
  }),
  missing: Object.freeze({
    code: "AI_PROVIDER_NOT_CONFIGURED",
    category: "configuration",
    message: "No AI provider is configured.",
    retryable: false,
  }),
  timeout: Object.freeze({
    code: "AI_REQUEST_TIMEOUT",
    category: "timeout",
    message: "The AI reviewer request timed out.",
    retryable: true,
  }),
  aborted: Object.freeze({
    code: "AI_REQUEST_ABORTED",
    category: "aborted",
    message: "The AI reviewer request was cancelled.",
    retryable: false,
  }),
  authentication: Object.freeze({
    code: "AI_PROVIDER_AUTHENTICATION_ERROR",
    category: "authentication",
    message: "The AI provider rejected its credentials.",
    retryable: false,
  }),
  network: Object.freeze({
    code: "AI_PROVIDER_NETWORK_FAILED",
    category: "network",
    message: "The AI provider could not be reached.",
    retryable: true,
  }),
  "rate-limit": Object.freeze({
    code: "AI_PROVIDER_RATE_LIMITED",
    category: "rate-limit",
    message: "The AI provider rate limit was reached.",
    retryable: true,
  }),
  schema: Object.freeze({
    code: "AI_PROVIDER_SCHEMA_INVALID",
    category: "schema",
    message: "The AI provider returned invalid data.",
    retryable: false,
  }),
  provider: Object.freeze({
    code: "AI_PROVIDER_ERROR",
    category: "provider",
    message: "The AI provider request failed.",
    retryable: true,
  }),
});

/** @param {Request} request */
function userId(request) {
  const value = /** @type {any} */ (request.user)?._id?.toString?.();
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("authenticated user required");
  }
  return value;
}

/**
 * @param {Response} response
 * @param {number} status
 * @param {keyof typeof ERRORS} kind
 */
function sendError(response, status, kind) {
  const error = ERRORS[kind];
  return response.status(status).json({
    error: {
      code: error.code,
      category: error.category,
      message: error.message,
      retryable: error.retryable,
    },
  });
}

/** @param {unknown} error */
function providerFailureKind(error) {
  if (error instanceof AgentGatewayError) {
    switch (error.category) {
      case "authentication":
      case "network":
      case "rate-limit":
      case "schema":
      case "provider":
        return error.category;
    }
  }
  return /** @type {const} */ ("provider");
}

/** @param {any} dependencies */
export function createAiReviewerProviderController(dependencies) {
  const { configStore, providerService } = dependencies;
  const timeoutSignalFactory =
    dependencies.timeoutSignalFactory ?? (() => AbortSignal.timeout(30_000));
  /**
   * @param {Request} request
   * @param {Response} response
   */
  async function getConfiguration(request, response) {
    try {
      return response.json(
        publicAiReviewerProviderConfig(await configStore.get(userId(request))),
      );
    } catch {
      return sendError(response, 400, "invalid");
    }
  }

  /**
   * @param {Request} request
   * @param {Response} response
   */
  async function saveConfiguration(request, response) {
    try {
      const config = parseAiReviewerProviderConfigUpdate(request.body);
      const saved = await configStore.save(userId(request), config);
      return response.json(publicAiReviewerProviderConfig(saved));
    } catch {
      return sendError(response, 400, "invalid");
    }
  }

  /**
   * @param {Request} request
   * @param {Response} response
   */
  async function testConnection(request, response) {
    let stored;
    try {
      stored = await configStore.get(userId(request));
      if (stored == null) {
        return sendError(response, 409, "missing");
      }
      stored = parseAiReviewerProviderConfig(stored);
    } catch {
      return sendError(response, 409, "invalid");
    }

    const disconnected = new AbortController();
    const timeout = timeoutSignalFactory();
    const signal = AbortSignal.any([disconnected.signal, timeout]);
    const onAborted = () => disconnected.abort(new AgentGatewayAbortError());
    request.once?.("aborted", onAborted);
    try {
      if (timeout.aborted) {
        throw timeout.reason;
      }
      return response.json(
        await providerService.testConnection(stored, { signal }),
      );
    } catch (error) {
      if (timeout.aborted) {
        return sendError(response, 504, "timeout");
      }
      if (
        disconnected.signal.aborted ||
        error instanceof AgentGatewayAbortError ||
        /** @type {any} */ (error)?.category === "aborted"
      ) {
        return sendError(response, 499, "aborted");
      }
      return sendError(response, 502, providerFailureKind(error));
    } finally {
      request.removeListener?.("aborted", onAborted);
    }
  }

  return { getConfiguration, saveConfiguration, testConnection };
}
