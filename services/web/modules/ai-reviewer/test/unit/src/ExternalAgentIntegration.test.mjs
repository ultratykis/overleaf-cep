import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  AgentGatewayError,
  ScriptedFakeAgentGateway,
} from "../../../app/src/AgentGateway.mjs";
import { createConfiguredAiReviewerController } from "../../../app/src/ConfiguredAiReviewerController.mjs";
import { AgentEventSchema } from "../../../shared/contracts.mjs";

const createdAt = "2026-08-07T00:00:00.000Z";
const userId = "user-external-0001";
const projectId = "project-external-0001";
const connectionId = "connection-external-0001";
const model = "recorder-model";
const text = "Synthetic text.";
const hash = "a".repeat(64);

function agentRequest(overrides = {}) {
  return {
    requestId: "request-external-0001",
    projectId,
    action: "review",
    instruction: "Review the synthetic document.",
    skill: "referee-review",
    connectionId,
    model,
    scope: {
      kind: "document",
      documentId: "document-external-0001",
      path: "main.tex",
      baseRevision: 7,
      baseTextHash: hash,
      text,
    },
    ...overrides,
  };
}

function checkpoint() {
  return Object.freeze({
    projectId,
    historyVersion: 12,
    documents: Object.freeze([
      Object.freeze({
        documentId: "document-external-0001",
        path: "main.tex",
        revision: 7,
        text,
        textHash: hash,
      }),
    ]),
  });
}

function events(request = agentRequest()) {
  return [
    {
      type: "started",
      eventId: "event-external-started",
      requestId: request.requestId,
      sequence: 0,
      createdAt,
      provider: "openai-compatible",
      model,
      skill: request.skill,
    },
    {
      type: "completed",
      eventId: "event-external-completed",
      requestId: request.requestId,
      sequence: 1,
      createdAt,
      finishReason: "stop",
    },
  ];
}

function httpRequest(body, authenticatedUserId = userId) {
  const request = new EventEmitter();
  request.body = body;
  request.params = { project_id: projectId };
  request.user = { _id: { toString: () => authenticatedUserId } };
  return request;
}

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = new Map();
    this.chunks = [];
    this.destroyed = false;
    this.writableEnded = false;
  }

  status(statusCode) {
    this.statusCode = statusCode;
    return this;
  }

  json(body) {
    this.body = body;
    return this;
  }

  setHeader(name, value) {
    this.headers.set(name.toLowerCase(), value);
  }

  flushHeaders() {}

  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }

  end() {
    this.writableEnded = true;
  }
}

function parseEvents(response) {
  return response.chunks
    .join("")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => AgentEventSchema.parse(JSON.parse(line)));
}

function fixture({
  request = agentRequest(),
  checkpointWork,
  connection,
} = {}) {
  const order = [];
  const externalCheckpoint = vi.fn(async () => {
    order.push("checkpoint");
    if (checkpointWork != null) return await checkpointWork();
    return checkpoint();
  });
  const configStore = {
    get: vi.fn(async () => {
      order.push("connection");
      return (
        connection ?? {
          id: connectionId,
          provider: "openai-compatible",
          baseUrl: "http://127.0.0.1:8765/v1",
          models: [model],
        }
      );
    }),
  };
  let session;
  const externalSessionStore = {
    create: vi.fn(async (input) => {
      order.push("create");
      session = {
        id: "stored-session-id",
        ...input,
        threadId: request.agentSessionId == null ? null : "thread-agent-1",
        stateRootKey: "opaque-state-key",
        status: "active",
        lastActivityAt: new Date(createdAt),
        stateBytes: 10,
        revision: 4,
        operationClaim: null,
      };
      return session;
    }),
    claim: vi.fn(async (input) => {
      order.push("claim");
      return {
        ...session,
        revision: 5,
        operationClaim: {
          id: "claim-1",
          type: "turn",
          claimedAt: new Date(createdAt),
        },
      };
    }),
  };
  const externalGatewayFactory = vi.fn((input) => {
    order.push("gateway");
    return new ScriptedFakeAgentGateway({ events: events(input.request) });
  });
  const providerService = {
    listModels: vi.fn(),
    resolveContextLength: vi.fn(),
    createAgentGateway: vi.fn(),
  };
  const requestScopeReader = { read: vi.fn() };
  const controller = createConfiguredAiReviewerController({
    configStore,
    providerService,
    requestScopeReader,
    harness: "external",
    externalCheckpoint,
    externalSessionStore,
    externalRunnerClient: {},
    externalGatewayFactory,
    now: () => createdAt,
    eventId: () => "event-external-error",
  });
  return {
    controller,
    request,
    order,
    externalCheckpoint,
    configStore,
    externalSessionStore,
    externalGatewayFactory,
    providerService,
    requestScopeReader,
  };
}

describe("AI reviewer: configured external harness", function () {
  it("checkpoints before configuration and keeps native provider I/O unused", async function () {
    const test = fixture();
    const response = new FakeResponse();

    await test.controller.stream(httpRequest(test.request), response);

    expect(parseEvents(response)).toEqual(events(test.request));
    expect(test.order).toEqual([
      "checkpoint",
      "connection",
      "create",
      "claim",
      "gateway",
    ]);
    expect(test.externalSessionStore.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        projectId,
        clientSessionId: test.request.requestId,
        mode: "review",
        connectionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      }),
    );
    expect(test.externalSessionStore.claim).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedRevision: 4,
        expectedThreadId: null,
      }),
    );
    expect(test.providerService.listModels).not.toHaveBeenCalled();
    expect(test.providerService.resolveContextLength).not.toHaveBeenCalled();
    expect(test.providerService.createAgentGateway).not.toHaveBeenCalled();
    expect(test.requestScopeReader.read).not.toHaveBeenCalled();
  });

  it("binds an Agent turn to its owner, project, discussion, and stored thread", async function () {
    const request = agentRequest({ agentSessionId: "discussion-agent-0001" });
    const test = fixture({ request });
    const response = new FakeResponse();

    await test.controller.stream(
      httpRequest(request, "user-agent-0002"),
      response,
    );

    expect(parseEvents(response).at(-1)?.type).toBe("completed");
    expect(test.externalSessionStore.create).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-agent-0002",
        projectId,
        clientSessionId: request.agentSessionId,
        mode: "agent",
      }),
    );
    expect(test.externalSessionStore.claim).toHaveBeenCalledWith(
      expect.objectContaining({ expectedThreadId: "thread-agent-1" }),
    );
    expect(test.externalGatewayFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-agent-0002",
        projectId,
        clientSessionId: request.agentSessionId,
      }),
    );
  });

  it("stops at a stale checkpoint before decryption, session CAS, or a process", async function () {
    const test = fixture({
      checkpointWork() {
        throw new AgentGatewayError("stale", {
          code: "AI_EXTERNAL_CHECKPOINT_STALE",
          category: "configuration",
          retryable: true,
        });
      },
    });
    const response = new FakeResponse();

    await test.controller.stream(httpRequest(test.request), response);

    expect(parseEvents(response)).toEqual([
      expect.objectContaining({
        type: "error",
        error: expect.objectContaining({
          code: "AI_EXTERNAL_CHECKPOINT_STALE",
          retryable: true,
        }),
      }),
    ]);
    expect(test.configStore.get).not.toHaveBeenCalled();
    expect(test.externalSessionStore.create).not.toHaveBeenCalled();
    expect(test.externalSessionStore.claim).not.toHaveBeenCalled();
    expect(test.externalGatewayFactory).not.toHaveBeenCalled();
    expect(test.providerService.listModels).not.toHaveBeenCalled();
  });

  it("passes an HTTPS-local credential only to the claimed runner turn", async function () {
    const credential = "synthetic-user-a-key";
    const test = fixture({
      connection: {
        id: connectionId,
        provider: "openai-compatible",
        baseUrl: "https://localhost:8765/v1",
        models: [model],
        credential,
        credentialUpdatedAt: new Date(createdAt),
      },
    });
    const response = new FakeResponse();

    await test.controller.stream(httpRequest(test.request), response);

    expect(parseEvents(response).at(-1)?.type).toBe("completed");
    expect(test.externalGatewayFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        configuration: {
          provider: "openai-compatible",
          baseUrl: "https://localhost:8765/v1",
          model,
          credential,
        },
      }),
    );
    expect(
      JSON.stringify(test.externalSessionStore.create.mock.calls),
    ).not.toContain(credential);

    const rotated = fixture({
      connection: {
        id: connectionId,
        provider: "openai-compatible",
        baseUrl: "https://localhost:8765/v1",
        models: [model],
        credential: "synthetic-user-a-rotated-key",
        credentialUpdatedAt: new Date(createdAt),
      },
    });
    await rotated.controller.stream(
      httpRequest(rotated.request),
      new FakeResponse(),
    );
    expect(
      rotated.externalSessionStore.create.mock.calls[0][0]
        .connectionFingerprint,
    ).not.toBe(
      test.externalSessionStore.create.mock.calls[0][0].connectionFingerprint,
    );
  });

  it("discovers a selected model and accepts a remote HTTPS destination", async function () {
    const test = fixture({
      connection: {
        id: connectionId,
        provider: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
      },
    });
    test.providerService.listModels.mockResolvedValue([
      { id: model, displayName: model },
    ]);
    const response = new FakeResponse();

    await test.controller.stream(httpRequest(test.request), response);

    expect(parseEvents(response).at(-1)?.type).toBe("completed");
    expect(test.providerService.listModels).toHaveBeenCalledOnce();
    expect(test.externalGatewayFactory).toHaveBeenCalledWith(
      expect.objectContaining({
        configuration: {
          provider: "openai-compatible",
          baseUrl: "https://api.example.com/v1",
          model,
        },
      }),
    );
  });

  it("rejects a plaintext credential destination before session CAS", async function () {
    const test = fixture({
      connection: {
        id: connectionId,
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:8765/v1",
        models: [model],
        credential: "must-not-reach-runner",
      },
    });
    const response = new FakeResponse();

    await test.controller.stream(httpRequest(test.request), response);

    expect(parseEvents(response).at(-1)).toMatchObject({
      type: "error",
      error: { category: "configuration", retryable: false },
    });
    expect(test.externalSessionStore.create).not.toHaveBeenCalled();
    expect(test.externalGatewayFactory).not.toHaveBeenCalled();
    expect(JSON.stringify(test.externalGatewayFactory.mock.calls)).not.toContain(
      "must-not-reach-runner",
    );
  });
});
