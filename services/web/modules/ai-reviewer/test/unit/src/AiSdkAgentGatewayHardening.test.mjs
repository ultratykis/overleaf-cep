import {
  APICallError,
  NoObjectGeneratedError,
  RetryError,
  simulateReadableStream,
} from "ai";
// The AI SDK exports this test entrypoint, but the repository's import
// resolver does not currently resolve package export subpaths.
// eslint-disable-next-line import/no-unresolved
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { AiSdkAgentGateway } from "../../../app/src/AiSdkAgentGateway.mjs";
import { AgentGatewayError } from "../../../app/src/AgentGateway.mjs";

const createdAt = "2026-07-24T00:00:00.000Z";
const contentHash = "a".repeat(64);

function projectRequest(overrides = {}) {
  return {
    requestId: "request-sdk-hardening-0001",
    projectId: "project-sdk-hardening-0001",
    action: "review",
    instruction: "Review the synthetic project.",
    skill: "referee-review",
    scope: {
      kind: "project",
    },
    ...overrides,
  };
}

function selectionRequest(overrides = {}) {
  return projectRequest({
    scope: {
      kind: "selection",
      documentId: "document-sdk-hardening-0001",
      path: "main.tex",
      baseRevision: 7,
      baseTextHash: contentHash,
      range: { from: 10, to: 14 },
      text: "Text",
    },
    ...overrides,
  });
}

function documentRequest(overrides = {}) {
  return projectRequest({
    scope: {
      kind: "document",
      documentId: "document-sdk-hardening-0001",
      path: "main.tex",
      baseRevision: 7,
      baseTextHash: contentHash,
      text: "Text",
    },
    ...overrides,
  });
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

function toolStep(
  toolInput,
  toolCallId = "tool-call-hardening-0001",
  providerExecuted = false,
) {
  return streamResult([
    {
      type: "tool-call",
      toolCallId,
      toolName: "read_project_file",
      input: JSON.stringify(toolInput),
      providerExecuted,
    },
    finish("tool-calls"),
  ]);
}

function outputChunks(output, finishReason = "stop") {
  const text = JSON.stringify(output);
  return [
    { type: "text-start", id: "text-hardening-0001" },
    {
      type: "text-delta",
      id: "text-hardening-0001",
      delta: text,
    },
    { type: "text-end", id: "text-hardening-0001" },
    finish(finishReason),
  ];
}

function outputStep(output, finishReason = "stop") {
  return streamResult(outputChunks(output, finishReason));
}

function outputStepWithWarnings(output, warnings) {
  return streamResult([
    { type: "stream-start", warnings },
    ...outputChunks(output),
  ]);
}

function validSuggestion(overrides = {}) {
  return {
    documentId: "document-sdk-hardening-0001",
    path: "main.tex",
    baseRevision: 7,
    baseTextHash: contentHash,
    range: { from: 0, to: 4 },
    original: "Text",
    replacement: "Edit",
    rationale: "Synthetic rationale.",
    evidence: [
      {
        path: "main.tex",
        range: { from: 0, to: 4 },
        revision: 7,
        textHash: contentHash,
      },
    ],
    ...overrides,
  };
}

function validOutput(overrides = {}) {
  return {
    narrative: "Synthetic structured review.",
    findings: [],
    suggestions: [],
    ...overrides,
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

function throwingModel(error) {
  return new MockLanguageModelV3({
    provider: "fixture",
    modelId: "fixture-model",
    doStream: async () => {
      throw error;
    },
  });
}

function abortAwareModel() {
  let observeSignal;
  const observedSignal = new Promise((resolve) => {
    observeSignal = resolve;
  });
  const model = new MockLanguageModelV3({
    provider: "fixture",
    modelId: "fixture-model",
    doStream: async ({ abortSignal }) => {
      observeSignal(abortSignal);
      return await new Promise((resolve, reject) => {
        const rejectForAbort = () => reject(abortSignal?.reason);
        if (abortSignal?.aborted) {
          rejectForAbort();
          return;
        }
        abortSignal?.addEventListener("abort", rejectForAbort, {
          once: true,
        });
      });
    },
  });
  return { model, observedSignal };
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

describe("AI reviewer: AI SDK v6 adapter hardening", function () {
  it.each([
    {
      label: "explicit cancellation",
      reason: new DOMException("Synthetic cancellation.", "AbortError"),
      expected: {
        name: "AgentGatewayAbortError",
        code: "AI_REQUEST_ABORTED",
        category: "aborted",
        retryable: false,
      },
    },
    {
      label: "timeout cancellation",
      reason: new DOMException("Synthetic timeout.", "TimeoutError"),
      expected: {
        name: "AgentGatewayTimeoutError",
        code: "AI_REQUEST_TIMEOUT",
        category: "timeout",
        retryable: true,
      },
    },
  ])(
    "propagates the caller signal and classifies $label",
    async function ({ reason, expected }) {
      const controller = new AbortController();
      const { model, observedSignal } = abortAwareModel();
      const gateway = createGateway(model);
      const iterator = gateway.stream(projectRequest(), {
        signal: controller.signal,
      });

      expect(await iterator.next()).toMatchObject({
        done: false,
        value: { type: "started", sequence: 0 },
      });
      const pendingError = captureError(iterator.next());
      expect(await observedSignal).toBe(controller.signal);

      controller.abort(reason);

      expect(await pendingError).toMatchObject(expected);
      expect(model.doStreamCalls).toHaveLength(1);
      expect(model.doStreamCalls[0].abortSignal).toBe(controller.signal);
    },
  );

  it.each([
    {
      statusCode: 401,
      isRetryable: true,
      expected: {
        code: "AI_PROVIDER_AUTHENTICATION_FAILED",
        category: "authentication",
        retryable: false,
      },
    },
    {
      statusCode: 403,
      isRetryable: true,
      expected: {
        code: "AI_PROVIDER_AUTHENTICATION_FAILED",
        category: "authentication",
        retryable: false,
      },
    },
    {
      statusCode: 429,
      isRetryable: false,
      expected: {
        code: "AI_PROVIDER_RATE_LIMITED",
        category: "rate-limit",
        retryable: true,
      },
    },
    {
      statusCode: undefined,
      isRetryable: true,
      expected: {
        code: "AI_PROVIDER_NETWORK_FAILED",
        category: "network",
        retryable: true,
      },
    },
    {
      statusCode: 503,
      isRetryable: true,
      expected: {
        code: "AI_PROVIDER_REQUEST_FAILED",
        category: "provider",
        retryable: true,
      },
    },
  ])(
    "classifies an API call with status $statusCode",
    async function ({ statusCode, isRetryable, expected }) {
      const sdkError = new APICallError({
        message: "Synthetic API failure.",
        url: "https://provider.invalid/v1/chat",
        requestBodyValues: { fixture: true },
        statusCode,
        isRetryable,
      });
      const gateway = createGateway(throwingModel(sdkError));

      expect(
        await captureError(collect(gateway.stream(projectRequest()))),
      ).toMatchObject(expected);
    },
  );

  it("classifies a RetryError from its last SDK error", async function () {
    const lastError = new APICallError({
      message: "Synthetic rate limit.",
      url: "https://provider.invalid/v1/chat",
      requestBodyValues: { fixture: true },
      statusCode: 429,
      isRetryable: true,
    });
    const retryError = new RetryError({
      message: "Synthetic retries exhausted.",
      reason: "maxRetriesExceeded",
      errors: [new Error("Synthetic first attempt."), lastError],
    });
    const gateway = createGateway(throwingModel(retryError));

    expect(
      await captureError(collect(gateway.stream(projectRequest()))),
    ).toMatchObject({
      code: "AI_PROVIDER_RATE_LIMITED",
      category: "rate-limit",
      retryable: true,
    });
  });

  it("rejects malformed structured output as a bounded schema error", async function () {
    const { model } = strictStreamModel([
      outputStep({
        narrative: "Synthetic malformed review.",
        findings: [],
        suggestions: [],
        undeclared: true,
      }),
    ]);
    const gateway = createGateway(model);

    expect(
      await captureError(collect(gateway.stream(projectRequest()))),
    ).toMatchObject({
      code: "AI_PROVIDER_SCHEMA_INVALID",
      category: "schema",
      retryable: false,
      message: "The AI provider returned an invalid structured response.",
    });
  });

  it("classifies an explicit NoObjectGeneratedError without exposing its text", async function () {
    const sentinel = "NO_OBJECT_RAW_SENTINEL";
    const sdkError = new NoObjectGeneratedError({
      message: sentinel,
      cause: new Error(sentinel),
      text: sentinel,
      response: {
        id: "response-hardening-0001",
        timestamp: new Date(createdAt),
        modelId: "fixture-model",
      },
      usage: usage(),
      finishReason: "stop",
    });
    const gateway = createGateway(throwingModel(sdkError));

    const error = await captureError(collect(gateway.stream(projectRequest())));

    expect(error).toMatchObject({
      code: "AI_PROVIDER_SCHEMA_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(String(error)).not.toContain(sentinel);
    expect(JSON.stringify(error)).not.toContain(sentinel);
  });

  it.each([
    {
      label: "selection path",
      request: selectionRequest(),
      toolInput: {
        path: "other.tex",
        range: { from: 10, to: 14 },
      },
    },
    {
      label: "selection missing range",
      request: selectionRequest(),
      toolInput: { path: "main.tex" },
    },
    {
      label: "selection range",
      request: selectionRequest(),
      toolInput: {
        path: "main.tex",
        range: { from: 9, to: 13 },
      },
    },
    {
      label: "document path",
      request: documentRequest(),
      toolInput: {
        path: "other.tex",
        range: { from: 0, to: 4 },
      },
    },
    {
      label: "document range",
      request: documentRequest(),
      toolInput: {
        path: "main.tex",
        range: { from: 0, to: 5 },
      },
    },
  ])(
    "rejects an out-of-scope $label read",
    async function ({ request, toolInput }) {
      const { model, consumed } = strictStreamModel([toolStep(toolInput)]);
      const readProjectFile = vi.fn();
      const gateway = createGateway(model, { readProjectFile });

      expect(
        await captureError(collect(gateway.stream(request))),
      ).toMatchObject({
        code: "AI_TOOL_SCOPE_MISMATCH",
        category: "schema",
        retryable: false,
      });
      expect(readProjectFile).not.toHaveBeenCalled();
      expect(consumed()).toBe(1);
      expect(model.doStreamCalls).toHaveLength(1);
    },
  );

  it("rejects a provider-executed project read without trusting its result", async function () {
    const { model, consumed } = strictStreamModel([
      toolStep(
        { path: "private.tex", range: { from: 0, to: 4 } },
        "tool-call-provider-executed-0001",
        true,
      ),
    ]);
    const readProjectFile = vi.fn();
    const gateway = createGateway(model, { readProjectFile });

    expect(
      await captureError(collect(gateway.stream(projectRequest()))),
    ).toMatchObject({
      code: "AI_TOOL_NOT_ALLOWED",
      category: "schema",
      retryable: false,
    });
    expect(readProjectFile).not.toHaveBeenCalled();
    expect(consumed()).toBe(1);
    expect(model.doStreamCalls).toHaveLength(1);
  });

  it.each([
    {
      label: "selection path",
      request: selectionRequest(),
      suggestion: validSuggestion({
        path: "other.tex",
        range: { from: 10, to: 14 },
        evidence: [
          {
            path: "main.tex",
            range: { from: 10, to: 14 },
            revision: 7,
            textHash: contentHash,
          },
        ],
      }),
    },
    {
      label: "selection range",
      request: selectionRequest(),
      suggestion: validSuggestion({
        range: { from: 9, to: 13 },
        evidence: [
          {
            path: "main.tex",
            range: { from: 10, to: 14 },
            revision: 7,
            textHash: contentHash,
          },
        ],
      }),
    },
    {
      label: "document path",
      request: documentRequest(),
      suggestion: validSuggestion({
        path: "other.tex",
      }),
    },
    {
      label: "document range",
      request: documentRequest(),
      suggestion: validSuggestion({
        range: { from: 1, to: 5 },
      }),
    },
  ])(
    "rejects an out-of-scope $label suggestion",
    async function ({ request, suggestion }) {
      const { model } = strictStreamModel([
        outputStep(validOutput({ suggestions: [suggestion] })),
      ]);
      const gateway = createGateway(model);

      expect(
        await captureError(collect(gateway.stream(request))),
      ).toMatchObject({
        code: "AI_EVENT_SCOPE_MISMATCH",
        category: "schema",
        retryable: false,
      });
    },
  );

  it("preserves a project callback allowlist rejection", async function () {
    const { model } = strictStreamModel([
      toolStep({ path: "private.tex", range: { from: 0, to: 4 } }),
    ]);
    const rejection = new AgentGatewayError(
      "The requested project file is not allowlisted.",
      {
        code: "AI_PROJECT_FILE_NOT_ALLOWED",
        category: "schema",
        retryable: false,
      },
    );
    const readProjectFile = vi.fn(async () => {
      throw rejection;
    });
    const controller = new AbortController();
    const request = projectRequest();
    const gateway = createGateway(model, { readProjectFile });

    expect(
      await captureError(
        collect(gateway.stream(request, { signal: controller.signal })),
      ),
    ).toBe(rejection);
    expect(readProjectFile).toHaveBeenCalledOnce();
    expect(readProjectFile).toHaveBeenCalledWith(
      {
        path: "private.tex",
        range: { from: 0, to: 4 },
      },
      {
        request,
        signal: controller.signal,
      },
    );
  });

  it("rejects a second read-tool call without invoking the callback twice", async function () {
    const { model, consumed } = strictStreamModel([
      toolStep(
        { path: "main.tex", range: { from: 0, to: 4 } },
        "tool-call-hardening-0001",
      ),
      toolStep(
        { path: "appendix.tex", range: { from: 0, to: 4 } },
        "tool-call-hardening-0002",
      ),
    ]);
    const readProjectFile = vi.fn(async () => ({
      path: "main.tex",
      text: "Synthetic tool result.",
    }));
    const gateway = createGateway(model, { readProjectFile });

    expect(
      await captureError(collect(gateway.stream(projectRequest()))),
    ).toMatchObject({
      code: "AI_TOOL_CALL_LIMIT_EXCEEDED",
      category: "schema",
      retryable: false,
    });
    expect(readProjectFile).toHaveBeenCalledOnce();
    expect(consumed()).toBe(2);
    expect(model.doStreamCalls).toHaveLength(2);
  });

  it("stops after the structured second step without another model call", async function () {
    const { model, consumed } = strictStreamModel([
      toolStep({ path: "main.tex", range: { from: 0, to: 4 } }),
      outputStep(validOutput()),
      outputStep(validOutput({ narrative: "Forbidden third step." })),
    ]);
    const gateway = createGateway(model);

    const events = await collect(gateway.stream(projectRequest()));

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      sequence: 3,
      finishReason: "stop",
    });
    expect(consumed()).toBe(2);
    expect(model.doStreamCalls).toHaveLength(2);
  });

  it("binds every suggestion to the explicitly selected request skill", async function () {
    const suggestion = validSuggestion();
    const { model } = strictStreamModel([
      outputStep(validOutput({ suggestions: [suggestion] })),
    ]);
    const gateway = createGateway(model);

    const events = await collect(
      gateway.stream(projectRequest({ skill: "line-edit" })),
    );

    expect(events.find((event) => event.type === "suggestion")).toMatchObject({
      suggestion: {
        skill: "line-edit",
        provider: "fixture-provider",
        model: "fixture-model",
        status: "proposed",
      },
    });
  });

  it("rejects a structured suggestion when the request skill is null", async function () {
    const { model } = strictStreamModel([
      outputStep(validOutput({ suggestions: [validSuggestion()] })),
    ]);
    const gateway = createGateway(model);

    expect(
      await captureError(
        collect(gateway.stream(projectRequest({ skill: null }))),
      ),
    ).toMatchObject({
      code: "AI_SUGGESTION_SKILL_REQUIRED",
      category: "schema",
      retryable: false,
    });
  });

  it("does not leak raw API error sentinels through errors or console output", async function () {
    const sentinel = "RAW_API_ERROR_SENTINEL";
    const sdkError = new APICallError({
      message: sentinel,
      url: `https://provider.invalid/${sentinel}`,
      requestBodyValues: {
        prompt: sentinel,
      },
      statusCode: 500,
      responseBody: sentinel,
      cause: new Error(sentinel),
      isRetryable: false,
      data: {
        response: sentinel,
      },
    });
    const gateway = createGateway(throwingModel(sdkError));
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    try {
      const error = await captureError(
        collect(gateway.stream(projectRequest())),
      );
      const publicError = [
        String(error),
        JSON.stringify(error),
        error.stack ?? "",
      ].join("\n");

      expect(error).toMatchObject({
        code: "AI_PROVIDER_REQUEST_FAILED",
        category: "provider",
        retryable: false,
        message: "The AI provider rejected the request.",
      });
      expect(error.cause).toBeUndefined();
      expect(publicError).not.toContain(sentinel);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("discards provider warnings before process-global or console loggers can observe them", async function () {
    const sentinel = "AI_REVIEWER_WARNING_SECRET";
    const warning = { type: "other", message: sentinel };
    const priorWarningLogger = Object.getOwnPropertyDescriptor(
      globalThis,
      "AI_SDK_LOG_WARNINGS",
    );
    const customWarningLogger = vi.fn();
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      for (const logger of [undefined, customWarningLogger]) {
        if (logger == null) {
          Reflect.deleteProperty(globalThis, "AI_SDK_LOG_WARNINGS");
        } else {
          Reflect.set(globalThis, "AI_SDK_LOG_WARNINGS", logger);
        }
        const { model } = strictStreamModel([
          outputStepWithWarnings(validOutput(), [warning]),
        ]);
        const events = await collect(
          createGateway(model).stream(projectRequest()),
        );

        expect(events.at(-1)).toMatchObject({
          type: "completed",
          finishReason: "stop",
        });
      }

      expect(customWarningLogger).not.toHaveBeenCalled();
      expect(consoleInfo).not.toHaveBeenCalled();
      expect(consoleWarn).not.toHaveBeenCalled();
      expect(
        JSON.stringify([
          customWarningLogger.mock.calls,
          consoleInfo.mock.calls,
          consoleWarn.mock.calls,
        ]),
      ).not.toContain(sentinel);
    } finally {
      consoleInfo.mockRestore();
      consoleWarn.mockRestore();
      if (priorWarningLogger == null) {
        Reflect.deleteProperty(globalThis, "AI_SDK_LOG_WARNINGS");
      } else {
        Object.defineProperty(
          globalThis,
          "AI_SDK_LOG_WARNINGS",
          priorWarningLogger,
        );
      }
    }
  });
});
