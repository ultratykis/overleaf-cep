import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  AiReviewerExternalAgentSessionValidationError,
  createExternalAgentSessionStore,
} from "../../../app/src/ExternalAgentSessionStore.mjs";

const plannedAt = new Date("2026-08-08T00:00:00.000Z");
const criteria = Object.freeze({
  status: "resolved",
  inactivity: "180d",
  minimumSize: "10mib",
});
const userId = "000000000000000000000001";
const projectId = "100000000000000000000001";
const clientSessionId = "client-session-1";

function aggregateQuery(value) {
  return { exec: vi.fn(async () => structuredClone(value)) };
}

function findQuery(value) {
  const query = {
    exec: vi.fn(async () => structuredClone(value)),
    lean: vi.fn(() => query),
    limit: vi.fn(() => query),
    read: vi.fn(() => query),
    sort: vi.fn(() => query),
  };
  return query;
}

function modelFixture({ summary, preview = [], candidates = [] } = {}) {
  const query = findQuery(candidates);
  const model = {
    aggregate: vi.fn((pipeline) =>
      aggregateQuery(pipeline[0]?.$facet == null ? preview : [summary]),
    ),
    find: vi.fn(() => query),
  };
  return {
    model,
    query,
    store: createExternalAgentSessionStore({ model }),
  };
}

function sessionRecord() {
  const id = createHash("sha256")
    .update(JSON.stringify([userId, projectId, clientSessionId]))
    .digest("hex");
  return {
    _id: id,
    userId,
    projectId,
    clientSessionId,
    mode: "agent",
    threadId: "thread-secret",
    stateRootKey: "state-secret",
    connectionFingerprint: "connection-secret",
    status: "resolved",
    lastActivityAt: new Date("2025-01-01T00:00:00.000Z"),
    stateBytes: 12_345_678,
    revision: 4,
    operationClaim: null,
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

describe("ExternalAgentSessionStore admin aggregates", function () {
  it("returns only fixed, zero-filled aggregate buckets", async function () {
    const state = modelFixture({
      summary: {
        statuses: [
          { _id: "active", count: 2, bytes: 20, userId: "do-not-return" },
          { _id: "resolved", count: 3, bytes: 30 },
        ],
        inactivity90d: [{ count: 4, bytes: 40, threadId: "do-not-return" }],
        inactivity180d: [{ count: 3, bytes: 30 }],
        inactivity365d: [],
        sizeAny: [{ count: 5, bytes: 50 }],
        size10mib: [{ count: 3, bytes: 45 }],
        size100mib: [],
        size1gib: [],
        projectId: "do-not-return",
      },
    });

    expect(await state.store.summarizeForPurge({ at: plannedAt })).toEqual({
      statuses: [
        { key: "active", count: 2, bytes: 20 },
        { key: "resolved", count: 3, bytes: 30 },
        { key: "purge_failed", count: 0, bytes: 0 },
      ],
      inactivity: [
        { key: "90d", count: 4, bytes: 40 },
        { key: "180d", count: 3, bytes: 30 },
        { key: "365d", count: 0, bytes: 0 },
      ],
      minimumSize: [
        { key: "any", count: 5, bytes: 50 },
        { key: "10mib", count: 3, bytes: 45 },
        { key: "100mib", count: 0, bytes: 0 },
        { key: "1gib", count: 0, bytes: 0 },
      ],
    });

    const pipeline = state.model.aggregate.mock.calls[0][0];
    expect(pipeline).toHaveLength(1);
    expect(Object.keys(pipeline[0].$facet)).toEqual([
      "statuses",
      "inactivity90d",
      "inactivity180d",
      "inactivity365d",
      "sizeAny",
      "size10mib",
      "size100mib",
      "size1gib",
    ]);
    expect(
      pipeline[0].$facet.inactivity180d[0].$match.lastActivityAt.$lte,
    ).toEqual(new Date("2026-02-09T00:00:00.000Z"));
  });

  it("returns zero buckets for an empty collection", async function () {
    const { store } = modelFixture();

    const result = await store.summarizeForPurge({ at: plannedAt });
    expect(result.statuses.every((bucket) => bucket.count === 0)).toBe(true);
    expect(result.inactivity.every((bucket) => bucket.bytes === 0)).toBe(true);
    expect(result.minimumSize.every((bucket) => bucket.count === 0)).toBe(true);
  });

  it("uses one exact filter for preview and the primary max-10 batch", async function () {
    const candidate = sessionRecord();
    const state = modelFixture({
      preview: [
        { count: 1, bytes: candidate.stateBytes, _id: "do-not-return" },
      ],
      candidates: [candidate],
    });

    expect(await state.store.previewPurge({ criteria, plannedAt })).toEqual({
      count: 1,
      bytes: candidate.stateBytes,
    });
    expect(
      await state.store.loadPurgeBatch({ criteria, plannedAt }),
    ).toHaveLength(1);

    const previewFilter = state.model.aggregate.mock.calls[0][0][0].$match;
    const [batchFilter, projection] = state.model.find.mock.calls[0];
    expect(batchFilter).toEqual(previewFilter);
    expect(batchFilter).toEqual({
      operationClaim: null,
      status: "resolved",
      lastActivityAt: { $lte: new Date("2026-02-09T00:00:00.000Z") },
      stateBytes: { $gte: 10 * 1024 * 1024 },
    });
    expect(Object.keys(projection).sort()).toEqual([
      "_id",
      "clientSessionId",
      "connectionFingerprint",
      "lastActivityAt",
      "mode",
      "operationClaim",
      "projectId",
      "revision",
      "stateBytes",
      "stateRootKey",
      "status",
      "threadId",
      "userId",
    ]);
    expect(state.query.sort).toHaveBeenCalledWith({
      lastActivityAt: 1,
      _id: 1,
    });
    expect(state.query.limit).toHaveBeenCalledWith(10);
    expect(state.query.read).toHaveBeenCalledWith("primary");
  });

  it("includes only old purge claims in the purge_failed recovery batch", async function () {
    const candidate = {
      ...sessionRecord(),
      status: "purge_failed",
      operationClaim: {
        id: "purge-claim",
        type: "purge",
        claimedAt: new Date("2026-08-07T23:49:59.000Z"),
      },
    };
    const failedCriteria = { ...criteria, status: "purge_failed" };
    const state = modelFixture({
      preview: [{ count: 1, bytes: candidate.stateBytes }],
      candidates: [candidate],
    });

    await state.store.previewPurge({
      criteria: failedCriteria,
      plannedAt,
    });
    await state.store.loadPurgeBatch({
      criteria: failedCriteria,
      plannedAt,
    });

    const previewFilter = state.model.aggregate.mock.calls[0][0][0].$match;
    const [batchFilter] = state.model.find.mock.calls[0];
    expect(batchFilter).toEqual(previewFilter);
    expect(previewFilter.$or).toEqual([
      { operationClaim: null },
      {
        "operationClaim.type": "purge",
        "operationClaim.claimedAt": {
          $lte: new Date("2026-08-07T23:50:00.000Z"),
        },
      },
    ]);
    expect(previewFilter.status).toBe("purge_failed");
  });

  it("rejects arbitrary criteria before querying Mongo", async function () {
    const state = modelFixture();

    expect(
      await failureOf(
        state.store.previewPurge({
          criteria: { ...criteria, days: 181 },
          plannedAt,
        }),
      ),
    ).toBeInstanceOf(AiReviewerExternalAgentSessionValidationError);
    expect(
      await failureOf(
        state.store.loadPurgeBatch({
          criteria: { ...criteria, inactivity: "181d" },
          plannedAt,
        }),
      ),
    ).toBeInstanceOf(AiReviewerExternalAgentSessionValidationError);
    expect(state.model.aggregate).not.toHaveBeenCalled();
    expect(state.model.find).not.toHaveBeenCalled();
  });

  it("fails closed when Mongo returns unsafe aggregate numbers", async function () {
    const state = modelFixture({
      preview: [{ count: 1, bytes: Number.MAX_SAFE_INTEGER + 1 }],
    });

    expect(
      await failureOf(state.store.previewPurge({ criteria, plannedAt })),
    ).toBeInstanceOf(AiReviewerExternalAgentSessionValidationError);
  });
});
