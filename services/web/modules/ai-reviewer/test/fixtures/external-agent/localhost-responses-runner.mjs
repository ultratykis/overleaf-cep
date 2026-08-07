#!/usr/bin/env node

// Toolkit-test fixture: the real App Server and its only model endpoint share
// one network-isolated process/container. It is not a production provider.

import { createHash } from "node:crypto";
import Fs from "node:fs";
import Https from "node:https";
import Path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { listenExternalAgentRunnerService } from "../../../app/src/ExternalAgentRunnerService.mjs";

export const RESPONSES_RECORDER_DEFAULT_PORT = 43119;
export const RESPONSES_RECORDER_MAX_BODY_BYTES = 1024 * 1024;
export const RESPONSES_RECORDER_DEFAULT_OPAQUE_PATH = "synthetic-recorder";

const FIXTURE_DIRECTORY = Path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CERTIFICATE = Path.join(
  FIXTURE_DIRECTORY,
  "synthetic-localhost-cert.pem",
);
const DEFAULT_PRIVATE_KEY = Path.join(
  FIXTURE_DIRECTORY,
  "synthetic-localhost-key.pem",
);
const OPAQUE_RESPONSES_PATH = /^\/[A-Za-z0-9_-]{16,128}\/v1\/responses$/u;
const BEARER = /^Bearer ([A-Za-z0-9._~+/-]{1,512}={0,2})$/iu;
const MARKER_COMMAND =
  "test -z \"${OVERLEAF_AI_REVIEWER_PROVIDER_KEY+x}\" && printf '%s\\n' '% overleaf-ai-reviewer-recorder-marker' >> main.tex";

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requestFailure(statusCode) {
  return Object.assign(new Error("The synthetic request is invalid."), {
    statusCode,
  });
}

function checkedPort(value) {
  const port = typeof value === "string" ? Number(value) : value;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("Responses recorder port is invalid.");
  }
  return port;
}

function requestPath(value) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > 160 ||
    !OPAQUE_RESPONSES_PATH.test(value)
  ) {
    throw requestFailure(404);
  }
  return value;
}

function authorizationSha256(request) {
  const values = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === "authorization") {
      values.push(request.rawHeaders[index + 1]);
    }
  }
  if (values.length === 0) return null;
  if (values.length !== 1 || values[0].length > 520) {
    throw requestFailure(401);
  }
  const match = BEARER.exec(values[0]);
  if (match == null) throw requestFailure(401);
  return sha256(match[1]);
}

async function jsonBody(request) {
  const declaredLength = request.headers["content-length"];
  if (
    (declaredLength != null && !/^(?:0|[1-9][0-9]*)$/u.test(declaredLength)) ||
    Number(declaredLength ?? 0) > RESPONSES_RECORDER_MAX_BODY_BYTES
  ) {
    throw requestFailure(413);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > RESPONSES_RECORDER_MAX_BODY_BYTES) {
      throw requestFailure(413);
    }
    chunks.push(chunk);
  }
  let value;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, bytes),
      ),
    );
  } catch {
    throw requestFailure(400);
  }
  if (
    !isRecord(value) ||
    !Array.isArray(value.input) ||
    value.input.length === 0
  ) {
    throw requestFailure(400);
  }
  return value;
}

function responseObject(id, model, output) {
  return {
    id,
    object: "response",
    created_at: 1,
    status: "completed",
    model,
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

function sendEvents(response, events) {
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

function toolEvents(body, requestHash) {
  const call = {
    type: "function_call",
    id: `fixture-call-${requestHash}`,
    call_id: `fixture-call-${requestHash}`,
    name: "exec_command",
    status: "completed",
    arguments: JSON.stringify({
      cmd: MARKER_COMMAND,
      yield_time_ms: 10_000,
      max_output_tokens: 1_000,
    }),
  };
  const completed = responseObject(
    `fixture-tool-${requestHash}`,
    typeof body.model === "string" ? body.model : "fixture-model",
    [call],
  );
  return [
    {
      type: "response.created",
      response: { ...completed, status: "in_progress", output: [] },
    },
    { type: "response.output_item.added", output_index: 0, item: call },
    { type: "response.output_item.done", output_index: 0, item: call },
    { type: "response.completed", response: completed },
  ];
}

function completedEvents(body, requestHash) {
  const message = {
    type: "message",
    id: `fixture-message-${requestHash}`,
    role: "assistant",
    status: "completed",
    content: [
      {
        type: "output_text",
        text: "Synthetic manuscript edit completed.",
        annotations: [],
      },
    ],
  };
  const completed = responseObject(
    `fixture-completed-${requestHash}`,
    typeof body.model === "string" ? body.model : "fixture-model",
    [message],
  );
  return [
    {
      type: "response.created",
      response: { ...completed, status: "in_progress", output: [] },
    },
    { type: "response.output_item.added", output_index: 0, item: message },
    {
      type: "response.output_text.delta",
      item_id: message.id,
      output_index: 0,
      content_index: 0,
      delta: "Synthetic manuscript edit completed.",
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    { type: "response.completed", response: completed },
  ];
}

function defaultWriteLog(line) {
  process.stdout.write(line);
}

function writeSafeLog(writeLog, path, phase, authSha256) {
  try {
    writeLog(`${JSON.stringify({ path, phase, authSha256 })}\n`);
  } catch {}
}

/**
 * @param {{
 *   port?: number | string,
 *   certificate?: string | Buffer,
 *   privateKey?: string | Buffer,
 *   writeLog?: (line: string) => void,
 * }} [options]
 */
export async function listenResponsesRecorder(options = {}) {
  const port = checkedPort(
    options.port ??
      process.env.OVERLEAF_AI_REVIEWER_RECORDER_PORT ??
      RESPONSES_RECORDER_DEFAULT_PORT,
  );
  const writeLog = options.writeLog ?? defaultWriteLog;
  if (typeof writeLog !== "function") {
    throw new TypeError("Responses recorder logger is invalid.");
  }
  const server = Https.createServer(
    {
      cert: options.certificate ?? Fs.readFileSync(DEFAULT_CERTIFICATE, "utf8"),
      key: options.privateKey ?? Fs.readFileSync(DEFAULT_PRIVATE_KEY, "utf8"),
    },
    async (request, response) => {
      let path = "<invalid>";
      let authSha256 = null;
      try {
        path = requestPath(request.url);
        authSha256 = authorizationSha256(request);
        if (request.method !== "POST") throw requestFailure(405);
        const body = await jsonBody(request);
        const newest = body.input.at(-1);
        const completed =
          isRecord(newest) && newest.type === "function_call_output";
        const requestHash = sha256(JSON.stringify(body)).slice(0, 16);
        writeSafeLog(
          writeLog,
          path,
          completed ? "completed" : "tool",
          authSha256,
        );
        sendEvents(
          response,
          completed
            ? completedEvents(body, requestHash)
            : toolEvents(body, requestHash),
        );
      } catch (error) {
        writeSafeLog(writeLog, path, "rejected", authSha256);
        const statusCode = Number.isSafeInteger(error?.statusCode)
          ? error.statusCode
          : 400;
        response.writeHead(statusCode, {
          "content-type": "application/json",
          connection: "close",
        });
        response.end('{"error":"synthetic request rejected"}\n');
      }
    },
  );
  server.on("clientError", (_error, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
  const address = server.address();
  if (address == null || typeof address === "string") {
    server.close();
    throw new TypeError("Responses recorder did not bind to IPv4 loopback.");
  }
  let closing = null;
  return Object.freeze({
    port: address.port,
    baseUrl(opaquePath = RESPONSES_RECORDER_DEFAULT_OPAQUE_PATH) {
      if (!/^[A-Za-z0-9_-]{16,128}$/u.test(opaquePath)) {
        throw new TypeError("Responses recorder path is invalid.");
      }
      return `https://127.0.0.1:${address.port}/${opaquePath}/v1`;
    },
    close() {
      closing ??= new Promise((resolve, reject) => {
        server.close((error) => (error == null ? resolve() : reject(error)));
        server.closeAllConnections?.();
      });
      return closing;
    },
  });
}

/**
 * @param {{
 *   recorder?: Parameters<typeof listenResponsesRecorder>[0],
 *   runner?: Parameters<typeof listenExternalAgentRunnerService>[0],
 *   listenRunner?: typeof listenExternalAgentRunnerService,
 * }} [options]
 */
export async function listenLocalExternalAgentFixture(options = {}) {
  const recorder = await listenResponsesRecorder(options.recorder);
  let runner;
  try {
    runner = await (options.listenRunner ?? listenExternalAgentRunnerService)(
      options.runner,
    );
  } catch (error) {
    await recorder.close();
    throw error;
  }
  let closing = null;
  return Object.freeze({
    recorder,
    runner,
    close() {
      closing ??= (async () => {
        try {
          await runner.close();
        } finally {
          await recorder.close();
        }
      })();
      return closing;
    },
  });
}

async function main() {
  let fixture;
  try {
    fixture = await listenLocalExternalAgentFixture();
  } catch {
    process.stderr.write(
      `${JSON.stringify({ path: "<service>", phase: "failed", authSha256: null })}\n`,
    );
    process.exitCode = 1;
    return;
  }
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await fixture.close();
    } catch {
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

if (
  process.argv[1] != null &&
  pathToFileURL(Path.resolve(process.argv[1])).href === import.meta.url
) {
  await main();
}
