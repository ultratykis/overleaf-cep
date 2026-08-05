// @ts-check

import logger from "@overleaf/logger";

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
