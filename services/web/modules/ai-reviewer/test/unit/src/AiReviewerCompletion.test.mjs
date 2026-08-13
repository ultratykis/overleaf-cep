import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { AgentGatewayError } from "../../../app/src/AgentGateway.mjs";
import { createAiReviewerCompletionController } from "../../../app/src/AiReviewerCompletionController.mjs";
import { AiReviewerConnectionNotFoundError } from "../../../app/src/AiReviewerProviderConfigStore.mjs";

const userId = "user-completion-0001";
const connectionId = "connection-completion-0001";
const model = "gemma4:12b-it-qat";
const baseUrl = "http://127.0.0.1:11434/v1";
const localConnection = Object.freeze({
  id: connectionId,
  provider: "openai-compatible",
  baseUrl,
  label: "Local Ollama",
});

class FakeResponse extends EventEmitter {
  statusCode = 200;
  body = null;
  writableEnded = false;

  status(statusCode) {
    this.statusCode = statusCode;
    return this;
  }

  json(body) {
    this.body = body;
    this.writableEnded = true;
    return this;
  }
}

function request(body = completionRequest()) {
  return Object.assign(new EventEmitter(), {
    body,
    user: { _id: userId },
  });
}

function completionRequest(overrides = {}) {
  return {
    connectionId,
    model,
    leftContext: "The result ",
    rightContext: " is significant.",
    maxLength: 60,
    ...overrides,
  };
}

function providerResponse(content = "is statistically") {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content } }],
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

function fixture(overrides = {}) {
  const fetchImpl =
    overrides.fetchImpl ?? vi.fn(async () => providerResponse());
  const resolveModel =
    overrides.resolveModel ??
    vi.fn(async (_connection, context) => context.request.model);
  const configStore = overrides.configStore ?? {
    get: vi.fn(async () => localConnection),
  };
  const logger = overrides.logger ?? { info: vi.fn(), warn: vi.fn() };
  const controller = createAiReviewerCompletionController({
    configStore,
    providerService: overrides.providerService ?? {},
    resolveModel,
    fetchImpl,
    logger,
    ...(overrides.timeoutSignalFactory == null
      ? {}
      : { timeoutSignalFactory: overrides.timeoutSignalFactory }),
  });
  return { controller, configStore, fetchImpl, logger, resolveModel };
}

async function run(controller, body = completionRequest()) {
  const response = new FakeResponse();
  await controller.completion(request(body), response);
  return response;
}

describe("AI reviewer: inline completion", function () {
  it.each([
    ["missing field", { model: undefined }],
    ["unknown field", { unexpected: true }],
    ["long left context", { leftContext: "x".repeat(4_001) }],
    ["long right context", { rightContext: "x".repeat(1_001) }],
    ["zero maxLength", { maxLength: 0 }],
    ["large maxLength", { maxLength: 201 }],
    ["fractional maxLength", { maxLength: 1.5 }],
  ])("rejects a strict request with $0", async function (_label, change) {
    const { controller, configStore, fetchImpl } = fixture();
    const body = completionRequest(change);
    if (change.model === undefined) delete body.model;

    const response = await run(controller, body);

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      success: false,
      error: { code: "AI_COMPLETION_REQUEST_INVALID" },
    });
    expect(configStore.get).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("loads only the authenticated user's connection and hides foreign ids", async function () {
    const configStore = {
      get: vi.fn(async () => {
        throw new AiReviewerConnectionNotFoundError();
      }),
    };
    const { controller, fetchImpl } = fixture({ configStore });

    const response = await run(controller);

    expect(configStore.get).toHaveBeenCalledExactlyOnceWith(
      userId,
      connectionId,
    );
    expect(response.statusCode).toBe(404);
    expect(response.body).toMatchObject({
      success: false,
      error: { code: "AI_PROVIDER_CONNECTION_NOT_FOUND" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [
      "remote OpenAI-compatible",
      {
        ...localConnection,
        baseUrl: "https://provider.example/v1",
      },
    ],
    [
      "another provider",
      {
        id: connectionId,
        provider: "gemini",
        label: "Google Gemini",
        credential: "SECRET_NOT_LOGGED",
      },
    ],
  ])(
    "rejects a $0 connection before model resolution",
    async function (_label, connection) {
      const resolveModel = vi.fn();
      const { controller, fetchImpl } = fixture({
        configStore: { get: vi.fn(async () => connection) },
        resolveModel,
      });

      const response = await run(controller);

      expect(response.statusCode).toBe(403);
      expect(response.body).toMatchObject({
        success: false,
        error: { code: "AI_COMPLETION_REQUIRES_LOCAL_CONNECTION" },
      });
      expect(resolveModel).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("rejects a model that the review model resolver cannot resolve", async function () {
    const { controller, fetchImpl } = fixture({
      resolveModel: vi.fn(async () => {
        throw new AgentGatewayError("unavailable", {
          code: "AI_PROVIDER_CONFIGURATION_INVALID",
          category: "configuration",
          retryable: false,
        });
      }),
    });

    const response = await run(controller);

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatchObject({
      success: false,
      error: { code: "AI_COMPLETION_MODEL_UNAVAILABLE" },
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends one guarded non-streaming request with the fixed prompt and options", async function () {
    const requests = [];
    const fetchImpl = vi.fn(async (input, init) => {
      requests.push({
        url: String(input),
        headers: Object.fromEntries(new Headers(init.headers)),
        body: JSON.parse(init.body),
        redirect: init.redirect,
        signal: init.signal,
      });
      return providerResponse("  is statistically  ");
    });
    const { controller, resolveModel } = fixture({ fetchImpl });

    const response = await run(controller);

    expect(resolveModel).toHaveBeenCalledWith(
      localConnection,
      expect.objectContaining({
        request: { model },
        signal: expect.any(AbortSignal),
      }),
      {},
      userId,
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: `${baseUrl}/chat/completions`,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: {
        model,
        messages: [
          {
            role: "system",
            content:
              "You are a text completion engine. Output ONLY the missing text, in the same language as the surrounding text. No thinking, no explanation, no markdown, no code fences. Just the raw continuation characters.",
          },
          {
            role: "user",
            content:
              "Complete the text at [CURSOR]. Output only the few words that replace [CURSOR]:\n\nThe result [CURSOR] is significant.",
          },
        ],
        max_tokens: 30,
        temperature: 0.2,
        reasoning_effort: "none",
        stream: false,
      },
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      success: true,
      data: "is statistically",
    });
  });

  it.each([
    [1, 8],
    [17, 9],
    [200, 96],
  ])(
    "maps maxLength %i to max_tokens %i",
    async function (maxLength, maxTokens) {
      let body;
      const { controller } = fixture({
        fetchImpl: vi.fn(async (_input, init) => {
          body = JSON.parse(init.body);
          return providerResponse();
        }),
      });

      await run(controller, completionRequest({ maxLength }));

      expect(body.max_tokens).toBe(maxTokens);
      expect(body.reasoning_effort).toBe("none");
    },
  );

  it.each([
    ["```latex\ncontinued text\n```", "continued text"],
    ["```\ncontinued text\n```", "continued text"],
    ["  continued text  ", "continued text"],
  ])("strips only surrounding code fences", async function (content, expected) {
    const { controller } = fixture({
      fetchImpl: vi.fn(async () => providerResponse(content)),
    });

    const response = await run(controller);

    expect(response.body).toEqual({ success: true, data: expected });
  });

  it.each(["timeout", "client close"])(
    "aborts the provider request on %s",
    async function (cause) {
      const timeout = new AbortController();
      let providerSignal;
      const fetchImpl = vi.fn(
        async (_input, init) =>
          await new Promise((_resolve, reject) => {
            providerSignal = init.signal;
            init.signal.addEventListener(
              "abort",
              () => reject(init.signal.reason),
              { once: true },
            );
          }),
      );
      const { controller } = fixture({
        fetchImpl,
        timeoutSignalFactory: () => timeout.signal,
      });
      const httpRequest = request();
      const response = new FakeResponse();
      const work = controller.completion(httpRequest, response);
      await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());

      if (cause === "timeout") timeout.abort(new Error("timeout"));
      else response.emit("close");
      await work;

      expect(providerSignal.aborted).toBe(true);
      expect(response.statusCode).toBe(502);
      expect(response.body).toMatchObject({
        success: false,
        error: { code: "AI_COMPLETION_PROVIDER_FAILED" },
      });
    },
  );

  it("ignores a response close that follows a finished response", async function () {
    let providerSignal;
    let resolveFetch;
    const fetchImpl = vi.fn(async (_input, init) => {
      providerSignal = init.signal;
      return await new Promise((resolve) => {
        resolveFetch = resolve;
      });
    });
    const { controller } = fixture({ fetchImpl });
    const response = new FakeResponse();
    const work = controller.completion(request(), response);
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());

    // A keep-alive response stream can close after the answer was written;
    // that must not read as a client disconnect.
    response.writableEnded = true;
    response.emit("close");
    expect(providerSignal.aborted).toBe(false);

    resolveFetch(
      new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    await work;
    expect(response.body).toEqual({ success: true, data: "ok" });
  });

  it("allows three in-flight requests per user and rejects the fourth", async function () {
    const completions = [];
    const fetchImpl = vi.fn(
      async () =>
        await new Promise((resolve) => {
          completions.push(resolve);
        }),
    );
    const { controller } = fixture({ fetchImpl });
    const responses = [
      new FakeResponse(),
      new FakeResponse(),
      new FakeResponse(),
    ];
    const pending = responses.map((response) =>
      controller.completion(request(), response),
    );
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(3));

    const limited = await run(controller);

    expect(limited.statusCode).toBe(429);
    expect(limited.body).toMatchObject({
      success: false,
      error: { code: "AI_COMPLETION_CONCURRENCY_LIMITED" },
    });
    for (const complete of completions) complete(providerResponse());
    await Promise.all(pending);
    expect(responses.every((response) => response.statusCode === 200)).toBe(
      true,
    );
  });

  it("does not expose or log provider response bodies", async function () {
    const privateBody = "PRIVATE_PROVIDER_RESPONSE_BODY";
    const logger = { info: vi.fn(), warn: vi.fn() };
    const { controller } = fixture({
      logger,
      fetchImpl: vi.fn(async () => new Response(privateBody, { status: 500 })),
    });

    const response = await run(controller);

    expect(response.statusCode).toBe(502);
    expect(JSON.stringify(response.body)).not.toContain(privateBody);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(privateBody);
    expect(logger.warn).toHaveBeenCalledWith(
      {
        elapsedMs: expect.any(Number),
        statusClass: "provider-failure",
        connectionId,
        model,
      },
      "AI reviewer completion request finished",
    );
  });
});
