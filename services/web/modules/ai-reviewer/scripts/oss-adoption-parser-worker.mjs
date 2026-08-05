/* eslint-disable @overleaf/require-script-runner */

import fs from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

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

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == null) {
      throw new Error("Expected paired --key value arguments.");
    }
    options[key.slice(2)] = value;
  }
  for (const key of ["candidate", "install-root", "source", "max-bytes"]) {
    if (options[key] == null) {
      throw new Error(`Missing --${key}.`);
    }
  }
  return options;
}

function heapCheckpoint(checkpoints, label) {
  checkpoints.push({
    label,
    heapUsedBytes: process.memoryUsage().heapUsed,
  });
}

function skipWhitespace(source, offset) {
  let cursor = offset;
  while (cursor < source.length && /\s/.test(source[cursor])) {
    cursor += 1;
  }
  return cursor;
}

function findBalanced(source, start, open, close) {
  if (source[start] !== open) {
    return -1;
  }
  let depth = 0;
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (escapedAt(source, cursor)) {
      continue;
    }
    if (character === open) {
      depth += 1;
    } else if (character === close) {
      depth -= 1;
      if (depth === 0) {
        return cursor;
      }
    }
  }
  return -1;
}

function scanInvocationAt(source, start, macro) {
  const prefix = `\\${macro}`;
  if (!source.startsWith(prefix, start)) {
    return null;
  }
  const boundary = source[start + prefix.length];
  if (boundary != null && /[A-Za-z@]/.test(boundary)) {
    return null;
  }

  let cursor = start + prefix.length;
  if (source[cursor] === "*") {
    cursor += 1;
  }
  cursor = skipWhitespace(source, cursor);
  while (source[cursor] === "[") {
    const optionalEnd = findBalanced(source, cursor, "[", "]");
    if (optionalEnd < 0) {
      return null;
    }
    cursor = skipWhitespace(source, optionalEnd + 1);
  }
  if (source[cursor] !== "{") {
    return null;
  }
  const argumentEnd = findBalanced(source, cursor, "{", "}");
  if (argumentEnd < 0) {
    return null;
  }
  const rawValue = source.slice(cursor + 1, argumentEnd);
  const kind = RELATION_KIND.get(macro);
  if (kind == null) {
    return null;
  }
  const values =
    kind === "cite" || kind === "bibliography"
      ? rawValue
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : [rawValue.trim()];
  if (values.length === 0 || values.some((value) => value.length === 0)) {
    return null;
  }
  return {
    kind,
    macro,
    values,
    from: start,
    to: argumentEnd + 1,
  };
}

function sortAndDedupeFacts(facts) {
  const seen = new Set();
  return facts
    .filter((fact) => {
      const key = JSON.stringify(fact);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .sort(
      (left, right) =>
        left.from - right.from ||
        left.to - right.to ||
        left.macro.localeCompare(right.macro),
    );
}

function isOpaqueUtensilsNode(node) {
  const kind = typeof node.kind === "string" ? node.kind.toLowerCase() : "";
  const name = typeof node.name === "string" ? node.name.toLowerCase() : "";
  return (
    kind.includes("comment") ||
    kind.includes("verbatim") ||
    kind === "verb" ||
    (kind.startsWith("env") &&
      ["verbatim", "lstlisting", "minted"].includes(name))
  );
}

function extractUtensilsFacts(ast, source) {
  const facts = [];
  const seen = new WeakSet();
  let recognizedNodes = 0;

  function visit(node, key = "") {
    if (node == null || typeof node !== "object") {
      return;
    }
    if (seen.has(node)) {
      return;
    }
    seen.add(node);
    if (key === "comment" || isOpaqueUtensilsNode(node)) {
      return;
    }
    if (
      typeof node.name === "string" &&
      RELATION_KIND.has(node.name) &&
      Number.isInteger(node.location?.start?.offset)
    ) {
      recognizedNodes += 1;
      const fact = scanInvocationAt(
        source,
        node.location.start.offset,
        node.name,
      );
      if (fact != null) {
        facts.push(fact);
      }
    }
    for (const [childKey, child] of Object.entries(node)) {
      if (["location", "position"].includes(childKey)) {
        continue;
      }
      if (Array.isArray(child)) {
        for (const item of child) {
          visit(item, childKey);
        }
      } else {
        visit(child, childKey);
      }
    }
  }

  visit(ast);
  return {
    facts: sortAndDedupeFacts(facts),
    native: {
      recognizedNodes,
      detachedArgumentRecoveries: 0,
      fullInvocationRangesProvided: false,
      rangeReconstruction: "bounded-local-scan-from-parser-start",
    },
  };
}

function unifiedEnvironmentName(node) {
  if (typeof node.env === "string") {
    return node.env;
  }
  if (typeof node.name === "string") {
    return node.name;
  }
  if (typeof node.env?.content === "string") {
    return node.env.content;
  }
  return "";
}

function isOpaqueUnifiedNode(node) {
  const type = typeof node.type === "string" ? node.type.toLowerCase() : "";
  if (
    type.includes("comment") ||
    type === "verb" ||
    type.includes("verbatim")
  ) {
    return true;
  }
  if (type.includes("environment")) {
    return ["verbatim", "lstlisting", "minted"].includes(
      unifiedEnvironmentName(node).toLowerCase(),
    );
  }
  return false;
}

function hasAttachedUnifiedArgument(node) {
  return (
    Array.isArray(node.args) &&
    node.args.some(
      (argument) =>
        argument != null &&
        Array.isArray(argument.content) &&
        argument.content.length > 0,
    )
  );
}

function extractUnifiedFacts(ast, source) {
  const facts = [];
  const seen = new WeakSet();
  let recognizedNodes = 0;
  let detachedArgumentRecoveries = 0;

  function visit(node) {
    if (node == null || typeof node !== "object") {
      return;
    }
    if (seen.has(node)) {
      return;
    }
    seen.add(node);
    if (isOpaqueUnifiedNode(node)) {
      return;
    }
    if (
      node.type === "macro" &&
      typeof node.content === "string" &&
      RELATION_KIND.has(node.content) &&
      Number.isInteger(node.position?.start?.offset)
    ) {
      recognizedNodes += 1;
      if (!hasAttachedUnifiedArgument(node)) {
        detachedArgumentRecoveries += 1;
      }
      const fact = scanInvocationAt(
        source,
        node.position.start.offset,
        node.content,
      );
      if (fact != null) {
        facts.push(fact);
      }
    }
    for (const [key, child] of Object.entries(node)) {
      if (["position", "_renderInfo"].includes(key)) {
        continue;
      }
      if (Array.isArray(child)) {
        for (const item of child) {
          visit(item);
        }
      } else {
        visit(child);
      }
    }
  }

  visit(ast);
  return {
    facts: sortAndDedupeFacts(facts),
    native: {
      recognizedNodes,
      detachedArgumentRecoveries,
      fullInvocationRangesProvided: false,
      rangeReconstruction: "bounded-local-scan-from-parser-start",
    },
  };
}

function escapedAt(source, offset) {
  let slashCount = 0;
  for (
    let cursor = offset - 1;
    cursor >= 0 && source[cursor] === "\\";
    cursor -= 1
  ) {
    slashCount += 1;
  }
  return slashCount % 2 === 1;
}

function maskRange(buffer, from, to) {
  for (let cursor = from; cursor < to; cursor += 1) {
    if (buffer[cursor] !== "\n") {
      buffer[cursor] = " ";
    }
  }
}

function maskSuppressedSource(source) {
  const buffer = source.split("");
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    if (source[cursor] === "%" && !escapedAt(source, cursor)) {
      let end = cursor;
      while (end < source.length && source[end] !== "\n") {
        end += 1;
      }
      maskRange(buffer, cursor, end);
      cursor = end;
    }
  }
  let masked = buffer.join("");

  const environmentPattern = /\\begin\{(verbatim|lstlisting|minted)\}/g;
  for (const match of masked.matchAll(environmentPattern)) {
    const start = match.index;
    const endMarker = `\\end{${match[1]}}`;
    const endStart = masked.indexOf(endMarker, start + match[0].length);
    const end = endStart < 0 ? masked.length : endStart + endMarker.length;
    maskRange(buffer, start, end);
  }
  masked = buffer.join("");

  const verbPattern = /\\verb\*?([^\s])/g;
  for (const match of masked.matchAll(verbPattern)) {
    const start = match.index;
    const delimiter = match[1];
    const contentStart = start + match[0].length;
    let end = masked.indexOf(delimiter, contentStart);
    const lineEnd = masked.indexOf("\n", contentStart);
    if (end < 0 || (lineEnd >= 0 && end > lineEnd)) {
      end = lineEnd >= 0 ? lineEnd : masked.length;
    } else {
      end += 1;
    }
    maskRange(buffer, start, end);
  }
  return buffer.join("");
}

function boundedExactScan(source) {
  const masked = maskSuppressedSource(source);
  const macroPattern = /\\([A-Za-z@]+)\b/g;
  const facts = [];
  for (const match of masked.matchAll(macroPattern)) {
    const macro = match[1];
    if (!RELATION_KIND.has(macro)) {
      continue;
    }
    const fact = scanInvocationAt(masked, match.index, macro);
    if (fact != null) {
      facts.push(fact);
    }
  }
  return sortAndDedupeFacts(facts);
}

const options = parseArguments(process.argv.slice(2));
const maxBytes = Number(options["max-bytes"]);
const checkpoints = [];
heapCheckpoint(checkpoints, "start");

if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
  throw new Error("--max-bytes must be a positive integer.");
}

const sourceBytes = fs.statSync(options.source).size;
if (sourceBytes > maxBytes) {
  process.stdout.write(
    `${JSON.stringify({
      candidate: options.candidate,
      sourceBytes,
      parserInvoked: false,
      errorCode: "SOURCE_TOO_LARGE",
      fallbackUsed: false,
      facts: [],
      timingsMs: {
        load: 0,
        parse: 0,
        normalize: 0,
      },
      heapCheckpoints: checkpoints,
      observedPeakHeapBytes: Math.max(
        ...checkpoints.map((checkpoint) => checkpoint.heapUsedBytes),
      ),
    })}\n`,
  );
} else {
  const source = fs.readFileSync(options.source, "utf8");
  if (Buffer.byteLength(source, "utf8") !== sourceBytes) {
    throw new Error("Source changed while the parser fixture was read.");
  }

  const requireFromInstall = createRequire(
    `${options["install-root"]}/package.json`,
  );
  const loadStart = performance.now();
  let parser;
  if (options.candidate === "latex-utensils") {
    parser = requireFromInstall("latex-utensils").latexParser;
  } else if (options.candidate === "unified-latex") {
    parser = requireFromInstall(
      "@unified-latex/unified-latex",
    ).processLatexToAstViaUnified;
  } else {
    throw new Error(`Unsupported parser candidate: ${options.candidate}`);
  }
  const loadMs = performance.now() - loadStart;
  heapCheckpoint(checkpoints, "after-load");

  let ast;
  let parseFailure = null;
  const parseStart = performance.now();
  try {
    if (options.candidate === "latex-utensils") {
      ast = parser.parse(source, {
        enableComment: true,
        enableMathCharacterLocation: true,
        timeout: 30_000,
      });
    } else {
      ast = parser().parse(source);
    }
  } catch (error) {
    parseFailure = {
      name: error?.name ?? "Error",
      hasLocation: Boolean(error?.location),
    };
  }
  const parseMs = performance.now() - parseStart;
  heapCheckpoint(checkpoints, "after-parse");

  const normalizeStart = performance.now();
  let normalized;
  let fallbackUsed = false;
  if (ast == null) {
    fallbackUsed = true;
    normalized = {
      facts: boundedExactScan(source),
      native: {
        recognizedNodes: 0,
        detachedArgumentRecoveries: 0,
        fullInvocationRangesProvided: false,
        rangeReconstruction: "bounded-exact-scanner-after-parse-failure",
      },
    };
  } else if (options.candidate === "latex-utensils") {
    normalized = extractUtensilsFacts(ast, source);
  } else {
    normalized = extractUnifiedFacts(ast, source);
  }
  const normalizeMs = performance.now() - normalizeStart;
  heapCheckpoint(checkpoints, "after-normalize");

  process.stdout.write(
    `${JSON.stringify({
      candidate: options.candidate,
      sourceBytes,
      parserInvoked: true,
      errorCode: null,
      fallbackUsed,
      parseFailure,
      facts: normalized.facts,
      native: normalized.native,
      timingsMs: {
        load: loadMs,
        parse: parseMs,
        normalize: normalizeMs,
      },
      heapCheckpoints: checkpoints,
      observedPeakHeapBytes: Math.max(
        ...checkpoints.map((checkpoint) => checkpoint.heapUsedBytes),
      ),
    })}\n`,
  );
}
