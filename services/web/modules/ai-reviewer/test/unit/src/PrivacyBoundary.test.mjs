import { readFile } from "node:fs/promises";

import logger from "@overleaf/logger";
import { describe, expect, it, vi } from "vitest";

import {
  AI_REVIEWER_FAILURE_LOG_MESSAGE,
  recordAiReviewerFailure,
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
        failureCode: "AI_PROVIDER_SCHEMA_INVALID",
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
          failureCode: "AI_PROVIDER_SCHEMA_INVALID",
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
        "requestId",
        "scopeKind",
      ]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(manuscriptSentinel);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(credentialSentinel);
    } finally {
      warn.mockRestore();
    }
  });
});
