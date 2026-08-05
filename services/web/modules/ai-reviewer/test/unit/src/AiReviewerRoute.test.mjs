import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  AgentGatewayError,
  ScriptedFakeAgentGateway,
} from "../../../app/src/AgentGateway.mjs";
import { createAiReviewerController } from "../../../app/src/AiReviewerController.mjs";
import { createAiReviewerRouter } from "../../../app/src/AiReviewerRouter.mjs";
import {
  AgentEventSchema,
  DiscussionEventSchema,
} from "../../../shared/contracts.mjs";

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

function discussionRequest() {
  return {
    requestId: "discussion-request-0001",
    discussionId: "discussion-0001",
    projectId: "project-0001",
    subject: {
      kind: "scope",
      sourceRequest: documentRequest(),
    },
    turns: [
      {
        role: "user",
        text: "Explain the proposed review in more detail.",
      },
    ],
  };
}

function discussionEvents() {
  return [
    {
      type: "started",
      eventId: "discussion-event-0001",
      requestId: "discussion-request-0001",
      sequence: 0,
      createdAt,
      provider: "fake",
      model: "deterministic-v1",
    },
    {
      type: "text.delta",
      eventId: "discussion-event-0002",
      requestId: "discussion-request-0001",
      sequence: 1,
      createdAt,
      delta: "Synthetic discussion response.",
    },
    {
      type: "completed",
      eventId: "discussion-event-0003",
      requestId: "discussion-request-0001",
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
      artifactKind: "finding",
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
      status: "unresolved",
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
  message:
    "The AI provider could not complete the request. Try again; if it keeps failing, switch models or check the AI Reviewer settings.",
  retryable: true,
};

const publicProtocolError = {
  code: "AI_STREAM_PROTOCOL_ERROR",
  category: "schema",
  message:
    "AI Reviewer could not use the model response. Try narrowing the review scope, switching to a more capable model, or checking the AI Reviewer settings.",
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

function parseDiscussionNdjson(response) {
  return response.chunks
    .join("")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => DiscussionEventSchema.parse(JSON.parse(line)));
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
  it("registers each authenticated project-read route once and in middleware order", function () {
    const login = vi.fn();
    const blockRestricted = vi.fn();
    const ensureCanRead = vi.fn();
    const rateLimit = vi.fn();
    const listModels = vi.fn();
    const testConnection = vi.fn();
    const stream = vi.fn();
    const discussionStream = vi.fn();
    const getWorkspace = vi.fn();
    const saveWorkspace = vi.fn();
    const getCommentProvenance = vi.fn();
    const markCommentProvenance = vi.fn();
    const deleteCommentProvenance = vi.fn();
    const deleteDiscussion = vi.fn();
    const deleteWorkspace = vi.fn();
    const listConnections = vi.fn();
    const createConnection = vi.fn();
    const updateConnection = vi.fn();
    const deleteConnection = vi.fn();
    const requireLogin = vi.fn(() => login);
    const get = vi.fn();
    const post = vi.fn();
    const put = vi.fn();
    const remove = vi.fn();
    const webRouter = { get, post, put, delete: remove };
    const anotherRouter = {
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
    };
    const router = createAiReviewerRouter({
      authenticationController: { requireLogin },
      authorizationMiddleware: {
        blockRestrictedUserFromProject: blockRestricted,
        ensureUserCanReadProject: ensureCanRead,
      },
      rateLimit,
      listModels,
      testConnection,
      stream,
      discussionStream,
      getWorkspace,
      saveWorkspace,
      getCommentProvenance,
      markCommentProvenance,
      deleteCommentProvenance,
      deleteDiscussion,
      deleteWorkspace,
      listConnections,
      createConnection,
      updateConnection,
      deleteConnection,
    });

    router.apply(webRouter);
    router.apply(webRouter);
    router.apply(anotherRouter);

    expect(requireLogin).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenNthCalledWith(
      1,
      "/project/:project_id/ai-reviewer/provider/models",
      login,
      rateLimit,
      blockRestricted,
      ensureCanRead,
      listModels,
    );
    expect(get).toHaveBeenNthCalledWith(
      2,
      "/project/:project_id/ai-reviewer/workspace",
      login,
      rateLimit,
      blockRestricted,
      ensureCanRead,
      getWorkspace,
    );
    expect(get).toHaveBeenNthCalledWith(
      3,
      "/project/:project_id/ai-reviewer/comment-provenance",
      login,
      rateLimit,
      blockRestricted,
      ensureCanRead,
      getCommentProvenance,
    );
    expect(put).toHaveBeenNthCalledWith(
      1,
      "/project/:project_id/ai-reviewer/workspace",
      login,
      rateLimit,
      blockRestricted,
      ensureCanRead,
      saveWorkspace,
    );
    expect(put).toHaveBeenNthCalledWith(
      2,
      "/project/:project_id/ai-reviewer/comment-provenance/:comment_id",
      login,
      rateLimit,
      blockRestricted,
      ensureCanRead,
      markCommentProvenance,
    );
    expect(post).toHaveBeenNthCalledWith(
      1,
      "/project/:project_id/ai-reviewer/connection-test",
      login,
      rateLimit,
      blockRestricted,
      ensureCanRead,
      testConnection,
    );
    expect(post).toHaveBeenNthCalledWith(
      2,
      "/project/:project_id/ai-reviewer/stream",
      login,
      rateLimit,
      blockRestricted,
      ensureCanRead,
      stream,
    );
    expect(post).toHaveBeenNthCalledWith(
      3,
      "/project/:project_id/ai-reviewer/discussion-stream",
      login,
      rateLimit,
      blockRestricted,
      ensureCanRead,
      discussionStream,
    );
    expect(remove).toHaveBeenNthCalledWith(
      1,
      "/project/:project_id/ai-reviewer/workspace/discussions/:discussion_id",
      login,
      rateLimit,
      blockRestricted,
      ensureCanRead,
      deleteDiscussion,
    );
    expect(remove).toHaveBeenNthCalledWith(
      2,
      "/project/:project_id/ai-reviewer/workspace",
      login,
      rateLimit,
      blockRestricted,
      ensureCanRead,
      deleteWorkspace,
    );
    expect(remove).toHaveBeenNthCalledWith(
      3,
      "/project/:project_id/ai-reviewer/comment-provenance/:comment_id",
      login,
      rateLimit,
      blockRestricted,
      ensureCanRead,
      deleteCommentProvenance,
    );
    expect(get).toHaveBeenNthCalledWith(
      4,
      "/project/:project_id/ai-reviewer/connections",
      login,
      rateLimit,
      blockRestricted,
      ensureCanRead,
      listConnections,
    );
    expect(post).toHaveBeenNthCalledWith(
      4,
      "/project/:project_id/ai-reviewer/connections",
      login,
      rateLimit,
      blockRestricted,
      ensureCanRead,
      createConnection,
    );
    expect(put).toHaveBeenNthCalledWith(
      3,
      "/project/:project_id/ai-reviewer/connections/:connection_id",
      login,
      rateLimit,
      blockRestricted,
      ensureCanRead,
      updateConnection,
    );
    expect(remove).toHaveBeenNthCalledWith(
      4,
      "/project/:project_id/ai-reviewer/connections/:connection_id",
      login,
      rateLimit,
      blockRestricted,
      ensureCanRead,
      deleteConnection,
    );
    expect(anotherRouter.get).toHaveBeenCalledTimes(4);
    expect(anotherRouter.put).toHaveBeenCalledTimes(3);
    expect(anotherRouter.post).toHaveBeenCalledTimes(4);
    expect(anotherRouter.delete).toHaveBeenCalledTimes(4);
    expect(anotherRouter.get.mock.calls).toEqual(get.mock.calls);
    expect(anotherRouter.put.mock.calls).toEqual(put.mock.calls);
    expect(anotherRouter.post.mock.calls).toEqual(post.mock.calls);
    expect(anotherRouter.delete.mock.calls).toEqual(remove.mock.calls);
  });

  it("streams validated fake-provider events as NDJSON", async function () {
    const gateway = new ScriptedFakeAgentGateway({ events: events() });
    const release = vi.fn(async () => {});
    const controller = createAiReviewerController({
      gatewayFactory: () => gateway,
      now: () => createdAt,
      eventId: () => "event-error",
      concurrencyStore: {
        acquire: vi.fn(async () => ({ acquired: true, release })),
      },
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
    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    [
      "review",
      "stream",
      request(),
      "user",
      "AI_REVIEWER_USER_CONCURRENCY_LIMITED",
    ],
    [
      "discussion",
      "discussionStream",
      discussionRequest(),
      "system",
      "AI_REVIEWER_SYSTEM_CONCURRENCY_LIMITED",
    ],
  ])(
    "returns the same bounded 429 response when %s capacity is exhausted",
    async function (_label, method, body, limit, failureCode) {
      const gatewayFactory = vi.fn();
      const failureRecorder = vi.fn();
      const concurrencyStore = {
        acquire: vi.fn(async () => ({ acquired: false, limit })),
      };
      const controller = createAiReviewerController({
        gatewayFactory,
        concurrencyStore,
        failureRecorder,
        elapsedNow: vi.fn().mockReturnValueOnce(10).mockReturnValue(14),
      });
      const rawRequest = {
        ...httpRequest(body),
        user: { _id: "user-0001" },
      };
      const response = new FakeResponse();

      await controller[method](rawRequest, response);

      expect(response.statusCode).toBe(429);
      expect(JSON.parse(response.chunks.join(""))).toEqual({
        error: {
          code: "AI_REVIEWER_CONCURRENCY_LIMITED",
          category: "rate-limit",
          message:
            "An AI review is already running. Wait for it to finish, then try again.",
          retryable: true,
        },
      });
      expect(response.chunks.join("")).not.toContain("user-0001");
      expect(concurrencyStore.acquire).toHaveBeenCalledExactlyOnceWith(
        "user-0001",
      );
      expect(gatewayFactory).not.toHaveBeenCalled();
      expect(failureRecorder).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: body.requestId,
          failureCategory: "rate-limit",
          failureCode,
        }),
      );
    },
  );

  it("releases capacity when provider startup fails", async function () {
    const release = vi.fn(async () => {});
    const controller = createAiReviewerController({
      gatewayFactory: () => {
        throw new Error("synthetic startup failure");
      },
      concurrencyStore: {
        acquire: vi.fn(async () => ({ acquired: true, release })),
      },
    });

    await controller.stream(httpRequest(), new FakeResponse());

    expect(release).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "abort",
      category: "aborted",
      internalCode: "AI_REQUEST_ABORTED",
      publicError: {
        code: "AI_REQUEST_ABORTED",
        category: "aborted",
        message:
          "The AI reviewer request was cancelled. Run it again if you still need the result.",
        retryable: false,
      },
    },
    {
      label: "authentication failure",
      category: "authentication",
      internalCode: "AI_PROVIDER_AUTHENTICATION_FAILED",
      publicError: {
        code: "AI_PROVIDER_AUTHENTICATION_ERROR",
        category: "authentication",
        message:
          "The AI provider rejected the credentials. Check the credential in AI Reviewer settings, then try again.",
        retryable: false,
      },
    },
    {
      label: "configuration failure",
      category: "configuration",
      internalCode: "AI_PROVIDER_NOT_CONFIGURED",
      publicError: {
        code: "AI_PROVIDER_NOT_CONFIGURED",
        category: "configuration",
        message:
          "AI Reviewer is not configured correctly. Check the provider and model in AI Reviewer settings, then try again.",
        retryable: false,
      },
    },
    {
      label: "project content failure",
      category: "configuration",
      internalCode: "AI_PROJECT_CONTENT_NOT_AVAILABLE",
      publicError: {
        code: "AI_PROJECT_CONTENT_NOT_AVAILABLE",
        category: "configuration",
        message:
          "AI Reviewer could not read the project content. Try narrowing the review scope or check that the project files are available.",
        retryable: false,
      },
    },
    {
      label: "network failure",
      category: "network",
      internalCode: "AI_PROVIDER_NETWORK_FAILED",
      publicError: {
        code: "AI_PROVIDER_NETWORK_ERROR",
        category: "network",
        message:
          "AI Reviewer could not reach the provider. Check the provider endpoint and network connection, then try again.",
        retryable: true,
      },
    },
    {
      label: "provider failure",
      category: "provider",
      internalCode: "AI_PROVIDER_REQUEST_FAILED",
      publicError: {
        code: "AI_PROVIDER_ERROR",
        category: "provider",
        message:
          "The AI provider could not complete the request. Try again; if it keeps failing, switch models or check the AI Reviewer settings.",
        retryable: true,
      },
    },
    {
      label: "rate limit",
      category: "rate-limit",
      internalCode: "AI_PROVIDER_RATE_LIMITED",
      publicError: {
        code: "AI_PROVIDER_RATE_LIMITED",
        category: "rate-limit",
        message:
          "The AI provider rate limit was reached. Wait a little, then try again.",
        retryable: true,
      },
    },
    {
      label: "structured-output schema rejection",
      category: "schema",
      internalCode: "AI_PROVIDER_SCHEMA_INVALID",
      publicError: {
        code: "AI_STREAM_PROTOCOL_ERROR",
        category: "schema",
        message:
          "AI Reviewer could not use the model response. Try narrowing the review scope, switching to a more capable model, or checking the AI Reviewer settings.",
        retryable: false,
      },
    },
    {
      label: "timeout",
      category: "timeout",
      internalCode: "AI_REQUEST_TIMEOUT",
      publicError: {
        code: "AI_REQUEST_TIMEOUT",
        category: "timeout",
        message:
          "The AI reviewer request timed out. Try again or narrow the review scope.",
        retryable: true,
      },
    },
    {
      label: "unknown failure",
      category: "unknown",
      internalCode: null,
      publicError: {
        code: "AI_PROVIDER_ERROR",
        category: "unknown",
        message:
          "AI Reviewer could not complete the request. Try again; if it keeps failing, check the AI Reviewer settings.",
        retryable: true,
      },
    },
  ])(
    "records classified metadata and preserves the four-field public payload for $label",
    async function ({ category, internalCode, publicError }) {
      const privateMessage = `PRIVATE_${category}_FAILURE_DETAIL`;
      const gateway = {
        async *stream() {
          yield events()[0];
          if (internalCode == null) {
            throw new Error(privateMessage);
          }
          throw new AgentGatewayError(privateMessage, {
            code: internalCode,
            category,
            retryable: false,
          });
        },
      };
      const failureRecorder = vi.fn();
      const elapsedNow = vi
        .fn()
        .mockReturnValueOnce(100)
        .mockReturnValue(137.6);
      const controller = createAiReviewerController({
        gatewayFactory: () => gateway,
        now: () => createdAt,
        eventId: () => "event-error",
        elapsedNow,
        failureRecorder,
      });
      const response = new FakeResponse();

      await controller.stream(httpRequest(), response);

      const terminalEvent = parseNdjson(response).at(-1);
      expect(terminalEvent).toMatchObject({
        type: "error",
        eventId: "event-error",
        requestId: "request-0001",
        sequence: 1,
        createdAt,
        error: publicError,
      });
      if (terminalEvent?.type !== "error") {
        throw new Error("Expected a terminal error event.");
      }
      expect(Object.keys(terminalEvent.error).sort()).toEqual([
        "category",
        "code",
        "message",
        "retryable",
      ]);
      expect(failureRecorder).toHaveBeenCalledExactlyOnceWith({
        requestId: "request-0001",
        provider: "fake",
        model: "deterministic-v1",
        scopeKind: "project",
        failureCategory: category,
        failureCode: internalCode ?? "AI_PROVIDER_ERROR",
        providerStatusCode: null,
        providerErrorType: null,
        elapsedMs: 38,
      });
      expect(JSON.stringify(failureRecorder.mock.calls)).not.toContain(
        privateMessage,
      );
      expect(response.chunks.join("")).not.toContain(privateMessage);
    },
  );

  it("records bounded provider diagnostics without widening the public error", async function () {
    const privateMessage = "PRIVATE_PROVIDER_RESPONSE_BODY";
    const gateway = {
      async *stream() {
        yield events()[0];
        throw new AgentGatewayError(privateMessage, {
          code: "AI_PROVIDER_REQUEST_FAILED",
          category: "provider",
          retryable: false,
          providerStatusCode: 400,
          providerErrorType: "AI_APICallError",
        });
      },
    };
    const failureRecorder = vi.fn();
    const controller = createAiReviewerController({
      gatewayFactory: () => gateway,
      now: () => createdAt,
      eventId: () => "event-provider-diagnostics",
      elapsedNow: vi.fn().mockReturnValueOnce(10).mockReturnValue(17.6),
      failureRecorder,
    });
    const response = new FakeResponse();

    await controller.stream(httpRequest(), response);

    const terminalEvent = parseNdjson(response).at(-1);
    expect(terminalEvent).toMatchObject({
      type: "error",
      error: publicProviderError,
    });
    if (terminalEvent?.type !== "error") {
      throw new Error("Expected a terminal error event.");
    }
    expect(Object.keys(terminalEvent.error).sort()).toEqual([
      "category",
      "code",
      "message",
      "retryable",
    ]);
    expect(failureRecorder).toHaveBeenCalledExactlyOnceWith({
      requestId: "request-0001",
      provider: "fake",
      model: "deterministic-v1",
      scopeKind: "project",
      failureCategory: "provider",
      failureCode: "AI_PROVIDER_REQUEST_FAILED",
      providerStatusCode: 400,
      providerErrorType: "AI_APICallError",
      elapsedMs: 8,
    });
    expect(response.chunks.join("")).not.toContain(privateMessage);
    expect(JSON.stringify(failureRecorder.mock.calls)).not.toContain(
      privateMessage,
    );
  });

  it("streams discussion events through the discussion gateway path", async function () {
    const reviewStream = vi.fn();
    const streamDiscussion = vi.fn(async function* (input) {
      expect(input).toEqual(discussionRequest());
      yield* discussionEvents();
    });
    const gatewayFactory = vi.fn(() => ({
      stream: reviewStream,
      streamDiscussion,
    }));
    const controller = createAiReviewerController({
      gatewayFactory,
      now: () => createdAt,
      eventId: () => "event-error",
    });
    const rawHttpRequest = httpRequest(discussionRequest());
    const response = new FakeResponse();

    await controller.discussionStream(rawHttpRequest, response);

    expect(response.statusCode).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/x-ndjson; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.writableEnded).toBe(true);
    expect(parseDiscussionNdjson(response)).toEqual(discussionEvents());
    expect(gatewayFactory).toHaveBeenCalledExactlyOnceWith({
      request: discussionRequest(),
      httpRequest: rawHttpRequest,
      signal: expect.any(AbortSignal),
      setFailureProvider: expect.any(Function),
    });
    expect(streamDiscussion).toHaveBeenCalledExactlyOnceWith(
      discussionRequest(),
      { signal: expect.any(AbortSignal) },
    );
    expect(reviewStream).not.toHaveBeenCalled();
  });

  it("redacts discussion provider failures into a typed terminal event", async function () {
    const secretSentinel = "PRIVATE_DISCUSSION_PROVIDER_SECRET";
    const gateway = {
      stream: vi.fn(),
      streamDiscussion() {
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

    await controller.discussionStream(
      httpRequest(discussionRequest()),
      response,
    );

    expect(parseDiscussionNdjson(response)).toEqual([
      {
        type: "error",
        eventId: "event-error",
        requestId: "discussion-request-0001",
        sequence: 0,
        createdAt,
        error: publicProviderError,
      },
    ]);
    expect(response.chunks.join("")).not.toContain(secretSentinel);
    expect(response.writableEnded).toBe(true);
  });

  it("applies the shared timeout handling to a discussion stream", async function () {
    const timeout = new AbortController();
    const release = vi.fn(async () => {});
    const next = vi.fn(() => new Promise(() => {}));
    const returnIterator = vi.fn(async () => ({
      done: true,
      value: undefined,
    }));
    const gateway = {
      stream: vi.fn(),
      streamDiscussion() {
        return {
          [Symbol.asyncIterator]() {
            return this;
          },
          next,
          return: returnIterator,
        };
      },
    };
    const controller = createAiReviewerController({
      gatewayFactory: () => gateway,
      timeoutSignalFactory: () => timeout.signal,
      now: () => createdAt,
      eventId: () => "event-error",
      concurrencyStore: {
        acquire: vi.fn(async () => ({
          acquired: true,
          release,
        })),
      },
    });
    const response = new FakeResponse();

    const streaming = controller.discussionStream(
      httpRequest(discussionRequest()),
      response,
    );
    await vi.waitFor(() => expect(next).toHaveBeenCalledOnce());
    timeout.abort(new DOMException("Synthetic timeout", "TimeoutError"));

    expect(await settlesWithin(streaming)).toBe(true);
    expect(returnIterator).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(parseDiscussionNdjson(response)).toEqual([
      {
        type: "error",
        eventId: "event-error",
        requestId: "discussion-request-0001",
        sequence: 0,
        createdAt,
        error: {
          code: "AI_REQUEST_TIMEOUT",
          category: "timeout",
          message:
            "The AI reviewer request timed out. Try again or narrow the review scope.",
          retryable: true,
        },
      },
    ]);
    expect(response.writableEnded).toBe(true);
  });

  it.each([
    {
      label: "timeout",
      trigger({ timeout }) {
        timeout.abort(new DOMException("Synthetic timeout", "TimeoutError"));
      },
      expectedEvents: [
        {
          type: "error",
          eventId: "event-error",
          requestId: "request-0001",
          sequence: 0,
          createdAt,
          error: {
            code: "AI_REQUEST_TIMEOUT",
            category: "timeout",
            message:
              "The AI reviewer request timed out. Try again or narrow the review scope.",
            retryable: true,
          },
        },
      ],
      expectEnded: true,
    },
    {
      label: "request abort",
      trigger({ rawHttpRequest }) {
        rawHttpRequest.emit("aborted");
      },
      expectedEvents: [],
      expectEnded: false,
    },
  ])(
    "settles a pending asynchronous gateway factory on $label",
    async function ({ expectEnded, expectedEvents, trigger }) {
      const timeout = new AbortController();
      const gatewayFactory = vi.fn(() => new Promise(() => {}));
      const controller = createAiReviewerController({
        gatewayFactory,
        timeoutSignalFactory: () => timeout.signal,
        now: () => createdAt,
        eventId: () => "event-error",
      });
      const rawHttpRequest = Object.assign(new EventEmitter(), httpRequest());
      const response = new FakeResponse();
      const streaming = controller.stream(rawHttpRequest, response);
      await vi.waitFor(() => expect(gatewayFactory).toHaveBeenCalledOnce());

      trigger({ rawHttpRequest, timeout });

      expect(await settlesWithin(streaming)).toBe(true);
      expect(response.writableEnded).toBe(expectEnded);
      expect(response.chunks.length === 0 ? [] : parseNdjson(response)).toEqual(
        expectedEvents,
      );
      expect(gatewayFactory).toHaveBeenCalledOnce();
    },
  );

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
          message:
            "The AI reviewer request timed out. Try again or narrow the review scope.",
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
    const failureRecorder = vi.fn();
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
      elapsedNow: vi.fn().mockReturnValueOnce(200).mockReturnValue(212.2),
      failureRecorder,
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
    expect(failureRecorder).toHaveBeenCalledExactlyOnceWith({
      requestId: "request-0001",
      provider: null,
      model: null,
      scopeKind: "project",
      failureCategory: "provider",
      failureCode: "AI_PROVIDER_FAILED",
      providerStatusCode: null,
      providerErrorType: null,
      elapsedMs: 12,
    });
    expect(JSON.stringify(failureRecorder.mock.calls)).not.toContain(
      secretSentinel,
    );
  });

  it("cancels the gateway when the browser closes the stream", async function () {
    const never = new Promise(() => {});
    const failureRecorder = vi.fn();
    const gateway = new ScriptedFakeAgentGateway({
      events: events(),
      beforeEvent: ({ index }) => (index === 1 ? never : undefined),
    });
    const controller = createAiReviewerController({
      gatewayFactory: () => gateway,
      now: () => createdAt,
      eventId: () => "event-error",
      elapsedNow: vi.fn().mockReturnValueOnce(50).mockReturnValue(59.7),
      failureRecorder,
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
    expect(failureRecorder).toHaveBeenCalledExactlyOnceWith({
      requestId: "request-0001",
      provider: "fake",
      model: "deterministic-v1",
      scopeKind: "project",
      failureCategory: "aborted",
      failureCode: "AI_REQUEST_ABORTED",
      providerStatusCode: null,
      providerErrorType: null,
      elapsedMs: 10,
    });
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
          message:
            "The AI reviewer request timed out. Try again or narrow the review scope.",
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
          message:
            "The AI reviewer request timed out. Try again or narrow the review scope.",
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
          message:
            "AI Reviewer could not complete the request. Try again; if it keeps failing, check the AI Reviewer settings.",
          retryable: true,
        },
      },
    ]);
    expect(parseNdjson(successfulResponse)).toEqual(events());
    expect(gatewayFactory).toHaveBeenCalledTimes(2);
  });

  it("keeps distinctive manuscript text and a credential out of a failure record and public response", async function () {
    const manuscriptSentinel = "PRIVATE_MANUSCRIPT_SENTINEL";
    const credentialSentinel = "PRIVATE_PROVIDER_CREDENTIAL";
    const failingRequest = {
      ...documentRequest(),
      scope: {
        ...documentRequest().scope,
        text: manuscriptSentinel,
      },
    };
    const failingGateway = {
      async *stream() {
        yield* [];
        throw new Error(credentialSentinel);
      },
    };
    const succeedingGateway = new ScriptedFakeAgentGateway({
      events: events(),
    });
    const gatewayFactory = vi
      .fn()
      .mockReturnValueOnce(failingGateway)
      .mockReturnValueOnce(succeedingGateway);
    const failureRecorder = vi.fn();
    const controller = createAiReviewerController({
      gatewayFactory,
      now: () => createdAt,
      eventId: () => "event-error",
      elapsedNow: vi
        .fn()
        .mockReturnValueOnce(0)
        .mockReturnValueOnce(25)
        .mockReturnValue(50),
      failureRecorder,
    });
    const failedResponse = new FakeResponse();
    const successfulResponse = new FakeResponse();

    await controller.stream(httpRequest(failingRequest), failedResponse);
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
          message:
            "AI Reviewer could not complete the request. Try again; if it keeps failing, check the AI Reviewer settings.",
          retryable: true,
        },
      },
    ]);
    expect(failedResponse.chunks.join("")).not.toContain(manuscriptSentinel);
    expect(failedResponse.chunks.join("")).not.toContain(credentialSentinel);
    expect(failureRecorder).toHaveBeenCalledExactlyOnceWith({
      requestId: "request-0001",
      provider: null,
      model: null,
      scopeKind: "document",
      failureCategory: "unknown",
      failureCode: "AI_PROVIDER_ERROR",
      providerStatusCode: null,
      providerErrorType: null,
      elapsedMs: 25,
    });
    expect(JSON.stringify(failureRecorder.mock.calls)).not.toContain(
      manuscriptSentinel,
    );
    expect(JSON.stringify(failureRecorder.mock.calls)).not.toContain(
      credentialSentinel,
    );
    expect(parseNdjson(successfulResponse)).toEqual(events());
    expect(gatewayFactory).toHaveBeenCalledTimes(2);
  });

  it("exposes every handler the router destructures", async function () {
    // The router mocks its handlers, so a handler that exists on the provider
    // controller but is never re-exported still passes those tests and only
    // fails when Express refuses the undefined callback at boot.
    const { default: controller } =
      await import("../../../app/src/ConfiguredAiReviewerController.mjs");
    const source = await readFile(
      new URL("../../../app/src/AiReviewerRouter.mjs", import.meta.url),
      "utf8",
    );
    const destructured = source
      .slice(
        source.indexOf("export function createAiReviewerRouter({"),
        source.indexOf("}) {"),
      )
      .split("\n")
      .map((line) => line.trim().replace(/,$/u, ""))
      .filter((line) => /^[a-zA-Z][a-zA-Z0-9]*$/u.test(line));

    expect(destructured.length).toBeGreaterThan(10);
    for (const name of destructured) {
      if (
        [
          "authenticationController",
          "authorizationMiddleware",
          "rateLimit",
        ].includes(name)
      ) {
        continue;
      }
      expect(typeof controller[name], `${name} must be exported`).toBe(
        "function",
      );
    }
  });
});
