// @ts-check

import { latexParser } from "latex-utensils";

const MAX_SOURCE_BYTES = 102_400;
const RELATION_KIND = new Map([
  ["input", "input"],
  ["include", "include"],
  ["section", "section"],
  ["subsection", "section"],
  ["subsubsection", "section"],
  ["label", "label"],
  ["ref", "ref"],
  ["eqref", "ref"],
  ["autoref", "ref"],
  ["cref", "ref"],
  ["Cref", "ref"],
  ["cite", "cite"],
  ["citet", "cite"],
  ["citep", "cite"],
  ["parencite", "cite"],
  ["textcite", "cite"],
  ["bibliography", "bibliography"],
  ["addbibresource", "bibliography"],
]);
const COMMA_SEPARATED_KINDS = new Set(["cite", "bibliography"]);

/**
 * @typedef {{
 *   kind: string,
 *   macro: string,
 *   values: ReadonlyArray<string>,
 *   range: Readonly<{ from: number, to: number }>,
 * }} LatexProjectRelation
 */

/** @param {any} node */
function groupArgument(node) {
  if (!Array.isArray(node.args)) {
    return null;
  }
  return (
    node.args.findLast(
      (/** @type {any} */ argument) => argument?.kind === "arg.group",
    ) ?? null
  );
}

/**
 * @param {any} node
 * @param {string} source
 */
function relationValues(node, source) {
  if (node.kind === "command.label" && typeof node.label === "string") {
    const value = node.label.trim();
    return value.length === 0 ? null : [value];
  }

  const argument = groupArgument(node);
  const from = argument?.location?.start?.offset;
  const to = argument?.location?.end?.offset;
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from < 0 ||
    to > source.length ||
    to <= from
  ) {
    return null;
  }
  const invocation = source.slice(from, to);
  if (!invocation.startsWith("{") || !invocation.endsWith("}")) {
    return null;
  }
  const value = invocation.slice(1, -1).trim();
  if (value.length === 0) {
    return null;
  }
  const kind =
    typeof node.name === "string" ? RELATION_KIND.get(node.name) : undefined;
  return kind != null && COMMA_SEPARATED_KINDS.has(kind)
    ? value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
    : [value];
}

/**
 * Extract project relationships from one bounded LaTeX source.
 *
 * Ranges are half-open UTF-16 code-unit offsets, matching JavaScript
 * `String#slice` and the AI reviewer evidence contracts.
 *
 * @param {string} source
 */
export function extractLatexProjectRelations(source) {
  if (typeof source !== "string") {
    throw new TypeError("LaTeX source must be a string.");
  }
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
    throw new RangeError("LaTeX source exceeds 102400 UTF-8 bytes.");
  }

  const ast = latexParser.parse(source, { timeout: 1_000 });
  /** @type {LatexProjectRelation[]} */
  const facts = [];

  /** @param {any} node */
  function visit(node) {
    if (node == null || typeof node !== "object") {
      return;
    }
    const kind = RELATION_KIND.get(node.name);
    const from = node.location?.start?.offset;
    const to = node.location?.end?.offset;
    if (
      kind != null &&
      Number.isSafeInteger(from) &&
      Number.isSafeInteger(to) &&
      from >= 0 &&
      to >= from &&
      to <= source.length
    ) {
      const values = relationValues(node, source);
      if (values != null && values.length > 0) {
        facts.push(
          Object.freeze({
            kind,
            macro: node.name,
            values: Object.freeze(values),
            range: Object.freeze({ from, to }),
          }),
        );
      }
    }

    for (const [key, child] of Object.entries(node)) {
      if (key === "location" || key === "comment") {
        continue;
      }
      if (Array.isArray(child)) {
        child.forEach(visit);
      } else {
        visit(child);
      }
    }
  }

  visit(ast);
  facts.sort(
    (left, right) =>
      left.range.from - right.range.from ||
      left.range.to - right.range.to ||
      left.macro.localeCompare(right.macro),
  );
  return Object.freeze(facts);
}
