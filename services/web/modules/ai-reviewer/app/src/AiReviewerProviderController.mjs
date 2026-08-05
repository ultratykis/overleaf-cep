// @ts-check

import { AgentGatewayAbortError } from "./AgentGateway.mjs";
import {
  parseAiReviewerProviderConfig,
  publicAiReviewerProviderConfig,
} from "./AiReviewerProviderConfig.mjs";

/** @import { Request, Response } from 'express' */

const ERRORS = {
  invalid: [
    "AI_PROVIDER_CONFIGURATION_INVALID",
    "The AI provider configuration is invalid.",
  ],
  missing: ["AI_PROVIDER_NOT_CONFIGURED", "No AI provider is configured."],
  timeout: ["AI_REQUEST_TIMEOUT", "The AI reviewer request timed out."],
  aborted: ["AI_REQUEST_ABORTED", "The AI reviewer request was cancelled."],
  provider: ["AI_PROVIDER_ERROR", "The AI provider request failed."],
};

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
  const [code, message] = ERRORS[kind];
  const category = ["invalid", "missing"].includes(kind)
    ? "configuration"
    : kind;
  const retryable = kind === "timeout" || kind === "provider";
  return response
    .status(status)
    .json({ error: { code, category, message, retryable } });
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
      const config = parseAiReviewerProviderConfig(request.body);
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
      return sendError(response, 502, "provider");
    } finally {
      request.removeListener?.("aborted", onAborted);
    }
  }

  return { getConfiguration, saveConfiguration, testConnection };
}
