/* eslint-disable @overleaf/require-script-runner */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PROTOCOL_CASES = [
  {
    id: "2025-06-18",
    responseVersion: "2025-06-18",
  },
  {
    id: "2025-11-25",
    responseVersion: "2025-11-25",
  },
  {
    id: "unsupported",
    responseVersion: "2099-01-01",
  },
  {
    id: "malformed",
    responseVersion: 20250618,
  },
];

const PACKAGE_VARIANTS = ["patched", "unpatched"];
const LOADERS = ["import", "require"];
const STRICT_PROTOCOL_VERSION = "2025-06-18";
const LIFECYCLE_OBSERVATION_MS = 25;
const LIFECYCLE_SETTLE_MS = 100;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value != null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function serializeError(error) {
  if (error == null) {
    return null;
  }
  const name =
    typeof error === "object" && typeof error.name === "string"
      ? error.name
      : "Error";
  const message =
    typeof error === "object" && typeof error.message === "string"
      ? error.message
      : String(error);
  return {
    name,
    message: message.slice(0, 1000),
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeHeaders(headers) {
  const normalized = {};
  for (const [name, value] of new Headers(headers).entries()) {
    normalized[name.toLowerCase()] = value;
  }
  return normalized;
}

function makeInitializeResult(protocolVersion) {
  return {
    protocolVersion,
    serverInfo: {
      name: "overleaf-ai-reviewer-mcp-probe",
      version: "1.0.0",
    },
    capabilities: {
      tools: {},
    },
  };
}

function makeToolList() {
  return {
    tools: [
      {
        name: "read_fixture",
        description: "Returns a bounded synthetic fixture.",
        inputSchema: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ],
  };
}

class ProbeTransport {
  constructor({ initializeVersion, hangListTools = false }) {
    this.initializeVersion = initializeVersion;
    this.hangListTools = hangListTools;
    this.started = false;
    this.closed = false;
    this.closeCalls = 0;
    this.messages = [];
    this.onclose = undefined;
    this.onerror = undefined;
    this.onmessage = undefined;
  }

  async start() {
    this.started = true;
  }

  async send(message) {
    if (this.closed) {
      throw new Error("Probe transport is closed.");
    }
    this.messages.push(cloneJson(message));
    if (!("id" in message)) {
      return;
    }
    if (message.method === "initialize") {
      queueMicrotask(() => {
        this.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          result: makeInitializeResult(this.initializeVersion),
        });
      });
      return;
    }
    if (message.method === "tools/list" && !this.hangListTools) {
      queueMicrotask(() => {
        this.onmessage?.({
          jsonrpc: "2.0",
          id: message.id,
          result: makeToolList(),
        });
      });
    }
  }

  async close() {
    this.closeCalls += 1;
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.onclose?.();
  }

  offeredProtocolVersion() {
    const initialize = this.messages.find(
      (message) => message.method === "initialize",
    );
    return initialize?.params?.protocolVersion ?? null;
  }
}

function monitorPromise(promise) {
  const observation = {
    state: "pending",
    value: null,
    error: null,
  };
  const settled = Promise.resolve(promise).then(
    (value) => {
      observation.state = "fulfilled";
      observation.value = value;
    },
    (error) => {
      observation.state = "rejected";
      observation.error = serializeError(error);
    },
  );
  return {
    observation,
    settled,
  };
}

function snapshotObservation(observation) {
  return {
    state: observation.state,
    error: observation.error,
  };
}

async function waitForSettlement(monitor) {
  await Promise.race([monitor.settled, delay(LIFECYCLE_SETTLE_MS)]);
  return snapshotObservation(monitor.observation);
}

async function readPackage(packageRoot) {
  const packageJsonPath = path.join(packageRoot, "package.json");
  const esmPath = path.join(packageRoot, "dist", "index.mjs");
  const cjsPath = path.join(packageRoot, "dist", "index.js");
  const [packageJsonText, esmSource, cjsSource] = await Promise.all([
    fs.readFile(packageJsonPath, "utf8"),
    fs.readFile(esmPath),
    fs.readFile(cjsPath),
  ]);
  const packageJson = JSON.parse(packageJsonText);
  if (
    packageJson.name !== "@ai-sdk/mcp" ||
    typeof packageJson.version !== "string"
  ) {
    throw new Error(
      `Expected @ai-sdk/mcp package root, received ${packageJson.name ?? "unknown"}.`,
    );
  }
  return {
    packageRoot,
    packageJsonPath,
    entrypoints: {
      import: esmPath,
      require: cjsPath,
    },
    metadata: {
      name: packageJson.name,
      version: packageJson.version,
      license: packageJson.license ?? null,
      entrypointSha256: {
        import: sha256(esmSource),
        require: sha256(cjsSource),
      },
    },
  };
}

async function loadPackage(packageInfo, loader) {
  let loaded;
  if (loader === "import") {
    const entrypointUrl = pathToFileURL(packageInfo.entrypoints.import);
    entrypointUrl.searchParams.set(
      "oss-adoption-probe",
      packageInfo.metadata.entrypointSha256.import,
    );
    loaded = await import(entrypointUrl.href);
  } else if (loader === "require") {
    const requireFromPackage = createRequire(packageInfo.packageJsonPath);
    loaded = requireFromPackage(packageInfo.entrypoints.require);
  } else {
    throw new Error(`Unsupported package loader: ${loader}`);
  }
  if (typeof loaded.createMCPClient !== "function") {
    throw new Error(
      `${packageInfo.metadata.name} ${packageInfo.metadata.version} ${loader} entrypoint does not export createMCPClient.`,
    );
  }
  return loaded;
}

async function runNegotiationCase({
  createMCPClient,
  packageVariant,
  loader,
  protocolCase,
}) {
  const transport = new ProbeTransport({
    initializeVersion: protocolCase.responseVersion,
  });
  let client = null;
  let error = null;
  let toolsExposed = 0;
  try {
    client = await createMCPClient({ transport });
    const result = await client.listTools();
    toolsExposed = Array.isArray(result?.tools) ? result.tools.length : 0;
  } catch (caught) {
    error = serializeError(caught);
  } finally {
    if (client != null) {
      try {
        await client.close();
      } catch (caught) {
        error ??= serializeError(caught);
      }
    }
  }
  const success = error == null;
  const failureInvariantPassed =
    success || (toolsExposed === 0 && transport.closed === true);
  return {
    packageVariant,
    loader,
    case: protocolCase.id,
    offeredVersion: transport.offeredProtocolVersion(),
    selectedVersion:
      typeof protocolCase.responseVersion === "string"
        ? protocolCase.responseVersion
        : null,
    success,
    toolsExposed,
    transport: {
      started: transport.started,
      closed: transport.closed,
      closeCalls: transport.closeCalls,
      sentMethods: transport.messages.map(
        (message) => message.method ?? "response",
      ),
    },
    error,
    failureInvariantPassed,
  };
}

async function createInitializedHungClient(createMCPClient) {
  const transport = new ProbeTransport({
    initializeVersion: STRICT_PROTOCOL_VERSION,
    hangListTools: true,
  });
  const client = await createMCPClient({ transport });
  return {
    client,
    transport,
  };
}

async function runAbortLifecycle({ createMCPClient, packageVariant, loader }) {
  const { client, transport } =
    await createInitializedHungClient(createMCPClient);
  const abortController = new AbortController();
  const request = monitorPromise(
    client.listTools({
      options: {
        signal: abortController.signal,
        timeout: 10,
        maxTotalTimeout: 10,
      },
    }),
  );
  abortController.abort(new Error("Synthetic MCP probe abort."));
  await delay(LIFECYCLE_OBSERVATION_MS);
  const beforeClose = snapshotObservation(request.observation);
  await client.close();
  const afterClose = await waitForSettlement(request);
  const postCloseRequest = monitorPromise(client.listTools());
  const postClose = await waitForSettlement(postCloseRequest);
  return {
    packageVariant,
    loader,
    mode: "abort",
    configuredTimeoutMs: 10,
    abortSignalled: abortController.signal.aborted,
    beforeClose,
    afterClose,
    postClose,
    transport: {
      closed: transport.closed,
      closeCalls: transport.closeCalls,
      listRequests: transport.messages.filter(
        (message) => message.method === "tools/list",
      ).length,
    },
  };
}

async function runTimeoutLifecycle({
  createMCPClient,
  packageVariant,
  loader,
}) {
  const { client, transport } =
    await createInitializedHungClient(createMCPClient);
  const request = monitorPromise(
    client.listTools({
      options: {
        timeout: 10,
        maxTotalTimeout: 10,
      },
    }),
  );
  await delay(LIFECYCLE_OBSERVATION_MS);
  const beforeClose = snapshotObservation(request.observation);
  await client.close();
  const afterClose = await waitForSettlement(request);
  const postCloseRequest = monitorPromise(client.listTools());
  const postClose = await waitForSettlement(postCloseRequest);
  return {
    packageVariant,
    loader,
    mode: "timeout",
    configuredTimeoutMs: 10,
    beforeClose,
    afterClose,
    postClose,
    transport: {
      closed: transport.closed,
      closeCalls: transport.closeCalls,
      listRequests: transport.messages.filter(
        (message) => message.method === "tools/list",
      ).length,
    },
  };
}

function jsonResponse(result, status = 200) {
  return new Response(JSON.stringify(result), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

async function runStrictHttpCase({ createMCPClient, packageVariant, loader }) {
  const calls = [];
  const uncaughtErrors = [];
  let toolsExposed = 0;
  let client = null;
  let error = null;
  const fetch = async (url, init = {}) => {
    const method = init.method ?? "GET";
    const headers = normalizeHeaders(init.headers);
    const protocolHeader = headers["mcp-protocol-version"] ?? null;
    let message = null;
    if (typeof init.body === "string") {
      try {
        message = JSON.parse(init.body);
      } catch {
        message = null;
      }
    }
    calls.push({
      url: String(url),
      method,
      protocolHeader,
      rpcMethod: message?.method ?? null,
    });

    if (method === "GET") {
      return new Response(null, {
        status: 405,
        statusText: "Method Not Allowed",
      });
    }
    if (method !== "POST") {
      return new Response(null, { status: 405 });
    }
    if (protocolHeader !== STRICT_PROTOCOL_VERSION) {
      return new Response("strict server requires MCP 2025-06-18", {
        status: 400,
        headers: {
          "content-type": "text/plain",
        },
      });
    }
    if (message?.method === "initialize" && "id" in message) {
      return jsonResponse({
        jsonrpc: "2.0",
        id: message.id,
        result: makeInitializeResult(STRICT_PROTOCOL_VERSION),
      });
    }
    if (message?.method === "tools/list" && "id" in message) {
      return jsonResponse({
        jsonrpc: "2.0",
        id: message.id,
        result: makeToolList(),
      });
    }
    return new Response(null, { status: 202 });
  };

  try {
    client = await createMCPClient({
      transport: {
        type: "http",
        url: "https://mcp-probe.invalid/strict-2025-06-18",
        fetch,
      },
      onUncaughtError: (caught) => {
        uncaughtErrors.push(serializeError(caught));
      },
    });
    const tools = await client.listTools();
    toolsExposed = Array.isArray(tools?.tools) ? tools.tools.length : 0;
  } catch (caught) {
    error = serializeError(caught);
  } finally {
    if (client != null) {
      try {
        await client.close();
      } catch (caught) {
        error ??= serializeError(caught);
      }
    }
  }

  const postCalls = calls.filter((call) => call.method === "POST");
  return {
    packageVariant,
    loader,
    requiredHeaderVersion: STRICT_PROTOCOL_VERSION,
    success: error == null,
    toolsExposed,
    offeredVersion:
      postCalls.find((call) => call.rpcMethod === "initialize")
        ?.protocolHeader ?? null,
    allPostHeadersCompatible:
      postCalls.length > 0 &&
      postCalls.every(
        (call) => call.protocolHeader === STRICT_PROTOCOL_VERSION,
      ),
    customFetchCalls: calls,
    externalNetworkRequests: 0,
    error,
    uncaughtErrors,
  };
}

function negotiationSignature(entries, packageVariant, loader) {
  return entries
    .filter(
      (entry) =>
        entry.packageVariant === packageVariant && entry.loader === loader,
    )
    .map((entry) => ({
      case: entry.case,
      offeredVersion: entry.offeredVersion,
      selectedVersion: entry.selectedVersion,
      success: entry.success,
      toolsExposed: entry.toolsExposed,
      failureInvariantPassed: entry.failureInvariantPassed,
    }));
}

function strictHeaderSignature(entries, packageVariant, loader) {
  const entry = entries.find(
    (candidate) =>
      candidate.packageVariant === packageVariant &&
      candidate.loader === loader,
  );
  return {
    offeredVersion: entry?.offeredVersion ?? null,
    success: entry?.success ?? false,
    toolsExposed: entry?.toolsExposed ?? 0,
    allPostHeadersCompatible: entry?.allPostHeadersCompatible ?? false,
  };
}

function makeParity({
  packages,
  negotiation,
  strictHttpHeader,
  patchTouchedFiles,
}) {
  const byPackage = {};
  for (const packageVariant of PACKAGE_VARIANTS) {
    const importNegotiation = negotiationSignature(
      negotiation,
      packageVariant,
      "import",
    );
    const requireNegotiation = negotiationSignature(
      negotiation,
      packageVariant,
      "require",
    );
    const importHttp = strictHeaderSignature(
      strictHttpHeader,
      packageVariant,
      "import",
    );
    const requireHttp = strictHeaderSignature(
      strictHttpHeader,
      packageVariant,
      "require",
    );
    byPackage[packageVariant] = {
      importRequireNegotiationEqual:
        stableJson(importNegotiation) === stableJson(requireNegotiation),
      importRequireStrictHttpEqual:
        stableJson(importHttp) === stableJson(requireHttp),
      importRequireEntrypointHashEqual:
        packages[packageVariant].entrypointSha256.import ===
        packages[packageVariant].entrypointSha256.require,
      importNegotiation,
      requireNegotiation,
      importStrictHttp: importHttp,
      requireStrictHttp: requireHttp,
    };
    byPackage[packageVariant].importRequireBehaviorEqual =
      byPackage[packageVariant].importRequireNegotiationEqual &&
      byPackage[packageVariant].importRequireStrictHttpEqual;
  }

  return {
    patchTouchesImportEntrypoint: patchTouchedFiles.includes("dist/index.mjs"),
    patchTouchesRequireEntrypoint: patchTouchedFiles.includes("dist/index.js"),
    patchChangedImportEntrypoint:
      packages.patched.entrypointSha256.import !==
      packages.unpatched.entrypointSha256.import,
    patchChangedRequireEntrypoint:
      packages.patched.entrypointSha256.require !==
      packages.unpatched.entrypointSha256.require,
    byPackage,
    patchedImportRequireParityPassed:
      byPackage.patched.importRequireBehaviorEqual,
  };
}

function patchTouchedFiles(patchText) {
  const files = [];
  for (const match of patchText.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    if (match[1] === match[2]) {
      files.push(match[1]);
    } else {
      files.push(`${match[1]} -> ${match[2]}`);
    }
  }
  return files;
}

function evaluateProbe({
  packages,
  patch,
  negotiation,
  lifecycle,
  strictHttpHeader,
  parity,
}) {
  const evaluationFailures = [];
  const candidateFailures = [];
  const expectedNegotiationCount =
    PACKAGE_VARIANTS.length * LOADERS.length * PROTOCOL_CASES.length;
  if (negotiation.length !== expectedNegotiationCount) {
    evaluationFailures.push({
      id: "negotiation-matrix-incomplete",
      expected: expectedNegotiationCount,
      actual: negotiation.length,
    });
  }
  for (const entry of negotiation) {
    if (!entry.failureInvariantPassed) {
      evaluationFailures.push({
        id: "negotiation-failure-exposed-tools-or-left-client-open",
        packageVariant: entry.packageVariant,
        loader: entry.loader,
        case: entry.case,
        toolsExposed: entry.toolsExposed,
        transportClosed: entry.transport.closed,
      });
    }
  }

  const expectedLifecycleCount = PACKAGE_VARIANTS.length * LOADERS.length * 2;
  if (lifecycle.length !== expectedLifecycleCount) {
    evaluationFailures.push({
      id: "lifecycle-matrix-incomplete",
      expected: expectedLifecycleCount,
      actual: lifecycle.length,
    });
  }
  for (const entry of lifecycle) {
    if (
      entry.afterClose.state === "pending" ||
      entry.postClose.state !== "rejected" ||
      !entry.transport.closed
    ) {
      evaluationFailures.push({
        id: "hung-request-not-bounded-by-close",
        packageVariant: entry.packageVariant,
        loader: entry.loader,
        mode: entry.mode,
        beforeClose: entry.beforeClose.state,
        afterClose: entry.afterClose.state,
        postClose: entry.postClose.state,
        transportClosed: entry.transport.closed,
      });
    }
  }

  if (
    !parity.patchTouchesImportEntrypoint ||
    !parity.patchTouchesRequireEntrypoint ||
    !parity.patchChangedImportEntrypoint ||
    !parity.patchChangedRequireEntrypoint
  ) {
    candidateFailures.push({
      id: "mcp-patch-entrypoint-coverage",
      patchTouchedFiles: patch.touchedFiles,
      patchChangedImportEntrypoint: parity.patchChangedImportEntrypoint,
      patchChangedRequireEntrypoint: parity.patchChangedRequireEntrypoint,
    });
  }
  if (!parity.patchedImportRequireParityPassed) {
    candidateFailures.push({
      id: "mcp-patch-import-require-parity",
      importNegotiation: parity.byPackage.patched.importNegotiation,
      requireNegotiation: parity.byPackage.patched.requireNegotiation,
      importStrictHttp: parity.byPackage.patched.importStrictHttp,
      requireStrictHttp: parity.byPackage.patched.requireStrictHttp,
    });
  }

  const strictByVariantAndLoader = Object.fromEntries(
    strictHttpHeader.map((entry) => [
      `${entry.packageVariant}:${entry.loader}`,
      entry,
    ]),
  );
  const patchedImportStrict = strictByVariantAndLoader["patched:import"];
  const unpatchedImportStrict = strictByVariantAndLoader["unpatched:import"];
  const compatibilityNeedDemonstrated =
    patchedImportStrict?.success === true &&
    patchedImportStrict?.allPostHeadersCompatible === true &&
    patchedImportStrict?.toolsExposed === 1 &&
    unpatchedImportStrict?.success === false &&
    unpatchedImportStrict?.toolsExposed === 0;
  const unpatchedStrictFails = LOADERS.every((loader) => {
    const entry = strictByVariantAndLoader[`unpatched:${loader}`];
    return entry?.success === false && entry?.toolsExposed === 0;
  });
  if (!compatibilityNeedDemonstrated || !unpatchedStrictFails) {
    evaluationFailures.push({
      id: "strict-2025-06-18-compatibility-need-not-demonstrated",
      compatibilityNeedDemonstrated,
      unpatchedStrictFails,
      observations: strictHttpHeader.map((entry) => ({
        packageVariant: entry.packageVariant,
        loader: entry.loader,
        offeredVersion: entry.offeredVersion,
        success: entry.success,
        toolsExposed: entry.toolsExposed,
      })),
    });
  }

  if (
    packages.patched.name !== "@ai-sdk/mcp" ||
    packages.unpatched.name !== "@ai-sdk/mcp" ||
    packages.patched.version !== packages.unpatched.version
  ) {
    evaluationFailures.push({
      id: "mcp-package-pair-mismatch",
      patched: {
        name: packages.patched.name,
        version: packages.patched.version,
      },
      unpatched: {
        name: packages.unpatched.name,
        version: packages.unpatched.version,
      },
    });
  }
  const failures = [...evaluationFailures, ...candidateFailures];
  return {
    pass: failures.length === 0,
    evaluationPass: evaluationFailures.length === 0,
    compatibilityNeedDemonstrated,
    failures,
    evaluationFailures,
    candidateFailures,
  };
}

export async function runMcpProbe({
  patchedPackageRoot,
  unpatchedPackageRoot,
  patchFile,
}) {
  for (const [name, value] of Object.entries({
    patchedPackageRoot,
    unpatchedPackageRoot,
    patchFile,
  })) {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError(`${name} must be a non-empty path.`);
    }
  }

  const [patchedInfo, unpatchedInfo, patchSource] = await Promise.all([
    readPackage(path.resolve(patchedPackageRoot)),
    readPackage(path.resolve(unpatchedPackageRoot)),
    fs.readFile(path.resolve(patchFile), "utf8"),
  ]);
  const packageInfo = {
    patched: patchedInfo,
    unpatched: unpatchedInfo,
  };
  const modules = {};
  for (const packageVariant of PACKAGE_VARIANTS) {
    modules[packageVariant] = {};
    for (const loader of LOADERS) {
      modules[packageVariant][loader] = await loadPackage(
        packageInfo[packageVariant],
        loader,
      );
    }
  }

  const negotiation = [];
  const lifecycle = [];
  const strictHttpHeader = [];
  for (const packageVariant of PACKAGE_VARIANTS) {
    for (const loader of LOADERS) {
      const { createMCPClient } = modules[packageVariant][loader];
      for (const protocolCase of PROTOCOL_CASES) {
        negotiation.push(
          await runNegotiationCase({
            createMCPClient,
            packageVariant,
            loader,
            protocolCase,
          }),
        );
      }
      lifecycle.push(
        await runAbortLifecycle({
          createMCPClient,
          packageVariant,
          loader,
        }),
      );
      lifecycle.push(
        await runTimeoutLifecycle({
          createMCPClient,
          packageVariant,
          loader,
        }),
      );
      strictHttpHeader.push(
        await runStrictHttpCase({
          createMCPClient,
          packageVariant,
          loader,
        }),
      );
    }
  }

  const touchedFiles = patchTouchedFiles(patchSource);
  const packages = {
    patched: packageInfo.patched.metadata,
    unpatched: packageInfo.unpatched.metadata,
  };
  const patch = {
    sha256: sha256(patchSource),
    bytes: Buffer.byteLength(patchSource),
    touchedFiles,
  };
  const parity = makeParity({
    packages,
    negotiation,
    strictHttpHeader,
    patchTouchedFiles: touchedFiles,
  });
  const verdict = evaluateProbe({
    packages,
    patch,
    negotiation,
    lifecycle,
    strictHttpHeader,
    parity,
  });
  const result = {
    schemaVersion: 1,
    ...verdict,
    packages,
    patch,
    negotiation,
    lifecycle,
    strictHttpHeader,
    parity,
    constraints: {
      inMemoryNegotiationOnly: true,
      customFetchOnly: true,
      externalNetworkRequests: 0,
      mcpSubprocesses: 0,
      fixtureToolsOnly: true,
    },
  };
  return {
    ...result,
    resultSha256: sha256(stableJson(result)),
  };
}
