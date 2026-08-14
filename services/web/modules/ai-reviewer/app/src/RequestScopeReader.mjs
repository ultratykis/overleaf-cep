// @ts-check

import { AgentRequestSchema } from "../../shared/contracts.mjs";
import { AgentGatewayAbortError, AgentGatewayError } from "./AgentGateway.mjs";
import { estimateAgentPromptTokens } from "./AiReviewerPrompt.mjs";
import {
  estimateModelInputTokens,
  modelInputTokenBudget,
} from "./ModelContextBudget.mjs";
import { createProjectSnapshot } from "./ProjectSnapshot.mjs";
import { PROJECT_FIGURE_MODEL_INPUT_TOKENS } from "./ProjectFigureReader.mjs";

function rejected() {
  return new AgentGatewayError(
    "The requested project content is unavailable.",
    {
      code: "AI_PROJECT_CONTENT_NOT_AVAILABLE",
      category: "configuration",
      retryable: false,
    },
  );
}

/**
 * @param {unknown} contextLength
 * @param {unknown} contextLengthSource
 */
function modelContextTooSmall(contextLength, contextLengthSource) {
  return new AgentGatewayError(
    "The request does not fit the selected model context.",
    {
      code: "AI_MODEL_CONTEXT_TOO_SMALL",
      category: "configuration",
      retryable: false,
      contextLength,
      contextLengthSource,
    },
  );
}

/** @param {any} request */
export function authenticatedUserId(request) {
  const value = request?.user?._id?.toString?.();
  if (typeof value !== "string" || value.length === 0) {
    throw rejected();
  }
  return value;
}

/** @param {unknown} input */
function requestIdentity(input) {
  const parsed = AgentRequestSchema.safeParse(input);
  if (
    !parsed.success ||
    parsed.data.scope == null ||
    parsed.data.scope.kind === "project"
  ) {
    return null;
  }
  const request = parsed.data;
  const scope = /** @type {any} */ (request.scope);
  return JSON.stringify([
    request.requestId,
    request.projectId,
    scope.kind,
    scope.documentId,
    scope.path,
    scope.baseRevision,
    scope.baseTextHash,
    scope.kind === "selection" ? scope.range : null,
  ]);
}

/**
 * @param {{
 *   loadProjectDocuments?: (
 *     projectId: string,
 *     options: { signal?: AbortSignal },
 *   ) => unknown | Promise<unknown>,
 *   loadProjectFigure?: (
 *     projectId: string,
 *     input: { path: string },
 *     options: { signal?: AbortSignal },
 *   ) => unknown | Promise<unknown>,
 *   loadProjectComments?: (
 *     projectId: string,
 *     input: { docPath?: string, threadId?: string },
 *     options: { signal?: AbortSignal },
 *   ) => unknown | Promise<unknown>,
 *   isZoteroLinked?: (userId: string) => boolean | Promise<boolean>,
 *   searchZoteroItems?: (
 *     userId: string,
 *     input: { query: string },
 *     options: { signal?: AbortSignal },
 *   ) => unknown | Promise<unknown>,
 * }} [dependencies]
 */
export function createRequestScopeReader({
  loadProjectDocuments,
  loadProjectFigure,
  loadProjectComments,
  isZoteroLinked,
  searchZoteroItems,
} = {}) {
  return {
    /**
     * @param {any} httpRequest
     * @param {{
     *   signal?: AbortSignal,
     *   contextLength?: unknown,
     *   contextLengthSource?: unknown,
     * }} [options]
     */
    async read(
      httpRequest,
      { signal, contextLength, contextLengthSource } = {},
    ) {
      const parsed = AgentRequestSchema.safeParse(httpRequest?.body);
      if (!parsed.success) {
        throw rejected();
      }
      const request = parsed.data;
      const scope = /** @type {any} */ (request.scope ?? null);
      if (request.projectId !== httpRequest?.params?.project_id) {
        throw rejected();
      }
      const userId = authenticatedUserId(httpRequest);
      /** @type {number} */
      let maxModelInputTokens;
      try {
        maxModelInputTokens = modelInputTokenBudget(contextLength);
      } catch {
        throw rejected();
      }
      // A request without a scope is a conversation about the project, so it
      // reads the project index the same way a project review does.
      if (scope == null || scope.kind === "project") {
        if (typeof loadProjectDocuments !== "function") {
          throw rejected();
        }
        const snapshot = createProjectSnapshot(
          request.projectId,
          await loadProjectDocuments(request.projectId, { signal }),
          {
            contextLength,
            contextLengthSource,
            request,
            modelRequest: request,
          },
        );
        const zoteroSearchRelevant =
          request.action === "citation-audit" ||
          snapshot.context.citationAudit.issues.length > 0;
        const zoteroLinked =
          zoteroSearchRelevant &&
          typeof isZoteroLinked === "function" &&
          (await isZoteroLinked(userId));
        /** @type {undefined | ((input: { query: string }, options: { signal?: AbortSignal }) => unknown | Promise<unknown>)} */
        const searchZotero =
          typeof searchZoteroItems === "function" && zoteroLinked
            ? (input, { signal }) =>
                searchZoteroItems(userId, input, { signal })
            : undefined;
        const readProjectFigure =
          typeof loadProjectFigure === "function"
            ? async (input, { request: active, signal }) => {
                const activeRequest = AgentRequestSchema.safeParse(active);
                if (
                  !activeRequest.success ||
                  activeRequest.data.projectId !== request.projectId
                ) {
                  throw rejected();
                }
                const result = await loadProjectFigure(
                  request.projectId,
                  input,
                  { signal },
                );
                snapshot.chargeModelInputTokens(
                  PROJECT_FIGURE_MODEL_INPUT_TOKENS,
                );
                return result;
              }
            : undefined;
        const readProjectComments =
          typeof loadProjectComments === "function"
            ? async (input, { request: active, signal }) => {
                const activeRequest = AgentRequestSchema.safeParse(active);
                if (
                  !activeRequest.success ||
                  activeRequest.data.projectId !== request.projectId
                ) {
                  throw rejected();
                }
                const result = await loadProjectComments(
                  request.projectId,
                  input,
                  { signal },
                );
                snapshot.chargeModelInputTokens(
                  estimateModelInputTokens(JSON.stringify(result)),
                );
                return result;
              }
            : undefined;

        return Object.freeze({
          userId,
          projectId: request.projectId,
          kind: "project",
          projectContext: snapshot.context,
          readProjectFile: snapshot.readProjectFile,
          ...(readProjectFigure === undefined ? {} : { readProjectFigure }),
          ...(readProjectComments === undefined ? {} : { readProjectComments }),
          searchZotero,
          validateEvidence: snapshot.validateEvidence,
        });
      }
      const identity = requestIdentity(request);
      // A scoped review reaches the same library as a project review; its
      // narrower boundary governs reported artifacts rather than research.
      const zoteroLinked =
        typeof searchZoteroItems === "function" &&
        typeof isZoteroLinked === "function" &&
        (await isZoteroLinked(userId));
      /** @type {undefined | ((input: { query: string }, options: { signal?: AbortSignal }) => unknown | Promise<unknown>)} */
      const searchZotero =
        typeof searchZoteroItems === "function" && zoteroLinked
          ? (input, { signal }) => searchZoteroItems(userId, input, { signal })
          : undefined;
      // Use the gateway's readable representation so this early rejection and
      // the transport boundary cannot disagree about the same scoped prompt.
      if (estimateAgentPromptTokens(request, null) > maxModelInputTokens) {
        // This request is valid and readable; only the selected model budget is
        // too small. Preserve that distinction so changing files or retrying the
        // same model is not presented as a remedy.
        throw modelContextTooSmall(contextLength, contextLengthSource);
      }
      const projectReadRequest = Object.freeze({
        ...request,
        scope: Object.freeze({ kind: "project" }),
      });
      let snapshotPromise;

      function projectSnapshot(signal) {
        if (typeof loadProjectDocuments !== "function") {
          throw rejected();
        }
        snapshotPromise ??= Promise.resolve(
          loadProjectDocuments(request.projectId, { signal }),
        ).then((documents) =>
          createProjectSnapshot(request.projectId, documents, {
            contextLength,
            contextLengthSource,
            request: projectReadRequest,
            modelRequest: request,
          }),
        );
        return snapshotPromise;
      }

      /**
       * @param {any} input
       * @param {{ request: unknown, signal?: AbortSignal }} options
       */
      async function readProjectFile(input, { request: active, signal }) {
        if (signal?.aborted) {
          throw signal.reason instanceof AgentGatewayError
            ? signal.reason
            : new AgentGatewayAbortError();
        }
        if (requestIdentity(active) !== identity) {
          throw rejected();
        }
        // The original scope remains the reporting authority. A project-shaped
        // snapshot gives reads the project review's path, size, and budget
        // protections without widening where artifacts may point.
        const snapshot = await projectSnapshot(signal);
        return await snapshot.readProjectFile(input, {
          request: projectReadRequest,
          signal,
        });
      }

      const readProjectFigure =
        typeof loadProjectFigure === "function"
          ? async (input, { request: active, signal }) => {
              if (requestIdentity(active) !== identity) {
                throw rejected();
              }
              const result = await loadProjectFigure(request.projectId, input, {
                signal,
              });
              const snapshot = await projectSnapshot(signal);
              snapshot.chargeModelInputTokens(
                PROJECT_FIGURE_MODEL_INPUT_TOKENS,
              );
              return result;
            }
          : undefined;
      const readProjectComments =
        typeof loadProjectComments === "function"
          ? async (input, { request: active, signal }) => {
              if (requestIdentity(active) !== identity) {
                throw rejected();
              }
              const result = await loadProjectComments(
                request.projectId,
                { ...input, docPath: input.docPath ?? scope.path },
                { signal },
              );
              const snapshot = await projectSnapshot(signal);
              snapshot.chargeModelInputTokens(
                estimateModelInputTokens(JSON.stringify(result)),
              );
              return result;
            }
          : undefined;

      return Object.freeze({
        userId,
        projectId: request.projectId,
        kind: scope.kind,
        documentId: scope.documentId,
        path: scope.path,
        readProjectFile,
        ...(readProjectFigure === undefined ? {} : { readProjectFigure }),
        ...(readProjectComments === undefined ? {} : { readProjectComments }),
        searchZotero,
      });
    },
  };
}
