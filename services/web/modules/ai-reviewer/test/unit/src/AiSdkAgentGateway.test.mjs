import logger from "@overleaf/logger";
import { describe, expect, it, vi } from "vitest";
import { simulateReadableStream } from "ai";
// The SDK publishes this test entrypoint, but the repository resolver does not
// currently resolve package export subpaths.
// eslint-disable-next-line import/no-unresolved
import { MockLanguageModelV3 } from "ai/test";

import { AiSdkAgentGateway } from "../../../app/src/AiSdkAgentGateway.mjs";
import { AI_REVIEWER_COMPLETION_LOG_MESSAGE } from "../../../app/src/AiReviewerFailureLogger.mjs";

const createdAt = "2026-07-24T00:00:00.000Z";

function request() {
  return {
    requestId: "request-sdk-0001",
    projectId: "project-sdk-0001",
    action: "review",
    instruction: "Review the synthetic project.",
    skill: "referee-review",
    scope: {
      kind: "project",
    },
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

function streamResult(chunks) {
  return {
    stream: simulateReadableStream({
      chunks,
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
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

function structuredOutput(findingOverrides = {}) {
  return {
    narrative: "Synthetic structured review.",
    suggestions: [],
    findings: [
      {
        artifactKind: "finding",
        severity: "suggestion",
        category: "style",
        title: "Synthetic finding",
        message: "A deterministic finding.",
        evidence: [
          {
            path: "main.tex",
            range: { from: 0, to: 4 },
            revision: 1,
            textHash: "a".repeat(64),
          },
        ],
        ...findingOverrides,
      },
    ],
  };
}

// The narrative streams as free text and each finding arrives as its own tool
// call, so one review is a conversation the model drives with tools.
function reviewStep(output, textId = "text-0001") {
  return streamResult([
    { type: "text-start", id: textId },
    { type: "text-delta", id: textId, delta: output.narrative },
    { type: "text-end", id: textId },
    ...output.findings.map((finding, index) => ({
      type: "tool-call",
      toolCallId: `report-finding-${index}`,
      toolName: "report_finding",
      input: JSON.stringify(finding),
    })),
    finish("tool-calls"),
  ]);
}

function closingStep(tokenUsage = usage(5, 8)) {
  return streamResult([finish("stop", tokenUsage)]);
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
    readProjectFile: async () => ({
      path: "main.tex",
      text: "Synthetic tool result.",
    }),
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

async function captureError(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject.");
}

describe("AI reviewer: AI SDK v6 adapter", function () {
  it("records that the finding tool was offered even when the model made no tool call", async function () {
    const { model } = strictStreamModel([
      streamResult([
        { type: "text-start", id: "text-no-finding-0001" },
        {
          type: "text-delta",
          id: "text-no-finding-0001",
          delta: "No structured finding was reported.",
        },
        { type: "text-end", id: "text-no-finding-0001" },
        finish("stop"),
      ]),
    ]);
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      await collect(createGateway(model).stream(request()));

      expect(info).toHaveBeenCalledExactlyOnceWith(
        {
          requestId: "request-sdk-0001",
          provider: "fixture-provider",
          model: "fixture-model",
          scopeKind: "project",
          findingToolOffered: true,
          toolCallCounts: {},
          pendingValidatedArtifactCount: 0,
        },
        AI_REVIEWER_COMPLETION_LOG_MESSAGE,
      );
    } finally {
      info.mockRestore();
    }
  });

  it("emits a structured subject from the same review run", async function () {
    const subjectStep = streamResult([
      {
        type: "tool-call",
        toolCallId: "report-subject-0001",
        toolName: "report_subject",
        input: JSON.stringify({ subject: "Claim support in chapter 3" }),
      },
      finish("tool-calls"),
    ]);
    const { model, consumed } = strictStreamModel([subjectStep, closingStep()]);
    const gateway = createGateway(model);
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});

    try {
      const events = await collect(gateway.stream(request()));

      expect(events.map((event) => event.type)).toEqual([
        "started",
        "subject",
        "completed",
      ]);
      expect(events[1]).toMatchObject({
        subject: "Claim support in chapter 3",
        sequence: 1,
      });
      expect(consumed()).toBe(2);
      expect(info).toHaveBeenCalledExactlyOnceWith(
        {
          requestId: "request-sdk-0001",
          provider: "fixture-provider",
          model: "fixture-model",
          scopeKind: "project",
          findingToolOffered: true,
          toolCallCounts: { report_subject: 1 },
          pendingValidatedArtifactCount: 0,
        },
        AI_REVIEWER_COMPLETION_LOG_MESSAGE,
      );
    } finally {
      info.mockRestore();
    }
  });

  it("maps one read-only tool call and structured result into local events", async function () {
    const toolStep = streamResult([
      {
        type: "tool-call",
        toolCallId: "tool-call-0001",
        toolName: "read_project_file",
        input: JSON.stringify({
          path: "main.tex",
          range: { from: 0, to: 4 },
        }),
      },
      finish("tool-calls"),
    ]);
    const { model, consumed } = strictStreamModel([
      toolStep,
      reviewStep(structuredOutput()),
      closingStep(),
    ]);
    const readProjectFile = vi.fn(async () => ({
      path: "main.tex",
      text: "Synthetic tool result.",
    }));
    const validateEvidence = vi.fn();
    const controller = new AbortController();
    const gateway = createGateway(model, {
      readProjectFile,
      projectContext: {
        summary: { fileCount: 1 },
        files: [{ path: "main.tex", textLength: 4 }],
      },
      validateEvidence,
    });

    const events = await collect(
      gateway.stream(request(), { signal: controller.signal }),
    );

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "tool.call",
      "text.delta",
      "finding",
      "completed",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4]);
    expect(events[1]).toMatchObject({
      call: {
        id: "tool-call-0001",
        name: "read_project_file",
        arguments: {
          path: "main.tex",
          range: { from: 0, to: 4 },
        },
      },
    });
    expect(events[3]).toMatchObject({
      finding: {
        artifactKind: "finding",
        requestId: "request-sdk-0001",
        projectId: "project-sdk-0001",
      },
    });
    expect(events[3].finding).not.toHaveProperty("proposedText");
    expect(events[4]).toMatchObject({
      finishReason: "stop",
      usage: {
        inputTokens: 11,
        outputTokens: 12,
      },
    });
    expect(readProjectFile).toHaveBeenCalledOnce();
    expect(consumed()).toBe(3);
    expect(model.doStreamCalls).toHaveLength(3);
    expect(model.doStreamCalls[0].abortSignal).toBe(controller.signal);
    expect(model.doStreamCalls[1].abortSignal).toBe(controller.signal);
    expect(
      model.doStreamCalls.map(
        (call) => call.providerOptions.openai.reasoningEffort,
      ),
    ).toEqual(["none", "none", "none"]);
    expect(model.doStreamCalls[0].prompt[0].content).toContain(
      "You are reviewing an academic manuscript as a referee.",
    );
    expect(model.doStreamCalls[0].prompt[0].content).toContain(
      "copy the exact cited project-file passage into evidence.excerpt",
    );
    expect(model.doStreamCalls[0].prompt[0].content).not.toContain(
      "otherwise report no finding",
    );
    expect(model.doStreamCalls[0].prompt[0].content).not.toContain(
      "count offsets",
    );
    expect(model.doStreamCalls[0].prompt[0].content).toContain(
      'artifactKind "citation-finding"',
    );
    expect(model.doStreamCalls[0].prompt[0].content).toContain(
      'artifactKind "finding"',
    );
    const userPrompt = model.doStreamCalls[0].prompt[1].content[0].text;
    expect(userPrompt).toContain("## Project");
    expect(userPrompt).toContain(
      JSON.stringify({
        summary: { fileCount: 1 },
        files: [{ path: "main.tex", textLength: 4 }],
      }),
    );
    expect(userPrompt).toContain("## Conversation");
    expect(userPrompt).toContain("User:\nReview the synthetic project.");
    expect(validateEvidence).toHaveBeenCalledExactlyOnceWith(
      structuredOutput().findings[0].evidence,
      {
        request: request(),
        signal: controller.signal,
      },
    );
  });

  it("emits an explicit citation finding with its proposed text", async function () {
    const citationOutput = structuredOutput({
      artifactKind: "citation-finding",
      proposedText: "Add a bibliography entry for the synthetic citation.",
    });
    const { model } = strictStreamModel([
      reviewStep(citationOutput, "text-citation-0001"),
      closingStep(),
    ]);
    const validateEvidence = vi.fn();
    const gateway = createGateway(model, { validateEvidence });

    const events = await collect(gateway.stream(request()));

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "text.delta",
      "finding",
      "completed",
    ]);
    expect(events[2]).toMatchObject({
      finding: {
        artifactKind: "citation-finding",
        proposedText: "Add a bibliography entry for the synthetic citation.",
        requestId: "request-sdk-0001",
        projectId: "project-sdk-0001",
      },
    });
    expect(validateEvidence).toHaveBeenCalledExactlyOnceWith(
      citationOutput.findings[0].evidence,
      {
        request: request(),
        signal: undefined,
      },
    );
  });

  it("allows one bounded Zotero search during a project review", async function () {
    const toolStep = streamResult([
      {
        type: "tool-call",
        toolCallId: "tool-call-zotero-0001",
        toolName: "search_zotero",
        input: JSON.stringify({ query: "Synthetic 2026" }),
      },
      finish("tool-calls"),
    ]);
    const { model } = strictStreamModel([
      toolStep,
      reviewStep(structuredOutput(), "text-zotero-0001"),
      closingStep(),
    ]);
    const searchZotero = vi.fn(async () => [
      {
        itemKey: "ITEM1",
        itemType: "journalArticle",
        title: "Synthetic result",
        creators: [],
        year: "2026",
        doi: null,
        verificationDepth: "metadata-only",
      },
    ]);
    const validateEvidence = vi.fn();
    const controller = new AbortController();
    const gateway = createGateway(model, {
      searchZotero,
      validateEvidence,
    });
    const activeRequest = request();

    const events = await collect(
      gateway.stream(activeRequest, { signal: controller.signal }),
    );

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "tool.call",
      "text.delta",
      "finding",
      "completed",
    ]);
    expect(events[1]).toMatchObject({
      call: {
        id: "tool-call-zotero-0001",
        name: "search_zotero",
        arguments: { query: "Synthetic 2026" },
      },
    });
    expect(searchZotero).toHaveBeenCalledExactlyOnceWith(
      { query: "Synthetic 2026" },
      {
        request: activeRequest,
        signal: controller.signal,
      },
    );
    expect(validateEvidence).toHaveBeenCalledOnce();
  });

  it("rejects a second Zotero search in the same review", async function () {
    const toolStep = streamResult([
      {
        type: "tool-call",
        toolCallId: "tool-call-zotero-first",
        toolName: "search_zotero",
        input: JSON.stringify({ query: "First query" }),
      },
      {
        type: "tool-call",
        toolCallId: "tool-call-zotero-second",
        toolName: "search_zotero",
        input: JSON.stringify({ query: "Second query" }),
      },
      finish("tool-calls"),
    ]);
    const { model } = strictStreamModel([toolStep]);
    const searchZotero = vi.fn(async () => []);
    const gateway = createGateway(model, { searchZotero });

    expect(
      await captureError(collect(gateway.stream(request()))),
    ).toMatchObject({
      code: "AI_TOOL_CALL_LIMIT_EXCEEDED",
      category: "schema",
      retryable: false,
    });
    expect(searchZotero).toHaveBeenCalledOnce();
  });

  it("rejects a string model identifier instead of using the default gateway", function () {
    expect(() => createGateway(/** @type {never} */ ("fixture:model"))).toThrow(
      "requires a concrete LanguageModel object",
    );
  });

  it("fails closed before model invocation when global telemetry is registered", async function () {
    const { model } = strictStreamModel([]);
    const gateway = createGateway(model);
    const previous = Reflect.get(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS");
    Reflect.set(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS", [{}]);
    try {
      expect(
        await captureError(collect(gateway.stream(request()))),
      ).toMatchObject({
        code: "AI_SDK_TELEMETRY_UNSAFE",
        category: "configuration",
        retryable: false,
      });
      expect(model.doStreamCalls).toHaveLength(0);
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS");
      } else {
        Reflect.set(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS", previous);
      }
    }
  });

  it("suppresses raw SDK error logging and returns a bounded provider error", async function () {
    const secret = "SDK_RAW_ERROR_SECRET_SENTINEL";
    const model = new MockLanguageModelV3({
      doStream: async () => {
        throw new Error(secret);
      },
    });
    const gateway = createGateway(model);
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      expect(
        await captureError(collect(gateway.stream(request()))),
      ).toMatchObject({
        code: "AI_PROVIDER_FAILED",
        category: "provider",
        retryable: true,
        message: "The AI provider failed.",
      });
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
