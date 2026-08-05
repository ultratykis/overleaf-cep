/* eslint-disable @overleaf/require-script-runner */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

import { runDiffProbe } from "./oss-adoption-diff-probe.mjs";
import { runMcpProbe } from "./oss-adoption-mcp-probe.mjs";
import { allSettledOrThrow } from "./all-settled-or-throw.mjs";

const REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../../..",
);
const MODULE_ROOT = path.join(
  REPOSITORY_ROOT,
  "services/web/modules/ai-reviewer",
);
const PARSER_WORKER = path.join(
  MODULE_ROOT,
  "scripts/oss-adoption-parser-worker.mjs",
);
const MCP_PATCH = path.join(
  REPOSITORY_ROOT,
  ".yarn/patches/@ai-sdk-mcp-npm-1.0.37-8cd89b8972.patch",
);
const MAX_COMMAND_OUTPUT_BYTES = 2_000_000;
const MAX_TARBALL_BYTES = 16_000_000;

function parseArguments(argv) {
  const options = {
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
      continue;
    }
    if (argument === "--candidate-manifest" || argument === "--fixture-set") {
      const value = argv[index + 1];
      if (value == null) {
        throw new Error(`Missing value for ${argument}.`);
      }
      options[argument.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  if (options["candidate-manifest"] == null) {
    throw new Error("--candidate-manifest is required.");
  }
  if (options["fixture-set"] == null) {
    throw new Error("--fixture-set is required.");
  }
  return options;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function validateManifest({ manifest, fixtureSet }) {
  assert.equal(manifest.registry, "https://registry.npmjs.org/");
  assert.match(manifest.metadataObservation.observedAt, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(manifest.metadataObservation.source.length > 0);
  assert.equal(manifest.isolatedInstall.ignoreScripts, true);
  assert.equal(manifest.browser.image, "cypress/included:15.12.0");
  assert.match(manifest.browser.digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(manifest.browser.network, "none");

  const packageManifestPath = path.join(
    fixtureSet,
    manifest.isolatedInstall.packageManifest,
  );
  const lockfilePath = path.join(fixtureSet, manifest.isolatedInstall.lockfile);
  const packageManifest = readJson(packageManifestPath);
  const lockfile = readJson(lockfilePath);
  assert.equal(packageManifest.private, true);
  assert.deepEqual(
    lockfile.packages[""].dependencies,
    packageManifest.dependencies,
  );
  for (const version of Object.values(packageManifest.dependencies)) {
    assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  }

  const candidateNames = manifest.packages.map((candidate) => candidate.name);
  assert.equal(new Set(candidateNames).size, candidateNames.length);
  assert.deepEqual([...candidateNames].sort(), [
    "@ai-sdk/mcp",
    "@ai-sdk/openai",
    "@codemirror/merge",
    "@unified-latex/unified-latex",
    "ai",
    "latex-utensils",
  ]);
  for (const candidate of manifest.packages) {
    assert.equal(
      packageManifest.dependencies[candidate.name],
      candidate.version,
    );
    assert.match(candidate.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
    assert.equal(new URL(candidate.source).protocol, "https:");
    assert.ok(Number.isFinite(Date.parse(candidate.publishedAt)));
    assert.ok(candidate.maintenanceObservation.length > 0);
    assert.ok(candidate.distributionObligations.length > 0);
  }

  const diffFixture = readJson(path.join(fixtureSet, "diff-fixtures.json"));
  assert.equal(diffFixture.schemaVersion, 1);
  assert.deepEqual(
    diffFixture.cases.map((fixture) => fixture.id),
    manifest.diff.fixtures,
  );
  assert.equal(manifest.diff.requireSingleCodeMirrorRuntime, true);
  assert.equal(manifest.diff.allowEditorDispatch, false);

  const parserCorpus = readJson(path.join(fixtureSet, "parser/corpus.json"));
  assert.equal(parserCorpus.schemaVersion, 1);
  const observedFactKinds = new Set(
    parserCorpus.cases.flatMap((fixture) =>
      fixture.expected.map((fact) => fact.kind),
    ),
  );
  assert.deepEqual(
    [...observedFactKinds].sort(),
    [...manifest.parser.requiredFacts].sort(),
  );
  assert.equal(
    manifest.parser.maxSourceBytes,
    parserCorpus.boundary.acceptedBytes,
  );
  assert.equal(
    parserCorpus.boundary.rejectedBytes,
    manifest.parser.maxSourceBytes + 1,
  );
  assert.deepEqual(manifest.parser.suppressInside, [
    "comment",
    "verbatim",
    "lstlisting",
    "verb",
  ]);
  assert.deepEqual(manifest.mcp.cases, [
    "2025-06-18",
    "2025-11-25",
    "unsupported",
    "malformed",
  ]);
  assert.ok(manifest.mcp.ownerIfRetained.length > 0);
  assert.ok(manifest.mcp.removalCondition.length > 0);

  const allowedLicenses = manifest.licensePolicy.allowedSpdxExpressions;
  assert.equal(new Set(allowedLicenses).size, allowedLicenses.length);
  assert.ok(allowedLicenses.length > 0);
  assert.ok(manifest.licensePolicy.intendedDistribution.length > 0);
  const supportDependencies = Object.keys(packageManifest.dependencies)
    .filter((name) => !candidateNames.includes(name))
    .sort();
  assert.deepEqual(supportDependencies, [
    "@codemirror/language",
    "@codemirror/state",
    "@codemirror/view",
    "esbuild",
    "jsdom",
    "zod",
  ]);

  return {
    packageManifestPath,
    lockfilePath,
    packageManifestSha256: fileSha256(packageManifestPath),
    lockfileSha256: fileSha256(lockfilePath),
    exactDirectDependencies: packageManifest.dependencies,
    supportDependencies,
  };
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fileSha256(file) {
  return sha256(fs.readFileSync(file));
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const midpoint = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[midpoint - 1] + sorted[midpoint]) / 2
    : sorted[midpoint];
}

function summarizeNumbers(values) {
  return {
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function safeTemporaryDirectory(directory) {
  const resolved = path.resolve(directory);
  const expectedPrefix = path.join(
    path.resolve(os.tmpdir()),
    "overleaf-ai-reviewer-oss-",
  );
  if (!resolved.startsWith(expectedPrefix)) {
    throw new Error(`Refusing unsafe temporary path: ${resolved}`);
  }
  return resolved;
}

async function removeTemporaryDirectory(directory) {
  const safeDirectory = safeTemporaryDirectory(directory);
  await fs.promises.rm(safeDirectory, { recursive: true, force: true });
}

function assertPortableReportPaths(report, temporaryRoot) {
  const values = [];
  const pending = [report];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      values.push(value);
    } else if (Array.isArray(value)) {
      pending.push(...value);
    } else if (value !== null && typeof value === "object") {
      pending.push(...Object.values(value));
    }
  }

  const serialized = JSON.stringify(report);
  const forbiddenFragments = [
    path.basename(temporaryRoot),
    REPOSITORY_ROOT,
    os.homedir(),
    path.dirname(process.execPath),
  ];
  const violations = [];
  if (forbiddenFragments.some((fragment) => serialized.includes(fragment))) {
    violations.push("host-or-temporary-root");
  }
  if (
    values.some(
      (value) =>
        path.isAbsolute(value) ||
        /^[A-Za-z]:[\\/]/u.test(value) ||
        value === ".." ||
        value.startsWith("../") ||
        value.includes("/../"),
    )
  ) {
    violations.push("absolute-or-parent-relative-value");
  }
  assert.deepEqual(
    violations,
    [],
    `OSS report path boundary failed: ${violations.join(", ")}`,
  );
}

function runCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const start = performance.now();
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPOSITORY_ROOT,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let outputExceeded = false;
    let timedOut = false;

    const append = (current, chunk) => {
      const next = current + chunk;
      if (Buffer.byteLength(next, "utf8") > MAX_COMMAND_OUTPUT_BYTES) {
        outputExceeded = true;
        child.kill("SIGKILL");
        return current;
      }
      return next;
    };
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk.toString("utf8"));
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        signal: null,
        stdout,
        stderr,
        error: error.message,
        timedOut,
        outputExceeded,
        elapsedMs: performance.now() - start,
      });
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        stdout,
        stderr,
        error: null,
        timedOut,
        outputExceeded,
        elapsedMs: performance.now() - start,
      });
    });
  });
}

async function verifyTarball(candidate) {
  const url = new URL(candidate.tarball);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "registry.npmjs.org" ||
    !url.pathname.endsWith(".tgz")
  ) {
    throw new Error(`Unsafe fixed tarball URL for ${candidate.name}.`);
  }
  const start = performance.now();
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(
      `Tarball retrieval failed for ${candidate.name}: ${response.status}`,
    );
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_TARBALL_BYTES) {
    throw new Error(`Tarball is too large for ${candidate.name}.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_TARBALL_BYTES) {
    throw new Error(`Tarball is too large for ${candidate.name}.`);
  }
  if (candidate.packedBytes != null && bytes.length !== candidate.packedBytes) {
    throw new Error(`Packed size mismatch for ${candidate.name}.`);
  }
  const integrity = `sha512-${crypto
    .createHash("sha512")
    .update(bytes)
    .digest("base64")}`;
  if (integrity !== candidate.integrity) {
    throw new Error(`Tarball integrity mismatch for ${candidate.name}.`);
  }
  return {
    name: candidate.name,
    version: candidate.version,
    source: candidate.tarball,
    integrity,
    bytes: bytes.length,
    elapsedMs: performance.now() - start,
  };
}

async function verifyPublishedAt(candidate, registry, npmCache) {
  const command = await runCommand(
    "npm",
    [
      "view",
      `${candidate.name}@${candidate.version}`,
      "time",
      "--json",
      "--registry",
      registry,
      "--cache",
      npmCache,
    ],
    { timeoutMs: 30_000 },
  );
  if (command.exitCode !== 0 || command.timedOut || command.outputExceeded) {
    throw new Error(
      `Registry publication lookup failed for ${candidate.name}.`,
    );
  }
  const publicationTimes = JSON.parse(command.stdout);
  assert.equal(publicationTimes[candidate.version], candidate.publishedAt);
  return {
    source: `${registry}${candidate.name}`,
    publishedAt: publicationTimes[candidate.version],
    verified: true,
    elapsedMs: command.elapsedMs,
  };
}

function resolveLockDependency(lock, fromPath, dependencyName) {
  let current = fromPath;
  while (true) {
    const nested = current
      ? `${current}/node_modules/${dependencyName}`
      : `node_modules/${dependencyName}`;
    if (lock.packages[nested] != null) {
      return nested;
    }
    const marker = current.lastIndexOf("/node_modules/");
    if (marker < 0) {
      break;
    }
    current = current.slice(0, marker);
  }
  const topLevel = `node_modules/${dependencyName}`;
  return lock.packages[topLevel] == null ? null : topLevel;
}

function dependencyClosure(lock, packageName) {
  const rootPath = `node_modules/${packageName}`;
  if (lock.packages[rootPath] == null) {
    throw new Error(`Missing lock entry for ${packageName}.`);
  }
  const queue = [rootPath];
  const visited = new Set();
  while (queue.length > 0) {
    const current = queue.shift();
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    const entry = lock.packages[current];
    const dependencyNames = new Set([
      ...Object.keys(entry.dependencies ?? {}),
      ...Object.keys(entry.optionalDependencies ?? {}),
      ...Object.keys(entry.peerDependencies ?? {}),
    ]);
    for (const dependencyName of dependencyNames) {
      const resolved = resolveLockDependency(lock, current, dependencyName);
      if (resolved != null && !visited.has(resolved)) {
        queue.push(resolved);
      }
    }
  }
  return [...visited].sort();
}

function directorySize(directory) {
  let bytes = 0;
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(child);
      } else if (entry.isFile()) {
        bytes += fs.statSync(child).size;
      }
    }
  }
  return bytes;
}

function packageLicenseFiles(packageRoot) {
  return fs
    .readdirSync(packageRoot)
    .filter((name) => /^(?:licen[cs]e|notice|copying)(?:\.|$)/i.test(name))
    .sort();
}

function canonicalRepositorySource(repository) {
  const repositoryUrl =
    typeof repository === "string" ? repository : repository?.url;
  if (typeof repositoryUrl !== "string") {
    return null;
  }
  let source = repositoryUrl
    .replace(/^git\+/, "")
    .replace(/\.git$/, "")
    .replace(/\/$/, "");
  if (
    typeof repository === "object" &&
    typeof repository.directory === "string"
  ) {
    source = `${source}/tree/main/${repository.directory}`;
  }
  return source;
}

function productYarnResolutionVersions(lockSource) {
  const versions = new Map();
  let currentVersion = null;
  for (const line of lockSource.split("\n")) {
    if (/^\S/.test(line)) {
      currentVersion = null;
    }
    const versionMatch = line.match(/^ {2}version: (.+)$/);
    if (versionMatch != null) {
      currentVersion = versionMatch[1].replace(/^"|"$/g, "");
      continue;
    }
    const resolutionMatch = line.match(/^ {2}resolution: "(.+)"$/);
    if (resolutionMatch == null || currentVersion == null) {
      continue;
    }
    const resolution = resolutionMatch[1];
    const protocolMarkers = ["@npm:", "@patch:", "@workspace:"];
    const markerIndexes = protocolMarkers
      .map((marker) => resolution.indexOf(marker))
      .filter((index) => index > 0);
    if (markerIndexes.length === 0) {
      continue;
    }
    const name = resolution.slice(0, Math.min(...markerIndexes));
    const packageVersions = versions.get(name) ?? new Set();
    packageVersions.add(currentVersion);
    versions.set(name, packageVersions);
  }
  return versions;
}

function installedPackageObservation(installRoot, lockPath, productVersions) {
  const packageRoot = path.join(installRoot, lockPath);
  const packageJson = readJson(path.join(packageRoot, "package.json"));
  const resolvedProductVersions = [
    ...(productVersions.get(packageJson.name) ?? []),
  ].sort();
  return {
    name: packageJson.name,
    version: packageJson.version,
    license: packageJson.license ?? null,
    lockPath,
    licenseFiles: packageLicenseFiles(packageRoot),
    productVersions: resolvedProductVersions,
    productDelta:
      resolvedProductVersions.length === 0
        ? "absent"
        : resolvedProductVersions.includes(packageJson.version)
          ? "same"
          : "version-differs",
  };
}

function verifyInstalledCandidates({
  candidates,
  lock,
  installRoot,
  fixtureSet,
  licensePolicy,
}) {
  const productVersions = productYarnResolutionVersions(
    fs.readFileSync(path.join(REPOSITORY_ROOT, "yarn.lock"), "utf8"),
  );
  return candidates.map((candidate) => {
    const lockPath = `node_modules/${candidate.name}`;
    const lockEntry = lock.packages[lockPath];
    assert.ok(lockEntry, `Missing lock entry for ${candidate.name}.`);
    assert.equal(lockEntry.version, candidate.version);
    assert.equal(lockEntry.integrity, candidate.integrity);
    assert.equal(lockEntry.resolved, candidate.tarball);

    const packageRoot = path.join(
      installRoot,
      "node_modules",
      ...candidate.name.split("/"),
    );
    const packageJson = readJson(path.join(packageRoot, "package.json"));
    assert.equal(packageJson.version, candidate.version);
    assert.equal(packageJson.license, candidate.license);
    const installedSource = canonicalRepositorySource(packageJson.repository);
    assert.equal(installedSource, candidate.source);
    const installedBytes = directorySize(packageRoot);
    if (
      candidate.unpackedBytes != null &&
      installedBytes !== candidate.unpackedBytes
    ) {
      throw new Error(`Unpacked size mismatch for ${candidate.name}.`);
    }
    const closure = dependencyClosure(lock, candidate.name);
    const closurePackages = closure.map((lockPackagePath) =>
      installedPackageObservation(
        installRoot,
        lockPackagePath,
        productVersions,
      ),
    );
    const directObservation = closurePackages.find(
      (entry) => entry.lockPath === lockPath,
    );
    assert.ok(directObservation);
    const licenseInventory = Object.entries(
      closurePackages.reduce((inventory, entry) => {
        const license = entry.license ?? "UNRESOLVED";
        inventory[license] = (inventory[license] ?? 0) + 1;
        return inventory;
      }, {}),
    )
      .map(([license, count]) => ({ license, count }))
      .sort((left, right) => left.license.localeCompare(right.license));
    const unresolvedLicensePackages = closurePackages
      .filter((entry) => entry.license == null)
      .map((entry) => entry.name);
    const disallowedLicenseExpressions = licenseInventory
      .map((entry) => entry.license)
      .filter(
        (license) => !licensePolicy.allowedSpdxExpressions.includes(license),
      );
    const closureNoticeGaps = closurePackages
      .filter((entry) => entry.licenseFiles.length === 0)
      .map((entry) => `${entry.name}@${entry.version}`);
    const directLicenseFiles = packageLicenseFiles(packageRoot);
    const distributionCompatible =
      unresolvedLicensePackages.length === 0 &&
      disallowedLicenseExpressions.length === 0;
    return {
      id: candidate.id,
      name: candidate.name,
      version: candidate.version,
      integrity: candidate.integrity,
      license: candidate.license,
      source: candidate.source,
      publishedAt: candidate.publishedAt,
      maintenanceObservation: candidate.maintenanceObservation,
      distributionObligations: candidate.distributionObligations,
      installedBytes,
      installedRepository: packageJson.repository ?? null,
      sourceVerifiedAgainstInstalledPackage: true,
      closurePackageCount: closure.length,
      transitiveDependencyCount: Math.max(0, closure.length - 1),
      closurePackages,
      dependencyDelta: closurePackages.filter(
        (entry) => entry.productDelta !== "same",
      ),
      alreadyPresentInProductGraph: directObservation.productVersions.includes(
        candidate.version,
      ),
      productResolvedVersions: directObservation.productVersions,
      licenseInventory,
      unresolvedLicensePackages,
      disallowedLicenseExpressions,
      selectedLicenseAlternatives: licensePolicy.selectedAlternatives,
      distributionCompatible,
      distributionRationale: distributionCompatible
        ? licensePolicy.intendedDistribution
        : "One or more closure licenses are unresolved or outside the fixed policy.",
      redistributionNoticeReady: closureNoticeGaps.length === 0,
      closureNoticeGaps,
      licenseFiles: directLicenseFiles,
      noticeGap:
        candidate.name === "@unified-latex/unified-latex" &&
        directLicenseFiles.length === 0,
      fixtureSet: path.relative(REPOSITORY_ROOT, fixtureSet),
    };
  });
}

async function createIsolatedInstall({ fixtureSet, manifest, candidates }) {
  const temporaryRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "overleaf-ai-reviewer-oss-"),
  );
  try {
    const packageManifest = path.join(
      fixtureSet,
      manifest.isolatedInstall.packageManifest,
    );
    const lockfile = path.join(fixtureSet, manifest.isolatedInstall.lockfile);
    await fs.promises.copyFile(
      packageManifest,
      path.join(temporaryRoot, "package.json"),
    );
    await fs.promises.copyFile(
      lockfile,
      path.join(temporaryRoot, "package-lock.json"),
    );

    const npmCache = path.join(temporaryRoot, "npm-cache");
    const tarballs = [];
    for (const candidate of candidates) {
      const [tarball, publication] = await allSettledOrThrow([
        verifyTarball(candidate),
        verifyPublishedAt(candidate, manifest.registry, npmCache),
      ]);
      tarballs.push({ ...tarball, publication });
    }

    const install = await runCommand(
      "npm",
      [
        "ci",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--cache",
        npmCache,
      ],
      {
        cwd: temporaryRoot,
        timeoutMs: 120_000,
      },
    );
    if (install.exitCode !== 0 || install.timedOut || install.outputExceeded) {
      throw new Error(
        `Isolated npm ci failed (${install.exitCode ?? install.signal}).`,
      );
    }

    const lock = readJson(path.join(temporaryRoot, "package-lock.json"));
    return {
      temporaryRoot,
      lock,
      lockSha256: fileSha256(path.join(temporaryRoot, "package-lock.json")),
      tarballs,
      install: {
        command:
          "npm ci --ignore-scripts --no-audit --no-fund --cache <temporary>",
        exitCode: install.exitCode,
        elapsedMs: install.elapsedMs,
        installedPackageCount: Object.keys(lock.packages).length - 1,
        lifecycleScriptsEnabled: false,
      },
    };
  } catch (error) {
    await removeTemporaryDirectory(temporaryRoot);
    throw error;
  }
}

function aiProviderUsage(inputTokens = 3, outputTokens = 2) {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: inputTokens,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: outputTokens,
      text: outputTokens,
      reasoning: undefined,
    },
  };
}

async function runAiSdkProbe(expectedVersion) {
  const beforeRss = process.memoryUsage().rss;
  const importStart = performance.now();
  const [{ AiSdkAgentGateway }, ai, aiTest] = await Promise.all([
    import(
      pathToFileURL(path.join(MODULE_ROOT, "app/src/AiSdkAgentGateway.mjs"))
        .href
    ),
    import("ai"),
    import("ai/test"),
  ]);
  const importMs = performance.now() - importStart;
  const importRssDeltaBytes = process.memoryUsage().rss - beforeRss;

  const finish = (reason, usage = aiProviderUsage()) => ({
    type: "finish",
    finishReason: { unified: reason, raw: reason },
    usage,
  });
  const streamResult = (chunks) => ({
    stream: ai.simulateReadableStream({
      chunks,
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  });
  const steps = [
    streamResult([
      {
        type: "tool-call",
        toolCallId: "fixture-tool-call",
        toolName: "read_project_file",
        input: JSON.stringify({
          path: "main.tex",
          range: { from: 0, to: 4 },
        }),
      },
      finish("tool-calls"),
    ]),
    streamResult([
      { type: "text-start", id: "fixture-text" },
      {
        type: "text-delta",
        id: "fixture-text",
        delta: JSON.stringify({
          narrative: "Synthetic SDK result.",
          findings: [],
          suggestions: [],
        }),
      },
      { type: "text-end", id: "fixture-text" },
      finish("stop"),
    ]),
  ];
  let stepIndex = 0;
  const model = new aiTest.MockLanguageModelV3({
    provider: "fixture",
    modelId: "fixture-model",
    doStream: async () => {
      if (stepIndex >= steps.length) {
        throw new Error("Unexpected extra model step.");
      }
      const step = steps[stepIndex];
      stepIndex += 1;
      return step;
    },
  });
  const allowedReads = new Set(["main.tex:0:4"]);
  const toolCalls = [];
  let nextId = 0;
  const gateway = new AiSdkAgentGateway({
    model,
    provider: "fixture-provider",
    modelId: "fixture-model",
    contextLength: 8_192,
    readProjectFile: async (input) => {
      const key = `${input.path}:${input.range?.from}:${input.range?.to}`;
      if (!allowedReads.has(key)) {
        throw new Error("Read outside immutable fixture allowlist.");
      }
      toolCalls.push(input);
      return { path: input.path, text: "Text" };
    },
    now: () => "2026-07-24T00:00:00.000Z",
    createId: (kind) => `${kind}-${(nextId += 1)}`,
  });
  const request = {
    requestId: "fixture-request",
    projectId: "fixture-project",
    action: "review",
    instruction: "Review the synthetic fixture.",
    skill: "referee-review",
    scope: { kind: "project" },
  };
  const controller = new AbortController();
  const events = [];
  for await (const event of gateway.stream(request, {
    signal: controller.signal,
  })) {
    events.push(event);
  }
  const eventTypes = events.map((event) => event.type);
  const expectedEventTypes = [
    "started",
    "tool.call",
    "text.delta",
    "completed",
  ];
  assert.deepEqual(eventTypes, expectedEventTypes);
  assert.equal(toolCalls.length, 1);
  assert.equal(model.doStreamCalls.length, 2);
  assert.equal(model.doStreamCalls[0].abortSignal, controller.signal);
  assert.equal(model.doStreamCalls[1].abortSignal, controller.signal);
  assert.equal(stepIndex, 2);

  const productionFiles = [];
  const pending = [
    path.join(MODULE_ROOT, "app/src"),
    path.join(MODULE_ROOT, "frontend/js"),
  ];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const child = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(child);
      } else if (/\.(?:mjs|js|ts|tsx)$/.test(entry.name)) {
        productionFiles.push(child);
      }
    }
  }
  const sdkImports = [];
  const mcpImports = [];
  for (const file of productionFiles) {
    const source = fs.readFileSync(file, "utf8");
    if (
      /from\s+["'](?:ai|@ai-sdk\/[^"']+)["']|import\(["'](?:ai|@ai-sdk\/)/.test(
        source,
      )
    ) {
      sdkImports.push(path.relative(REPOSITORY_ROOT, file));
    }
    if (source.includes("@ai-sdk/mcp")) {
      mcpImports.push(path.relative(REPOSITORY_ROOT, file));
    }
  }
  assert.deepEqual(sdkImports, [
    "services/web/modules/ai-reviewer/app/src/AiSdkAgentGateway.mjs",
  ]);
  assert.deepEqual(mcpImports, []);

  const resolvedVersion = readJson(
    path.join(REPOSITORY_ROOT, "node_modules/ai/package.json"),
  ).version;
  assert.equal(resolvedVersion, expectedVersion);

  return {
    pass: true,
    resolvedVersion,
    importMs,
    importRssDeltaBytes,
    eventTypes,
    toolCallCount: toolCalls.length,
    structuredOutputMapped: events.some(
      (event) =>
        event.type === "text.delta" && event.delta === "Synthetic SDK result.",
    ),
    abortSignalPropagated: model.doStreamCalls.every(
      (call) => call.abortSignal === controller.signal,
    ),
    strictModelStepCount: stepIndex,
    sdkImports,
    productionMcpImports: mcpImports,
    localBoundaryRetained: true,
  };
}

function buildExpectedFacts(source, expected) {
  return expected.map((fact) => {
    const from = source.indexOf(fact.slice);
    if (from < 0 || source.indexOf(fact.slice, from + 1) >= 0) {
      throw new Error(`Expected slice must occur exactly once: ${fact.slice}`);
    }
    return {
      kind: fact.kind,
      macro: fact.macro,
      values: fact.values,
      from,
      to: from + fact.slice.length,
    };
  });
}

function sourceWithExactByteLength(seed, targetBytes) {
  const seedBytes = Buffer.byteLength(seed, "utf8");
  if (seedBytes > targetBytes) {
    throw new Error("Boundary seed is larger than the target.");
  }
  const remaining = targetBytes - seedBytes;
  const multibyteCount = Math.floor(remaining / 3);
  const asciiCount = remaining % 3;
  const source = `${seed}${"界".repeat(multibyteCount)}${"x".repeat(
    asciiCount,
  )}`;
  assert.equal(Buffer.byteLength(source, "utf8"), targetBytes);
  return source;
}

async function runParserWorker({
  candidate,
  installRoot,
  sourceFile,
  maxBytes,
  watchdogMs,
}) {
  const command = await runCommand(
    process.execPath,
    [
      PARSER_WORKER,
      "--candidate",
      candidate,
      "--install-root",
      installRoot,
      "--source",
      sourceFile,
      "--max-bytes",
      String(maxBytes),
    ],
    {
      timeoutMs: watchdogMs,
    },
  );
  if (command.exitCode !== 0 || command.timedOut || command.outputExceeded) {
    return {
      watchdogTrip: command.timedOut,
      workerFailure: true,
      exitCode: command.exitCode,
      signal: command.signal,
      outputExceeded: command.outputExceeded,
      elapsedMs: command.elapsedMs,
    };
  }
  return {
    watchdogTrip: false,
    workerFailure: false,
    elapsedMs: command.elapsedMs,
    output: JSON.parse(command.stdout),
  };
}

function sameFacts(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

async function runParserComparison({
  fixtureSet,
  installRoot,
  parserConfig,
  temporaryRoot,
}) {
  const parserRoot = path.join(fixtureSet, "parser");
  const corpus = readJson(path.join(parserRoot, "corpus.json"));
  const cases = corpus.cases.map((entry) => {
    const sourceFile = path.join(parserRoot, entry.file);
    const source = fs.readFileSync(sourceFile, "utf8");
    return {
      id: entry.id,
      sourceFile,
      source,
      expectedFacts: buildExpectedFacts(source, entry.expected),
      oversize: false,
    };
  });
  const seed = fs.readFileSync(
    path.join(parserRoot, corpus.boundary.seedFile),
    "utf8",
  );
  const seedExpected = cases.find(
    (entry) => entry.id === "graph",
  ).expectedFacts;
  const acceptedSource = sourceWithExactByteLength(
    seed,
    corpus.boundary.acceptedBytes,
  );
  const rejectedSource = sourceWithExactByteLength(
    seed,
    corpus.boundary.rejectedBytes,
  );
  const acceptedFile = path.join(temporaryRoot, "boundary-accepted.tex");
  const rejectedFile = path.join(temporaryRoot, "boundary-rejected.tex");
  await fs.promises.writeFile(acceptedFile, acceptedSource);
  await fs.promises.writeFile(rejectedFile, rejectedSource);
  cases.push({
    id: "boundary-accepted",
    sourceFile: acceptedFile,
    source: acceptedSource,
    expectedFacts: seedExpected,
    oversize: false,
  });
  cases.push({
    id: "boundary-rejected",
    sourceFile: rejectedFile,
    source: rejectedSource,
    expectedFacts: [],
    oversize: true,
  });

  const candidates = ["unified-latex", "latex-utensils"];
  const candidateReports = [];
  for (const candidate of candidates) {
    const caseReports = [];
    for (const fixture of cases) {
      const attempts = [];
      for (
        let repetition = 0;
        repetition < parserConfig.repetitions;
        repetition += 1
      ) {
        attempts.push(
          await runParserWorker({
            candidate,
            installRoot,
            sourceFile: fixture.sourceFile,
            maxBytes: parserConfig.maxSourceBytes,
            watchdogMs: parserConfig.watchdogMsPerCase,
          }),
        );
      }
      const completed = attempts.filter((attempt) => !attempt.workerFailure);
      const outputs = completed.map((attempt) => attempt.output);
      const expectedOversizePass = outputs.every(
        (output) =>
          output.parserInvoked === false &&
          output.errorCode === "SOURCE_TOO_LARGE" &&
          output.sourceBytes === corpus.boundary.rejectedBytes,
      );
      const correctnessPass = fixture.oversize
        ? expectedOversizePass
        : outputs.every(
            (output) =>
              output.parserInvoked &&
              sameFacts(output.facts, fixture.expectedFacts) &&
              output.facts.every(
                (fact, index) =>
                  fixture.source.slice(fact.from, fact.to) ===
                  fixture.source.slice(
                    fixture.expectedFacts[index].from,
                    fixture.expectedFacts[index].to,
                  ),
              ),
          );
      const fallbackPolicyPass = fixture.oversize
        ? true
        : fixture.id === "malformed"
          ? outputs.every(
              (output) =>
                (output.fallbackUsed === false &&
                  output.parseFailure == null) ||
                (output.fallbackUsed === true &&
                  output.parseFailure?.hasLocation === true),
            )
          : outputs.every(
              (output) =>
                output.fallbackUsed === false && output.parseFailure == null,
            );
      const fullPass =
        attempts.length === parserConfig.repetitions &&
        completed.length === parserConfig.repetitions &&
        correctnessPass &&
        fallbackPolicyPass;
      caseReports.push({
        id: fixture.id,
        sourceBytes: Buffer.byteLength(fixture.source, "utf8"),
        repetitions: parserConfig.repetitions,
        watchdogTrips: attempts.filter((attempt) => attempt.watchdogTrip)
          .length,
        attemptFailures: attempts
          .filter((attempt) => attempt.workerFailure)
          .map((attempt) => ({
            watchdogTrip: attempt.watchdogTrip,
            exitCode: attempt.exitCode,
            signal: attempt.signal,
            outputExceeded: attempt.outputExceeded,
          })),
        pass: fullPass,
        adaptedFactsExact: correctnessPass,
        fallbackPolicyPass,
        fallbackUsed: outputs.some((output) => output.fallbackUsed),
        native: outputs[0]?.native ?? null,
        parseFailure: outputs[0]?.parseFailure ?? null,
        wallMs:
          completed.length > 0
            ? summarizeNumbers(completed.map((attempt) => attempt.elapsedMs))
            : null,
        parseMs:
          outputs.length > 0
            ? summarizeNumbers(outputs.map((output) => output.timingsMs.parse))
            : null,
        peakHeapBytes:
          outputs.length > 0
            ? summarizeNumbers(
                outputs.map((output) => output.observedPeakHeapBytes),
              )
            : null,
      });
    }
    const adaptedCorrectness = caseReports.every((entry) => entry.pass);
    const decision =
      candidate === "latex-utensils" && adaptedCorrectness ? "adopt" : "reject";
    const nativeLimitations =
      candidate === "unified-latex"
        ? [
            "macro positions omit attached argument ranges",
            "five required graph macros need a local signature or detached-group recovery",
            "malformed groups require a local balanced-delimiter check",
          ]
        : [
            "full invocation ranges are reconstructed by the bounded local adapter from parser-recognized start offsets",
            "unclosed groups raise a located SyntaxError and require the bounded exact-scanner fallback",
          ];
    candidateReports.push({
      candidate,
      pass: adaptedCorrectness,
      adaptedCorrectness,
      nativeRangeCompleteness: caseReports.every(
        (entry) =>
          entry.pass &&
          (entry.id === "malformed" ||
            entry.id === "boundary-rejected" ||
            (!entry.fallbackUsed &&
              entry.native?.fullInvocationRangesProvided === true)),
      ),
      nativeLimitations,
      cases: caseReports,
      decision,
      decisionPhase: decision === "adopt" ? 4 : null,
      decisionReason:
        decision === "adopt"
          ? "Parser-recognized start offsets and opaque-region handling pass; the bounded local adapter reconstructs exact ranges and handles located syntax failures."
          : "The umbrella parser needs argument/range reconstruction before correctness and carries a much larger parser-only closure.",
    });
  }
  return {
    pass: candidateReports.some((candidate) => candidate.pass),
    boundedExactScannerFallbackRetained: true,
    runtime: {
      node: process.version,
      executable: path.basename(process.execPath),
      platform: process.platform,
      architecture: process.arch,
      isolatedProcessPerCase: true,
    },
    repetitions: parserConfig.repetitions,
    watchdogMsPerCase: parserConfig.watchdogMsPerCase,
    maxSourceBytes: parserConfig.maxSourceBytes,
    candidates: candidateReports,
  };
}

async function runBrowserContainerProbe(browserOutputDir, browserConfig) {
  const inspect = await runCommand(
    "docker",
    [
      "image",
      "inspect",
      browserConfig.image,
      "--format",
      "{{json .RepoDigests}}",
    ],
    { timeoutMs: 30_000 },
  );
  if (inspect.exitCode !== 0) {
    return {
      pass: false,
      image: browserConfig.image,
      failure: "fixed Cypress image is not installed",
      imageInspectExitCode: inspect.exitCode,
    };
  }
  let repoDigests = [];
  try {
    repoDigests = JSON.parse(inspect.stdout.trim());
  } catch {
    repoDigests = [];
  }
  const digestMatches = repoDigests.some((digest) =>
    digest.endsWith(`@${browserConfig.digest}`),
  );
  if (!digestMatches) {
    return {
      pass: false,
      image: browserConfig.image,
      expectedDigest: browserConfig.digest,
      repoDigests,
      failure: "fixed Cypress image digest mismatch",
    };
  }
  const tagSeparator = browserConfig.image.lastIndexOf(":");
  const slashSeparator = browserConfig.image.lastIndexOf("/");
  const imageRepository =
    tagSeparator > slashSeparator
      ? browserConfig.image.slice(0, tagSeparator)
      : browserConfig.image;
  const immutableImage = `${imageRepository}@${browserConfig.digest}`;
  const cidFile = path.join(browserOutputDir, "cypress.cid");
  let run;
  let cleanup = {
    cidRecorded: false,
    removedAfterTimeoutOrFailure: false,
    absentAfterRun: false,
  };
  try {
    run = await runCommand(
      "docker",
      [
        "run",
        "--rm",
        "--cidfile",
        cidFile,
        "--network",
        browserConfig.network,
        "--volume",
        `${browserOutputDir}:/e2e`,
        "--workdir",
        "/e2e",
        "--entrypoint",
        "cypress",
        immutableImage,
        "run",
        "--config-file",
        "cypress.config.cjs",
        "--spec",
        "cypress/e2e/detached-diff.cy.js",
        "--browser",
        "electron",
      ],
      { timeoutMs: 180_000 },
    );
  } finally {
    if (fs.existsSync(cidFile)) {
      const containerId = fs.readFileSync(cidFile, "utf8").trim();
      cleanup.cidRecorded = containerId.length > 0;
      if (containerId.length > 0) {
        const beforeCleanup = await runCommand(
          "docker",
          ["container", "inspect", containerId],
          { timeoutMs: 30_000 },
        );
        if (beforeCleanup.exitCode === 0) {
          const removal = await runCommand(
            "docker",
            ["container", "rm", "--force", containerId],
            { timeoutMs: 30_000 },
          );
          cleanup.removedAfterTimeoutOrFailure = removal.exitCode === 0;
        }
        const afterCleanup = await runCommand(
          "docker",
          ["container", "inspect", containerId],
          { timeoutMs: 30_000 },
        );
        cleanup.absentAfterRun = afterCleanup.exitCode !== 0;
      }
    }
  }
  assert.ok(run);
  const browserPassed =
    run.exitCode === 0 &&
    !run.timedOut &&
    !run.outputExceeded &&
    cleanup.absentAfterRun;
  const failureOutput = `${run.stderr}\n${run.stdout}`
    .replaceAll("\u001B", "")
    .split("\n")
    .filter(Boolean)
    .slice(-120)
    .join(" | ");
  return {
    pass: browserPassed,
    image: browserConfig.image,
    immutableImage,
    expectedDigest: browserConfig.digest,
    repoDigests,
    network: browserConfig.network,
    exitCode: run.exitCode,
    elapsedMs: run.elapsedMs,
    timedOut: run.timedOut,
    outputExceeded: run.outputExceeded,
    failure: browserPassed
      ? null
      : failureOutput ||
        (cleanup.absentAfterRun
          ? "Cypress failed without bounded output."
          : "Cypress container cleanup failed."),
    cleanup,
  };
}

function decisionRecords({
  packageReports,
  aiSdk,
  parser,
  diff,
  mcp,
  manifest,
}) {
  const byName = new Map(packageReports.map((report) => [report.name, report]));
  const adoptionAllowed = (report) =>
    report.distributionCompatible && report.licenseFiles.length > 0;
  const licenseDecisionFields = (report) => ({
    distributionCompatible: report.distributionCompatible,
    redistributionNoticeReady: report.redistributionNoticeReady,
    directLicenseFiles: report.licenseFiles,
  });
  const aiReport = byName.get("ai");
  const openAiReport = byName.get("@ai-sdk/openai");
  const mergeReport = byName.get("@codemirror/merge");
  const mcpReport = byName.get("@ai-sdk/mcp");
  return [
    {
      candidate: "ai",
      version: aiReport.version,
      decision: adoptionAllowed(aiReport) ? "adopt" : "reject",
      phase: adoptionAllowed(aiReport) ? 1 : null,
      boundary:
        "Only AiSdkAgentGateway imports the SDK; SDK types, arbitrary tools, hosted gateway model IDs, telemetry, and raw errors do not cross the local contract.",
      cost: {
        importMs: aiSdk.importMs,
        importRssDeltaBytes: aiSdk.importRssDeltaBytes,
      },
      failures: [],
      ...licenseDecisionFields(aiReport),
    },
    {
      candidate: "@ai-sdk/openai",
      version: openAiReport.version,
      decision: "defer",
      phase: 3,
      boundary:
        "The already-resolved provider SDK is not instantiated in Phase 1; Phase 3 must use createOpenAI(...).chat(model) with the local Ollama allowlist.",
      cost: {
        status: "deferred",
        reason:
          "Provider instantiation and Ollama process cost belong to EVAL-OLLAMA-01 in Phase 3.",
      },
      failures: ["runtime compatibility and cost intentionally deferred"],
      ...licenseDecisionFields(openAiReport),
    },
    {
      candidate: "@codemirror/merge",
      version: mergeReport.version,
      decision: diff.pass && adoptionAllowed(mergeReport) ? "adopt" : "reject",
      phase: diff.pass && adoptionAllowed(mergeReport) ? 2 : null,
      boundary:
        "Detached side-by-side read-only wrapper only; no unified merge controls, Editor dispatch, or realtime/OT mutation.",
      cost: diff.bundle.delta,
      failures: diff.failures,
      ...licenseDecisionFields(mergeReport),
    },
    ...parser.candidates.map((candidate) => {
      const packageName =
        candidate.candidate === "unified-latex"
          ? "@unified-latex/unified-latex"
          : "latex-utensils";
      const report = byName.get(packageName);
      const decision =
        candidate.decision === "adopt" && adoptionAllowed(report)
          ? "adopt"
          : "reject";
      const caseFailures = candidate.cases
        .filter((entry) => !entry.pass)
        .map((entry) => entry.id);
      const decisionFailures =
        decision === "reject"
          ? [
              ...caseFailures,
              ...candidate.nativeLimitations,
              ...(report.licenseFiles.length === 0
                ? ["direct license file absent from the packed candidate"]
                : []),
            ]
          : caseFailures;
      return {
        candidate: packageName,
        version: report.version,
        decision,
        phase: decision === "adopt" ? candidate.decisionPhase : null,
        decisionReason: candidate.decisionReason,
        boundary:
          candidate.candidate === "latex-utensils"
            ? "Phase 4 parser adapter with a 100 KiB pre-import bound and bounded exact-scanner fallback on located syntax failure."
            : "Retain the bounded exact-scanner fallback; a future revision may compare the smaller util-parse package directly.",
        cost: {
          wallMs: candidate.cases.map((entry) => ({
            fixture: entry.id,
            ...entry.wallMs,
          })),
          peakHeapBytes: candidate.cases.map((entry) => ({
            fixture: entry.id,
            ...entry.peakHeapBytes,
          })),
        },
        failures: decisionFailures,
        limitations: candidate.nativeLimitations,
        ...licenseDecisionFields(report),
      };
    }),
    {
      candidate: "@ai-sdk/mcp",
      version: mcpReport.version,
      decision: "defer",
      phase: 6,
      boundary:
        "No production import before sidecar isolation; the inherited ESM-only protocol patch is not adopted as the AI reviewer long-term patch.",
      compatibilityNeedDemonstrated: mcp.compatibilityNeedDemonstrated,
      patchOwner: manifest.mcp.ownerIfRetained,
      patchRemovalCondition: manifest.mcp.removalCondition,
      cost: mcp.processCost,
      failures: mcp.candidateFailures,
      ...licenseDecisionFields(mcpReport),
    },
  ];
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const candidateManifestPath = path.resolve(
    REPOSITORY_ROOT,
    options["candidate-manifest"],
  );
  const fixtureSet = path.resolve(REPOSITORY_ROOT, options["fixture-set"]);
  if (!fixtureSet.startsWith(`${REPOSITORY_ROOT}${path.sep}`)) {
    throw new Error("Fixture set must be inside the repository.");
  }
  if (!candidateManifestPath.startsWith(`${fixtureSet}${path.sep}`)) {
    throw new Error("Candidate manifest must be inside the fixture set.");
  }
  const manifest = readJson(candidateManifestPath);
  if (manifest.schemaVersion !== 1) {
    throw new Error("Unsupported candidate manifest schema.");
  }
  const manifestControls = validateManifest({ manifest, fixtureSet });
  if (
    manifest.parser.repetitions !== 3 ||
    manifest.parser.watchdogMsPerCase !== 30_000
  ) {
    throw new Error("Parser repetitions or watchdog changed unexpectedly.");
  }
  if (
    manifest.runtime.node !== process.version.slice(1) ||
    manifest.runtime.platform !== process.platform ||
    manifest.runtime.architecture !== process.arch
  ) {
    throw new Error("The declared OSS evaluation runtime does not match.");
  }

  const start = new Date();
  const isolated = await createIsolatedInstall({
    fixtureSet,
    manifest,
    candidates: manifest.packages,
  });
  let result;
  try {
    const packageReports = verifyInstalledCandidates({
      candidates: manifest.packages,
      lock: isolated.lock,
      installRoot: isolated.temporaryRoot,
      fixtureSet,
      licensePolicy: manifest.licensePolicy,
    });
    const browserOutputDir = path.join(isolated.temporaryRoot, "browser-probe");
    await fs.promises.mkdir(browserOutputDir);

    const aiSdkCandidate = manifest.packages.find(
      (candidate) => candidate.name === "ai",
    );
    assert.ok(aiSdkCandidate);
    const aiSdk = await runAiSdkProbe(aiSdkCandidate.version);
    const parser = await runParserComparison({
      fixtureSet,
      installRoot: isolated.temporaryRoot,
      parserConfig: manifest.parser,
      temporaryRoot: isolated.temporaryRoot,
    });
    const diff = await runDiffProbe({
      installRoot: isolated.temporaryRoot,
      fixtureFile: path.join(fixtureSet, "diff-fixtures.json"),
      browserOutputDir,
    });
    const browser = await runBrowserContainerProbe(
      browserOutputDir,
      manifest.browser,
    );
    diff.realBrowser = browser;
    diff.pass = diff.pass && browser.pass;

    const mcpRssBefore = process.memoryUsage().rss;
    const mcpStart = performance.now();
    const mcp = await runMcpProbe({
      patchedPackageRoot: path.join(
        REPOSITORY_ROOT,
        "node_modules/@ai-sdk/mcp",
      ),
      unpatchedPackageRoot: path.join(
        isolated.temporaryRoot,
        "node_modules/@ai-sdk/mcp",
      ),
      patchFile: MCP_PATCH,
    });
    mcp.processCost = {
      elapsedMs: performance.now() - mcpStart,
      rssDeltaBytes: process.memoryUsage().rss - mcpRssBefore,
    };

    const failures = [];
    if (!aiSdk.pass) failures.push("ai-sdk");
    if (!parser.pass) failures.push("parser");
    if (!diff.pass) failures.push("diff");
    if (!mcp.evaluationPass) failures.push("mcp");
    const decisions = decisionRecords({
      packageReports,
      aiSdk,
      parser,
      diff,
      mcp,
      manifest,
    });
    result = {
      schemaVersion: 1,
      evaluation: "EVAL-OSS-01",
      evaluationRevision: 1,
      result: failures.length === 0 ? "pass" : "fail",
      failures,
      startedAt: start.toISOString(),
      endedAt: new Date().toISOString(),
      runtime: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        targetHardware: manifest.runtime.targetHardware,
      },
      fixtureSet: path.relative(REPOSITORY_ROOT, fixtureSet),
      candidateManifest: path.relative(REPOSITORY_ROOT, candidateManifestPath),
      candidateManifestSha256: fileSha256(candidateManifestPath),
      metadataObservation: manifest.metadataObservation,
      manifestControls: {
        packageManifest: path.relative(
          REPOSITORY_ROOT,
          manifestControls.packageManifestPath,
        ),
        packageManifestSha256: manifestControls.packageManifestSha256,
        lockfile: path.relative(REPOSITORY_ROOT, manifestControls.lockfilePath),
        lockfileSha256: manifestControls.lockfileSha256,
        exactDirectDependencies: manifestControls.exactDirectDependencies,
        supportDependencies: manifestControls.supportDependencies,
      },
      productDependencyGraph: {
        lockfile: "yarn.lock",
        lockfileSha256: fileSha256(path.join(REPOSITORY_ROOT, "yarn.lock")),
        comparison: "all Yarn lock resolution name/version pairs",
      },
      isolatedInstall: {
        ...isolated.install,
        lockfile: path.relative(
          REPOSITORY_ROOT,
          path.join(fixtureSet, manifest.isolatedInstall.lockfile),
        ),
        lockfileSha256: isolated.lockSha256,
        temporaryInstallRemovedAfterRun: true,
      },
      retrieval: isolated.tarballs,
      packages: packageReports,
      aiSdk,
      diff,
      parser,
      mcp,
      decisions,
      prohibitedActivity: {
        liveManuscript: false,
        credentials: false,
        modelPull: false,
        mcpSubprocess: false,
        productExternalService: false,
        productDocumentMutation: false,
      },
    };
    assertPortableReportPaths(result, isolated.temporaryRoot);
    result.artifactPathBoundary = {
      hostAbsolutePaths: false,
      temporaryPaths: false,
      parentRelativePaths: false,
    };
    const stableResult = structuredClone(result);
    delete stableResult.startedAt;
    delete stableResult.endedAt;
    result.resultSha256 = sha256(JSON.stringify(stableResult));
  } finally {
    await removeTemporaryDirectory(isolated.temporaryRoot);
  }
  assert.ok(result);
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `EVAL-OSS-01 ${result.result}: ${result.failures.length} failure(s)\n`,
    );
  }
  if (result.result !== "pass") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const safeError = {
    evaluation: "EVAL-OSS-01",
    result: "fail",
    error: error instanceof Error ? error.message : "Unknown error",
  };
  process.stderr.write(`${JSON.stringify(safeError)}\n`);
  process.exitCode = 1;
});
