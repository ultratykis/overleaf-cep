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

async function captureErrorBeforeDeadline(promise) {
  let timeoutId;
  try {
    return await Promise.race([
      captureError(promise),
      new Promise((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("Expected the operation to settle promptly.")),
          250,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function flushProviderPromiseObservation() {
  await new Promise((resolve) => setImmediate(resolve));
}

describe("AI reviewer: AI SDK v6 adapter hardening", function () {
  it.each([
    {
      label: "specificationVersion presence check",
      model(providerError) {
        return new Proxy(
          { doStream: vi.fn() },
          {
            has(target, property) {
              if (property === "specificationVersion") {
                throw providerError;
              }
              return Reflect.has(target, property);
            },
          },
        );
      },
    },
    {
      label: "doStream getter",
      model(providerError) {
        const model = { specificationVersion: "v3" };
        Object.defineProperty(model, "doStream", {
          get() {
            throw providerError;
          },
        });
        return model;
      },
    },
  ])(
    "redacts a provider-owned error from the constructor $label",
    async function ({ model }) {
      const sentinel = "PROVIDER_CONSTRUCTOR_PRIVATE";
      const providerError = new AgentGatewayError(sentinel, {
        code: `${sentinel}_CODE`,
        category: "provider",
        retryable: false,
      });

      const error = await captureError(
        Promise.resolve().then(() => createGateway(model(providerError))),
      );

      expect(error).not.toBe(providerError);
      expect(error).toMatchObject({
        code: "AI_PROVIDER_FAILED",
        category: "provider",
        retryable: true,
        message: "The AI provider failed.",
      });
      expect(
        [String(error), JSON.stringify(error), error.stack ?? ""].join("\n"),
      ).not.toContain(sentinel);
    },
  );

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
    "promptly classifies $label while provider dispatch remains pending",
    async function ({ reason, expected }) {
      const controller = new AbortController();
      let rejectProviderWork;
      const providerWork = new Promise((_, reject) => {
        rejectProviderWork = reject;
      });
      const model = new MockLanguageModelV3({
        provider: "fixture",
        modelId: "fixture-model",
        doStream: async () => await providerWork,
      });
      const iterator = createGateway(model).stream(projectRequest(), {
        signal: controller.signal,
      });
      const onUnhandledRejection = vi.fn();
      process.on("unhandledRejection", onUnhandledRejection);

      try {
        expect(await iterator.next()).toMatchObject({
          done: false,
          value: { type: "started" },
        });
        const pending = iterator.next();
        await new Promise((resolve) => setImmediate(resolve));
        expect(model.doStreamCalls).toHaveLength(1);

        controller.abort(reason);

        expect(await captureErrorBeforeDeadline(pending)).toMatchObject(
          expected,
        );

        rejectProviderWork(new Error("LATE_PROVIDER_DISPATCH_PRIVATE"));
        await flushProviderPromiseObservation();
        await flushProviderPromiseObservation();
        expect(onUnhandledRejection).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", onUnhandledRejection);
      }
    },
  );

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
    "promptly classifies $label while downstream pipe work remains pending",
    async function ({ reason, expected }) {
      const controller = new AbortController();
      let observePipeStart;
      const pipeStarted = new Promise((resolve) => {
        observePipeStart = resolve;
      });
      let rejectPipeWork;
      const pipeWork = new Promise((_, reject) => {
        rejectPipeWork = reject;
      });
      let pipeAbortCount = 0;
      let pipeSignal;
      const providerStream = {
        pipeThrough() {
          return {
            pipeThrough() {
              return {
                pipeTo(_destination, options) {
                  pipeSignal = options?.signal;
                  pipeSignal?.addEventListener(
                    "abort",
                    () => {
                      pipeAbortCount += 1;
                    },
                    { once: true },
                  );
                  observePipeStart();
                  return pipeWork;
                },
              };
            },
          };
        },
      };
      const { model } = strictStreamModel([{ stream: providerStream }]);
      const iterator = createGateway(model).stream(projectRequest(), {
        signal: controller.signal,
      });
      const onUnhandledRejection = vi.fn();
      process.on("unhandledRejection", onUnhandledRejection);

      try {
        expect(await iterator.next()).toMatchObject({
          done: false,
          value: { type: "started" },
        });
        const pending = iterator.next();
        await pipeStarted;

        controller.abort(reason);

        expect(await captureErrorBeforeDeadline(pending)).toMatchObject(
          expected,
        );
        expect(pipeSignal).toBe(controller.signal);
        expect(pipeAbortCount).toBe(1);

        rejectPipeWork(new Error("LATE_PROVIDER_PIPE_PRIVATE"));
        await flushProviderPromiseObservation();
        await flushProviderPromiseObservation();
        expect(onUnhandledRejection).not.toHaveBeenCalled();
      } finally {
        process.off("unhandledRejection", onUnhandledRejection);
      }
    },
  );

  it("isolates concurrent request signals on one shared provider model", async function () {
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstReason = new DOMException(
      "CONCURRENT_FIRST_ABORT_PRIVATE",
      "AbortError",
    );
    const pendingBySignal = new Map();
    let observeBoth;
    const bothObserved = new Promise((resolve) => {
      observeBoth = resolve;
    });
    const observedSignals = [];
    const model = new MockLanguageModelV3({
      provider: "fixture",
      modelId: "fixture-model",
      doStream: async ({ abortSignal }) => {
        observedSignals.push(abortSignal);
        if (observedSignals.length === 2) {
          observeBoth();
        }
        return await new Promise((resolve, reject) => {
          pendingBySignal.set(abortSignal, { resolve, reject });
          abortSignal?.addEventListener(
            "abort",
            () => reject(abortSignal.reason),
            { once: true },
          );
        });
      },
    });
    const gateway = createGateway(model);
    const first = gateway.stream(projectRequest(), {
      signal: firstController.signal,
    });
    const second = gateway.stream(
      projectRequest({
        requestId: "request-sdk-hardening-0002",
      }),
      { signal: secondController.signal },
    );

    expect(await first.next()).toMatchObject({
      done: false,
      value: { type: "started" },
    });
    expect(await second.next()).toMatchObject({
      done: false,
      value: { type: "started" },
    });
    const firstError = captureError(first.next());
    const secondEvents = collect(second);
    await bothObserved;

    firstController.abort(firstReason);
    pendingBySignal
      .get(secondController.signal)
      .resolve(outputStep(validOutput()));

    expect(await firstError).toMatchObject({
      name: "AgentGatewayAbortError",
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    expect(await secondEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "completed",
          requestId: "request-sdk-hardening-0002",
        }),
      ]),
    );
    expect(observedSignals).toEqual([
      firstController.signal,
      secondController.signal,
    ]);
    expect(secondController.signal.aborted).toBe(false);
    expect(model.doStreamCalls).toHaveLength(2);
  });

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
    expect(Object.isFrozen(rejection)).toBe(true);
  });

  it("redacts a provider-owned error carried by an orphan tool result", async function () {
    const sentinel = "PROVIDER_TOOL_RESULT_PRIVATE";
    const providerError = new AgentGatewayError(sentinel, {
      code: `${sentinel}_CODE`,
      category: "provider",
      retryable: false,
    });
    const { model } = strictStreamModel([
      streamResult([
        {
          type: "tool-result",
          toolCallId: "orphan-provider-tool-result-0001",
          toolName: "read_project_file",
          result: providerError,
          isError: true,
        },
        finish("stop"),
      ]),
    ]);

    const error = await captureError(
      collect(createGateway(model).stream(projectRequest())),
    );

    expect(error).not.toBe(providerError);
    expect(error).toMatchObject({
      code: "AI_PROVIDER_FAILED",
      category: "provider",
      retryable: true,
      message: "The AI provider failed.",
    });
    expect(
      [String(error), JSON.stringify(error), error.stack ?? ""].join("\n"),
    ).not.toContain(sentinel);
  });

  it("redacts a provider-owned error thrown by a model getter", async function () {
    const sentinel = "PROVIDER_GETTER_PRIVATE";
    const providerError = new AgentGatewayError(sentinel, {
      code: `${sentinel}_CODE`,
      category: "provider",
      retryable: false,
    });
    const model = {
      specificationVersion: "v3",
      doStream: vi.fn(),
    };
    Object.defineProperty(model, "provider", {
      get() {
        throw providerError;
      },
    });

    const error = await captureError(
      collect(createGateway(model).stream(projectRequest())),
    );

    expect(error).not.toBe(providerError);
    expect(error).toMatchObject({
      code: "AI_PROVIDER_FAILED",
      category: "provider",
      retryable: true,
      message: "The AI provider failed.",
    });
    expect(
      [String(error), JSON.stringify(error), error.stack ?? ""].join("\n"),
    ).not.toContain(sentinel);
    expect(model.doStream).not.toHaveBeenCalled();
  });

  it("observes a rejected native Promise read from a provider model slot", async function () {
    const sentinel = "PROVIDER_MODEL_SLOT_PRIVATE";
    const rejected = Promise.reject(new Error(sentinel));
    const model = {
      specificationVersion: "v3",
      provider: rejected,
      modelId: "fixture-model",
      doStream: vi.fn(async () => {
        throw new Error("Synthetic bounded provider failure.");
      }),
    };

    const error = await captureError(
      collect(createGateway(model).stream(projectRequest())),
    );

    expect(error).toMatchObject({
      code: "AI_PROVIDER_FAILED",
      category: "provider",
      retryable: true,
    });
    expect(String(error)).not.toContain(sentinel);
    await flushProviderPromiseObservation();
  });

  it("does not read a provider function's own bind property", async function () {
    const sentinel = "PROVIDER_BIND_SLOT_PRIVATE";
    let bindReads = 0;
    const provider = function provider() {};
    Object.defineProperty(provider, "bind", {
      get() {
        bindReads += 1;
        return Promise.reject(new Error(sentinel));
      },
    });
    const model = {
      specificationVersion: "v3",
      provider,
      modelId: "fixture-model",
      doStream: vi.fn(async () => {
        throw new Error("Synthetic bounded provider failure.");
      }),
    };

    const error = await captureError(
      collect(createGateway(model).stream(projectRequest())),
    );
    await flushProviderPromiseObservation();

    expect(error).toMatchObject({
      code: "AI_PROVIDER_FAILED",
      category: "provider",
      retryable: true,
    });
    expect(bindReads).toBe(0);
    expect(String(error)).not.toContain(sentinel);
  });

  it("does not inspect provider function metadata while wrapping it", async function () {
    const sentinel = "PROVIDER_FUNCTION_METADATA_PRIVATE";
    let lengthReads = 0;
    const provider = new Proxy(function provider() {}, {
      get(target, property, receiver) {
        if (property === "length") {
          lengthReads += 1;
          return Promise.reject(new Error(sentinel));
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const model = {
      specificationVersion: "v3",
      provider,
      modelId: "fixture-model",
      doStream: vi.fn(async () => {
        throw new Error("Synthetic bounded provider failure.");
      }),
    };

    const error = await captureError(
      collect(createGateway(model).stream(projectRequest())),
    );
    await flushProviderPromiseObservation();

    expect(error).toMatchObject({
      code: "AI_PROVIDER_FAILED",
      category: "provider",
      retryable: true,
    });
    expect(lengthReads).toBe(0);
    expect(String(error)).not.toContain(sentinel);
  });

  it.each([
    {
      label: "stream",
      result(rejected) {
        return { stream: rejected };
      },
    },
    {
      label: "pipeThrough method",
      result(rejected) {
        return {
          stream: {
            pipeThrough: rejected,
          },
        };
      },
    },
    {
      label: "pipeThrough result",
      result(rejected) {
        return {
          stream: {
            pipeThrough() {
              return rejected;
            },
          },
        };
      },
    },
  ])(
    "observes a rejected native Promise read from the provider $label slot",
    async function ({ result }) {
      const sentinel = "PROVIDER_STREAM_SLOT_PRIVATE";
      const rejected = Promise.reject(new Error(sentinel));
      const { model } = strictStreamModel([result(rejected)]);

      const error = await captureError(
        collect(createGateway(model).stream(projectRequest())),
      );

      expect(error).toMatchObject({
        code: "AI_PROVIDER_FAILED",
        category: "provider",
        retryable: true,
      });
      expect(String(error)).not.toContain(sentinel);
      await flushProviderPromiseObservation();
    },
  );

  it("does not enumerate unrelated provider result fields", async function () {
    const sentinel = "PROVIDER_RESULT_ENUMERATION_PRIVATE";
    let privateReads = 0;
    let ownKeysCalls = 0;
    const resultTarget = outputStep(validOutput());
    Object.defineProperty(resultTarget, "privateRequest", {
      enumerable: true,
      get() {
        privateReads += 1;
        return Promise.reject(new Error(sentinel));
      },
    });
    const result = new Proxy(resultTarget, {
      ownKeys(target) {
        ownKeysCalls += 1;
        return Reflect.ownKeys(target);
      },
    });
    const { model } = strictStreamModel([result]);

    const events = await collect(createGateway(model).stream(projectRequest()));
    await flushProviderPromiseObservation();

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      finishReason: "stop",
    });
    expect(privateReads).toBe(0);
    expect(ownKeysCalls).toBe(0);
    expect(JSON.stringify(events)).not.toContain(sentinel);
  });

  it("does not enumerate unrelated provider stream-start fields", async function () {
    const sentinel = "PROVIDER_STREAM_START_ENUMERATION_PRIVATE";
    let privateReads = 0;
    const start = {
      type: "stream-start",
      warnings: [],
    };
    Object.defineProperty(start, "privateRequest", {
      enumerable: true,
      get() {
        privateReads += 1;
        return Promise.reject(new Error(sentinel));
      },
    });
    const { model } = strictStreamModel([
      streamResult([start, ...outputChunks(validOutput())]),
    ]);

    const events = await collect(createGateway(model).stream(projectRequest()));
    await flushProviderPromiseObservation();

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      finishReason: "stop",
    });
    expect(privateReads).toBe(0);
    expect(JSON.stringify(events)).not.toContain(sentinel);
  });

  it("observes rejected native Promise warnings before discarding them", async function () {
    const sentinel = "PROVIDER_WARNING_SLOT_PRIVATE";
    const rejected = Promise.reject(new Error(sentinel));
    const { model } = strictStreamModel([
      streamResult([
        {
          type: "stream-start",
          warnings: rejected,
        },
        ...outputChunks(validOutput()),
      ]),
    ]);

    const events = await collect(createGateway(model).stream(projectRequest()));
    await flushProviderPromiseObservation();

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      finishReason: "stop",
    });
    expect(JSON.stringify(events)).not.toContain(sentinel);
  });

  it("observes rejected native Promise warning entries before discarding them", async function () {
    const sentinel = "PROVIDER_WARNING_ENTRY_PRIVATE";
    const rejected = Promise.reject(new Error(sentinel));
    let warningEntryReads = 0;
    const warnings = [];
    Object.defineProperty(warnings, "0", {
      configurable: true,
      enumerable: true,
      get() {
        warningEntryReads += 1;
        return rejected;
      },
    });
    warnings.length = 1;
    const { model } = strictStreamModel([
      streamResult([
        {
          type: "stream-start",
          warnings,
        },
        ...outputChunks(validOutput()),
      ]),
    ]);

    const events = await collect(createGateway(model).stream(projectRequest()));
    await flushProviderPromiseObservation();

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      finishReason: "stop",
    });
    expect(warningEntryReads).toBe(1);
    expect(JSON.stringify(events)).not.toContain(sentinel);
  });

  it("accepts at most 512 discarded provider warning entries", async function () {
    const sentinel = "PROVIDER_WARNING_ACCEPTED_BOUND_PRIVATE";
    const rejected = Promise.reject(new Error(sentinel));
    let boundaryEntryReads = 0;
    const warnings = Array.from({ length: 512 }, () => ({
      type: "unsupported-setting",
      setting: "synthetic",
    }));
    Object.defineProperty(warnings, "511", {
      configurable: true,
      enumerable: true,
      get() {
        boundaryEntryReads += 1;
        return rejected;
      },
    });
    const { model } = strictStreamModel([
      streamResult([
        { type: "stream-start", warnings },
        ...outputChunks(validOutput()),
      ]),
    ]);

    const events = await collect(createGateway(model).stream(projectRequest()));
    await flushProviderPromiseObservation();

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      finishReason: "stop",
    });
    expect(boundaryEntryReads).toBe(1);
    expect(JSON.stringify(events)).not.toContain(sentinel);
  });

  it("rejects more than 512 discarded provider warning entries", async function () {
    const sentinel = "PROVIDER_WARNING_BOUND_PRIVATE";
    const rejected = Promise.reject(new Error(sentinel));
    const warnings = Array.from({ length: 513 }, () => ({
      type: "unsupported-setting",
      setting: "synthetic",
    }));
    warnings[512] = rejected;
    const { model } = strictStreamModel([
      streamResult([
        { type: "stream-start", warnings },
        ...outputChunks(validOutput()),
      ]),
    ]);

    const error = await captureError(
      collect(createGateway(model).stream(projectRequest())),
    );
    await flushProviderPromiseObservation();

    expect(error).toMatchObject({
      code: "AI_PROVIDER_FAILED",
      category: "provider",
      retryable: true,
    });
    expect(String(error)).not.toContain(sentinel);
  });

  it("observes a rejected native Promise in a provider text delta", async function () {
    const sentinel = "PROVIDER_TEXT_DELTA_PRIVATE";
    const rejected = Promise.reject(new Error(sentinel));
    const { model } = strictStreamModel([
      streamResult([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "text-hardening-0001" },
        {
          type: "text-delta",
          id: "text-hardening-0001",
          delta: rejected,
        },
      ]),
    ]);

    const error = await captureError(
      collect(createGateway(model).stream(projectRequest())),
    );

    expect(error).toMatchObject({
      code: "AI_PROVIDER_FAILED",
      category: "provider",
      retryable: true,
    });
    expect(String(error)).not.toContain(sentinel);
    await flushProviderPromiseObservation();
  });

  it("observes provider metadata before dropping it from a text delta", async function () {
    const sentinel = "PROVIDER_TEXT_METADATA_PRIVATE";
    const rejected = Promise.reject(new Error(sentinel));
    let metadataReads = 0;
    const delta = {
      type: "text-delta",
      id: "text-hardening-0001",
      delta: JSON.stringify(validOutput()),
    };
    Object.defineProperty(delta, "providerMetadata", {
      get() {
        metadataReads += 1;
        return rejected;
      },
    });
    const { model } = strictStreamModel([
      streamResult([
        { type: "text-start", id: "text-hardening-0001" },
        delta,
        { type: "text-end", id: "text-hardening-0001" },
        finish("stop"),
      ]),
    ]);

    const events = await collect(createGateway(model).stream(projectRequest()));
    await flushProviderPromiseObservation();

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      finishReason: "stop",
    });
    expect(metadataReads).toBe(1);
    expect(JSON.stringify(events)).not.toContain(sentinel);
  });

  it("stops text-delta inspection when the delta getter aborts", async function () {
    const controller = new AbortController();
    const reason = new DOMException(
      "PROVIDER_TEXT_DELTA_ABORT_PRIVATE",
      "AbortError",
    );
    let idReads = 0;
    let metadataReads = 0;
    const delta = { type: "text-delta" };
    Object.defineProperties(delta, {
      delta: {
        get() {
          controller.abort(reason);
          return "forbidden";
        },
      },
      id: {
        get() {
          idReads += 1;
          return "text-hardening-0001";
        },
      },
      providerMetadata: {
        get() {
          metadataReads += 1;
          return {};
        },
      },
    });
    const { model } = strictStreamModel([streamResult([delta])]);

    const error = await captureError(
      collect(
        createGateway(model).stream(projectRequest(), {
          signal: controller.signal,
        }),
      ),
    );

    expect(error).toMatchObject({
      name: "AgentGatewayAbortError",
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    expect(idReads).toBe(0);
    expect(metadataReads).toBe(0);
    expect(String(error)).not.toContain("PROVIDER_TEXT_DELTA_ABORT_PRIVATE");
  });

  it("stops stream-start inspection when the type getter aborts", async function () {
    const controller = new AbortController();
    const reason = new DOMException(
      "PROVIDER_STREAM_TYPE_ABORT_PRIVATE",
      "AbortError",
    );
    let warningReads = 0;
    const start = {};
    Object.defineProperties(start, {
      type: {
        get() {
          controller.abort(reason);
          return "stream-start";
        },
      },
      warnings: {
        get() {
          warningReads += 1;
          return [];
        },
      },
    });
    const { model } = strictStreamModel([streamResult([start])]);

    const error = await captureError(
      collect(
        createGateway(model).stream(projectRequest(), {
          signal: controller.signal,
        }),
      ),
    );

    expect(error).toMatchObject({
      name: "AgentGatewayAbortError",
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    expect(warningReads).toBe(0);
    expect(String(error)).not.toContain("PROVIDER_STREAM_TYPE_ABORT_PRIVATE");
  });

  it.each([
    {
      label: "result stream getter",
      result(controller, nextProviderReads, baseStream) {
        const stream = {};
        Object.defineProperty(stream, "pipeThrough", {
          get() {
            nextProviderReads.count += 1;
            return baseStream.pipeThrough.bind(baseStream);
          },
        });
        const result = {};
        Object.defineProperty(result, "stream", {
          get() {
            controller.abort(
              new DOMException(
                "PROVIDER_RESULT_STREAM_ABORT_PRIVATE",
                "AbortError",
              ),
            );
            return stream;
          },
        });
        return result;
      },
    },
    {
      label: "pipeThrough getter",
      result(controller, nextProviderReads, baseStream) {
        return {
          stream: {
            get pipeThrough() {
              controller.abort(
                new DOMException(
                  "PROVIDER_PIPE_GETTER_ABORT_PRIVATE",
                  "AbortError",
                ),
              );
              return () => {
                nextProviderReads.count += 1;
                return baseStream;
              };
            },
          },
        };
      },
    },
    {
      label: "pipeThrough call",
      result(controller, nextProviderReads, baseStream) {
        const filteredStream = {};
        Object.defineProperty(filteredStream, "pipeThrough", {
          get() {
            nextProviderReads.count += 1;
            return baseStream.pipeThrough.bind(baseStream);
          },
        });
        return {
          stream: {
            pipeThrough() {
              controller.abort(
                new DOMException(
                  "PROVIDER_PIPE_CALL_ABORT_PRIVATE",
                  "AbortError",
                ),
              );
              return filteredStream;
            },
          },
        };
      },
    },
  ])(
    "stops provider inspection after abort in the $label",
    async function ({ result }) {
      const controller = new AbortController();
      const nextProviderReads = { count: 0 };
      const baseStream = streamResult(outputChunks(validOutput())).stream;
      const { model } = strictStreamModel([
        result(controller, nextProviderReads, baseStream),
      ]);

      const error = await captureError(
        collect(
          createGateway(model).stream(projectRequest(), {
            signal: controller.signal,
          }),
        ),
      );

      expect(error).toMatchObject({
        name: "AgentGatewayAbortError",
        code: "AI_REQUEST_ABORTED",
        category: "aborted",
        retryable: false,
      });
      expect(nextProviderReads.count).toBe(0);
      expect(String(error)).not.toContain("PROVIDER_");
    },
  );

  it("observes a rejected native Promise used as a provider stream chunk", async function () {
    const sentinel = "PROVIDER_STREAM_CHUNK_PRIVATE";
    const rejected = Promise.reject(new Error(sentinel));
    const { model } = strictStreamModel([streamResult([rejected])]);

    const error = await captureError(
      collect(createGateway(model).stream(projectRequest())),
    );

    expect(error).toMatchObject({
      code: "AI_PROVIDER_FAILED",
      category: "provider",
      retryable: true,
    });
    expect(String(error)).not.toContain(sentinel);
    await flushProviderPromiseObservation();
  });

  it("observes and drops optional provider request and response result slots", async function () {
    const requestSentinel = "PROVIDER_RESULT_REQUEST_PRIVATE";
    const responseSentinel = "PROVIDER_RESULT_RESPONSE_PRIVATE";
    const result = streamResult(outputChunks(validOutput()));
    const rejectedRequest = Promise.reject(new Error(requestSentinel));
    const rejectedResponse = Promise.reject(new Error(responseSentinel));
    let requestReads = 0;
    let responseReads = 0;
    Object.defineProperties(result, {
      request: {
        get() {
          requestReads += 1;
          return rejectedRequest;
        },
      },
      response: {
        get() {
          responseReads += 1;
          return rejectedResponse;
        },
      },
    });
    const { model } = strictStreamModel([result]);

    const events = await collect(createGateway(model).stream(projectRequest()));

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      finishReason: "stop",
    });
    expect(requestReads).toBe(1);
    expect(responseReads).toBe(1);
    expect(JSON.stringify(events)).not.toContain(requestSentinel);
    expect(JSON.stringify(events)).not.toContain(responseSentinel);
    await flushProviderPromiseObservation();
  });

  it.each([
    {
      label: "request body",
      parent: "request",
      property: "body",
    },
    {
      label: "response headers",
      parent: "response",
      property: "headers",
    },
  ])(
    "observes and drops the provider $label without enumerating siblings",
    async function ({ parent, property }) {
      const sentinel = "PROVIDER_RESULT_NESTED_SLOT_PRIVATE";
      const rejected = Promise.reject(new Error(sentinel));
      const nestedTarget = {};
      let knownReads = 0;
      let privateReads = 0;
      let ownKeysCalls = 0;
      Object.defineProperties(nestedTarget, {
        [property]: {
          get() {
            knownReads += 1;
            return rejected;
          },
        },
        privateRequest: {
          enumerable: true,
          get() {
            privateReads += 1;
            return Promise.reject(new Error("PROVIDER_RESULT_NESTED_PRIVATE"));
          },
        },
      });
      const nested = new Proxy(nestedTarget, {
        ownKeys(target) {
          ownKeysCalls += 1;
          return Reflect.ownKeys(target);
        },
      });
      const result = streamResult(outputChunks(validOutput()));
      Object.defineProperty(result, parent, {
        get() {
          return nested;
        },
      });
      const { model } = strictStreamModel([result]);

      const events = await collect(
        createGateway(model).stream(projectRequest()),
      );
      await flushProviderPromiseObservation();

      expect(events.at(-1)).toMatchObject({
        type: "completed",
        finishReason: "stop",
      });
      expect(knownReads).toBe(1);
      expect(privateReads).toBe(0);
      expect(ownKeysCalls).toBe(0);
      expect(JSON.stringify(events)).not.toContain(sentinel);
    },
  );

  it("bridges provider pipe work without reading its hostile own then slot", async function () {
    const sentinel = "PROVIDER_PIPE_WORK_THEN_PRIVATE";
    let ownThenReads = 0;
    const baseStream = streamResult(outputChunks(validOutput())).stream;
    const providerStream = {
      pipeThrough(providerTransform) {
        const filtered = baseStream.pipeThrough(providerTransform);
        return {
          pipeThrough(sdkTransform) {
            const piped = filtered.pipeThrough(sdkTransform);
            return {
              pipeTo(destination) {
                const work = piped.pipeTo(destination);
                Object.defineProperty(work, "then", {
                  configurable: true,
                  get() {
                    ownThenReads += 1;
                    throw new Error(sentinel);
                  },
                });
                return work;
              },
            };
          },
        };
      },
    };
    const { model } = strictStreamModel([{ stream: providerStream }]);

    const events = await collect(createGateway(model).stream(projectRequest()));

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      finishReason: "stop",
    });
    expect(ownThenReads).toBe(0);
    expect(JSON.stringify(events)).not.toContain(sentinel);
  });

  it("discards a provider pipe fulfillment value without thenable assimilation", async function () {
    const sentinel = "PROVIDER_PIPE_FULFILLMENT_THEN_PRIVATE";
    let ownThenReads = 0;
    const fulfillment = {};
    const providerWork = Promise.resolve(fulfillment);
    Object.defineProperty(fulfillment, "then", {
      get() {
        ownThenReads += 1;
        throw new Error(sentinel);
      },
    });
    const baseStream = streamResult(outputChunks(validOutput())).stream;
    const providerStream = {
      pipeThrough(providerTransform) {
        const filtered = baseStream.pipeThrough(providerTransform);
        return {
          pipeThrough(sdkTransform) {
            const piped = filtered.pipeThrough(sdkTransform);
            return {
              pipeTo(destination) {
                const pipeWork = piped.pipeTo(destination);
                void Reflect.apply(Promise.prototype.then, pipeWork, [
                  () => {},
                  () => {},
                ]);
                return providerWork;
              },
            };
          },
        };
      },
    };
    const { model } = strictStreamModel([{ stream: providerStream }]);

    const events = await collect(createGateway(model).stream(projectRequest()));

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      finishReason: "stop",
    });
    expect(ownThenReads).toBe(0);
    expect(JSON.stringify(events)).not.toContain(sentinel);
  });

  it("accepts a sanitized reasoning lifecycle without exposing its text", async function () {
    const sentinel = "PROVIDER_REASONING_PRIVATE";
    const metadataSentinel = "PROVIDER_REASONING_METADATA_PRIVATE";
    const rejectedMetadata = Promise.reject(new Error(metadataSentinel));
    let metadataReads = 0;
    const reasoningDelta = {
      type: "reasoning-delta",
      id: "reasoning-hardening-0001",
      delta: sentinel,
    };
    Object.defineProperty(reasoningDelta, "providerMetadata", {
      get() {
        metadataReads += 1;
        return rejectedMetadata;
      },
    });
    const { model } = strictStreamModel([
      streamResult([
        { type: "reasoning-start", id: "reasoning-hardening-0001" },
        reasoningDelta,
        { type: "reasoning-end", id: "reasoning-hardening-0001" },
        ...outputChunks(validOutput()),
      ]),
    ]);

    const events = await collect(createGateway(model).stream(projectRequest()));

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      finishReason: "stop",
    });
    expect(metadataReads).toBe(1);
    expect(JSON.stringify(events)).not.toContain(sentinel);
    expect(JSON.stringify(events)).not.toContain(metadataSentinel);
    await flushProviderPromiseObservation();
  });

  it.each([
    {
      label: "text end",
      chunks: [
        { type: "text-start", id: "text-hardening-0001" },
        {
          type: "text-delta",
          id: "text-hardening-0001",
          delta: JSON.stringify(validOutput()),
        },
        finish("stop"),
      ],
    },
    {
      label: "reasoning end",
      chunks: [
        { type: "reasoning-start", id: "reasoning-hardening-0001" },
        {
          type: "reasoning-delta",
          id: "reasoning-hardening-0001",
          delta: "Synthetic hidden reasoning.",
        },
        ...outputChunks(validOutput()),
      ],
    },
    {
      label: "unique reasoning start",
      chunks: [
        { type: "reasoning-start", id: "reasoning-hardening-0001" },
        { type: "reasoning-start", id: "reasoning-hardening-0001" },
        {
          type: "reasoning-delta",
          id: "reasoning-hardening-0001",
          delta: "Synthetic hidden reasoning.",
        },
        { type: "reasoning-end", id: "reasoning-hardening-0001" },
        ...outputChunks(validOutput()),
      ],
    },
  ])(
    "rejects a stream without a valid $label lifecycle",
    async function ({ chunks }) {
      const { model } = strictStreamModel([streamResult(chunks)]);

      expect(
        await captureError(
          collect(createGateway(model).stream(projectRequest())),
        ),
      ).toMatchObject({
        code: "AI_PROVIDER_FAILED",
        category: "provider",
        retryable: true,
      });
    },
  );

  it("bounds cumulative provider text before SDK accumulation", async function () {
    const sentinel = "X".repeat(60_000);
    const { model } = strictStreamModel([
      streamResult([
        { type: "text-start", id: "text-hardening-0001" },
        {
          type: "text-delta",
          id: "text-hardening-0001",
          delta: sentinel,
        },
        {
          type: "text-delta",
          id: "text-hardening-0001",
          delta: sentinel,
        },
        { type: "text-end", id: "text-hardening-0001" },
        finish("stop"),
      ]),
    ]);

    const error = await captureError(
      collect(createGateway(model).stream(projectRequest())),
    );

    expect(error).toMatchObject({
      code: "AI_PROVIDER_FAILED",
      category: "provider",
      retryable: true,
    });
  });

  it("does not send a generation token cap to the provider", async function () {
    const { model } = strictStreamModel([outputStep(validOutput())]);

    await collect(createGateway(model).stream(projectRequest()));

    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0].maxOutputTokens).toBeUndefined();
  });

  it("derives a smaller prompt budget from a smaller context length", async function () {
    const text = "x".repeat(2_000);
    const boundedRequest = selectionRequest({
      scope: {
        kind: "selection",
        documentId: "document-sdk-context-budget",
        path: "main.tex",
        baseRevision: 1,
        baseTextHash: contentHash,
        range: { from: 0, to: text.length },
        text,
      },
    });
    const { model: smallModel } = strictStreamModel([
      outputStep(validOutput()),
    ]);
    const { model: largeModel } = strictStreamModel([
      outputStep(validOutput()),
    ]);

    expect(
      await captureError(
        collect(
          createGateway(smallModel, { contextLength: 4_096 }).stream(
            boundedRequest,
          ),
        ),
      ),
    ).toMatchObject({
      code: "AI_PROJECT_CONTENT_NOT_AVAILABLE",
      category: "configuration",
      retryable: false,
    });
    expect(smallModel.doStreamCalls).toHaveLength(0);

    const events = await collect(
      createGateway(largeModel, { contextLength: 8_192 }).stream(
        boundedRequest,
      ),
    );
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      finishReason: "stop",
    });
    expect(largeModel.doStreamCalls).toHaveLength(1);
  });

  it.each([
    {
      label: "duplicate text start",
      chunks: [
        { type: "text-start", id: "text-hardening-0001" },
        { type: "text-start", id: "text-hardening-0001" },
        {
          type: "text-delta",
          id: "text-hardening-0001",
          delta: JSON.stringify(validOutput()),
        },
        { type: "text-end", id: "text-hardening-0001" },
        finish("stop"),
      ],
    },
    {
      label: "orphan text delta",
      chunks: [
        {
          type: "text-delta",
          id: "text-hardening-0001",
          delta: JSON.stringify(validOutput()),
        },
        finish("stop"),
      ],
    },
    {
      label: "mismatched text end",
      chunks: [
        { type: "text-start", id: "text-hardening-0001" },
        {
          type: "text-delta",
          id: "text-hardening-0001",
          delta: JSON.stringify(validOutput()),
        },
        { type: "text-end", id: "text-hardening-0002" },
        finish("stop"),
      ],
    },
    {
      label: "mismatched reasoning end",
      chunks: [
        { type: "reasoning-start", id: "reasoning-hardening-0001" },
        {
          type: "reasoning-delta",
          id: "reasoning-hardening-0001",
          delta: "Synthetic hidden reasoning.",
        },
        { type: "reasoning-end", id: "reasoning-hardening-0002" },
        ...outputChunks(validOutput()),
      ],
    },
    {
      label: "orphan tool input delta",
      chunks: [
        {
          type: "tool-input-delta",
          id: "tool-input-hardening-0001",
          delta: "{}",
        },
        ...outputChunks(validOutput()),
      ],
    },
    {
      label: "duplicate tool input start",
      chunks: [
        {
          type: "tool-input-start",
          id: "tool-input-hardening-0001",
          toolName: "read_project_file",
        },
        {
          type: "tool-input-start",
          id: "tool-input-hardening-0001",
          toolName: "read_project_file",
        },
        {
          type: "tool-input-end",
          id: "tool-input-hardening-0001",
        },
        ...outputChunks(validOutput()),
      ],
    },
    {
      label: "mismatched tool input end",
      chunks: [
        {
          type: "tool-input-start",
          id: "tool-input-hardening-0001",
          toolName: "read_project_file",
        },
        {
          type: "tool-input-delta",
          id: "tool-input-hardening-0001",
          delta: "{}",
        },
        {
          type: "tool-input-end",
          id: "tool-input-hardening-0002",
        },
        ...outputChunks(validOutput()),
      ],
    },
    {
      label: "missing tool input end",
      chunks: [
        {
          type: "tool-input-start",
          id: "tool-input-hardening-0001",
          toolName: "read_project_file",
        },
        {
          type: "tool-input-delta",
          id: "tool-input-hardening-0001",
          delta: "{}",
        },
        ...outputChunks(validOutput()),
      ],
    },
    {
      label: "duplicate finish",
      chunks: [...outputChunks(validOutput()), finish("stop")],
    },
    {
      label: "post-finish content",
      chunks: [
        ...outputChunks(validOutput()),
        { type: "reasoning-start", id: "reasoning-hardening-0001" },
      ],
    },
    {
      label: "missing finish",
      chunks: [
        { type: "text-start", id: "text-hardening-0001" },
        {
          type: "text-delta",
          id: "text-hardening-0001",
          delta: JSON.stringify(validOutput()),
        },
        { type: "text-end", id: "text-hardening-0001" },
      ],
    },
  ])("rejects a provider stream with $label", async function ({ chunks }) {
    const { model } = strictStreamModel([streamResult(chunks)]);

    expect(
      await captureError(
        collect(createGateway(model).stream(projectRequest())),
      ),
    ).toMatchObject({
      code: "AI_PROVIDER_FAILED",
      category: "provider",
      retryable: true,
    });
  });

  it.each([
    {
      label: "reasoning",
      chunks: [
        {
          type: "reasoning-start",
          id: "reasoning-hardening-0001",
        },
        {
          type: "reasoning-delta",
          id: "reasoning-hardening-0001",
          delta: "X".repeat(60_000),
        },
        {
          type: "reasoning-delta",
          id: "reasoning-hardening-0001",
          delta: "X".repeat(60_000),
        },
        {
          type: "reasoning-end",
          id: "reasoning-hardening-0001",
        },
        ...outputChunks(validOutput()),
      ],
    },
    {
      label: "tool input",
      chunks: [
        {
          type: "tool-input-start",
          id: "tool-input-hardening-0001",
          toolName: "read_project_file",
        },
        {
          type: "tool-input-delta",
          id: "tool-input-hardening-0001",
          delta: "X".repeat(60_000),
        },
        {
          type: "tool-input-delta",
          id: "tool-input-hardening-0001",
          delta: "X".repeat(60_000),
        },
        {
          type: "tool-input-end",
          id: "tool-input-hardening-0001",
        },
        ...outputChunks(validOutput()),
      ],
    },
  ])(
    "bounds cumulative provider $label characters before SDK accumulation",
    async function ({ chunks }) {
      const { model } = strictStreamModel([streamResult(chunks)]);

      expect(
        await captureError(
          collect(createGateway(model).stream(projectRequest())),
        ),
      ).toMatchObject({
        code: "AI_PROVIDER_FAILED",
        category: "provider",
        retryable: true,
      });
    },
  );

  it("accepts at most 100 provider stream blocks", async function () {
    const reasoningBlocks = Array.from({ length: 99 }, (_, index) => {
      const id = `reasoning-${String(index).padStart(3, "0")}`;
      return [
        { type: "reasoning-start", id },
        { type: "reasoning-end", id },
      ];
    }).flat();
    const { model } = strictStreamModel([
      streamResult([...reasoningBlocks, ...outputChunks(validOutput())]),
    ]);

    const events = await collect(createGateway(model).stream(projectRequest()));

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      finishReason: "stop",
    });
  });

  it("accepts exactly 100,000 cumulative provider stream characters", async function () {
    const output = validOutput();
    const outputText = JSON.stringify(output);
    const reasoningText = "X".repeat(100_000 - outputText.length);
    const { model } = strictStreamModel([
      streamResult([
        {
          type: "reasoning-start",
          id: "reasoning-hardening-0001",
        },
        {
          type: "reasoning-delta",
          id: "reasoning-hardening-0001",
          delta: reasoningText,
        },
        {
          type: "reasoning-end",
          id: "reasoning-hardening-0001",
        },
        ...outputChunks(output),
      ]),
    ]);

    const events = await collect(createGateway(model).stream(projectRequest()));

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      finishReason: "stop",
    });
  });

  it("rejects more than 100 provider stream blocks", async function () {
    const reasoningBlocks = Array.from({ length: 100 }, (_, index) => {
      const id = `reasoning-${String(index).padStart(3, "0")}`;
      return [
        { type: "reasoning-start", id },
        { type: "reasoning-end", id },
      ];
    }).flat();
    const { model } = strictStreamModel([
      streamResult([...reasoningBlocks, ...outputChunks(validOutput())]),
    ]);

    expect(
      await captureError(
        collect(createGateway(model).stream(projectRequest())),
      ),
    ).toMatchObject({
      code: "AI_PROVIDER_FAILED",
      category: "provider",
      retryable: true,
    });
  });

  it.each([
    { label: "empty", id: "" },
    { label: "257-character", id: "i".repeat(257) },
  ])("rejects a $label provider stream block id", async function ({ id }) {
    const { model } = strictStreamModel([
      streamResult([
        { type: "reasoning-start", id },
        { type: "reasoning-end", id },
        ...outputChunks(validOutput()),
      ]),
    ]);

    expect(
      await captureError(
        collect(createGateway(model).stream(projectRequest())),
      ),
    ).toMatchObject({
      code: "AI_PROVIDER_FAILED",
      category: "provider",
      retryable: true,
    });
  });

  it("accepts a 256-character provider stream block id", async function () {
    const id = "i".repeat(256);
    const { model } = strictStreamModel([
      streamResult([
        { type: "reasoning-start", id },
        { type: "reasoning-end", id },
        ...outputChunks(validOutput()),
      ]),
    ]);

    const events = await collect(createGateway(model).stream(projectRequest()));

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      finishReason: "stop",
    });
  });

  it("accepts large reported output token usage", async function () {
    const { model } = strictStreamModel([
      streamResult(
        outputChunks(validOutput())
          .slice(0, -1)
          .concat(finish("stop", usage(3, 513))),
      ),
    ]);

    const events = await collect(createGateway(model).stream(projectRequest()));

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      finishReason: "stop",
      usage: {
        inputTokens: 3,
        outputTokens: 513,
      },
    });
  });

  it("accepts reported output usage at the previous ceiling", async function () {
    const { model } = strictStreamModel([
      streamResult(
        outputChunks(validOutput())
          .slice(0, -1)
          .concat(finish("stop", usage(3, 512))),
      ),
    ]);

    const events = await collect(createGateway(model).stream(projectRequest()));

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      finishReason: "stop",
      usage: {
        inputTokens: 3,
        outputTokens: 512,
      },
    });
  });

  it("rejects an orphan reasoning delta as a bounded provider failure", async function () {
    const sentinel = "PROVIDER_ORPHAN_REASONING_PRIVATE";
    const { model } = strictStreamModel([
      streamResult([
        {
          type: "reasoning-delta",
          id: "reasoning-hardening-0001",
          delta: sentinel,
        },
        ...outputChunks(validOutput()),
      ]),
    ]);

    const error = await captureError(
      collect(createGateway(model).stream(projectRequest())),
    );

    expect(error).toMatchObject({
      code: "AI_PROVIDER_FAILED",
      category: "provider",
      retryable: true,
    });
    expect(String(error)).not.toContain(sentinel);
  });

  it("rechecks cancellation when the generator resumes after a text event", async function () {
    const controller = new AbortController();
    const reason = new DOMException(
      "PROVIDER_POST_YIELD_ABORT_PRIVATE",
      "AbortError",
    );
    const { model } = strictStreamModel([
      outputStep(
        validOutput({
          narrative: "Synthetic visible review.",
          suggestions: [validSuggestion()],
        }),
      ),
    ]);
    const iterator = createGateway(model).stream(projectRequest(), {
      signal: controller.signal,
    });

    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { type: "started" },
    });
    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { type: "text.delta" },
    });

    controller.abort(reason);
    const error = await captureError(iterator.next());

    expect(error).toMatchObject({
      name: "AgentGatewayAbortError",
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    expect(String(error)).not.toContain("PROVIDER_POST_YIELD_ABORT_PRIVATE");
  });

  it("rechecks cancellation when the generator resumes after started", async function () {
    const controller = new AbortController();
    const reason = new DOMException(
      "PROVIDER_STARTED_YIELD_ABORT_PRIVATE",
      "AbortError",
    );
    const { model: baseModel } = strictStreamModel([outputStep(validOutput())]);
    let specificationVersionReads = 0;
    const model = new Proxy(baseModel, {
      get(target, property, receiver) {
        if (property === "specificationVersion") {
          specificationVersionReads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const iterator = createGateway(model).stream(projectRequest(), {
      signal: controller.signal,
    });

    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { type: "started" },
    });
    controller.abort(reason);
    const error = await captureError(iterator.next());

    expect(error).toMatchObject({
      name: "AgentGatewayAbortError",
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    expect(specificationVersionReads).toBe(0);
    expect(baseModel.doStreamCalls).toHaveLength(0);
    expect(String(error)).not.toContain("PROVIDER_STARTED_YIELD_ABORT_PRIVATE");
  });

  it("rechecks global telemetry when the generator resumes after started", async function () {
    const requestValue = projectRequest({
      instruction: "AI_REVIEWER_POST_YIELD_TELEMETRY_PRIVATE",
    });
    const { model } = strictStreamModel([outputStep(validOutput())]);
    const iterator = createGateway(model).stream(requestValue);
    const previous = Reflect.get(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS");
    const onStart = vi.fn();

    try {
      expect(await iterator.next()).toMatchObject({
        done: false,
        value: { type: "started" },
      });
      Reflect.set(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS", [{ onStart }]);

      const error = await captureError(iterator.next());

      expect(error).toMatchObject({
        code: "AI_SDK_TELEMETRY_UNSAFE",
        category: "configuration",
        retryable: false,
      });
      expect(onStart).not.toHaveBeenCalled();
      expect(model.doStreamCalls).toHaveLength(0);
      expect(String(error)).not.toContain(
        "AI_REVIEWER_POST_YIELD_TELEMETRY_PRIVATE",
      );
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS");
      } else {
        Reflect.set(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS", previous);
      }
    }
  });

  it("rechecks telemetry after capturing every provider model slot", async function () {
    const sentinel = "PROVIDER_MODEL_TELEMETRY_PRIVATE";
    const onStart = vi.fn();
    const { model: baseModel } = strictStreamModel([outputStep(validOutput())]);
    let providerReads = 0;
    const model = new Proxy(baseModel, {
      get(target, property, receiver) {
        if (property === "provider") {
          providerReads += 1;
          Reflect.set(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS", [
            { onStart },
          ]);
          return sentinel;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const gateway = createGateway(model);
    const iterator = gateway.stream(projectRequest());
    const previous = Object.getOwnPropertyDescriptor(
      globalThis,
      "AI_SDK_TELEMETRY_INTEGRATIONS",
    );

    try {
      Reflect.deleteProperty(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS");
      expect(await iterator.next()).toMatchObject({
        done: false,
        value: { type: "started" },
      });

      const error = await captureError(iterator.next());

      expect(error).toMatchObject({
        code: "AI_SDK_TELEMETRY_UNSAFE",
        category: "configuration",
        retryable: false,
      });
      expect(providerReads).toBe(1);
      expect(onStart).not.toHaveBeenCalled();
      expect(baseModel.doStreamCalls).toHaveLength(0);
      expect(String(error)).not.toContain(sentinel);
    } finally {
      if (previous == null) {
        Reflect.deleteProperty(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS");
      } else {
        Object.defineProperty(
          globalThis,
          "AI_SDK_TELEMETRY_INTEGRATIONS",
          previous,
        );
      }
    }
  });

  it("gives the SDK a plain snapshot instead of re-reading provider model getters", async function () {
    const { model: baseModel } = strictStreamModel([outputStep(validOutput())]);
    const properties = [
      "specificationVersion",
      "provider",
      "modelId",
      "supportedUrls",
      "doGenerate",
    ];
    const reads = Object.fromEntries(
      properties.map((property) => [property, 0]),
    );
    const model = new Proxy(baseModel, {
      get(target, property, receiver) {
        if (Object.hasOwn(reads, property)) {
          reads[property] += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const gateway = createGateway(model);
    for (const property of properties) {
      reads[property] = 0;
    }

    const events = await collect(gateway.stream(projectRequest()));

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      finishReason: "stop",
    });
    expect(reads).toEqual({
      specificationVersion: 1,
      provider: 1,
      modelId: 1,
      supportedUrls: 1,
      doGenerate: 1,
    });
    expect(baseModel.doStreamCalls).toHaveLength(1);
  });

  it("fails closed on an accessor-backed global telemetry registry", async function () {
    const sentinel = "GLOBAL_TELEMETRY_GETTER_PRIVATE";
    const { model } = strictStreamModel([outputStep(validOutput())]);
    const previous = Object.getOwnPropertyDescriptor(
      globalThis,
      "AI_SDK_TELEMETRY_INTEGRATIONS",
    );
    let getterReads = 0;

    try {
      Object.defineProperty(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS", {
        configurable: true,
        get() {
          getterReads += 1;
          throw new Error(sentinel);
        },
      });

      const error = await captureError(
        collect(createGateway(model).stream(projectRequest())),
      );

      expect(error).toMatchObject({
        code: "AI_SDK_TELEMETRY_UNSAFE",
        category: "configuration",
        retryable: false,
      });
      expect(getterReads).toBe(0);
      expect(model.doStreamCalls).toHaveLength(0);
      expect(String(error)).not.toContain(sentinel);
    } finally {
      if (previous == null) {
        Reflect.deleteProperty(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS");
      } else {
        Object.defineProperty(
          globalThis,
          "AI_SDK_TELEMETRY_INTEGRATIONS",
          previous,
        );
      }
    }
  });

  it("fails closed on an empty global telemetry registry", async function () {
    const { model } = strictStreamModel([outputStep(validOutput())]);
    const previous = Object.getOwnPropertyDescriptor(
      globalThis,
      "AI_SDK_TELEMETRY_INTEGRATIONS",
    );

    try {
      Object.defineProperty(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS", {
        configurable: true,
        writable: true,
        value: [],
      });

      const error = await captureError(
        collect(createGateway(model).stream(projectRequest())),
      );

      expect(error).toMatchObject({
        code: "AI_SDK_TELEMETRY_UNSAFE",
        category: "configuration",
        retryable: false,
      });
      expect(model.doStreamCalls).toHaveLength(0);
    } finally {
      if (previous == null) {
        Reflect.deleteProperty(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS");
      } else {
        Object.defineProperty(
          globalThis,
          "AI_SDK_TELEMETRY_INTEGRATIONS",
          previous,
        );
      }
    }
  });

  it.each([
    { label: "zero number", integrations: 0 },
    { label: "false boolean", integrations: false },
    { label: "empty string", integrations: "" },
    { label: "plain object", integrations: {} },
    {
      label: "function",
      integrations: function telemetryIntegration() {},
    },
    {
      label: "symbol",
      integrations: Symbol("synthetic-telemetry-integration"),
    },
    { label: "bigint", integrations: 0n },
  ])(
    "fails closed on a non-null $label global telemetry registry",
    async function ({ integrations }) {
      const { model } = strictStreamModel([outputStep(validOutput())]);
      const previous = Object.getOwnPropertyDescriptor(
        globalThis,
        "AI_SDK_TELEMETRY_INTEGRATIONS",
      );

      try {
        Object.defineProperty(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS", {
          configurable: true,
          writable: true,
          value: integrations,
        });

        const error = await captureError(
          collect(createGateway(model).stream(projectRequest())),
        );

        expect(error).toMatchObject({
          code: "AI_SDK_TELEMETRY_UNSAFE",
          category: "configuration",
          retryable: false,
        });
        expect(model.doStreamCalls).toHaveLength(0);
      } finally {
        if (previous == null) {
          Reflect.deleteProperty(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS");
        } else {
          Object.defineProperty(
            globalThis,
            "AI_SDK_TELEMETRY_INTEGRATIONS",
            previous,
          );
        }
      }
    },
  );

  it.each([
    { label: "null", integrations: null },
    { label: "undefined", integrations: undefined },
  ])(
    "accepts an explicitly $label global telemetry registry",
    async function ({ integrations }) {
      const { model } = strictStreamModel([outputStep(validOutput())]);
      const previous = Object.getOwnPropertyDescriptor(
        globalThis,
        "AI_SDK_TELEMETRY_INTEGRATIONS",
      );

      try {
        Object.defineProperty(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS", {
          configurable: true,
          writable: true,
          value: integrations,
        });

        const events = await collect(
          createGateway(model).stream(projectRequest()),
        );

        expect(events.at(-1)).toMatchObject({
          type: "completed",
          finishReason: "stop",
        });
        expect(model.doStreamCalls).toHaveLength(1);
      } finally {
        if (previous == null) {
          Reflect.deleteProperty(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS");
        } else {
          Object.defineProperty(
            globalThis,
            "AI_SDK_TELEMETRY_INTEGRATIONS",
            previous,
          );
        }
      }
    },
  );

  it("fails closed on an inherited global telemetry registry", async function () {
    const property = "AI_SDK_TELEMETRY_INTEGRATIONS";
    const globalPrototype = Object.getPrototypeOf(globalThis);
    const previousOwn = Object.getOwnPropertyDescriptor(globalThis, property);
    const previousInherited = Object.getOwnPropertyDescriptor(
      globalPrototype,
      property,
    );
    const { model } = strictStreamModel([outputStep(validOutput())]);

    try {
      Reflect.deleteProperty(globalThis, property);
      Object.defineProperty(globalPrototype, property, {
        configurable: true,
        writable: true,
        value: {},
      });

      const error = await captureError(
        collect(createGateway(model).stream(projectRequest())),
      );

      expect(error).toMatchObject({
        code: "AI_SDK_TELEMETRY_UNSAFE",
        category: "configuration",
        retryable: false,
      });
      expect(model.doStreamCalls).toHaveLength(0);
    } finally {
      if (previousOwn == null) {
        Reflect.deleteProperty(globalThis, property);
      } else {
        Object.defineProperty(globalThis, property, previousOwn);
      }
      if (previousInherited == null) {
        Reflect.deleteProperty(globalPrototype, property);
      } else {
        Object.defineProperty(globalPrototype, property, previousInherited);
      }
    }
  });

  it("rejects an all-trap telemetry Proxy without invoking it", async function () {
    const sentinel = "GLOBAL_TELEMETRY_PROXY_TRAP_PRIVATE";
    const { model } = strictStreamModel([outputStep(validOutput())]);
    const previous = Object.getOwnPropertyDescriptor(
      globalThis,
      "AI_SDK_TELEMETRY_INTEGRATIONS",
    );
    let trapCalls = 0;
    const trap = () => {
      trapCalls += 1;
      throw new Error(sentinel);
    };
    const integrations = new Proxy(function telemetryIntegration() {}, {
      apply: trap,
      construct: trap,
      defineProperty: trap,
      deleteProperty: trap,
      get: trap,
      getOwnPropertyDescriptor: trap,
      getPrototypeOf: trap,
      has: trap,
      isExtensible: trap,
      ownKeys: trap,
      preventExtensions: trap,
      set: trap,
      setPrototypeOf: trap,
    });

    try {
      Object.defineProperty(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS", {
        configurable: true,
        writable: true,
        value: integrations,
      });

      const error = await captureError(
        collect(createGateway(model).stream(projectRequest())),
      );

      expect(error).toMatchObject({
        code: "AI_SDK_TELEMETRY_UNSAFE",
        category: "configuration",
        retryable: false,
      });
      expect(trapCalls).toBe(0);
      expect(model.doStreamCalls).toHaveLength(0);
      expect(String(error)).not.toContain(sentinel);
    } finally {
      if (previous == null) {
        Reflect.deleteProperty(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS");
      } else {
        Object.defineProperty(
          globalThis,
          "AI_SDK_TELEMETRY_INTEGRATIONS",
          previous,
        );
      }
    }
  });

  it("rejects a proxy-backed global telemetry registry without iterating it", async function () {
    const { model } = strictStreamModel([outputStep(validOutput())]);
    const previous = Object.getOwnPropertyDescriptor(
      globalThis,
      "AI_SDK_TELEMETRY_INTEGRATIONS",
    );
    const onStart = vi.fn();
    let lengthReads = 0;
    let iteratorReads = 0;
    const integrations = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") {
          lengthReads += 1;
          return 0;
        }
        if (property === Symbol.iterator) {
          iteratorReads += 1;
          return function* telemetryIntegrations() {
            yield { onStart };
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    try {
      Object.defineProperty(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS", {
        configurable: true,
        writable: true,
        value: integrations,
      });

      const error = await captureError(
        collect(createGateway(model).stream(projectRequest())),
      );

      expect(error).toMatchObject({
        code: "AI_SDK_TELEMETRY_UNSAFE",
        category: "configuration",
        retryable: false,
      });
      expect(lengthReads).toBe(0);
      expect(iteratorReads).toBe(0);
      expect(onStart).not.toHaveBeenCalled();
      expect(model.doStreamCalls).toHaveLength(0);
    } finally {
      if (previous == null) {
        Reflect.deleteProperty(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS");
      } else {
        Object.defineProperty(
          globalThis,
          "AI_SDK_TELEMETRY_INTEGRATIONS",
          previous,
        );
      }
    }
  });

  it("rejects a proxy-backed registry without reading a throwing length", async function () {
    const sentinel = "GLOBAL_TELEMETRY_LENGTH_PRIVATE";
    const { model } = strictStreamModel([outputStep(validOutput())]);
    const previous = Object.getOwnPropertyDescriptor(
      globalThis,
      "AI_SDK_TELEMETRY_INTEGRATIONS",
    );
    let lengthReads = 0;
    const integrations = new Proxy([], {
      get(target, property, receiver) {
        if (property === "length") {
          lengthReads += 1;
          throw new Error(sentinel);
        }
        return Reflect.get(target, property, receiver);
      },
    });

    try {
      Object.defineProperty(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS", {
        configurable: true,
        writable: true,
        value: integrations,
      });

      const error = await captureError(
        collect(createGateway(model).stream(projectRequest())),
      );

      expect(error).toMatchObject({
        code: "AI_SDK_TELEMETRY_UNSAFE",
        category: "configuration",
        retryable: false,
      });
      expect(lengthReads).toBe(0);
      expect(model.doStreamCalls).toHaveLength(0);
      expect(String(error)).not.toContain(sentinel);
    } finally {
      if (previous == null) {
        Reflect.deleteProperty(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS");
      } else {
        Object.defineProperty(
          globalThis,
          "AI_SDK_TELEMETRY_INTEGRATIONS",
          previous,
        );
      }
    }
  });

  it("does not turn a delivered completed event into a later abort", async function () {
    const controller = new AbortController();
    const { model } = strictStreamModel([outputStep(validOutput())]);
    const iterator = createGateway(model).stream(projectRequest(), {
      signal: controller.signal,
    });
    let result;
    do {
      result = await iterator.next();
    } while (!result.done && result.value.type !== "completed");

    expect(result).toMatchObject({
      done: false,
      value: { type: "completed" },
    });
    controller.abort(
      new DOMException("Synthetic post-terminal abort.", "AbortError"),
    );
    expect(await iterator.next()).toEqual({
      done: true,
      value: undefined,
    });
  });

  it("stops request-specific model inspection when a getter aborts", async function () {
    const controller = new AbortController();
    const reason = new DOMException(
      "PROVIDER_MODEL_GETTER_ABORT_PRIVATE",
      "AbortError",
    );
    const { model: baseModel } = strictStreamModel([outputStep(validOutput())]);
    let providerReads = 0;
    let modelIdReads = 0;
    const model = new Proxy(baseModel, {
      get(target, property, receiver) {
        if (property === "provider") {
          providerReads += 1;
          controller.abort(reason);
          return "fixture";
        }
        if (property === "modelId") {
          modelIdReads += 1;
        }
        return Reflect.get(target, property, receiver);
      },
    });
    const iterator = createGateway(model).stream(projectRequest(), {
      signal: controller.signal,
    });

    expect(await iterator.next()).toMatchObject({
      done: false,
      value: { type: "started" },
    });
    const error = await captureError(iterator.next());

    expect(error).toMatchObject({
      name: "AgentGatewayAbortError",
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    expect(providerReads).toBe(1);
    expect(modelIdReads).toBe(0);
    expect(baseModel.doStreamCalls).toHaveLength(0);
    expect(String(error)).not.toContain("PROVIDER_MODEL_GETTER_ABORT_PRIVATE");
  });

  it("limits a project review to three read-tool calls", async function () {
    const { model, consumed } = strictStreamModel([
      toolStep(
        { path: "main.tex", range: { from: 0, to: 4 } },
        "tool-call-hardening-0001",
      ),
      toolStep(
        { path: "appendix.tex", range: { from: 0, to: 4 } },
        "tool-call-hardening-0002",
      ),
      toolStep(
        { path: "method.tex", range: { from: 0, to: 4 } },
        "tool-call-hardening-0003",
      ),
      toolStep(
        { path: "results.tex", range: { from: 0, to: 4 } },
        "tool-call-hardening-0004",
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
    expect(readProjectFile).toHaveBeenCalledTimes(3);
    expect(consumed()).toBe(4);
    expect(model.doStreamCalls).toHaveLength(4);
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
      gateway.stream(documentRequest({ skill: "line-edit" })),
    );

    expect(events.find((event) => event.type === "suggestion")).toMatchObject({
      suggestion: {
        skill: "line-edit",
        provider: "fixture-provider",
        model: "fixture-model",
        status: "unresolved",
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
        collect(gateway.stream(documentRequest({ skill: null }))),
      ),
    ).toMatchObject({
      code: "AI_SUGGESTION_SKILL_REQUIRED",
      category: "schema",
      retryable: false,
    });
  });

  it("keeps project review read-only even when a skill is selected", async function () {
    const { model } = strictStreamModel([
      outputStep(validOutput({ suggestions: [validSuggestion()] })),
    ]);
    const gateway = createGateway(model);

    expect(
      await captureError(
        collect(gateway.stream(projectRequest({ skill: "line-edit" }))),
      ),
    ).toMatchObject({
      code: "AI_PROJECT_SUGGESTION_NOT_ALLOWED",
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
