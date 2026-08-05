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
const REVIEW_SKILL_LOAD_COUNT_LIMIT = AI_REVIEWER_SKILL_COUNT_LIMIT;
const REVIEW_SKILL_LOAD_MAX_BYTES =
  REVIEW_SKILL_LOAD_COUNT_LIMIT * AI_REVIEWER_SKILL_MAX_BYTES;
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

/** @param {unknown} input */
function gitProvenance(input) {
  if (input == null) {
    return null;
  }
  if (
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  ) {
    throw new AiReviewerSkillValidationError(
      "The AI reviewer skill provenance is invalid.",
    );
  }
  const value = /** @type {Record<string, unknown>} */ (input);
  const service = value.service;
  const resolvedSha = value.resolvedSha;
  if (
    value.kind !== "git" ||
    (service !== "github" && service !== "gitlab") ||
    typeof resolvedSha !== "string" ||
    !/^[0-9a-f]{40}$/u.test(resolvedSha)
  ) {
    throw new AiReviewerSkillValidationError(
      "The AI reviewer skill provenance is invalid.",
    );
  }
  const fields = ["host", "repository", "path"];
  for (const field of fields) {
    const fieldValue = value[field];
    if (
      typeof fieldValue !== "string" ||
      fieldValue.length === 0 ||
      fieldValue.length > 1_000 ||
      HAS_CONTROL_OR_LINE_SEPARATOR.test(fieldValue)
    ) {
      throw new AiReviewerSkillValidationError(
        "The AI reviewer skill provenance is invalid.",
      );
    }
  }
  const optionalFields = ["pluginName", "pluginVersion", "license", "homepage"];
  /** @type {Record<string, string>} */
  const optionalMetadata = {};
  for (const field of optionalFields) {
    const fieldValue = value[field];
    if (fieldValue == null) continue;
    if (
      typeof fieldValue !== "string" ||
      fieldValue.length === 0 ||
      fieldValue.length > 1_000 ||
      HAS_CONTROL_OR_LINE_SEPARATOR.test(fieldValue)
    ) {
      throw new AiReviewerSkillValidationError(
        "The AI reviewer skill provenance is invalid.",
      );
    }
    optionalMetadata[field] = fieldValue;
  }
  let owner;
  if (value.owner != null) {
    if (
      typeof value.owner !== "object" ||
      Array.isArray(value.owner) ||
      Object.getPrototypeOf(value.owner) !== Object.prototype
    ) {
      throw new AiReviewerSkillValidationError(
        "The AI reviewer skill provenance is invalid.",
      );
    }
    const ownerValue = /** @type {Record<string, unknown>} */ (value.owner);
    const ownerName = ownerValue.name;
    const ownerUrl = ownerValue.url;
    if (
      typeof ownerName !== "string" ||
      ownerName.length === 0 ||
      ownerName.length > 1_000 ||
      HAS_CONTROL_OR_LINE_SEPARATOR.test(ownerName) ||
      (ownerUrl != null &&
        (typeof ownerUrl !== "string" ||
          ownerUrl.length === 0 ||
          ownerUrl.length > 1_000 ||
          HAS_CONTROL_OR_LINE_SEPARATOR.test(ownerUrl)))
    ) {
      throw new AiReviewerSkillValidationError(
        "The AI reviewer skill provenance is invalid.",
      );
    }
    owner = Object.freeze({
      name: ownerName,
      ...(ownerUrl == null ? {} : { url: ownerUrl }),
    });
  }
  return Object.freeze({
    kind: /** @type {const} */ ("git"),
    service,
    host: /** @type {string} */ (value.host),
    repository: /** @type {string} */ (value.repository),
    path: /** @type {string} */ (value.path),
    resolvedSha,
    ...optionalMetadata,
    ...(owner == null ? {} : { owner }),
  });
}

/** @param {string} body @param {Record<string, string>} files */
export function aiReviewerSkillContentBytes(body, files) {
  let bytes = Buffer.byteLength(body, "utf8");
  for (const content of Object.values(files)) {
    bytes += Buffer.byteLength(content, "utf8");
  }
  return bytes;
}

/** @param {string} body @param {Record<string, string>} files */
function assertByteLimit(body, files) {
  if (aiReviewerSkillContentBytes(body, files) > AI_REVIEWER_SKILL_MAX_BYTES) {
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
  const provenance = gitProvenance(value.provenance);
  assertByteLimit(value.body, files);
  return Object.freeze({
    id,
    name,
    description,
    body: value.body,
    referenceFiles: Object.freeze(files),
    ...(provenance == null ? {} : { provenance }),
  });
}

/**
 * Parse and validate the exact content that would be stored without assigning
 * an identifier or mutating persistence. Git previews call the same boundary
 * as local uploads so their displayed metadata matches the eventual record.
 *
 * @param {{ skillMarkdown?: unknown, referenceFiles?: unknown, provenance?: unknown }} input
 */
export function prepareAiReviewerSkill(input) {
  if (typeof input !== "object" || input == null || Array.isArray(input)) {
    throw new AiReviewerSkillValidationError(
      "The AI reviewer skill input is invalid.",
    );
  }
  const parsed = parseAiReviewerSkill(input.skillMarkdown);
  const files = referenceFiles(input.referenceFiles ?? {});
  const provenance = gitProvenance(input.provenance);
  assertByteLimit(parsed.body, files);
  return Object.freeze({
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
    referenceFiles: Object.freeze(files),
    ...(provenance == null ? {} : { provenance }),
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

  /**
   * @param {unknown} userIdInput
   * @param {unknown} inputs
   */
  async function createMany(userIdInput, inputs) {
    const userId = identifier(userIdInput, "user identifier");
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new AiReviewerSkillValidationError(
        "At least one AI reviewer skill is required.",
      );
    }
    if (inputs.length > AI_REVIEWER_SKILL_COUNT_LIMIT) {
      throw new AiReviewerSkillCountLimitError();
    }
    const added = inputs.map((input) =>
      storedSkill({
        id: identifier(newSkillId(), "identifier"),
        ...prepareAiReviewerSkill(input),
      }),
    );
    const addedNames = new Set();
    for (const skill of added) {
      if (addedNames.has(skill.name)) {
        throw new AiReviewerSkillDuplicateNameError(skill.name);
      }
      addedNames.add(skill.name);
    }
    await commit(userId, (skills) => {
      if (skills.length + added.length > AI_REVIEWER_SKILL_COUNT_LIMIT) {
        throw new AiReviewerSkillCountLimitError();
      }
      for (const skill of added) {
        if (skills.some((stored) => stored.name === skill.name)) {
          throw new AiReviewerSkillDuplicateNameError(skill.name);
        }
      }
      return [...skills, ...added];
    });
    return added;
  }

  return {
    /** @param {unknown} userIdInput */
    async list(userIdInput) {
      const userId = identifier(userIdInput, "user identifier");
      return storedSkills(await lean(model.findOne({ _id: userId })));
    },

    /**
     * Bound the execution read at the persistence query as well as at the
     * gateway. The stored order is retained so the prompt metadata and
     * read_skill lookup describe the same finite prefix.
     *
     * @param {unknown} userIdInput
     */
    async listForReview(userIdInput) {
      const userId = identifier(userIdInput, "user identifier");
      const skills = storedSkills(
        await lean(
          model.findOne(
            { _id: userId },
            { skills: { $slice: REVIEW_SKILL_LOAD_COUNT_LIMIT } },
          ),
        ),
      );
      const bounded = [];
      let loadedBytes = 0;
      for (const skill of skills) {
        const skillBytes = aiReviewerSkillContentBytes(
          skill.body,
          skill.referenceFiles,
        );
        if (skillBytes > REVIEW_SKILL_LOAD_MAX_BYTES - loadedBytes) {
          break;
        }
        loadedBytes += skillBytes;
        bounded.push(skill);
      }
      return Object.freeze(bounded);
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
     * @param {{ skillMarkdown?: unknown, referenceFiles?: unknown, provenance?: unknown }} input
     */
    async create(userIdInput, input) {
      return (await createMany(userIdInput, [input]))[0];
    },

    /**
     * Import a selection in one CAS mutation. A count or duplicate-name
     * failure rejects the whole selection, so a multi-skill repository cannot
     * be left partially imported.
     *
     * @param {unknown} userIdInput
     * @param {unknown} inputs
     */
    createMany,

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
