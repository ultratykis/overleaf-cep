import { readFile } from "node:fs/promises";

import logger from "@overleaf/logger";
import Settings from "@overleaf/settings";
import { APICallError } from "ai";
import { describe, expect, it, vi } from "vitest";

import {
  AI_REVIEWER_COMPLETION_LOG_MESSAGE,
  AI_REVIEWER_FAILURE_LOG_MESSAGE,
  AI_REVIEWER_PROVIDER_DIAGNOSTIC_LOG_MESSAGE,
  recordAiReviewerCompletion,
  recordAiReviewerFailure,
  recordAiReviewerProviderDiagnostic,
} from "../../../app/src/AiReviewerFailureLogger.mjs";

const serverContentBoundary = [
  "../../../app/src/AgentGateway.mjs",
  "../../../app/src/AiReviewerController.mjs",
  "../../../app/src/AiSdkAgentGateway.mjs",
  "../../../app/src/ConfiguredAiReviewerController.mjs",
];

const browserContentBoundary = [
  "../../../frontend/js/services/agent-stream.ts",
  "../../../frontend/js/services/editor-evidence-navigation.ts",
  "../../../frontend/js/components/ai-reviewer-panel.tsx",
  "../../../frontend/js/components/ai-reviewer-suggestion-preview.tsx",
];

async function readSource(relativePath) {
  return await readFile(new URL(relativePath, import.meta.url), "utf8");
}

describe("AI reviewer: module shell privacy boundary", function () {
  it("keeps content-handling paths free of persistence, logging, and analytics sinks", async function () {
    const serverSource = (
      await Promise.all(serverContentBoundary.map(readSource))
    ).join("\n");
    const browserSource = (
      await Promise.all(browserContentBoundary.map(readSource))
    ).join("\n");

    for (const forbiddenServerDependency of [
      "node:fs",
      "@overleaf/logger",
      "AnalyticsManager",
      "mongodb",
      "RedisWrapper",
    ]) {
      expect(serverSource).not.toContain(forbiddenServerDependency);
    }

    for (const forbiddenBrowserSink of [
      "indexedDB",
      "localStorage",
      "sessionStorage",
    ]) {
      expect(browserSource).not.toContain(forbiddenBrowserSink);
    }
  });

  it("records completion tool and pending-artifact counts without content", function () {
    const manuscriptSentinel = "COMPLETION_MANUSCRIPT_LOG_SENTINEL";
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      recordAiReviewerCompletion({
        requestId: "completion-request",
        provider: "openai-compatible",
        model: "safe-model",
        scopeKind: "document",
        findingToolOffered: true,
        toolCallCount: 4,
        pendingValidatedArtifactCount: 2,
        manuscript: manuscriptSentinel,
      });

      expect(info).toHaveBeenCalledExactlyOnceWith(
        {
          requestId: "completion-request",
          provider: "openai-compatible",
          model: "safe-model",
          scopeKind: "document",
          findingToolOffered: true,
          toolCallCount: 4,
          pendingValidatedArtifactCount: 2,
        },
        AI_REVIEWER_COMPLETION_LOG_MESSAGE,
      );
      expect(JSON.stringify(info.mock.calls)).not.toContain(manuscriptSentinel);
    } finally {
      info.mockRestore();
    }
  });

  it("keeps distinctive manuscript text and a credential outside the host failure log", function () {
    const manuscriptSentinel = "DISTINCTIVE_MANUSCRIPT_LOG_SENTINEL";
    const credentialSentinel = "DISTINCTIVE_CREDENTIAL_LOG_SENTINEL";
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      recordAiReviewerFailure({
        requestId: "privacy-request",
        provider: "openai-compatible",
        model: "safe-model",
        scopeKind: "document",
        failureCategory: "schema",
        failureCode: "AI_TOOL_INPUT_INVALID",
        providerStatusCode: manuscriptSentinel,
        providerErrorType: credentialSentinel,
        elapsedMs: 42,
        manuscript: manuscriptSentinel,
        credential: credentialSentinel,
      });

      expect(warn).toHaveBeenCalledExactlyOnceWith(
        {
          requestId: "privacy-request",
          provider: "openai-compatible",
          model: "safe-model",
          scopeKind: "document",
          failureCategory: "schema",
          failureCode: "AI_TOOL_INPUT_INVALID",
          providerStatusCode: null,
          providerErrorType: null,
          elapsedMs: 42,
        },
        AI_REVIEWER_FAILURE_LOG_MESSAGE,
      );
      expect(Object.keys(warn.mock.calls[0][0]).sort()).toEqual([
        "elapsedMs",
        "failureCategory",
        "failureCode",
        "model",
        "provider",
        "providerErrorType",
        "providerStatusCode",
        "requestId",
        "scopeKind",
      ]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(manuscriptSentinel);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(credentialSentinel);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps only bounded provider status and allowlisted SDK error type fields", function () {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      recordAiReviewerFailure({
        requestId: "provider-diagnostics-request",
        provider: "gemini",
        model: "gemini-safe-model",
        scopeKind: "project",
        failureCategory: "rate-limit",
        failureCode: "AI_PROVIDER_RATE_LIMITED",
        providerStatusCode: 429,
        providerErrorType: "AI_APICallError",
        elapsedMs: 17,
      });

      expect(warn).toHaveBeenCalledExactlyOnceWith(
        {
          requestId: "provider-diagnostics-request",
          provider: "gemini",
          model: "gemini-safe-model",
          scopeKind: "project",
          failureCategory: "rate-limit",
          failureCode: "AI_PROVIDER_RATE_LIMITED",
          providerStatusCode: 429,
          providerErrorType: "AI_APICallError",
          elapsedMs: 17,
        },
        AI_REVIEWER_FAILURE_LOG_MESSAGE,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps opt-in provider diagnostics while redacting credentials and author content", function () {
    const credential = `AIza${"s".repeat(35)}`;
    const responseBody = JSON.stringify({
      error: {
        code: 400,
        status: "INVALID_ARGUMENT",
        message: `Function parameters need type OBJECT; key=${credential}`,
      },
    });
    const error = new APICallError({
      message: "Provider rejected the request.",
      url: "https://generativelanguage.googleapis.com/v1beta/models/test",
      requestBodyValues: {},
      statusCode: 400,
      responseBody,
      isRetryable: false,
    });
    const previousDebugSetting = Settings.aiReviewer?.debugProviderErrors;
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      Settings.aiReviewer.debugProviderErrors = false;
      recordAiReviewerProviderDiagnostic({
        provider: "gemini",
        model: "gemini-test",
        detail: error,
      });
      expect(warn).not.toHaveBeenCalled();

      Settings.aiReviewer.debugProviderErrors = true;
      recordAiReviewerProviderDiagnostic({
        provider: "gemini",
        model: "gemini-test",
        detail: error,
      });

      expect(warn).toHaveBeenCalledExactlyOnceWith(
        {
          provider: "gemini",
          model: "gemini-test",
          detail: responseBody.replace(credential, "[REDACTED]"),
        },
        AI_REVIEWER_PROVIDER_DIAGNOSTIC_LOG_MESSAGE,
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(credential);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(
        credential.slice(4),
      );

      warn.mockClear();
      const systemInstruction =
        "You are a bounded LaTeX reviewer working inside one project conversation.";
      const systemInstructionResponse = JSON.stringify({
        error: {
          code: 400,
          message:
            `Unknown name "x" at 'systemInstruction.parts[0].text': ` +
            systemInstruction,
        },
      });
      recordAiReviewerProviderDiagnostic({
        provider: "gemini",
        model: "gemini-test",
        detail: new APICallError({
          message: "Provider rejected the request.",
          url: "https://generativelanguage.googleapis.com/v1beta/models/test",
          requestBodyValues: {
            systemInstruction: { parts: [{ text: systemInstruction }] },
            messages: [{ role: "system", content: systemInstruction }],
          },
          statusCode: 400,
          responseBody: systemInstructionResponse,
          isRetryable: false,
        }),
      });
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        {
          provider: "gemini",
          model: "gemini-test",
          detail: systemInstructionResponse,
        },
        AI_REVIEWER_PROVIDER_DIAGNOSTIC_LOG_MESSAGE,
      );

      warn.mockClear();
      const manuscript = "DISTINCTIVE_PROVIDER_ECHOED_MANUSCRIPT_CONTENT";
      const manuscriptResponse = JSON.stringify({
        error: {
          code: 400,
          message: `Invalid field after excerpt: ${manuscript}; unknown name "x".`,
        },
      });
      recordAiReviewerProviderDiagnostic({
        provider: "gemini",
        model: "gemini-test",
        detail: new APICallError({
          message: "Provider rejected the request.",
          url: "https://generativelanguage.googleapis.com/v1beta/models/test",
          requestBodyValues: {
            contents: [{ role: "user", parts: [{ text: manuscript }] }],
          },
          statusCode: 400,
          responseBody: manuscriptResponse,
          isRetryable: false,
        }),
      });
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        {
          provider: "gemini",
          model: "gemini-test",
          detail: manuscriptResponse.replace(
            manuscript,
            "[REDACTED: author content]",
          ),
        },
        AI_REVIEWER_PROVIDER_DIAGNOSTIC_LOG_MESSAGE,
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(manuscript);
    } finally {
      Settings.aiReviewer.debugProviderErrors = previousDebugSetting;
      warn.mockRestore();
    }
  });
});
