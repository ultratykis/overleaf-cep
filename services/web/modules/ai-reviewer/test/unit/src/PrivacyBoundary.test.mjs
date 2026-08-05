import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

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
});
