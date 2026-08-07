// @ts-check

import { randomUUID } from "node:crypto";

import {
  AgentEventSchema,
  AgentRequestSchema,
  SuggestionSchema,
} from "../../shared/contracts.mjs";
import {
  AgentGatewayAbortError,
  AgentGatewayError,
  AgentGatewayTimeoutError,
  assertAgentEventForRequest,
  assertSuggestionForRequest,
} from "./AgentGateway.mjs";
import { formatAgentPrompt } from "./AiReviewerPrompt.mjs";
import { parseAiReviewerProviderCredential } from "./AiReviewerProviderConfig.mjs";

/** @import { AgentEvent, AgentGateway, AgentRequest } from '../../shared/contract-types' */

const MAX_TEXT_DELTA_CHARACTERS = 100_000;
const MAX_RUNNER_TEXT_CHARACTERS = 200_000;
const MAX_EDITS = 100;
const EDIT_RATIONALE = "Proposed by the external AI reviewer.";
const PROMPT_PREFIX = [
  "Work only on the requested manuscript in the current workspace.",
  "Make only the changes needed for the request.",
  "Do not use Git, and do not add, remove, or rename files.",
].join("\n");

function invalid() {
  return new AgentGatewayError("The external agent result is invalid.", {
    code: "AI_EXTERNAL_AGENT_RESULT_INVALID",
    category: "schema",
    retryable: false,
  });
}

function runnerFailed() {
  return new AgentGatewayError("The external agent runner failed.", {
    code: "AI_EXTERNAL_AGENT_RUNNER_FAILED",
    category: "provider",
    retryable: true,
  });
}

function finalizeFailed() {
  return new AgentGatewayError(
    "The external agent session could not be saved.",
    {
      code: "AI_EXTERNAL_SESSION_INTERMEDIATE_STATE",
      category: "provider",
      retryable: true,
    },
  );
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string[]} keys
 * @returns {value is Record<string, any>}
 */
function hasExactKeys(value, keys) {
  return (
    isRecord(value) &&
    Reflect.ownKeys(value).every((key) => typeof key === "string") &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

/** @param {unknown} value */
function identifier(value) {
  try {
    const result = /** @type {any} */ (value)?.toString?.();
    if (
      typeof result !== "string" ||
      result.length === 0 ||
      result.length > 500
    ) {
      throw invalid();
    }
    return result;
  } catch {
    throw invalid();
  }
}

/** @param {unknown} value */
function optionalIdentifier(value) {
  return value == null ? null : identifier(value);
}

/** @param {AbortSignal | undefined} signal */
function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason?.name === "TimeoutError") {
    throw new AgentGatewayTimeoutError();
  }
  throw new AgentGatewayAbortError();
}

/** @param {unknown} error @param {AbortSignal | undefined} signal */
function runnerError(error, signal) {
  if (signal?.aborted) {
    throwIfAborted(signal);
  }
  if (isRecord(error) && error.code === "AI_EXTERNAL_AGENT_RUNNER_ABORTED") {
    return new AgentGatewayAbortError();
  }
  return runnerFailed();
}

/**
 * @param {unknown} value
 * @param {{ mode: "review" | "agent", threadId: string | null }} expected
 * @param {AgentRequest} request
 * @param {{ projectId: string, historyVersion: number }} snapshot
 * @returns {Record<string, any>}
 */
function runnerResult(value, expected, request, snapshot) {
  if (
    !hasExactKeys(value, ["threadId", "turn", "changes", "stateBytes"]) ||
    !Number.isSafeInteger(value.stateBytes) ||
    value.stateBytes < 0 ||
    !hasExactKeys(value.turn, ["threadId", "turnId", "text"]) ||
    !hasExactKeys(value.changes, ["projectId", "historyVersion", "edits"]) ||
    identifier(value.threadId) !== identifier(value.turn.threadId) ||
    typeof value.turn.text !== "string" ||
    value.turn.text.length > MAX_RUNNER_TEXT_CHARACTERS ||
    identifier(value.turn.turnId).length === 0 ||
    value.changes.projectId !== request.projectId ||
    value.changes.projectId !== snapshot.projectId ||
    value.changes.historyVersion !== snapshot.historyVersion ||
    !Array.isArray(value.changes.edits) ||
    value.changes.edits.length > MAX_EDITS ||
    (expected.mode === "agent" &&
      expected.threadId != null &&
      value.threadId !== expected.threadId)
  ) {
    throw invalid();
  }
  return value;
}

/**
 * Concrete adapter from one claimed external session turn to the existing
 * AgentGateway stream. Session creation and claiming stay in the configured
 * controller; this adapter does not introduce another lifecycle layer.
 *
 * @param {{
 *   request: unknown,
 *   snapshot: any,
 *   configuration: unknown,
 *   session: any,
 *   claim: any,
 *   runnerClient: {
 *     turn: (input: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>,
 *     retire: (input: { stateRootKey: string }) => Promise<unknown>,
 *   },
 *   sessionStore: { finalize: (input: unknown) => Promise<unknown> },
 *   userId: unknown,
 *   projectId: unknown,
 *   clientSessionId: unknown,
 *   createId?: () => string,
 *   now?: () => string,
 * }} input
 * @returns {AgentGateway}
 */
export function createExternalAgentGateway({
  request,
  snapshot,
  configuration,
  session,
  claim,
  runnerClient,
  sessionStore,
  userId,
  projectId,
  clientSessionId,
  createId = randomUUID,
  now = () => new Date().toISOString(),
}) {
  let checkedRequest;
  /** @type {string} */
  let checkedUserId;
  /** @type {string} */
  let checkedProjectId;
  /** @type {string} */
  let checkedClientSessionId;
  try {
    checkedRequest = AgentRequestSchema.parse(request);
    checkedUserId = identifier(userId);
    checkedProjectId = identifier(projectId);
    checkedClientSessionId = identifier(clientSessionId);
    const sessionThreadId = optionalIdentifier(session?.threadId);
    const claimThreadId = optionalIdentifier(claim?.threadId);
    const configurationKeys = ["provider", "baseUrl", "model"];
    if (isRecord(configuration) && Object.hasOwn(configuration, "credential")) {
      configurationKeys.push("credential");
      parseAiReviewerProviderCredential(configuration.credential);
    }
    if (
      checkedRequest.projectId !== checkedProjectId ||
      checkedRequest.scope == null ||
      checkedRequest.scope.kind === "project" ||
      snapshot?.projectId !== checkedProjectId ||
      !Number.isSafeInteger(snapshot?.historyVersion) ||
      !hasExactKeys(configuration, configurationKeys) ||
      configuration.provider !== "openai-compatible" ||
      typeof configuration.baseUrl !== "string" ||
      configuration.baseUrl.length === 0 ||
      typeof configuration.model !== "string" ||
      configuration.model !== checkedRequest.model ||
      typeof runnerClient?.turn !== "function" ||
      typeof runnerClient?.retire !== "function" ||
      typeof sessionStore?.finalize !== "function" ||
      typeof createId !== "function" ||
      typeof now !== "function" ||
      identifier(session?.userId) !== checkedUserId ||
      identifier(claim?.userId) !== checkedUserId ||
      identifier(session?.projectId) !== checkedProjectId ||
      identifier(claim?.projectId) !== checkedProjectId ||
      identifier(session?.clientSessionId) !== checkedClientSessionId ||
      identifier(claim?.clientSessionId) !== checkedClientSessionId ||
      identifier(session?.id) !== identifier(claim?.id) ||
      (session?.mode !== "review" && session?.mode !== "agent") ||
      claim?.mode !== session.mode ||
      (checkedRequest.agentSessionId == null
        ? session.mode !== "review" ||
          checkedClientSessionId !== checkedRequest.requestId
        : session.mode !== "agent" ||
          checkedClientSessionId !== checkedRequest.agentSessionId) ||
      session?.status !== "active" ||
      claim?.status !== "active" ||
      session?.operationClaim != null ||
      claim?.operationClaim?.type !== "turn" ||
      typeof claim.operationClaim.id !== "string" ||
      claim.operationClaim.id.length === 0 ||
      !Number.isSafeInteger(session?.revision) ||
      !Number.isSafeInteger(claim?.revision) ||
      claim.revision !== session.revision + 1 ||
      sessionThreadId !== claimThreadId ||
      (session.mode === "review" && sessionThreadId != null) ||
      identifier(session?.stateRootKey) !== identifier(claim?.stateRootKey) ||
      identifier(session?.connectionFingerprint) !==
        identifier(claim?.connectionFingerprint)
    ) {
      throw invalid();
    }
  } catch {
    throw invalid();
  }

  const sessionThreadId = optionalIdentifier(session.threadId);
  const mode = session.mode;
  const stateRootKey = identifier(claim.stateRootKey);
  const fingerprint = identifier(claim.connectionFingerprint);
  const claimRevision = claim.revision;
  const claimId = identifier(claim.operationClaim.id);
  const checkedConfiguration = /** @type {{
   *   provider: "openai-compatible",
   *   baseUrl: string,
   *   model: string,
   *   credential?: string,
   * }} */ (configuration);
  const destination = Object.freeze({
    provider: /** @type {const} */ ("openai-compatible"),
    baseUrl: checkedConfiguration.baseUrl,
    model: checkedConfiguration.model,
    ...(checkedConfiguration.credential == null
      ? {}
      : { credential: checkedConfiguration.credential }),
  });
  const prompt = `${PROMPT_PREFIX}\n\n${formatAgentPrompt(checkedRequest, null)}`;
  const requestIdentity = JSON.stringify(checkedRequest);
  let used = false;
  /** @type {Promise<void> | null} */
  let retirement = null;
  /** @type {AgentGatewayError | null} */
  let retirementError = null;

  function startAgentRetirement() {
    if (mode !== "agent") return Promise.resolve();
    retirement ??= runnerClient.retire({ stateRootKey }).then(
      () => {},
      () => {
        retirementError = runnerFailed();
      },
    );
    return retirement;
  }

  async function retireAgentRunner() {
    await startAgentRetirement();
    if (retirementError != null) throw retirementError;
  }

  return Object.freeze({
    /**
     * @param {unknown} activeRequest
     * @param {{ signal?: AbortSignal }} [options]
     * @returns {AsyncGenerator<AgentEvent, void, void>}
     */
    async *stream(activeRequest, { signal } = {}) {
      let parsedActiveRequest;
      try {
        parsedActiveRequest = AgentRequestSchema.parse(activeRequest);
      } catch {
        throw invalid();
      }
      if (used || JSON.stringify(parsedActiveRequest) !== requestIdentity) {
        throw invalid();
      }
      used = true;
      throwIfAborted(signal);

      let rawResult;
      try {
        rawResult = await runnerClient.turn(
          {
            mode,
            snapshot,
            prompt,
            stateRootKey,
            fingerprint,
            destination,
            threadId: mode === "review" ? null : sessionThreadId,
          },
          { signal },
        );
      } catch (error) {
        throw runnerError(error, signal);
      }
      const retireOnAbort = () => void startAgentRetirement();
      let fullyDelivered = false;
      signal?.addEventListener("abort", retireOnAbort, { once: true });
      try {
        try {
          throwIfAborted(signal);
        } catch (error) {
          await retireAgentRunner();
          throw error;
        }

        /** @type {AgentEvent[]} */
        let events;
        let result;
        try {
          result = runnerResult(
            rawResult,
            { mode, threadId: sessionThreadId },
            checkedRequest,
            snapshot,
          );
          const createdAt = now();
          let sequence = 0;
          events = [
            AgentEventSchema.parse({
              type: "started",
              eventId: createId(),
              requestId: checkedRequest.requestId,
              sequence: sequence++,
              createdAt,
              provider: destination.provider,
              model: destination.model,
              skill: checkedRequest.skill,
            }),
          ];
          for (
            let offset = 0;
            offset < result.turn.text.length;
            offset += MAX_TEXT_DELTA_CHARACTERS
          ) {
            events.push(
              AgentEventSchema.parse({
                type: "text.delta",
                eventId: createId(),
                requestId: checkedRequest.requestId,
                sequence: sequence++,
                createdAt,
                delta: result.turn.text.slice(
                  offset,
                  offset + MAX_TEXT_DELTA_CHARACTERS,
                ),
              }),
            );
          }
          for (const edit of result.changes.edits) {
            const suggestion = SuggestionSchema.parse({
              id: createId(),
              requestId: checkedRequest.requestId,
              projectId: checkedRequest.projectId,
              documentId: edit?.documentId,
              path: edit?.path,
              baseRevision: edit?.baseRevision,
              baseTextHash: edit?.baseTextHash,
              range: edit?.range,
              original: edit?.original,
              replacement: edit?.replacement,
              rationale: EDIT_RATIONALE,
              evidence: [
                {
                  path: edit?.path,
                  range: edit?.range,
                  revision: edit?.baseRevision,
                  textHash: edit?.baseTextHash,
                },
              ],
              provider: destination.provider,
              model: destination.model,
              skill: checkedRequest.skill,
              createdAt,
              status: "unresolved",
            });
            assertSuggestionForRequest(checkedRequest, suggestion);
            events.push(
              AgentEventSchema.parse({
                type: "suggestion",
                eventId: createId(),
                requestId: checkedRequest.requestId,
                sequence: sequence++,
                createdAt,
                suggestion,
              }),
            );
          }
          events.push(
            AgentEventSchema.parse({
              type: "completed",
              eventId: createId(),
              requestId: checkedRequest.requestId,
              sequence: sequence++,
              createdAt,
              finishReason: "stop",
            }),
          );
          events.forEach((event, index) =>
            assertAgentEventForRequest(checkedRequest, event, index),
          );
        } catch {
          await retireAgentRunner();
          throw invalid();
        }

        try {
          await sessionStore.finalize({
            userId: checkedUserId,
            projectId: checkedProjectId,
            clientSessionId: checkedClientSessionId,
            type: "turn",
            expectedRevision: claimRevision,
            claimId,
            threadId: result.threadId,
            stateBytes: result.stateBytes,
          });
        } catch {
          await retireAgentRunner();
          throw finalizeFailed();
        }

        try {
          throwIfAborted(signal);
        } catch (error) {
          await retireAgentRunner();
          throw error;
        }

        for (const event of events) {
          if (event.type === "completed") fullyDelivered = true;
          yield event;
        }
      } finally {
        signal?.removeEventListener("abort", retireOnAbort);
        if (!fullyDelivered || signal?.aborted) {
          await retireAgentRunner();
        }
      }
    },
  });
}
