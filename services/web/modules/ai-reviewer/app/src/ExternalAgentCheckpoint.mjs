// @ts-check

import { AgentRequestSchema } from "../../shared/contracts.mjs";
import { AgentGatewayAbortError, AgentGatewayError } from "./AgentGateway.mjs";
import { createExternalAgentHistorySnapshot } from "./ExternalAgentWorkspace.mjs";

/**
 * @typedef {{
 *   ensureNoResyncPending: (projectId: string, options: { signal?: AbortSignal }) => Promise<unknown>,
 *   getLatestVersion: (projectId: string, options: { signal?: AbortSignal }) => Promise<number>,
 *   getContentAtVersion: (projectId: string, version: number, options: { signal?: AbortSignal }) => Promise<unknown>,
 * }} ExternalAgentHistoryManager
 */

/** @param {unknown} [cause] */
function unavailable(cause) {
  return new AgentGatewayError(
    "The requested project history checkpoint is unavailable.",
    {
      code: "AI_EXTERNAL_CHECKPOINT_UNAVAILABLE",
      category: "configuration",
      retryable: false,
      cause,
    },
  );
}

function stale() {
  return new AgentGatewayError(
    "The requested document no longer matches project history.",
    {
      code: "AI_EXTERNAL_CHECKPOINT_STALE",
      category: "configuration",
      retryable: true,
    },
  );
}

/** @param {AbortSignal | undefined} signal */
function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new AgentGatewayAbortError();
  }
}

/**
 * @param {ReturnType<typeof createExternalAgentHistorySnapshot>} snapshot
 * @param {any} scope
 */
function matchesRequest(snapshot, scope) {
  const document = snapshot.documents.find(
    (candidate) => candidate.documentId === scope.documentId,
  );
  if (
    document == null ||
    document.path !== scope.path ||
    document.revision !== scope.baseRevision ||
    document.textHash !== scope.baseTextHash
  ) {
    return false;
  }
  if (scope.kind === "document") {
    return document.text === scope.text;
  }
  return (
    scope.range.to <= document.text.length &&
    document.text.slice(scope.range.from, scope.range.to) === scope.text
  );
}

/**
 * Bind a selection or document request to one complete project-history
 * snapshot. Only an exact request mismatch is retried, and only once.
 *
 * @param {unknown} input
 * @param {{
 *   historyManager?: ExternalAgentHistoryManager,
 *   signal?: AbortSignal,
 * }} [options]
 */
export async function createExternalAgentCheckpoint(input, options = {}) {
  const parsed = AgentRequestSchema.safeParse(input);
  const request = parsed.success ? parsed.data : null;
  const scope = request?.scope;
  if (request == null || scope == null || scope.kind === "project") {
    throw unavailable();
  }
  const signal = options.signal;
  throwIfAborted(signal);
  let historyManager = options.historyManager;
  if (historyManager == null) {
    try {
      historyManager = (
        await import("../../../../app/src/Features/History/HistoryManager.mjs")
      ).default.promises;
    } catch (error) {
      throwIfAborted(signal);
      throw unavailable(error);
    }
    throwIfAborted(signal);
  }

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let snapshot;
    try {
      throwIfAborted(signal);
      await historyManager.ensureNoResyncPending(request.projectId, { signal });
      throwIfAborted(signal);
      const historyVersion = await historyManager.getLatestVersion(
        request.projectId,
        { signal },
      );
      throwIfAborted(signal);
      const rawSnapshot = await historyManager.getContentAtVersion(
        request.projectId,
        historyVersion,
        { signal },
      );
      throwIfAborted(signal);
      snapshot = createExternalAgentHistorySnapshot({
        projectId: request.projectId,
        historyVersion,
        rawSnapshot,
      });
      await historyManager.ensureNoResyncPending(request.projectId, { signal });
      throwIfAborted(signal);
    } catch (error) {
      throwIfAborted(signal);
      if (error instanceof AgentGatewayError) {
        throw error;
      }
      throw unavailable(error);
    }
    if (matchesRequest(snapshot, scope)) {
      return snapshot;
    }
  }
  throw stale();
}
