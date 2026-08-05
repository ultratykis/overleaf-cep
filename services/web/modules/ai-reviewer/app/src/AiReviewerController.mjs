// @ts-check

import { randomUUID } from "node:crypto";

import { ZodError } from "zod";

import {
  AgentEventSchema,
  AgentRequestSchema,
} from "../../shared/contracts.mjs";
import {
  AgentGatewayAbortError,
  AgentGatewayError,
  assertAgentEventForRequest,
} from "./AgentGateway.mjs";

/** @import { AgentError, AgentEvent, AgentGateway, AgentRequest } from '../../shared/contract-types' */
/** @import { Request, Response } from 'express' */

const DEFAULT_TIMEOUT_MS = 60_000;
const FALLBACK_ERROR_EVENT_ID = "ai-error";
const FALLBACK_ERROR_CREATED_AT = "1970-01-01T00:00:00.000Z";

/** @type {Readonly<Record<AgentError["category"], AgentError>>} */
const PUBLIC_ERRORS = Object.freeze({
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
  configuration: Object.freeze({
    code: "AI_PROVIDER_NOT_CONFIGURED",
    category: "configuration",
    message: "No AI provider is configured.",
    retryable: false,
  }),
  network: Object.freeze({
    code: "AI_PROVIDER_NETWORK_ERROR",
    category: "network",
    message: "The AI provider could not be reached.",
    retryable: true,
  }),
  provider: Object.freeze({
    code: "AI_PROVIDER_ERROR",
    category: "provider",
    message: "The AI provider request failed.",
    retryable: true,
  }),
  "rate-limit": Object.freeze({
    code: "AI_PROVIDER_RATE_LIMITED",
    category: "rate-limit",
    message: "The AI provider rate limit was reached.",
    retryable: true,
  }),
  schema: Object.freeze({
    code: "AI_STREAM_PROTOCOL_ERROR",
    category: "schema",
    message: "The AI provider returned invalid stream data.",
    retryable: false,
  }),
  timeout: Object.freeze({
    code: "AI_REQUEST_TIMEOUT",
    category: "timeout",
    message: "The AI reviewer request timed out.",
    retryable: true,
  }),
  unknown: Object.freeze({
    code: "AI_PROVIDER_ERROR",
    category: "unknown",
    message: "The AI provider request failed.",
    retryable: true,
  }),
});

/**
 * Return a bounded public error selected only by a known category. Provider
 * messages, codes, and retry hints never cross the HTTP boundary.
 *
 * @param {unknown} category
 * @returns {AgentError}
 */
function publicErrorForCategory(category) {
  switch (category) {
    case "aborted":
    case "authentication":
    case "configuration":
    case "network":
    case "provider":
    case "rate-limit":
    case "schema":
    case "timeout":
      return { ...PUBLIC_ERRORS[category] };
    default:
      return { ...PUBLIC_ERRORS.unknown };
  }
}

/**
 * @param {unknown} error
 * @param {{ disconnectSignal: AbortSignal, timeoutSignal: AbortSignal }} signals
 * @returns {AgentError}
 */
function classifyError(error, { disconnectSignal, timeoutSignal }) {
  if (timeoutSignal.aborted) {
    return publicErrorForCategory("timeout");
  }
  if (disconnectSignal.aborted) {
    return publicErrorForCategory("aborted");
  }
  if (error instanceof ZodError) {
    return publicErrorForCategory("schema");
  }
  if (error instanceof AgentGatewayError) {
    return publicErrorForCategory(error.category);
  }
  return publicErrorForCategory("unknown");
}

/**
 * @param {AbortSignal} signal
 * @returns {AgentGatewayAbortError}
 */
function abortErrorForSignal(signal) {
  return signal.reason instanceof AgentGatewayAbortError
    ? signal.reason
    : new AgentGatewayAbortError();
}

/**
 * Race producer work against cancellation without relying on the producer to
 * observe its signal. Resolution and rejection handlers remain attached to the
 * producer promise so a late failure cannot become unhandled.
 *
 * @template T
 * @param {PromiseLike<T> | T} work
 * @param {AbortSignal} signal
 * @returns {Promise<T>}
 */
function raceWithAbort(work, signal) {
  if (signal.aborted) {
    return Promise.reject(abortErrorForSignal(signal));
  }

  return new Promise((resolve, reject) => {
    const handleAbort = () => {
      cleanup();
      reject(abortErrorForSignal(signal));
    };
    const cleanup = () => {
      signal.removeEventListener("abort", handleAbort);
    };

    signal.addEventListener("abort", handleAbort, { once: true });
    Promise.resolve(work).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * @param {Response} response
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
function waitForDrain(response, signal) {
  if (signal.aborted) {
    return Promise.reject(abortErrorForSignal(signal));
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.removeListener("drain", handleDrain);
      signal.removeEventListener("abort", handleAbort);
    };
    const handleDrain = () => {
      cleanup();
      resolve();
    };
    const handleAbort = () => {
      cleanup();
      reject(abortErrorForSignal(signal));
    };

    response.once("drain", handleDrain);
    signal.addEventListener("abort", handleAbort, { once: true });
  });
}

/**
 * @param {Response} response
 * @param {AgentEvent} event
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<void> | undefined}
 */
function writeEvent(response, event, signal) {
  const hasCapacity = response.write(`${JSON.stringify(event)}\n`);
  if (!hasCapacity && signal != null) {
    return waitForDrain(response, signal);
  }
}

/**
 * @param {unknown} rawEvent
 * @param {AgentRequest} request
 * @param {number} sequence
 * @returns {AgentEvent}
 */
function validateStreamEvent(rawEvent, request, sequence) {
  const event = AgentEventSchema.parse(rawEvent);
  assertAgentEventForRequest(request, event, sequence);

  if (event.type === "error") {
    return {
      ...event,
      error: publicErrorForCategory(event.error.category),
    };
  }
  return event;
}

/**
 * @param {AgentEvent} event
 */
function isTerminalEvent(event) {
  return event.type === "completed" || event.type === "error";
}

/**
 * @param {{
 *   requestId: string,
 *   sequence: number,
 *   error: AgentError,
 *   now: () => string,
 *   eventId: () => string,
 * }} input
 * @returns {AgentEvent}
 */
function buildErrorEvent({ requestId, sequence, error, now, eventId }) {
  try {
    const result = AgentEventSchema.safeParse({
      type: "error",
      eventId: eventId(),
      requestId,
      sequence,
      createdAt: now(),
      error,
    });
    if (result.success) {
      return result.data;
    }
  } catch {
    // Use the constant, schema-valid fallback below.
  }

  return {
    type: "error",
    eventId: FALLBACK_ERROR_EVENT_ID,
    requestId,
    sequence,
    createdAt: FALLBACK_ERROR_CREATED_AT,
    error: publicErrorForCategory(error.category),
  };
}

/**
 * Request producer cleanup without allowing a non-cooperative `return()` to
 * hold the HTTP request open.
 *
 * @param {AsyncIterator<unknown> | undefined} iterator
 */
function closeIterator(iterator) {
  if (iterator == null || typeof iterator.return !== "function") {
    return;
  }

  try {
    Promise.resolve(iterator.return()).catch(() => {});
  } catch {
    // Cleanup failure cannot replace the terminal HTTP result.
  }
}

/**
 * Give a cooperative producer one event-loop turn to observe cancellation
 * before calling `return()`. The bound preserves prompt settlement for a
 * producer that ignores both mechanisms.
 *
 * @param {PromiseLike<unknown>} work
 */
async function allowAbortPropagation(work) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    await Promise.race([
      Promise.resolve(work).then(
        () => {},
        () => {},
      ),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 0);
      }),
    ]);
  } finally {
    if (timer != null) {
      clearTimeout(timer);
    }
  }
}

/**
 * @param {{
 *   gatewayFactory: () => AgentGateway,
 *   timeoutSignalFactory?: () => AbortSignal,
 *   now?: () => string,
 *   eventId?: () => string,
 * }} dependencies
 */
export function createAiReviewerController({
  gatewayFactory,
  timeoutSignalFactory = () => AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  now = () => new Date().toISOString(),
  eventId = randomUUID,
}) {
  if (typeof gatewayFactory !== "function") {
    throw new TypeError("gatewayFactory must be a function.");
  }

  /**
   * @param {Request} request
   * @param {Response} response
   */
  async function stream(request, response) {
    const parsedRequest = AgentRequestSchema.safeParse(request.body);
    if (!parsedRequest.success) {
      return response.status(400).json({
        error: {
          code: "AI_REQUEST_SCHEMA_INVALID",
          category: "schema",
          message: "The AI reviewer request is invalid.",
          retryable: false,
        },
      });
    }
    if (parsedRequest.data.projectId !== request.params.project_id) {
      return response.status(400).json({
        error: {
          code: "AI_REQUEST_PROJECT_MISMATCH",
          category: "schema",
          message: "The AI reviewer request does not match this project.",
          retryable: false,
        },
      });
    }

    response.status(200);
    response.setHeader("content-type", "application/x-ndjson; charset=utf-8");
    response.setHeader("cache-control", "no-store");
    response.setHeader("x-accel-buffering", "no");
    response.flushHeaders?.();

    const disconnectController = new AbortController();
    const timeoutSignal = timeoutSignalFactory();
    const signal = AbortSignal.any([
      disconnectController.signal,
      timeoutSignal,
    ]);
    const handleClose = () => {
      if (!response.writableEnded) {
        disconnectController.abort(
          new DOMException("The client closed the stream.", "AbortError"),
        );
      }
    };
    const handleAborted = () => {
      disconnectController.abort(
        new DOMException("The client aborted the request.", "AbortError"),
      );
    };
    response.once("close", handleClose);
    request.once?.("aborted", handleAborted);

    let nextSequence = 0;
    let iterator;
    let pendingStep;
    let iteratorFinished = false;
    try {
      const gateway = gatewayFactory();
      const stream = gateway.stream(parsedRequest.data, { signal });
      const activeIterator = stream[Symbol.asyncIterator]();
      iterator = activeIterator;

      while (true) {
        pendingStep = activeIterator.next();
        const step = await raceWithAbort(pendingStep, signal);
        pendingStep = undefined;
        if (step == null || typeof step !== "object") {
          throw new AgentGatewayError(
            "The AI provider returned an invalid iterator result.",
            {
              code: "AI_STREAM_ITERATOR_INVALID",
              category: "schema",
              retryable: false,
            },
          );
        }
        if (step.done === true) {
          iteratorFinished = true;
          throw new AgentGatewayError(
            "The AI provider stream ended without a terminal event.",
            {
              code: "AI_STREAM_TERMINAL_MISSING",
              category: "schema",
              retryable: false,
            },
          );
        }
        if (signal.aborted || response.destroyed || response.writableEnded) {
          throw abortErrorForSignal(signal);
        }

        const event = validateStreamEvent(
          step.value,
          parsedRequest.data,
          nextSequence,
        );
        const terminal = isTerminalEvent(event);
        const capacity = writeEvent(response, event, signal);
        nextSequence += 1;

        if (capacity != null) {
          try {
            await capacity;
          } catch (error) {
            if (terminal && signal.aborted) {
              break;
            }
            throw error;
          }
        }
        if (terminal) {
          break;
        }
      }
    } catch (error) {
      if (
        response.destroyed ||
        response.writableEnded ||
        disconnectController.signal.aborted
      ) {
        return;
      }

      const errorEvent = buildErrorEvent({
        requestId: parsedRequest.data.requestId,
        sequence: nextSequence,
        error: classifyError(error, {
          disconnectSignal: disconnectController.signal,
          timeoutSignal,
        }),
        now,
        eventId,
      });
      try {
        await writeEvent(response, errorEvent, undefined);
      } catch {
        // A broken response cannot receive a typed terminal event.
      }
    } finally {
      response.removeListener("close", handleClose);
      request.removeListener?.("aborted", handleAborted);
      if (signal.aborted && pendingStep != null) {
        await allowAbortPropagation(pendingStep);
      }
      if (!iteratorFinished) {
        closeIterator(iterator);
      }
      if (
        !disconnectController.signal.aborted &&
        !response.destroyed &&
        !response.writableEnded
      ) {
        response.end();
      }
    }
  }

  return { stream };
}
