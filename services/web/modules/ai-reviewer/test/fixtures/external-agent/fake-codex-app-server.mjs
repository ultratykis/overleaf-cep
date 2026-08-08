#!/usr/bin/env node

import { spawn } from "node:child_process";
import Readline from "node:readline";

const argv = process.argv.slice(2);
const scenarioIndex = argv.indexOf("--scenario");
const scenario = (name) =>
  argv.includes(`--${name}`) ||
  argv.includes(`--scenario=${name}`) ||
  argv[scenarioIndex + 1] === name;

if (scenario("ignore-sigterm") || scenario("sigterm-ignore")) {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 60_000);
}

if (scenario("orphan-child")) {
  spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], {
    stdio: "ignore",
  }).unref();
}

const threads = new Map();
const approvals = new Map();
let nextThread = 1;
let nextTurn = 1;
let activeTurn;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ id, result: value });
}

function error(id, message) {
  send({ id, error: { code: -32_000, message } });
}

function fixtureAssertion(condition, message) {
  if (!condition) {
    process.stderr.write(`fixture assertion failed: ${message}\n`);
    process.exit(2);
  }
}

function assertThreadParams(params) {
  const provider = params.config?.model_providers?.["overleaf-ai-reviewer"];
  const credential = process.env.OVERLEAF_AI_REVIEWER_PROVIDER_KEY;
  fixtureAssertion(!Object.hasOwn(params, "environments"), "environments");
  fixtureAssertion(params.approvalPolicy === "never", "approval policy");
  fixtureAssertion(params.sandbox === "danger-full-access", "thread sandbox");
  fixtureAssertion(params.allowProviderModelFallback === false, "fallback");
  fixtureAssertion(
    params.runtimeWorkspaceRoots?.length === 1 &&
      params.runtimeWorkspaceRoots[0] === params.cwd,
    "thread workspace root",
  );
  fixtureAssertion(params.config?.project_doc_max_bytes === 0, "AGENTS size");
  fixtureAssertion(
    params.config?.features?.enable_request_compression === false,
    "request compression",
  );
  fixtureAssertion(
    params.config?.project_doc_fallback_filenames?.length === 0,
    "AGENTS fallback",
  );
  fixtureAssertion(
    params.config?.skills?.include_instructions === false,
    "skills instructions",
  );
  fixtureAssertion(
    params.config?.shell_environment_policy?.inherit === "none",
    "shell environment",
  );
  fixtureAssertion(provider?.request_max_retries === 0, "request retries");
  fixtureAssertion(provider?.stream_max_retries === 0, "stream retries");
  fixtureAssertion(
    credential == null
      ? !Object.hasOwn(provider, "env_key")
      : provider?.env_key === "OVERLEAF_AI_REVIEWER_PROVIDER_KEY" &&
          !JSON.stringify(params).includes(credential),
    "provider credential",
  );
}

function assertTurnParams(params) {
  fixtureAssertion(!Object.hasOwn(params, "environments"), "turn environments");
  fixtureAssertion(params.approvalPolicy === "never", "turn approval policy");
  fixtureAssertion(
    params.runtimeWorkspaceRoots?.length === 1 &&
      params.runtimeWorkspaceRoots[0] === params.cwd,
    "turn workspace root",
  );
  fixtureAssertion(
    params.sandboxPolicy?.type === "externalSandbox" &&
      params.sandboxPolicy.networkAccess === "restricted" &&
      Object.keys(params.sandboxPolicy).length === 2,
    "turn sandbox",
  );
}

function ensureThread(id, params = {}) {
  if (!threads.has(id)) {
    threads.set(id, {
      id,
      cwd: params.cwd ?? process.cwd(),
      model: params.model ?? "fixture-model",
      modelProvider: params.modelProvider ?? "fixture-provider",
      turns: [],
    });
  }
  const thread = threads.get(id);
  thread.cwd = params.cwd ?? thread.cwd;
  thread.model = params.model ?? thread.model;
  thread.modelProvider = params.modelProvider ?? thread.modelProvider;
  return thread;
}

function threadValue(thread, includeTurns = false) {
  return {
    cliVersion: "0.146.0",
    createdAt: 1,
    cwd: thread.cwd,
    ephemeral: false,
    id: thread.id,
    modelProvider: thread.modelProvider,
    preview: "",
    sessionId: thread.id,
    source: "appServer",
    status: { type: "idle" },
    turns: includeTurns ? thread.turns : [],
    updatedAt: 1,
  };
}

function threadResult(thread) {
  return {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    cwd: thread.cwd,
    instructionSources: [],
    model: thread.model,
    modelProvider: thread.modelProvider,
    sandbox: {
      type: "dangerFullAccess",
    },
    runtimeWorkspaceRoots: [],
    thread: threadValue(thread),
  };
}

function finishTurn(status = "completed") {
  if (!activeTurn) return;
  const { thread, turn } = activeTurn;
  const completed = { ...turn, status };
  thread.turns.push(completed);
  activeTurn = undefined;
  send({
    method: "turn/completed",
    params: { threadId: thread.id, turn: completed },
  });
}

function finishSuccessfulTurn() {
  if (!activeTurn) return;
  send({
    method: "item/agentMessage/delta",
    params: {
      threadId: activeTurn.thread.id,
      turnId: activeTurn.turn.id,
      itemId: `fixture-message-${activeTurn.turn.id}`,
      delta: "fixture response",
    },
  });
  finishTurn();
}

function finishThenSendLateDelta() {
  if (!activeTurn) return;
  const { thread, turn } = activeTurn;
  finishTurn();
  send({
    method: "item/agentMessage/delta",
    params: {
      threadId: thread.id,
      turnId: turn.id,
      itemId: `fixture-late-message-${turn.id}`,
      delta: "late fixture response",
    },
  });
}

function requestApprovals(thread, turn) {
  for (const [kind, method] of [
    ["command", "item/commandExecution/requestApproval"],
    ["file", "item/fileChange/requestApproval"],
  ]) {
    const id = `approval-${kind}-${turn.id}`;
    approvals.set(id, false);
    send({
      id,
      method,
      params: {
        itemId: `item-${kind}-${turn.id}`,
        startedAtMs: 1,
        threadId: thread.id,
        turnId: turn.id,
      },
    });
  }
}

function handleApproval(message) {
  if (!approvals.has(message.id)) return false;
  if (message.result?.decision !== "cancel") {
    process.stderr.write("fixture expected approval denial\n");
    process.exit(2);
  }
  approvals.set(message.id, true);
  if ([...approvals.values()].every(Boolean)) finishTurn();
  return true;
}

function handleRequest(message) {
  const params = message.params ?? {};

  switch (message.method) {
    case "initialize":
      result(message.id, {
        codexHome: process.env.CODEX_HOME ?? process.cwd(),
        platformFamily: "unix",
        platformOs: "linux",
        userAgent: "fake-codex-app-server/0.146.0",
      });
      break;
    case "initialized":
      break;
    case "thread/start": {
      assertThreadParams(params);
      const thread = ensureThread(`fixture-thread-${nextThread++}`, params);
      result(message.id, threadResult(thread));
      break;
    }
    case "thread/resume": {
      assertThreadParams(params);
      const thread = ensureThread(params.threadId, params);
      result(message.id, threadResult(thread));
      break;
    }
    case "thread/read": {
      const thread = ensureThread(params.threadId, params);
      result(message.id, {
        thread: threadValue(thread, params.includeTurns === true),
      });
      break;
    }
    case "thread/archive":
      ensureThread(params.threadId);
      result(message.id, {});
      break;
    case "thread/unarchive": {
      const thread = ensureThread(params.threadId);
      result(message.id, { thread: threadValue(thread) });
      break;
    }
    case "thread/delete":
      if (!threads.delete(params.threadId)) {
        send({
          id: message.id,
          error: {
            code: -32600,
            message: `no rollout found for thread id ${params.threadId}`,
          },
        });
        break;
      }
      result(
        message.id,
        scenario("malformed-delete") ? { unexpected: true } : {},
      );
      send({
        method: "thread/deleted",
        params: { threadId: params.threadId },
      });
      break;
    case "turn/start": {
      assertTurnParams(params);
      const thread = ensureThread(params.threadId, params);
      const turn = {
        id: `fixture-turn-${nextTurn++}`,
        items: [],
        status: "inProgress",
      };
      activeTurn = { thread, turn };
      result(message.id, { turn });

      if (scenario("exit")) {
        setImmediate(() => process.exit(17));
      } else if (scenario("malformed-json")) {
        process.stdout.write('{"method":\n');
      } else if (scenario("approval")) {
        requestApprovals(thread, turn);
      } else if (scenario("late-delta")) {
        setImmediate(finishThenSendLateDelta);
      } else if (!scenario("missing-terminal")) {
        setImmediate(finishSuccessfulTurn);
      }
      break;
    }
    case "turn/interrupt":
      result(message.id, {});
      if (!scenario("missing-terminal")) {
        setImmediate(() => finishTurn("interrupted"));
      }
      break;
    case "thread/backgroundTerminals/clean":
      if (scenario("cleanup-failure")) {
        error(message.id, "fixture cleanup failure");
      } else {
        result(message.id, {});
      }
      break;
    case "thread/backgroundTerminals/list":
      result(message.id, {
        data: scenario("cleanup-failure")
          ? [
              {
                command: "fixture-background-command",
                cwd: process.cwd(),
                itemId: "fixture-background-item",
                processId: "fixture-background-process",
              },
            ]
          : [],
        nextCursor: null,
      });
      break;
    default:
      error(message.id, `unsupported fixture method: ${message.method}`);
  }
}

Readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    process.stderr.write("fixture received malformed JSON\n");
    process.exit(2);
  }
  if (!handleApproval(message)) handleRequest(message);
});
