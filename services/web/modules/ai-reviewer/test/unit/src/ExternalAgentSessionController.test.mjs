import { describe, expect, it, vi } from "vitest";
import { createExternalAgentSessionController } from "../../../app/src/ExternalAgentSessionController.mjs";
import { AiReviewerExternalAgentSessionNotFoundError } from "../../../app/src/ExternalAgentSessionStore.mjs";

vi.mock("../../../app/src/RequestScopeReader.mjs", () => ({
  authenticatedUserId(request) {
    return request.user._id.toString();
  },
}));

vi.mock("../../../app/src/ExternalAgentSessionStore.mjs", () => {
  class AiReviewerExternalAgentSessionValidationError extends TypeError {}
  class AiReviewerExternalAgentSessionNotFoundError extends Error {}
  class AiReviewerExternalAgentSessionConflictError extends Error {}
  return {
    AiReviewerExternalAgentSessionValidationError,
    AiReviewerExternalAgentSessionNotFoundError,
    AiReviewerExternalAgentSessionConflictError,
  };
});

const userId = "000000000000000000000001";
const otherUserId = "000000000000000000000002";
const projectId = "100000000000000000000001";
const otherProjectId = "100000000000000000000002";
const clientSessionId = "client-session-1";
const threadId = "thread-secret-1";
const stateRootKey = "state-root-secret-1";
const connectionFingerprint = "fingerprint-secret-1";
const claimId = "claim-secret-1";
const lastActivityAt = new Date("2026-08-07T00:00:00.000Z");

const intermediateError = {
  error: {
    code: "AI_EXTERNAL_SESSION_INTERMEDIATE_STATE",
    message:
      "The external AI reviewer session has an unfinished operation. Reload before trying again.",
    retryable: true,
  },
};

function session(overrides = {}) {
  return {
    id: "mongo-secret-1",
    userId,
    projectId,
    clientSessionId,
    mode: "agent",
    threadId,
    stateRootKey,
    connectionFingerprint,
    status: "active",
    lastActivityAt,
    stateBytes: 123,
    revision: 4,
    operationClaim: null,
    ...overrides,
  };
}

function request({
  body,
  authenticatedUserId = userId,
  routedProjectId = projectId,
  routedSessionId = clientSessionId,
} = {}) {
  return {
    body,
    params: {
      project_id: routedProjectId,
      agent_session_id: routedSessionId,
    },
    user: {
      _id: {
        toString: () => authenticatedUserId,
      },
    },
  };
}

class FakeResponse {
  statusCode = 200;
  body = undefined;

  status(statusCode) {
    this.statusCode = statusCode;
    return this;
  }

  json(body) {
    this.body = body;
    return this;
  }
}

function expectNoSecrets(value, additionalSecrets = []) {
  const serialized = JSON.stringify(value);
  for (const secret of [
    "threadId",
    "stateRootKey",
    "connectionFingerprint",
    "operationClaim",
    threadId,
    stateRootKey,
    connectionFingerprint,
    claimId,
    ...additionalSecrets,
  ]) {
    expect(serialized).not.toContain(secret);
  }
}

function lifecycleFixture({ type, failAt } = {}) {
  const finalStatus = type === "resolve" ? "resolved" : "active";
  const calls = [];
  const operationSignal = new AbortController().signal;
  let current = session({
    status: type === "resolve" ? "active" : "resolved",
  });
  const sessionStore = {
    load: vi.fn(async () => {
      calls.push("load");
      return current;
    }),
    claim: vi.fn(async () => {
      calls.push("claim");
      current = {
        ...current,
        revision: current.revision + 1,
        operationClaim: {
          id: claimId,
          type,
          claimedAt: new Date("2026-08-07T00:01:00.000Z"),
        },
      };
      return current;
    }),
    finalize: vi.fn(async () => {
      calls.push("finalize");
      if (failAt === "finalize") {
        throw new Error("FINALIZE_FAILURE_SECRET");
      }
      current = {
        ...current,
        status: finalStatus,
        lastActivityAt: new Date("2026-08-07T00:02:00.000Z"),
        stateBytes: 456,
        revision: current.revision + 1,
        operationClaim: null,
      };
      return current;
    }),
  };
  const runnerClient = {
    archive: vi.fn(async () => {
      calls.push("archive");
      if (failAt === "runner") {
        throw new Error("RUNNER_FAILURE_SECRET");
      }
      return { stateBytes: 456 };
    }),
    unarchive: vi.fn(async () => {
      calls.push("unarchive");
      if (failAt === "runner") {
        throw new Error("RUNNER_FAILURE_SECRET");
      }
      return { stateBytes: 456 };
    }),
  };
  return {
    calls,
    controller: createExternalAgentSessionController({
      sessionStore,
      runnerClient,
      operationTimeoutSignalFactory: () => operationSignal,
    }),
    current: () => current,
    operationSignal,
    runnerClient,
    sessionStore,
  };
}

describe("ExternalAgentSessionController", function () {
  it("returns only the safe public session projection", async function () {
    const stored = session({
      operationClaim: {
        id: claimId,
        type: "turn",
        claimedAt: new Date("2026-08-07T00:00:30.000Z"),
      },
    });
    const sessionStore = { load: vi.fn(async () => stored) };
    const runnerClient = { archive: vi.fn(), unarchive: vi.fn() };
    const controller = createExternalAgentSessionController({
      sessionStore,
      runnerClient,
    });
    const response = new FakeResponse();

    await controller.getSession(request(), response);

    expect(sessionStore.load).toHaveBeenCalledWith({
      userId,
      projectId,
      clientSessionId,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      agentSessionId: clientSessionId,
      mode: "agent",
      status: "active",
      lastActivityAt: lastActivityAt.toISOString(),
      stateBytes: 123,
      revision: 4,
      operationInProgress: true,
    });
    expectNoSecrets(response.body);
  });

  it.each([
    ["another owner", otherUserId, projectId],
    ["another project", userId, otherProjectId],
  ])("returns not-found for %s", async function (_, owner, project) {
    const sessionStore = {
      load: vi.fn(async (scope) => {
        if (scope.userId !== userId || scope.projectId !== projectId) {
          throw new AiReviewerExternalAgentSessionNotFoundError();
        }
        return session();
      }),
    };
    const runnerClient = { archive: vi.fn(), unarchive: vi.fn() };
    const controller = createExternalAgentSessionController({
      sessionStore,
      runnerClient,
    });
    const response = new FakeResponse();

    await controller.getSession(
      request({ authenticatedUserId: owner, routedProjectId: project }),
      response,
    );

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({
      error: {
        code: "AI_EXTERNAL_SESSION_NOT_FOUND",
        message: "The external AI reviewer session could not be found.",
        retryable: false,
      },
    });
    expect(runnerClient.archive).not.toHaveBeenCalled();
    expect(runnerClient.unarchive).not.toHaveBeenCalled();
    expectNoSecrets(response.body);
  });

  it.each([
    undefined,
    null,
    [],
    {},
    { revision: "4" },
    { revision: -1 },
    { revision: 1.5 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { revision: 4, extra: true },
  ])("strictly rejects an invalid revision body: %j", async function (body) {
    const sessionStore = {
      load: vi.fn(),
      claim: vi.fn(),
      finalize: vi.fn(),
    };
    const runnerClient = { archive: vi.fn(), unarchive: vi.fn() };
    const controller = createExternalAgentSessionController({
      sessionStore,
      runnerClient,
    });
    const response = new FakeResponse();

    await controller.resolveSession(request({ body }), response);

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({
      error: {
        code: "AI_EXTERNAL_SESSION_INVALID",
        message: "The external AI reviewer session request is invalid.",
        retryable: false,
      },
    });
    expect(sessionStore.load).not.toHaveBeenCalled();
    expect(sessionStore.claim).not.toHaveBeenCalled();
    expect(sessionStore.finalize).not.toHaveBeenCalled();
    expect(runnerClient.archive).not.toHaveBeenCalled();
    expect(runnerClient.unarchive).not.toHaveBeenCalled();
  });

  it.each([
    ["resolve", "resolveSession", "archive", "resolved"],
    ["reopen", "reopenSession", "unarchive", "active"],
  ])(
    "%s performs load, CAS claim, credentialless runner operation, and finalize",
    async function (type, handler, runnerMethod, finalStatus) {
      const fixture = lifecycleFixture({ type });
      const response = new FakeResponse();

      await fixture.controller[handler](
        request({ body: { revision: 4 } }),
        response,
      );

      expect(fixture.calls).toEqual([
        "load",
        "claim",
        runnerMethod,
        "finalize",
      ]);
      expect(fixture.sessionStore.load).toHaveBeenCalledWith({
        userId,
        projectId,
        clientSessionId,
      });
      expect(fixture.sessionStore.claim).toHaveBeenCalledWith({
        userId,
        projectId,
        clientSessionId,
        type,
        expectedRevision: 4,
        expectedThreadId: threadId,
      });
      expect(fixture.runnerClient[runnerMethod]).toHaveBeenCalledWith(
        {
          stateRootKey,
          threadId,
        },
        { signal: fixture.operationSignal },
      );
      expect(fixture.sessionStore.finalize).toHaveBeenCalledWith({
        userId,
        projectId,
        clientSessionId,
        type,
        claimId,
        expectedRevision: 5,
        stateBytes: 456,
      });
      expect(fixture.runnerClient[runnerMethod]).toHaveBeenCalledTimes(1);
      expect(
        fixture.runnerClient[type === "resolve" ? "unarchive" : "archive"],
      ).not.toHaveBeenCalled();
      expect(response.statusCode).toBe(200);
      expect(response.body).toEqual({
        agentSessionId: clientSessionId,
        mode: "agent",
        status: finalStatus,
        lastActivityAt: "2026-08-07T00:02:00.000Z",
        stateBytes: 456,
        revision: 6,
        operationInProgress: false,
      });
      expectNoSecrets(response.body);
    },
  );

  it.each([
    ["resolve", "resolveSession", "active"],
    ["reopen", "reopenSession", "resolved"],
  ])(
    "%s rejects an existing active claim before the runner",
    async function (type, handler, status) {
      const sessionStore = {
        load: vi.fn(async () =>
          session({
            status,
            operationClaim: {
              id: claimId,
              type,
              claimedAt: new Date("2026-08-07T00:01:00.000Z"),
            },
          }),
        ),
        claim: vi.fn(),
        finalize: vi.fn(),
      };
      const runnerClient = { archive: vi.fn(), unarchive: vi.fn() };
      const controller = createExternalAgentSessionController({
        sessionStore,
        runnerClient,
      });
      const response = new FakeResponse();

      await controller[handler](request({ body: { revision: 4 } }), response);

      expect(response.statusCode).toBe(409);
      expect(response.body).toEqual(intermediateError);
      expect(sessionStore.claim).not.toHaveBeenCalled();
      expect(sessionStore.finalize).not.toHaveBeenCalled();
      expect(runnerClient.archive).not.toHaveBeenCalled();
      expect(runnerClient.unarchive).not.toHaveBeenCalled();
      expectNoSecrets(response.body);
    },
  );

  it.each([
    ["runner", ["load", "claim", "archive"]],
    ["finalize", ["load", "claim", "archive", "finalize"]],
  ])(
    "keeps the claim and returns a typed intermediate error after %s failure",
    async function (failAt, expectedCalls) {
      const fixture = lifecycleFixture({ type: "resolve", failAt });
      const response = new FakeResponse();

      await fixture.controller.resolveSession(
        request({ body: { revision: 4 } }),
        response,
      );

      expect(fixture.calls).toEqual(expectedCalls);
      expect(fixture.current().operationClaim).toMatchObject({
        id: claimId,
        type: "resolve",
      });
      expect(response.statusCode).toBe(409);
      expect(response.body).toEqual(intermediateError);
      expectNoSecrets(response.body, [
        "RUNNER_FAILURE_SECRET",
        "FINALIZE_FAILURE_SECRET",
      ]);
    },
  );

  it.each(["getSession", "resolveSession", "reopenSession"])(
    "returns fixed not-found from %s when the external harness is disabled",
    async function (handler) {
      const sessionStore = {
        load: vi.fn(),
        claim: vi.fn(),
        finalize: vi.fn(),
      };
      const runnerClient = { archive: vi.fn(), unarchive: vi.fn() };
      const operationTimeoutSignalFactory = vi.fn();
      const controller = createExternalAgentSessionController({
        sessionStore,
        runnerClient,
        enabled: false,
        operationTimeoutSignalFactory,
      });
      const response = new FakeResponse();

      await controller[handler](request(), response);

      expect(response.statusCode).toBe(404);
      expect(response.body).toEqual({
        error: {
          code: "AI_EXTERNAL_SESSION_NOT_FOUND",
          message: "The external AI reviewer session could not be found.",
          retryable: false,
        },
      });
      expect(sessionStore.load).not.toHaveBeenCalled();
      expect(sessionStore.claim).not.toHaveBeenCalled();
      expect(sessionStore.finalize).not.toHaveBeenCalled();
      expect(runnerClient.archive).not.toHaveBeenCalled();
      expect(runnerClient.unarchive).not.toHaveBeenCalled();
      expect(operationTimeoutSignalFactory).not.toHaveBeenCalled();
      expectNoSecrets(response.body);
    },
  );

  it("aborts a hanging runner operation and keeps the claim quarantined", async function () {
    const fixture = lifecycleFixture({ type: "resolve" });
    const timeout = new AbortController();
    fixture.runnerClient.archive.mockImplementation(
      async (_input, { signal }) =>
        await new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("ABORT_SECRET")),
            { once: true },
          );
        }),
    );
    fixture.controller = createExternalAgentSessionController({
      sessionStore: fixture.sessionStore,
      runnerClient: fixture.runnerClient,
      operationTimeoutSignalFactory: () => timeout.signal,
    });
    const response = new FakeResponse();

    const operation = fixture.controller.resolveSession(
      request({ body: { revision: 4 } }),
      response,
    );
    await vi.waitFor(() =>
      expect(fixture.runnerClient.archive).toHaveBeenCalledTimes(1),
    );
    timeout.abort();
    await operation;

    expect(fixture.sessionStore.finalize).not.toHaveBeenCalled();
    expect(fixture.current().operationClaim).toMatchObject({
      id: claimId,
      type: "resolve",
    });
    expect(response.statusCode).toBe(409);
    expect(response.body).toEqual(intermediateError);
    expectNoSecrets(response.body, ["ABORT_SECRET"]);
  });
});
