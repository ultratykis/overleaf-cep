// @ts-check

import { createHash, randomUUID } from "node:crypto";

import { AiReviewerExternalAgentSession as AiReviewerExternalAgentSessionModel } from "../models/AiReviewerExternalAgentSession.mjs";

/** @typedef {"review" | "agent"} SessionMode */
/** @typedef {"turn" | "resolve" | "reopen" | "purge"} OperationType */
/** @typedef {"active" | "resolved" | "purge_failed"} SessionStatus */

const MODES = new Set(["review", "agent"]);
const OPERATION_TYPES = new Set(["turn", "resolve", "reopen", "purge"]);
const STATUSES = new Set(["active", "resolved", "purge_failed"]);
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
 * @param {1 | 2} remainingIncrements
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
     * @param {{
     *   userId: unknown,
     *   projectId: unknown,
     *   clientSessionId: unknown,
     *   type: unknown,
     *   expectedRevision: unknown,
     *   expectedThreadId?: unknown,
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
      if (
        (type === "resolve" || type === "reopen") &&
        hasExpectedThreadId &&
        expectedThreadId == null
      ) {
        throw new AiReviewerExternalAgentSessionValidationError();
      }
      const filter = {
        _id: checkedScope.scopeId,
        userId: checkedScope.userId,
        projectId: checkedScope.projectId,
        clientSessionId: checkedScope.clientSessionId,
        revision: expectedRevision,
        status: CLAIMABLE_STATUS[type],
        operationClaim: null,
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
              ...(type === "purge" ? {} : { lastActivityAt: claimedAt }),
            },
            $inc: { revision: 1 },
          },
          { new: true, runValidators: true },
        ),
      );
      return storedSession(record, checkedScope) ?? failedCas(checkedScope);
    },

    /**
     * Finalizing `purge` records a partial purge failure. Successful hard
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
      return storedSession(record, checkedScope) ?? failedCas(checkedScope);
    },
  };
}
