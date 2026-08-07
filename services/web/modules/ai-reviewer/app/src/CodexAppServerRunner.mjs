// @ts-check

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import Fs from "node:fs";
import Path from "node:path";
import { StringDecoder } from "node:string_decoder";

import {
  AgentGatewayAbortError,
  AgentGatewayError,
  AgentGatewayTimeoutError,
} from "./AgentGateway.mjs";
import { parseAiReviewerProviderCredential } from "./AiReviewerProviderConfig.mjs";
import {
  assertOpenAiCompatibleCredentialTransport,
  OpenAiCompatibleEndpointPolicyError,
  parseOpenAiCompatibleBaseUrl,
  parseOpenAiCompatibleModelId,
} from "./OllamaEndpointPolicy.mjs";
import {
  collectExternalAgentWorkspaceEdits,
  materializeExternalAgentWorkspace,
} from "./ExternalAgentWorkspace.mjs";

export const CODEX_APP_SERVER_VERSION = "0.146.0";
export const CODEX_APP_SERVER_STATE_ROOT =
  "/var/lib/overleaf/data/ai-reviewer/external-agent";
export const CODEX_APP_SERVER_WORK_ROOT =
  "/var/lib/overleaf/tmp/ai-reviewer/external-agent";
const MODEL_PROVIDER_ID = "overleaf-ai-reviewer";
const PROVIDER_CREDENTIAL_ENV = "OVERLEAF_AI_REVIEWER_PROVIDER_KEY";
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_LIMITS = Object.freeze({
  controlTimeoutMs: 10_000,
  interruptGraceMs: 1_000,
  exitGraceMs: 1_000,
  maxEvents: 20_000,
  maxLineBytes: 1024 * 1024,
  maxOutputCharacters: 200_000,
  maxStderrBytes: 1024 * 1024,
  maxStdoutBytes: 20 * 1024 * 1024,
});
const SAFE_ENVIRONMENT_KEYS = Object.freeze([
  "PATH",
  "LANG",
  "LC_ALL",
  "TZ",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
]);
const require = createRequire(import.meta.url);

export class CodexAppServerProtocolError extends AgentGatewayError {
  /** @param {unknown} [cause] */
  constructor(cause) {
    super("The external agent protocol failed.", {
      code: "AI_CODEX_APP_SERVER_PROTOCOL_ERROR",
      category: "schema",
      retryable: false,
      cause,
    });
    this.name = "CodexAppServerProtocolError";
  }
}

export class CodexAppServerProcessError extends AgentGatewayError {
  /** @param {unknown} [cause] */
  constructor(cause) {
    super("The external agent process failed.", {
      code: "AI_CODEX_APP_SERVER_PROCESS_ERROR",
      category: "provider",
      retryable: true,
      cause,
    });
    this.name = "CodexAppServerProcessError";
  }
}

export class CodexAppServerApprovalError extends AgentGatewayError {
  constructor() {
    super("The external agent requested an approval that is not allowed.", {
      code: "AI_CODEX_APP_SERVER_APPROVAL_REJECTED",
      category: "configuration",
      retryable: false,
    });
    this.name = "CodexAppServerApprovalError";
  }
}

export class CodexAppServerCleanupError extends AgentGatewayError {
  /** @param {unknown} [cause] */
  constructor(cause) {
    super("The external agent process could not be cleaned up.", {
      code: "AI_CODEX_APP_SERVER_CLEANUP_FAILED",
      category: "provider",
      retryable: false,
      cause,
    });
    this.name = "CodexAppServerCleanupError";
  }
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deferred() {
  /** @type {(value: any) => void} */
  let resolve = () => {};
  /** @type {(reason?: unknown) => void} */
  let reject = () => {};
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

/** @param {number} milliseconds */
function timeout(milliseconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

/** @param {AbortSignal | undefined} signal */
function abortError(signal) {
  return signal?.reason?.name === "TimeoutError"
    ? new AgentGatewayTimeoutError(signal.reason)
    : new AgentGatewayAbortError();
}

/** @param {AbortSignal | undefined} signal */
function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw abortError(signal);
  }
}

/** @param {unknown} value @param {string} field @param {number} limit */
function boundedString(value, field, limit = 500) {
  if (typeof value !== "string" || value.length === 0 || value.length > limit) {
    throw new TypeError(`${field} is invalid.`);
  }
  return value;
}

/** @param {unknown} value @param {string} field */
function absolutePath(value, field) {
  const parsed = boundedString(value, field, 4096);
  if (!Path.isAbsolute(parsed) || Path.normalize(parsed) !== parsed) {
    throw new TypeError(`${field} is invalid.`);
  }
  return parsed;
}

/** @param {string} directory */
async function ensurePrivateDirectory(directory) {
  await Fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await Fs.promises.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new TypeError("The Codex state directory is invalid.");
  }
  await Fs.promises.chmod(directory, 0o700);
}

/** @param {unknown} value */
function stateRootKey(value) {
  const key = boundedString(value, "stateRootKey", 200);
  if (!/^[A-Za-z0-9_-]+$/u.test(key)) {
    throw new TypeError("stateRootKey is invalid.");
  }
  return key;
}

/** @param {unknown} value @param {string} field */
async function privateRoot(value, field) {
  const root = absolutePath(value, field);
  await ensurePrivateDirectory(root);
  return await Fs.promises.realpath(root);
}

/** @param {string} root @param {string} key @param {string} kind */
async function privateSessionDirectory(root, key, kind) {
  const directory = Path.join(root, key);
  await ensurePrivateDirectory(directory);
  const realDirectory = await Fs.promises.realpath(directory);
  if (Path.dirname(realDirectory) !== root) {
    throw new TypeError(`The Codex ${kind} directory escaped its safe root.`);
  }
  return realDirectory;
}

/** @param {unknown} value @param {string} root */
async function containedWorkDirectory(value, root) {
  const directory = absolutePath(value, "workDirectory");
  const stat = await Fs.promises.lstat(directory);
  const realDirectory = await Fs.promises.realpath(directory);
  const relative = Path.relative(root, realDirectory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realDirectory !== directory ||
    relative.length === 0 ||
    relative.startsWith(`..${Path.sep}`) ||
    Path.isAbsolute(relative)
  ) {
    throw new TypeError("workDirectory escaped its safe root.");
  }
  return realDirectory;
}

/** @param {unknown} value */
function normalizeDestination(value) {
  if (!isRecord(value) || value.provider !== "openai-compatible") {
    throw new TypeError("The external agent provider is unsupported.");
  }
  const endpoint = parseOpenAiCompatibleBaseUrl(value.baseUrl);
  const model = parseOpenAiCompatibleModelId(value.model);
  const credential = Object.hasOwn(value, "credential")
    ? parseAiReviewerProviderCredential(value.credential)
    : null;
  if (endpoint.classification !== "local") {
    throw new OpenAiCompatibleEndpointPolicyError();
  }
  assertOpenAiCompatibleCredentialTransport(
    endpoint.baseUrl,
    credential != null,
  );
  return Object.freeze({
    baseUrl: endpoint.baseUrl,
    model,
    ...(credential == null ? {} : { credential }),
  });
}

/** @param {{ baseUrl: string, model: string, credentialPresent: boolean } | null} destination */
function threadConfig(destination) {
  if (destination == null) {
    return null;
  }
  return {
    model_providers: {
      [MODEL_PROVIDER_ID]: {
        name: "Overleaf AI Reviewer",
        base_url: destination.baseUrl,
        wire_api: "responses",
        ...(destination.credentialPresent
          ? { env_key: PROVIDER_CREDENTIAL_ENV }
          : {}),
        request_max_retries: 0,
        stream_max_retries: 0,
      },
    },
    features: { enable_request_compression: false },
    project_doc_fallback_filenames: [],
    project_doc_max_bytes: 0,
    project_root_markers: [],
    skills: { include_instructions: false },
    shell_environment_policy: {
      inherit: "none",
      ignore_default_excludes: false,
    },
    web_search: "disabled",
  };
}

/**
 * @param {string} stateDirectory
 * @param {NodeJS.ProcessEnv} source
 * @param {string | null} credential
 * @returns {Record<string, string>}
 */
function childEnvironment(stateDirectory, source, credential) {
  /** @type {Record<string, string>} */
  const environment = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (typeof value === "string") environment[key] = value;
  }
  environment.HOME = stateDirectory;
  environment.CODEX_HOME = stateDirectory;
  environment.XDG_CACHE_HOME = Path.join(stateDirectory, "cache");
  environment.XDG_CONFIG_HOME = Path.join(stateDirectory, "config");
  if (credential != null) {
    environment[PROVIDER_CREDENTIAL_ENV] = credential;
  }
  return environment;
}

function defaultExecutables() {
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new TypeError("The pinned App Server runtime is unsupported.");
  }
  const target = "x86_64-unknown-linux-musl";
  let vendorRoot;
  try {
    vendorRoot = Path.join(
      Path.dirname(require.resolve("@openai/codex-linux-x64/package.json")),
      "vendor",
    );
  } catch {
    vendorRoot = Path.join(
      Path.dirname(Path.dirname(require.resolve("@openai/codex/bin/codex.js"))),
      "vendor",
    );
  }
  const packageManifest = JSON.parse(
    Fs.readFileSync(
      Path.join(vendorRoot, target, "codex-package.json"),
      "utf8",
    ),
  );
  const nativeCodex = Fs.realpathSync(
    Path.join(vendorRoot, target, "bin", "codex"),
  );
  const bubblewrap = Fs.realpathSync(
    Path.join(vendorRoot, target, "codex-resources", "bwrap"),
  );
  if (
    packageManifest?.version !== CODEX_APP_SERVER_VERSION ||
    packageManifest?.target !== target ||
    packageManifest?.entrypoint !== "bin/codex" ||
    !Fs.statSync(nativeCodex).isFile() ||
    !Fs.statSync(bubblewrap).isFile()
  ) {
    throw new TypeError("The pinned App Server runtime is invalid.");
  }
  return Object.freeze({ bubblewrap, nativeCodex });
}

/** @param {string} left @param {string} right */
function pathsOverlap(left, right) {
  const relative = Path.relative(left, right);
  return (
    relative.length === 0 ||
    (!relative.startsWith(`..${Path.sep}`) && !Path.isAbsolute(relative))
  );
}

/** @param {string} stateRootDirectory @param {string} workRootDirectory */
function assertDisjointRoots(stateRootDirectory, workRootDirectory) {
  if (
    pathsOverlap(stateRootDirectory, workRootDirectory) ||
    pathsOverlap(workRootDirectory, stateRootDirectory)
  ) {
    throw new TypeError("The Codex state and work roots must be disjoint.");
  }
}

/**
 * @param {{ bubblewrap: string, nativeCodex: string }} executables
 * @param {{
 *   stateRootDirectory: string,
 *   stateDirectory: string,
 *   workRootDirectory: string,
 *   sessionWorkDirectory: string,
 * }} options
 */
function bubblewrapArguments(
  executables,
  {
    stateRootDirectory,
    stateDirectory,
    workRootDirectory,
    sessionWorkDirectory,
  },
) {
  return [
    "--new-session",
    "--die-with-parent",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    // Network stays shared so the loopback-only provider remains reachable;
    // externalSandbox's restricted value is a protocol declaration, not a
    // bubblewrap firewall.
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/run",
    // ponytail: Empty proc hides sibling secrets but means ordinary tools that
    // require procfs are unavailable. Replace it only when the dedicated
    // runner container permits mounting a private procfs.
    "--tmpfs",
    "/proc",
    "--dir",
    "/proc/self",
    "--symlink",
    executables.nativeCodex,
    "/proc/self/exe",
    "--tmpfs",
    stateRootDirectory,
    "--dir",
    stateDirectory,
    "--bind-fd",
    "3",
    stateDirectory,
    "--tmpfs",
    workRootDirectory,
    "--dir",
    sessionWorkDirectory,
    "--bind-fd",
    "4",
    sessionWorkDirectory,
    "--chdir",
    stateDirectory,
    "--",
    executables.nativeCodex,
    "app-server",
    "--listen",
    "stdio://",
    "--strict-config",
  ];
}

/** @param {number | undefined} pid */
function processGroupExists(pid) {
  if (!Number.isSafeInteger(pid) || /** @type {number} */ (pid) <= 0) {
    return false;
  }
  if (process.platform === "linux") {
    for (const entry of Fs.readdirSync("/proc")) {
      if (!/^[0-9]+$/u.test(entry)) continue;
      let stat;
      try {
        stat = Fs.readFileSync(`/proc/${entry}/stat`, "utf8");
      } catch (error) {
        if (isRecord(error) && error.code === "ENOENT") continue;
        throw error;
      }
      const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
      if (fields[0] !== "Z" && Number(fields[2]) === pid) {
        return true;
      }
    }
    return false;
  }
  try {
    process.kill(
      process.platform === "win32"
        ? /** @type {number} */ (pid)
        : -(/** @type {number} */ (pid)),
      0,
    );
    return true;
  } catch (error) {
    if (isRecord(error) && error.code === "ESRCH") {
      return false;
    }
    if (isRecord(error) && error.code === "EPERM") {
      return true;
    }
    throw error;
  }
}

/** @param {number | undefined} pid @param {number} timeoutMs */
async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (processGroupExists(pid) && Date.now() < deadline) {
    await timeout(Math.min(25, Math.max(1, deadline - Date.now())));
  }
  return !processGroupExists(pid);
}

/** @param {number | undefined} pid @param {NodeJS.Signals} signal */
function killProcessGroup(pid, signal) {
  if (!Number.isSafeInteger(pid) || /** @type {number} */ (pid) <= 0) {
    return;
  }
  try {
    if (process.platform === "win32") {
      process.kill(/** @type {number} */ (pid), signal);
    } else {
      process.kill(-(/** @type {number} */ (pid)), signal);
    }
  } catch (error) {
    if (!isRecord(error) || error.code !== "ESRCH") {
      throw error;
    }
  }
}

/** @param {unknown} input */
function threadId(input) {
  return boundedString(input, "threadId", 500);
}

/** @param {unknown} input */
function turnId(input) {
  return boundedString(input, "turnId", 500);
}

/** @param {unknown} value */
function exactVersionUserAgent(value) {
  return (
    typeof value === "string" &&
    new RegExp(
      `(^|[^0-9.])${CODEX_APP_SERVER_VERSION.replaceAll(".", "\\.")}([^0-9.]|$)`,
      "u",
    ).test(value)
  );
}

/**
 * One exact-version stdio App Server process. It intentionally implements
 * only the methods used by the external reviewer proof.
 */
export class CodexAppServerRunner {
  /**
   * @param {import("node:child_process").ChildProcessWithoutNullStreams} child
   * @param {{
   *   stateDirectory: string,
   *   workRootDirectory: string,
   *   baselineRootDirectory: string,
   *   destination: { baseUrl: string, model: string, credentialPresent: boolean } | null,
   *   limits: typeof DEFAULT_LIMITS,
   * }} options
   */
  constructor(
    child,
    {
      stateDirectory,
      workRootDirectory,
      baselineRootDirectory,
      destination,
      limits,
    },
  ) {
    this.child = child;
    this.stateDirectory = stateDirectory;
    this.workRootDirectory = workRootDirectory;
    this.baselineRootDirectory = baselineRootDirectory;
    this.destination = destination;
    this.limits = limits;
    this.loadedThreadIds = new Set();
    this.nextRequestId = 1;
    this.eventCount = 0;
    this.stdoutBytes = 0;
    this.stderrBytes = 0;
    this.stdoutBuffer = "";
    this.stdoutDecoder = new StringDecoder("utf8");
    this.pending = new Map();
    /** @type {null | {
     *   threadId: string,
     *   turnId: string | null,
     *   observedTurnId: string | null,
     *   text: string,
     *   completed: boolean,
     *   terminal: ReturnType<typeof deferred>,
     * }} */
    this.activeTurn = null;
    this.fatalError = null;
    this.closing = false;
    this.closed = false;
    this.exited = false;
    this.closePromise = null;
    this.exit = deferred();

    child.stdout.on("data", (chunk) => this.handleStdout(chunk));
    child.stdout.on("end", () => this.handleStdoutEnd());
    child.stderr.on("data", (chunk) => this.handleStderr(chunk));
    child.on("error", (error) =>
      this.fail(new CodexAppServerProcessError(error)),
    );
    child.on("exit", (code, signal) => {
      this.exited = true;
      this.exit.resolve({ code, signal });
      if (!this.closing) {
        this.fail(new CodexAppServerProcessError());
      }
    });
  }

  get pid() {
    return this.child.pid ?? null;
  }

  get healthy() {
    return !this.closed && !this.closing && this.fatalError == null;
  }

  /** @param {unknown} threadIdInput */
  hasThread(threadIdInput) {
    return (
      typeof threadIdInput === "string" &&
      this.loadedThreadIds.has(threadIdInput)
    );
  }

  /** @param {Buffer | string} chunk */
  handleStdout(chunk) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.stdoutBytes += buffer.length;
    if (this.stdoutBytes > this.limits.maxStdoutBytes) {
      this.fail(new CodexAppServerProtocolError());
      return;
    }
    this.stdoutBuffer += this.stdoutDecoder.write(buffer);
    let newline;
    while ((newline = this.stdoutBuffer.indexOf("\n")) !== -1) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (Buffer.byteLength(line) > this.limits.maxLineBytes) {
        this.fail(new CodexAppServerProtocolError());
        return;
      }
      if (line.trim().length !== 0) {
        this.handleLine(line);
      }
    }
    if (Buffer.byteLength(this.stdoutBuffer) > this.limits.maxLineBytes) {
      this.fail(new CodexAppServerProtocolError());
    }
  }

  handleStdoutEnd() {
    this.stdoutBuffer += this.stdoutDecoder.end();
    if (this.stdoutBuffer.trim().length !== 0 && !this.closing) {
      this.fail(new CodexAppServerProtocolError());
    }
  }

  /** @param {Buffer | string} chunk */
  handleStderr(chunk) {
    this.stderrBytes += Buffer.byteLength(chunk);
    if (this.stderrBytes > this.limits.maxStderrBytes) {
      this.fail(new CodexAppServerProtocolError());
    }
  }

  /** @param {string} line */
  handleLine(line) {
    this.eventCount += 1;
    if (this.eventCount > this.limits.maxEvents) {
      this.fail(new CodexAppServerProtocolError());
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.fail(new CodexAppServerProtocolError(error));
      return;
    }
    if (!isRecord(message)) {
      this.fail(new CodexAppServerProtocolError());
      return;
    }
    if (Object.hasOwn(message, "method")) {
      if (Object.hasOwn(message, "id")) {
        void this.handleServerRequest(message);
      } else {
        this.handleNotification(message);
      }
      return;
    }
    this.handleResponse(message);
  }

  /** @param {Record<string, any>} message */
  handleResponse(message) {
    const pending = this.pending.get(message.id);
    const hasResult = Object.hasOwn(message, "result");
    const hasError = Object.hasOwn(message, "error");
    if (pending == null || hasResult === hasError) {
      this.fail(new CodexAppServerProtocolError());
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (hasError) {
      pending.reject(new CodexAppServerProtocolError());
    } else {
      pending.resolve(message.result);
    }
  }

  /** @param {Record<string, any>} message */
  async handleServerRequest(message) {
    const approvals = new Map([
      ["item/commandExecution/requestApproval", { decision: "cancel" }],
      ["item/fileChange/requestApproval", { decision: "cancel" }],
      ["execCommandApproval", { decision: "abort" }],
      ["applyPatchApproval", { decision: "abort" }],
      ["item/permissions/requestApproval", { permissions: {} }],
    ]);
    const decision = approvals.get(message.method);
    if (decision == null) {
      await this.send({
        id: message.id,
        error: { code: -32_601, message: "Unsupported server request." },
      }).catch(() => {});
      this.fail(new CodexAppServerProtocolError());
      return;
    }
    if (this.fatalError == null) {
      this.fatalError = new CodexAppServerApprovalError();
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(this.fatalError);
      }
      this.pending.clear();
      this.activeTurn?.terminal.reject(this.fatalError);
    }
    await this.send({ id: message.id, result: decision }).catch(() => {});
    void this.close().catch(() => {});
  }

  /** @param {Record<string, any>} message */
  handleNotification(message) {
    if (message.method === "turn/completed") {
      const active = this.activeTurn;
      const notificationThreadId = message.params?.threadId;
      const notificationTurn = message.params?.turn;
      if (
        active == null ||
        active.completed ||
        notificationThreadId !== active.threadId ||
        !isRecord(notificationTurn) ||
        typeof notificationTurn.id !== "string" ||
        (active.turnId != null && notificationTurn.id !== active.turnId)
      ) {
        this.fail(new CodexAppServerProtocolError());
        return;
      }
      active.observedTurnId ??= notificationTurn.id;
      active.completed = true;
      active.terminal.resolve(notificationTurn);
      return;
    }
    if (message.method === "item/agentMessage/delta") {
      const active = this.activeTurn;
      const {
        threadId: messageThreadId,
        turnId: messageTurnId,
        delta,
      } = message.params ?? {};
      if (
        active == null ||
        active.completed ||
        messageThreadId !== active.threadId ||
        typeof messageTurnId !== "string" ||
        (active.turnId != null && messageTurnId !== active.turnId) ||
        typeof delta !== "string"
      ) {
        this.fail(new CodexAppServerProtocolError());
        return;
      }
      active.observedTurnId ??= messageTurnId;
      active.text += delta;
      if (active.text.length > this.limits.maxOutputCharacters) {
        this.fail(new CodexAppServerProtocolError());
      }
    }
  }

  /** @param {unknown} error */
  fail(error) {
    if (this.fatalError != null || this.closed) {
      return;
    }
    this.fatalError =
      error instanceof AgentGatewayError
        ? error
        : new CodexAppServerProcessError(error);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.fatalError);
    }
    this.pending.clear();
    this.activeTurn?.terminal.reject(this.fatalError);
    void this.close().catch(() => {});
  }

  /** @param {Record<string, unknown>} message */
  async send(message) {
    if (this.closed || this.closing) {
      throw new CodexAppServerProcessError();
    }
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line) > this.limits.maxLineBytes) {
      throw new CodexAppServerProtocolError();
    }
    await new Promise((resolve, reject) => {
      this.child.stdin.write(line, (error) =>
        error == null ? resolve(undefined) : reject(error),
      );
    });
  }

  /** @param {Record<string, unknown>} message */
  async write(message) {
    if (this.fatalError != null) {
      throw this.fatalError;
    }
    await this.send(message);
  }

  /**
   * @param {string} method
   * @param {Record<string, unknown>} params
   * @param {number} [timeoutMs]
   */
  async request(method, params, timeoutMs = this.limits.controlTimeoutMs) {
    if (this.fatalError != null) {
      throw this.fatalError;
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    if (!Number.isSafeInteger(id) || this.pending.size >= 32) {
      throw new CodexAppServerProtocolError();
    }
    const response = deferred();
    void response.promise.catch(() => {});
    const timer = setTimeout(() => {
      if (this.pending.delete(id)) {
        const error = new CodexAppServerProcessError();
        response.reject(error);
        this.fail(error);
      }
    }, timeoutMs);
    timer.unref?.();
    this.pending.set(id, { ...response, timer });
    try {
      await this.write({ id, method, params });
      return await response.promise;
    } catch (error) {
      clearTimeout(timer);
      this.pending.delete(id);
      throw error;
    }
  }

  async initialize() {
    const result = await this.request("initialize", {
      clientInfo: {
        name: "overleaf_ai_reviewer",
        title: "Overleaf AI Reviewer",
        version: CODEX_APP_SERVER_VERSION,
      },
      capabilities: { experimentalApi: true },
    });
    if (
      !isRecord(result) ||
      !exactVersionUserAgent(result.userAgent) ||
      result.codexHome !== this.stateDirectory
    ) {
      throw new CodexAppServerProtocolError();
    }
    await this.write({ method: "initialized", params: {} });
  }

  /** @param {string} workDirectory */
  threadParams(workDirectory) {
    if (this.destination == null) {
      throw new TypeError("The external agent destination is required.");
    }
    return {
      approvalPolicy: "never",
      allowProviderModelFallback: false,
      config: threadConfig(this.destination),
      cwd: workDirectory,
      dynamicTools: [],
      model: this.destination.model,
      modelProvider: MODEL_PROVIDER_ID,
      runtimeWorkspaceRoots: [workDirectory],
      sandbox: "danger-full-access",
      selectedCapabilityRoots: [],
    };
  }

  /** @param {unknown} result @param {string} workDirectory */
  validateThreadResult(result, workDirectory) {
    if (
      !isRecord(result) ||
      !isRecord(result.thread) ||
      typeof result.thread.id !== "string" ||
      result.cwd !== workDirectory ||
      result.approvalPolicy !== "never" ||
      result.model !== this.destination?.model ||
      result.modelProvider !== MODEL_PROVIDER_ID ||
      !Array.isArray(result.runtimeWorkspaceRoots) ||
      !(
        result.runtimeWorkspaceRoots.length === 0 ||
        (result.runtimeWorkspaceRoots.length === 1 &&
          result.runtimeWorkspaceRoots[0] === workDirectory)
      ) ||
      result.sandbox?.type !== "dangerFullAccess"
    ) {
      throw new CodexAppServerProtocolError();
    }
    return threadId(result.thread.id);
  }

  /** @param {unknown} workDirectoryInput */
  async startThread(workDirectoryInput) {
    const workDirectory = await containedWorkDirectory(
      workDirectoryInput,
      this.workRootDirectory,
    );
    const result = await this.request("thread/start", {
      ...this.threadParams(workDirectory),
      ephemeral: false,
    });
    const startedThreadId = this.validateThreadResult(result, workDirectory);
    this.loadedThreadIds.add(startedThreadId);
    return startedThreadId;
  }

  /** @param {unknown} threadIdInput @param {unknown} workDirectoryInput */
  async resumeThread(threadIdInput, workDirectoryInput) {
    const workDirectory = await containedWorkDirectory(
      workDirectoryInput,
      this.workRootDirectory,
    );
    const expectedThreadId = threadId(threadIdInput);
    const result = await this.request("thread/resume", {
      threadId: expectedThreadId,
      ...this.threadParams(workDirectory),
    });
    const resumedThreadId = this.validateThreadResult(result, workDirectory);
    if (resumedThreadId !== expectedThreadId) {
      throw new CodexAppServerProtocolError();
    }
    this.loadedThreadIds.add(resumedThreadId);
    return resumedThreadId;
  }

  /** @param {unknown} threadIdInput */
  async readThread(threadIdInput) {
    const expectedThreadId = threadId(threadIdInput);
    const result = await this.request("thread/read", {
      threadId: expectedThreadId,
      includeTurns: false,
    });
    if (!isRecord(result?.thread) || result.thread.id !== expectedThreadId) {
      throw new CodexAppServerProtocolError();
    }
    return result.thread;
  }

  /** @param {unknown} threadIdInput */
  async archiveThread(threadIdInput) {
    const expectedThreadId = threadId(threadIdInput);
    const result = await this.request("thread/archive", {
      threadId: expectedThreadId,
    });
    if (!isRecord(result)) {
      throw new CodexAppServerProtocolError();
    }
    this.loadedThreadIds.delete(expectedThreadId);
  }

  /** @param {unknown} threadIdInput */
  async unarchiveThread(threadIdInput) {
    const expectedThreadId = threadId(threadIdInput);
    const result = await this.request("thread/unarchive", {
      threadId: expectedThreadId,
    });
    if (!isRecord(result?.thread) || result.thread.id !== expectedThreadId) {
      throw new CodexAppServerProtocolError();
    }
  }

  /** @param {string} expectedThreadId */
  async cleanBackgroundTerminals(expectedThreadId) {
    const cleaned = await this.request("thread/backgroundTerminals/clean", {
      threadId: expectedThreadId,
    });
    if (!isRecord(cleaned)) {
      throw new CodexAppServerProtocolError();
    }
    let cursor = null;
    for (let page = 0; page < 10; page += 1) {
      const result = await this.request("thread/backgroundTerminals/list", {
        threadId: expectedThreadId,
        cursor,
        limit: 100,
      });
      if (!Array.isArray(result?.data) || result.data.length !== 0) {
        throw new CodexAppServerProcessError();
      }
      if (result.nextCursor == null) {
        return;
      }
      cursor = boundedString(result.nextCursor, "nextCursor", 500);
    }
    throw new CodexAppServerProtocolError();
  }

  /**
   * @param {{
   *   threadId: unknown,
   *   workDirectory: unknown,
   *   prompt: unknown,
   *   signal?: AbortSignal,
   * }} input
   */
  async runTurn({
    threadId: threadIdInput,
    workDirectory: workDirectoryInput,
    prompt: promptInput,
    signal,
  }) {
    throwIfAborted(signal);
    if (this.activeTurn != null || !this.healthy) {
      throw new CodexAppServerProcessError();
    }
    const expectedThreadId = threadId(threadIdInput);
    const workDirectory = await containedWorkDirectory(
      workDirectoryInput,
      this.workRootDirectory,
    );
    if (!this.hasThread(expectedThreadId)) {
      throw new CodexAppServerProtocolError();
    }
    const prompt = boundedString(promptInput, "prompt", 200_000);
    const terminal = deferred();
    void terminal.promise.catch(() => {});
    this.activeTurn = {
      threadId: expectedThreadId,
      turnId: null,
      observedTurnId: null,
      text: "",
      completed: false,
      terminal,
    };

    /** @type {(() => void) | null} */
    let removeAbortListener = null;
    const cancellation = deferred();
    void cancellation.promise.catch(() => {});
    if (signal != null) {
      const listener = () => cancellation.reject(abortError(signal));
      signal.addEventListener("abort", listener, { once: true });
      removeAbortListener = () => signal.removeEventListener("abort", listener);
      if (signal.aborted) {
        listener();
      }
    }
    try {
      const started = await Promise.race([
        this.request("turn/start", {
          threadId: expectedThreadId,
          input: [{ type: "text", text: prompt }],
          cwd: workDirectory,
          runtimeWorkspaceRoots: [workDirectory],
          approvalPolicy: "never",
          sandboxPolicy: {
            type: "externalSandbox",
            networkAccess: "restricted",
          },
        }),
        cancellation.promise,
      ]);
      const startedTurnId = turnId(started?.turn?.id);
      if (
        this.activeTurn.observedTurnId != null &&
        this.activeTurn.observedTurnId !== startedTurnId
      ) {
        throw new CodexAppServerProtocolError();
      }
      this.activeTurn.turnId = startedTurnId;

      let completedTurn;
      try {
        completedTurn = await Promise.race([
          terminal.promise,
          cancellation.promise,
        ]);
      } catch (error) {
        if (
          !(
            error instanceof AgentGatewayAbortError ||
            error instanceof AgentGatewayTimeoutError
          )
        ) {
          throw error;
        }
        await this.request(
          "turn/interrupt",
          { threadId: expectedThreadId, turnId: startedTurnId },
          this.limits.interruptGraceMs,
        ).catch(() => {});
        await Promise.race([
          terminal.promise.catch(() => undefined),
          timeout(this.limits.interruptGraceMs),
        ]);
        throw error;
      }

      if (
        !isRecord(completedTurn) ||
        completedTurn.id !== startedTurnId ||
        completedTurn.status !== "completed"
      ) {
        throw new CodexAppServerProcessError();
      }
      throwIfAborted(signal);
      await this.cleanBackgroundTerminals(expectedThreadId);
      throwIfAborted(signal);
      return Object.freeze({
        threadId: expectedThreadId,
        turnId: startedTurnId,
        text: this.activeTurn.text,
      });
    } catch (error) {
      await this.close();
      throw error instanceof AgentGatewayError
        ? error
        : new CodexAppServerProcessError(error);
    } finally {
      removeAbortListener?.();
      this.activeTurn = null;
    }
  }

  async measureStateBytes() {
    return await directoryBytes(this.stateDirectory);
  }

  async close() {
    if (this.closePromise != null) {
      return await this.closePromise;
    }
    this.closing = true;
    this.closePromise = (async () => {
      const pid = this.child.pid;
      try {
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.reject(this.fatalError ?? new CodexAppServerProcessError());
        }
        this.pending.clear();
        this.activeTurn?.terminal.reject(
          this.fatalError ?? new CodexAppServerProcessError(),
        );
        this.child.stdin.end();
        await Promise.race([
          this.exit.promise,
          timeout(this.limits.exitGraceMs),
        ]);
        if (processGroupExists(pid)) {
          killProcessGroup(pid, "SIGTERM");
          await waitForProcessGroupExit(pid, this.limits.exitGraceMs);
        }
        if (processGroupExists(pid)) {
          killProcessGroup(pid, "SIGKILL");
          await waitForProcessGroupExit(pid, this.limits.exitGraceMs);
        }
        await Promise.race([
          this.exit.promise,
          timeout(this.limits.exitGraceMs),
        ]);
        if (!this.exited || processGroupExists(pid)) {
          throw new CodexAppServerCleanupError();
        }
        try {
          await Promise.all([
            Fs.promises.rm(this.workRootDirectory, {
              recursive: true,
              force: true,
            }),
            Fs.promises.rm(this.baselineRootDirectory, {
              recursive: true,
              force: true,
            }),
          ]);
        } catch (error) {
          throw new CodexAppServerCleanupError(error);
        }
        this.closed = true;
      } catch (error) {
        try {
          killProcessGroup(pid, "SIGKILL");
          await waitForProcessGroupExit(pid, this.limits.exitGraceMs);
        } catch {}
        if (processGroupExists(pid)) {
          throw error instanceof CodexAppServerCleanupError
            ? error
            : new CodexAppServerCleanupError(error);
        }
        this.closed = true;
        throw error;
      } finally {
        this.closing = false;
      }
    })();
    return await this.closePromise;
  }
}

/**
 * @param {{
 *   stateRootKey: unknown,
 *   stateRootDirectory?: unknown,
 *   workRootDirectory?: unknown,
 *   destination?: unknown,
 *   command?: string,
 *   args?: string[],
 *   environment?: NodeJS.ProcessEnv,
 *   limits?: Partial<typeof DEFAULT_LIMITS>,
 *   spawnProcess?: typeof spawn,
 * }} options
 */
export async function createCodexAppServerRunner(options) {
  if (!isRecord(options)) {
    throw new TypeError("The App Server options are invalid.");
  }
  const key = stateRootKey(options.stateRootKey);
  const destination =
    options.destination == null
      ? null
      : normalizeDestination(options.destination);
  const hasCustomCommand = options.command != null || options.args != null;
  if (
    hasCustomCommand &&
    (typeof options.command !== "string" || !Array.isArray(options.args))
  ) {
    throw new TypeError("The App Server arguments are invalid.");
  }
  const customCommand = hasCustomCommand
    ? boundedString(options.command, "App Server command", 4096)
    : null;
  const customArguments = hasCustomCommand ? options.args : null;
  if (
    customArguments != null &&
    customArguments.some((argument) => typeof argument !== "string")
  ) {
    throw new TypeError("The App Server arguments are invalid.");
  }
  const limits = Object.freeze({ ...DEFAULT_LIMITS, ...options.limits });
  if (
    Object.values(limits).some(
      (limit) => !Number.isSafeInteger(limit) || limit <= 0,
    )
  ) {
    throw new TypeError("The App Server limits are invalid.");
  }
  const executables = hasCustomCommand ? null : defaultExecutables();
  const stateRootDirectory = await privateRoot(
    options.stateRootDirectory ?? CODEX_APP_SERVER_STATE_ROOT,
    "stateRootDirectory",
  );
  const commonWorkRootDirectory = await privateRoot(
    options.workRootDirectory ?? CODEX_APP_SERVER_WORK_ROOT,
    "workRootDirectory",
  );
  assertDisjointRoots(stateRootDirectory, commonWorkRootDirectory);
  const stateDirectory = await privateSessionDirectory(
    stateRootDirectory,
    key,
    "state",
  );
  const workRootDirectory = await privateSessionDirectory(
    commonWorkRootDirectory,
    key,
    "work",
  );
  const baselineRootDirectory = await privateSessionDirectory(
    commonWorkRootDirectory,
    `.base_${key}`,
    "baseline",
  );
  const spawnProcess = options.spawnProcess ?? spawn;
  const environment = childEnvironment(
    stateDirectory,
    options.environment ?? process.env,
    destination?.credential ?? null,
  );
  const runnerDestination =
    destination == null
      ? null
      : Object.freeze({
          baseUrl: destination.baseUrl,
          model: destination.model,
          credentialPresent: destination.credential != null,
        });
  let stateFd = null;
  let workFd = null;
  let child;
  try {
    if (customCommand != null && customArguments != null) {
      child = spawnProcess(customCommand, customArguments, {
        cwd: stateDirectory,
        detached: process.platform !== "win32",
        env: environment,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } else {
      if (executables == null) {
        throw new TypeError("The pinned App Server runtime is invalid.");
      }
      const directoryFlags =
        Fs.constants.O_RDONLY |
        Fs.constants.O_DIRECTORY |
        Fs.constants.O_NOFOLLOW;
      stateFd = Fs.openSync(stateDirectory, directoryFlags);
      workFd = Fs.openSync(workRootDirectory, directoryFlags);
      child = spawnProcess(
        executables.bubblewrap,
        bubblewrapArguments(executables, {
          stateRootDirectory,
          stateDirectory,
          workRootDirectory: commonWorkRootDirectory,
          sessionWorkDirectory: workRootDirectory,
        }),
        {
          cwd: stateDirectory,
          detached: true,
          env: environment,
          stdio: ["pipe", "pipe", "pipe", stateFd, workFd],
        },
      );
    }
  } catch (error) {
    await Promise.all([
      Fs.promises.rm(workRootDirectory, { recursive: true, force: true }),
      Fs.promises.rm(baselineRootDirectory, {
        recursive: true,
        force: true,
      }),
    ]);
    throw error;
  } finally {
    if (stateFd != null) Fs.closeSync(stateFd);
    if (workFd != null) Fs.closeSync(workFd);
  }
  const runner = new CodexAppServerRunner(
    /** @type {import("node:child_process").ChildProcessWithoutNullStreams} */ (
      child
    ),
    {
      stateDirectory,
      workRootDirectory,
      baselineRootDirectory,
      destination: runnerDestination,
      limits,
    },
  );
  try {
    await runner.initialize();
    return runner;
  } catch (error) {
    await runner.close();
    throw error instanceof AgentGatewayError
      ? error
      : new CodexAppServerProcessError(error);
  }
}

/** @param {string} directory */
async function directoryBytes(directory) {
  let total = 0;
  for (const entry of await Fs.promises.readdir(directory, {
    withFileTypes: true,
  })) {
    const path = Path.join(directory, entry.name);
    if (entry.isDirectory()) {
      total += await directoryBytes(path);
    } else if (entry.isFile()) {
      total += (await Fs.promises.lstat(path)).size;
    } else {
      throw new CodexAppServerProtocolError();
    }
    if (!Number.isSafeInteger(total)) {
      throw new CodexAppServerProtocolError();
    }
  }
  return total;
}

/**
 * Materialize one fresh History workspace, complete one turn, collect exact
 * edits, and always remove the turn directory. A failed turn also retires its
 * process; normal Agent turns may keep it in the active registry.
 *
 * @param {{
 *   runner: CodexAppServerRunner,
 *   snapshot: Parameters<typeof materializeExternalAgentWorkspace>[1],
 *   prompt: unknown,
 *   threadId?: unknown,
 *   resume?: boolean,
 *   signal?: AbortSignal,
 * }} input
 */
export async function runCodexAppServerWorkspaceTurn({
  runner,
  snapshot,
  prompt,
  threadId: existingThreadId,
  resume = false,
  signal,
}) {
  if (typeof resume !== "boolean" || (resume && existingThreadId == null)) {
    throw new TypeError("The external agent resume request is invalid.");
  }
  let workspace = null;
  let output = null;
  let failure = null;
  try {
    workspace = await materializeExternalAgentWorkspace(
      runner.workRootDirectory,
      snapshot,
      { baselineRootDirectory: runner.baselineRootDirectory },
    );
    const activeThreadId =
      existingThreadId == null
        ? await runner.startThread(workspace.workDirectory)
        : resume
          ? await runner.resumeThread(existingThreadId, workspace.workDirectory)
          : threadId(existingThreadId);
    const turn = await runner.runTurn({
      threadId: activeThreadId,
      workDirectory: workspace.workDirectory,
      prompt,
      signal,
    });
    output = Object.freeze({
      threadId: activeThreadId,
      turn,
      changes: await collectExternalAgentWorkspaceEdits(workspace),
      stateBytes: await runner.measureStateBytes(),
    });
  } catch (error) {
    failure = error;
    try {
      await runner.close();
    } catch (cleanupError) {
      failure = cleanupError;
    }
  }
  if (workspace != null) {
    if (failure != null && !runner.closed) {
      throw failure instanceof CodexAppServerCleanupError
        ? failure
        : new CodexAppServerCleanupError(failure);
    }
    try {
      await Promise.all(
        [workspace.runDirectory, workspace.baselineRunDirectory]
          .filter((directory) => typeof directory === "string")
          .map((directory) =>
            Fs.promises.rm(directory, { recursive: true, force: true }),
          ),
      );
    } catch (error) {
      let cleanupFailure = null;
      try {
        await runner.close();
      } catch (closeError) {
        cleanupFailure = closeError;
      }
      failure = cleanupFailure ?? new CodexAppServerCleanupError(error);
    }
  }
  if (failure != null) throw failure;
  if (output == null) throw new CodexAppServerProtocolError();
  return output;
}

/**
 * A runner-process-local registry for active Agent sessions. Review callers do
 * not register their one-shot process.
 *
 * @param {{ idleTimeoutMs?: number }} [options]
 */
export function createCodexAppServerRegistry({
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
} = {}) {
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs <= 0) {
    throw new TypeError("idleTimeoutMs is invalid.");
  }
  const entries = new Map();

  /** @param {any} entry */
  function clearIdleTimer(entry) {
    if (entry.timer != null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }
  }

  /** @param {string} key @param {any} expected */
  async function discard(key, expected) {
    const entry = entries.get(key);
    if (entry == null || (expected != null && entry !== expected)) {
      return;
    }
    clearIdleTimer(entry);
    let started = false;
    entry.closing ??= Promise.resolve(entry.starting)
      .then((runner) => {
        started = true;
        return runner.close();
      })
      .then(() => {
        if (entries.get(key) === entry) {
          entries.delete(key);
        }
      })
      .catch((error) => {
        if (!started && entries.get(key) === entry) {
          entries.delete(key);
        }
        throw error;
      });
    await entry.closing;
  }

  return {
    get size() {
      return entries.size;
    },

    /**
     * @param {unknown} keyInput
     * @param {unknown} fingerprintInput
     * @param {() => Promise<CodexAppServerRunner>} start
     */
    async acquire(keyInput, fingerprintInput, start) {
      const key = boundedString(keyInput, "registry key", 500);
      const fingerprint = boundedString(
        fingerprintInput,
        "connection fingerprint",
        500,
      );
      for (;;) {
        const current = entries.get(key);
        if (current?.closing != null) {
          await current.closing;
          continue;
        }
        if (current != null && current.fingerprint === fingerprint) {
          clearIdleTimer(current);
          const runner = await current.starting;
          if (runner.healthy) {
            return runner;
          }
          await discard(key, current);
          continue;
        }
        if (current != null) {
          await discard(key, current);
          continue;
        }
        const entry = {
          fingerprint,
          timer: null,
          closing: null,
          starting: Promise.resolve().then(start),
        };
        entries.set(key, entry);
        try {
          return await entry.starting;
        } catch (error) {
          if (entries.get(key) === entry) {
            entries.delete(key);
          }
          throw error;
        }
      }
    },

    /** @param {unknown} keyInput @param {{ healthy?: boolean }} [result] */
    async release(keyInput, { healthy = true } = {}) {
      const key = boundedString(keyInput, "registry key", 500);
      const entry = entries.get(key);
      if (entry == null) {
        return;
      }
      if (!healthy) {
        await discard(key, entry);
        return;
      }
      clearIdleTimer(entry);
      entry.timer = setTimeout(
        () => void discard(key, entry).catch(() => {}),
        idleTimeoutMs,
      );
      entry.timer.unref?.();
    },

    /** @param {unknown} keyInput */
    async stop(keyInput) {
      const key = boundedString(keyInput, "registry key", 500);
      await discard(key, entries.get(key));
    },

    async closeAll() {
      await Promise.all(
        [...entries.entries()].map(([key, entry]) => discard(key, entry)),
      );
    },
  };
}
