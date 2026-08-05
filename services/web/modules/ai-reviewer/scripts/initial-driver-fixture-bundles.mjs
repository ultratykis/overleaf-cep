/* eslint-disable @overleaf/require-script-runner */
// @ts-check

import { Buffer } from "node:buffer";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { assembleInitialDriverFixtureBundlesV1 } from "../app/src/v1/conformance/InitialDriverFixtureBundleAssemblyV1.mjs";
import {
  canonicalEncode,
  sha256Hex,
} from "../app/src/v1/foundation/CanonicalEncodingV1.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const MODULE_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const DEFAULT_REPOSITORY_ROOT = resolve(MODULE_ROOT, "../../../..");
const MANIFEST_FILE = "bundle.manifest.v1.canonical.json";
const MAXIMUM_FILE_COUNT = 128;
const MAXIMUM_TOTAL_BYTES = 64 * 1_024 * 1_024;
/** @type {{ files: Map<string, ExpectedFile>, bundleRoots: string[] } | null} */
let expectedFilesCache = null;

/**
 * @typedef {{
 *   bytes: Uint8Array,
 *   repositoryRelativePath: string
 * }} ExpectedFile
 */

/** @param {string} value */
function assertRelativePath(value) {
  const segments = value.split("/");
  if (
    value.length === 0 ||
    isAbsolute(value) ||
    value.includes("\\") ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    )
  ) {
    throw new TypeError(`Invalid fixture path: path=${value}`);
  }
  return value;
}

/** @param {string} path */
function lstatIfPresent(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      Reflect.get(error, "code") === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * @param {string} repositoryRoot
 * @param {string} repositoryRelativePath
 */
function absolutePath(repositoryRoot, repositoryRelativePath) {
  const checked = assertRelativePath(repositoryRelativePath);
  const absolute = resolve(repositoryRoot, ...checked.split("/"));
  const fromRoot = relative(repositoryRoot, absolute);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new TypeError(`Fixture path escapes repository: path=${checked}`);
  }
  return absolute;
}

/** @param {string} repositoryRoot */
function assertRepositoryRoot(repositoryRoot) {
  const stats = lstatIfPresent(repositoryRoot);
  if (stats === null || stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new TypeError(
      "Fixture repository root is not a regular directory: path=.",
    );
  }
}

/** @returns {{ files: Map<string, ExpectedFile>, bundleRoots: string[] }} */
function assembleExpectedFiles() {
  if (expectedFilesCache !== null) {
    return expectedFilesCache;
  }
  const files = new Map();
  const bundleRoots = [];
  let totalBytes = 0;
  for (const bundle of assembleInitialDriverFixtureBundlesV1()) {
    const root = assertRelativePath(
      bundle.sourceBundleManifest.repositoryRelativeRoot,
    );
    if (bundleRoots.includes(root)) {
      throw new TypeError(`Duplicate fixture bundle root: path=${root}`);
    }
    bundleRoots.push(root);
    for (const [logicalPath, material] of Object.entries(
      bundle.filesByLogicalPath,
    )) {
      addExpectedFile(
        `${root}/${assertRelativePath(logicalPath)}`,
        material.bytes,
      );
    }
    addExpectedFile(
      `${root}/${MANIFEST_FILE}`,
      canonicalEncode(bundle.sourceBundleManifest),
    );
  }
  if (files.size > MAXIMUM_FILE_COUNT || totalBytes > MAXIMUM_TOTAL_BYTES) {
    throw new RangeError(
      `Fixture output limit exceeded: count=${files.size} bytes=${totalBytes}`,
    );
  }
  expectedFilesCache = { files, bundleRoots };
  return expectedFilesCache;

  /** @param {string} path @param {Uint8Array} bytes */
  function addExpectedFile(path, bytes) {
    const repositoryRelativePath = assertRelativePath(path);
    if (files.has(repositoryRelativePath)) {
      throw new TypeError(
        `Duplicate fixture file: path=${repositoryRelativePath}`,
      );
    }
    const copy = Uint8Array.from(bytes);
    totalBytes += copy.byteLength;
    files.set(repositoryRelativePath, { bytes: copy, repositoryRelativePath });
  }
}

/**
 * @param {string} repositoryRoot
 * @param {string} bundleRoot
 */
function collectBundleFiles(repositoryRoot, bundleRoot) {
  /** @type {Map<string, { absolute: string, size: number }>} */
  const files = new Map();
  const rootPath = absolutePath(repositoryRoot, bundleRoot);
  const rootStats = lstatIfPresent(rootPath);
  if (rootStats === null) {
    return files;
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new TypeError(
      `Fixture bundle root is not a directory: path=${bundleRoot}`,
    );
  }
  visit(rootPath, bundleRoot);
  return files;

  /** @param {string} directory @param {string} relativeDirectory */
  function visit(directory, relativeDirectory) {
    for (const name of readdirSync(directory).sort()) {
      const repositoryRelativePath = `${relativeDirectory}/${name}`;
      const child = join(directory, name);
      const stats = lstatSync(child);
      if (stats.isSymbolicLink()) {
        throw new TypeError(
          `Fixture bundle path is a symbolic link: path=${repositoryRelativePath}`,
        );
      }
      if (stats.isDirectory()) {
        visit(child, repositoryRelativePath);
      } else if (stats.isFile()) {
        files.set(repositoryRelativePath, {
          absolute: child,
          size: stats.size,
        });
      } else {
        throw new TypeError(
          `Fixture bundle path is not a regular file: path=${repositoryRelativePath}`,
        );
      }
      if (files.size > MAXIMUM_FILE_COUNT) {
        throw new RangeError(
          `Fixture file count limit exceeded: count=${files.size}`,
        );
      }
    }
  }
}

/**
 * @param {string} repositoryRoot
 * @param {Map<string, ExpectedFile>} expectedFiles
 * @param {string[]} bundleRoots
 */
function checkFiles(repositoryRoot, expectedFiles, bundleRoots) {
  /** @type {Map<string, { absolute: string, size: number }>} */
  const actualFiles = new Map();
  let totalBytes = 0;
  for (const path of expectedFiles.keys()) {
    const stats = lstatIfPresent(absolutePath(repositoryRoot, path));
    if (stats?.isSymbolicLink()) {
      throw new TypeError(
        `Fixture bundle path is a symbolic link: path=${path}`,
      );
    }
    if (stats !== null && !stats.isFile()) {
      throw new TypeError(
        `Fixture bundle path is not a regular file: path=${path}`,
      );
    }
  }
  for (const root of bundleRoots) {
    for (const [path, file] of collectBundleFiles(repositoryRoot, root)) {
      if (actualFiles.has(path)) {
        throw new TypeError(`Duplicate fixture file on disk: path=${path}`);
      }
      actualFiles.set(path, file);
      totalBytes += file.size;
    }
  }
  if (totalBytes > MAXIMUM_TOTAL_BYTES) {
    throw new RangeError(`Fixture byte limit exceeded: bytes=${totalBytes}`);
  }
  const missing = [...expectedFiles.keys()].filter(
    (path) => !actualFiles.has(path),
  );
  const extra = [...actualFiles.keys()].filter(
    (path) => !expectedFiles.has(path),
  );
  if (missing.length > 0 || extra.length > 0) {
    throw new TypeError(
      `Fixture file set mismatch: missingCount=${missing.length} extraCount=${extra.length} firstMissing=${missing[0] ?? "-"} firstExtra=${extra[0] ?? "-"}`,
    );
  }
  for (const [path, expected] of expectedFiles) {
    const actual = actualFiles.get(path);
    if (actual === undefined) {
      throw new TypeError(`Fixture file disappeared: path=${path}`);
    }
    const bytes = readFileSync(actual.absolute);
    if (!Buffer.from(expected.bytes).equals(bytes)) {
      throw new TypeError(
        `Fixture byte mismatch: path=${path} expectedSha256=${sha256Hex(expected.bytes)} actualSha256=${sha256Hex(bytes)}`,
      );
    }
  }
  return Object.freeze({ fileCount: actualFiles.size, totalBytes });
}

/**
 * @param {string} repositoryRoot
 * @param {string} relativeDirectory
 */
function ensureDirectory(repositoryRoot, relativeDirectory) {
  let current = repositoryRoot;
  for (const segment of assertRelativePath(relativeDirectory).split("/")) {
    current = join(current, segment);
    let stats = lstatIfPresent(current);
    if (stats === null) {
      mkdirSync(current);
      stats = lstatSync(current);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      const path = relative(repositoryRoot, current).split(sep).join("/");
      throw new TypeError(`Fixture parent is not a directory: path=${path}`);
    }
  }
}

/**
 * @param {string} repositoryRoot
 * @param {ExpectedFile} expected
 */
function writeFileAtomically(repositoryRoot, expected) {
  const target = absolutePath(repositoryRoot, expected.repositoryRelativePath);
  ensureDirectory(
    repositoryRoot,
    dirname(expected.repositoryRelativePath).split(sep).join("/"),
  );
  const existing = lstatIfPresent(target);
  if (existing !== null && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new TypeError(
      `Fixture target is not a regular file: path=${expected.repositoryRelativePath}`,
    );
  }
  const temporaryDirectory = mkdtempSync(
    join(dirname(target), ".initial-driver-fixture-"),
  );
  try {
    const temporaryFile = join(temporaryDirectory, "payload");
    writeFileSync(temporaryFile, expected.bytes, { flag: "wx", mode: 0o600 });
    renameSync(temporaryFile, target);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

/**
 * @param {"--check" | "--write"} mode
 * @param {string} [repositoryRoot]
 */
export function runInitialDriverFixtureBundlesV1(
  mode,
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
) {
  if (mode !== "--check" && mode !== "--write") {
    throw new TypeError("Mode must be exactly --check or --write.");
  }
  const root = resolve(repositoryRoot);
  assertRepositoryRoot(root);
  const expected = assembleExpectedFiles();
  if (mode === "--write") {
    for (const file of expected.files.values()) {
      writeFileAtomically(root, file);
    }
  }
  return checkFiles(root, expected.files, expected.bundleRoots);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === SCRIPT_PATH) {
  const arguments_ = process.argv.slice(2);
  if (
    arguments_.length !== 1 ||
    (arguments_[0] !== "--check" && arguments_[0] !== "--write")
  ) {
    throw new TypeError(
      "Usage: initial-driver-fixture-bundles.mjs [--check|--write]",
    );
  }
  runInitialDriverFixtureBundlesV1(arguments_[0]);
}
