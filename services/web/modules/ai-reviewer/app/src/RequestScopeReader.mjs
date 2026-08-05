// @ts-check

import { AgentRequestSchema } from "../../shared/contracts.mjs";
import { AgentGatewayAbortError, AgentGatewayError } from "./AgentGateway.mjs";
import { createProjectSnapshot } from "./ProjectSnapshot.mjs";

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

/** @param {any} request */
function authenticatedUserId(request) {
  const value = request?.user?._id?.toString?.();
  if (typeof value !== "string" || value.length === 0) {
    throw rejected();
  }
  return value;
}

/** @param {unknown} input */
function requestIdentity(input) {
  const parsed = AgentRequestSchema.safeParse(input);
  if (!parsed.success || parsed.data.scope.kind === "project") {
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
  isZoteroLinked,
  searchZoteroItems,
} = {}) {
  return {
    /**
     * @param {any} httpRequest
     * @param {{ signal?: AbortSignal }} [options]
     */
    async read(httpRequest, { signal } = {}) {
      const parsed = AgentRequestSchema.safeParse(httpRequest?.body);
      if (!parsed.success) {
        throw rejected();
      }
      const request = parsed.data;
      const scope = /** @type {any} */ (request.scope);
      if (request.projectId !== httpRequest?.params?.project_id) {
        throw rejected();
      }
      const userId = authenticatedUserId(httpRequest);
      if (scope.kind === "project") {
        if (typeof loadProjectDocuments !== "function") {
          throw rejected();
        }
        const snapshot = createProjectSnapshot(
          request.projectId,
          await loadProjectDocuments(request.projectId, { signal }),
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

        return Object.freeze({
          userId,
          projectId: request.projectId,
          kind: "project",
          projectContext: snapshot.context,
          readProjectFile: snapshot.readProjectFile,
          searchZotero,
          validateEvidence: snapshot.validateEvidence,
        });
      }
      const identity = requestIdentity(request);
      const lower = scope.kind === "selection" ? scope.range.from : 0;
      const upper =
        scope.kind === "selection" ? scope.range.to : scope.text.length;

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
        const range = input?.range;
        if (
          requestIdentity(active) !== identity ||
          input?.path !== scope.path ||
          !Number.isSafeInteger(range?.from) ||
          !Number.isSafeInteger(range?.to) ||
          range.from < lower ||
          range.to > upper ||
          range.to < range.from
        ) {
          throw rejected();
        }
        return Object.freeze({
          path: scope.path,
          range: Object.freeze({ from: range.from, to: range.to }),
          text: scope.text.slice(range.from - lower, range.to - lower),
        });
      }

      return Object.freeze({
        userId,
        projectId: request.projectId,
        kind: scope.kind,
        documentId: scope.documentId,
        path: scope.path,
        readProjectFile,
      });
    },
  };
}
