import { describe, expect, it } from "vitest";

import {
  formatAgentMessages,
  estimateAgentPromptTokens,
} from "../../../app/src/AiReviewerPrompt.mjs";
import { estimateModelInputTokens } from "../../../app/src/ModelContextBudget.mjs";

describe("AI reviewer model context budget", function () {
  it("estimates English text at about four characters per token", function () {
    expect(estimateModelInputTokens("a".repeat(4_000))).toBe(1_000);
  });

  it("estimates Japanese text at one character per token", function () {
    expect(estimateModelInputTokens("あー".repeat(500))).toBe(1_000);
  });

  it("counts CJK and ASCII portions at their respective rates", function () {
    expect(estimateModelInputTokens("汉".repeat(600) + "a".repeat(1_600))).toBe(
      1_000,
    );
  });

  it("classifies every specified CJK script and shared range as CJK", function () {
    expect(estimateModelInputTokens("漢あア한、Ａ")).toBe(6);
  });

  it("adds four tokens of overhead per message", function () {
    expect(
      estimateModelInputTokens([{ content: "abcd" }, { content: "efgh" }]),
    ).toBe(10);
  });

  it("measures raw LaTeX message text instead of its JSON escaping", function () {
    const request = {
      requestId: "request-latex-budget-0001",
      projectId: "project-latex-budget-0001",
      action: "review",
      instruction: "Check the LaTeX commands.",
      skill: "line-edit",
      scope: {
        kind: "document",
        documentId: "document-latex-budget-0001",
        path: "main.tex",
        baseRevision: 1,
        baseTextHash: "a".repeat(64),
        text: "\\".repeat(4_000),
      },
      turns: [],
    };
    const messages = formatAgentMessages(request, null);
    const rawEstimate = estimateAgentPromptTokens(request, null);
    const serializedEstimate = estimateModelInputTokens(
      JSON.stringify(messages),
    );

    expect(rawEstimate).toBe(estimateModelInputTokens(messages));
    expect(serializedEstimate).toBeGreaterThan(rawEstimate * 1.9);
  });
});
