// @ts-check

import { Buffer } from "node:buffer";

import {
  AI_REVIEWER_SKILL_COUNT_LIMIT,
  AI_REVIEWER_SKILL_DESCRIPTION_MAX_LENGTH,
  AI_REVIEWER_SKILL_MAX_BYTES,
  AI_REVIEWER_SKILL_NAME_MAX_LENGTH,
  AiReviewerSkill as AiReviewerSkillModel,
  newAiReviewerSkillId,
} from "../models/AiReviewerSkill.mjs";
import { parseAiReviewerSkill } from "./AiReviewerSkillParser.mjs";

export {
  AI_REVIEWER_SKILL_COUNT_LIMIT,
  AI_REVIEWER_SKILL_DESCRIPTION_MAX_LENGTH,
  AI_REVIEWER_SKILL_MAX_BYTES,
  AI_REVIEWER_SKILL_NAME_MAX_LENGTH,
};

const MAX_SKILL_STORE_MUTATION_RETRIES = 5;
const CONTROL_OR_LINE_SEPARATOR = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;
const HAS_CONTROL_OR_LINE_SEPARATOR = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export class AiReviewerSkillValidationError extends TypeError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "AiReviewerSkillValidationError";
  }
}

export class AiReviewerSkillByteLimitError extends AiReviewerSkillValidationError {
  constructor() {
    super(
      `An AI reviewer skill may not exceed ${AI_REVIEWER_SKILL_MAX_BYTES} bytes.`,
    );
    this.name = "AiReviewerSkillByteLimitError";
  }
}

export class AiReviewerSkillCountLimitError extends AiReviewerSkillValidationError {
  constructor() {
    super(
      `A user may not keep more than ${AI_REVIEWER_SKILL_COUNT_LIMIT} AI reviewer skills.`,
    );
    this.name = "AiReviewerSkillCountLimitError";
  }
}

export class AiReviewerSkillDuplicateNameError extends AiReviewerSkillValidationError {
  /** @param {string} name */
  constructor(name) {
    super(`An AI reviewer skill named ${JSON.stringify(name)} already exists.`);
    this.name = "AiReviewerSkillDuplicateNameError";
  }
}

export class AiReviewerSkillNotFoundError extends Error {
  constructor() {
    super("The AI reviewer skill does not exist.");
    this.name = "AiReviewerSkillNotFoundError";
  }
}

/** @param {any} query */
async function lean(query) {
  return await query.lean().exec();
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

/** @param {any} record */
function storedRevision(record) {
  const revision = record?.revision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new AiReviewerSkillValidationError(
      "The AI reviewer skill store revision is invalid.",
    );
  }
  return /** @type {number} */ (revision);
}

/**
 * Convert line-breaking and invisible framing characters to one ordinary
 * space. The printable wording can remain user-authored while no entry can
 * manufacture another line or alter the surrounding prompt-list structure.
 *
 * @param {unknown} input
 * @param {number} maximumLength
 * @param {string} field
 */
function promptListMetadata(input, maximumLength, field) {
  if (typeof input !== "string") {
    throw new AiReviewerSkillValidationError(
      `The AI reviewer skill ${field} must be a string.`,
    );
  }
  const flattened = input
    .replace(CONTROL_OR_LINE_SEPARATOR, " ")
    .replace(/[\t ]+/g, " ")
    .trim();
  const bounded = Array.from(flattened).slice(0, maximumLength).join("");
  if (bounded.length === 0) {
    throw new AiReviewerSkillValidationError(
      `The AI reviewer skill ${field} must not be empty.`,
    );
  }
  return bounded;
}

/** @param {unknown} input */
function referenceFiles(input) {
  if (
    typeof input !== "object" ||
    input == null ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw new AiReviewerSkillValidationError(
      "AI reviewer skill reference files must be keyed by relative path.",
    );
  }
  /** @type {Record<string, string>} */
  const files = {};
  for (const [relativePath, content] of Object.entries(input)) {
    const segments = relativePath.split("/");
    if (
      relativePath.length === 0 ||
      relativePath.startsWith("/") ||
      relativePath.includes("\\") ||
      HAS_CONTROL_OR_LINE_SEPARATOR.test(relativePath) ||
      segments.some(
        (segment) =>
          segment === "" ||
          segment === "." ||
          segment === ".." ||
          segment === "__proto__" ||
          segment === "constructor" ||
          segment === "prototype",
      )
    ) {
      throw new AiReviewerSkillValidationError(
        `The AI reviewer skill reference path ${JSON.stringify(relativePath)} is not a safe relative path.`,
      );
    }
    if (typeof content !== "string") {
      throw new AiReviewerSkillValidationError(
        `The AI reviewer skill reference ${JSON.stringify(relativePath)} must contain text.`,
      );
    }
    files[relativePath] = content;
  }
  return files;
}

/** @param {string} body @param {Record<string, string>} files */
function assertByteLimit(body, files) {
  let bytes = Buffer.byteLength(body, "utf8");
  for (const content of Object.values(files)) {
    bytes += Buffer.byteLength(content, "utf8");
    if (bytes > AI_REVIEWER_SKILL_MAX_BYTES) {
      throw new AiReviewerSkillByteLimitError();
    }
  }
  if (bytes > AI_REVIEWER_SKILL_MAX_BYTES) {
    throw new AiReviewerSkillByteLimitError();
  }
}

/** @param {unknown} input @param {string} field */
function identifier(input, field) {
  try {
    const value = /** @type {any} */ (input)?.toString?.();
    if (typeof value !== "string" || value.length === 0 || value.length > 200) {
      throw new AiReviewerSkillValidationError(
        `The AI reviewer skill ${field} is invalid.`,
      );
    }
    return value;
  } catch (error) {
    if (error instanceof AiReviewerSkillValidationError) {
      throw error;
    }
    throw new AiReviewerSkillValidationError(
      `The AI reviewer skill ${field} is invalid.`,
    );
  }
}

/** @param {any} value */
function storedSkill(value) {
  const id = identifier(value?.id, "identifier");
  const name = promptListMetadata(
    value?.name,
    AI_REVIEWER_SKILL_NAME_MAX_LENGTH,
    "name",
  );
  const description = promptListMetadata(
    value?.description,
    AI_REVIEWER_SKILL_DESCRIPTION_MAX_LENGTH,
    "description",
  );
  if (name !== value.name || description !== value.description) {
    throw new AiReviewerSkillValidationError(
      "Stored AI reviewer skill metadata is not sanitised.",
    );
  }
  if (typeof value?.body !== "string") {
    throw new AiReviewerSkillValidationError(
      "The AI reviewer skill body must be a string.",
    );
  }
  const files = referenceFiles(value.referenceFiles);
  assertByteLimit(value.body, files);
  return Object.freeze({
    id,
    name,
    description,
    body: value.body,
    referenceFiles: Object.freeze(files),
  });
}

/** @param {any} record */
function storedSkills(record) {
  if (record == null) {
    return [];
  }
  if (!Array.isArray(record.skills)) {
    throw new AiReviewerSkillValidationError(
      "The stored AI reviewer skills are invalid.",
    );
  }
  if (record.skills.length > AI_REVIEWER_SKILL_COUNT_LIMIT) {
    throw new AiReviewerSkillCountLimitError();
  }
  const skills = record.skills.map(storedSkill);
  const names = new Set();
  for (const skill of skills) {
    if (names.has(skill.name)) {
      throw new AiReviewerSkillDuplicateNameError(skill.name);
    }
    names.add(skill.name);
  }
  return skills;
}

/**
 * @param {{
 *   model?: typeof AiReviewerSkillModel,
 *   newSkillId?: () => unknown,
 * }} [dependencies]
 */
export function createAiReviewerSkillStore({
  model = AiReviewerSkillModel,
  newSkillId = newAiReviewerSkillId,
} = {}) {
  /**
   * @param {string} userId
   * @param {(skills: ReturnType<typeof storedSkills>) => ReturnType<typeof storedSkills> | Promise<ReturnType<typeof storedSkills>>} mutate
   */
  async function commit(userId, mutate) {
    for (
      let attempt = 0;
      attempt < MAX_SKILL_STORE_MUTATION_RETRIES;
      attempt += 1
    ) {
      const currentRecord = await lean(model.findOne({ _id: userId }));
      const revision = storedRevision(currentRecord);
      const next = await mutate(storedSkills(currentRecord));
      try {
        const record = await lean(
          model.findOneAndUpdate(
            { _id: userId, revision },
            { $set: { skills: next }, $inc: { revision: 1 } },
            {
              new: true,
              runValidators: true,
              setDefaultsOnInsert: true,
              upsert: currentRecord == null,
            },
          ),
        );
        if (record != null) {
          return storedSkills(record);
        }
      } catch (error) {
        if (!isDuplicateKeyError(error)) {
          throw error;
        }
      }
    }
    throw new Error(
      "The AI reviewer skills changed while they were being saved.",
    );
  }

  return {
    /** @param {unknown} userIdInput */
    async list(userIdInput) {
      const userId = identifier(userIdInput, "user identifier");
      return storedSkills(await lean(model.findOne({ _id: userId })));
    },

    /**
     * @param {unknown} userIdInput
     * @param {unknown} skillIdInput
     */
    async get(userIdInput, skillIdInput) {
      const userId = identifier(userIdInput, "user identifier");
      const skillId = identifier(skillIdInput, "identifier");
      const skills = storedSkills(await lean(model.findOne({ _id: userId })));
      return skills.find((skill) => skill.id === skillId) ?? null;
    },

    /**
     * @param {unknown} userIdInput
     * @param {{ skillMarkdown?: unknown, referenceFiles?: unknown }} input
     */
    async create(userIdInput, input) {
      const userId = identifier(userIdInput, "user identifier");
      if (typeof input !== "object" || input == null || Array.isArray(input)) {
        throw new AiReviewerSkillValidationError(
          "The AI reviewer skill input is invalid.",
        );
      }
      const parsed = parseAiReviewerSkill(input.skillMarkdown);
      const files = referenceFiles(input.referenceFiles ?? {});
      assertByteLimit(parsed.body, files);
      const skill = storedSkill({
        id: identifier(newSkillId(), "identifier"),
        name: promptListMetadata(
          parsed.name,
          AI_REVIEWER_SKILL_NAME_MAX_LENGTH,
          "name",
        ),
        description: promptListMetadata(
          parsed.description,
          AI_REVIEWER_SKILL_DESCRIPTION_MAX_LENGTH,
          "description",
        ),
        body: parsed.body,
        referenceFiles: files,
      });
      await commit(userId, (skills) => {
        if (skills.length >= AI_REVIEWER_SKILL_COUNT_LIMIT) {
          throw new AiReviewerSkillCountLimitError();
        }
        if (skills.some((stored) => stored.name === skill.name)) {
          throw new AiReviewerSkillDuplicateNameError(skill.name);
        }
        return [...skills, skill];
      });
      return skill;
    },

    /**
     * @param {unknown} userIdInput
     * @param {unknown} skillIdInput
     */
    async remove(userIdInput, skillIdInput) {
      const userId = identifier(userIdInput, "user identifier");
      const skillId = identifier(skillIdInput, "identifier");
      await commit(userId, (skills) => {
        const remaining = skills.filter((skill) => skill.id !== skillId);
        if (remaining.length === skills.length) {
          throw new AiReviewerSkillNotFoundError();
        }
        return remaining;
      });
    },

    /** @param {unknown} userIdInput */
    async deleteUser(userIdInput) {
      const userId = identifier(userIdInput, "user identifier");
      await model.deleteOne({ _id: userId }).exec();
    },
  };
}
