// @ts-check

import { createHash } from "node:crypto";

import { AiReviewerModeInstructions as AiReviewerModeInstructionsModel } from "../models/AiReviewerModeInstructions.mjs";
import {
  AiReviewerModeInstructionsSchema,
  WorkspaceRevisionSchema,
} from "../../shared/contracts.mjs";

export class AiReviewerModeInstructionValidationError extends Error {
  constructor() {
    super("The AI reviewer perspectives are invalid.");
    this.name = "AiReviewerModeInstructionValidationError";
  }
}

export class AiReviewerModeInstructionConflictError extends Error {
  constructor() {
    super("The AI reviewer perspectives changed in another session.");
    this.name = "AiReviewerModeInstructionConflictError";
  }
}

/** @param {unknown} value */
function scopeIdentifier(value) {
  try {
    const identifier = value?.toString?.();
    if (
      typeof identifier !== "string" ||
      identifier.length === 0 ||
      identifier.length > 200
    ) {
      throw new AiReviewerModeInstructionValidationError();
    }
    return /^[0-9a-f]{24}$/iu.test(identifier)
      ? identifier.toLowerCase()
      : identifier;
  } catch (error) {
    if (error instanceof AiReviewerModeInstructionValidationError) {
      throw error;
    }
    throw new AiReviewerModeInstructionValidationError();
  }
}

/**
 * Use MongoDB's always-enforced `_id` uniqueness as the ownership boundary,
 * matching the private workspace precedent for one user/project pair.
 *
 * @param {string} userId
 * @param {string} projectId
 */
function modeInstructionScopeId(userId, projectId) {
  return createHash("sha256")
    .update(JSON.stringify([userId, projectId]))
    .digest("hex");
}

/** @param {unknown} value */
function parseInstructions(value) {
  const parsed = AiReviewerModeInstructionsSchema.safeParse(value);
  if (!parsed.success) {
    throw new AiReviewerModeInstructionValidationError();
  }
  return parsed.data;
}

/** @param {unknown} value */
function parseRevision(value) {
  const parsed = WorkspaceRevisionSchema.safeParse(value);
  if (!parsed.success) {
    throw new AiReviewerModeInstructionValidationError();
  }
  return parsed.data;
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

/**
 * @param {any} record
 * @param {string} scopeId
 * @param {string} userId
 * @param {string} projectId
 */
function storedSnapshot(record, scopeId, userId, projectId) {
  if (record == null) {
    return null;
  }
  if (
    scopeIdentifier(record._id) !== scopeId ||
    scopeIdentifier(record.userId) !== userId ||
    scopeIdentifier(record.projectId) !== projectId
  ) {
    throw new AiReviewerModeInstructionValidationError();
  }
  return {
    revision: parseRevision(record.revision),
    instructions: parseInstructions(record.instructions),
  };
}

/**
 * @param {{ model?: typeof AiReviewerModeInstructionsModel }} [dependencies]
 */
export function createAiReviewerModeInstructionStore({
  model = AiReviewerModeInstructionsModel,
} = {}) {
  return {
    /**
     * @param {unknown} userIdInput
     * @param {unknown} projectIdInput
     */
    async load(userIdInput, projectIdInput) {
      const userId = scopeIdentifier(userIdInput);
      const projectId = scopeIdentifier(projectIdInput);
      const scopeId = modeInstructionScopeId(userId, projectId);
      const record = await model
        .findOne({ _id: scopeId, userId, projectId })
        .lean()
        .exec();
      return (
        storedSnapshot(record, scopeId, userId, projectId) ?? {
          revision: 0,
          instructions: {},
        }
      );
    },

    /**
     * @param {unknown} userIdInput
     * @param {unknown} projectIdInput
     * @param {unknown} instructionsInput
     * @param {unknown} expectedRevisionInput
     */
    async save(
      userIdInput,
      projectIdInput,
      instructionsInput,
      expectedRevisionInput,
    ) {
      const userId = scopeIdentifier(userIdInput);
      const projectId = scopeIdentifier(projectIdInput);
      const instructions = parseInstructions(instructionsInput);
      const expectedRevision = parseRevision(expectedRevisionInput);
      const scopeId = modeInstructionScopeId(userId, projectId);
      try {
        const record = await model
          .findOneAndUpdate(
            {
              _id: scopeId,
              userId,
              projectId,
              revision: expectedRevision,
            },
            {
              $set: { instructions },
              $inc: { revision: 1 },
            },
            {
              new: true,
              runValidators: true,
              setDefaultsOnInsert: true,
              upsert: expectedRevision === 0,
            },
          )
          .lean()
          .exec();
        const snapshot = storedSnapshot(record, scopeId, userId, projectId);
        if (snapshot == null) {
          throw new AiReviewerModeInstructionConflictError();
        }
        return snapshot;
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new AiReviewerModeInstructionConflictError();
        }
        throw error;
      }
    },

    /** @param {unknown} projectIdInput */
    async deleteProject(projectIdInput) {
      const projectId = scopeIdentifier(projectIdInput);
      return await model.deleteMany({ projectId }).exec();
    },

    /** @param {unknown} userIdInput */
    async deleteUser(userIdInput) {
      const userId = scopeIdentifier(userIdInput);
      return await model.deleteMany({ userId }).exec();
    },
  };
}
