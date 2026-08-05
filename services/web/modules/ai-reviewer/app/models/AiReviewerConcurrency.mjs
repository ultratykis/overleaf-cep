// @ts-check

import { randomUUID } from "node:crypto";

import mongoose from "../../../../app/src/infrastructure/Mongoose.mjs";

const DEFAULT_PER_USER_LIMIT = 2;
const DEFAULT_GLOBAL_LIMIT = 10;
const DEFAULT_TTL_MS = 10 * 60_000;
const CAPACITY_ID = "active";

/** @param {string} collection */
function canonicalRecordSchema(collection) {
  return new mongoose.Schema(
    {
      _id: { type: String, required: true },
      reservations: {
        type: [
          {
            _id: false,
            reservationId: { type: String, required: true },
            userId: {
              type: mongoose.Schema.Types.ObjectId,
              ref: "User",
              required: true,
            },
            acquiredAt: { type: Date, required: true },
            expiresAt: { type: Date, required: true },
          },
        ],
        default: [],
        required: true,
      },
    },
    {
      collection,
      strict: "throw",
      timestamps: false,
      versionKey: false,
    },
  );
}

export const AiReviewerConcurrencySchema = canonicalRecordSchema(
  "aiReviewerConcurrency",
);
export const AiReviewerConcurrency = mongoose.model(
  "AiReviewerConcurrency",
  AiReviewerConcurrencySchema,
);

/**
 * @param {string} name
 * @param {number} fallback
 */
function positiveIntegerFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

/**
 * @param {{
 *   model?: typeof AiReviewerConcurrency,
 *   perUserLimit?: number,
 *   globalLimit?: number,
 *   ttlMs?: number,
 *   now?: () => Date,
 *   reservationId?: () => string,
 * }} [dependencies]
 */
export function createAiReviewerConcurrencyStore({
  model = AiReviewerConcurrency,
  perUserLimit = positiveIntegerFromEnv(
    "OVERLEAF_AI_REVIEWER_PER_USER_CONCURRENCY_LIMIT",
    DEFAULT_PER_USER_LIMIT,
  ),
  globalLimit = positiveIntegerFromEnv(
    "OVERLEAF_AI_REVIEWER_GLOBAL_CONCURRENCY_LIMIT",
    DEFAULT_GLOBAL_LIMIT,
  ),
  ttlMs = positiveIntegerFromEnv(
    "OVERLEAF_AI_REVIEWER_RESERVATION_TTL_MS",
    DEFAULT_TTL_MS,
  ),
  now = () => new Date(),
  reservationId = randomUUID,
} = {}) {
  return {
    /**
     * @param {unknown} userId
     * @returns {Promise<
     *   | { acquired: false, limit: 'user' | 'system' }
     *   | { acquired: true, release: () => Promise<void> }
     * >}
     */
    async acquire(userId) {
      const acquiredAt = now();
      const expiresAt = new Date(acquiredAt.getTime() + ttlMs);
      const id = reservationId();
      const reservation = { reservationId: id, userId, acquiredAt, expiresAt };
      const activeReservations = {
        $filter: {
          input: { $ifNull: ["$reservations", []] },
          as: "reservation",
          cond: { $gt: ["$$reservation.expiresAt", acquiredAt] },
        },
      };
      const record = await model
        .findOneAndUpdate(
          { _id: CAPACITY_ID },
          [
            { $set: { reservations: activeReservations } },
            {
              $set: {
                reservations: {
                  $cond: [
                    {
                      $and: [
                        { $lt: [{ $size: "$reservations" }, globalLimit] },
                        {
                          $lt: [
                            {
                              $size: {
                                $filter: {
                                  input: "$reservations",
                                  as: "reservation",
                                  cond: {
                                    $eq: ["$$reservation.userId", userId],
                                  },
                                },
                              },
                            },
                            perUserLimit,
                          ],
                        },
                      ],
                    },
                    { $concatArrays: ["$reservations", [reservation]] },
                    "$reservations",
                  ],
                },
              },
            },
          ],
          { upsert: true, new: true },
        )
        .lean()
        .exec();
      const reservations = Array.isArray(record?.reservations)
        ? record.reservations
        : [];
      if (!reservations.some((item) => item.reservationId === id)) {
        return {
          acquired: false,
          limit: reservations.length >= globalLimit ? "system" : "user",
        };
      }

      let released = false;
      return {
        acquired: true,
        async release() {
          if (released) {
            return;
          }
          released = true;
          await model
            .updateOne(
              { _id: CAPACITY_ID },
              { $pull: { reservations: { reservationId: id } } },
            )
            .exec();
        },
      };
    },
  };
}
