import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  AgentGatewayAbortError,
  AgentGatewayError,
} from "../../../app/src/AgentGateway.mjs";
import { createExternalAgentGateway } from "../../../app/src/ExternalAgentGateway.mjs";
import { AgentEventSchema } from "../../../shared/contracts.mjs";

const createdAt = "2026-08-07T00:00:00.000Z";
const userId = "507f1f77bcf86cd799439011";
const projectId = "507f1f77bcf86cd799439012";
const reviewClientSessionId = "request-external-1";
const agentSessionId = "agent-session-1";
const original = "Alpha text";
const textHash = createHash("sha256").update(original).digest("hex");

function request(overrides = {}) {
  return {
    requestId: "request-external-1",
    projectId,
    action: "rewrite",
    instruction: "Improve the opening word.",
    skill: "referee-review",
    connectionId: "connection-local",
    model: "mock-model",
    scope: {
      kind: "document",
      documentId: "document-1",
      path: "main.tex",
      baseRevision: 7,
      baseTextHash: textHash,
      text: original,
    },
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    projectId,
    historyVersion: 11,
    documents: [
      {
        documentId: "document-1",
        path: "main.tex",
        revision: 7,
        text: original,
        textHash,
      },
    ],
    ...overrides,
  };
}

function session(overrides = {}) {
  return {
    id: "session-scope-hash",
    userId,
    projectId,
    clientSessionId: reviewClientSessionId,
    mode: "review",
    threadId: null,
    stateRootKey: "state-key-1",
    connectionFingerprint: "fingerprint-1",
    status: "active",
    lastActivityAt: new Date(createdAt),
    stateBytes: 0,
    revision: 0,
    operationClaim: null,
    ...overrides,
  };
}

function claim(base = session(), overrides = {}) {
  return {
    ...base,
    revision: base.revision + 1,
    operationClaim: {
      id: "claim-1",
      type: "turn",
      claimedAt: new Date(createdAt),
    },
    ...overrides,
  };
}

function edit(overrides = {}) {
  return {
    documentId: "document-1",
    path: "main.tex",
    baseRevision: 7,
    baseTextHash: textHash,
    range: { from: 0, to: 5 },
    original: "Alpha",
    replacement: "Clear",
    ...overrides,
  };
}

function result(overrides = {}) {
  return {
    threadId: "thread-1",
    turn: {
      threadId: "thread-1",
      turnId: "turn-1",
      text: "I updated the opening.",
    },
    changes: {
      projectId,
      historyVersion: 11,
      edits: [edit()],
    },
    stateBytes: 123,
    ...overrides,
  };
}

function fixture(overrides = {}) {
  let id = 0;
  const storedRequest = overrides.request ?? request();
  const storedSession = overrides.session ?? session();
  const storedClaim = overrides.claim ?? claim(storedSession);
  const runnerClient = {
    turn: vi.fn(async () => overrides.result ?? result()),
    retire: vi.fn(async () => ({})),
  };
  const sessionStore = {
    finalize: vi.fn(async () => ({ ...storedClaim, operationClaim: null })),
  };
  return {
    storedSession,
    storedClaim,
    runnerClient,
    sessionStore,
    gateway: createExternalAgentGateway({
      request: storedRequest,
      snapshot: overrides.snapshot ?? snapshot(),
      configuration:
        overrides.configuration ??
        Object.freeze({
          provider: "openai-compatible",
          baseUrl: "http://127.0.0.1:43123",
          model: "mock-model",
        }),
      session: storedSession,
      claim: storedClaim,
      runnerClient,
      sessionStore,
      userId: overrides.userId ?? userId,
      projectId: overrides.projectId ?? projectId,
      clientSessionId:
        overrides.clientSessionId ?? storedSession.clientSessionId,
      createId: () => `external-id-${++id}`,
      now: () => createdAt,
    }),
  };
}

async function collect(gateway, activeRequest = request(), signal) {
  const events = [];
  for await (const event of gateway.stream(activeRequest, { signal })) {
    events.push(event);
  }
  return events;
}

async function failureOf(work) {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to fail.");
}

describe("ExternalAgentGateway", function () {
  it("validates and finalizes a Review before yielding existing AgentEvents", async function () {
    const order = [];
    const test = fixture();
    test.runnerClient.turn.mockImplementation(async () => {
      order.push("runner");
      return result();
    });
    test.sessionStore.finalize.mockImplementation(async () => {
      order.push("finalize");
      return {};
    });

    const events = await collect(test.gateway);
    order.push("yielded");

    expect(order).toEqual(["runner", "finalize", "yielded"]);
    expect(events.map((event) => event.type)).toEqual([
      "started",
      "text.delta",
      "suggestion",
      "completed",
    ]);
    events.forEach((event) =>
      expect(AgentEventSchema.safeParse(event).success).toBe(true),
    );
    expect(events[2].suggestion).toMatchObject({
      requestId: "request-external-1",
      projectId,
      documentId: "document-1",
      path: "main.tex",
      baseRevision: 7,
      baseTextHash: textHash,
      range: { from: 0, to: 5 },
      original: "Alpha",
      replacement: "Clear",
      provider: "openai-compatible",
      model: "mock-model",
      skill: "referee-review",
      status: "unresolved",
    });
    expect(test.runnerClient.turn).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        mode: "review",
        stateRootKey: "state-key-1",
        fingerprint: "fingerprint-1",
        destination: {
          provider: "openai-compatible",
          baseUrl: "http://127.0.0.1:43123",
          model: "mock-model",
        },
        threadId: null,
      }),
      { signal: undefined },
    );
    const runnerInput = test.runnerClient.turn.mock.calls[0][0];
    expect(runnerInput.prompt).toContain("Do not use Git");
    expect(runnerInput.prompt).toContain("Improve the opening word.");
    expect(test.sessionStore.finalize).toHaveBeenCalledExactlyOnceWith({
      userId,
      projectId,
      clientSessionId: reviewClientSessionId,
      type: "turn",
      expectedRevision: 1,
      claimId: "claim-1",
      threadId: "thread-1",
      stateBytes: 123,
    });
    expect(test.runnerClient.retire).not.toHaveBeenCalled();
  });

  it("sends an HTTPS-local credential only inside the runner destination", async function () {
    const credential = "synthetic-user-a-key";
    const test = fixture({
      configuration: {
        provider: "openai-compatible",
        baseUrl: "https://localhost:43123",
        model: "mock-model",
        credential,
      },
    });

    await collect(test.gateway);

    expect(test.runnerClient.turn.mock.calls[0][0].destination).toEqual({
      provider: "openai-compatible",
      baseUrl: "https://localhost:43123",
      model: "mock-model",
      credential,
    });
    expect(JSON.stringify(test.sessionStore.finalize.mock.calls)).not.toContain(
      credential,
    );
  });

  it("resumes only the claimed Agent thread and bounds text deltas", async function () {
    const text = "x".repeat(100_001);
    const agentRequest = request({ agentSessionId });
    const storedSession = session({
      clientSessionId: agentSessionId,
      mode: "agent",
      threadId: "thread-1",
    });
    const test = fixture({
      request: agentRequest,
      session: storedSession,
      claim: claim(storedSession),
      result: result({
        turn: { threadId: "thread-1", turnId: "turn-2", text },
        changes: { projectId, historyVersion: 11, edits: [] },
      }),
    });

    const events = await collect(test.gateway, agentRequest);

    expect(test.runnerClient.turn.mock.calls[0][0]).toMatchObject({
      mode: "agent",
      threadId: "thread-1",
    });
    expect(
      events
        .filter((event) => event.type === "text.delta")
        .map((event) => event.delta.length),
    ).toEqual([100_000, 1]);
    expect(events.at(-1).type).toBe("completed");
    expect(test.runnerClient.retire).not.toHaveBeenCalled();
  });

  it("fails closed for Review thread reuse and Agent thread replacement", async function () {
    expect(() => {
      const storedSession = session({ threadId: "old-review-thread" });
      fixture({ session: storedSession, claim: claim(storedSession) });
    }).toThrowError(
      expect.objectContaining({ code: "AI_EXTERNAL_AGENT_RESULT_INVALID" }),
    );

    const agentRequest = request({ agentSessionId });
    const storedSession = session({
      clientSessionId: agentSessionId,
      mode: "agent",
      threadId: "thread-1",
    });
    const test = fixture({
      request: agentRequest,
      session: storedSession,
      claim: claim(storedSession),
      result: result({
        threadId: "thread-other",
        turn: { threadId: "thread-other", turnId: "turn-other", text: "" },
      }),
    });
    const error = await failureOf(collect(test.gateway, agentRequest));

    expect(error).toMatchObject({ code: "AI_EXTERNAL_AGENT_RESULT_INVALID" });
    expect(test.sessionStore.finalize).not.toHaveBeenCalled();
    expect(test.runnerClient.retire).toHaveBeenCalledExactlyOnceWith({
      stateRootKey: "state-key-1",
    });
  });

  it("binds Review and Agent requests to their server-owned session mode and id", function () {
    for (const input of [
      {
        session: session({ clientSessionId: "wrong-review-session" }),
      },
      {
        session: session({ mode: "agent", threadId: "thread-1" }),
      },
      {
        request: request({ agentSessionId }),
        session: session({ clientSessionId: agentSessionId }),
      },
      {
        request: request({ agentSessionId }),
        session: session({
          clientSessionId: "wrong-agent-session",
          mode: "agent",
          threadId: "thread-1",
        }),
      },
    ]) {
      const storedClaim = claim(input.session);
      expect(() => fixture({ ...input, claim: storedClaim })).toThrowError(
        expect.objectContaining({ code: "AI_EXTERNAL_AGENT_RESULT_INVALID" }),
      );
    }
  });

  it("validates every edit before finalize or the first streamed event", async function () {
    const agentRequest = request({ agentSessionId });
    const storedSession = session({
      clientSessionId: agentSessionId,
      mode: "agent",
      threadId: "thread-1",
    });
    const test = fixture({
      request: agentRequest,
      session: storedSession,
      claim: claim(storedSession),
      result: result({
        changes: {
          projectId,
          historyVersion: 11,
          edits: [edit({ path: "other.tex" })],
        },
      }),
    });
    const yielded = [];
    const error = await failureOf(
      (async () => {
        for await (const event of test.gateway.stream(agentRequest)) {
          yielded.push(event);
        }
      })(),
    );

    expect(error).toMatchObject({ code: "AI_EXTERNAL_AGENT_RESULT_INVALID" });
    expect(yielded).toEqual([]);
    expect(test.sessionStore.finalize).not.toHaveBeenCalled();
    expect(test.runnerClient.retire).toHaveBeenCalledExactlyOnceWith({
      stateRootKey: "state-key-1",
    });
  });

  it("rejects cross-owner scope and malformed secret-bearing destinations before the runner", function () {
    for (const input of [
      { userId: "507f1f77bcf86cd799439099" },
      { snapshot: snapshot({ projectId: "507f1f77bcf86cd799439099" }) },
      {
        configuration: {
          provider: "openai-compatible",
          baseUrl: "https://localhost:43123",
          model: "mock-model",
          credential: "credential-must-not-cross\n",
        },
      },
    ]) {
      let error;
      try {
        fixture(input);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(AgentGatewayError);
      expect(error).toMatchObject({
        code: "AI_EXTERNAL_AGENT_RESULT_INVALID",
        message: "The external agent result is invalid.",
      });
      expect(error.message).not.toContain("credential-must-not-cross");
    }
  });

  it("redacts runner failures and preserves abort classification", async function () {
    const failed = fixture();
    failed.runnerClient.turn.mockRejectedValue(
      new Error("manuscript-secret credential-secret"),
    );
    const error = await failureOf(collect(failed.gateway));
    expect(error).toMatchObject({
      code: "AI_EXTERNAL_AGENT_RUNNER_FAILED",
      message: "The external agent runner failed.",
    });
    expect(error.message).not.toMatch(/manuscript-secret|credential-secret/u);

    const aborted = fixture();
    const abort = new AbortController();
    abort.abort(new DOMException("credential-secret", "AbortError"));
    const abortError = await failureOf(
      collect(aborted.gateway, request(), abort.signal),
    );
    expect(abortError).toBeInstanceOf(AgentGatewayAbortError);
    expect(abortError.message).not.toContain("credential-secret");
    expect(aborted.runnerClient.turn).not.toHaveBeenCalled();
  });

  it("reports a redacted retryable intermediate state when finalize fails", async function () {
    const agentRequest = request({ agentSessionId });
    const storedSession = session({
      clientSessionId: agentSessionId,
      mode: "agent",
      threadId: "thread-1",
    });
    const test = fixture({
      request: agentRequest,
      session: storedSession,
      claim: claim(storedSession),
    });
    test.sessionStore.finalize.mockRejectedValue(
      new Error("thread-secret credential-secret"),
    );

    const error = await failureOf(collect(test.gateway, agentRequest));

    expect(error).toMatchObject({
      code: "AI_EXTERNAL_SESSION_INTERMEDIATE_STATE",
      category: "provider",
      retryable: true,
      message: "The external agent session could not be saved.",
    });
    expect(error.message).not.toMatch(/thread-secret|credential-secret/u);
    expect(test.runnerClient.retire).toHaveBeenCalledExactlyOnceWith({
      stateRootKey: "state-key-1",
    });
  });

  it("retires an Agent runner when cancellation arrives after its response", async function () {
    const abort = new AbortController();
    const agentRequest = request({ agentSessionId });
    const storedSession = session({
      clientSessionId: agentSessionId,
      mode: "agent",
      threadId: "thread-1",
    });
    const test = fixture({
      request: agentRequest,
      session: storedSession,
      claim: claim(storedSession),
    });
    test.runnerClient.turn.mockImplementation(async () => {
      abort.abort();
      return result();
    });

    const error = await failureOf(
      collect(test.gateway, agentRequest, abort.signal),
    );

    expect(error).toBeInstanceOf(AgentGatewayAbortError);
    expect(test.sessionStore.finalize).not.toHaveBeenCalled();
    expect(test.runnerClient.retire).toHaveBeenCalledExactlyOnceWith({
      stateRootKey: "state-key-1",
    });
  });

  it("retires an Agent runner when its validated event stream is abandoned", async function () {
    const agentRequest = request({ agentSessionId });
    const storedSession = session({
      clientSessionId: agentSessionId,
      mode: "agent",
      threadId: "thread-1",
    });
    const test = fixture({
      request: agentRequest,
      session: storedSession,
      claim: claim(storedSession),
    });
    const iterator = test.gateway.stream(agentRequest)[Symbol.asyncIterator]();

    expect(await iterator.next()).toMatchObject({
      value: { type: "started" },
    });
    await iterator.return();

    expect(test.runnerClient.retire).toHaveBeenCalledExactlyOnceWith({
      stateRootKey: "state-key-1",
    });
  });

  it("redacts a failure to retire an invalid Agent runner result", async function () {
    const agentRequest = request({ agentSessionId });
    const storedSession = session({
      clientSessionId: agentSessionId,
      mode: "agent",
      threadId: "thread-1",
    });
    const test = fixture({
      request: agentRequest,
      session: storedSession,
      claim: claim(storedSession),
      result: result({ threadId: "wrong-thread" }),
    });
    test.runnerClient.retire.mockRejectedValue(
      new Error("credential-secret /private/path"),
    );

    const error = await failureOf(collect(test.gateway, agentRequest));

    expect(error).toMatchObject({
      code: "AI_EXTERNAL_AGENT_RUNNER_FAILED",
      message: "The external agent runner failed.",
    });
    expect(error.message).not.toMatch(/credential-secret|private/iu);
  });
});
