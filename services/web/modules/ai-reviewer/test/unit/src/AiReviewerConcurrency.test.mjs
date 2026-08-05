import { afterEach, describe, expect, it, vi } from "vitest";

import { createAiReviewerConcurrencyStore } from "../../../app/models/AiReviewerConcurrency.mjs";

const userA = "000000000000000000000001";
const userB = "000000000000000000000002";

afterEach(() => {
  vi.unstubAllEnvs();
});

function query(work) {
  const value = {
    lean: vi.fn(() => value),
    exec: vi.fn(async () => structuredClone(work())),
  };
  return value;
}

function atomicModel() {
  let reservations = [];
  return {
    findOneAndUpdate: vi.fn((_filter, pipeline) =>
      query(() => {
        const acquiredAt = pipeline[0].$set.reservations.$filter.cond.$gt[1];
        const condition = pipeline[1].$set.reservations.$cond;
        const globalLimit = condition[0].$and[0].$lt[1];
        const perUserLimit = condition[0].$and[1].$lt[1];
        const reservation = condition[1].$concatArrays[1][0];
        reservations = reservations.filter(
          (item) => item.expiresAt > acquiredAt,
        );
        const userCount = reservations.filter(
          (item) => item.userId === reservation.userId,
        ).length;
        if (reservations.length < globalLimit && userCount < perUserLimit) {
          reservations.push(reservation);
        }
        return { _id: "active", reservations };
      }),
    ),
    updateOne: vi.fn((_filter, update) =>
      query(() => {
        const id = update.$pull.reservations.reservationId;
        reservations = reservations.filter((item) => item.reservationId !== id);
        return { acknowledged: true, modifiedCount: 1 };
      }),
    ),
    reservations: () => structuredClone(reservations),
  };
}

function store(model, options = {}) {
  let sequence = 0;
  return createAiReviewerConcurrencyStore({
    model,
    perUserLimit: 2,
    globalLimit: 10,
    ttlMs: 600_000,
    now: () => new Date("2026-07-31T00:00:00.000Z"),
    reservationId: () => `reservation-${++sequence}`,
    ...options,
  });
}

describe("AI reviewer concurrency reservations", function () {
  it("reads per-user and global limits from the environment", async function () {
    vi.stubEnv("OVERLEAF_AI_REVIEWER_PER_USER_CONCURRENCY_LIMIT", "1");
    vi.stubEnv("OVERLEAF_AI_REVIEWER_GLOBAL_CONCURRENCY_LIMIT", "2");
    const model = atomicModel();
    const reservations = createAiReviewerConcurrencyStore({
      model,
      reservationId: vi
        .fn()
        .mockReturnValueOnce("reservation-1")
        .mockReturnValueOnce("reservation-2")
        .mockReturnValueOnce("reservation-3")
        .mockReturnValueOnce("reservation-4"),
    });

    expect((await reservations.acquire(userA)).acquired).toBe(true);
    expect(await reservations.acquire(userA)).toEqual({
      acquired: false,
      limit: "user",
    });
    expect((await reservations.acquire(userB)).acquired).toBe(true);
    expect(await reservations.acquire("000000000000000000000003")).toEqual({
      acquired: false,
      limit: "system",
    });
  });

  it("allows two requests per user, rejects the third, and reopens capacity after release", async function () {
    const model = atomicModel();
    const reservations = store(model);

    const first = await reservations.acquire(userA);
    const second = await reservations.acquire(userA);
    const rejected = await reservations.acquire(userA);

    expect(first.acquired).toBe(true);
    expect(second.acquired).toBe(true);
    expect(rejected).toEqual({ acquired: false, limit: "user" });
    expect(model.findOneAndUpdate).toHaveBeenCalledTimes(3);

    if (!first.acquired) {
      throw new Error("Expected the first reservation.");
    }
    await first.release();
    expect((await reservations.acquire(userA)).acquired).toBe(true);
  });

  it("rejects another user when global capacity is full", async function () {
    const model = atomicModel();
    const reservations = store(model, {
      perUserLimit: 2,
      globalLimit: 3,
    });

    expect((await reservations.acquire(userA)).acquired).toBe(true);
    expect((await reservations.acquire(userA)).acquired).toBe(true);
    expect((await reservations.acquire(userB)).acquired).toBe(true);
    expect(await reservations.acquire("000000000000000000000003")).toEqual({
      acquired: false,
      limit: "system",
    });
  });

  it("removes expired reservations during the next atomic acquisition", async function () {
    const model = atomicModel();
    let time = Date.parse("2026-07-31T00:00:00.000Z");
    const reservations = store(model, {
      perUserLimit: 1,
      ttlMs: 100,
      now: () => new Date(time),
    });

    expect((await reservations.acquire(userA)).acquired).toBe(true);
    time += 101;
    expect((await reservations.acquire(userA)).acquired).toBe(true);
    expect(model.reservations()).toHaveLength(1);
  });

  it("does not exceed either limit under concurrent acquisition", async function () {
    const perUserModel = atomicModel();
    const perUserStore = store(perUserModel);
    const sameUser = await Promise.all(
      Array.from({ length: 20 }, () => perUserStore.acquire(userA)),
    );
    expect(sameUser.filter((item) => item.acquired)).toHaveLength(2);

    const globalModel = atomicModel();
    const globalStore = store(globalModel);
    const manyUsers = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        globalStore.acquire(index.toString(16).padStart(24, "0")),
      ),
    );
    expect(manyUsers.filter((item) => item.acquired)).toHaveLength(10);
  });

  it("releases a reservation idempotently", async function () {
    const model = atomicModel();
    const reservations = store(model);
    const acquired = await reservations.acquire(userA);
    if (!acquired.acquired) {
      throw new Error("Expected a reservation.");
    }

    await acquired.release();
    await acquired.release();

    expect(model.updateOne).toHaveBeenCalledOnce();
    expect(model.reservations()).toEqual([]);
  });
});
