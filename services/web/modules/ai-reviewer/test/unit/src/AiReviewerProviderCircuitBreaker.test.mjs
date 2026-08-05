import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  AiReviewerProviderCircuitOpenError,
  AiReviewerProviderCooldownError,
  createAiReviewerCircuitBreakerFetch,
  createAiReviewerProviderCircuitBreakerStore,
} from "../../../app/models/AiReviewerProviderCircuitBreaker.mjs";
import { createAiReviewerProviderController } from "../../../app/src/AiReviewerProviderController.mjs";

const connectionId = "connection-circuit-0001";
const otherConnectionId = "connection-circuit-0002";

function fakeQuery(value) {
  const query = { exec: vi.fn(async () => value()) };
  query.lean = vi.fn(() => query);
  return query;
}

function circuitModelFixture() {
  const records = new Map();
  const model = {
    findById: vi.fn((id) =>
      fakeQuery(() =>
        records.has(id) ? { _id: id, ...records.get(id) } : null,
      ),
    ),
    findOneAndUpdate: vi.fn((filter, update, options) =>
      fakeQuery(() => {
        const exists = records.has(filter._id);
        const current = records.get(filter._id) ?? {};
        if (filter.openedAt === null && current.openedAt != null) {
          return null;
        }
        if (!exists && options?.upsert === false) {
          return null;
        }
        if (Array.isArray(update)) {
          const consecutiveFailures = (current.consecutiveFailures ?? 0) + 1;
          const firstSet = update[0].$set;
          const failureLimit = update[1].$set.openedAt.$cond[0].$gte[1];
          const next = {
            ...current,
            consecutiveFailures,
            cooldownUntil: firstSet.cooldownUntil,
            updatedAt: firstSet.updatedAt,
            ...(consecutiveFailures >= failureLimit
              ? { openedAt: current.openedAt ?? firstSet.updatedAt }
              : {}),
          };
          records.set(filter._id, next);
          return { _id: filter._id, ...next };
        }
        const next = { ...current, ...update.$set };
        for (const field of Object.keys(update.$unset ?? {})) {
          delete next[field];
        }
        records.set(filter._id, next);
        return { _id: filter._id, ...next };
      }),
    ),
    deleteOne: vi.fn(({ _id }) =>
      fakeQuery(() => {
        records.delete(_id);
        return { deletedCount: 1 };
      }),
    ),
  };
  return { model, records };
}

function fixture() {
  const { model, records } = circuitModelFixture();
  let nowMs = Date.parse("2026-08-06T00:00:00.000Z");
  const store = createAiReviewerProviderCircuitBreakerStore({
    model,
    failureLimit: 3,
    cooldownMs: 5_000,
    now: () => new Date(nowMs),
  });
  return {
    records,
    store,
    advance(milliseconds) {
      nowMs += milliseconds;
    },
  };
}

function response(status) {
  return { status };
}

describe("AI reviewer provider circuit breaker", function () {
  it("opens after three consecutive HTTP failures and sends no fourth request", async function () {
    const { store } = fixture();
    const providerFetch = vi.fn(async () => response(400));
    const guardedFetch = createAiReviewerCircuitBreakerFetch({
      circuitBreakerStore: store,
      connectionId,
      fetchImpl: providerFetch,
    });

    await guardedFetch("https://provider.example/v1/models");
    await guardedFetch("https://provider.example/v1/models");
    await guardedFetch("https://provider.example/v1/models");

    await expect(
      guardedFetch("https://provider.example/v1/models"),
    ).rejects.toBeInstanceOf(AiReviewerProviderCircuitOpenError);
    expect(providerFetch).toHaveBeenCalledTimes(3);
  });

  it("resets the consecutive count when a provider request succeeds", async function () {
    const { store } = fixture();
    const statuses = [400, 400, 200, 400, 400, 200];
    const providerFetch = vi.fn(async () => response(statuses.shift()));
    const guardedFetch = createAiReviewerCircuitBreakerFetch({
      circuitBreakerStore: store,
      connectionId,
      fetchImpl: providerFetch,
    });

    for (let index = 0; index < 6; index += 1) {
      await guardedFetch("https://provider.example/v1/models");
    }

    expect(providerFetch).toHaveBeenCalledTimes(6);
    await expect(
      store.assertProviderRequestAllowed(connectionId),
    ).resolves.toBeUndefined();
  });

  it("allows the connection again after the reset used by settings save", async function () {
    const { store } = fixture();
    const providerFetch = vi.fn(async () => response(403));
    const guardedFetch = createAiReviewerCircuitBreakerFetch({
      circuitBreakerStore: store,
      connectionId,
      fetchImpl: providerFetch,
    });
    await guardedFetch("https://provider.example/v1/models");
    await guardedFetch("https://provider.example/v1/models");
    await guardedFetch("https://provider.example/v1/models");
    await expect(
      store.assertProviderRequestAllowed(connectionId),
    ).rejects.toBeInstanceOf(AiReviewerProviderCircuitOpenError);

    await store.reset(connectionId);

    await expect(
      store.assertRequestAllowed(connectionId),
    ).resolves.toBeUndefined();
    await guardedFetch("https://provider.example/v1/models");
    expect(providerFetch).toHaveBeenCalledTimes(4);
  });

  it("isolates failures by connection", async function () {
    const { store } = fixture();
    const failedFetch = createAiReviewerCircuitBreakerFetch({
      circuitBreakerStore: store,
      connectionId,
      fetchImpl: vi.fn(async () => response(429)),
    });
    const otherProviderFetch = vi.fn(async () => response(200));
    const otherFetch = createAiReviewerCircuitBreakerFetch({
      circuitBreakerStore: store,
      connectionId: otherConnectionId,
      fetchImpl: otherProviderFetch,
    });
    await failedFetch("https://provider.example/v1/models");
    await failedFetch("https://provider.example/v1/models");
    await failedFetch("https://provider.example/v1/models");

    await otherFetch("https://other-provider.example/v1/models");

    expect(otherProviderFetch).toHaveBeenCalledTimes(1);
    await expect(
      store.assertProviderRequestAllowed(otherConnectionId),
    ).resolves.toBeUndefined();
  });

  it("does not retry a failed provider request automatically", async function () {
    const { store } = fixture();
    const providerFetch = vi.fn(async () => response(400));
    const guardedFetch = createAiReviewerCircuitBreakerFetch({
      circuitBreakerStore: store,
      connectionId,
      fetchImpl: providerFetch,
    });

    expect(
      await guardedFetch("https://provider.example/v1/models"),
    ).toEqual(response(400));
    expect(providerFetch).toHaveBeenCalledTimes(1);
  });

  it("cools down new user operations after the first failure", async function () {
    const { advance, store } = fixture();
    await store.recordFailure(connectionId);

    await expect(store.assertRequestAllowed(connectionId)).rejects.toBeInstanceOf(
      AiReviewerProviderCooldownError,
    );
    advance(5_000);
    await expect(
      store.assertRequestAllowed(connectionId),
    ).resolves.toBeUndefined();
  });

  it("does not count an aborted or unreachable fetch without an HTTP response", async function () {
    const { store } = fixture();
    const providerFetch = vi.fn(async () => {
      throw new TypeError("unreachable");
    });
    const guardedFetch = createAiReviewerCircuitBreakerFetch({
      circuitBreakerStore: store,
      connectionId,
      fetchImpl: providerFetch,
    });

    await expect(
      guardedFetch("https://provider.example/v1/models"),
    ).rejects.toThrow("unreachable");
    await expect(
      store.assertRequestAllowed(connectionId),
    ).resolves.toBeUndefined();
  });

  it("keeps an open circuit stopped when an earlier request later succeeds", async function () {
    const { store } = fixture();
    let finishLateRequest;
    const providerFetch = vi.fn(async (input) => {
      if (String(input).endsWith("/late-success")) {
        return await new Promise((resolve) => {
          finishLateRequest = resolve;
        });
      }
      return response(500);
    });
    const guardedFetch = createAiReviewerCircuitBreakerFetch({
      circuitBreakerStore: store,
      connectionId,
      fetchImpl: providerFetch,
    });

    const lateRequest = guardedFetch(
      "https://provider.example/v1/late-success",
    );
    await vi.waitFor(() => expect(providerFetch).toHaveBeenCalledOnce());
    await guardedFetch("https://provider.example/v1/failure-1");
    await guardedFetch("https://provider.example/v1/failure-2");
    await guardedFetch("https://provider.example/v1/failure-3");

    finishLateRequest(response(200));
    await lateRequest;

    await expect(
      store.assertProviderRequestAllowed(connectionId),
    ).rejects.toBeInstanceOf(AiReviewerProviderCircuitOpenError);
  });

  it("resets the circuit after an existing connection is saved", async function () {
    const reset = vi.fn(async () => {});
    const controller = createAiReviewerProviderController({
      configStore: {
        update: vi.fn(async () => ({
          id: connectionId,
          revision: 2,
          label: "provider.example",
          provider: "openai-compatible",
          baseUrl: "https://provider.example/v1",
        })),
      },
      providerService: {},
      circuitBreakerStore: { reset },
    });
    const request = new EventEmitter();
    request.user = { _id: { toString: () => "user-circuit-0001" } };
    request.params = { connection_id: connectionId };
    request.body = {
      provider: "openai-compatible",
      baseUrl: "https://provider.example/v1",
      models: [],
      label: "provider.example",
      contextLengthOverride: null,
      expectedRevision: 1,
    };
    const responseFixture = {
      status: vi.fn(() => responseFixture),
      json: vi.fn((body) => body),
    };

    await controller.updateConnection(request, responseFixture);

    expect(reset).toHaveBeenCalledTimes(1);
    expect(reset).toHaveBeenCalledWith(connectionId);
  });

  it("returns the saved revision when automatic circuit reset fails", async function () {
    const controller = createAiReviewerProviderController({
      configStore: {
        update: vi.fn(async () => ({
          id: connectionId,
          revision: 2,
          label: "provider.example",
          provider: "openai-compatible",
          baseUrl: "https://provider.example/v1",
        })),
      },
      providerService: {},
      circuitBreakerStore: {
        reset: vi.fn(async () => {
          throw new Error("circuit persistence unavailable");
        }),
      },
    });
    const request = new EventEmitter();
    request.user = { _id: { toString: () => "user-circuit-0001" } };
    request.params = { connection_id: connectionId };
    request.body = {
      provider: "openai-compatible",
      baseUrl: "https://provider.example/v1",
      models: [],
      label: "provider.example",
      contextLengthOverride: null,
      expectedRevision: 1,
    };
    const responseFixture = {
      status: vi.fn(() => responseFixture),
      json: vi.fn((body) => body),
    };

    await controller.updateConnection(request, responseFixture);

    expect(responseFixture.status).not.toHaveBeenCalled();
    expect(responseFixture.json).toHaveBeenCalledWith(
      expect.objectContaining({ id: connectionId, revision: 2 }),
    );
  });

  it("explicitly resets an owned connection without contacting the provider", async function () {
    const reset = vi.fn(async () => {});
    const providerService = { testConnection: vi.fn() };
    const controller = createAiReviewerProviderController({
      configStore: {
        get: vi.fn(async () => ({
          id: connectionId,
          provider: "openai-compatible",
          baseUrl: "https://provider.example/v1",
        })),
      },
      providerService,
      circuitBreakerStore: { reset },
    });
    const request = new EventEmitter();
    request.user = { _id: { toString: () => "user-circuit-0001" } };
    request.params = { connection_id: connectionId };
    request.body = {};
    const responseFixture = {
      status: vi.fn(() => responseFixture),
      json: vi.fn((body) => body),
    };

    await controller.resetCircuit(request, responseFixture);

    expect(reset).toHaveBeenCalledExactlyOnceWith(connectionId);
    expect(responseFixture.json).toHaveBeenCalledWith({ ok: true });
    expect(providerService.testConnection).not.toHaveBeenCalled();
  });
});
