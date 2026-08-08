import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { AiReviewerExternalAgentSessionConflictError } from "../../../../ai-reviewer/app/src/ExternalAgentSessionStore.mjs";
import {
  dryRunAiReviewerHistory,
  executePurgeBatch,
  purgeAiReviewerHistory,
} from "../../../app/src/AiReviewerHistoryAdminController.mjs";

vi.mock("../../../../../app/src/infrastructure/LockManager.mjs", () => ({
  default: { promises: { runWithLock: vi.fn() } },
}));

const plannedAt = Date.parse("2026-08-08T00:00:00.000Z");
const criteria = Object.freeze({
  status: "resolved",
  inactivity: "180d",
  minimumSize: "10mib",
});
const summary = Object.freeze({
  statuses: [
    { key: "active", count: 1, bytes: 10 },
    { key: "resolved", count: 2, bytes: 20 },
    { key: "purge_failed", count: 0, bytes: 0 },
  ],
  inactivity: [
    { key: "90d", count: 3, bytes: 30 },
    { key: "180d", count: 2, bytes: 20 },
    { key: "365d", count: 1, bytes: 10 },
  ],
  minimumSize: [
    { key: "any", count: 3, bytes: 30 },
    { key: "10mib", count: 2, bytes: 20 },
    { key: "100mib", count: 0, bytes: 0 },
    { key: "1gib", count: 0, bytes: 0 },
  ],
});
const forbiddenKeys = new Set([
  "userId",
  "email",
  "projectId",
  "projectName",
  "clientSessionId",
  "sessionId",
  "threadId",
  "stateRootKey",
  "connectionFingerprint",
  "documentId",
  "documentPath",
  "documentText",
  "endpoint",
  "model",
  "title",
  "prompt",
  "response",
  "suggestion",
  "content",
  "text",
]);

function expectAggregateOnly(value) {
  if (Array.isArray(value)) {
    for (const item of value) expectAggregateOnly(item);
    return;
  }
  if (value == null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    expect(forbiddenKeys.has(key), `forbidden key: ${key}`).toBe(false);
    expectAggregateOnly(child);
  }
}

function session(plan) {
  return {
    user: { _id: "admin-id" },
    ...(plan == null ? {} : { aiReviewerHistoryPurgePlan: plan }),
    reload: vi.fn((callback) => callback()),
    save: vi.fn((callback) => callback()),
  };
}

function response() {
  const res = {
    render: vi.fn(),
    status: vi.fn(() => res),
  };
  return res;
}

function dependencies(overrides = {}) {
  return {
    auditLog: { promises: { addEntry: vi.fn(async () => {}) } },
    createNonce: () => "opaque-plan-nonce",
    now: () => plannedAt,
    operationTimeoutSignalFactory: () => new AbortController().signal,
    purge: vi.fn(async () => {}),
    runWithLock: vi.fn(async (_nonce, work) => await work()),
    runnerClient: {},
    sessionStore: {
      loadPurgeBatch: vi.fn(async () => []),
      previewPurge: vi.fn(async () => ({ count: 2, bytes: 20 })),
      summarizeForPurge: vi.fn(async () => summary),
    },
    ...overrides,
  };
}

function plan(overrides = {}) {
  return {
    criteria,
    plannedAt,
    count: 2,
    bytes: 20,
    nonce: "opaque-plan-nonce",
    ...overrides,
  };
}

function dryRunRequest(overrides = {}) {
  return {
    body: {
      _csrf: "csrf-token",
      status: criteria.status,
      inactivity: criteria.inactivity,
      minimumSize: criteria.minimumSize,
    },
    ip: "127.0.0.1",
    session: session(),
    ...overrides,
  };
}

function purgeRequest(inputPlan = plan(), overrides = {}) {
  return {
    body: {
      _csrf: "csrf-token",
      nonce: inputPlan.nonce,
      count: String(inputPlan.count),
      bytes: String(inputPlan.bytes),
      confirmation:
        inputPlan.criteria.status === "active" ? "PURGE ACTIVE" : "PURGE",
    },
    ip: "127.0.0.1",
    sessionID: "cookie-session-secret",
    session: session(inputPlan),
    ...overrides,
  };
}

async function failureOf(work) {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject.");
}

describe("AiReviewerHistoryAdminController", function () {
  it("keeps CSRF and irreversible backup warnings in the server-rendered form", function () {
    const view = readFileSync(
      new URL("../../../app/views/ai-reviewer-history.pug", import.meta.url),
      "utf8",
    );

    expect(view).toContain('input(name="_csrf"');
    expect(view).toContain("Purging is irreversible in live storage.");
    expect(view).toContain("backup retention period expires");
    expect(view).toContain("Recovered for retry");
  });

  it("stores only the aggregate five-field dry-run plan", async function () {
    const deps = dependencies();
    const req = dryRunRequest();
    const res = response();

    await dryRunAiReviewerHistory(req, res, deps);

    expect(req.session.aiReviewerHistoryPurgePlan).toEqual(plan());
    expect(Object.keys(req.session.aiReviewerHistoryPurgePlan)).toEqual([
      "criteria",
      "plannedAt",
      "count",
      "bytes",
      "nonce",
    ]);
    expect(req.session.save).toHaveBeenCalledOnce();
    expect(deps.auditLog.promises.addEntry).toHaveBeenCalledWith(
      "admin-id",
      "ai-reviewer-history-purge-dry-run",
      "admin-id",
      "127.0.0.1",
      { criteria, plannedAt, count: 2, bytes: 20 },
    );
    expect(res.render).toHaveBeenCalledOnce();

    const exposed = JSON.stringify({
      plan: req.session.aiReviewerHistoryPurgePlan,
      render: res.render.mock.calls[0][1],
      audit: deps.auditLog.promises.addEntry.mock.calls[0][4],
    });
    for (const forbidden of [
      "user-secret",
      "project-secret",
      "session-secret",
      "thread-secret",
      "state-root-secret",
      "document-marker-secret",
    ]) {
      expect(exposed).not.toContain(forbidden);
    }
    const renderLocals = res.render.mock.calls[0][1];
    expect(Object.keys(renderLocals)).toEqual([
      "title",
      "options",
      "summary",
      "plan",
      "result",
    ]);
    expectAggregateOnly({
      options: renderLocals.options,
      summary: renderLocals.summary,
      plan: renderLocals.plan,
      result: renderLocals.result,
      audit: deps.auditLog.promises.addEntry.mock.calls[0][4],
    });
  });

  it("rejects arbitrary criteria before Mongo or session writes", async function () {
    const deps = dependencies();
    const req = dryRunRequest();
    req.body.days = "181";

    expect(
      await failureOf(dryRunAiReviewerHistory(req, response(), deps)),
    ).toMatchObject({ message: "Invalid AI history purge request." });
    expect(deps.sessionStore.previewPurge).not.toHaveBeenCalled();
    expect(req.session.save).not.toHaveBeenCalled();
  });

  it("executes at most 10 purges sequentially", async function () {
    const candidates = Array.from({ length: 12 }, (_, index) => ({
      stateBytes: index + 1,
      userId: `user-secret-${index}`,
      projectId: `project-secret-${index}`,
      clientSessionId: `session-secret-${index}`,
    }));
    let active = 0;
    let maximumActive = 0;
    const purge = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await Promise.resolve();
      active -= 1;
    });
    const deps = dependencies({
      purge,
      sessionStore: {
        previewPurge: vi.fn(async () => ({ count: 12, bytes: 78 })),
        loadPurgeBatch: vi.fn(async () => candidates),
      },
    });

    expect(
      await executePurgeBatch(plan({ count: 12, bytes: 78 }), deps),
    ).toEqual({
      outcome: "completed",
      plannedCount: 12,
      plannedBytes: 78,
      matchedCount: 12,
      matchedBytes: 78,
      deletedCount: 10,
      deletedBytes: 55,
      recoveredCount: 0,
      skippedCount: 0,
      failedCount: 0,
      remainingCount: 2,
      remainingBytes: 23,
    });
    expect(purge).toHaveBeenCalledTimes(10);
    expect(purge.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
    expect(new Set(purge.mock.calls.map(([input]) => input.signal)).size).toBe(
      1,
    );
    expect(maximumActive).toBe(1);
  });

  it("stops before another claim when the batch timeout expires", async function () {
    const deps = dependencies({
      operationTimeoutSignalFactory: () => AbortSignal.abort(),
      sessionStore: {
        previewPurge: vi.fn(async () => ({ count: 1, bytes: 20 })),
        loadPurgeBatch: vi.fn(async () => [{ stateBytes: 20 }]),
      },
    });

    expect(
      await executePurgeBatch(plan({ count: 1, bytes: 20 }), deps),
    ).toMatchObject({
      deletedCount: 0,
      recoveredCount: 0,
      skippedCount: 1,
      failedCount: 0,
      remainingCount: 1,
      remainingBytes: 20,
    });
    expect(deps.purge).not.toHaveBeenCalled();
  });

  it("skips a lost CAS, counts a partial failure, and continues", async function () {
    const candidates = [10, 20, 30].map((stateBytes, index) => ({
      stateBytes,
      clientSessionId: `session-secret-${index}`,
    }));
    const purge = vi
      .fn()
      .mockRejectedValueOnce(new AiReviewerExternalAgentSessionConflictError())
      .mockRejectedValueOnce(new Error("fixed partial failure"))
      .mockResolvedValueOnce();
    const deps = dependencies({
      purge,
      sessionStore: {
        previewPurge: vi.fn(async () => ({ count: 3, bytes: 60 })),
        loadPurgeBatch: vi.fn(async () => candidates),
      },
    });

    expect(
      await executePurgeBatch(plan({ count: 3, bytes: 60 }), deps),
    ).toMatchObject({
      outcome: "completed",
      deletedCount: 1,
      deletedBytes: 30,
      skippedCount: 1,
      failedCount: 1,
      remainingCount: 2,
      remainingBytes: 30,
    });
    expect(purge).toHaveBeenCalledTimes(3);
  });

  it("recovers a stale purge claim without repeating deletion", async function () {
    const candidate = {
      stateBytes: 20,
      operationClaim: {
        id: "stale-claim",
        type: "purge",
        claimedAt: new Date(plannedAt - 20 * 60 * 1_000),
      },
    };
    const recoverStalePurgeClaim = vi.fn(async () => {});
    const deps = dependencies({
      sessionStore: {
        previewPurge: vi.fn(async () => ({ count: 1, bytes: 20 })),
        loadPurgeBatch: vi.fn(async () => [candidate]),
        recoverStalePurgeClaim,
      },
    });

    expect(
      await executePurgeBatch(plan({ count: 1, bytes: 20 }), deps),
    ).toMatchObject({
      outcome: "completed",
      deletedCount: 0,
      recoveredCount: 1,
      failedCount: 0,
      remainingCount: 1,
      remainingBytes: 20,
    });
    expect(recoverStalePurgeClaim).toHaveBeenCalledWith({
      session: candidate,
      plannedAt,
    });
    expect(deps.purge).not.toHaveBeenCalled();
  });

  it("does not purge when the aggregate changed after dry run", async function () {
    const deps = dependencies({
      sessionStore: {
        previewPurge: vi.fn(async () => ({ count: 1, bytes: 10 })),
        loadPurgeBatch: vi.fn(),
      },
    });

    expect(await executePurgeBatch(plan(), deps)).toMatchObject({
      outcome: "stale",
      deletedCount: 0,
      matchedCount: 1,
      matchedBytes: 10,
    });
    expect(deps.sessionStore.loadPurgeBatch).not.toHaveBeenCalled();
    expect(deps.purge).not.toHaveBeenCalled();
  });

  it("requires the stronger active confirmation", async function () {
    const activePlan = plan({ criteria: { ...criteria, status: "active" } });
    const req = purgeRequest(activePlan);
    req.body.confirmation = "PURGE";
    const deps = dependencies();

    expect(
      await failureOf(purgeAiReviewerHistory(req, response(), deps)),
    ).toMatchObject({ message: "Invalid AI history purge request." });
    expect(req.session.aiReviewerHistoryPurgePlan).toEqual(activePlan);
    expect(req.session.save).not.toHaveBeenCalled();
    expect(deps.sessionStore.loadPurgeBatch).not.toHaveBeenCalled();
  });

  it("consumes the plan before execute and audits aggregate results only", async function () {
    const calls = [];
    const candidate = {
      stateBytes: 20,
      userId: "user-secret",
      projectId: "project-secret",
      clientSessionId: "session-secret",
      threadId: "thread-secret",
      stateRootKey: "state-root-secret",
    };
    const deps = dependencies({
      auditLog: {
        promises: {
          addEntry: vi.fn(async (_adminId, operation) => calls.push(operation)),
        },
      },
      now: vi
        .fn()
        .mockReturnValueOnce(plannedAt + 1_000)
        .mockReturnValueOnce(plannedAt + 2_000),
      purge: vi.fn(async () => calls.push("purge")),
      sessionStore: {
        previewPurge: vi.fn(async () => ({ count: 1, bytes: 20 })),
        loadPurgeBatch: vi.fn(async () => [candidate]),
        summarizeForPurge: vi.fn(async () => summary),
      },
    });
    const inputPlan = plan({ count: 1 });
    const req = purgeRequest(inputPlan);
    req.session.save = vi.fn((callback) => {
      calls.push("save");
      callback();
    });
    const res = response();

    await purgeAiReviewerHistory(req, res, deps);

    expect(calls).toEqual([
      "save",
      "ai-reviewer-history-purge-execute-start",
      "purge",
      "ai-reviewer-history-purge-execute-complete",
    ]);
    expect(req.session).not.toHaveProperty("aiReviewerHistoryPurgePlan");
    const auditInfo = deps.auditLog.promises.addEntry.mock.calls.find(
      ([, operation]) =>
        operation === "ai-reviewer-history-purge-execute-complete",
    )[4];
    expect(auditInfo).toMatchObject({
      criteria,
      planned: { count: 1, bytes: 20 },
      matched: { count: 1, bytes: 20 },
      deleted: { count: 1, bytes: 20 },
      recoveredCount: 0,
      skippedCount: 0,
      failedCount: 0,
      remaining: { count: 0, bytes: 0 },
      outcome: "completed",
    });
    const exposed = JSON.stringify({
      auditInfo,
      render: res.render.mock.calls[0][1],
    });
    for (const forbidden of Object.values(candidate).filter(
      (value) => typeof value === "string",
    )) {
      expect(exposed).not.toContain(forbidden);
    }
    expectAggregateOnly({
      audits: deps.auditLog.promises.addEntry.mock.calls.map((call) => call[4]),
      result: res.render.mock.calls[0][1].result,
    });
  });

  it("does not purge when the required start audit fails", async function () {
    const deps = dependencies({
      auditLog: {
        promises: {
          addEntry: vi.fn(async (_adminId, operation) => {
            if (operation === "ai-reviewer-history-purge-execute-start") {
              throw new Error("fixed audit failure");
            }
          }),
        },
      },
    });
    const req = purgeRequest();

    expect(
      await failureOf(purgeAiReviewerHistory(req, response(), deps)),
    ).toMatchObject({ message: "fixed audit failure" });
    expect(req.session).not.toHaveProperty("aiReviewerHistoryPurgePlan");
    expect(req.session.save).toHaveBeenCalledOnce();
    expect(deps.sessionStore.previewPurge).not.toHaveBeenCalled();
    expect(deps.sessionStore.loadPurgeBatch).not.toHaveBeenCalled();
    expect(deps.purge).not.toHaveBeenCalled();
  });

  it.each(["lock", "reload", "save"])(
    "does not purge when session %s fails",
    async function (failurePoint) {
      const failure = new Error(`fixed ${failurePoint} failure`);
      const deps = dependencies(
        failurePoint === "lock"
          ? { runWithLock: vi.fn(async () => Promise.reject(failure)) }
          : {},
      );
      const req = purgeRequest();
      if (failurePoint === "reload") {
        req.session.reload = vi.fn((callback) => callback(failure));
      }
      if (failurePoint === "save") {
        req.session.save = vi.fn((callback) => callback(failure));
      }

      expect(
        await failureOf(purgeAiReviewerHistory(req, response(), deps)),
      ).toBe(failure);
      expect(deps.sessionStore.previewPurge).not.toHaveBeenCalled();
      expect(deps.sessionStore.loadPurgeBatch).not.toHaveBeenCalled();
      expect(deps.purge).not.toHaveBeenCalled();
    },
  );

  it("consumes one plan once across concurrent confirmation requests", async function () {
    const candidates = Array.from({ length: 12 }, (_, index) => ({
      stateBytes: index + 1,
      userId: `user-secret-${index}`,
      projectId: `project-secret-${index}`,
      clientSessionId: `session-secret-${index}`,
    }));
    let storedPlan = structuredClone(plan({ count: 12, bytes: 78 }));
    let lockTail = Promise.resolve();
    const deps = dependencies({
      purge: vi.fn(async () => {}),
      runWithLock: vi.fn((_nonce, work) => {
        const result = lockTail.then(work);
        lockTail = result.catch(() => {});
        return result;
      }),
      sessionStore: {
        previewPurge: vi.fn(async () => ({ count: 12, bytes: 78 })),
        loadPurgeBatch: vi.fn(async () => candidates),
        summarizeForPurge: vi.fn(async () => summary),
      },
    });
    const requests = [0, 1].map(() => {
      const req = purgeRequest(structuredClone(storedPlan));
      req.session.reload = vi.fn((callback) => {
        if (storedPlan == null) {
          delete req.session.aiReviewerHistoryPurgePlan;
        } else {
          req.session.aiReviewerHistoryPurgePlan = structuredClone(storedPlan);
        }
        callback();
      });
      req.session.save = vi.fn((callback) => {
        storedPlan = req.session.aiReviewerHistoryPurgePlan
          ? structuredClone(req.session.aiReviewerHistoryPurgePlan)
          : null;
        callback();
      });
      return req;
    });

    const outcomes = await Promise.allSettled(
      requests.map((req) => purgeAiReviewerHistory(req, response(), deps)),
    );

    expect(outcomes.map(({ status }) => status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(deps.runWithLock).toHaveBeenCalledTimes(2);
    const lockIds = deps.runWithLock.mock.calls.map(([lockId]) => lockId);
    expect(new Set(lockIds).size).toBe(1);
    expect(lockIds[0]).toMatch(/^[a-f0-9]{64}$/u);
    expect(lockIds[0]).not.toContain("cookie-session-secret");
    expect(lockIds[0]).not.toContain("opaque-plan-nonce");
    expect(deps.purge).toHaveBeenCalledTimes(10);
  });

  it("expires and consumes a plan after 10 minutes", async function () {
    const deps = dependencies({ now: () => plannedAt + 10 * 60 * 1_000 + 1 });
    const req = purgeRequest();

    expect(
      await failureOf(purgeAiReviewerHistory(req, response(), deps)),
    ).toMatchObject({ message: "Invalid AI history purge request." });
    expect(req.session).not.toHaveProperty("aiReviewerHistoryPurgePlan");
    expect(req.session.save).toHaveBeenCalledOnce();
    expect(deps.sessionStore.previewPurge).not.toHaveBeenCalled();
  });
});
