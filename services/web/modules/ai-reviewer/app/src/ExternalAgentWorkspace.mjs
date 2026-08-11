// @ts-check

import { createHash } from "node:crypto";
import Fs from "node:fs";
import Path from "node:path";

import DMP from "diff-match-patch";
import { Snapshot } from "overleaf-editor-core";

import { ProjectRelativePathSchema } from "../../shared/contracts.mjs";

const DOCUMENT_LIMIT = 200;
const MAX_DOCUMENT_CHARACTERS = 200_000;
const MAX_PROJECT_CHARACTERS = 2_000_000;
const MAX_REPORTED_FILE_EXCLUSIONS = 10;
const EDIT_LIMIT = 100;
const INLINE_EQUALITY_MERGE_LIMIT = 32;
const MANIFEST_VERSION = 1;
const ADDED = 1;
const REMOVED = -1;
const UNCHANGED = 0;
const AGENT_CONTROL_DIRECTORIES = new Set([".agents", ".codex", ".git"]);
const AGENT_CONTROL_FILES = new Set(["AGENTS.md", "AGENTS.override.md"]);

/**
 * @typedef {{
 *   documentId: string,
 *   path: string,
 *   revision: number,
 *   text: string,
 *   textHash: string,
 * }} ExternalAgentHistoryDocument
 */

/**
 * @typedef {{
 *   path: string,
 *   reason: "document-too-large" | "document-unversioned",
 *   textLength: number,
 *   maxTextLength: number,
 * }} ExternalAgentFileExclusion
 */

/**
 * @typedef {{
 *   projectId: string,
 *   historyVersion: number,
 *   documents: ReadonlyArray<Readonly<ExternalAgentHistoryDocument>>,
 *   fileExclusionCount?: number,
 *   fileExclusions?: ReadonlyArray<Readonly<ExternalAgentFileExclusion>>,
 * }} ExternalAgentHistorySnapshot
 */

/**
 * @typedef {{
 *   range: { from: number, to: number },
 *   original: string,
 *   replacement: string,
 * }} ExternalAgentTextEdit
 */

export class ExternalAgentWorkspaceError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ExternalAgentWorkspaceError";
    this.code = code;
    this.details = details;
  }
}

function invalidSnapshot() {
  return new ExternalAgentWorkspaceError(
    "AI_EXTERNAL_WORKSPACE_INVALID_SNAPSHOT",
    "The project history snapshot cannot be materialized.",
  );
}

/** @param {string} value */
function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {unknown} value */
function normalizedPath(value) {
  if (typeof value !== "string") {
    throw invalidSnapshot();
  }
  const withoutRoot = value.startsWith("/") ? value.slice(1) : value;
  const normalized = Path.posix.normalize(withoutRoot);
  const parsed = ProjectRelativePathSchema.safeParse(normalized);
  const segments = normalized.split("/");
  if (
    !parsed.success ||
    normalized !== withoutRoot ||
    segments.some((segment) => AGENT_CONTROL_DIRECTORIES.has(segment)) ||
    AGENT_CONTROL_FILES.has(Path.posix.basename(normalized))
  ) {
    throw invalidSnapshot();
  }
  return parsed.data;
}

/** @param {Iterable<string>} paths */
function hasPathPrefixCollision(paths) {
  const sorted = [...paths].sort();
  return sorted.some(
    (path, index) => sorted[index + 1]?.startsWith(`${path}/`) === true,
  );
}

/**
 * Convert Overleaf's history representation into the exact editable document
 * state that an external agent may see. The history version is deliberately
 * separate from each document's OT revision.
 *
 * @param {{
 *   projectId: unknown,
 *   historyVersion: unknown,
 *   rawSnapshot: unknown,
 * }} input
 * @returns {Readonly<ExternalAgentHistorySnapshot>}
 */
export function createExternalAgentHistorySnapshot(input) {
  const { projectId, historyVersion, rawSnapshot } = input;
  if (
    typeof projectId !== "string" ||
    projectId.length === 0 ||
    typeof historyVersion !== "number" ||
    !Number.isSafeInteger(historyVersion) ||
    historyVersion < 0
  ) {
    throw invalidSnapshot();
  }

  /** @type {Snapshot} */
  let snapshot;
  try {
    snapshot = Snapshot.fromRaw(/** @type {any} */ (rawSnapshot));
  } catch {
    throw invalidSnapshot();
  }
  const rawVersions = snapshot.getV2DocVersions()?.toRaw();
  if (rawVersions == null || typeof rawVersions !== "object") {
    throw invalidSnapshot();
  }

  /** @type {ExternalAgentHistoryDocument[]} */
  const documents = [];
  /** @type {Array<Readonly<ExternalAgentFileExclusion>>} */
  const fileExclusions = [];
  const documentIds = new Set();
  const paths = new Set();
  let totalCharacters = 0;
  for (const [documentId, rawVersion] of Object.entries(rawVersions)) {
    const path = normalizedPath(rawVersion?.pathname);
    const lastAppliedRevision = rawVersion?.v;
    // History stores the operation's base revision; ShareJS advances after it.
    const revision =
      typeof lastAppliedRevision === "number"
        ? lastAppliedRevision + 1
        : Number.NaN;
    const file = snapshot.getFile(path) ?? snapshot.getFile(`/${path}`);
    const text = file?.getContent({ filterTrackedDeletes: true });
    if (
      documentId.length === 0 ||
      typeof lastAppliedRevision !== "number" ||
      !Number.isSafeInteger(lastAppliedRevision) ||
      lastAppliedRevision < 0 ||
      !Number.isSafeInteger(revision) ||
      typeof text !== "string" ||
      documentIds.has(documentId) ||
      paths.has(path)
    ) {
      throw invalidSnapshot();
    }
    documentIds.add(documentId);
    paths.add(path);
    if (text.length > MAX_DOCUMENT_CHARACTERS) {
      fileExclusions.push(
        Object.freeze({
          path,
          reason: "document-too-large",
          textLength: text.length,
          maxTextLength: MAX_DOCUMENT_CHARACTERS,
        }),
      );
      continue;
    }
    totalCharacters += text.length;
    if (totalCharacters > MAX_PROJECT_CHARACTERS) {
      throw invalidSnapshot();
    }
    documents.push(
      Object.freeze({
        documentId,
        path,
        revision,
        text,
        textHash: sha256(text),
      }),
    );
  }

  const editablePaths = snapshot
    .getFilePathnames()
    .filter((path) => {
      try {
        return typeof snapshot.getFile(path)?.getContent() === "string";
      } catch {
        return false;
      }
    })
    .map(normalizedPath);
  const editablePathSet = new Set(editablePaths);
  for (const path of editablePathSet) {
    if (paths.has(path)) {
      continue;
    }
    const file = snapshot.getFile(path) ?? snapshot.getFile(`/${path}`);
    const text = file?.getContent({ filterTrackedDeletes: true });
    if (typeof text !== "string") {
      throw invalidSnapshot();
    }
    // A requested unversioned document intentionally falls through as stale.
    fileExclusions.push(
      Object.freeze({
        path,
        reason: "document-unversioned",
        textLength: text.length,
        maxTextLength: MAX_DOCUMENT_CHARACTERS,
      }),
    );
    paths.add(path);
  }
  const includedPaths = new Set([
    ...documents.map(({ path }) => path),
    ...fileExclusions.map(({ path }) => path),
  ]);
  if (
    documents.length === 0 ||
    documentIds.size > DOCUMENT_LIMIT ||
    paths.size > DOCUMENT_LIMIT ||
    editablePaths.length !== editablePathSet.size ||
    editablePaths.some((path) => !includedPaths.has(path))
  ) {
    throw invalidSnapshot();
  }

  documents.sort((left, right) => left.path.localeCompare(right.path));
  fileExclusions.sort((left, right) => left.path.localeCompare(right.path));
  if (hasPathPrefixCollision(paths)) {
    throw invalidSnapshot();
  }

  return Object.freeze({
    projectId,
    historyVersion,
    documents: Object.freeze(documents),
    ...(fileExclusions.length === 0
      ? {}
      : {
          fileExclusionCount: fileExclusions.length,
          fileExclusions: Object.freeze(
            fileExclusions.slice(0, MAX_REPORTED_FILE_EXCLUSIONS),
          ),
        }),
  });
}

/**
 * @param {unknown} value
 * @returns {Readonly<ExternalAgentHistorySnapshot>}
 */
export function validateExternalAgentHistorySnapshot(value) {
  const input = /** @type {any} */ (value);
  if (
    typeof input !== "object" ||
    input == null ||
    typeof input.projectId !== "string" ||
    input.projectId.length === 0 ||
    !Number.isSafeInteger(input.historyVersion) ||
    input.historyVersion < 0 ||
    !Array.isArray(input.documents) ||
    input.documents.length === 0 ||
    input.documents.length > DOCUMENT_LIMIT
  ) {
    throw invalidSnapshot();
  }
  const documentIds = new Set();
  const paths = new Set();
  let totalCharacters = 0;
  /** @type {ExternalAgentHistoryDocument[]} */
  const documents = input.documents.map((/** @type {any} */ document) => {
    if (
      typeof document !== "object" ||
      document == null ||
      typeof document.documentId !== "string" ||
      document.documentId.length === 0 ||
      typeof document.path !== "string" ||
      normalizedPath(document.path) !== document.path ||
      !Number.isSafeInteger(document.revision) ||
      document.revision < 0 ||
      typeof document.text !== "string" ||
      document.text.length > MAX_DOCUMENT_CHARACTERS ||
      typeof document.textHash !== "string" ||
      sha256(document.text) !== document.textHash ||
      documentIds.has(document.documentId) ||
      paths.has(document.path)
    ) {
      throw invalidSnapshot();
    }
    totalCharacters += document.text.length;
    if (totalCharacters > MAX_PROJECT_CHARACTERS) {
      throw invalidSnapshot();
    }
    documentIds.add(document.documentId);
    paths.add(document.path);
    return Object.freeze({
      documentId: document.documentId,
      path: document.path,
      revision: document.revision,
      text: document.text,
      textHash: document.textHash,
    });
  });
  documents.sort((left, right) => left.path.localeCompare(right.path));
  const hasFileExclusionCount = Object.hasOwn(input, "fileExclusionCount");
  const hasFileExclusions = Object.hasOwn(input, "fileExclusions");
  if (hasFileExclusionCount !== hasFileExclusions) {
    throw invalidSnapshot();
  }
  let fileExclusionCount = 0;
  /** @type {Array<Readonly<ExternalAgentFileExclusion>>} */
  let fileExclusions = [];
  if (hasFileExclusions) {
    fileExclusionCount = input.fileExclusionCount;
    if (
      !Number.isSafeInteger(fileExclusionCount) ||
      fileExclusionCount <= 0 ||
      documents.length + fileExclusionCount > DOCUMENT_LIMIT ||
      !Array.isArray(input.fileExclusions) ||
      input.fileExclusions.length !==
        Math.min(fileExclusionCount, MAX_REPORTED_FILE_EXCLUSIONS)
    ) {
      throw invalidSnapshot();
    }
    fileExclusions = input.fileExclusions.map(
      (/** @type {any} */ exclusion) => {
        if (
          typeof exclusion !== "object" ||
          exclusion == null ||
          Object.keys(exclusion).length !== 4 ||
          typeof exclusion.path !== "string" ||
          normalizedPath(exclusion.path) !== exclusion.path ||
          (exclusion.reason !== "document-too-large" &&
            exclusion.reason !== "document-unversioned") ||
          !Number.isSafeInteger(exclusion.textLength) ||
          (exclusion.reason === "document-too-large"
            ? exclusion.textLength <= MAX_DOCUMENT_CHARACTERS
            : exclusion.textLength < 0) ||
          exclusion.maxTextLength !== MAX_DOCUMENT_CHARACTERS ||
          paths.has(exclusion.path)
        ) {
          throw invalidSnapshot();
        }
        paths.add(exclusion.path);
        return Object.freeze({
          path: exclusion.path,
          reason: /** @type {"document-too-large" | "document-unversioned"} */ (
            exclusion.reason
          ),
          textLength: exclusion.textLength,
          maxTextLength: MAX_DOCUMENT_CHARACTERS,
        });
      },
    );
  }
  if (hasPathPrefixCollision(paths)) {
    throw invalidSnapshot();
  }
  return Object.freeze({
    projectId: input.projectId,
    historyVersion: input.historyVersion,
    documents: Object.freeze(documents),
    ...(fileExclusionCount === 0
      ? {}
      : {
          fileExclusionCount,
          fileExclusions: Object.freeze(fileExclusions),
        }),
  });
}

/**
 * @param {string} rootDirectory
 * @param {ReturnType<typeof createExternalAgentHistorySnapshot>} snapshot
 * @param {{ baselineRootDirectory?: string }} [options]
 */
export async function materializeExternalAgentWorkspace(
  rootDirectory,
  snapshot,
  { baselineRootDirectory } = {},
) {
  if (
    !Path.isAbsolute(rootDirectory) ||
    (baselineRootDirectory != null && !Path.isAbsolute(baselineRootDirectory))
  ) {
    throw new ExternalAgentWorkspaceError(
      "AI_EXTERNAL_WORKSPACE_INVALID_ROOT",
      "The external agent workspace root must be absolute.",
    );
  }
  const checkedSnapshot = validateExternalAgentHistorySnapshot(snapshot);
  const runDirectory = await Fs.promises.mkdtemp(
    Path.join(rootDirectory, "ai-reviewer-agent-"),
  );
  /** @type {string | null} */
  let baselineRunDirectory = null;
  try {
    if (baselineRootDirectory != null) {
      baselineRunDirectory = await Fs.promises.mkdtemp(
        Path.join(baselineRootDirectory, "ai-reviewer-agent-base-"),
      );
    }
    const baseParent = baselineRunDirectory ?? runDirectory;
    const baseDirectory = Path.join(baseParent, "base");
    const workDirectory = Path.join(runDirectory, "work");
    await Promise.all([
      Fs.promises.mkdir(baseDirectory, { mode: 0o700 }),
      Fs.promises.mkdir(workDirectory, { mode: 0o700 }),
    ]);
    for (const document of checkedSnapshot.documents) {
      const basePath = Path.join(baseDirectory, ...document.path.split("/"));
      const workPath = Path.join(workDirectory, ...document.path.split("/"));
      await Promise.all([
        Fs.promises.mkdir(Path.dirname(basePath), {
          recursive: true,
          mode: 0o700,
        }),
        Fs.promises.mkdir(Path.dirname(workPath), {
          recursive: true,
          mode: 0o700,
        }),
      ]);
      await Promise.all([
        Fs.promises.writeFile(basePath, document.text, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        }),
        Fs.promises.writeFile(workPath, document.text, {
          encoding: "utf8",
          flag: "wx",
          mode: 0o600,
        }),
      ]);
    }

    const manifest = Object.freeze({
      formatVersion: MANIFEST_VERSION,
      projectId: checkedSnapshot.projectId,
      historyVersion: checkedSnapshot.historyVersion,
      documents: Object.freeze(
        checkedSnapshot.documents.map((document) =>
          Object.freeze({
            documentId: document.documentId,
            path: document.path,
            revision: document.revision,
            textHash: document.textHash,
            textLength: document.text.length,
          }),
        ),
      ),
    });
    const manifestPath = Path.join(baseParent, "manifest.json");
    await Fs.promises.writeFile(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );

    return Object.freeze({
      runDirectory,
      baselineRunDirectory,
      baseDirectory,
      workDirectory,
      manifestPath,
      manifest,
    });
  } catch (error) {
    await Promise.all(
      [runDirectory, baselineRunDirectory]
        .filter((directory) => directory != null)
        .map((directory) =>
          Fs.promises.rm(directory, { recursive: true, force: true }),
        ),
    );
    throw error;
  }
}

/** @param {string} value */
function shouldMergeEquality(value) {
  return value.length < INLINE_EQUALITY_MERGE_LIMIT && !value.includes("\n");
}

/**
 * Compute exact, base-relative UTF-16 edits without Git or unified-diff
 * parsing.
 *
 * @param {string} original
 * @param {string} replacement
 */
export function deriveExternalAgentTextEdits(original, replacement) {
  if (original === replacement) {
    return Object.freeze([]);
  }
  const dmp = new DMP();
  // The input is bounded above. Still cap the search: a timed-out diff may be
  // coarser, but the reconstruction check below makes it no less exact.
  dmp.Diff_Timeout = 0.1;
  const differences = dmp.diff_main(original, replacement);
  dmp.diff_cleanupSemantic(differences);
  const hasLaterChange = new Array(differences.length);
  let laterChangeSeen = false;
  for (let index = differences.length - 1; index >= 0; index -= 1) {
    hasLaterChange[index] = laterChangeSeen;
    if (differences[index][0] !== UNCHANGED) {
      laterChangeSeen = true;
    }
  }

  /** @type {ExternalAgentTextEdit[]} */
  const edits = [];
  let cursor = 0;
  /** @type {{ from: number, original: string, replacement: string } | null} */
  let pending = null;

  function flush() {
    if (pending == null) {
      return;
    }
    if (pending.original !== pending.replacement) {
      edits.push(
        Object.freeze({
          range: Object.freeze({
            from: pending.from,
            to: pending.from + pending.original.length,
          }),
          original: pending.original,
          replacement: pending.replacement,
        }),
      );
    }
    pending = null;
  }

  for (const [index, [type, value]] of differences.entries()) {
    if (type === UNCHANGED) {
      if (
        pending != null &&
        hasLaterChange[index] &&
        shouldMergeEquality(value)
      ) {
        pending.original += value;
        pending.replacement += value;
      } else {
        flush();
      }
      cursor += value.length;
      continue;
    }
    pending ??= { from: cursor, original: "", replacement: "" };
    if (type === REMOVED) {
      pending.original += value;
      cursor += value.length;
    } else if (type === ADDED) {
      pending.replacement += value;
    } else {
      throw new ExternalAgentWorkspaceError(
        "AI_EXTERNAL_WORKSPACE_DIFF_INVALID",
        "The external agent diff contains an unknown operation.",
      );
    }
  }
  flush();

  let reconstructed = "";
  let reconstructedCursor = 0;
  for (const edit of edits) {
    if (
      edit.range.from < reconstructedCursor ||
      original.slice(edit.range.from, edit.range.to) !== edit.original
    ) {
      throw new ExternalAgentWorkspaceError(
        "AI_EXTERNAL_WORKSPACE_DIFF_INVALID",
        "The external agent changes could not be reconstructed.",
      );
    }
    reconstructed += original.slice(reconstructedCursor, edit.range.from);
    reconstructed += edit.replacement;
    reconstructedCursor = edit.range.to;
  }
  reconstructed += original.slice(reconstructedCursor);
  if (reconstructed !== replacement) {
    throw new ExternalAgentWorkspaceError(
      "AI_EXTERNAL_WORKSPACE_DIFF_INVALID",
      "The external agent changes could not be reconstructed.",
    );
  }
  return Object.freeze(edits);
}

/**
 * @param {string} directory
 * @param {string} [relativeDirectory]
 * @returns {Promise<string[]>}
 */
async function listRegularFiles(directory, relativeDirectory = "") {
  const absoluteDirectory = relativeDirectory
    ? Path.join(directory, ...relativeDirectory.split("/"))
    : directory;
  const entries = await Fs.promises.readdir(absoluteDirectory, {
    withFileTypes: true,
  });
  const files = [];
  for (const entry of entries) {
    const relativePath = relativeDirectory
      ? `${relativeDirectory}/${entry.name}`
      : entry.name;
    if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
      throw new ExternalAgentWorkspaceError(
        "AI_EXTERNAL_WORKSPACE_UNSUPPORTED_CHANGE",
        "The external agent created an unsupported filesystem entry.",
        { path: relativePath },
      );
    }
    if (entry.isDirectory()) {
      files.push(...(await listRegularFiles(directory, relativePath)));
    } else {
      files.push(normalizedPath(relativePath));
    }
  }
  return files;
}

/** @param {string} filename */
async function readUtf8(filename) {
  const bytes = await Fs.promises.readFile(filename);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ExternalAgentWorkspaceError(
      "AI_EXTERNAL_WORKSPACE_UNSUPPORTED_CHANGE",
      "The external agent produced non-UTF-8 content.",
    );
  }
}

/**
 * Compare the runner-owned base with the agent-writable tree and return the
 * fields needed to build ordinary Overleaf suggestions. No Git repository or
 * diff text is involved.
 *
 * @param {Awaited<ReturnType<typeof materializeExternalAgentWorkspace>>} workspace
 */
export async function collectExternalAgentWorkspaceEdits(workspace) {
  const expectedPaths = new Set(
    workspace.manifest.documents.map((document) => document.path),
  );
  const actualPaths = await listRegularFiles(workspace.workDirectory);
  const unsupportedPaths = actualPaths.filter(
    (path) => !expectedPaths.has(path),
  );
  const missingPaths = [...expectedPaths].filter(
    (path) => !actualPaths.includes(path),
  );
  if (unsupportedPaths.length > 0 || missingPaths.length > 0) {
    throw new ExternalAgentWorkspaceError(
      "AI_EXTERNAL_WORKSPACE_UNSUPPORTED_CHANGE",
      "The external agent added, removed, or renamed a project file.",
      { unsupportedPaths, missingPaths },
    );
  }

  const edits = [];
  let workCharacters = 0;
  for (const document of workspace.manifest.documents) {
    const segments = document.path.split("/");
    const baseText = await readUtf8(
      Path.join(workspace.baseDirectory, ...segments),
    );
    const workText = await readUtf8(
      Path.join(workspace.workDirectory, ...segments),
    );
    if (
      baseText.length !== document.textLength ||
      sha256(baseText) !== document.textHash
    ) {
      throw new ExternalAgentWorkspaceError(
        "AI_EXTERNAL_WORKSPACE_BASE_MISMATCH",
        "The runner-owned external agent baseline changed.",
        { path: document.path },
      );
    }
    workCharacters += workText.length;
    if (
      workText.length > MAX_DOCUMENT_CHARACTERS ||
      workCharacters > MAX_PROJECT_CHARACTERS
    ) {
      throw new ExternalAgentWorkspaceError(
        "AI_EXTERNAL_WORKSPACE_CONTENT_LIMIT",
        "The external agent output exceeds the review limits.",
      );
    }
    if (sha256(workText) === document.textHash) {
      continue;
    }
    for (const edit of deriveExternalAgentTextEdits(baseText, workText)) {
      edits.push(
        Object.freeze({
          documentId: document.documentId,
          path: document.path,
          baseRevision: document.revision,
          baseTextHash: document.textHash,
          range: edit.range,
          original: edit.original,
          replacement: edit.replacement,
        }),
      );
      if (edits.length > EDIT_LIMIT) {
        throw new ExternalAgentWorkspaceError(
          "AI_EXTERNAL_WORKSPACE_EDIT_LIMIT",
          "The external agent produced too many reviewable edits.",
        );
      }
    }
  }

  return Object.freeze({
    projectId: workspace.manifest.projectId,
    historyVersion: workspace.manifest.historyVersion,
    edits: Object.freeze(edits),
  });
}

/**
 * Recheck one history-anchored edit against a current Overleaf document. This
 * is intentionally exact: any concurrent edit remains reviewable as a stale
 * result, but cannot cross into the realtime/OT application path.
 *
 * @param {{
 *   documentId: string,
 *   path: string,
 *   baseRevision: number,
 *   baseTextHash: string,
 *   range: { from: number, to: number },
 *   original: string,
 *   replacement: string,
 * }} edit
 * @param {{
 *   documentId: unknown,
 *   path: unknown,
 *   revision: unknown,
 *   text: unknown,
 * }} currentDocument
 */
export function assertExternalAgentEditMatchesDocument(edit, currentDocument) {
  const currentText = currentDocument?.text;
  if (
    currentDocument?.documentId !== edit.documentId ||
    currentDocument?.path !== edit.path ||
    currentDocument?.revision !== edit.baseRevision ||
    typeof currentText !== "string" ||
    sha256(currentText) !== edit.baseTextHash ||
    edit.range.to > currentText.length ||
    currentText.slice(edit.range.from, edit.range.to) !== edit.original
  ) {
    throw new ExternalAgentWorkspaceError(
      "AI_EXTERNAL_WORKSPACE_STALE",
      "The Overleaf document changed after the external agent started.",
      { documentId: edit.documentId, path: edit.path },
    );
  }
  return edit;
}
