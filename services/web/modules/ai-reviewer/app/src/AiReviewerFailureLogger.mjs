// @ts-check

import logger from "@overleaf/logger";
import Settings from "@overleaf/settings";

import {
  safeProviderErrorType,
  safeProviderStatusCode,
} from "./AgentGateway.mjs";

export const AI_REVIEWER_FAILURE_LOG_MESSAGE = "AI reviewer request failed";

/**
 * Keep the logging boundary shape-only. Reconstructing the record prevents a
 * caller from adding manuscript, prompt, credential, bibliography, response,
 * or raw error fields.
 *
 * @param {{
 *   requestId: string | null,
 *   provider: string | null,
 *   model: string | null,
 *   scopeKind: 'selection' | 'document' | 'project' | 'none',
 *   failureCategory: 'aborted' | 'authentication' | 'configuration' |
 *     'network' | 'provider' | 'rate-limit' | 'schema' | 'timeout' | 'unknown',
 *   failureCode: string,
 *   providerStatusCode: unknown,
 *   providerErrorType: unknown,
 *   elapsedMs: number,
 * }} record
 */
export function recordAiReviewerFailure(record) {
  logger.warn(
    {
      requestId: record.requestId,
      provider: record.provider,
      model: record.model,
      scopeKind: record.scopeKind,
      failureCategory: record.failureCategory,
      failureCode: record.failureCode,
      providerStatusCode: safeProviderStatusCode(record.providerStatusCode),
      providerErrorType: safeProviderErrorType(record.providerErrorType),
      elapsedMs: record.elapsedMs,
    },
    AI_REVIEWER_FAILURE_LOG_MESSAGE,
  );
}

export const AI_REVIEWER_PROVIDER_DIAGNOSTIC_LOG_MESSAGE =
  "AI reviewer provider diagnostic";

/**
 * Off unless `OVERLEAF_AI_REVIEWER_DEBUG_PROVIDER_ERRORS=true` is set in the
 * environment, which surfaces as `aiReviewer.debugProviderErrors`.
 *
 * A provider rejection carries the reason the request shape was refused, which
 * is the only way to tell an unsupported request combination from a transport
 * fault. That text is provider-controlled and can quote the request, so it is
 * never recorded on the normal path. Enable this on a development instance
 * only, and never where real manuscripts are reviewed.
 *
 * @param {{ provider: string | null, model: string | null, detail: unknown }} record
 */
export function recordAiReviewerProviderDiagnostic(record) {
  if (Settings.aiReviewer?.debugProviderErrors !== true) {
    return;
  }
  const detail =
    record.detail instanceof Error ? record.detail.message : record.detail;
  logger.warn(
    {
      provider: record.provider,
      model: record.model,
      detail: typeof detail === "string" ? detail.slice(0, 4_000) : null,
    },
    AI_REVIEWER_PROVIDER_DIAGNOSTIC_LOG_MESSAGE,
  );
}
