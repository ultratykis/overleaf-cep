// @ts-check

import logger from "@overleaf/logger";

export const AI_REVIEWER_FAILURE_LOG_MESSAGE = "AI reviewer request failed";

/**
 * Keep the logging boundary shape-only. Reconstructing the record prevents a
 * caller from adding manuscript, prompt, credential, bibliography, response,
 * or raw error fields.
 *
 * @param {{
 *   requestId: string,
 *   provider: string | null,
 *   model: string | null,
 *   scopeKind: 'selection' | 'document' | 'project' | 'none',
 *   failureCategory: 'aborted' | 'authentication' | 'configuration' |
 *     'network' | 'provider' | 'rate-limit' | 'schema' | 'timeout' | 'unknown',
 *   failureCode: string,
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
      elapsedMs: record.elapsedMs,
    },
    AI_REVIEWER_FAILURE_LOG_MESSAGE,
  );
}
