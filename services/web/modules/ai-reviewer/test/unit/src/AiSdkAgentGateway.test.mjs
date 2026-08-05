import { describe, expect, it, vi } from "vitest";
import { simulateReadableStream } from "ai";
// The SDK publishes this test entrypoint, but the repository resolver does not
// currently resolve package export subpaths.
// eslint-disable-next-line import/no-unresolved
import { MockLanguageModelV3 } from "ai/test";

import { AiSdkAgentGateway } from "../../../app/src/AiSdkAgentGateway.mjs";

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

function structuredOutput() {
  return {
    narrative: "Synthetic structured review.",
    suggestions: [
      {
        documentId: "document-sdk-0001",
        path: "main.tex",
        baseRevision: 1,
        baseTextHash: "a".repeat(64),
        range: { from: 0, to: 4 },
        original: "Text",
        replacement: "Edit",
        rationale: "Synthetic rationale.",
        evidence: [
          {
            path: "main.tex",
            range: { from: 0, to: 4 },
            revision: 1,
            textHash: "a".repeat(64),
          },
        ],
      },
    ],
    findings: [
      {
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
      },
    ],
  };
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
    const output = JSON.stringify(structuredOutput());
    const structuredStep = streamResult([
      { type: "text-start", id: "text-0001" },
      { type: "text-delta", id: "text-0001", delta: output },
      { type: "text-end", id: "text-0001" },
      finish("stop", usage(5, 8)),
    ]);
    const { model, consumed } = strictStreamModel([toolStep, structuredStep]);
    const readProjectFile = vi.fn(async () => ({
      path: "main.tex",
      text: "Synthetic tool result.",
    }));
    const controller = new AbortController();
    const gateway = createGateway(model, { readProjectFile });

    const events = await collect(
      gateway.stream(request(), { signal: controller.signal }),
    );

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "tool.call",
      "text.delta",
      "suggestion",
      "finding",
      "completed",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([0, 1, 2, 3, 4, 5]);
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
      suggestion: {
        requestId: "request-sdk-0001",
        projectId: "project-sdk-0001",
        provider: "fixture-provider",
        model: "fixture-model",
        status: "proposed",
      },
    });
    expect(events[4]).toMatchObject({
      finding: {
        requestId: "request-sdk-0001",
        projectId: "project-sdk-0001",
      },
    });
    expect(events[5]).toMatchObject({
      finishReason: "stop",
      usage: {
        inputTokens: 8,
        outputTokens: 10,
      },
    });
    expect(readProjectFile).toHaveBeenCalledOnce();
    expect(consumed()).toBe(2);
    expect(model.doStreamCalls).toHaveLength(2);
    expect(model.doStreamCalls[0].abortSignal).toBe(controller.signal);
    expect(model.doStreamCalls[1].abortSignal).toBe(controller.signal);
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
