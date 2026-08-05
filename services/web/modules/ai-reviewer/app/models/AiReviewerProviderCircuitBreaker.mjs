// @ts-check

import mongoose from "../../../../app/src/infrastructure/Mongoose.mjs";

import { AgentGatewayError } from "../src/AgentGateway.mjs";

export const AI_REVIEWER_PROVIDER_FAILURE_LIMIT = 3;
export const AI_REVIEWER_PROVIDER_COOLDOWN_MS = 5_000;

export const AiReviewerProviderCircuitBreakerSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    consecutiveFailures: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },
    openedAt: { type: Date },
    cooldownUntil: { type: Date },
    updatedAt: { type: Date, required: true },
  },
  {
    collection: "aiReviewerProviderCircuitBreakers",
    strict: "throw",
    timestamps: false,
    versionKey: false,
  },
);

export const AiReviewerProviderCircuitBreaker = mongoose.model(
  "AiReviewerProviderCircuitBreaker",
  AiReviewerProviderCircuitBreakerSchema,
);

export class AiReviewerProviderCircuitOpenError extends AgentGatewayError {
  constructor() {
    super(
      "This AI provider connection was stopped after repeated failures.",
      {
        code: "AI_PROVIDER_CIRCUIT_OPEN",
        category: "configuration",
        retryable: false,
      },
    );
    this.name = "AiReviewerProviderCircuitOpenError";
  }
}

export class AiReviewerProviderCooldownError extends AgentGatewayError {
  constructor() {
    super("This AI provider connection is cooling down after a failure.", {
      code: "AI_PROVIDER_COOLDOWN",
      category: "rate-limit",
      retryable: true,
    });
    this.name = "AiReviewerProviderCooldownError";
  }
}

/** @param {any} query */
async function lean(query) {
  return await query.lean().exec();
}

/**
 * @param {{
 *   model?: typeof AiReviewerProviderCircuitBreaker,
 *   failureLimit?: number,
 *   cooldownMs?: number,
 *   now?: () => Date,
 * }} [dependencies]
 */
export function createAiReviewerProviderCircuitBreakerStore({
  model = AiReviewerProviderCircuitBreaker,
  failureLimit = AI_REVIEWER_PROVIDER_FAILURE_LIMIT,
  cooldownMs = AI_REVIEWER_PROVIDER_COOLDOWN_MS,
  now = () => new Date(),
} = {}) {
  if (!Number.isSafeInteger(failureLimit) || failureLimit <= 0) {
    throw new TypeError("failureLimit must be a positive safe integer.");
  }
  if (!Number.isSafeInteger(cooldownMs) || cooldownMs <= 0) {
    throw new TypeError("cooldownMs must be a positive safe integer.");
  }

  /** @param {unknown} connectionId */
  function key(connectionId) {
    if (typeof connectionId !== "string" || connectionId.length === 0) {
      throw new TypeError("connectionId must be a non-empty string.");
    }
    return connectionId;
  }

  /**
   * The per-click cooldown is checked only at route entry. Provider-internal
   * fallback requests may finish the current operation, but every one still
   * checks the permanent circuit before leaving the process.
   *
   * @param {unknown} connectionId
   * @param {boolean} includeCooldown
   */
  async function assertAllowed(connectionId, includeCooldown) {
    const checkedAt = now();
    const record = await lean(model.findById(key(connectionId)));
    if (record?.openedAt != null) {
      throw new AiReviewerProviderCircuitOpenError();
    }
    if (
      includeCooldown &&
      record?.cooldownUntil != null &&
      new Date(record.cooldownUntil).getTime() > checkedAt.getTime()
    ) {
      throw new AiReviewerProviderCooldownError();
    }
  }

  return {
    /** @param {unknown} connectionId */
    async assertRequestAllowed(connectionId) {
      await assertAllowed(connectionId, true);
    },

    /** @param {unknown} connectionId */
    async assertProviderRequestAllowed(connectionId) {
      await assertAllowed(connectionId, false);
    },

    /** @param {unknown} connectionId */
    async recordSuccess(connectionId) {
      const succeededAt = now();
      await model
        .findOneAndUpdate(
          {
            _id: key(connectionId),
            // A response that was already in flight when the circuit opened
            // must not enable the connection again. Only reset() may remove an
            // open record.
            // MongoDB's null equality matches both a missing field and an
            // explicit null, while excluding every actual opening timestamp.
            openedAt: null,
          },
          {
            $set: { consecutiveFailures: 0, updatedAt: succeededAt },
            $unset: { cooldownUntil: 1 },
          },
          { upsert: false },
        )
        .exec();
    },

    /** @param {unknown} connectionId */
    async recordFailure(connectionId) {
      const failedAt = now();
      const cooldownUntil = new Date(failedAt.getTime() + cooldownMs);
      await model
        .findOneAndUpdate(
          { _id: key(connectionId) },
          [
            {
              $set: {
                consecutiveFailures: {
                  $add: [{ $ifNull: ["$consecutiveFailures", 0] }, 1],
                },
                cooldownUntil,
                updatedAt: failedAt,
              },
            },
            {
              $set: {
                openedAt: {
                  $cond: [
                    { $gte: ["$consecutiveFailures", failureLimit] },
                    { $ifNull: ["$openedAt", failedAt] },
                    "$openedAt",
                  ],
                },
              },
            },
          ],
          { upsert: true },
        )
        .exec();
    },

    /** @param {unknown} connectionId */
    async reset(connectionId) {
      await model.deleteOne({ _id: key(connectionId) }).exec();
    },
  };
}

/**
 * Count provider HTTP failures at the common fetch boundary. A rejected fetch
 * has no provider response, and an abort is user-controlled, so neither can
 * consume the gateway's HTTP error counter and neither changes this circuit.
 *
 * @param {{
 *   circuitBreakerStore: ReturnType<typeof createAiReviewerProviderCircuitBreakerStore>,
 *   connectionId: string,
 *   fetchImpl: typeof fetch,
 * }} dependencies
 */
export function createAiReviewerCircuitBreakerFetch({
  circuitBreakerStore,
  connectionId,
  fetchImpl,
}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function.");
  }
  /**
   * @param {Parameters<typeof fetch>[0]} input
   * @param {Parameters<typeof fetch>[1]} [init]
   */
  return async function circuitBreakerFetch(input, init) {
    await circuitBreakerStore.assertProviderRequestAllowed(connectionId);
    const response = await fetchImpl(input, init);
    if (
      Number.isSafeInteger(response?.status) &&
      response.status >= 400 &&
      response.status <= 599
    ) {
      await circuitBreakerStore.recordFailure(connectionId);
    } else if (response.status >= 200 && response.status <= 299) {
      await circuitBreakerStore.recordSuccess(connectionId);
    }
    return response;
  };
}
