// @ts-check

import { createHash } from "node:crypto";
import Path from "node:path";

import { bibtexParser } from "latex-utensils";

import {
  AgentRequestSchema,
  EvidenceReferenceSchema,
  ProjectRelativePathSchema,
  ReadProjectFileArgumentsSchema,
} from "../../shared/contracts.mjs";
import { AgentGatewayAbortError, AgentGatewayError } from "./AgentGateway.mjs";
import { extractLatexProjectRelations } from "./LatexProjectRelations.mjs";
import { modelInputCharacterBudget } from "./ModelContextBudget.mjs";

export const PROJECT_SNAPSHOT_DOCUMENT_LIMIT = 200;
const MAX_DOCUMENT_CHARACTERS = 200_000;
const MAX_PROJECT_CHARACTERS = 2_000_000;
const MAX_RELATIONSHIPS = 100;
const MAX_CITATION_AUDIT_ISSUES = 25;
const REQUIRED_BIBLIOGRAPHY_FIELDS = new Map([
  [
    "article",
    [["author"], ["title"], ["journal", "journaltitle"], ["year", "date"]],
  ],
  ["book", [["author", "editor"], ["title"], ["publisher"], ["year", "date"]]],
  ["booklet", [["author", "key"], ["title"]]],
  ["conference", [["author"], ["title"], ["booktitle"], ["year", "date"]]],
  ["inbook", [["author"], ["title"], ["publisher"], ["year", "date"]]],
  [
    "incollection",
    [["author"], ["title"], ["booktitle"], ["publisher"], ["year", "date"]],
  ],
  ["inproceedings", [["author"], ["title"], ["booktitle"], ["year", "date"]]],
  ["manual", [["author", "key", "organization"], ["title"]]],
  ["mastersthesis", [["author"], ["title"], ["school"], ["year", "date"]]],
  ["misc", [["author", "key"]]],
  ["phdthesis", [["author"], ["title"], ["school"], ["year", "date"]]],
  [
    "proceedings",
    [["editor", "key", "organization"], ["title"], ["year", "date"]],
  ],
  ["techreport", [["author"], ["title"], ["institution"], ["year", "date"]]],
  ["unpublished", [["author"], ["title"], ["note"]]],
]);

function unavailable() {
  return new AgentGatewayError(
    "The requested project content is unavailable.",
    {
      code: "AI_PROJECT_CONTENT_NOT_AVAILABLE",
      category: "configuration",
      retryable: false,
    },
  );
}

/** @param {AbortSignal | undefined} signal */
function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof AgentGatewayError
      ? signal.reason
      : new AgentGatewayAbortError();
  }
}

/** @param {unknown} value */
function normalizedPath(value) {
  if (typeof value !== "string") {
    throw unavailable();
  }
  const withoutRoot = value.startsWith("/") ? value.slice(1) : value;
  const normalized = Path.posix.normalize(withoutRoot);
  const parsed = ProjectRelativePathSchema.safeParse(normalized);
  if (!parsed.success || normalized !== withoutRoot) {
    throw unavailable();
  }
  return parsed.data;
}

/** @param {string} sourcePath @param {string} value @param {string} extension */
function relatedPath(sourcePath, value, extension) {
  const candidate = Path.posix.join(Path.posix.dirname(sourcePath), value);
  const withExtension = Path.posix.extname(candidate)
    ? candidate
    : `${candidate}${extension}`;
  const parsed = ProjectRelativePathSchema.safeParse(withExtension);
  return parsed.success ? parsed.data : null;
}

/** @param {any} document */
function documentText(document) {
  const lines = document?.lines;
  if (
    !Array.isArray(lines) ||
    lines.some((/** @type {unknown} */ line) => typeof line !== "string")
  ) {
    throw unavailable();
  }
  return lines.join("\n");
}

/** @param {unknown} request @param {string} projectId */
function assertProjectRequest(request, projectId) {
  const parsed = AgentRequestSchema.safeParse(request);
  if (
    !parsed.success ||
    parsed.data.projectId !== projectId ||
    // A request that names no document is about the project as a whole and
    // reads the project the same way an explicit project review does.
    (parsed.data.scope != null && parsed.data.scope.kind !== "project")
  ) {
    throw unavailable();
  }
  return parsed.data;
}

/**
 * @param {Map<string, any>} documents
 * @param {ReadonlyArray<any>} relationships
 */
function buildCitationAudit(documents, relationships) {
  /** @type {Map<string, { path: string, range: Readonly<{ from: number, to: number }> }>} */
  const entries = new Map();
  const reportedDuplicates = new Set();
  const reportedUnresolved = new Set();
  /** @type {Array<{ kind: "duplicate-key" | "unresolved-citation" | "missing-required-fields", key: string, entryType?: string, missingFields?: ReadonlyArray<string>, proposal?: string, evidence: ReadonlyArray<{ path: string, range: Readonly<{ from: number, to: number }> }> }>} */
  const issues = [];
  let truncated = false;
  let incomplete = relationships.some(
    (relationship) =>
      relationship.kind === "bibliography" &&
      !documents.has(relationship.target),
  );

  for (const document of documents.values()) {
    if (!/\.bib$/iu.test(document.path)) {
      continue;
    }
    let bibliography;
    try {
      bibliography = bibtexParser.parse(document.text, { timeout: 1_000 });
    } catch {
      incomplete = true;
      continue;
    }
    for (const entry of bibliography.content) {
      if (!bibtexParser.isEntry(entry)) {
        continue;
      }
      const key = entry.internalKey?.trim();
      const from = entry.location?.start?.offset;
      const to = entry.location?.end?.offset;
      if (
        typeof key !== "string" ||
        key.length === 0 ||
        !Number.isSafeInteger(from) ||
        !Number.isSafeInteger(to) ||
        from < 0 ||
        to <= from ||
        to > document.text.length
      ) {
        continue;
      }
      const evidence = Object.freeze({
        path: document.path,
        range: Object.freeze({ from, to }),
      });
      const entryType = entry.entryType.toLowerCase();
      const requiredFields = REQUIRED_BIBLIOGRAPHY_FIELDS.get(entryType);
      const actualFields = new Set(
        entry.content.map((field) => field.name?.toLowerCase()).filter(Boolean),
      );
      if (requiredFields != null && !actualFields.has("crossref")) {
        const missingFields = requiredFields
          .filter(
            (alternatives) =>
              !alternatives.some((field) => actualFields.has(field)),
          )
          .map((alternatives) => alternatives.join(" or "));
        if (missingFields.length > 0) {
          if (issues.length < MAX_CITATION_AUDIT_ISSUES) {
            issues.push(
              Object.freeze({
                kind: "missing-required-fields",
                key,
                entryType,
                missingFields: Object.freeze(missingFields),
                proposal:
                  `Add missing BibTeX fields to "${key}": ` +
                  `${missingFields.join(", ")}.`,
                evidence: Object.freeze([evidence]),
              }),
            );
          } else {
            truncated = true;
          }
        }
      }
      const first = entries.get(key);
      if (first == null) {
        entries.set(key, evidence);
      } else if (!reportedDuplicates.has(key)) {
        if (issues.length < MAX_CITATION_AUDIT_ISSUES) {
          issues.push(
            Object.freeze({
              kind: "duplicate-key",
              key,
              proposal: `Rename one duplicate "${key}" entry and update its citations.`,
              evidence: Object.freeze([first, evidence]),
            }),
          );
        } else {
          truncated = true;
        }
        reportedDuplicates.add(key);
      }
    }
  }

  for (const relationship of relationships) {
    if (
      incomplete ||
      relationship.kind !== "cite" ||
      entries.has(relationship.target) ||
      reportedUnresolved.has(relationship.target)
    ) {
      continue;
    }
    if (issues.length < MAX_CITATION_AUDIT_ISSUES) {
      issues.push(
        Object.freeze({
          kind: "unresolved-citation",
          key: relationship.target,
          proposal:
            `Add a bibliography entry for "${relationship.target}" or ` +
            `replace \\cite{${relationship.target}}.`,
          evidence: Object.freeze([relationship.source]),
        }),
      );
    } else {
      truncated = true;
    }
    reportedUnresolved.add(relationship.target);
  }

  return Object.freeze({
    incomplete,
    truncated,
    issues: Object.freeze(issues),
  });
}

/**
 * @param {string} projectId
 * @param {unknown} input
 * @param {{ contextLength?: unknown, request?: unknown }} [options]
 */
export function createProjectSnapshot(
  projectId,
  input,
  { contextLength, request } = {},
) {
  if (
    typeof projectId !== "string" ||
    projectId.length === 0 ||
    input == null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    throw unavailable();
  }
  const projectRequest = assertProjectRequest(request, projectId);
  let maxModelInputCharacters;
  try {
    maxModelInputCharacters = modelInputCharacterBudget(contextLength);
  } catch {
    throw unavailable();
  }
  const entries = Object.entries(input);
  if (
    entries.length === 0 ||
    entries.length > PROJECT_SNAPSHOT_DOCUMENT_LIMIT
  ) {
    throw unavailable();
  }

  const documents = new Map();
  let totalCharacters = 0;
  for (const [rawPath, rawDocument] of entries) {
    const path = normalizedPath(rawPath);
    const document = /** @type {any} */ (rawDocument);
    const documentId = document?._id?.toString?.();
    const revision = document?.version;
    const text = documentText(document);
    if (
      typeof documentId !== "string" ||
      documentId.length === 0 ||
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      text.length > MAX_DOCUMENT_CHARACTERS ||
      documents.has(path)
    ) {
      throw unavailable();
    }
    totalCharacters += text.length;
    if (totalCharacters > MAX_PROJECT_CHARACTERS) {
      throw unavailable();
    }
    documents.set(path, {
      documentId,
      path,
      revision,
      text,
      textHash: createHash("sha256").update(text).digest("hex"),
    });
  }

  const manifest = [...documents.values()]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(({ documentId, path, revision, text, textHash }) =>
      Object.freeze({
        documentId,
        path,
        revision,
        textHash,
        textLength: text.length,
      }),
    );
  const contextFiles = manifest.map(({ path, textLength }) =>
    Object.freeze({ path, textLength }),
  );
  const relationships = [];
  const relationshipExclusions = [];
  let relationshipsTruncated = false;
  relationshipScan: for (const document of documents.values()) {
    if (!/\.(?:cls|sty|tex)$/iu.test(document.path)) {
      continue;
    }
    let facts;
    try {
      facts = extractLatexProjectRelations(document.text);
    } catch {
      relationshipExclusions.push(
        Object.freeze({ path: document.path, reason: "parse-unavailable" }),
      );
      continue;
    }
    for (const fact of facts) {
      for (const value of fact.values) {
        if (relationships.length >= MAX_RELATIONSHIPS) {
          relationshipsTruncated = true;
          break relationshipScan;
        }
        /** @type {string | null} */
        let target = value;
        if (fact.kind === "input" || fact.kind === "include") {
          target = relatedPath(document.path, value, ".tex");
        } else if (fact.kind === "bibliography") {
          target = relatedPath(document.path, value, ".bib");
        }
        if (target == null) {
          continue;
        }
        relationships.push(
          Object.freeze({
            kind: fact.kind,
            macro: fact.macro,
            source: Object.freeze({
              path: document.path,
              range: fact.range,
            }),
            target,
          }),
        );
      }
    }
  }

  const citationAudit = buildCitationAudit(documents, relationships);
  const frozenContextFiles = Object.freeze(contextFiles);
  const frozenRelationshipExclusions = Object.freeze(relationshipExclusions);
  let successfulReadCount = 0;
  let modelInputBudgetFailureCount = 0;
  let context;
  /** @type {number} */
  let modelInputCharacters;
  while (true) {
    context = Object.freeze({
      summary: Object.freeze({
        fileCount: manifest.length,
        characterCount: totalCharacters,
        relationshipCount: relationships.length,
        relationshipExclusionCount: relationshipExclusions.length,
        relationshipsTruncated,
      }),
      files: frozenContextFiles,
      relationships: Object.freeze([...relationships]),
      relationshipExclusions: frozenRelationshipExclusions,
      citationAudit,
    });
    modelInputCharacters = JSON.stringify({
      request: projectRequest,
      project: context,
    }).length;
    if (modelInputCharacters <= maxModelInputCharacters) {
      break;
    }
    if (relationships.length === 0) {
      throw unavailable();
    }
    relationships.pop();
    relationshipsTruncated = true;
  }

  const snapshot = {
    manifest: Object.freeze(manifest),
    context,

    /**
     * @param {unknown} input
     * @param {{ request: unknown, signal?: AbortSignal }} options
     */
    async readProjectFile(input, { request, signal }) {
      throwIfAborted(signal);
      assertProjectRequest(request, projectId);
      const parsed = ReadProjectFileArgumentsSchema.safeParse(input);
      if (!parsed.success) {
        throw unavailable();
      }
      const document = documents.get(parsed.data.path);
      if (document == null) {
        throw unavailable();
      }
      const range = parsed.data.range ?? {
        from: 0,
        to: document.text.length,
      };
      if (range.to > document.text.length) {
        throw unavailable();
      }
      const result = Object.freeze({
        path: document.path,
        range: Object.freeze({ ...range }),
        revision: document.revision,
        textHash: document.textHash,
        text: document.text.slice(range.from, range.to),
      });
      const resultCharacters = JSON.stringify(result).length;
      if (resultCharacters > maxModelInputCharacters - modelInputCharacters) {
        modelInputBudgetFailureCount += 1;
        throw unavailable();
      }
      modelInputCharacters += resultCharacters;
      successfulReadCount += 1;
      return result;
    },

    /**
     * @param {unknown} evidence
     * @param {{ request: unknown, signal?: AbortSignal }} options
     */
    validateEvidence(evidence, { request, signal }) {
      throwIfAborted(signal);
      assertProjectRequest(request, projectId);
      if (!Array.isArray(evidence)) {
        throw unavailable();
      }
      for (const reference of evidence) {
        const parsed = EvidenceReferenceSchema.safeParse(reference);
        const document = parsed.success
          ? documents.get(parsed.data.path)
          : null;
        if (
          !parsed.success ||
          document == null ||
          parsed.data.range == null ||
          parsed.data.range.to > document.text.length ||
          (parsed.data.revision != null &&
            parsed.data.revision !== document.revision) ||
          (parsed.data.textHash != null &&
            parsed.data.textHash !== document.textHash)
        ) {
          throw unavailable();
        }
      }
    },
  };
  snapshot.readProjectFile.reviewCoverage = () =>
    Object.freeze({
      successfulReadCount,
      modelInputBudgetFailureCount,
      relationshipsTruncated,
    });
  return Object.freeze(snapshot);
}
