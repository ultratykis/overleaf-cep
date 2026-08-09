import { spawn } from "node:child_process";
import Fs from "node:fs";
import Http from "node:http";
import Os from "node:os";
import Path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CODEX_APP_SERVER_VERSION,
  createCodexAppServerRegistry,
  createCodexAppServerRunner,
  hasCodexAppServerState,
  removeCodexAppServerState,
  runCodexAppServerWorkspaceTurn,
} from "../../../app/src/CodexAppServerRunner.mjs";
import { createExternalAgentHistorySnapshot } from "../../../app/src/ExternalAgentWorkspace.mjs";

const TEST_DIRECTORY = Path.dirname(fileURLToPath(import.meta.url));
const WEB_DIRECTORY = Path.resolve(TEST_DIRECTORY, "../../../../..");
const FIXTURE = Path.resolve(
  TEST_DIRECTORY,
  "../../fixtures/external-agent/fake-codex-app-server.mjs",
);
const CONTRACT = Path.resolve(
  TEST_DIRECTORY,
  "../../fixtures/external-agent/codex-app-server-0.146.0-contract.json",
);
const temporaryRoots = [];
const runners = [];
const servers = [];
const realCodexIt =
  process.platform === "linux" &&
  process.arch === "x64" &&
  process.env.OVERLEAF_AI_REVIEWER_REAL_CODEX_TEST === "1"
    ? it
    : it.skip;

async function temporaryRoot() {
  const root = await Fs.promises.mkdtemp(
    Path.join(Os.tmpdir(), "ai-reviewer-app-server-test-"),
  );
  temporaryRoots.push(root);
  return root;
}

async function directory(root, name) {
  const result = Path.join(root, name);
  await Fs.promises.mkdir(result, { recursive: true });
  return result;
}

async function workDirectory(root, name) {
  return await directory(
    await directory(await directory(root, "work-root"), "fixture-session"),
    name,
  );
}

async function runner(root, scenario, overrides = {}) {
  const result = await createCodexAppServerRunner({
    stateRootKey: "fixture-session",
    stateRootDirectory: await directory(root, "state-root"),
    workRootDirectory: await directory(root, "work-root"),
    destination: {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:34567/v1",
      model: "fixture-model",
    },
    command: process.execPath,
    args: [FIXTURE, ...(scenario == null ? [] : [`--${scenario}`])],
    limits: {
      controlTimeoutMs: 200,
      interruptGraceMs: 25,
      exitGraceMs: 25,
    },
    ...overrides,
  });
  runners.push(result);
  return result;
}

function processExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

function processGroupExists(pid) {
  if (process.platform === "linux") {
    for (const entry of Fs.readdirSync("/proc")) {
      if (!/^[0-9]+$/u.test(entry)) continue;
      let stat;
      try {
        stat = Fs.readFileSync(`/proc/${entry}/stat`, "utf8");
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        throw error;
      }
      const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
      if (fields[0] !== "Z" && Number(fields[2]) === pid) return true;
    }
    return false;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}

async function waitFor(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function failureOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to fail");
}

function historySnapshot(text = "Original text") {
  return createExternalAgentHistorySnapshot({
    projectId: "project-app-server-test",
    historyVersion: 12,
    rawSnapshot: {
      files: { "main.tex": { content: text } },
      projectVersion: "12.4",
      v2DocVersions: {
        "document-main": { pathname: "main.tex", v: 6 },
      },
      timestamp: "2026-08-07T00:00:00.000Z",
    },
  });
}

function responseObject(id, output = []) {
  return {
    id,
    object: "response",
    created_at: 1,
    status: "completed",
    model: "gpt-5.4",
    output,
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
    usage: {
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 1,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 2,
    },
  };
}

function sendResponseEvents(response, events) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    connection: "close",
  });
  for (const event of events) {
    response.write(`event: ${event.type}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

async function isolationProvider(command) {
  const requests = [];
  let count = 0;
  const server = Http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    requests.push({
      authorization: request.headers.authorization,
      contentEncoding: request.headers["content-encoding"],
      host: request.headers.host,
      method: request.method,
      path: request.url,
      body: JSON.parse(body.toString("utf8")),
    });
    count += 1;
    if (count === 1) {
      const call = {
        type: "function_call",
        id: "fixture-isolation-call",
        call_id: "fixture-isolation-call",
        name: "exec_command",
        status: "completed",
        arguments: JSON.stringify({
          cmd: command,
          yield_time_ms: 10_000,
          max_output_tokens: 1_000,
        }),
      };
      const completed = responseObject("fixture-tool-response", [call]);
      sendResponseEvents(response, [
        {
          type: "response.created",
          response: { ...completed, status: "in_progress", output: [] },
        },
        { type: "response.output_item.added", output_index: 0, item: call },
        { type: "response.output_item.done", output_index: 0, item: call },
        { type: "response.completed", response: completed },
      ]);
      return;
    }
    const message = {
      type: "message",
      id: "fixture-isolation-message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: "outer isolation complete",
          annotations: [],
        },
      ],
    };
    const completed = responseObject("fixture-final-response", [message]);
    sendResponseEvents(response, [
      {
        type: "response.created",
        response: { ...completed, status: "in_progress", output: [] },
      },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: message,
      },
      {
        type: "response.output_text.delta",
        item_id: message.id,
        output_index: 0,
        content_index: 0,
        delta: "outer isolation complete",
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: message,
      },
      { type: "response.completed", response: completed },
    ]);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (address == null || typeof address === "string") {
    throw new Error("fixture provider did not listen");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
  };
}

afterEach(async function () {
  await Promise.all(runners.splice(0).map((runner) => runner.close()));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve);
        }),
    ),
  );
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => Fs.promises.rm(root, { recursive: true, force: true })),
  );
});

describe("pinned Codex App Server runner", function () {
  it("pins the aged package and the deliberately small protocol surface", async function () {
    const contract = JSON.parse(await Fs.promises.readFile(CONTRACT, "utf8"));
    const packageJson = JSON.parse(
      await Fs.promises.readFile(
        Path.join(WEB_DIRECTORY, "package.json"),
        "utf8",
      ),
    );
    const lock = await Fs.promises.readFile(
      Path.resolve(WEB_DIRECTORY, "../../yarn.lock"),
      "utf8",
    );

    expect(CODEX_APP_SERVER_VERSION).toBe("0.146.0");
    expect(packageJson.dependencies["@openai/codex"]).toBe("0.146.0");
    expect(contract.package).toMatchObject({
      version: "0.146.0",
      registryIntegrity:
        "sha512-yG3sPWNda/2YAIQIDq9MrrjoCTIQ7rxYM5IasrG3VBcuhCLTkgeg/JzqmJq1V98RE4MJ5jCxDXXQlOjrditFRw==",
      yarnChecksum:
        "10c0/3e6cf877683904211f66d769d5a25a28eedc17341aaa98718b08097a26eb2c368b282589f5f6a5372659dad8d176db4b6229b784bfe34807b1094dabdacfd9b5",
    });
    expect(Object.keys(contract.clientRequests)).toEqual([
      "initialize",
      "thread/start",
      "thread/resume",
      "thread/read",
      "thread/archive",
      "thread/unarchive",
      "thread/delete",
      "turn/start",
      "turn/interrupt",
      "thread/backgroundTerminals/clean",
      "thread/backgroundTerminals/list",
    ]);
    expect(contract.excludedMethods).toEqual(["thread/fork"]);
    expect(contract.securityInvariants).toEqual({
      environments: "omitted",
      projectDocMaxBytes: 0,
      projectDocFallbackFilenames: [],
      skillInstructions: false,
      requestCompression: false,
      providerEndpoints: "configured-http-or-https",
      providerCredentials: "https-env-key-only",
      providerRequestRetries: 0,
      providerStreamRetries: 0,
      processIsolation: "outer-bundled-bwrap",
      sessionFilesystem: "state-work-bind-fd-only",
      outerNetworkNamespace: "shared-provider-network",
      threadSandbox: "danger-full-access",
      turnSandbox: "externalSandbox",
      turnNetworkAccess: "restricted",
    });
    expect(lock).toContain('"@openai/codex@npm:0.146.0"');
    expect(lock).toContain(`checksum: ${contract.package.yarnChecksum}`);
  });

  it("runs the exact lifecycle with isolated environment and no Git", async function () {
    const root = await temporaryRoot();
    const work = await workDirectory(root, "work");
    let childEnvironment;
    let childCommand;
    let childStdio;
    const appServer = await runner(root, null, {
      environment: {
        ...process.env,
        UNRELATED_SECRET: "must-not-cross-the-process-boundary",
        HTTPS_PROXY: "http://proxy-user:proxy-password@fixture.invalid",
      },
      spawnProcess(command, args, options) {
        childCommand = command;
        childEnvironment = options.env;
        childStdio = options.stdio;
        return spawn(command, args, options);
      },
    });
    const pid = appServer.pid;

    const threadId = await appServer.startThread(work);
    expect(appServer.hasThread(threadId)).toBe(true);
    expect(appServer.hasThread("not-this-thread")).toBe(false);
    const turn = await appServer.runTurn({
      threadId,
      workDirectory: work,
      prompt: "Review the document.",
    });
    expect(turn).toMatchObject({ threadId, text: "fixture response" });
    expect((await appServer.readThread(threadId)).id).toBe(threadId);
    await appServer.archiveThread(threadId);
    expect(appServer.hasThread(threadId)).toBe(false);
    await appServer.unarchiveThread(threadId);
    await appServer.deleteThread(threadId);
    await appServer.deleteThread(threadId);
    expect(appServer.hasThread(threadId)).toBe(false);
    expect(
      (
        await Fs.promises.lstat(
          Path.join(root, "state-root", "fixture-session"),
        )
      ).mode & 0o077,
    ).toBe(0);
    expect(
      (await Fs.promises.lstat(appServer.workRootDirectory)).mode & 0o077,
    ).toBe(0);
    expect(
      (await Fs.promises.lstat(appServer.baselineRootDirectory)).mode & 0o077,
    ).toBe(0);
    expect(childEnvironment).toMatchObject({
      CODEX_HOME: Path.join(root, "state-root", "fixture-session"),
      HOME: Path.join(root, "state-root", "fixture-session"),
    });
    expect(childEnvironment).not.toHaveProperty("UNRELATED_SECRET");
    expect(childEnvironment).not.toHaveProperty("HTTPS_PROXY");
    expect(childEnvironment).not.toHaveProperty(
      "OVERLEAF_AI_REVIEWER_PROVIDER_KEY",
    );
    expect(childCommand).toBe(process.execPath);
    expect(childStdio).toEqual(["pipe", "pipe", "pipe"]);
    const outsideState = Path.join(root, "outside-state");
    const stateLink = Path.join(appServer.stateDirectory, "state-link");
    await Promise.all([
      Fs.promises.writeFile(
        Path.join(appServer.stateDirectory, "state-bytes-fixture"),
        "state",
      ),
      Fs.promises.writeFile(outsideState, "must-not-be-counted"),
    ]);
    await Fs.promises.symlink(outsideState, stateLink);
    expect(await appServer.measureStateBytes()).toBe(
      5 + (await Fs.promises.lstat(stateLink)).size,
    );
    expect(
      await Fs.promises
        .access(Path.join(work, ".git"))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);

    await appServer.close();
    expect(processExists(pid)).toBe(false);
    expect(
      await Fs.promises
        .access(Path.join(root, "work-root", "fixture-session"))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
    expect(
      await Fs.promises
        .access(Path.join(root, "work-root", ".base_fixture-session"))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
  });

  it("rejects a malformed thread/delete result", async function () {
    const root = await temporaryRoot();
    const appServer = await runner(root, "malformed-delete");
    const threadId = await appServer.startThread(
      await workDirectory(root, "delete-work"),
    );

    expect(await failureOf(appServer.deleteThread(threadId))).toMatchObject({
      code: "AI_CODEX_APP_SERVER_PROTOCOL_ERROR",
    });
  });

  it("removes only a canonical private state directory without following links", async function () {
    const root = await temporaryRoot();
    const stateRoot = await directory(root, "state-root");
    const sessionState = await directory(stateRoot, "fixture-session");
    const siblingState = await directory(stateRoot, "sibling-session");
    const outside = await directory(root, "outside");
    await Promise.all(
      [stateRoot, sessionState, siblingState, outside].map((path) =>
        Fs.promises.chmod(path, 0o700),
      ),
    );
    const siblingMarker = Path.join(siblingState, "keep");
    const outsideMarker = Path.join(outside, "keep");
    await Promise.all([
      Fs.promises.writeFile(siblingMarker, "sibling"),
      Fs.promises.writeFile(outsideMarker, "outside"),
      Fs.promises.symlink(outsideMarker, Path.join(sessionState, "link")),
    ]);

    const options = {
      stateRootKey: "fixture-session",
      stateRootDirectory: stateRoot,
    };
    expect(await hasCodexAppServerState(options)).toBe(true);
    expect(await removeCodexAppServerState(options)).toBe(true);
    expect(await hasCodexAppServerState(options)).toBe(false);
    expect(await removeCodexAppServerState(options)).toBe(false);
    expect(await Fs.promises.readFile(siblingMarker, "utf8")).toBe("sibling");
    expect(await Fs.promises.readFile(outsideMarker, "utf8")).toBe("outside");
    expect(Fs.existsSync(stateRoot)).toBe(true);

    await Fs.promises.symlink(outside, Path.join(stateRoot, "linked-session"));
    expect(
      await failureOf(
        removeCodexAppServerState({
          stateRootKey: "linked-session",
          stateRootDirectory: stateRoot,
        }),
      ),
    ).toMatchObject({ message: "The Codex state directory is invalid." });
    expect(
      await failureOf(
        removeCodexAppServerState({
          stateRootKey: "../outside",
          stateRootDirectory: stateRoot,
        }),
      ),
    ).toMatchObject({ message: "stateRootKey is invalid." });
    expect(await Fs.promises.readFile(outsideMarker, "utf8")).toBe("outside");
  });

  realCodexIt(
    "isolates the real App Server and deletes its thread without provider credentials",
    async function () {
      const root = await temporaryRoot();
      const stateRoot = await directory(root, "state-root");
      const workRoot = await directory(root, "work-root");
      const siblingState = await directory(stateRoot, "sibling-state");
      const siblingWork = await directory(workRoot, "sibling-work");
      const siblingStateMarker = Path.join(siblingState, "secret");
      const siblingWorkMarker = Path.join(siblingWork, "secret");
      await Promise.all([
        Fs.promises.writeFile(siblingStateMarker, "state-secret", {
          mode: 0o600,
        }),
        Fs.promises.writeFile(siblingWorkMarker, "work-secret", {
          mode: 0o600,
        }),
      ]);
      const sessionWork = Path.join(workRoot, "fixture-session");
      const baseline = Path.join(workRoot, ".base_fixture-session");
      const ownMarker = Path.join(sessionWork, "own-marker");
      const baselineMarker = Path.join(baseline, "secret");
      const command = [
        "sibling_state=absent",
        `test -r '${siblingStateMarker}' && sibling_state=visible`,
        "sibling_work=absent",
        `test -r '${siblingWorkMarker}' && sibling_work=visible`,
        "baseline=absent",
        `test -r '${baselineMarker}' && baseline=visible`,
        "secret=absent",
        'for file in /proc/[0-9]*/environ; do [ -e "$file" ] || continue; grep -zq \'^OUTER_PROCESS_SECRET=\' "$file" 2>/dev/null && secret=visible && break; done',
        "proc=empty",
        'for process in /proc/[0-9]*; do [ -e "$process" ] || continue; proc=visible; break; done',
        "own=failed",
        `printf own > '${ownMarker}' && own=written`,
        'printf \'sibling_state=%s sibling_work=%s baseline=%s secret=%s proc=%s own=%s\\n\' "$sibling_state" "$sibling_work" "$baseline" "$secret" "$proc" "$own"',
      ].join("; ");
      const provider = await isolationProvider(command);
      const appServer = await createCodexAppServerRunner({
        stateRootKey: "fixture-session",
        stateRootDirectory: stateRoot,
        workRootDirectory: workRoot,
        destination: {
          provider: "openai-compatible",
          baseUrl: provider.baseUrl,
          model: "gpt-5.4",
        },
        environment: {
          ...process.env,
          OUTER_PROCESS_SECRET: "must-not-be-readable",
        },
      });
      runners.push(appServer);
      await Fs.promises.writeFile(baselineMarker, "baseline-secret", {
        mode: 0o600,
      });
      const pid = appServer.pid;
      const work = await directory(appServer.workRootDirectory, "turn");
      const threadId = await appServer.startThread(work);
      const turn = await appServer.runTurn({
        threadId,
        workDirectory: work,
        prompt: "Run the isolation fixture.",
      });

      expect(turn.text).toBe("outer isolation complete");
      expect(appServer.hasThread(threadId)).toBe(true);
      expect(await Fs.promises.readFile(ownMarker, "utf8")).toBe("own");
      expect(provider.requests).toHaveLength(2);
      expect(
        provider.requests.every(
          (request) =>
            request.host === new URL(provider.baseUrl).host &&
            request.method === "POST" &&
            request.path === "/v1/responses" &&
            request.authorization == null &&
            request.contentEncoding == null,
        ),
      ).toBe(true);
      const toolOutput = provider.requests[1].body.input.find(
        (item) => item.type === "function_call_output",
      )?.output;
      expect(toolOutput).toContain(
        "sibling_state=absent sibling_work=absent baseline=absent secret=absent proc=empty own=written",
      );

      await appServer.close();
      expect(processGroupExists(pid)).toBe(false);
      expect(Fs.existsSync(sessionWork)).toBe(false);
      expect(Fs.existsSync(baseline)).toBe(false);
      expect(Fs.existsSync(Path.join(stateRoot, "fixture-session"))).toBe(true);

      const deleteRunner = await createCodexAppServerRunner({
        stateRootKey: "fixture-session",
        stateRootDirectory: stateRoot,
        workRootDirectory: workRoot,
      });
      runners.push(deleteRunner);
      const deletePid = deleteRunner.pid;
      expect(deleteRunner.destination).toBeNull();
      await deleteRunner.deleteThread(threadId);
      await deleteRunner.deleteThread(threadId);
      await deleteRunner.close();
      expect(processGroupExists(deletePid)).toBe(false);
      expect(provider.requests).toHaveLength(2);
      expect(
        await removeCodexAppServerState({
          stateRootKey: "fixture-session",
          stateRootDirectory: stateRoot,
        }),
      ).toBe(true);
      expect(Fs.existsSync(Path.join(stateRoot, "fixture-session"))).toBe(
        false,
      );
      expect(await Fs.promises.readFile(siblingStateMarker, "utf8")).toBe(
        "state-secret",
      );
    },
    30_000,
  );

  it("passes one HTTPS-local credential by env_key without argv or state plaintext", async function () {
    const root = await temporaryRoot();
    const credential = "synthetic-user-a-key";
    let childArguments;
    let childEnvironment;
    const spawnProcess = vi.fn((command, args, options) => {
      childArguments = args;
      childEnvironment = options.env;
      return spawn(process.execPath, [FIXTURE], options);
    });
    const appServer = await createCodexAppServerRunner({
      stateRootKey: "credential-test",
      stateRootDirectory: await directory(root, "state-root"),
      workRootDirectory: await directory(root, "work-root"),
      destination: {
        provider: "openai-compatible",
        baseUrl: "https://localhost:8443/v1",
        model: "fixture-model",
        credential,
      },
      environment: {
        ...process.env,
        ANOTHER_PROVIDER_KEY: "must-not-cross",
      },
      spawnProcess,
    });
    runners.push(appServer);

    const work = await directory(appServer.workRootDirectory, "turn");
    await appServer.startThread(work);

    expect(childEnvironment).toMatchObject({
      OVERLEAF_AI_REVIEWER_PROVIDER_KEY: credential,
    });
    expect(
      Object.entries(childEnvironment).filter(
        ([, value]) => value === credential,
      ),
    ).toEqual([["OVERLEAF_AI_REVIEWER_PROVIDER_KEY", credential]]);
    expect(childEnvironment).not.toHaveProperty("ANOTHER_PROVIDER_KEY");
    expect(JSON.stringify(childArguments)).not.toContain(credential);
    expect(appServer.destination).toEqual({
      baseUrl: "https://localhost:8443/v1",
      model: "fixture-model",
      credentialPresent: true,
    });
    expect(JSON.stringify(appServer.destination)).not.toContain(credential);

    await appServer.close();
    expect(
      await Fs.promises.readdir(
        Path.join(root, "state-root", "credential-test"),
      ),
    ).toEqual([]);
  });

  it("rejects an HTTP credential before starting a process", async function () {
    const root = await temporaryRoot();
    const spawnProcess = vi.fn();

    expect(
      await failureOf(
        createCodexAppServerRunner({
          stateRootKey: "credential-test",
          stateRootDirectory: await directory(root, "state-root"),
          workRootDirectory: await directory(root, "work-root"),
          destination: {
            provider: "openai-compatible",
            baseUrl: "http://127.0.0.1:8443/v1",
            model: "fixture-model",
            credential: "must-not-reach-a-process",
          },
          command: process.execPath,
          args: [FIXTURE],
          spawnProcess,
        }),
      ),
    ).toMatchObject({
      code: "AI_PROVIDER_PLAINTEXT_CREDENTIAL_BLOCKED",
    });
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(
      Fs.existsSync(Path.join(root, "state-root", "credential-test")),
    ).toBe(false);
    expect(Fs.existsSync(Path.join(root, "work-root", "credential-test"))).toBe(
      false,
    );
  });

  it("accepts a remote HTTPS provider", async function () {
    const root = await temporaryRoot();
    const appServer = await runner(root, "remote-provider", {
      destination: {
        provider: "openai-compatible",
        baseUrl: "https://fixture.example/v1",
        model: "fixture-model",
      },
    });

    expect(appServer.destination).toEqual({
      baseUrl: "https://fixture.example/v1",
      model: "fixture-model",
      credentialPresent: false,
    });
    await appServer.startThread(await workDirectory(root, "remote-work"));
  });

  it("rejects overlapping state and work roots before starting a process", async function () {
    const root = await temporaryRoot();
    const sharedRoot = await directory(root, "shared-root");
    const nestedWorkRoot = await directory(sharedRoot, "work-root");
    const spawnProcess = vi.fn();

    expect(
      await failureOf(
        createCodexAppServerRunner({
          stateRootKey: "overlap-test",
          stateRootDirectory: sharedRoot,
          workRootDirectory: nestedWorkRoot,
          command: process.execPath,
          args: [FIXTURE],
          spawnProcess,
        }),
      ),
    ).toMatchObject({
      message: "The Codex state and work roots must be disjoint.",
    });
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("uses and removes a fresh non-Git workspace for every turn", async function () {
    const root = await temporaryRoot();
    const appServer = await runner(root, null);
    const workRoot = appServer.workRootDirectory;

    const first = await runCodexAppServerWorkspaceTurn({
      runner: appServer,
      snapshot: historySnapshot(),
      prompt: "First turn.",
    });
    expect(first).toMatchObject({
      changes: { edits: [] },
      stateBytes: 0,
    });
    expect(await Fs.promises.readdir(workRoot)).toEqual([]);

    await runCodexAppServerWorkspaceTurn({
      runner: appServer,
      snapshot: historySnapshot("New checkpoint"),
      prompt: "Second turn.",
      threadId: first.threadId,
    });
    expect(await Fs.promises.readdir(workRoot)).toEqual([]);
    expect(appServer.healthy).toBe(true);
  });

  it("removes the turn workspace after a protocol failure", async function () {
    const root = await temporaryRoot();
    const appServer = await runner(root, "malformed-json");

    expect(
      await failureOf(
        runCodexAppServerWorkspaceTurn({
          runner: appServer,
          snapshot: historySnapshot(),
          prompt: "Fail this turn.",
        }),
      ),
    ).toMatchObject({ code: "AI_CODEX_APP_SERVER_PROTOCOL_ERROR" });
    expect(await Fs.promises.readdir(Path.join(root, "work-root"))).toEqual([]);
    expect(appServer.healthy).toBe(false);
  });

  it("keeps work and baseline evidence when process cleanup is unconfirmed", async function () {
    const root = await temporaryRoot();
    const appServer = await runner(root, "malformed-json");
    const close = appServer.close.bind(appServer);
    appServer.close = vi.fn(async () => {
      throw new Error("fixture cleanup could not be confirmed");
    });

    expect(
      await failureOf(
        runCodexAppServerWorkspaceTurn({
          runner: appServer,
          snapshot: historySnapshot(),
          prompt: "Fail without cleanup confirmation.",
        }),
      ),
    ).toMatchObject({ code: "AI_CODEX_APP_SERVER_CLEANUP_FAILED" });
    expect(await Fs.promises.readdir(appServer.workRootDirectory)).not.toEqual(
      [],
    );
    expect(
      await Fs.promises.readdir(appServer.baselineRootDirectory),
    ).not.toEqual([]);

    appServer.close = close;
    await appServer.close();
  });

  it("reuses one active process, idles it, and resumes from the same state in a new process", async function () {
    const root = await temporaryRoot();
    const registry = createCodexAppServerRegistry({ idleTimeoutMs: 30 });
    const start = () => runner(root, null);
    const first = await registry.acquire("session-key", "connection-a", start);
    const firstPid = first.pid;
    const firstWork = await workDirectory(root, "work-1");
    const threadId = await first.startThread(firstWork);
    await first.runTurn({
      threadId,
      workDirectory: firstWork,
      prompt: "First turn.",
    });
    await registry.release("session-key");

    const second = await registry.acquire("session-key", "connection-a", start);
    expect(second.pid).toBe(firstPid);
    const secondWork = await workDirectory(root, "work-2");
    await second.runTurn({
      threadId,
      workDirectory: secondWork,
      prompt: "Second turn.",
    });
    await registry.release("session-key");
    await waitFor(() => registry.size === 0);
    expect(processExists(firstPid)).toBe(false);

    const resumed = await registry.acquire(
      "session-key",
      "connection-a",
      start,
    );
    expect(resumed.pid).not.toBe(firstPid);
    expect(resumed.hasThread(threadId)).toBe(false);
    await resumed.resumeThread(
      threadId,
      await workDirectory(root, "work-after-restart"),
    );
    expect(resumed.hasThread(threadId)).toBe(true);

    const otherRoot = await temporaryRoot();
    const other = await registry.acquire("other-session", "connection-b", () =>
      runner(otherRoot, null),
    );
    expect(other.pid).not.toBe(resumed.pid);
    expect(other.stateDirectory).not.toBe(resumed.stateDirectory);
    await registry.closeAll();
    expect(registry.size).toBe(0);
  });

  it("does not forget a registry entry when process cleanup fails", async function () {
    const registry = createCodexAppServerRegistry();
    const cleanupError = new Error("cleanup failed");
    await registry.acquire("session-key", "connection-a", async () => ({
      healthy: true,
      close: async () => {
        throw cleanupError;
      },
    }));

    expect(await failureOf(registry.stop("session-key"))).toBe(cleanupError);
    expect(registry.size).toBe(1);
    expect(
      await failureOf(
        registry.acquire("session-key", "connection-a", async () => {
          throw new Error("must not restart");
        }),
      ),
    ).toBe(cleanupError);
  });

  it.each([
    ["malformed-json", "AI_CODEX_APP_SERVER_PROTOCOL_ERROR"],
    ["late-delta", "AI_CODEX_APP_SERVER_PROTOCOL_ERROR"],
    ["approval", "AI_CODEX_APP_SERVER_APPROVAL_REJECTED"],
    ["exit", "AI_CODEX_APP_SERVER_PROCESS_ERROR"],
    ["cleanup-failure", "AI_CODEX_APP_SERVER_PROTOCOL_ERROR"],
  ])("kills the process after %s", async function (scenario, expectedCode) {
    const root = await temporaryRoot();
    const appServer = await runner(root, scenario);
    const work = await workDirectory(root, "work");
    const threadId = await appServer.startThread(work);
    const pid = appServer.pid;

    expect(
      await failureOf(
        appServer.runTurn({ threadId, workDirectory: work, prompt: "Turn." }),
      ),
    ).toMatchObject({ code: expectedCode });
    expect(appServer.healthy).toBe(false);
    expect(processExists(pid)).toBe(false);
  });

  it("interrupts a missing terminal event on timeout", async function () {
    const root = await temporaryRoot();
    const appServer = await runner(root, "missing-terminal");
    const work = await workDirectory(root, "work");
    const threadId = await appServer.startThread(work);
    const pid = appServer.pid;

    expect(
      await failureOf(
        appServer.runTurn({
          threadId,
          workDirectory: work,
          prompt: "Turn.",
          signal: AbortSignal.timeout(30),
        }),
      ),
    ).toMatchObject({ code: "AI_REQUEST_TIMEOUT" });
    expect(processExists(pid)).toBe(false);
  });

  it("escalates shutdown when the process ignores SIGTERM", async function () {
    const root = await temporaryRoot();
    const appServer = await runner(root, "ignore-sigterm");
    const pid = appServer.pid;

    await appServer.close();

    expect(processExists(pid)).toBe(false);
  });

  it("kills descendants left behind after the wrapper exits", async function () {
    const root = await temporaryRoot();
    const appServer = await runner(root, "orphan-child");
    const pid = appServer.pid;

    await appServer.close();

    expect(processGroupExists(pid)).toBe(false);
  });

  it("rejects work paths outside the private turn root", async function () {
    const root = await temporaryRoot();
    const appServer = await runner(root, null);
    const outside = await directory(root, "outside");
    const link = Path.join(appServer.workRootDirectory, "link");
    await Fs.promises.symlink(outside, link);

    expect(await failureOf(appServer.startThread(outside))).toMatchObject({
      message: "workDirectory escaped its safe root.",
    });
    expect(await failureOf(appServer.startThread(link))).toMatchObject({
      message: "workDirectory escaped its safe root.",
    });
  });
});
