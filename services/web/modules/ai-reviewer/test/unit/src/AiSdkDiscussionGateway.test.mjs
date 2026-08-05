import { simulateReadableStream } from "ai";
// The SDK publishes this test entrypoint, but the repository resolver does not
// currently resolve package export subpaths.
// eslint-disable-next-line import/no-unresolved
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { AiSdkAgentGateway } from "../../../app/src/AiSdkAgentGateway.mjs";

const createdAt = "2026-07-25T00:00:00.000Z";
const contentHash = "a".repeat(64);

function sourceRequest(overrides = {}) {
  return {
    requestId: "source-request-0001",
    projectId: "project-discussion-0001",
    action: "rewrite",
    instruction: "Improve the selected text.",
    skill: "line-edit",
    scope: {
      kind: "selection",
      documentId: "document-discussion-0001",
      path: "main.tex",
      baseRevision: 7,
      baseTextHash: contentHash,
      range: { from: 0, to: 4 },
      text: "Text",
    },
    ...overrides,
  };
}

function discussionRequest(overrides = {}) {
  const source = sourceRequest();
  return {
    requestId: "discussion-turn-0001",
    discussionId: "discussion-0001",
    projectId: source.projectId,
    subject: {
      kind: "scope",
      sourceRequest: source,
    },
    turns: [{ role: "user", text: "Why should this wording change?" }],
    ...overrides,
  };
}

function usage(inputTokens = 3, outputTokens = 2) {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: inputTokens,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: outputTokens,
      text: outputTokens,
      reasoning: undefined,
    },
  };
}

function finish(finishReason, tokenUsage = usage()) {
  return {
    type: "finish",
    finishReason: {
      unified: finishReason,
      raw: finishReason,
    },
    usage: tokenUsage,
  };
}

function streamResult(chunks) {
  return {
    stream: simulateReadableStream({
      chunks,
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}

function textStep(text, tokenUsage = usage()) {
  return streamResult([
    { type: "text-start", id: "discussion-text-0001" },
    {
      type: "text-delta",
      id: "discussion-text-0001",
      delta: text,
    },
    { type: "text-end", id: "discussion-text-0001" },
    finish("stop", tokenUsage),
  ]);
}

function strictStreamModel(results) {
  let index = 0;
  const model = new MockLanguageModelV3({
    provider: "fixture",
    modelId: "fixture-model",
    doStream: async () => {
      if (index >= results.length) {
        throw new Error("Unexpected extra model step.");
      }
      const result = results[index];
      index += 1;
      return result;
    },
  });
  return { model, consumed: () => index };
}

function createGateway(model, overrides = {}) {
  let id = 0;
  return new AiSdkAgentGateway({
    model,
    provider: "fixture-provider",
    modelId: "fixture-model",
    contextLength: 8_192,
    readProjectFile: async () => {
      throw new Error("Discussion must not read project files.");
    },
    now: () => createdAt,
    createId: (kind) => `${kind}-${String((id += 1)).padStart(4, "0")}`,
    ...overrides,
  });
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

async function captureError(work) {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject.");
}

describe("AI reviewer: subject-bound discussion gateway", function () {
  it("streams free text through the hardened model path without a generation cap", async function () {
    const { model } = strictStreamModel([
      textStep("A concise discussion response.", usage(5, 50_000)),
    ]);
    const gateway = createGateway(model);

    const events = await collect(gateway.streamDiscussion(discussionRequest()));

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "text.delta",
      "completed",
    ]);
    expect(events[1]).toMatchObject({
      requestId: "discussion-turn-0001",
      delta: "A concise discussion response.",
    });
    expect(events[2]).toMatchObject({
      usage: {
        inputTokens: 5,
        outputTokens: 50_000,
      },
    });
    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0].maxOutputTokens).toBeUndefined();
    expect(model.doStreamCalls[0].responseFormat).toBeUndefined();
    expect(model.doStreamCalls[0].tools).toEqual([
      expect.objectContaining({
        type: "function",
        name: "propose_suggestion",
      }),
    ]);
    expect(model.doStreamCalls[0].prompt[0].content).toContain(
      "Do not start, claim to start, or simulate a review run.",
    );
    const prompt = JSON.parse(model.doStreamCalls[0].prompt[1].content[0].text);
    expect(prompt.turns).toEqual(discussionRequest().turns);
  });

  it("derives the discussion prompt budget from the configured context length", async function () {
    const request = discussionRequest({
      turns: [{ role: "user", text: "x".repeat(1_200) }],
    });
    const { model: smallModel } = strictStreamModel([
      textStep("Must not run."),
    ]);
    const { model: largeModel } = strictStreamModel([textStep("Fits.")]);

    expect(
      await captureError(
        collect(
          createGateway(smallModel, {
            contextLength: 2_048,
          }).streamDiscussion(request),
        ),
      ),
    ).toMatchObject({
      code: "AI_PROJECT_CONTENT_NOT_AVAILABLE",
      category: "configuration",
      retryable: false,
    });
    expect(smallModel.doStreamCalls).toHaveLength(0);

    const events = await collect(
      createGateway(largeModel, {
        contextLength: 8_192,
      }).streamDiscussion(request),
    );
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      finishReason: "stop",
    });
    expect(largeModel.doStreamCalls).toHaveLength(1);
  });

  it("emits a discussion suggestion bound to the source review request", async function () {
    const draft = {
      documentId: "document-discussion-0001",
      path: "main.tex",
      baseRevision: 7,
      baseTextHash: contentHash,
      range: { from: 0, to: 4 },
      original: "Text",
      replacement: "Edit",
      rationale: "The replacement is more direct.",
      evidence: [
        {
          path: "main.tex",
          range: { from: 0, to: 4 },
          revision: 7,
          textHash: contentHash,
        },
      ],
    };
    const toolStep = streamResult([
      {
        type: "tool-call",
        toolCallId: "discussion-tool-0001",
        toolName: "propose_suggestion",
        input: JSON.stringify(draft),
      },
      finish("tool-calls"),
    ]);
    const { model, consumed } = strictStreamModel([toolStep]);

    const events = await collect(
      createGateway(model).streamDiscussion(discussionRequest()),
    );

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "suggestion",
      "completed",
    ]);
    expect(events[1]).toMatchObject({
      requestId: "discussion-turn-0001",
      suggestion: {
        ...draft,
        requestId: "source-request-0001",
        projectId: "project-discussion-0001",
        provider: "fixture-provider",
        model: "fixture-model",
        skill: "line-edit",
        status: "proposed",
      },
    });
    expect(consumed()).toBe(1);
  });

  it("rejects a discussion suggestion outside the source request scope", async function () {
    const toolStep = streamResult([
      {
        type: "tool-call",
        toolCallId: "discussion-tool-outside",
        toolName: "propose_suggestion",
        input: JSON.stringify({
          documentId: "another-document",
          path: "other.tex",
          baseRevision: 7,
          baseTextHash: contentHash,
          range: { from: 0, to: 4 },
          original: "Text",
          replacement: "Edit",
          rationale: "Synthetic rationale.",
          evidence: [
            {
              path: "other.tex",
              range: { from: 0, to: 4 },
              revision: 7,
              textHash: contentHash,
            },
          ],
        }),
      },
      finish("tool-calls"),
    ]);
    const { model } = strictStreamModel([toolStep]);

    expect(
      await captureError(
        collect(createGateway(model).streamDiscussion(discussionRequest())),
      ),
    ).toMatchObject({
      code: "AI_EVENT_EVIDENCE_SCOPE_MISMATCH",
      category: "schema",
      retryable: false,
    });
  });

  it("does not expose the suggestion tool for a project-scope discussion", async function () {
    const projectSource = sourceRequest({
      action: "review",
      instruction: "Review the project.",
      skill: "referee-review",
      scope: { kind: "project" },
    });
    const request = discussionRequest({
      subject: {
        kind: "scope",
        sourceRequest: projectSource,
      },
    });
    const { model } = strictStreamModel([textStep("Project discussion only.")]);

    await collect(createGateway(model).streamDiscussion(request));

    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0].tools).toBeUndefined();
  });
});
