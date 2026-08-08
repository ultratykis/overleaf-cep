// @ts-check

import { createHash, randomUUID } from "node:crypto";

import { AiReviewerExternalAgentSession as AiReviewerExternalAgentSessionModel } from "../models/AiReviewerExternalAgentSession.mjs";

/** @typedef {"review" | "agent"} SessionMode */
/** @typedef {"turn" | "resolve" | "reopen" | "purge"} OperationType */
/** @typedef {"active" | "resolved" | "purge_failed"} SessionStatus */
/** @typedef {{ status: SessionStatus, inactivity: "90d" | "180d" | "365d", minimumSize: "any" | "10mib" | "100mib" | "1gib" }} PurgeCriteria */

const MODES = new Set(["review", "agent"]);
const OPERATION_TYPES = new Set(["turn", "resolve", "reopen", "purge"]);
const STATUSES = new Set(["active", "resolved", "purge_failed"]);
export const EXTERNAL_AGENT_PURGE_OPTIONS = Object.freeze({
  statuses: Object.freeze(["active", "resolved", "purge_failed"]),
  inactivity: Object.freeze(["90d", "180d", "365d"]),
  minimumSize: Object.freeze(["any", "10mib", "100mib", "1gib"]),
});
const DAY_MS = 24 * 60 * 60 * 1_000;
export const EXTERNAL_AGENT_STALE_PURGE_CLAIM_MS = 10 * 60 * 1_000;
const INACTIVITY_MS = Object.freeze({
  "90d": 90 * DAY_MS,
  "180d": 180 * DAY_MS,
  "365d": 365 * DAY_MS,
});
const MINIMUM_SIZE_BYTES = Object.freeze({
  any: 0,
  "10mib": 10 * 1024 * 1024,
  "100mib": 100 * 1024 * 1024,
  "1gib": 1024 * 1024 * 1024,
});
const PURGE_PROJECTION = Object.freeze({
  _id: 1,
  userId: 1,
  projectId: 1,
  clientSessionId: 1,
  mode: 1,
  threadId: 1,
  stateRootKey: 1,
  connectionFingerprint: 1,
  status: 1,
  lastActivityAt: 1,
  stateBytes: 1,
  revision: 1,
  operationClaim: 1,
});
const CLAIMABLE_STATUS = Object.freeze({
  turn: "active",
  resolve: "active",
  reopen: "resolved",
  purge: { $in: ["active", "resolved", "purge_failed"] },
});
const FINAL_STATUS = Object.freeze({
  turn: "active",
  resolve: "resolved",
  reopen: "active",
  purge: "purge_failed",
});

export class AiReviewerExternalAgentSessionValidationError extends TypeError {
  constructor() {
    super("The external AI reviewer session is invalid.");
    this.name = "AiReviewerExternalAgentSessionValidationError";
  }
}

export class AiReviewerExternalAgentSessionNotFoundError extends Error {
  constructor() {
    super("The external AI reviewer session does not exist.");
    this.name = "AiReviewerExternalAgentSessionNotFoundError";
  }
}

export class AiReviewerExternalAgentSessionConflictError extends Error {
  constructor() {
    super("The external AI reviewer session changed elsewhere.");
    this.name = "AiReviewerExternalAgentSessionConflictError";
  }
}

/** @param {unknown} value */
function boundedIdentifier(value) {
  try {
    const identifier = /** @type {any} */ (value)?.toString?.();
    if (
      typeof identifier !== "string" ||
      identifier.length === 0 ||
      identifier.length > 200
    ) {
      throw new AiReviewerExternalAgentSessionValidationError();
    }
    return identifier;
  } catch (error) {
    if (error instanceof AiReviewerExternalAgentSessionValidationError) {
      throw error;
    }
    throw new AiReviewerExternalAgentSessionValidationError();
  }
}

/** @param {unknown} value */
function scopeIdentifier(value) {
  const identifier = boundedIdentifier(value);
  return /^[0-9a-f]{24}$/iu.test(identifier)
    ? identifier.toLowerCase()
    : identifier;
}

/** @param {unknown} value */
function opaqueKey(value) {
  const key = boundedIdentifier(value);
  if (!/^[a-zA-Z0-9_-]+$/u.test(key)) {
    throw new AiReviewerExternalAgentSessionValidationError();
  }
  return key;
}

/**
 * @param {unknown} value
 * @returns {SessionMode}
 */
function mode(value) {
  if (typeof value !== "string" || !MODES.has(value)) {
    throw new AiReviewerExternalAgentSessionValidationError();
  }
  return /** @type {SessionMode} */ (value);
}

/**
 * @param {unknown} value
 * @returns {OperationType}
 */
function operationType(value) {
  if (typeof value !== "string" || !OPERATION_TYPES.has(value)) {
    throw new AiReviewerExternalAgentSessionValidationError();
  }
  return /** @type {OperationType} */ (value);
}

/**
 * @param {unknown} value
 * @returns {SessionStatus}
 */
function status(value) {
  if (typeof value !== "string" || !STATUSES.has(value)) {
    throw new AiReviewerExternalAgentSessionValidationError();
  }
  return /** @type {SessionStatus} */ (value);
}

/** @param {unknown} value */
function nonNegativeSafeInteger(value) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 0) {
    throw new AiReviewerExternalAgentSessionValidationError();
  }
  return /** @type {number} */ (value);
}

/**
 * @param {unknown} value
 * @param {1 | 2 | 3} remainingIncrements
 */
function incrementableRevision(value, remainingIncrements) {
  const revision = nonNegativeSafeInteger(value);
  if (revision > Number.MAX_SAFE_INTEGER - remainingIncrements) {
    throw new AiReviewerExternalAgentSessionValidationError();
  }
  return revision;
}

/** @param {unknown} value */
function date(value) {
  const parsed =
    value instanceof Date ? value : new Date(/** @type {any} */ (value));
  if (!Number.isFinite(parsed.getTime())) {
    throw new AiReviewerExternalAgentSessionValidationError();
  }
  return parsed;
}

/** @param {unknown} value */
function nullableThreadId(value) {
  return value == null ? null : boundedIdentifier(value);
}

/** @param {unknown} value @returns {PurgeCriteria} */
function purgeCriteria(value) {
  if (
    typeof value !== "object" ||
    value == null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    !Object.hasOwn(value, "status") ||
    !Object.hasOwn(value, "inactivity") ||
    !Object.hasOwn(value, "minimumSize")
  ) {
    throw new AiReviewerExternalAgentSessionValidationError();
  }
  const input = /** @type {any} */ (value);
  const checkedStatus = status(input.status);
  if (
    !Object.hasOwn(INACTIVITY_MS, input.inactivity) ||
    !Object.hasOwn(MINIMUM_SIZE_BYTES, input.minimumSize)
  ) {
    throw new AiReviewerExternalAgentSessionValidationError();
  }
  return {
    status: checkedStatus,
    inactivity: input.inactivity,
    minimumSize: input.minimumSize,
  };
}

/** @param {unknown} value */
function aggregateValue(value) {
  if (!Array.isArray(value) || value.length > 1) {
    throw new AiReviewerExternalAgentSessionValidationError();
  }
  if (value.length === 0) return { count: 0, bytes: 0 };
  return {
    count: nonNegativeSafeInteger(value[0]?.count),
    bytes: nonNegativeSafeInteger(value[0]?.bytes),
  };
}

/** @param {unknown} value */
function statusAggregate(value) {
  if (!Array.isArray(value)) {
    throw new AiReviewerExternalAgentSessionValidationError();
  }
  const totals = new Map();
  for (const row of value) {
    const key = status(row?._id);
    if (totals.has(key)) {
      throw new AiReviewerExternalAgentSessionValidationError();
    }
    totals.set(key, {
      count: nonNegativeSafeInteger(row?.count),
      bytes: nonNegativeSafeInteger(row?.bytes),
    });
  }
  return EXTERNAL_AGENT_PURGE_OPTIONS.statuses.map((key) => ({
    key,
    ...(totals.get(key) ?? { count: 0, bytes: 0 }),
  }));
}

/** @param {PurgeCriteria} criteria @param {Date} plannedAt */
function purgeFilter(criteria, plannedAt) {
  const minimumSize = MINIMUM_SIZE_BYTES[criteria.minimumSize];
  return {
    ...(criteria.status === "purge_failed"
      ? {
          $or: [
            { operationClaim: null },
            {
              "operationClaim.type": "purge",
              "operationClaim.claimedAt": {
                $lte: new Date(
                  plannedAt.getTime() - EXTERNAL_AGENT_STALE_PURGE_CLAIM_MS,
                ),
              },
            },
          ],
        }
      : { operationClaim: null }),
    status: criteria.status,
    lastActivityAt: {
      $lte: new Date(plannedAt.getTime() - INACTIVITY_MS[criteria.inactivity]),
    },
    ...(minimumSize === 0 ? {} : { stateBytes: { $gte: minimumSize } }),
  };
}

/**
 * @param {string} userId
 * @param {string} projectId
 * @param {string} clientSessionId
 */
function sessionScopeId(userId, projectId, clientSessionId) {
  return createHash("sha256")
    .update(JSON.stringify([userId, projectId, clientSessionId]))
    .digest("hex");
}

/** @param {unknown} error */
function isDuplicateKeyError(error) {
  return (
    typeof error === "object" &&
    error != null &&
    "code" in error &&
    error.code === 11000
  );
}

/** @param {any} query */
async function lean(query) {
  return await query.lean().exec();
}

/**
 * @param {any} record
 * @param {{ scopeId: string, userId: string, projectId: string, clientSessionId: string }} scope
 */
function storedSession(record, scope) {
  if (record == null) {
    return null;
  }
  if (
    scopeIdentifier(record._id) !== scope.scopeId ||
    scopeIdentifier(record.userId) !== scope.userId ||
    scopeIdentifier(record.projectId) !== scope.projectId ||
    boundedIdentifier(record.clientSessionId) !== scope.clientSessionId
  ) {
    throw new AiReviewerExternalAgentSessionValidationError();
  }

  let operationClaim = null;
  if (record.operationClaim != null) {
    operationClaim = {
      id: opaqueKey(record.operationClaim.id),
      type: operationType(record.operationClaim.type),
      claimedAt: date(record.operationClaim.claimedAt),
    };
  }

  return {
    id: scope.scopeId,
    userId: scope.userId,
    projectId: scope.projectId,
    clientSessionId: scope.clientSessionId,
    mode: mode(record.mode),
    threadId: nullableThreadId(record.threadId),
    stateRootKey: opaqueKey(record.stateRootKey),
    connectionFingerprint: boundedIdentifier(record.connectionFingerprint),
    status: status(record.status),
    lastActivityAt: date(record.lastActivityAt),
    stateBytes: nonNegativeSafeInteger(record.stateBytes),
    revision: nonNegativeSafeInteger(record.revision),
    operationClaim,
  };
}

/** @param {{ userId: unknown, projectId: unknown, clientSessionId: unknown }} input */
function scope(input) {
  const userId = scopeIdentifier(input.userId);
  const projectId = scopeIdentifier(input.projectId);
  const clientSessionId = boundedIdentifier(input.clientSessionId);
  return {
    scopeId: sessionScopeId(userId, projectId, clientSessionId),
    userId,
    projectId,
    clientSessionId,
  };
}

/**
 * @param {{
 *   model?: typeof AiReviewerExternalAgentSessionModel,
 *   now?: () => Date,
 *   createId?: () => string,
 * }} [dependencies]
 */
export function createExternalAgentSessionStore({
  model = AiReviewerExternalAgentSessionModel,
  now = () => new Date(),
  createId = randomUUID,
} = {}) {
  /**
   * Preserve not-found semantics across ownership boundaries while reporting
   * every failed revision, state, thread, or active-claim check as one conflict.
   *
   * @param {{ scopeId: string, userId: string, projectId: string, clientSessionId: string }} checkedScope
   */
  async function failedCas(checkedScope) {
    const record = await lean(
      model.findOne({
        _id: checkedScope.scopeId,
        userId: checkedScope.userId,
        projectId: checkedScope.projectId,
        clientSessionId: checkedScope.clientSessionId,
      }),
    );
    if (record == null) {
      throw new AiReviewerExternalAgentSessionNotFoundError();
    }
    storedSession(record, checkedScope);
    throw new AiReviewerExternalAgentSessionConflictError();
  }

  return {
    /**
     * @param {{
     *   userId: unknown,
     *   projectId: unknown,
     *   clientSessionId: unknown,
     *   mode: unknown,
     *   connectionFingerprint: unknown,
     * }} input
     */
    async create(input) {
      const checkedScope = scope(input);
      const sessionMode = mode(input.mode);
      const connectionFingerprint = boundedIdentifier(
        input.connectionFingerprint,
      );
      const stateRootKey = opaqueKey(createId());
      const createdAt = date(now());
      try {
        const record = await lean(
          model.findOneAndUpdate(
            {
              _id: checkedScope.scopeId,
              userId: checkedScope.userId,
              projectId: checkedScope.projectId,
              clientSessionId: checkedScope.clientSessionId,
              mode: sessionMode,
              connectionFingerprint,
            },
            {
              $setOnInsert: {
                _id: checkedScope.scopeId,
                userId: checkedScope.userId,
                projectId: checkedScope.projectId,
                clientSessionId: checkedScope.clientSessionId,
                mode: sessionMode,
                threadId: null,
                stateRootKey,
                connectionFingerprint,
                status: "active",
                lastActivityAt: createdAt,
                stateBytes: 0,
                revision: 0,
                operationClaim: null,
              },
            },
            {
              new: true,
              runValidators: true,
              setDefaultsOnInsert: true,
              upsert: true,
            },
          ),
        );
        const session = storedSession(record, checkedScope);
        if (session == null) {
          throw new AiReviewerExternalAgentSessionConflictError();
        }
        return session;
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new AiReviewerExternalAgentSessionConflictError();
        }
        throw error;
      }
    },

    /** @param {{ userId: unknown, projectId: unknown, clientSessionId: unknown }} input */
    async load(input) {
      const checkedScope = scope(input);
      const record = await lean(
        model.findOne({
          _id: checkedScope.scopeId,
          userId: checkedScope.userId,
          projectId: checkedScope.projectId,
          clientSessionId: checkedScope.clientSessionId,
        }),
      );
      const session = storedSession(record, checkedScope);
      if (session == null) {
        throw new AiReviewerExternalAgentSessionNotFoundError();
      }
      return session;
    },

    /**
     * Return only fixed aggregate buckets; never return session records.
     * @param {{ at: unknown }} input
     */
    async summarizeForPurge({ at }) {
      const summaryAt = date(at);
      /** @param {number} days */
      const cutoff = (days) => new Date(summaryAt.getTime() - days * DAY_MS);
      const totals = [
        {
          $group: {
            _id: null,
            count: { $sum: 1 },
            bytes: { $sum: "$stateBytes" },
          },
        },
        { $project: { _id: 0, count: 1, bytes: 1 } },
      ];
      const [result] = await model
        .aggregate([
          {
            $facet: {
              statuses: [
                {
                  $group: {
                    _id: "$status",
                    count: { $sum: 1 },
                    bytes: { $sum: "$stateBytes" },
                  },
                },
              ],
              inactivity90d: [
                { $match: { lastActivityAt: { $lte: cutoff(90) } } },
                ...totals,
              ],
              inactivity180d: [
                { $match: { lastActivityAt: { $lte: cutoff(180) } } },
                ...totals,
              ],
              inactivity365d: [
                { $match: { lastActivityAt: { $lte: cutoff(365) } } },
                ...totals,
              ],
              sizeAny: [...totals],
              size10mib: [
                {
                  $match: { stateBytes: { $gte: MINIMUM_SIZE_BYTES["10mib"] } },
                },
                ...totals,
              ],
              size100mib: [
                {
                  $match: {
                    stateBytes: { $gte: MINIMUM_SIZE_BYTES["100mib"] },
                  },
                },
                ...totals,
              ],
              size1gib: [
                {
                  $match: { stateBytes: { $gte: MINIMUM_SIZE_BYTES["1gib"] } },
                },
                ...totals,
              ],
            },
          },
        ])
        .exec();
      return {
        statuses: statusAggregate(result?.statuses ?? []),
        inactivity: [
          { key: "90d", ...aggregateValue(result?.inactivity90d ?? []) },
          { key: "180d", ...aggregateValue(result?.inactivity180d ?? []) },
          { key: "365d", ...aggregateValue(result?.inactivity365d ?? []) },
        ],
        minimumSize: [
          { key: "any", ...aggregateValue(result?.sizeAny ?? []) },
          { key: "10mib", ...aggregateValue(result?.size10mib ?? []) },
          { key: "100mib", ...aggregateValue(result?.size100mib ?? []) },
          { key: "1gib", ...aggregateValue(result?.size1gib ?? []) },
        ],
      };
    },

    /** @param {{ criteria: unknown, plannedAt: unknown }} input */
    async previewPurge(input) {
      const criteria = purgeCriteria(input.criteria);
      const plannedAt = date(input.plannedAt);
      const rows = await model
        .aggregate([
          { $match: purgeFilter(criteria, plannedAt) },
          {
            $group: {
              _id: null,
              count: { $sum: 1 },
              bytes: { $sum: "$stateBytes" },
            },
          },
          { $project: { _id: 0, count: 1, bytes: 1 } },
        ])
        .exec();
      return aggregateValue(rows);
    },

    /**
     * Load at most one synchronous purge batch for internal execution.
     * @param {{ criteria: unknown, plannedAt: unknown }} input
     */
    async loadPurgeBatch({
      criteria: inputCriteria,
      plannedAt: inputPlannedAt,
    }) {
      const criteria = purgeCriteria(inputCriteria);
      const plannedAt = date(inputPlannedAt);
      const records = await model
        .find(purgeFilter(criteria, plannedAt), PURGE_PROJECTION)
        .sort({ lastActivityAt: 1, _id: 1 })
        .limit(10)
        .read("primary")
        .lean()
        .exec();
      if (!Array.isArray(records)) {
        throw new AiReviewerExternalAgentSessionValidationError();
      }
      return records.map((record) => storedSession(record, scope(record)));
    },

    /**
     * @param {{
     *   userId: unknown,
     *   projectId: unknown,
     *   clientSessionId: unknown,
     *   type: unknown,
     *   expectedRevision: unknown,
     *   expectedThreadId?: unknown,
     *   expectedStatus?: unknown,
     *   expectedLastActivityAt?: unknown,
     * }} input
     */
    async claim(input) {
      const checkedScope = scope(input);
      const type = operationType(input.type);
      const expectedRevision = incrementableRevision(input.expectedRevision, 2);
      const claimedAt = date(now());
      const operationClaim = {
        id: opaqueKey(createId()),
        type,
        claimedAt,
      };
      const hasExpectedThreadId = Object.hasOwn(input, "expectedThreadId");
      const expectedThreadId = hasExpectedThreadId
        ? nullableThreadId(input.expectedThreadId)
        : undefined;
      const hasExpectedStatus = Object.hasOwn(input, "expectedStatus");
      const hasExpectedLastActivityAt = Object.hasOwn(
        input,
        "expectedLastActivityAt",
      );
      const expectedStatus = hasExpectedStatus
        ? status(input.expectedStatus)
        : undefined;
      const expectedLastActivityAt = hasExpectedLastActivityAt
        ? date(input.expectedLastActivityAt)
        : undefined;
      if (
        (type === "resolve" || type === "reopen") &&
        hasExpectedThreadId &&
        expectedThreadId == null
      ) {
        throw new AiReviewerExternalAgentSessionValidationError();
      }
      if (
        (type === "purge" &&
          (!hasExpectedThreadId ||
            !hasExpectedStatus ||
            !hasExpectedLastActivityAt)) ||
        (type !== "purge" && (hasExpectedStatus || hasExpectedLastActivityAt))
      ) {
        throw new AiReviewerExternalAgentSessionValidationError();
      }
      const filter = {
        _id: checkedScope.scopeId,
        userId: checkedScope.userId,
        projectId: checkedScope.projectId,
        clientSessionId: checkedScope.clientSessionId,
        revision: expectedRevision,
        status: type === "purge" ? expectedStatus : CLAIMABLE_STATUS[type],
        operationClaim: null,
        ...(type === "purge" ? { lastActivityAt: expectedLastActivityAt } : {}),
        ...(type === "resolve" || type === "reopen"
          ? { threadId: hasExpectedThreadId ? expectedThreadId : { $ne: null } }
          : hasExpectedThreadId
            ? { threadId: expectedThreadId }
            : {}),
      };
      const record = await lean(
        model.findOneAndUpdate(
          filter,
          {
            $set: {
              operationClaim,
              ...(type === "purge"
                ? { status: "purge_failed" }
                : { lastActivityAt: claimedAt }),
            },
            $inc: { revision: 1 },
          },
          { new: true, runValidators: true },
        ),
      );
      return storedSession(record, checkedScope) ?? failedCas(checkedScope);
    },

    /**
     * Normalize an abandoned purge claim without repeating external deletion.
     * A later dry run can purge the resulting `purge_failed` session normally.
     *
     * @param {{ session: any, plannedAt: unknown }} input
     */
    async recoverStalePurgeClaim({ session, plannedAt: inputPlannedAt }) {
      const checkedScope = scope(session);
      const expectedRevision = incrementableRevision(session?.revision, 3);
      const expectedStatus = status(session?.status);
      const expectedLastActivityAt = date(session?.lastActivityAt);
      const expectedThreadId = nullableThreadId(session?.threadId);
      const expectedStateRootKey = opaqueKey(session?.stateRootKey);
      const claimId = opaqueKey(session?.operationClaim?.id);
      const claimType = operationType(session?.operationClaim?.type);
      date(session?.operationClaim?.claimedAt);
      const plannedAt = date(inputPlannedAt);
      if (expectedStatus !== "purge_failed" || claimType !== "purge") {
        throw new AiReviewerExternalAgentSessionValidationError();
      }
      const record = await lean(
        model.findOneAndUpdate(
          {
            _id: checkedScope.scopeId,
            userId: checkedScope.userId,
            projectId: checkedScope.projectId,
            clientSessionId: checkedScope.clientSessionId,
            revision: expectedRevision,
            status: expectedStatus,
            lastActivityAt: expectedLastActivityAt,
            threadId: expectedThreadId,
            stateRootKey: expectedStateRootKey,
            "operationClaim.id": claimId,
            "operationClaim.type": "purge",
            "operationClaim.claimedAt": {
              $lte: new Date(
                plannedAt.getTime() - EXTERNAL_AGENT_STALE_PURGE_CLAIM_MS,
              ),
            },
          },
          {
            $set: { operationClaim: null, status: "purge_failed" },
            $inc: { revision: 1 },
          },
          { new: true, runValidators: true },
        ),
      );
      return storedSession(record, checkedScope) ?? failedCas(checkedScope);
    },

    /**
     * Finalizing `purge` clears its write-ahead failure fence. Successful hard
     * deletion remains outside the user-facing Gate 2 store API.
     *
     * @param {{
     *   userId: unknown,
     *   projectId: unknown,
     *   clientSessionId: unknown,
     *   type: unknown,
     *   claimId: unknown,
     *   expectedRevision: unknown,
     *   threadId?: unknown,
     *   stateBytes?: unknown,
     * }} input
     */
    async finalize(input) {
      const checkedScope = scope(input);
      const type = operationType(input.type);
      const claimId = opaqueKey(input.claimId);
      const expectedRevision = incrementableRevision(input.expectedRevision, 1);
      const completedAt = date(now());
      const hasStateBytes = Object.hasOwn(input, "stateBytes");
      const stateBytes = hasStateBytes
        ? nonNegativeSafeInteger(input.stateBytes)
        : undefined;
      if (
        type === "turn" &&
        (!Object.hasOwn(input, "threadId") || !hasStateBytes)
      ) {
        throw new AiReviewerExternalAgentSessionValidationError();
      }
      if (type !== "turn" && Object.hasOwn(input, "threadId")) {
        throw new AiReviewerExternalAgentSessionValidationError();
      }
      const threadId = Object.hasOwn(input, "threadId")
        ? boundedIdentifier(input.threadId)
        : undefined;
      const record = await lean(
        model.findOneAndUpdate(
          {
            _id: checkedScope.scopeId,
            userId: checkedScope.userId,
            projectId: checkedScope.projectId,
            clientSessionId: checkedScope.clientSessionId,
            revision: expectedRevision,
            status: CLAIMABLE_STATUS[type],
            "operationClaim.id": claimId,
            "operationClaim.type": type,
            ...(type === "turn"
              ? { $or: [{ threadId: null }, { threadId }] }
              : {}),
          },
          {
            $set: {
              operationClaim: null,
              status: FINAL_STATUS[type],
              ...(type === "purge" ? {} : { lastActivityAt: completedAt }),
              ...(type === "turn" ? { threadId } : {}),
              ...(stateBytes == null ? {} : { stateBytes }),
            },
            $inc: { revision: 1 },
          },
          { new: true, runValidators: true },
        ),
      );
      const finalized = storedSession(record, checkedScope);
      if (finalized != null) return finalized;
      if (type === "purge") {
        const alreadyFinalized = storedSession(
          await lean(
            model.findOne({
              _id: checkedScope.scopeId,
              userId: checkedScope.userId,
              projectId: checkedScope.projectId,
              clientSessionId: checkedScope.clientSessionId,
              revision: expectedRevision + 1,
              status: "purge_failed",
              operationClaim: null,
            }),
          ),
          checkedScope,
        );
        if (alreadyFinalized != null) return alreadyFinalized;
      }
      return failedCas(checkedScope);
    },

    /**
     * @param {{
     *   userId: unknown,
     *   projectId: unknown,
     *   clientSessionId: unknown,
     *   claimId: unknown,
     *   expectedRevision: unknown,
     *   expectedStatus: unknown,
     *   expectedLastActivityAt: unknown,
     *   expectedThreadId: unknown,
     *   stateRootKey: unknown,
     * }} input
     */
    async deleteClaimedPurge(input) {
      const checkedScope = scope(input);
      const claimId = opaqueKey(input.claimId);
      const expectedRevision = nonNegativeSafeInteger(input.expectedRevision);
      const expectedStatus = status(input.expectedStatus);
      const expectedLastActivityAt = date(input.expectedLastActivityAt);
      const expectedThreadId = nullableThreadId(input.expectedThreadId);
      const expectedStateRootKey = opaqueKey(input.stateRootKey);
      const record = await lean(
        model.findOneAndDelete({
          _id: checkedScope.scopeId,
          userId: checkedScope.userId,
          projectId: checkedScope.projectId,
          clientSessionId: checkedScope.clientSessionId,
          revision: expectedRevision,
          status: expectedStatus,
          lastActivityAt: expectedLastActivityAt,
          threadId: expectedThreadId,
          stateRootKey: expectedStateRootKey,
          "operationClaim.id": claimId,
          "operationClaim.type": "purge",
        }),
      );
      return storedSession(record, checkedScope) ?? failedCas(checkedScope);
    },
  };
}
