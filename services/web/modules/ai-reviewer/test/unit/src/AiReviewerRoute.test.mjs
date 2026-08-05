import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  AgentGatewayError,
  ScriptedFakeAgentGateway,
} from "../../../app/src/AgentGateway.mjs";
import { createAiReviewerController } from "../../../app/src/AiReviewerController.mjs";
import { createAiReviewerRouter } from "../../../app/src/AiReviewerRouter.mjs";
import { AgentEventSchema } from "../../../shared/contracts.mjs";

const createdAt = "2026-07-24T00:00:00.000Z";

function request() {
  return {
    requestId: "request-0001",
    projectId: "project-0001",
    action: "review",
    instruction: "Review the synthetic project.",
    skill: "referee-review",
    scope: {
      kind: "project",
    },
  };
}

function events() {
  return [
    {
      type: "started",
      eventId: "event-0001",
      requestId: "request-0001",
      sequence: 0,
      createdAt,
      provider: "fake",
      model: "deterministic-v1",
      skill: "referee-review",
    },
    {
      type: "text.delta",
      eventId: "event-0002",
      requestId: "request-0001",
      sequence: 1,
      createdAt,
      delta: "Synthetic review.",
    },
    {
      type: "completed",
      eventId: "event-0003",
      requestId: "request-0001",
      sequence: 2,
      createdAt,
      finishReason: "stop",
    },
  ];
}

function findingEvent(projectId = "project-0001") {
  return {
    type: "finding",
    eventId: "event-finding",
    requestId: "request-0001",
    sequence: 0,
    createdAt,
    finding: {
      id: "finding-0001",
      requestId: "request-0001",
      projectId,
      severity: "warning",
      category: "terminology",
      title: "Synthetic finding",
      message: "The synthetic terminology is inconsistent.",
      evidence: [
        {
          path: "main.tex",
          range: {
            from: 0,
            to: 9,
          },
        },
      ],
      suggestionIds: [],
    },
  };
}

function documentRequest() {
  return {
    ...request(),
    scope: {
      kind: "document",
      documentId: "document-0001",
      path: "main.tex",
      baseRevision: 7,
      baseTextHash: "a".repeat(64),
      text: "Synthetic text",
    },
  };
}

function selectionRequest() {
  return {
    ...request(),
    scope: {
      kind: "selection",
      documentId: "document-0001",
      path: "main.tex",
      baseRevision: 7,
      baseTextHash: "a".repeat(64),
      range: {
        from: 0,
        to: 9,
      },
      text: "Synthetic",
    },
  };
}

function suggestionEvent(documentId = "document-0001") {
  return {
    type: "suggestion",
    eventId: "event-suggestion",
    requestId: "request-0001",
    sequence: 0,
    createdAt,
    suggestion: {
      id: "suggestion-0001",
      requestId: "request-0001",
      projectId: "project-0001",
      documentId,
      path: "main.tex",
      baseRevision: 7,
      baseTextHash: "a".repeat(64),
      range: {
        from: 0,
        to: 9,
      },
      original: "Synthetic",
      replacement: "Rewritten",
      rationale: "Use the requested terminology.",
      evidence: [
        {
          path: "main.tex",
          range: {
            from: 0,
            to: 9,
          },
        },
      ],
      provider: "fake",
      model: "deterministic-v1",
      skill: "referee-review",
      createdAt,
      status: "proposed",
    },
  };
}

function toolCallEvent(arguments_) {
  return {
    type: "tool.call",
    eventId: "event-tool-call",
    requestId: "request-0001",
    sequence: 0,
    createdAt,
    call: {
      id: "tool-call-0001",
      name: "read_project_file",
      arguments: arguments_,
    },
  };
}

const publicProviderError = {
  code: "AI_PROVIDER_ERROR",
  category: "provider",
  message: "The AI provider request failed.",
  retryable: true,
};

const publicProtocolError = {
  code: "AI_STREAM_PROTOCOL_ERROR",
  category: "schema",
  message: "The AI provider returned invalid stream data.",
  retryable: false,
};

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = new Map();
    this.chunks = [];
    this.writableEnded = false;
    this.destroyed = false;
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  setHeader(name, value) {
    this.headers.set(name.toLowerCase(), value);
  }

  flushHeaders() {}

  write(chunk) {
    this.chunks.push(String(chunk));
    this.emit("write", String(chunk));
    return true;
  }

  end(chunk) {
    if (chunk != null) {
      this.chunks.push(String(chunk));
    }
    this.writableEnded = true;
    this.emit("finish");
  }

  json(value) {
    this.setHeader("content-type", "application/json");
    this.end(JSON.stringify(value));
  }
}

class BackpressureResponse extends FakeResponse {
  blockedWrites = 1;

  write(chunk) {
    super.write(chunk);
    if (this.blockedWrites > 0) {
      this.blockedWrites -= 1;
      return false;
    }
    return true;
  }
}

function httpRequest(body = request()) {
  return {
    body,
    params: {
      project_id: "project-0001",
    },
  };
}

function parseNdjson(response) {
  return response.chunks
    .join("")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => AgentEventSchema.parse(JSON.parse(line)));
}

function nonCooperativeGateway() {
  const next = vi.fn(() => new Promise(() => {}));
  const returnIterator = vi.fn(async () => ({ done: true, value: undefined }));
  return {
    gateway: {
      stream() {
        return {
          [Symbol.asyncIterator]() {
            return this;
          },
          next,
          return: returnIterator,
        };
      },
    },
    next,
    returnIterator,
  };
}

async function settlesWithin(promise, milliseconds = 50) {
  return await Promise.race([
    promise.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), milliseconds)),
  ]);
}

describe("AI reviewer: module shell authenticated route", function () {
  it("registers one authenticated project-read route per web router", function () {
    const login = vi.fn();
    const blockRestricted = vi.fn();
    const ensureCanRead = vi.fn();
    const rateLimit = vi.fn();
    const stream = vi.fn();
    const requireLogin = vi.fn(() => login);
    const post = vi.fn();
    const webRouter = { post };
    const anotherRouter = { post: vi.fn() };
    const router = createAiReviewerRouter({
      authenticationController: { requireLogin },
      authorizationMiddleware: {
        blockRestrictedUserFromProject: blockRestricted,
        ensureUserCanReadProject: ensureCanRead,
      },
      rateLimit,
      stream,
    });

    router.apply(webRouter);
    router.apply(webRouter);
    router.apply(anotherRouter);

    expect(requireLogin).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith(
      "/project/:project_id/ai-reviewer/stream",
      login,
      rateLimit,
      blockRestricted,
      ensureCanRead,
      stream,
    );
    expect(anotherRouter.post).toHaveBeenCalledOnce();
  });

  it("streams validated fake-provider events as NDJSON", async function () {
    const gateway = new ScriptedFakeAgentGateway({ events: events() });
    const controller = createAiReviewerController({
      gatewayFactory: () => gateway,
      now: () => createdAt,
      eventId: () => "event-error",
    });
    const response = new FakeResponse();

    await controller.stream(httpRequest(), response);

    expect(response.statusCode).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/x-ndjson; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.writableEnded).toBe(true);
    expect(parseNdjson(response)).toEqual(events());
    expect(gateway.calls).toEqual([request()]);
  });

  it.each([
    ["an empty stream", []],
    ["a non-terminal stream", [events()[0]]],
  ])("returns a typed protocol error for %s", async function (_name, script) {
    const gateway = new ScriptedFakeAgentGateway({ events: script });
    const controller = createAiReviewerController({
      gatewayFactory: () => gateway,
      now: () => createdAt,
      eventId: () => "event-error",
    });
    const response = new FakeResponse();

    await controller.stream(httpRequest(), response);

    const streamed = parseNdjson(response);
    expect(streamed.at(-1)).toEqual({
      type: "error",
      eventId: "event-error",
      requestId: "request-0001",
      sequence: script.length,
      createdAt,
      error: publicProtocolError,
    });
    expect(response.writableEnded).toBe(true);
  });

  it("stops consuming after the first terminal event", async function () {
    const terminal = {
      ...events()[2],
      sequence: 0,
    };
    const lateDelta = {
      ...events()[1],
      sequence: 1,
    };
    const gateway = new ScriptedFakeAgentGateway({
      events: [terminal, lateDelta],
    });
    const controller = createAiReviewerController({
      gatewayFactory: () => gateway,
      now: () => createdAt,
      eventId: () => "event-error",
    });
    const response = new FakeResponse();

    await controller.stream(httpRequest(), response);

    expect(parseNdjson(response)).toEqual([terminal]);
    expect(gateway.emittedEventCount).toBe(1);
  });

  it("does not replace a terminal event with a later provider failure", async function () {
    const terminal = {
      ...events()[2],
      sequence: 0,
    };
    const gateway = {
      async *stream() {
        yield terminal;
        throw new Error("PRIVATE_FAILURE_AFTER_TERMINAL");
      },
    };
    const controller = createAiReviewerController({
      gatewayFactory: () => gateway,
      now: () => createdAt,
      eventId: () => "event-error",
    });
    const response = new FakeResponse();

    await controller.stream(httpRequest(), response);

    expect(parseNdjson(response)).toEqual([terminal]);
    expect(response.chunks.join("")).not.toContain(
      "PRIVATE_FAILURE_AFTER_TERMINAL",
    );
  });

  it("waits for response drain before requesting the next event", async function () {
    const gateway = new ScriptedFakeAgentGateway({ events: events() });
    const controller = createAiReviewerController({
      gatewayFactory: () => gateway,
      now: () => createdAt,
      eventId: () => "event-error",
    });
    const response = new BackpressureResponse();
    const firstWrite = new Promise((resolve) =>
      response.once("write", resolve),
    );

    const streaming = controller.stream(httpRequest(), response);
    await firstWrite;
    await Promise.resolve();

    expect(response.chunks).toHaveLength(1);
    expect(gateway.emittedEventCount).toBe(1);
    expect(response.writableEnded).toBe(false);

    response.emit("drain");
    await streaming;

    expect(parseNdjson(response)).toEqual(events());
    expect(response.writableEnded).toBe(true);
  });

  it("uses the next sequence when timeout interrupts a nonterminal drain", async function () {
    const timeout = new AbortController();
    const gateway = new ScriptedFakeAgentGateway({ events: events() });
    const controller = createAiReviewerController({
      gatewayFactory: () => gateway,
      timeoutSignalFactory: () => timeout.signal,
      now: () => createdAt,
      eventId: () => "event-error",
    });
    const response = new BackpressureResponse();
    const firstWrite = new Promise((resolve) =>
      response.once("write", resolve),
    );

    const streaming = controller.stream(httpRequest(), response);
    await firstWrite;
    timeout.abort(new DOMException("Synthetic timeout", "TimeoutError"));
    await streaming;

    expect(parseNdjson(response)).toEqual([
      events()[0],
      {
        type: "error",
        eventId: "event-error",
        requestId: "request-0001",
        sequence: 1,
        createdAt,
        error: {
          code: "AI_REQUEST_TIMEOUT",
          category: "timeout",
          message: "The AI reviewer request timed out.",
          retryable: true,
        },
      },
    ]);
    expect(gateway.emittedEventCount).toBe(1);
    expect(response.writableEnded).toBe(true);
  });

  it("does not append an error when timeout interrupts a terminal drain", async function () {
    const timeout = new AbortController();
    const terminal = {
      ...events()[2],
      sequence: 0,
    };
    const gateway = new ScriptedFakeAgentGateway({ events: [terminal] });
    const controller = createAiReviewerController({
      gatewayFactory: () => gateway,
      timeoutSignalFactory: () => timeout.signal,
      now: () => createdAt,
      eventId: () => "event-error",
    });
    const response = new BackpressureResponse();
    const firstWrite = new Promise((resolve) =>
      response.once("write", resolve),
    );

    const streaming = controller.stream(httpRequest(), response);
    await firstWrite;
    timeout.abort(new DOMException("Synthetic timeout", "TimeoutError"));
    await streaming;

    expect(parseNdjson(response)).toEqual([terminal]);
    expect(gateway.emittedEventCount).toBe(1);
    expect(response.writableEnded).toBe(true);
  });

  it("rejects a request whose body is bound to another project", async function () {
    const gatewayFactory = vi.fn();
    const controller = createAiReviewerController({
      gatewayFactory,
      now: () => createdAt,
      eventId: () => "event-error",
    });
    const response = new FakeResponse();

    await controller.stream(
      httpRequest({ ...request(), projectId: "project-0002" }),
      response,
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.chunks.join(""))).toEqual({
      error: {
        code: "AI_REQUEST_PROJECT_MISMATCH",
        category: "schema",
        message: "The AI reviewer request does not match this project.",
        retryable: false,
      },
    });
    expect(gatewayFactory).not.toHaveBeenCalled();
  });

  it("rejects a raw gateway finding bound to another project", async function () {
    const gateway = {
      async *stream() {
        yield findingEvent("project-0002");
      },
    };
    const controller = createAiReviewerController({
      gatewayFactory: () => gateway,
      now: () => createdAt,
      eventId: () => "event-error",
    });
    const response = new FakeResponse();

    await controller.stream(httpRequest(), response);

    expect(parseNdjson(response)).toEqual([
      {
        type: "error",
        eventId: "event-error",
        requestId: "request-0001",
        sequence: 0,
        createdAt,
        error: publicProtocolError,
      },
    ]);
  });

  it("rejects a raw gateway suggestion outside the requested document", async function () {
    const gateway = {
      async *stream() {
        yield suggestionEvent("document-0002");
      },
    };
    const controller = createAiReviewerController({
      gatewayFactory: () => gateway,
      now: () => createdAt,
      eventId: () => "event-error",
    });
    const response = new FakeResponse();

    await controller.stream(httpRequest(documentRequest()), response);

    expect(parseNdjson(response)).toEqual([
      {
        type: "error",
        eventId: "event-error",
        requestId: "request-0001",
        sequence: 0,
        createdAt,
        error: publicProtocolError,
      },
    ]);
  });

  it.each([
    {
      label: "started skill",
      body: request(),
      event: {
        ...events()[0],
        skill: "line-edit",
      },
    },
    {
      label: "suggestion skill",
      body: documentRequest(),
      event: {
        ...suggestionEvent(),
        suggestion: {
          ...suggestionEvent().suggestion,
          skill: "line-edit",
        },
      },
    },
    {
      label: "finding evidence path",
      body: documentRequest(),
      event: {
        ...findingEvent(),
        finding: {
          ...findingEvent().finding,
          evidence: [{ path: "references.tex", range: { from: 0, to: 9 } }],
        },
      },
    },
    {
      label: "suggestion evidence revision",
      body: documentRequest(),
      event: {
        ...suggestionEvent(),
        suggestion: {
          ...suggestionEvent().suggestion,
          evidence: [
            {
              path: "main.tex",
              range: { from: 0, to: 9 },
              revision: 8,
            },
          ],
        },
      },
    },
    {
      label: "tool path",
      body: documentRequest(),
      event: toolCallEvent({
        path: "references.tex",
        range: { from: 0, to: 9 },
      }),
    },
    {
      label: "selection tool range",
      body: selectionRequest(),
      event: toolCallEvent({ path: "main.tex" }),
    },
  ])(
    "rejects a raw gateway event with mismatched $label",
    async function ({ body, event }) {
      const gateway = {
        async *stream() {
          yield event;
        },
      };
      const controller = createAiReviewerController({
        gatewayFactory: () => gateway,
        now: () => createdAt,
        eventId: () => "event-error",
      });
      const response = new FakeResponse();

      await controller.stream(httpRequest(body), response);

      expect(parseNdjson(response)).toEqual([
        {
          type: "error",
          eventId: "event-error",
          requestId: "request-0001",
          sequence: 0,
          createdAt,
          error: publicProtocolError,
        },
      ]);
      expect(response.writableEnded).toBe(true);
    },
  );

  it("converts provider failures into a typed terminal event", async function () {
    const gateway = {
      async *stream() {
        yield* [];
        throw new AgentGatewayError("Synthetic provider unavailable.", {
          code: "AI_PROVIDER_UNAVAILABLE",
          category: "provider",
          retryable: true,
        });
      },
    };
    const controller = createAiReviewerController({
      gatewayFactory: () => gateway,
      now: () => createdAt,
      eventId: () => "event-error",
    });
    const response = new FakeResponse();

    await controller.stream(httpRequest(), response);

    expect(parseNdjson(response)).toEqual([
      {
        type: "error",
        eventId: "event-error",
        requestId: "request-0001",
        sequence: 0,
        createdAt,
        error: publicProviderError,
      },
    ]);
    expect(response.writableEnded).toBe(true);
  });

  it("normalizes a secret-bearing provider error event", async function () {
    const secretSentinel = "PRIVATE_PROVIDER_SECRET";
    const gateway = {
      async *stream() {
        yield {
          type: "error",
          eventId: "event-provider-error",
          requestId: "request-0001",
          sequence: 0,
          createdAt,
          error: {
            code: secretSentinel,
            category: "provider",
            message: secretSentinel,
            retryable: false,
          },
        };
      },
    };
    const controller = createAiReviewerController({
      gatewayFactory: () => gateway,
      now: () => createdAt,
      eventId: () => "event-error",
    });
    const response = new FakeResponse();

    await controller.stream(httpRequest(), response);

    expect(parseNdjson(response)).toEqual([
      {
        type: "error",
        eventId: "event-provider-error",
        requestId: "request-0001",
        sequence: 0,
        createdAt,
        error: publicProviderError,
      },
    ]);
    expect(response.chunks.join("")).not.toContain(secretSentinel);
  });

  it("cancels the gateway when the browser closes the stream", async function () {
    const never = new Promise(() => {});
    const gateway = new ScriptedFakeAgentGateway({
      events: events(),
      beforeEvent: ({ index }) => (index === 1 ? never : undefined),
    });
    const controller = createAiReviewerController({
      gatewayFactory: () => gateway,
      now: () => createdAt,
      eventId: () => "event-error",
    });
    const response = new FakeResponse();
    const firstWrite = new Promise((resolve) =>
      response.once("write", resolve),
    );

    const streaming = controller.stream(httpRequest(), response);
    await firstWrite;
    response.destroyed = true;
    response.emit("close");
    await streaming;

    expect(gateway.emittedEventCount).toBe(1);
    expect(response.chunks).toHaveLength(1);
    expect(response.writableEnded).toBe(false);
  });

  it("settles a browser disconnect even when the gateway ignores cancellation", async function () {
    const { gateway, next, returnIterator } = nonCooperativeGateway();
    const controller = createAiReviewerController({
      gatewayFactory: () => gateway,
      now: () => createdAt,
      eventId: () => "event-error",
    });
    const response = new FakeResponse();

    const streaming = controller.stream(httpRequest(), response);
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
    response.destroyed = true;
    response.emit("close");

    expect(await settlesWithin(streaming)).toBe(true);
    expect(returnIterator).toHaveBeenCalledOnce();
    expect(response.chunks).toEqual([]);
    expect(response.writableEnded).toBe(false);
  });

  it("classifies a deterministic timeout without terminating the process", async function () {
    const timeout = new AbortController();
    const never = new Promise(() => {});
    const gateway = new ScriptedFakeAgentGateway({
      events: events(),
      beforeEvent: () => never,
    });
    const controller = createAiReviewerController({
      gatewayFactory: () => gateway,
      timeoutSignalFactory: () => timeout.signal,
      now: () => createdAt,
      eventId: () => "event-error",
    });
    const response = new FakeResponse();

    const streaming = controller.stream(httpRequest(), response);
    timeout.abort(new DOMException("Synthetic timeout", "TimeoutError"));
    await streaming;

    expect(parseNdjson(response)).toEqual([
      {
        type: "error",
        eventId: "event-error",
        requestId: "request-0001",
        sequence: 0,
        createdAt,
        error: {
          code: "AI_REQUEST_TIMEOUT",
          category: "timeout",
          message: "The AI reviewer request timed out.",
          retryable: true,
        },
      },
    ]);
    expect(response.writableEnded).toBe(true);
  });

  it("settles a timeout even when the gateway ignores cancellation", async function () {
    const timeout = new AbortController();
    const { gateway, next, returnIterator } = nonCooperativeGateway();
    const controller = createAiReviewerController({
      gatewayFactory: () => gateway,
      timeoutSignalFactory: () => timeout.signal,
      now: () => createdAt,
      eventId: () => "event-error",
    });
    const response = new FakeResponse();

    const streaming = controller.stream(httpRequest(), response);
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
    timeout.abort(new DOMException("Synthetic timeout", "TimeoutError"));

    expect(await settlesWithin(streaming)).toBe(true);
    expect(returnIterator).toHaveBeenCalledOnce();
    expect(parseNdjson(response)).toEqual([
      {
        type: "error",
        eventId: "event-error",
        requestId: "request-0001",
        sequence: 0,
        createdAt,
        error: {
          code: "AI_REQUEST_TIMEOUT",
          category: "timeout",
          message: "The AI reviewer request timed out.",
          retryable: true,
        },
      },
    ]);
    expect(response.writableEnded).toBe(true);
  });

  it("does not expose classified error messages or codes", async function () {
    const secretSentinel = "PRIVATE_PROVIDER_SECRET";
    const gateway = {
      async *stream() {
        yield* [];
        throw new AgentGatewayError(secretSentinel, {
          code: secretSentinel,
          category: "provider",
          retryable: false,
        });
      },
    };
    const controller = createAiReviewerController({
      gatewayFactory: () => gateway,
      now: () => createdAt,
      eventId: () => "event-error",
    });
    const response = new FakeResponse();

    await controller.stream(httpRequest(), response);

    expect(parseNdjson(response)).toEqual([
      {
        type: "error",
        eventId: "event-error",
        requestId: "request-0001",
        sequence: 0,
        createdAt,
        error: publicProviderError,
      },
    ]);
    expect(response.chunks.join("")).not.toContain(secretSentinel);
  });

  it("contains a malformed classified error and serves the next request", async function () {
    const malformedGateway = {
      async *stream() {
        yield* [];
        throw new AgentGatewayError("x".repeat(2_001), {
          code: "x".repeat(201),
          category: "invalid-category",
          retryable: true,
        });
      },
    };
    const succeedingGateway = new ScriptedFakeAgentGateway({
      events: events(),
    });
    const gatewayFactory = vi
      .fn()
      .mockReturnValueOnce(malformedGateway)
      .mockReturnValueOnce(succeedingGateway);
    const controller = createAiReviewerController({
      gatewayFactory,
      now: () => createdAt,
      eventId: () => "event-error",
    });
    const malformedResponse = new FakeResponse();
    const successfulResponse = new FakeResponse();

    const malformedResult = await controller.stream(
      httpRequest(),
      malformedResponse,
    );
    expect(malformedResult).toBeUndefined();
    await controller.stream(httpRequest(), successfulResponse);

    expect(parseNdjson(malformedResponse)).toEqual([
      {
        type: "error",
        eventId: "event-error",
        requestId: "request-0001",
        sequence: 0,
        createdAt,
        error: {
          code: "AI_PROVIDER_ERROR",
          category: "unknown",
          message: "The AI provider request failed.",
          retryable: true,
        },
      },
    ]);
    expect(parseNdjson(successfulResponse)).toEqual(events());
    expect(gatewayFactory).toHaveBeenCalledTimes(2);
  });

  it("redacts an unknown failure and serves the next request", async function () {
    const manuscriptSentinel = "PRIVATE_MANUSCRIPT_SENTINEL";
    const secretSentinel = "PRIVATE_PROVIDER_SECRET";
    const failingGateway = {
      async *stream() {
        yield* [];
        throw new Error(`${manuscriptSentinel}:${secretSentinel}`);
      },
    };
    const succeedingGateway = new ScriptedFakeAgentGateway({
      events: events(),
    });
    const gatewayFactory = vi
      .fn()
      .mockReturnValueOnce(failingGateway)
      .mockReturnValueOnce(succeedingGateway);
    const controller = createAiReviewerController({
      gatewayFactory,
      now: () => createdAt,
      eventId: () => "event-error",
    });
    const failedResponse = new FakeResponse();
    const successfulResponse = new FakeResponse();

    await controller.stream(httpRequest(), failedResponse);
    await controller.stream(httpRequest(), successfulResponse);

    expect(parseNdjson(failedResponse)).toEqual([
      {
        type: "error",
        eventId: "event-error",
        requestId: "request-0001",
        sequence: 0,
        createdAt,
        error: {
          code: "AI_PROVIDER_ERROR",
          category: "unknown",
          message: "The AI provider request failed.",
          retryable: true,
        },
      },
    ]);
    expect(failedResponse.chunks.join("")).not.toContain(manuscriptSentinel);
    expect(failedResponse.chunks.join("")).not.toContain(secretSentinel);
    expect(parseNdjson(successfulResponse)).toEqual(events());
    expect(gatewayFactory).toHaveBeenCalledTimes(2);
  });
});
