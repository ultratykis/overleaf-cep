import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import Fs from "node:fs";
import Net from "node:net";
import Os from "node:os";
import Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EXTERNAL_AGENT_RUNNER_MAX_MESSAGE_BYTES,
  ExternalAgentRunnerClient,
  listenExternalAgentRunnerService,
} from "../../../app/src/ExternalAgentRunnerService.mjs";

const roots = [];
const services = [];

async function temporaryRoot() {
  const root = await Fs.promises.mkdtemp(
    Path.join(Os.tmpdir(), "runner-service-test-"),
  );
  roots.push(root);
  return root;
}

async function socketFilename(root) {
  const directory = Path.join(root, "socket");
  await Fs.promises.mkdir(directory, { mode: 0o700 });
  return Path.join(directory, "runner.sock");
}

function snapshot(text = "Original") {
  return {
    projectId: "project-1",
    historyVersion: 4,
    documents: [
      {
        documentId: "document-1",
        path: "main.tex",
        revision: 7,
        text,
        textHash: createHash("sha256").update(text).digest("hex"),
      },
    ],
  };
}

function turnInput(overrides = {}) {
  return {
    mode: "agent",
    snapshot: snapshot(),
    prompt: "Review it.",
    stateRootKey: "state-key-1",
    fingerprint: "connection-1",
    destination: {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:43210/v1",
      model: "fixture-model",
    },
    threadId: null,
    ...overrides,
  };
}

function fakeRegistry() {
  const entries = new Map();
  const stops = [];
  return {
    entries,
    stops,
    async acquire(key, fingerprint, start) {
      let entry = entries.get(key);
      if (entry != null && entry.fingerprint !== fingerprint) {
        await this.stop(key);
        entry = null;
      }
      if (entry == null) {
        entry = { fingerprint, runner: await start() };
        entries.set(key, entry);
      }
      return entry.runner;
    },
    async release(key, { healthy = true } = {}) {
      if (!healthy) await this.stop(key);
    },
    async stop(key) {
      stops.push(key);
      const entry = entries.get(key);
      await entry?.runner.close();
      entries.delete(key);
    },
    async closeAll() {
      await Promise.all([...entries.keys()].map((key) => this.stop(key)));
    },
  };
}

function fakeHarness({ workspaceTurn } = {}) {
  const runners = [];
  const turns = [];
  const registry = fakeRegistry();
  async function runnerFactory(options) {
    const id = runners.length + 1;
    const runner = {
      id,
      pid: 10_000 + id,
      options,
      threads: new Set(),
      closed: false,
      archives: [],
      unarchives: [],
      deletes: [],
      hasThread(threadId) {
        return this.threads.has(threadId);
      },
      async archiveThread(threadId) {
        this.archives.push(threadId);
      },
      async unarchiveThread(threadId) {
        this.unarchives.push(threadId);
      },
      async deleteThread(threadId) {
        this.deletes.push(threadId);
      },
      async measureStateBytes() {
        return 100 + id;
      },
      async close() {
        this.closed = true;
      },
    };
    runners.push(runner);
    return runner;
  }
  const defaultTurn = async (input) => {
    const threadId = input.threadId ?? `thread-${input.runner.id}`;
    if (input.threadId == null || input.resume) {
      input.runner.threads.add(threadId);
    }
    turns.push({ ...input, threadId });
    return {
      threadId,
      turn: { threadId, turnId: `turn-${turns.length}`, text: "done" },
      changes: { projectId: input.snapshot.projectId, edits: [] },
      stateBytes: 100 + input.runner.id,
    };
  };
  return {
    registry,
    runners,
    turns,
    runnerFactory,
    workspaceTurn: workspaceTurn ?? defaultTurn,
  };
}

async function start(root, harness) {
  const filename = await socketFilename(root);
  const service = await listenExternalAgentRunnerService({
    socketPath: filename,
    stateRootDirectory: Path.join(root, "state"),
    workRootDirectory: Path.join(root, "work"),
    runnerFactory: harness.runnerFactory,
    registry: harness.registry,
    workspaceTurn: harness.workspaceTurn,
  });
  services.push(service);
  return { service, client: new ExternalAgentRunnerClient(filename), filename };
}

async function closeService(service) {
  services.splice(services.indexOf(service), 1);
  await service.close();
}

async function rawRequest(filename, bytes) {
  return await new Promise((resolve, reject) => {
    const connection = Net.createConnection({ path: filename });
    const chunks = [];
    connection.on("connect", () => connection.write(bytes));
    connection.on("data", (chunk) => chunks.push(chunk));
    connection.on("error", reject);
    connection.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function failureOf(work) {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to fail.");
}

afterEach(async function () {
  await Promise.all(services.splice(0).map((service) => service.close()));
  await Promise.all(
    roots
      .splice(0)
      .map((root) => Fs.promises.rm(root, { recursive: true, force: true })),
  );
});

describe("external agent runner Unix socket", function () {
  it("closes each Review runner and cleans up its private socket", async function () {
    const root = await temporaryRoot();
    const harness = fakeHarness();
    const { service, client, filename } = await start(root, harness);

    const result = await client.turn(turnInput({ mode: "review" }));

    expect(result.threadId).toBe("thread-1");
    expect(harness.runners).toHaveLength(1);
    expect(harness.runners[0].closed).toBe(true);
    expect(harness.registry.entries.size).toBe(0);
    expect((await Fs.promises.lstat(filename)).mode & 0o777).toBe(0o600);

    await closeService(service);
    expect(await failureOf(Fs.promises.lstat(filename))).toMatchObject({
      code: "ENOENT",
    });
  });

  it("reuses an Agent runner and resumes only after its process stops", async function () {
    const root = await temporaryRoot();
    const harness = fakeHarness();
    const { client } = await start(root, harness);

    const first = await client.turn(turnInput());
    await client.turn(turnInput({ threadId: first.threadId }));

    expect(harness.runners).toHaveLength(1);
    expect(harness.turns.map((turn) => turn.resume)).toEqual([false, false]);
    expect(harness.turns.map((turn) => turn.runner.pid)).toEqual([
      10_001, 10_001,
    ]);

    await harness.registry.stop("state-key-1");
    await client.turn(turnInput({ threadId: first.threadId }));

    expect(harness.runners).toHaveLength(2);
    expect(harness.turns[2]).toMatchObject({ resume: true });
    expect(harness.turns[2].runner.pid).toBe(10_002);
  });

  it("separates session keys and replaces a changed connection fingerprint", async function () {
    const root = await temporaryRoot();
    const harness = fakeHarness();
    const { client } = await start(root, harness);
    const userAKey = "synthetic-user-a-key";
    const userBKey = "synthetic-user-b-key";

    const first = await client.turn(
      turnInput({
        stateRootKey: "state-a",
        fingerprint: "connection-a",
        destination: {
          provider: "openai-compatible",
          baseUrl: "https://localhost:43210/user-a/v1",
          model: "fixture-model",
          credential: userAKey,
        },
      }),
    );
    await client.turn(
      turnInput({
        stateRootKey: "state-b",
        fingerprint: "connection-b",
        destination: {
          provider: "openai-compatible",
          baseUrl: "https://localhost:43210/user-b/v1",
          model: "fixture-model",
          credential: userBKey,
        },
      }),
    );

    expect(harness.runners.map((runner) => runner.pid)).toEqual([
      10_001, 10_002,
    ]);
    expect(harness.runners[0].closed).toBe(false);
    expect(harness.runners[1].closed).toBe(false);
    expect(harness.runners[0].options.destination.credential).toBe(userAKey);
    expect(harness.runners[1].options.destination.credential).toBe(userBKey);
    expect(JSON.stringify(harness.runners[0].options)).not.toContain(userBKey);
    expect(JSON.stringify(harness.runners[1].options)).not.toContain(userAKey);

    await client.turn(
      turnInput({
        stateRootKey: "state-a",
        fingerprint: "connection-a-rotated",
        threadId: first.threadId,
      }),
    );

    expect(harness.runners[0].closed).toBe(true);
    expect(harness.runners[1].closed).toBe(false);
    expect(harness.turns[2]).toMatchObject({ resume: true });
    expect(harness.turns[2].runner.pid).toBe(10_003);
  });

  it("accepts only the exact optional credential IPC shape", async function () {
    const root = await temporaryRoot();
    const harness = fakeHarness();
    const { client, filename } = await start(root, harness);
    const expectedFailure = {
      ok: false,
      error: {
        code: "AI_EXTERNAL_AGENT_RUNNER_FAILED",
        message: "The external agent runner request failed.",
      },
    };

    for (const destination of [
      {
        provider: "openai-compatible",
        baseUrl: "https://localhost:43210/v1",
        model: "fixture-model",
        credential: "synthetic-key\n",
      },
      {
        provider: "openai-compatible",
        baseUrl: "https://localhost:43210/v1",
        model: "fixture-model",
        credential: "synthetic-key",
        extra: true,
      },
    ]) {
      expect(
        await failureOf(client.turn(turnInput({ destination }))),
      ).toMatchObject({ code: "AI_EXTERNAL_AGENT_RUNNER_FAILED" });
      const response = await rawRequest(
        filename,
        `${JSON.stringify({
          operation: "turn",
          ...turnInput({ destination }),
        })}\n`,
      );
      expect(JSON.parse(response)).toEqual(expectedFailure);
      expect(response).not.toContain("synthetic-key");
    }
    expect(harness.runners).toHaveLength(0);
  });

  it("stops active runners before credentialless archive operations", async function () {
    const root = await temporaryRoot();
    const harness = fakeHarness();
    const { client } = await start(root, harness);
    const first = await client.turn(turnInput());
    const active = harness.runners[0];

    expect(
      await client.archive({
        stateRootKey: "state-key-1",
        threadId: first.threadId,
      }),
    ).toEqual({ stateBytes: 102 });
    const archived = harness.runners[1];
    expect(active.closed).toBe(true);
    expect(archived.options.destination).toBeUndefined();
    expect(archived.archives).toEqual([first.threadId]);
    expect(archived.closed).toBe(true);

    expect(
      await client.unarchive({
        stateRootKey: "state-key-1",
        threadId: first.threadId,
      }),
    ).toEqual({ stateBytes: 103 });
    expect(harness.runners[2].unarchives).toEqual([first.threadId]);
    expect(harness.runners[2].closed).toBe(true);
  });

  it("credentiallessly deletes a thread and only its verified state root", async function () {
    const root = await temporaryRoot();
    const harness = fakeHarness();
    const { client, filename } = await start(root, harness);
    const first = await client.turn(turnInput());
    const active = harness.runners[0];
    const stateRoot = Path.join(root, "state");
    const sessionState = Path.join(stateRoot, "state-key-1");
    const siblingState = Path.join(stateRoot, "sibling-state");
    const outside = Path.join(root, "outside-state");
    await Promise.all(
      [stateRoot, sessionState, siblingState, outside].map(async (path) => {
        await Fs.promises.mkdir(path, { recursive: true, mode: 0o700 });
        await Fs.promises.chmod(path, 0o700);
      }),
    );
    const siblingMarker = Path.join(siblingState, "keep");
    const outsideMarker = Path.join(outside, "keep");
    await Promise.all([
      Fs.promises.writeFile(siblingMarker, "sibling"),
      Fs.promises.writeFile(outsideMarker, "outside"),
      Fs.promises.symlink(outsideMarker, Path.join(sessionState, "link")),
    ]);

    expect(
      await client.purge({
        stateRootKey: "state-key-1",
        threadId: first.threadId,
      }),
    ).toEqual({});
    const purgeRunner = harness.runners[1];
    expect(active.closed).toBe(true);
    expect(purgeRunner.options.destination).toBeUndefined();
    expect(purgeRunner.deletes).toEqual([first.threadId]);
    expect(purgeRunner.closed).toBe(true);
    expect(await failureOf(Fs.promises.lstat(sessionState))).toMatchObject({
      code: "ENOENT",
    });
    expect(await Fs.promises.readFile(siblingMarker, "utf8")).toBe("sibling");
    expect(await Fs.promises.readFile(outsideMarker, "utf8")).toBe("outside");

    expect(
      await client.purge({
        stateRootKey: "state-key-1",
        threadId: first.threadId,
      }),
    ).toEqual({});
    expect(harness.runners).toHaveLength(2);

    await Fs.promises.symlink(outside, Path.join(stateRoot, "linked-state"));
    expect(
      await failureOf(
        client.purge({
          stateRootKey: "linked-state",
          threadId: first.threadId,
        }),
      ),
    ).toMatchObject({
      code: "AI_EXTERNAL_AGENT_RUNNER_FAILED",
      message: "The external agent runner request failed.",
    });
    expect(harness.runners).toHaveLength(2);
    expect(await Fs.promises.readFile(outsideMarker, "utf8")).toBe("outside");

    for (const extra of [
      { credential: "must-not-cross" },
      { destination: turnInput().destination },
      { path: "/var/lib/private" },
    ]) {
      const response = await rawRequest(
        filename,
        `${JSON.stringify({
          operation: "purge",
          stateRootKey: "state-key-1",
          threadId: first.threadId,
          ...extra,
        })}\n`,
      );
      expect(JSON.parse(response)).toMatchObject({
        ok: false,
        error: { code: "AI_EXTERNAL_AGENT_RUNNER_FAILED" },
      });
      expect(response).not.toMatch(/must-not-cross|\/var\/lib\/private/iu);
    }
    expect(harness.runners).toHaveLength(2);
  });

  it("retries after thread deletion when state removal did not start", async function () {
    const root = await temporaryRoot();
    const harness = fakeHarness();
    const createRunner = harness.runnerFactory;
    let allowCleanup = false;
    harness.runnerFactory = async (options) => {
      const runner = await createRunner(options);
      if (harness.runners.length === 1) {
        runner.close = async function () {
          if (!allowCleanup) {
            throw new Error("cleanup confirmation failed");
          }
          runner.closed = true;
        };
      }
      return runner;
    };
    const { client } = await start(root, harness);
    const state = Path.join(root, "state", "state-key-1");
    await Fs.promises.mkdir(state, { recursive: true, mode: 0o700 });

    expect(
      await failureOf(
        client.purge({ stateRootKey: "state-key-1", threadId: "thread-1" }),
      ),
    ).toMatchObject({ code: "AI_EXTERNAL_AGENT_RUNNER_FAILED" });
    expect(Fs.existsSync(state)).toBe(true);

    expect(
      await failureOf(
        client.purge({
          stateRootKey: "state-key-1",
          threadId: "thread-1",
        }),
      ),
    ).toMatchObject({ code: "AI_EXTERNAL_AGENT_RUNNER_FAILED" });
    expect(harness.runners).toHaveLength(1);
    expect(harness.registry.entries.size).toBe(1);
    expect(Fs.existsSync(state)).toBe(true);

    allowCleanup = true;
    await harness.registry.stop("state-key-1");
    expect(
      await client.purge({ stateRootKey: "state-key-1", threadId: "thread-1" }),
    ).toEqual({});
    expect(harness.runners.map((runner) => runner.deletes)).toEqual([
      ["thread-1"],
      ["thread-1"],
    ]);
    expect(Fs.existsSync(state)).toBe(false);
  });

  it("purges a threadless session without starting an App Server", async function () {
    const root = await temporaryRoot();
    const harness = fakeHarness();
    const { client } = await start(root, harness);

    expect(
      await failureOf(
        client.purge({ stateRootKey: "never-started", threadId: null }),
      ),
    ).toMatchObject({ code: "AI_EXTERNAL_AGENT_RUNNER_FAILED" });
    const stateRoot = Path.join(root, "state");
    await Fs.promises.mkdir(stateRoot, { mode: 0o700 });
    expect(
      await client.purge({ stateRootKey: "never-started", threadId: null }),
    ).toEqual({});
    const state = Path.join(stateRoot, "threadless");
    await Fs.promises.mkdir(state, { recursive: true, mode: 0o700 });
    expect(
      await client.purge({ stateRootKey: "threadless", threadId: null }),
    ).toEqual({});

    expect(harness.runners).toHaveLength(0);
    expect(Fs.existsSync(state)).toBe(false);
  });

  it("retires an active Agent runner by state key only", async function () {
    const root = await temporaryRoot();
    const harness = fakeHarness();
    const { client } = await start(root, harness);
    await client.turn(turnInput());

    expect(await client.retire({ stateRootKey: "state-key-1" })).toEqual({});

    expect(harness.registry.stops).toEqual(["state-key-1"]);
    expect(harness.registry.entries.size).toBe(0);
    expect(harness.runners[0].closed).toBe(true);
    expect(
      await failureOf(
        client.retire({
          stateRootKey: "state-key-1",
          threadId: "thread-1",
        }),
      ),
    ).toMatchObject({ code: "AI_EXTERNAL_AGENT_RUNNER_FAILED" });

    harness.registry.stop = async () => {
      throw new Error("credential-secret /private/path");
    };
    const error = await failureOf(
      client.retire({ stateRootKey: "state-key-2" }),
    );
    expect(error).toMatchObject({
      code: "AI_EXTERNAL_AGENT_RUNNER_FAILED",
      message: "The external agent runner request failed.",
    });
    expect(error.message).not.toMatch(/credential-secret|private/iu);
  });

  it("turns a client disconnect into runner cancellation and retirement", async function () {
    const root = await temporaryRoot();
    let startedResolve;
    const started = new Promise((resolve) => {
      startedResolve = resolve;
    });
    let observedAbort = false;
    const harness = fakeHarness({
      workspaceTurn: async ({ signal }) => {
        startedResolve();
        await new Promise((resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              reject(new Error("cancelled /secret/path credential=hidden"));
            },
            { once: true },
          );
        });
      },
    });
    const { client } = await start(root, harness);
    const abort = new AbortController();
    const pending = client.turn(turnInput(), { signal: abort.signal });
    await started;

    abort.abort();

    expect(await failureOf(pending)).toMatchObject({
      code: "AI_EXTERNAL_AGENT_RUNNER_ABORTED",
    });
    await expect.poll(() => observedAbort).toBe(true);
    await expect.poll(() => harness.runners[0].closed).toBe(true);
    expect(harness.registry.entries.size).toBe(0);
  });

  it("bounds JSONL and redacts malformed and internal failures", async function () {
    const root = await temporaryRoot();
    const harness = fakeHarness({
      workspaceTurn: async () => {
        const error = new Error(
          "credential=top-secret path=/var/lib/private/secret",
        );
        error.stack = "stack at /var/lib/private/secret";
        throw error;
      },
    });
    const { client, filename } = await start(root, harness);
    const expected = {
      ok: false,
      error: {
        code: "AI_EXTERNAL_AGENT_RUNNER_FAILED",
        message: "The external agent runner request failed.",
      },
    };

    expect(JSON.parse(await rawRequest(filename, "not-json\n"))).toEqual(
      expected,
    );
    expect(
      JSON.parse(
        await rawRequest(
          filename,
          Buffer.alloc(EXTERNAL_AGENT_RUNNER_MAX_MESSAGE_BYTES + 1, 0x78),
        ),
      ),
    ).toEqual(expected);
    const failed = await rawRequest(
      filename,
      `${JSON.stringify({ operation: "turn", ...turnInput() })}\n`,
    );
    expect(JSON.parse(failed)).toEqual(expected);
    expect(failed).not.toMatch(/credential|secret|\/var\/lib|stack/iu);
    expect(await failureOf(client.turn(turnInput()))).toMatchObject({
      code: "AI_EXTERNAL_AGENT_RUNNER_FAILED",
      message: "The external agent runner request failed.",
    });
    await expect.poll(() => harness.registry.entries.size).toBe(0);
    expect(harness.runners.every((runner) => runner.closed)).toBe(true);
  });

  it("recovers only an owned stale socket and rejects an active one", async function () {
    const root = await temporaryRoot();
    const filename = await socketFilename(root);
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const n=require('node:net').createServer();n.listen(process.argv[1],()=>process.stdout.write('ready\\n'))",
        filename,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("error", reject);
      child.once("exit", () => reject(new Error("fixture exited early")));
    });

    const activeHarness = fakeHarness();
    expect(
      await failureOf(
        listenExternalAgentRunnerService({
          socketPath: filename,
          runnerFactory: activeHarness.runnerFactory,
          registry: activeHarness.registry,
          workspaceTurn: activeHarness.workspaceTurn,
        }),
      ),
    ).toMatchObject({ message: expect.stringContaining("already active") });

    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    expect((await Fs.promises.lstat(filename)).isSocket()).toBe(true);

    const recovered = await listenExternalAgentRunnerService({
      socketPath: filename,
      runnerFactory: activeHarness.runnerFactory,
      registry: activeHarness.registry,
      workspaceTurn: activeHarness.workspaceTurn,
    });
    services.push(recovered);
    expect((await Fs.promises.lstat(filename)).isSocket()).toBe(true);
  });
});
