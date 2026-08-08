import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { AiReviewerExternalAgentSessionSchema } from "../../../app/models/AiReviewerExternalAgentSession.mjs";
import {
  AiReviewerExternalAgentSessionConflictError,
  AiReviewerExternalAgentSessionNotFoundError,
  AiReviewerExternalAgentSessionValidationError,
  createExternalAgentSessionStore,
} from "../../../app/src/ExternalAgentSessionStore.mjs";

const userId = "000000000000000000000001";
const otherUserId = "000000000000000000000002";
const projectId = "100000000000000000000001";
const otherProjectId = "100000000000000000000002";
const clientSessionId = "client-session-1";
const connectionFingerprint = "connection-fingerprint-1";

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function fakeQuery(work) {
  const query = { exec: vi.fn(async () => clone(await work())) };
  query.lean = vi.fn(() => query);
  return query;
}

function pathValue(value, path) {
  return path.split(".").reduce((current, part) => current?.[part], value);
}

function matchesValue(actual, expected) {
  if (actual instanceof Date && expected instanceof Date) {
    return actual.getTime() === expected.getTime();
  }
  if (
    expected != null &&
    typeof expected === "object" &&
    !Array.isArray(expected)
  ) {
    if (Object.hasOwn(expected, "$in")) {
      return expected.$in.includes(actual);
    }
    if (Object.hasOwn(expected, "$ne")) {
      return actual !== expected.$ne;
    }
  }
  return actual === expected;
}

function matches(record, filter) {
  return Object.entries(filter).every(([key, expected]) => {
    if (key === "$or") {
      return expected.some((alternative) => matches(record, alternative));
    }
    return matchesValue(pathValue(record, key), expected);
  });
}

function inMemoryModel() {
  const records = new Map();
  const model = {
    findOne: vi.fn((filter) =>
      fakeQuery(() => {
        const record = records.get(filter._id);
        return record != null && matches(record, filter) ? record : null;
      }),
    ),
    findOneAndUpdate: vi.fn((filter, update, options) =>
      fakeQuery(() => {
        const current = records.get(filter._id);
        if (current == null) {
          if (!options.upsert) {
            return null;
          }
          const inserted = clone(update.$setOnInsert);
          records.set(inserted._id, inserted);
          return inserted;
        }
        if (!matches(current, filter)) {
          if (options.upsert) {
            const error = new Error("duplicate key");
            error.code = 11000;
            throw error;
          }
          return null;
        }
        const next = clone(current);
        Object.assign(next, clone(update.$set ?? {}));
        for (const [field, increment] of Object.entries(update.$inc ?? {})) {
          next[field] += increment;
        }
        records.set(next._id, next);
        return next;
      }),
    ),
    findOneAndDelete: vi.fn((filter) =>
      fakeQuery(() => {
        const current = records.get(filter._id);
        if (current == null || !matches(current, filter)) return null;
        records.delete(filter._id);
        return current;
      }),
    ),
  };
  return { model, records };
}

function fixture() {
  const { model, records } = inMemoryModel();
  let id = 0;
  let timestamp = Date.parse("2026-08-07T00:00:00.000Z");
  const store = createExternalAgentSessionStore({
    model,
    createId: () => `server-key-${++id}`,
    now: () => new Date((timestamp += 1_000)),
  });
  return { model, records, store };
}

function sessionInput(overrides = {}) {
  return {
    userId,
    projectId,
    clientSessionId,
    mode: "agent",
    connectionFingerprint,
    ...overrides,
  };
}

function operationInput(session, type, overrides = {}) {
  return {
    userId: session.userId,
    projectId: session.projectId,
    clientSessionId: session.clientSessionId,
    type,
    expectedRevision: session.revision,
    ...(type === "purge"
      ? {
          expectedStatus: session.status,
          expectedLastActivityAt: session.lastActivityAt,
          expectedThreadId: session.threadId,
        }
      : {}),
    ...overrides,
  };
}

async function captureError(work) {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject.");
}

async function finishFirstTurn(store, session, threadId = "thread-1") {
  const claim = await store.claim(operationInput(session, "turn"));
  return await store.finalize({
    ...operationInput(claim, "turn"),
    claimId: claim.operationClaim.id,
    threadId,
    stateBytes: 123,
  });
}

describe("ExternalAgentSessionStore", function () {
  it("uses a strict, non-expiring server-owned record", function () {
    expect(AiReviewerExternalAgentSessionSchema.options.strict).toBe("throw");
    expect(AiReviewerExternalAgentSessionSchema.options.timestamps).toBe(false);
    expect(
      AiReviewerExternalAgentSessionSchema.indexes().some(
        ([, options]) => options.expireAfterSeconds != null,
      ),
    ).toBe(false);
    expect(
      AiReviewerExternalAgentSessionSchema.path("operationClaim").schema.path(
        "type",
      ).enumValues,
    ).toEqual(["turn", "resolve", "reopen", "purge"]);
  });

  it("creates an idempotent deterministic session with an opaque server key", async function () {
    const { records, store } = fixture();
    const created = await store.create({
      ...sessionInput(),
      stateRootKey: "client-controlled",
      threadId: "client-thread",
    });
    const expectedId = createHash("sha256")
      .update(JSON.stringify([userId, projectId, clientSessionId]))
      .digest("hex");

    expect(created).toMatchObject({
      id: expectedId,
      userId,
      projectId,
      clientSessionId,
      mode: "agent",
      threadId: null,
      stateRootKey: "server-key-1",
      connectionFingerprint,
      status: "active",
      stateBytes: 0,
      revision: 0,
      operationClaim: null,
    });
    expect(records.size).toBe(1);

    const retried = await store.create(sessionInput());
    expect(retried.stateRootKey).toBe("server-key-1");
    expect(records.size).toBe(1);

    for (const immutableChange of [
      { mode: "review" },
      { connectionFingerprint: "connection-fingerprint-2" },
    ]) {
      const conflict = await captureError(
        store.create(sessionInput(immutableChange)),
      );
      expect(conflict).toBeInstanceOf(
        AiReviewerExternalAgentSessionConflictError,
      );
    }
  });

  it("returns not-found without crossing user or project ownership", async function () {
    const { store } = fixture();
    await store.create(sessionInput());

    for (const attemptedScope of [
      sessionInput({ userId: otherUserId }),
      sessionInput({ projectId: otherProjectId }),
    ]) {
      const error = await captureError(store.load(attemptedScope));
      expect(error).toBeInstanceOf(AiReviewerExternalAgentSessionNotFoundError);
    }

    expect(
      await captureError(
        store.claim({
          ...operationInput(await store.load(sessionInput()), "turn"),
          userId: otherUserId,
        }),
      ),
    ).toBeInstanceOf(AiReviewerExternalAgentSessionNotFoundError);

    const claim = await store.claim(
      operationInput(await store.load(sessionInput()), "turn"),
    );
    expect(
      await captureError(
        store.finalize({
          ...operationInput(claim, "turn"),
          userId: otherUserId,
          claimId: claim.operationClaim.id,
          threadId: "thread-1",
          stateBytes: 1,
        }),
      ),
    ).toBeInstanceOf(AiReviewerExternalAgentSessionNotFoundError);
    expect((await store.load(sessionInput())).operationClaim).toEqual(
      claim.operationClaim,
    );
  });

  it("rejects revisions that cannot survive the remaining CAS increments", async function () {
    const { model, store } = fixture();
    const session = await store.create(sessionInput());

    for (const expectedRevision of [
      Number.MAX_SAFE_INTEGER - 1,
      Number.MAX_SAFE_INTEGER,
    ]) {
      expect(
        await captureError(
          store.claim({
            ...operationInput(session, "turn"),
            expectedRevision,
          }),
        ),
      ).toBeInstanceOf(AiReviewerExternalAgentSessionValidationError);
    }
    expect(
      await captureError(
        store.finalize({
          ...operationInput(session, "turn"),
          expectedRevision: Number.MAX_SAFE_INTEGER,
          claimId: "claim-at-limit",
          threadId: "thread-1",
          stateBytes: 1,
        }),
      ),
    ).toBeInstanceOf(AiReviewerExternalAgentSessionValidationError);
    expect(model.findOneAndUpdate).toHaveBeenCalledTimes(1);
  });

  it("lets only one revision-CAS claimant win and retains a failed operation claim", async function () {
    const { store } = fixture();
    const session = await store.create(sessionInput());
    const attempts = await Promise.allSettled([
      store.claim(operationInput(session, "turn")),
      store.claim(operationInput(session, "turn")),
    ]);
    const winner = attempts.find((attempt) => attempt.status === "fulfilled");
    const loser = attempts.find((attempt) => attempt.status === "rejected");

    expect(winner.status).toBe("fulfilled");
    expect(winner.value).toMatchObject({
      revision: 1,
      operationClaim: { type: "turn" },
    });
    expect(loser.status).toBe("rejected");
    expect(loser.reason).toBeInstanceOf(
      AiReviewerExternalAgentSessionConflictError,
    );

    const stillClaimed = await store.load(sessionInput());
    expect(stillClaimed.operationClaim).toEqual(winner.value.operationClaim);
    const retry = await captureError(
      store.claim(operationInput(stillClaimed, "turn")),
    );
    expect(retry).toBeInstanceOf(AiReviewerExternalAgentSessionConflictError);
  });

  it("binds the first turn thread and rejects a later thread mismatch", async function () {
    const { store } = fixture();
    const created = await store.create(sessionInput());
    const completed = await finishFirstTurn(store, created);
    expect(completed).toMatchObject({
      threadId: "thread-1",
      stateBytes: 123,
      revision: 2,
      operationClaim: null,
    });

    const mismatch = await captureError(
      store.claim(
        operationInput(completed, "turn", {
          expectedThreadId: "thread-other",
        }),
      ),
    );
    expect(mismatch).toBeInstanceOf(
      AiReviewerExternalAgentSessionConflictError,
    );

    const claim = await store.claim(
      operationInput(completed, "turn", {
        expectedThreadId: "thread-1",
      }),
    );
    const replacement = await captureError(
      store.finalize({
        ...operationInput(claim, "turn"),
        claimId: claim.operationClaim.id,
        threadId: "thread-other",
        stateBytes: 200,
      }),
    );
    expect(replacement).toBeInstanceOf(
      AiReviewerExternalAgentSessionConflictError,
    );
    expect((await store.load(sessionInput())).threadId).toBe("thread-1");
  });

  it("serializes resolve and reopen with turns through the same claim", async function () {
    const { store } = fixture();
    let session = await finishFirstTurn(
      store,
      await store.create(sessionInput()),
    );

    let claim = await store.claim(
      operationInput(session, "resolve", { expectedThreadId: "thread-1" }),
    );
    expect(
      await captureError(
        store.finalize({
          ...operationInput(claim, "resolve"),
          claimId: claim.operationClaim.id,
          threadId: "thread-other",
        }),
      ),
    ).toBeInstanceOf(AiReviewerExternalAgentSessionValidationError);
    expect((await store.load(sessionInput())).operationClaim).toEqual(
      claim.operationClaim,
    );
    session = await store.finalize({
      ...operationInput(claim, "resolve"),
      claimId: claim.operationClaim.id,
      stateBytes: 140,
    });
    expect(session).toMatchObject({
      status: "resolved",
      stateBytes: 140,
      revision: 4,
    });
    expect(
      await captureError(store.claim(operationInput(session, "turn"))),
    ).toBeInstanceOf(AiReviewerExternalAgentSessionConflictError);

    claim = await store.claim(
      operationInput(session, "reopen", { expectedThreadId: "thread-1" }),
    );
    session = await store.finalize({
      ...operationInput(claim, "reopen"),
      claimId: claim.operationClaim.id,
    });
    expect(session).toMatchObject({
      status: "active",
      revision: 6,
      operationClaim: null,
    });
  });

  it("uses the common CAS slot for purge and records an explicit partial failure", async function () {
    const { store } = fixture();
    let session = await finishFirstTurn(
      store,
      await store.create(sessionInput()),
    );
    const lastUserActivity = session.lastActivityAt;
    for (const staleCandidate of [
      { expectedStatus: "resolved" },
      { expectedLastActivityAt: new Date(0) },
    ]) {
      expect(
        await captureError(
          store.claim(operationInput(session, "purge", staleCandidate)),
        ),
      ).toBeInstanceOf(AiReviewerExternalAgentSessionConflictError);
    }
    const claim = await store.claim(operationInput(session, "purge"));
    expect(claim).toMatchObject({
      revision: 3,
      operationClaim: { type: "purge" },
    });
    expect(claim.lastActivityAt).toEqual(lastUserActivity);
    expect(
      await captureError(store.claim(operationInput(claim, "resolve"))),
    ).toBeInstanceOf(AiReviewerExternalAgentSessionConflictError);

    session = await store.finalize({
      ...operationInput(claim, "purge"),
      claimId: claim.operationClaim.id,
      stateBytes: 80,
    });
    expect(session).toMatchObject({
      status: "purge_failed",
      stateBytes: 80,
      revision: 4,
      operationClaim: null,
    });
    expect(session.lastActivityAt).toEqual(lastUserActivity);

    const retry = await store.claim(operationInput(session, "purge"));
    expect(retry).toMatchObject({
      revision: 5,
      operationClaim: { type: "purge" },
    });

    const deletion = {
      userId: retry.userId,
      projectId: retry.projectId,
      clientSessionId: retry.clientSessionId,
      claimId: retry.operationClaim.id,
      expectedRevision: retry.revision,
      expectedStatus: retry.status,
      expectedLastActivityAt: retry.lastActivityAt,
      expectedThreadId: retry.threadId,
      stateRootKey: retry.stateRootKey,
    };
    expect(
      await captureError(
        store.deleteClaimedPurge({ ...deletion, userId: otherUserId }),
      ),
    ).toBeInstanceOf(AiReviewerExternalAgentSessionNotFoundError);
    expect(
      await captureError(
        store.deleteClaimedPurge({
          ...deletion,
          expectedRevision: retry.revision - 1,
        }),
      ),
    ).toBeInstanceOf(AiReviewerExternalAgentSessionConflictError);

    expect(await store.deleteClaimedPurge(deletion)).toMatchObject({
      status: "purge_failed",
      operationClaim: { type: "purge" },
    });
    expect(await captureError(store.load(sessionInput()))).toBeInstanceOf(
      AiReviewerExternalAgentSessionNotFoundError,
    );
  });

  it("claims and deletes a never-started threadless session", async function () {
    const { store } = fixture();
    const session = await store.create(sessionInput());
    const claim = await store.claim(operationInput(session, "purge"));

    expect(claim).toMatchObject({
      threadId: null,
      revision: 1,
      operationClaim: { type: "purge" },
    });
    await store.deleteClaimedPurge({
      userId: claim.userId,
      projectId: claim.projectId,
      clientSessionId: claim.clientSessionId,
      claimId: claim.operationClaim.id,
      expectedRevision: claim.revision,
      expectedStatus: claim.status,
      expectedLastActivityAt: claim.lastActivityAt,
      expectedThreadId: null,
      stateRootKey: claim.stateRootKey,
    });
    expect(await captureError(store.load(sessionInput()))).toBeInstanceOf(
      AiReviewerExternalAgentSessionNotFoundError,
    );
  });
});
