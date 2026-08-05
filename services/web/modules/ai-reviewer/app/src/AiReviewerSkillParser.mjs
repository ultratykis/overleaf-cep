// @ts-check

export class AiReviewerSkillParseError extends TypeError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "AiReviewerSkillParseError";
  }
}

const FRONTMATTER_OPENING = /^---[\t ]*(?:\r?\n|$)/;
const FRONTMATTER_CLOSING = /^(?:---|\.\.\.)[\t ]*\r?$/gm;
const SCALAR_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const RESERVED_SCALAR_CHARACTERS = "[]{},&*!|>@`";
const BLOCK_SCALAR_HEADER =
  /^[|>](?:(?:[1-9][+-]?)|(?:[+-][1-9]?))?(?:[\t ]+#.*)?$/;

function invalidFrontmatter(detail) {
  return new AiReviewerSkillParseError(
    `SKILL.md frontmatter is not valid YAML: ${detail}`,
  );
}

/** @param {string} input */
function quotedScalar(input) {
  if (input.startsWith('"')) {
    try {
      const parsed = JSON.parse(input);
      if (typeof parsed !== "string") {
        throw invalidFrontmatter("values must be simple scalars.");
      }
      return parsed;
    } catch (error) {
      if (error instanceof AiReviewerSkillParseError) {
        throw error;
      }
      throw invalidFrontmatter("a double-quoted scalar is malformed.");
    }
  }
  if (input.startsWith("'")) {
    if (!input.endsWith("'") || input.length < 2) {
      throw invalidFrontmatter("a single-quoted scalar is malformed.");
    }
    return input.slice(1, -1).replaceAll("''", "'");
  }
  return null;
}

/** @param {string} input */
function plainScalar(input) {
  const commentAt = input.search(/[\t ]#/);
  const value = (commentAt < 0 ? input : input.slice(0, commentAt)).trimEnd();
  if (
    (value.length > 0 && RESERVED_SCALAR_CHARACTERS.includes(value[0])) ||
    /:\s/.test(value) ||
    Array.from(value).some((character) => "[]{}".includes(character))
  ) {
    throw invalidFrontmatter("only simple scalar values are supported.");
  }
  return value;
}

/** @param {string} input */
function validateFlowSequence(input) {
  let itemStart = 1;
  /** @type {'"' | "'" | null} */
  let quote = null;
  let closing = -1;

  /**
   * @param {number} end
   * @param {boolean} allowEmpty
   */
  const validateItem = (end, allowEmpty) => {
    const item = input.slice(itemStart, end).trim();
    if (item === "") {
      if (allowEmpty) {
        return;
      }
      throw invalidFrontmatter("only simple scalar values are supported.");
    }
    if (item.startsWith("#")) {
      throw invalidFrontmatter("only simple scalar values are supported.");
    }
    const quoted = quotedScalar(item);
    if (quoted == null) {
      plainScalar(item);
    }
  };

  for (let index = 1; index < input.length; index += 1) {
    const character = input[index];
    if (quote === '"') {
      if (character === "\\") {
        index += 1;
      } else if (character === '"') {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (character === "'" && input[index + 1] === "'") {
        index += 1;
      } else if (character === "'") {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "[" || character === "{" || character === "}") {
      throw invalidFrontmatter("only simple scalar values are supported.");
    }
    if (character === ",") {
      validateItem(index, false);
      itemStart = index + 1;
      continue;
    }
    if (character === "]") {
      const item = input.slice(itemStart, index).trim();
      validateItem(
        index,
        item === "" && (itemStart === 1 || input[itemStart - 1] === ","),
      );
      closing = index;
      break;
    }
  }

  if (quote != null || closing < 0) {
    throw invalidFrontmatter("only simple scalar values are supported.");
  }
  const remainder = input.slice(closing + 1).trim();
  if (remainder !== "" && !remainder.startsWith("#")) {
    throw invalidFrontmatter("only simple scalar values are supported.");
  }
}

/**
 * services/web does not declare a YAML parser. Skills deliberately accept the
 * portable scalar subset needed for name and description. Unused block values
 * are skipped by indentation instead of relying on a hoisted transitive
 * package that could disappear after an unrelated dependency bump.
 *
 * @param {string} source
 */
function parseSimpleFrontmatter(source) {
  /** @type {Record<string, string>} */
  const values = {};
  /** @type {Set<string>} */
  const keys = new Set();
  let skippingIndentedValue = false;
  for (const line of source.split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    if (skippingIndentedValue && /^[\t ]/.test(line)) {
      if (/^[ ]*\t/.test(line)) {
        throw invalidFrontmatter("tabs cannot be used for indentation.");
      }
      continue;
    }
    skippingIndentedValue = false;
    if (/^[\t ]/.test(line)) {
      throw invalidFrontmatter(
        "indented content must belong to a skipped top-level value.",
      );
    }
    const separator = line.indexOf(":");
    if (separator < 1) {
      throw invalidFrontmatter("expected a `key: value` entry.");
    }
    const key = line.slice(0, separator).trim();
    if (!SCALAR_KEY.test(key)) {
      throw invalidFrontmatter(`the key ${JSON.stringify(key)} is malformed.`);
    }
    if (keys.has(key)) {
      throw invalidFrontmatter(`the key ${JSON.stringify(key)} is duplicated.`);
    }
    keys.add(key);
    const input = line.slice(separator + 1).trim();
    if (input === "" || input.startsWith("#")) {
      if (key === "name" || key === "description") {
        values[key] = "";
      }
      skippingIndentedValue = true;
      continue;
    }
    if (BLOCK_SCALAR_HEADER.test(input)) {
      if (key === "name" || key === "description") {
        throw invalidFrontmatter(
          `the key ${JSON.stringify(key)} must be a simple scalar.`,
        );
      }
      skippingIndentedValue = true;
      continue;
    }
    if (input.startsWith("[")) {
      validateFlowSequence(input);
      if (key === "name" || key === "description") {
        throw invalidFrontmatter(
          `the key ${JSON.stringify(key)} must be a simple scalar.`,
        );
      }
      continue;
    }
    const quoted = quotedScalar(input);
    values[key] = quoted ?? plainScalar(input);
  }
  return values;
}

/**
 * Parse the scalar frontmatter and preserve the markdown body verbatim after
 * its delimiter. Sanitising prompt-list metadata belongs to the persistence
 * boundary; the body remains unmodified for later tool-only reads.
 *
 * @param {unknown} input
 */
export function parseAiReviewerSkill(input) {
  if (typeof input !== "string") {
    throw new AiReviewerSkillParseError("SKILL.md content must be a string.");
  }
  const source = input.startsWith("\uFEFF") ? input.slice(1) : input;
  const opening = FRONTMATTER_OPENING.exec(source);
  if (opening == null) {
    throw new AiReviewerSkillParseError(
      "SKILL.md must begin with YAML frontmatter.",
    );
  }

  FRONTMATTER_CLOSING.lastIndex = opening[0].length;
  const closing = FRONTMATTER_CLOSING.exec(source);
  if (closing == null) {
    throw invalidFrontmatter("the closing delimiter is missing.");
  }
  const frontmatter = source.slice(opening[0].length, closing.index);
  const values = parseSimpleFrontmatter(frontmatter);
  if (values.name == null || values.name.trim() === "") {
    throw new AiReviewerSkillParseError(
      "SKILL.md frontmatter must include a non-empty `name`.",
    );
  }
  if (values.description == null || values.description.trim() === "") {
    throw new AiReviewerSkillParseError(
      "SKILL.md frontmatter must include a non-empty `description`.",
    );
  }

  let bodyStart = closing.index + closing[0].length;
  if (source.startsWith("\r\n", bodyStart)) {
    bodyStart += 2;
  } else if (source.startsWith("\n", bodyStart)) {
    bodyStart += 1;
  }
  return Object.freeze({
    name: values.name,
    description: values.description,
    body: source.slice(bodyStart),
  });
}
