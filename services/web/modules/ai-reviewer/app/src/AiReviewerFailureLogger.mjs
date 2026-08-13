// @ts-check

import logger from "@overleaf/logger";
import Settings from "@overleaf/settings";

import {
  safeProviderErrorType,
  safeProviderStatusCode,
} from "./AgentGateway.mjs";

export const AI_REVIEWER_FAILURE_LOG_MESSAGE = "AI reviewer request failed";
export const AI_REVIEWER_COMPLETION_LOG_MESSAGE =
  "AI reviewer request completed";

const INTERNAL_FAILURE_CODE_PATTERN = /^AI_[A-Z0-9_]{1,125}$/u;
const COMPLETION_TOOL_NAMES = new Set([
  "read_project_file",
  "read_project_figure",
  "read_skill",
  "search_zotero",
  "report_subject",
  "report_finding",
  "propose_suggestion",
]);
const COMPLETION_FINDING_REJECTION_CODES = new Set([
  "AI_TOOL_INPUT_INVALID",
  "AI_EVIDENCE_EXCERPT_NOT_FOUND",
  "AI_EVIDENCE_EXCERPT_AMBIGUOUS",
  "AI_EVIDENCE_SCOPE_MISMATCH",
  "AI_EVENT_SCOPE_MISMATCH",
  "AI_PROJECT_CONTENT_NOT_AVAILABLE",
  "AI_MODEL_CONTEXT_TOO_SMALL",
]);

// Failure codes are bounded identifiers; rejecting free-form values keeps the
// normal log from becoming a second path for provider or manuscript content.
/** @param {unknown} value */
function safeInternalFailureCode(value) {
  return typeof value === "string" && INTERNAL_FAILURE_CODE_PATTERN.test(value)
    ? value
    : "AI_PROVIDER_ERROR";
}

/**
 * Tool names are provider-controlled until they cross this boundary. Folding
 * undeclared values into one fixed bucket keeps arbitrary text out of logs.
 *
 * @param {ReadonlyMap<string, number>} toolCallCounts
 */
function safeCompletionToolCallCounts(toolCallCounts) {
  /** @type {Record<string, number>} */
  const safeCounts = {};
  for (const [toolName, count] of toolCallCounts) {
    if (!Number.isSafeInteger(count) || count <= 0) {
      continue;
    }
    const safeToolName = COMPLETION_TOOL_NAMES.has(toolName)
      ? toolName
      : "unknown";
    safeCounts[safeToolName] = (safeCounts[safeToolName] ?? 0) + count;
  }
  return safeCounts;
}

/**
 * @param {ReadonlyMap<string, number>} rejectionCounts
 */
function safeReportFindingRejections(rejectionCounts) {
  /** @type {Record<string, number>} */
  const byCode = {};
  let count = 0;
  for (const [code, rejected] of rejectionCounts) {
    if (!Number.isSafeInteger(rejected) || rejected <= 0) {
      continue;
    }
    const safeCode = COMPLETION_FINDING_REJECTION_CODES.has(code)
      ? code
      : "unknown";
    byCode[safeCode] = (byCode[safeCode] ?? 0) + rejected;
    count += rejected;
  }
  return { count, byCode };
}

/**
 * Completion diagnostics stay shape-only so a run with no visible artifacts
 * can be distinguished without retaining provider or manuscript content.
 *
 * @param {{
 *   requestId: string,
 *   provider: string,
 *   model: string,
 *   scopeKind: 'selection' | 'document' | 'project' | 'none',
 *   findingToolOffered: boolean,
 *   toolCallCounts: ReadonlyMap<string, number>,
 *   reportFindingRejectionCounts: ReadonlyMap<string, number>,
 *   pendingValidatedArtifactCount: number,
 * }} record
 */
export function recordAiReviewerCompletion(record) {
  logger.info(
    {
      requestId: record.requestId,
      provider: record.provider,
      model: record.model,
      scopeKind: record.scopeKind,
      findingToolOffered: record.findingToolOffered,
      toolCallCounts: safeCompletionToolCallCounts(record.toolCallCounts),
      reportFindingRejections: safeReportFindingRejections(
        record.reportFindingRejectionCounts,
      ),
      pendingValidatedArtifactCount: record.pendingValidatedArtifactCount,
    },
    AI_REVIEWER_COMPLETION_LOG_MESSAGE,
  );
}

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
      failureCode: safeInternalFailureCode(record.failureCode),
      providerStatusCode: safeProviderStatusCode(record.providerStatusCode),
      providerErrorType: safeProviderErrorType(record.providerErrorType),
      elapsedMs: record.elapsedMs,
    },
    AI_REVIEWER_FAILURE_LOG_MESSAGE,
  );
}

export const AI_REVIEWER_PROVIDER_DIAGNOSTIC_LOG_MESSAGE =
  "AI reviewer provider diagnostic";

const PROVIDER_DIAGNOSTIC_MAX_LENGTH = 4_000;
const PROVIDER_CONTENT_FRAGMENT_LENGTH = 16;
const PROVIDER_AUTHOR_CONTENT_FIELDS = new Set([
  "contents",
  "input",
  "messages",
  "prompt",
]);
const PROVIDER_AUTHOR_CONTENT_REDACTION = "[REDACTED: author content]";
const PROVIDER_CREDENTIAL_PATTERNS = Object.freeze([
  /(\b(?:api[_ -]?key|x-goog-api-key|authorization|access[_ -]?token|key)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^,"'\s}\]]+)/giu,
  /([?&](?:api[_-]?key|key)=)[^&\s"']+/giu,
  /(\bBearer\s+)[0-9A-Za-z._~+\/-]+/giu,
  /\bAIza[0-9A-Za-z_-]{20,}\b/gu,
]);

/** @param {unknown} value @param {string} property */
function ownValue(value, property) {
  if (
    value == null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return undefined;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, property);
    return descriptor != null && Object.hasOwn(descriptor, "value")
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

/** @param {string} value */
function redactProviderCredentials(value) {
  let redacted = value;
  for (const pattern of PROVIDER_CREDENTIAL_PATTERNS) {
    redacted = redacted.replace(pattern, (_match, prefix) =>
      typeof prefix === "string" ? `${prefix}[REDACTED]` : "[REDACTED]",
    );
  }
  return redacted;
}

/** @param {unknown} value @param {string[]} output @param {number} depth */
function collectAuthorStringLeaves(value, output, depth) {
  if (output.length >= 128 || depth > 16) {
    return;
  }
  if (typeof value === "string") {
    if (value.length > 0) {
      output.push(value);
    }
    return;
  }
  if (value == null || typeof value !== "object") {
    return;
  }
  let descriptors;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return;
  }
  // Every request role may now contain user-supplied Skill metadata or model
  // output, so role tags never exempt a subtree from echo redaction.
  for (const descriptor of Object.values(descriptors)) {
    if (Object.hasOwn(descriptor, "value")) {
      collectAuthorStringLeaves(descriptor.value, output, depth + 1);
    }
  }
}

/**
 * @param {unknown} detail
 * @param {string} responseBody
 * @param {unknown} systemInstructionAuthorContent
 * @param {unknown} providerDiagnosticAllowlist
 */
function redactAuthorContentEchoes(
  detail,
  responseBody,
  systemInstructionAuthorContent,
  providerDiagnosticAllowlist,
) {
  const requestBody = ownValue(detail, "requestBodyValues");
  const content = [];
  if (requestBody != null && typeof requestBody === "object") {
    let descriptors;
    try {
      descriptors = Object.getOwnPropertyDescriptors(requestBody);
    } catch {
      descriptors = {};
    }
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (
        PROVIDER_AUTHOR_CONTENT_FIELDS.has(key) &&
        Object.hasOwn(descriptor, "value")
      ) {
        collectAuthorStringLeaves(descriptor.value, content, 0);
      }
    }
  }
  // Fixed system instructions name tools that provider schema errors must name
  // in turn. Only the separately supplied user Skill metadata is author text.
  collectAuthorStringLeaves(systemInstructionAuthorContent, content, 0);
  const allowlistedPositions = new Uint8Array(responseBody.length);
  if (Array.isArray(providerDiagnosticAllowlist)) {
    for (const value of providerDiagnosticAllowlist) {
      if (typeof value !== "string" || value.length === 0) {
        continue;
      }
      let position = responseBody.indexOf(value);
      while (position >= 0) {
        const before = responseBody[position - 1];
        const after = responseBody[position + value.length];
        if (
          (before == null || !/[A-Za-z0-9_]/u.test(before)) &&
          (after == null || !/[A-Za-z0-9_]/u.test(after))
        ) {
          allowlistedPositions.fill(1, position, position + value.length);
        }
        position = responseBody.indexOf(value, position + 1);
      }
    }
  }
  const responseFragments = new Map();
  for (
    let index = 0;
    index <= responseBody.length - PROVIDER_CONTENT_FRAGMENT_LENGTH;
    index += 1
  ) {
    const fragment = responseBody.slice(
      index,
      index + PROVIDER_CONTENT_FRAGMENT_LENGTH,
    );
    const positions = responseFragments.get(fragment) ?? [];
    positions.push(index);
    responseFragments.set(fragment, positions);
  }
  const redactedPositions = new Uint8Array(responseBody.length);
  for (const value of content) {
    if (value.length < PROVIDER_CONTENT_FRAGMENT_LENGTH) {
      continue;
    }
    for (
      let index = 0;
      index <= value.length - PROVIDER_CONTENT_FRAGMENT_LENGTH;
      index += 1
    ) {
      const positions = responseFragments.get(
        value.slice(index, index + PROVIDER_CONTENT_FRAGMENT_LENGTH),
      );
      for (const position of positions ?? []) {
        for (
          let offset = position;
          offset < position + PROVIDER_CONTENT_FRAGMENT_LENGTH;
          offset += 1
        ) {
          if (allowlistedPositions[offset] === 0) {
            redactedPositions[offset] = 1;
          }
        }
      }
    }
  }
  if (!redactedPositions.includes(1)) {
    return responseBody;
  }
  const output = [];
  for (let index = 0; index < responseBody.length; ) {
    if (redactedPositions[index] === 0) {
      output.push(responseBody[index]);
      index += 1;
      continue;
    }
    while (redactedPositions[index] === 1) {
      index += 1;
    }
    output.push(PROVIDER_AUTHOR_CONTENT_REDACTION);
  }
  return output.join("");
}

/** @param {unknown} value @param {Set<string>} output @param {number} depth */
function collectToolInputContent(value, output, depth) {
  if (output.size >= 128 || depth > 16) {
    return;
  }
  if (typeof value === "string") {
    output.add(value);
    return;
  }
  if (value == null || typeof value !== "object") {
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    output.add(key);
    collectToolInputContent(nested, output, depth + 1);
  }
}

/** @param {unknown} detail */
function invalidToolInputDiagnostic(detail) {
  const toolName = ownValue(detail, "toolName");
  const toolInput = ownValue(detail, "toolInput");
  if (
    typeof toolName !== "string" ||
    !/^[a-z][a-z0-9_]{0,127}$/u.test(toolName) ||
    typeof toolInput !== "string"
  ) {
    return null;
  }
  let cause = ownValue(detail, "cause");
  for (let depth = 0; depth < 8; depth += 1) {
    const nestedCause = ownValue(cause, "cause");
    if (nestedCause == null || nestedCause === cause) {
      break;
    }
    cause = nestedCause;
  }
  const causeMessage = ownValue(cause, "message");
  if (typeof causeMessage !== "string" || causeMessage.length === 0) {
    return null;
  }
  const inputContent = new Set();
  try {
    collectToolInputContent(JSON.parse(toolInput), inputContent, 0);
  } catch {
    // Syntax errors already identify the parse position without needing input.
  }
  let safeCauseMessage = causeMessage;
  for (const content of inputContent) {
    if (content.length >= PROVIDER_CONTENT_FRAGMENT_LENGTH) {
      safeCauseMessage = safeCauseMessage.replaceAll(
        content,
        PROVIDER_AUTHOR_CONTENT_REDACTION,
      );
    }
  }
  return {
    toolName,
    detail: redactProviderCredentials(safeCauseMessage).slice(
      0,
      PROVIDER_DIAGNOSTIC_MAX_LENGTH,
    ),
  };
}

/**
 * @param {unknown} detail
 * @param {unknown} systemInstructionAuthorContent
 * @param {unknown} providerDiagnosticAllowlist
 */
function providerClientErrorResponse(
  detail,
  systemInstructionAuthorContent,
  providerDiagnosticAllowlist,
) {
  const statusCode = ownValue(detail, "statusCode");
  const responseBody = ownValue(detail, "responseBody");
  if (
    typeof statusCode !== "number" ||
    statusCode < 400 ||
    statusCode > 499 ||
    typeof responseBody !== "string"
  ) {
    return null;
  }
  const redactedBody = redactProviderCredentials(responseBody).slice(
    0,
    PROVIDER_DIAGNOSTIC_MAX_LENGTH,
  );
  return redactAuthorContentEchoes(
    detail,
    redactedBody,
    systemInstructionAuthorContent,
    providerDiagnosticAllowlist,
  );
}

/**
 * Off unless `OVERLEAF_AI_REVIEWER_DEBUG_PROVIDER_ERRORS=true` is set in the
 * environment, which surfaces as `aiReviewer.debugProviderErrors`.
 *
 * Provider 4xx responses and SDK tool validation failures carry the reason a
 * request shape was refused. Keep this opt-in and credential-redacted. Author
 * content echoed in either detail is removed without discarding the reason.
 *
 * @param {{
 *   provider: string | null,
 *   model: string | null,
 *   detail: unknown,
 *   diagnosticKind?: 'invalid-tool-input',
 *   systemInstructionAuthorContent?: readonly string[],
 *   providerDiagnosticAllowlist?: readonly string[],
 * }} record
 */
export function recordAiReviewerProviderDiagnostic(record) {
  if (Settings.aiReviewer?.debugProviderErrors !== true) {
    return;
  }
  const toolInputDiagnostic =
    record.diagnosticKind === "invalid-tool-input"
      ? invalidToolInputDiagnostic(record.detail)
      : null;
  if (toolInputDiagnostic != null) {
    logger.warn(
      {
        provider: record.provider,
        model: record.model,
        toolName: toolInputDiagnostic.toolName,
        detail: toolInputDiagnostic.detail,
      },
      AI_REVIEWER_PROVIDER_DIAGNOSTIC_LOG_MESSAGE,
    );
    return;
  }
  const detail = providerClientErrorResponse(
    record.detail,
    record.systemInstructionAuthorContent,
    record.providerDiagnosticAllowlist,
  );
  if (detail == null) {
    return;
  }
  logger.warn(
    {
      provider: record.provider,
      model: record.model,
      detail,
    },
    AI_REVIEWER_PROVIDER_DIAGNOSTIC_LOG_MESSAGE,
  );
}
