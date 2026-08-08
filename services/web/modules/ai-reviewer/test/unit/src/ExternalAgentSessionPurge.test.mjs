import { describe, expect, it, vi } from "vitest";

import {
  AiReviewerExternalAgentSessionPurgeError,
  purgeExternalAgentSession,
} from "../../../app/src/ExternalAgentSessionPurge.mjs";

const session = Object.freeze({
  userId: "000000000000000000000001",
  projectId: "100000000000000000000001",
  clientSessionId: "client-session-1",
  threadId: "thread-1",
  stateRootKey: "state-root-1",
  status: "resolved",
  lastActivityAt: new Date("2026-08-07T00:00:00.000Z"),
  revision: 6,
});

function fixture({ candidate = session, failAt, failFinalize = false } = {}) {
  const calls = [];
  let finalizeAttempts = 0;
  const claim = {
    ...candidate,
    status: "purge_failed",
    revision: 7,
    operationClaim: { id: "purge-claim-1", type: "purge" },
  };
  const failure = new Error("fixed internal failure");
  const sessionStore = {
    claim: vi.fn(async (input) => {
      calls.push(["claim", input]);
      if (failAt === "claim") throw failure;
      return claim;
    }),
    deleteClaimedPurge: vi.fn(async (input) => {
      calls.push(["delete-record", input]);
      if (failAt === "delete-record") throw failure;
    }),
    finalize: vi.fn(async (input) => {
      calls.push(["purge-failed", input]);
      finalizeAttempts += 1;
      if (
        failFinalize === true ||
        (failFinalize === "once" && finalizeAttempts === 1)
      ) {
        throw new Error("fixed finalize failure");
      }
    }),
  };
  const runnerClient = {
    purge: vi.fn(async (input) => {
      calls.push(["runner-purge", input]);
      if (failAt === "runner-purge") throw failure;
    }),
  };
  return { calls, failure, runnerClient, sessionStore };
}

async function failureOf(work) {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to fail.");
}

describe("ExternalAgentSessionPurge", function () {
  it("keeps the destructive order inside one purge claim", async function () {
    const state = fixture();

    expect(
      await purgeExternalAgentSession({
        session,
        sessionStore: state.sessionStore,
        runnerClient: state.runnerClient,
      }),
    ).toBeUndefined();

    expect(state.calls.map(([name]) => name)).toEqual([
      "claim",
      "runner-purge",
      "delete-record",
    ]);
    expect(state.sessionStore.claim).toHaveBeenCalledWith({
      userId: session.userId,
      projectId: session.projectId,
      clientSessionId: session.clientSessionId,
      type: "purge",
      expectedRevision: session.revision,
      expectedStatus: session.status,
      expectedLastActivityAt: session.lastActivityAt,
      expectedThreadId: session.threadId,
    });
    expect(state.runnerClient.purge).toHaveBeenCalledWith(
      {
        stateRootKey: session.stateRootKey,
        threadId: session.threadId,
      },
      { signal: undefined },
    );
    expect(state.sessionStore.deleteClaimedPurge).toHaveBeenCalledWith({
      userId: session.userId,
      projectId: session.projectId,
      clientSessionId: session.clientSessionId,
      claimId: "purge-claim-1",
      expectedRevision: 7,
      expectedStatus: "purge_failed",
      expectedLastActivityAt: session.lastActivityAt,
      expectedThreadId: session.threadId,
      stateRootKey: session.stateRootKey,
    });
    expect(state.sessionStore.finalize).not.toHaveBeenCalled();
  });

  it.each(["runner-purge", "delete-record"])(
    "records purge_failed after a %s failure without masking it",
    async function (failAt) {
      const state = fixture({ failAt, failFinalize: true });

      const error = await failureOf(
        purgeExternalAgentSession({
          session,
          sessionStore: state.sessionStore,
          runnerClient: state.runnerClient,
        }),
      );
      expect(error).toBeInstanceOf(AiReviewerExternalAgentSessionPurgeError);
      expect(error.cause).toBe(state.failure);

      expect(state.calls.at(-1)).toEqual([
        "purge-failed",
        {
          userId: session.userId,
          projectId: session.projectId,
          clientSessionId: session.clientSessionId,
          claimId: "purge-claim-1",
          expectedRevision: 7,
          type: "purge",
        },
      ]);
      expect(state.sessionStore.deleteClaimedPurge).toHaveBeenCalledTimes(
        failAt === "delete-record" ? 1 : 0,
      );
      expect(state.sessionStore.finalize).toHaveBeenCalledTimes(2);
    },
  );

  it("retries one transient purge_failed finalization", async function () {
    const state = fixture({ failAt: "runner-purge", failFinalize: "once" });

    const error = await failureOf(
      purgeExternalAgentSession({
        session,
        sessionStore: state.sessionStore,
        runnerClient: state.runnerClient,
      }),
    );

    expect(error).toBeInstanceOf(AiReviewerExternalAgentSessionPurgeError);
    expect(error.cause).toBe(state.failure);
    expect(state.sessionStore.finalize).toHaveBeenCalledTimes(2);
  });

  it("does not reach the runner when the CAS claim loses", async function () {
    const state = fixture({ failAt: "claim" });

    expect(
      await failureOf(
        purgeExternalAgentSession({
          session,
          sessionStore: state.sessionStore,
          runnerClient: state.runnerClient,
        }),
      ),
    ).toBe(state.failure);
    expect(state.runnerClient.purge).not.toHaveBeenCalled();
    expect(state.sessionStore.finalize).not.toHaveBeenCalled();
  });

  it("passes a threadless claim through the same destructive boundary", async function () {
    const candidate = { ...session, threadId: null };
    const state = fixture({ candidate });

    await purgeExternalAgentSession({
      session: candidate,
      sessionStore: state.sessionStore,
      runnerClient: state.runnerClient,
    });

    expect(state.runnerClient.purge).toHaveBeenCalledWith(
      {
        stateRootKey: candidate.stateRootKey,
        threadId: null,
      },
      { signal: undefined },
    );
  });
});
