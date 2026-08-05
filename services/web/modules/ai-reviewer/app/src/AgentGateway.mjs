// @ts-check

import {
  AgentEventSchema,
  AgentRequestSchema,
} from "../../shared/contracts.mjs";

/**
 * @import {
 *   AgentEvent,
 *   AgentGateway as AgentGatewayContract,
 *   AgentRequest,
 *   EvidenceReference,
 *   Suggestion,
 * } from '../../shared/contract-types'
 */

const PROVIDER_ERROR_TYPES = new Set([
  "AI_APICallError",
  "AI_InvalidResponseDataError",
  "AI_InvalidToolInputError",
  "AI_LoadAPIKeyError",
  "AI_LoadSettingError",
  "AI_NoObjectGeneratedError",
  "AI_NoOutputGeneratedError",
  "AI_NoSuchModelError",
  "AI_NoSuchToolError",
  "AI_TypeValidationError",
]);
const MODEL_CONTEXT_LENGTH_SOURCES = new Set([
  "derived",
  "detected",
  "default",
  "override",
]);

/** @param {unknown} value */
export function safeProviderStatusCode(value) {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : null;
}

/** @param {unknown} value */
export function safeProviderErrorType(value) {
  return typeof value === "string" && PROVIDER_ERROR_TYPES.has(value)
    ? value
    : null;
}

/** @param {unknown} value */
function safeModelContextLength(value) {
  return Number.isSafeInteger(value) && /** @type {number} */ (value) > 0
    ? /** @type {number} */ (value)
    : null;
}

/** @param {unknown} value */
function safeModelContextLengthSource(value) {
  return typeof value === "string" && MODEL_CONTEXT_LENGTH_SOURCES.has(value)
    ? value
    : null;
}

export class AgentGatewayError extends Error {
  /**
   * @param {string} message
   * @param {{
   *   code: string,
   *   category: 'aborted' | 'authentication' | 'configuration' | 'network' |
   *     'provider' | 'rate-limit' | 'schema' | 'timeout' | 'unknown',
   *   retryable: boolean,
   *   cause?: unknown,
   *   providerStatusCode?: unknown,
   *   providerErrorType?: unknown,
   *   contextLength?: unknown,
   *   contextLengthSource?: unknown,
   * }} details
   */
  constructor(
    message,
    {
      code,
      category,
      retryable,
      cause,
      providerStatusCode,
      providerErrorType,
      contextLength,
      contextLengthSource,
    },
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "AgentGatewayError";
    this.code = code;
    this.category = category;
    this.retryable = retryable;
    this.providerStatusCode = safeProviderStatusCode(providerStatusCode);
    this.providerErrorType = safeProviderErrorType(providerErrorType);
    this.contextLength = safeModelContextLength(contextLength);
    this.contextLengthSource =
      safeModelContextLengthSource(contextLengthSource);
  }
}

export class AgentGatewayAbortError extends AgentGatewayError {
  constructor() {
    super("The AI reviewer request was cancelled.", {
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    this.name = "AgentGatewayAbortError";
  }
}

export class AgentGatewayTimeoutError extends AgentGatewayError {
  /**
   * @param {unknown} [cause]
   */
  constructor(cause) {
    super("The AI reviewer request timed out.", {
      code: "AI_REQUEST_TIMEOUT",
      category: "timeout",
      retryable: true,
      cause,
    });
    this.name = "AgentGatewayTimeoutError";
  }
}

/**
 * @param {AbortSignal} signal
 */
function abortErrorForSignal(signal) {
  if (signal.reason?.name === "TimeoutError") {
    return new AgentGatewayTimeoutError(signal.reason);
  }
  return new AgentGatewayAbortError();
}

/**
 * @param {AbortSignal | undefined} signal
 */
function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw abortErrorForSignal(signal);
  }
}

/**
 * @param {(context: {
 *   index: number,
 *   request: AgentRequest,
 *   signal?: AbortSignal,
 * }) => void | Promise<void>} beforeEvent
 * @param {{
 *   index: number,
 *   request: AgentRequest,
 *   signal?: AbortSignal,
 * }} context
 * @param {AbortSignal | undefined} signal
 */
async function waitForCheckpoint(beforeEvent, context, signal) {
  throwIfAborted(signal);
  if (signal == null) {
    await beforeEvent(context);
    return;
  }

  const checkpoint = Promise.resolve().then(() => beforeEvent(context));
  /** @type {(reason?: unknown) => void} */
  let rejectCancellation = () => {};
  const cancellation = new Promise((_, reject) => {
    rejectCancellation = reject;
  });

  const abortListener = () => rejectCancellation(abortErrorForSignal(signal));
  signal.addEventListener("abort", abortListener, { once: true });
  try {
    await Promise.race([checkpoint, cancellation]);
  } finally {
    signal.removeEventListener("abort", abortListener);
  }
}

/**
 * @param {AgentRequest} request
 * @param {Suggestion} suggestion
 */
export function assertSuggestionForRequest(request, suggestion) {
  // An edit is only checkable against the document state the request carried,
  // so a request without one cannot produce an applicable suggestion.
  if (request.scope == null) {
    throw new AgentGatewayError(
      "A request without a document scope cannot return edit suggestions.",
      {
        code: "AI_SUGGESTION_SCOPE_REQUIRED",
        category: "schema",
        retryable: false,
      },
    );
  }
  if (request.scope.kind === "project") {
    throw new AgentGatewayError(
      "A project review cannot return edit suggestions.",
      {
        code: "AI_PROJECT_SUGGESTION_NOT_ALLOWED",
        category: "schema",
        retryable: false,
      },
    );
  }

  const { scope } = request;
  const identityMatches =
    suggestion.documentId === scope.documentId &&
    suggestion.path === scope.path &&
    suggestion.baseRevision === scope.baseRevision &&
    suggestion.baseTextHash === scope.baseTextHash;
  const rangeStart = scope.kind === "selection" ? scope.range.from : 0;
  const rangeEnd =
    scope.kind === "selection" ? scope.range.to : scope.text.length;
  const rangeMatches =
    suggestion.range.from >= rangeStart && suggestion.range.to <= rangeEnd;
  const originalOffset = suggestion.range.from - rangeStart;
  const originalMatches =
    rangeMatches &&
    scope.text.slice(
      originalOffset,
      originalOffset + suggestion.original.length,
    ) === suggestion.original;

  if (!identityMatches || !rangeMatches || !originalMatches) {
    throw new AgentGatewayError(
      "The provider suggestion does not match the requested document state.",
      {
        code: "AI_EVENT_SCOPE_MISMATCH",
        category: "schema",
        retryable: false,
      },
    );
  }
}

/**
 * @param {AgentRequest} request
 * @param {{ path: string, range?: { from: number, to: number } }} reference
 * @param {{
 *   code: string,
 *   message: string,
 *   requireSelectionRange: boolean,
 * }} failure
 */
function assertPathAndRangeWithinRequest(request, reference, failure) {
  if (request.scope == null || request.scope.kind === "project") {
    return;
  }

  const { scope } = request;
  const lowerBound = scope.kind === "selection" ? scope.range.from : 0;
  const upperBound =
    scope.kind === "selection" ? scope.range.to : scope.text.length;
  const rangeMissing =
    failure.requireSelectionRange &&
    scope.kind === "selection" &&
    reference.range == null;
  const rangeOutside =
    reference.range != null &&
    (reference.range.from < lowerBound || reference.range.to > upperBound);

  if (reference.path !== scope.path || rangeMissing || rangeOutside) {
    throw new AgentGatewayError(failure.message, {
      code: failure.code,
      category: "schema",
      retryable: false,
    });
  }
}

/**
 * @param {AgentRequest} request
 * @param {EvidenceReference} reference
 */
function assertEvidenceReferenceForRequest(request, reference) {
  assertPathAndRangeWithinRequest(request, reference, {
    code: "AI_EVENT_EVIDENCE_SCOPE_MISMATCH",
    message: "The provider evidence is outside the requested document state.",
    requireSelectionRange: true,
  });
  if (
    request.scope != null &&
    request.scope.kind !== "project" &&
    ((reference.revision != null &&
      reference.revision !== request.scope.baseRevision) ||
      (reference.textHash != null &&
        reference.textHash !== request.scope.baseTextHash))
  ) {
    throw new AgentGatewayError(
      "The provider evidence does not match the requested document state.",
      {
        code: "AI_EVENT_EVIDENCE_SCOPE_MISMATCH",
        category: "schema",
        retryable: false,
      },
    );
  }
}

/**
 * @param {AgentRequest} request
 * @param {EvidenceReference[]} evidence
 */
export function assertFindingEvidenceForRequest(request, evidence) {
  // The legacy finding shape has no separate target, and its first evidence
  // entry already owns navigation and migration anchoring. Keeping that entry
  // scoped preserves what the finding is about without treating later support
  // as another edit target.
  assertEvidenceReferenceForRequest(request, evidence[0]);
}

/**
 * @param {AgentRequest} request
 * @param {EvidenceReference[]} evidence
 */
export function assertSuggestionEvidenceForRequest(request, evidence) {
  for (const reference of evidence) {
    assertEvidenceReferenceForRequest(request, reference);
  }
}

/**
 * Enforce request identity at the boundary shared by every provider adapter
 * and the authenticated HTTP controller.
 *
 * @param {AgentRequest} request
 * @param {AgentEvent} event
 * @param {number} expectedSequence
 */
export function assertAgentEventForRequest(request, event, expectedSequence) {
  if (event.requestId !== request.requestId) {
    throw new AgentGatewayError(
      "The provider event does not belong to the active request.",
      {
        code: "AI_EVENT_REQUEST_MISMATCH",
        category: "schema",
        retryable: false,
      },
    );
  }

  const eventProjectId =
    event.type === "finding"
      ? event.finding.projectId
      : event.type === "suggestion"
        ? event.suggestion.projectId
        : null;
  if (eventProjectId != null && eventProjectId !== request.projectId) {
    throw new AgentGatewayError(
      "The provider event does not belong to the active project.",
      {
        code: "AI_EVENT_PROJECT_MISMATCH",
        category: "schema",
        retryable: false,
      },
    );
  }

  const eventSkill =
    event.type === "started"
      ? event.skill
      : event.type === "suggestion"
        ? event.suggestion.skill
        : request.skill;
  if (eventSkill !== request.skill) {
    throw new AgentGatewayError(
      "The provider event does not match the requested skill.",
      {
        code: "AI_EVENT_SKILL_MISMATCH",
        category: "schema",
        retryable: false,
      },
    );
  }

  if (event.type === "finding") {
    assertFindingEvidenceForRequest(request, event.finding.evidence);
  } else if (event.type === "suggestion") {
    assertSuggestionEvidenceForRequest(request, event.suggestion.evidence);
  }

  if (event.type === "suggestion") {
    assertSuggestionForRequest(request, event.suggestion);
  }
  if (event.sequence !== expectedSequence) {
    throw new AgentGatewayError(
      "The provider event sequence is not contiguous.",
      {
        code: "AI_EVENT_SEQUENCE_INVALID",
        category: "schema",
        retryable: false,
      },
    );
  }
}

/**
 * Deterministic test gateway. It never reads time, randomness, the filesystem,
 * network, or project state.
 */
/** @implements {AgentGatewayContract} */
export class ScriptedFakeAgentGateway {
  /** @type {AgentRequest[]} */
  calls = [];

  emittedEventCount = 0;

  /**
   * @param {{
   *   events: unknown[],
   *   beforeEvent?: (context: {
   *     index: number,
   *     request: AgentRequest,
   *     signal?: AbortSignal,
   *   }) => void | Promise<void>,
   * }} options
   */
  constructor({ events, beforeEvent = () => {} }) {
    if (!Array.isArray(events)) {
      throw new TypeError("Scripted fake events must be an array.");
    }
    if (typeof beforeEvent !== "function") {
      throw new TypeError("beforeEvent must be a function.");
    }

    this.events = structuredClone(events);
    this.beforeEvent = beforeEvent;
  }

  /**
   * @param {unknown} input
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {AsyncGenerator<AgentEvent, void, void>}
   */
  async *stream(input, { signal } = {}) {
    throwIfAborted(signal);
    const parsedRequest = AgentRequestSchema.safeParse(input);
    if (!parsedRequest.success) {
      throw new AgentGatewayError("The AI reviewer request is invalid.", {
        code: "AI_REQUEST_SCHEMA_INVALID",
        category: "schema",
        retryable: false,
        cause: parsedRequest.error,
      });
    }
    const request = parsedRequest.data;
    this.calls.push(structuredClone(request));

    for (const [index, rawEvent] of this.events.entries()) {
      await waitForCheckpoint(
        this.beforeEvent,
        { index, request, signal },
        signal,
      );
      throwIfAborted(signal);

      let event;
      try {
        event = AgentEventSchema.parse(structuredClone(rawEvent));
      } catch (cause) {
        throw new AgentGatewayError(
          "The fake provider emitted an invalid event.",
          {
            code: "AI_EVENT_SCHEMA_INVALID",
            category: "schema",
            retryable: false,
            cause,
          },
        );
      }

      assertAgentEventForRequest(request, event, index);
      this.emittedEventCount += 1;
      yield event;
    }
  }
}
