// @ts-check

import Fs from "node:fs";
import Net from "node:net";
import Path from "node:path";
import { pathToFileURL } from "node:url";

import {
  CODEX_APP_SERVER_STATE_ROOT,
  CODEX_APP_SERVER_WORK_ROOT,
  createCodexAppServerRegistry,
  createCodexAppServerRunner,
  runCodexAppServerWorkspaceTurn,
} from "./CodexAppServerRunner.mjs";
import { parseAiReviewerProviderCredential } from "./AiReviewerProviderConfig.mjs";
import { validateExternalAgentHistorySnapshot } from "./ExternalAgentWorkspace.mjs";

export const EXTERNAL_AGENT_RUNNER_SOCKET =
  "/run/overleaf-ai-reviewer/runner.sock";
export const EXTERNAL_AGENT_RUNNER_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

const PUBLIC_ERROR = Object.freeze({
  code: "AI_EXTERNAL_AGENT_RUNNER_FAILED",
  message: "The external agent runner request failed.",
});
const ABORTED_ERROR = Object.freeze({
  code: "AI_EXTERNAL_AGENT_RUNNER_ABORTED",
  message: "The external agent runner request was cancelled.",
});

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @param {string} field @param {number} limit */
function boundedString(value, field, limit) {
  if (typeof value !== "string" || value.length === 0 || value.length > limit) {
    throw new TypeError(`${field} is invalid.`);
  }
  return value;
}

/** @param {Record<string, any>} value @param {string[]} keys */
function exactKeys(value, keys) {
  const expected = new Set(keys);
  if (
    Object.keys(value).length !== expected.size ||
    Object.keys(value).some((key) => !expected.has(key))
  ) {
    throw new TypeError("The external agent runner request is invalid.");
  }
}

/** @param {unknown} value */
function opaqueKey(value) {
  const key = boundedString(value, "stateRootKey", 200);
  if (!/^[A-Za-z0-9_-]+$/u.test(key)) {
    throw new TypeError("stateRootKey is invalid.");
  }
  return key;
}

/** @param {unknown} value */
function optionalThreadId(value) {
  return value == null ? null : boundedString(value, "threadId", 500);
}

/** @param {unknown} value */
function destination(value) {
  if (!isRecord(value)) {
    throw new TypeError("destination is invalid.");
  }
  const keys = ["provider", "baseUrl", "model"];
  let credential;
  if (Object.hasOwn(value, "credential")) {
    keys.push("credential");
    credential = parseAiReviewerProviderCredential(value.credential);
  }
  exactKeys(value, keys);
  if (value.provider !== "openai-compatible") {
    throw new TypeError("destination is invalid.");
  }
  return Object.freeze({
    provider: "openai-compatible",
    baseUrl: boundedString(value.baseUrl, "destination.baseUrl", 2_000),
    model: boundedString(value.model, "destination.model", 500),
    ...(credential == null ? {} : { credential }),
  });
}

/** @param {unknown} value */
function request(value) {
  if (!isRecord(value)) {
    throw new TypeError("The external agent runner request is invalid.");
  }
  if (value.operation === "turn") {
    exactKeys(value, [
      "operation",
      "mode",
      "snapshot",
      "prompt",
      "stateRootKey",
      "fingerprint",
      "destination",
      "threadId",
    ]);
    if (value.mode !== "review" && value.mode !== "agent") {
      throw new TypeError("mode is invalid.");
    }
    const threadId = optionalThreadId(value.threadId);
    if (value.mode === "review" && threadId != null) {
      throw new TypeError("Review turns cannot resume a thread.");
    }
    return Object.freeze({
      operation: "turn",
      mode: value.mode,
      snapshot: validateExternalAgentHistorySnapshot(value.snapshot),
      prompt: boundedString(value.prompt, "prompt", 200_000),
      stateRootKey: opaqueKey(value.stateRootKey),
      fingerprint: boundedString(value.fingerprint, "fingerprint", 200),
      destination: destination(value.destination),
      threadId,
    });
  }
  if (value.operation === "retire") {
    exactKeys(value, ["operation", "stateRootKey"]);
    return Object.freeze({
      operation: "retire",
      stateRootKey: opaqueKey(value.stateRootKey),
    });
  }
  if (value.operation === "archive") {
    exactKeys(value, ["operation", "stateRootKey", "threadId"]);
    return Object.freeze({
      operation: "archive",
      stateRootKey: opaqueKey(value.stateRootKey),
      threadId: boundedString(value.threadId, "threadId", 500),
    });
  }
  if (value.operation === "unarchive") {
    exactKeys(value, ["operation", "stateRootKey", "threadId"]);
    return Object.freeze({
      operation: "unarchive",
      stateRootKey: opaqueKey(value.stateRootKey),
      threadId: boundedString(value.threadId, "threadId", 500),
    });
  }
  throw new TypeError("The external agent runner operation is invalid.");
}

/** @param {unknown} value */
function socketPath(value) {
  const parsed = boundedString(value, "socketPath", 100);
  if (
    !Path.isAbsolute(parsed) ||
    Path.normalize(parsed) !== parsed ||
    !/^[A-Za-z0-9._-]+$/u.test(Path.basename(parsed)) ||
    Buffer.byteLength(parsed) > 100
  ) {
    throw new TypeError("socketPath is invalid.");
  }
  return parsed;
}

/** @param {string} filename */
async function prepareSocket(filename) {
  const directory = Path.dirname(filename);
  await Fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const [stat, realDirectory] = await Promise.all([
    Fs.promises.lstat(directory),
    Fs.promises.realpath(directory),
  ]);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realDirectory !== directory ||
    (stat.mode & 0o077) !== 0 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  ) {
    throw new TypeError("The runner socket directory is unsafe.");
  }
  let existing;
  try {
    existing = await Fs.promises.lstat(filename);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (
    !existing.isSocket() ||
    (typeof process.getuid === "function" && existing.uid !== process.getuid())
  ) {
    throw new TypeError("The runner socket path already exists.");
  }
  const active = await new Promise((resolve, reject) => {
    const probe = Net.createConnection({ path: filename });
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", (error) => {
      const code = /** @type {NodeJS.ErrnoException} */ (error).code;
      if (code === "ECONNREFUSED" || code === "ENOENT") {
        resolve(false);
      } else {
        reject(error);
      }
    });
  });
  if (active) {
    throw new TypeError("The runner socket path is already active.");
  }
  let stale;
  try {
    stale = await Fs.promises.lstat(filename);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (
    !stale.isSocket() ||
    stale.dev !== existing.dev ||
    stale.ino !== existing.ino ||
    (typeof process.getuid === "function" && stale.uid !== process.getuid())
  ) {
    throw new TypeError("The runner socket path changed unexpectedly.");
  }
  await Fs.promises.unlink(filename);
}

/**
 * @param {string} filename
 * @param {{ dev: number, ino: number, uid: number }} expected
 */
async function removeSocket(filename, expected) {
  let stat;
  try {
    stat = await Fs.promises.lstat(filename);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return;
    throw error;
  }
  if (
    !stat.isSocket() ||
    stat.dev !== expected.dev ||
    stat.ino !== expected.ino ||
    stat.uid !== expected.uid
  ) {
    throw new TypeError("The runner socket path is unsafe.");
  }
  await Fs.promises.unlink(filename);
}

function publicFailure() {
  const error = new Error(PUBLIC_ERROR.message);
  // @ts-ignore -- callers use the stable code without another error class.
  error.code = PUBLIC_ERROR.code;
  return error;
}

function abortedFailure() {
  const error = new Error(ABORTED_ERROR.message);
  // @ts-ignore -- callers use the stable code without another error class.
  error.code = ABORTED_ERROR.code;
  return error;
}

/** @param {unknown} payload */
function responseLine(payload) {
  const line = `${JSON.stringify(payload)}\n`;
  if (Buffer.byteLength(line) - 1 > EXTERNAL_AGENT_RUNNER_MAX_MESSAGE_BYTES) {
    throw new TypeError("The runner response is too large.");
  }
  return line;
}

/**
 * Start the narrow runner boundary. The injected functions are only test
 * seams; production uses the pinned runner and its active-process registry.
 *
 * @param {{
 *   socketPath?: unknown,
 *   stateRootDirectory?: unknown,
 *   workRootDirectory?: unknown,
 *   runnerFactory?: typeof createCodexAppServerRunner,
 *   registry?: ReturnType<typeof createCodexAppServerRegistry>,
 *   workspaceTurn?: typeof runCodexAppServerWorkspaceTurn,
 * }} [options]
 */
export async function listenExternalAgentRunnerService(options = {}) {
  const filename = socketPath(
    options.socketPath ??
      process.env.OVERLEAF_AI_REVIEWER_RUNNER_SOCKET ??
      EXTERNAL_AGENT_RUNNER_SOCKET,
  );
  const stateRootDirectory =
    options.stateRootDirectory ??
    process.env.OVERLEAF_AI_REVIEWER_RUNNER_STATE_ROOT ??
    CODEX_APP_SERVER_STATE_ROOT;
  const workRootDirectory =
    options.workRootDirectory ??
    process.env.OVERLEAF_AI_REVIEWER_RUNNER_WORK_ROOT ??
    CODEX_APP_SERVER_WORK_ROOT;
  const runnerFactory = options.runnerFactory ?? createCodexAppServerRunner;
  const registry = options.registry ?? createCodexAppServerRegistry();
  const workspaceTurn = options.workspaceTurn ?? runCodexAppServerWorkspaceTurn;
  await prepareSocket(filename);

  /** @type {Set<{ connection: Net.Socket, abort: AbortController }>} */
  const connections = new Set();
  /** @type {Set<Promise<void>>} */
  const inFlight = new Set();

  /** @param {ReturnType<typeof request>} input @param {AbortSignal} signal */
  async function execute(input, signal) {
    if (signal.aborted) throw new Error("The runner request was cancelled.");
    if (input.operation === "retire") {
      await registry.stop(input.stateRootKey);
      return {};
    }
    if (input.operation === "archive" || input.operation === "unarchive") {
      await registry.stop(input.stateRootKey);
      if (signal.aborted) throw new Error("The runner request was cancelled.");
      const runner = await runnerFactory({
        stateRootKey: input.stateRootKey,
        stateRootDirectory,
        workRootDirectory,
      });
      const onAbort = () => void runner.close().catch(() => {});
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        if (signal.aborted)
          throw new Error("The runner request was cancelled.");
        if (input.operation === "archive") {
          await runner.archiveThread(input.threadId);
        } else {
          await runner.unarchiveThread(input.threadId);
        }
        return { stateBytes: await runner.measureStateBytes() };
      } finally {
        signal.removeEventListener("abort", onAbort);
        await runner.close();
      }
    }

    const start = () =>
      runnerFactory({
        stateRootKey: input.stateRootKey,
        stateRootDirectory,
        workRootDirectory,
        destination: input.destination,
      });
    if (input.mode === "review") {
      const runner = await start();
      try {
        if (signal.aborted)
          throw new Error("The runner request was cancelled.");
        return await workspaceTurn({
          runner,
          snapshot: input.snapshot,
          prompt: input.prompt,
          signal,
        });
      } finally {
        await runner.close();
      }
    }

    try {
      const runner = await registry.acquire(
        input.stateRootKey,
        input.fingerprint,
        start,
      );
      if (signal.aborted) throw new Error("The runner request was cancelled.");
      const resume =
        input.threadId != null && !(await runner.hasThread(input.threadId));
      const result = await workspaceTurn({
        runner,
        snapshot: input.snapshot,
        prompt: input.prompt,
        threadId: input.threadId ?? undefined,
        resume,
        signal,
      });
      await registry.release(input.stateRootKey, { healthy: true });
      return result;
    } catch (error) {
      await registry.release(input.stateRootKey, { healthy: false });
      throw error;
    }
  }

  const server = Net.createServer((connection) => {
    const abort = new AbortController();
    const active = { connection, abort };
    connections.add(active);
    /** @type {Buffer[]} */
    let chunks = [];
    let bytes = 0;
    let processing = false;
    let replied = false;

    const fail = () => {
      if (replied || connection.destroyed) return;
      abort.abort();
      try {
        const line = responseLine({ ok: false, error: PUBLIC_ERROR });
        replied = true;
        connection.end(line);
      } catch {
        connection.destroy();
      }
    };

    connection.on("error", () => {});
    connection.on("close", () => {
      connections.delete(active);
      if (!replied) abort.abort();
    });
    connection.on("end", () => {
      if (!processing) fail();
    });
    connection.on("data", (chunk) => {
      if (processing) {
        fail();
        return;
      }
      const newline = chunk.indexOf(0x0a);
      if (newline === -1) {
        bytes += chunk.length;
        if (bytes > EXTERNAL_AGENT_RUNNER_MAX_MESSAGE_BYTES) {
          fail();
        } else {
          chunks.push(chunk);
        }
        return;
      }
      bytes += newline;
      if (
        bytes > EXTERNAL_AGENT_RUNNER_MAX_MESSAGE_BYTES ||
        newline !== chunk.length - 1
      ) {
        fail();
        return;
      }
      chunks.push(chunk.subarray(0, newline));
      processing = true;
      connection.pause();
      let input;
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks, bytes),
        );
        input = request(JSON.parse(text));
      } catch {
        fail();
        return;
      }
      chunks = [];
      const operation = execute(input, abort.signal)
        .then((result) => {
          if (replied || connection.destroyed) return;
          const line = responseLine({ ok: true, result });
          replied = true;
          connection.end(line);
        })
        .catch(fail);
      inFlight.add(operation);
      void operation.finally(() => inFlight.delete(operation));
    });
  });

  /** @type {{ dev: number, ino: number, uid: number } | null} */
  let ownedSocket = null;
  try {
    await new Promise((resolve, reject) => {
      /** @param {Error} error */
      const onError = (error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve(undefined);
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(filename);
    });
    let stat = await Fs.promises.lstat(filename);
    if (
      !stat.isSocket() ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) {
      throw new TypeError("The runner socket is unsafe.");
    }
    ownedSocket = { dev: stat.dev, ino: stat.ino, uid: stat.uid };
    await Fs.promises.chmod(filename, 0o600);
    stat = await Fs.promises.lstat(filename);
    if (
      !stat.isSocket() ||
      stat.dev !== ownedSocket.dev ||
      stat.ino !== ownedSocket.ino ||
      stat.uid !== ownedSocket.uid ||
      (stat.mode & 0o777) !== 0o600 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) {
      throw new TypeError("The runner socket is unsafe.");
    }
  } catch (error) {
    if (server.listening) server.close();
    if (ownedSocket != null) {
      await removeSocket(filename, ownedSocket).catch(() => {});
    }
    throw error;
  }
  if (ownedSocket == null) {
    throw new TypeError("The runner socket is unsafe.");
  }
  const socketIdentity = ownedSocket;

  let closing = null;
  return Object.freeze({
    socketPath: filename,
    close() {
      closing ??= (async () => {
        for (const active of connections) {
          active.abort.abort();
          active.connection.destroy();
        }
        await new Promise((resolve, reject) => {
          server.close((error) =>
            error == null ? resolve(undefined) : reject(error),
          );
        });
        await Promise.allSettled([...inFlight]);
        try {
          await registry.closeAll();
        } finally {
          await removeSocket(filename, socketIdentity);
        }
      })();
      return closing;
    },
  });
}

export class ExternalAgentRunnerClient {
  /** @param {unknown} [filename] */
  constructor(
    filename = process.env.OVERLEAF_AI_REVIEWER_RUNNER_SOCKET ??
      EXTERNAL_AGENT_RUNNER_SOCKET,
  ) {
    this.socketPath = socketPath(filename);
  }

  /** @param {unknown} input @param {{ signal?: AbortSignal }} [options] */
  async turn(input, options) {
    if (!isRecord(input)) throw publicFailure();
    return await this.#send(
      { ...input, operation: "turn", threadId: input.threadId ?? null },
      options?.signal,
    );
  }

  /** @param {unknown} input @param {{ signal?: AbortSignal }} [options] */
  async archive(input, options) {
    if (!isRecord(input)) throw publicFailure();
    return await this.#send(
      { ...input, operation: "archive" },
      options?.signal,
    );
  }

  /** @param {unknown} input @param {{ signal?: AbortSignal }} [options] */
  async unarchive(input, options) {
    if (!isRecord(input)) throw publicFailure();
    return await this.#send(
      { ...input, operation: "unarchive" },
      options?.signal,
    );
  }

  /** @param {unknown} input */
  async retire(input) {
    if (!isRecord(input)) throw publicFailure();
    return await this.#send({ ...input, operation: "retire" }, undefined);
  }

  /** @param {unknown} value @param {AbortSignal | undefined} signal */
  async #send(value, signal) {
    let input;
    let line;
    try {
      input = request(value);
      line = `${JSON.stringify(input)}\n`;
      if (
        Buffer.byteLength(line) - 1 >
        EXTERNAL_AGENT_RUNNER_MAX_MESSAGE_BYTES
      ) {
        throw new TypeError("The runner request is too large.");
      }
    } catch {
      throw publicFailure();
    }
    if (signal?.aborted) throw abortedFailure();

    return await new Promise((resolve, reject) => {
      const connection = Net.createConnection({ path: this.socketPath });
      let buffer = Buffer.alloc(0);
      let settled = false;
      /** @param {Error | null} error @param {unknown} [result] */
      const settle = (error, result) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        connection.destroy();
        if (error == null) resolve(result);
        else reject(error);
      };
      const onAbort = () => settle(abortedFailure());
      signal?.addEventListener("abort", onAbort, { once: true });
      connection.on("connect", () => connection.write(line));
      connection.on("error", () => settle(publicFailure()));
      connection.on("end", () => settle(publicFailure()));
      connection.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length > EXTERNAL_AGENT_RUNNER_MAX_MESSAGE_BYTES + 1) {
          settle(publicFailure());
          return;
        }
        const newline = buffer.indexOf(0x0a);
        if (newline === -1) return;
        if (newline !== buffer.length - 1) {
          settle(publicFailure());
          return;
        }
        let response;
        try {
          response = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(
              buffer.subarray(0, newline),
            ),
          );
        } catch {
          settle(publicFailure());
          return;
        }
        if (
          isRecord(response) &&
          response.ok === true &&
          Object.keys(response).length === 2 &&
          Object.hasOwn(response, "result")
        ) {
          settle(null, response.result);
        } else {
          settle(publicFailure());
        }
      });
    });
  }
}

const isMain =
  process.argv[1] != null &&
  import.meta.url === pathToFileURL(Path.resolve(process.argv[1])).href;

if (isMain) {
  /** @type {Awaited<ReturnType<typeof listenExternalAgentRunnerService>> | undefined} */
  let service;
  try {
    service = await listenExternalAgentRunnerService();
  } catch {
    process.stderr.write("External agent runner service failed.\n");
    process.exitCode = 1;
  }
  if (service != null) {
    const close = () => {
      void service.close().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
  }
}
