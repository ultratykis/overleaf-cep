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

/**
 * services/web does not declare a YAML parser. Skills deliberately accept the
 * portable subset needed for metadata instead of relying on a hoisted
 * transitive package that could disappear after an unrelated dependency bump.
 *
 * @param {string} source
 */
function parseSimpleFrontmatter(source) {
  /** @type {Record<string, string>} */
  const values = {};
  for (const line of source.split(/\r?\n/)) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      continue;
    }
    if (/^[\t ]/.test(line)) {
      throw invalidFrontmatter("nested or multiline values are not supported.");
    }
    const separator = line.indexOf(":");
    if (separator < 1) {
      throw invalidFrontmatter("expected a `key: value` entry.");
    }
    const key = line.slice(0, separator).trim();
    if (!SCALAR_KEY.test(key)) {
      throw invalidFrontmatter(`the key ${JSON.stringify(key)} is malformed.`);
    }
    if (Object.hasOwn(values, key)) {
      throw invalidFrontmatter(`the key ${JSON.stringify(key)} is duplicated.`);
    }
    const input = line.slice(separator + 1).trim();
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
