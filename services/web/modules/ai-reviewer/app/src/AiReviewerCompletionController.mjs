// @ts-check

import logger from "@overleaf/logger";
import { z } from "zod";

import { deriveAiReviewerChatRequestUrl } from "../../shared/provider-request-url.mjs";
import { AgentGatewayError } from "./AgentGateway.mjs";
import {
  classifyAiReviewerProviderConnection,
  parseAiReviewerConnectionId,
} from "./AiReviewerProviderConfig.mjs";
import { AiReviewerConnectionNotFoundError } from "./AiReviewerProviderConfigStore.mjs";
import {
  assertOpenAiCompatibleCredentialTransport,
  parseOpenAiCompatibleModelId,
} from "./OllamaEndpointPolicy.mjs";
import { createGuardedOpenAiCompatibleFetch } from "./OllamaOpenAiTransport.mjs";

/** @import { Request, Response } from 'express' */

const COMPLETION_SYSTEM_PROMPT =
  "You are a text completion engine. Output ONLY the missing text, in the same language as the surrounding text. No thinking, no explanation, no markdown, no code fences. Just the raw continuation characters.";
const COMPLETION_USER_PROMPT =
  "Complete the text at [CURSOR]. Output only the few words that replace [CURSOR]:\n\n";
const MAX_IN_FLIGHT_COMPLETIONS_PER_USER = 3;

const CompletionRequestSchema = z
  .object({
    connectionId: z.string(),
    model: z.string(),
    leftContext: z.string().max(4_000),
    rightContext: z.string().max(1_000),
    maxLength: z.number().int().min(1).max(200),
  })
  .strict();

const ERRORS = Object.freeze({
  invalid: Object.freeze({
    code: "AI_COMPLETION_REQUEST_INVALID",
    category: "configuration",
    message: "The inline completion request is invalid.",
    retryable: false,
  }),
  authentication: Object.freeze({
    code: "AI_AUTHENTICATION_REQUIRED",
    category: "authentication",
    message: "Authentication is required.",
    retryable: false,
  }),
  connectionMissing: Object.freeze({
    code: "AI_PROVIDER_CONNECTION_NOT_FOUND",
    category: "configuration",
    message: "The selected AI provider connection does not exist.",
    retryable: false,
  }),
  localOnly: Object.freeze({
    code: "AI_COMPLETION_REQUIRES_LOCAL_CONNECTION",
    category: "configuration",
    message: "Inline completion requires a local OpenAI-compatible connection.",
    retryable: false,
  }),
  modelUnavailable: Object.freeze({
    code: "AI_COMPLETION_MODEL_UNAVAILABLE",
    category: "configuration",
    message: "The selected model is unavailable for this connection.",
    retryable: false,
  }),
  concurrency: Object.freeze({
    code: "AI_COMPLETION_CONCURRENCY_LIMITED",
    category: "rate-limit",
    message: "Too many inline completion requests are already running.",
    retryable: true,
  }),
  configuration: Object.freeze({
    code: "AI_COMPLETION_CONFIGURATION_FAILED",
    category: "configuration",
    message: "The inline completion connection could not be loaded.",
    retryable: true,
  }),
  provider: Object.freeze({
    code: "AI_COMPLETION_PROVIDER_FAILED",
    category: "provider",
    message: "The inline completion provider request failed.",
    retryable: true,
  }),
});

/** @param {Response} response @param {number} status @param {keyof typeof ERRORS} kind */
function sendError(response, status, kind) {
  return response.status(status).json({ success: false, error: ERRORS[kind] });
}

/** @param {Request} request */
function authenticatedUserId(request) {
  const value = /** @type {any} */ (request.user)?._id?.toString?.();
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("authenticated user required");
  }
  return value;
}

/** @param {unknown} input */
function completionText(input) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("The completion response is invalid.");
  }
  const choices = /** @type {any} */ (input).choices;
  const content = Array.isArray(choices) ? choices[0]?.message?.content : null;
  if (typeof content !== "string") {
    throw new TypeError("The completion response is invalid.");
  }
  const trimmed = content.trim();
  return trimmed
    .replace(/^```(?:[A-Za-z0-9_-]+)?(?:\r?\n|$)/u, "")
    .replace(/(?:\r?\n)?```$/u, "")
    .trim();
}

/** @param {globalThis.Response} response */
function discardResponseBody(response) {
  try {
    Promise.resolve(response.body?.cancel()).catch(() => {});
  } catch {
    // The bounded client failure does not depend on an untrusted body cleanup.
  }
}

/** @param {unknown} error */
function isUnavailableModel(error) {
  return (
    error instanceof AgentGatewayError &&
    [
      "AI_PROVIDER_CONFIGURATION_INVALID",
      "AI_PROVIDER_MODEL_NOT_SELECTED",
    ].includes(error.code)
  );
}

/** @param {() => number} elapsedNow */
function readElapsedNow(elapsedNow) {
  try {
    const value = elapsedNow();
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/** @param {number} startedAt @param {() => number} elapsedNow */
function elapsedMilliseconds(startedAt, elapsedNow) {
  return Math.max(0, Math.round(readElapsedNow(elapsedNow) - startedAt));
}

/** @param {any} dependencies */
export function createAiReviewerCompletionController(dependencies) {
  const {
    configStore,
    providerService,
    resolveModel,
    fetchImpl = globalThis.fetch,
    timeoutSignalFactory = () => AbortSignal.timeout(10_000),
    elapsedNow = () => performance.now(),
    logger: completionLogger = logger,
  } = dependencies;
  if (
    typeof configStore?.get !== "function" ||
    typeof resolveModel !== "function" ||
    typeof fetchImpl !== "function" ||
    typeof timeoutSignalFactory !== "function"
  ) {
    throw new TypeError("The inline completion controller is invalid.");
  }
  const inFlightByUser = new Map();

  /** @param {string} userId */
  function acquire(userId) {
    const inFlight = inFlightByUser.get(userId) ?? 0;
    // ponytail: process-local ceiling is 3; use a shared store if web replicas need a global limit.
    if (inFlight >= MAX_IN_FLIGHT_COMPLETIONS_PER_USER) return false;
    inFlightByUser.set(userId, inFlight + 1);
    return true;
  }

  /** @param {string} userId */
  function release(userId) {
    const inFlight = inFlightByUser.get(userId) ?? 0;
    if (inFlight <= 1) inFlightByUser.delete(userId);
    else inFlightByUser.set(userId, inFlight - 1);
  }

  /**
   * @param {"success" | "provider-failure"} statusClass
   * @param {number} startedAt
   * @param {string} connectionId
   * @param {string} model
   */
  function record(statusClass, startedAt, connectionId, model) {
    try {
      const method = statusClass === "success" ? "info" : "warn";
      completionLogger[method](
        {
          elapsedMs: elapsedMilliseconds(startedAt, elapsedNow),
          statusClass,
          connectionId,
          model,
        },
        "AI reviewer completion request finished",
      );
    } catch {
      // Logging cannot replace the bounded public response.
    }
  }

  /** @param {Request} request @param {Response} response */
  async function completion(request, response) {
    let input;
    try {
      input = CompletionRequestSchema.parse(request.body);
      input.connectionId = parseAiReviewerConnectionId(input.connectionId);
    } catch {
      return sendError(response, 400, "invalid");
    }
    let userId;
    try {
      userId = authenticatedUserId(request);
    } catch {
      return sendError(response, 401, "authentication");
    }
    if (!acquire(userId)) {
      return sendError(response, 429, "concurrency");
    }

    const startedAt = readElapsedNow(elapsedNow);
    const disconnected = new AbortController();
    let onClose = null;
    let resolvedModel = null;
    let requestedModel = null;
    try {
      const timeout = timeoutSignalFactory();
      const signal = AbortSignal.any([disconnected.signal, timeout]);
      // The request stream's "close" fires once the body is consumed, so it
      // cannot signal a client disconnect. The response closes early only
      // when the client goes away before the answer is written.
      onClose = () => {
        if (response.writableEnded !== true) {
          disconnected.abort(new Error("client disconnected"));
        }
      };
      response.once?.("close", onClose);
      let connection;
      try {
        connection = await configStore.get(userId, input.connectionId);
      } catch (error) {
        if (error instanceof AiReviewerConnectionNotFoundError) {
          return sendError(response, 404, "connectionMissing");
        }
        return sendError(response, 500, "configuration");
      }
      if (connection == null) {
        return sendError(response, 404, "connectionMissing");
      }
      try {
        if (
          classifyAiReviewerProviderConnection(connection) !== "local" ||
          connection.provider !== "openai-compatible"
        ) {
          return sendError(response, 403, "localOnly");
        }
      } catch {
        return sendError(response, 403, "localOnly");
      }

      try {
        requestedModel = parseOpenAiCompatibleModelId(input.model);
      } catch {
        return sendError(response, 400, "modelUnavailable");
      }
      try {
        resolvedModel = await resolveModel(
          connection,
          { request: { model: requestedModel }, signal },
          providerService,
          userId,
        );
      } catch (error) {
        if (isUnavailableModel(error)) {
          return sendError(response, 400, "modelUnavailable");
        }
        record(
          "provider-failure",
          startedAt,
          input.connectionId,
          requestedModel,
        );
        return sendError(response, 502, "provider");
      }
      resolvedModel = parseOpenAiCompatibleModelId(resolvedModel);
      signal.throwIfAborted();
      assertOpenAiCompatibleCredentialTransport(
        connection.baseUrl,
        typeof connection.credential === "string",
      );
      const url = deriveAiReviewerChatRequestUrl({
        provider: "openai-compatible",
        baseUrl: connection.baseUrl,
        ...(connection.apiVersion == null
          ? {}
          : { apiVersion: connection.apiVersion }),
      });
      const guardedFetch = createGuardedOpenAiCompatibleFetch({
        baseUrl: connection.baseUrl,
        allowedRequestUrl: url,
        fetchImpl,
      });
      const headers = new Headers({
        Accept: "application/json",
        "Content-Type": "application/json",
      });
      if (typeof connection.credential === "string") {
        headers.set("Authorization", `Bearer ${connection.credential}`);
      }
      const providerResponse = await guardedFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: resolvedModel,
          messages: [
            { role: "system", content: COMPLETION_SYSTEM_PROMPT },
            {
              role: "user",
              content: `${COMPLETION_USER_PROMPT}${input.leftContext}[CURSOR]${input.rightContext}`,
            },
          ],
          max_tokens: Math.min(96, Math.max(8, Math.ceil(input.maxLength / 2))),
          temperature: 0.2,
          reasoning_effort: "none",
          stream: false,
        }),
        signal,
      });
      if (!(providerResponse instanceof Response) || !providerResponse.ok) {
        if (providerResponse instanceof Response) {
          discardResponseBody(providerResponse);
        }
        throw new Error("The inline completion provider request failed.");
      }
      const data = completionText(await providerResponse.json());
      record("success", startedAt, input.connectionId, resolvedModel);
      return response.json({ success: true, data });
    } catch {
      record(
        "provider-failure",
        startedAt,
        input.connectionId,
        resolvedModel ?? requestedModel ?? "unavailable",
      );
      return sendError(response, 502, "provider");
    } finally {
      if (onClose != null) response.removeListener?.("close", onClose);
      release(userId);
    }
  }

  return Object.freeze({ completion });
}
