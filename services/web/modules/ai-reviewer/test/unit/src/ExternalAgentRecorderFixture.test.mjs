import { createHash } from "node:crypto";
import Fs from "node:fs";
import Https from "node:https";
import Path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RESPONSES_RECORDER_MAX_BODY_BYTES,
  listenLocalExternalAgentFixture,
} from "../../fixtures/external-agent/localhost-responses-runner.mjs";

const FIXTURE_DIRECTORY = Path.resolve(
  Path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/external-agent",
);
const CERTIFICATE = Fs.readFileSync(
  Path.join(FIXTURE_DIRECTORY, "synthetic-localhost-cert.pem"),
);
const services = [];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function request(port, { path, method = "POST", authorization, body }) {
  const bytes = Buffer.from(body ?? "");
  return await new Promise((resolve, reject) => {
    const outgoing = Https.request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        ca: CERTIFICATE,
        headers: {
          connection: "close",
          "content-type": "application/json",
          "content-length": bytes.length,
          ...(authorization == null ? {} : { authorization }),
        },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            statusCode: response.statusCode,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    outgoing.on("error", reject);
    outgoing.end(bytes);
  });
}

function eventData(response) {
  return response.body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

afterEach(async function () {
  await Promise.all(services.splice(0).map((service) => service.close()));
});

describe("toolkit-test localhost Responses recorder", function () {
  it("returns the deterministic edit/tool sequence without logging secrets", async function () {
    const lines = [];
    const runner = { close: vi.fn(async () => {}) };
    const listenRunner = vi.fn(async () => runner);
    const service = await listenLocalExternalAgentFixture({
      recorder: { port: 0, writeLog: (line) => lines.push(line) },
      runner: { socketPath: "/synthetic/runner.sock" },
      listenRunner,
    });
    services.push(service);
    expect(listenRunner).toHaveBeenCalledWith({
      socketPath: "/synthetic/runner.sock",
    });

    const path = "/synthetic-user-a/v1/responses";
    const key = "SYNTHETIC_BEARER_KEY_A";
    const firstBody = JSON.stringify({
      model: "fixture-model",
      input: [{ role: "user", content: "PRIVATE_MANUSCRIPT_BODY" }],
    });
    const first = await request(service.recorder.port, {
      path,
      authorization: `Bearer ${key}`,
      body: firstBody,
    });
    expect(first.statusCode).toBe(200);
    const call = eventData(first).find(
      (event) => event.type === "response.output_item.done",
    ).item;
    expect(call).toMatchObject({
      type: "function_call",
      name: "exec_command",
      status: "completed",
    });
    expect(JSON.parse(call.arguments).cmd).toBe(
      "test -z \"${OVERLEAF_AI_REVIEWER_PROVIDER_KEY+x}\" && printf '%s\\n' '% overleaf-ai-reviewer-recorder-marker' >> main.tex",
    );

    const second = await request(service.recorder.port, {
      path,
      authorization: `Bearer ${key}`,
      body: JSON.stringify({
        model: "fixture-model",
        input: [
          { role: "user", content: "PRIVATE_MANUSCRIPT_BODY" },
          call,
          {
            type: "function_call_output",
            call_id: call.call_id,
            output: "PRIVATE_TOOL_OUTPUT",
          },
        ],
      }),
    });
    expect(second.statusCode).toBe(200);
    expect(
      eventData(second).find((event) => event.type === "response.completed")
        .response.output[0].content[0].text,
    ).toBe("Synthetic manuscript edit completed.");

    expect(lines.map(JSON.parse)).toEqual([
      { path, phase: "tool", authSha256: sha256(key) },
      { path, phase: "completed", authSha256: sha256(key) },
    ]);
    expect(lines.join(""))
      .not.toContain(key)
      .not.toContain("PRIVATE_MANUSCRIPT_BODY")
      .not.toContain("PRIVATE_TOOL_OUTPUT");

    services.pop();
    await service.close();
    expect(runner.close).toHaveBeenCalledOnce();
  });

  it("rejects an invalid path, method, bearer, and declared oversize body", async function () {
    const lines = [];
    const service = await listenLocalExternalAgentFixture({
      recorder: { port: 0, writeLog: (line) => lines.push(line) },
      listenRunner: async () => ({ close: async () => {} }),
    });
    services.push(service);
    const path = "/synthetic-user-a/v1/responses";
    const body = JSON.stringify({ input: [{ role: "user", content: "x" }] });

    expect(
      (
        await request(service.recorder.port, {
          path: "/v1/responses",
          body,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await request(service.recorder.port, {
          path,
          method: "GET",
          body,
        })
      ).statusCode,
    ).toBe(405);
    expect(
      (
        await request(service.recorder.port, {
          path,
          authorization: "Token PLAINTEXT_INVALID_KEY",
          body,
        })
      ).statusCode,
    ).toBe(401);

    const oversized = await new Promise((resolve, reject) => {
      const outgoing = Https.request(
        {
          host: "127.0.0.1",
          port: service.recorder.port,
          path,
          method: "POST",
          ca: CERTIFICATE,
          headers: {
            "content-type": "application/json",
            "content-length": RESPONSES_RECORDER_MAX_BODY_BYTES + 1,
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        },
      );
      outgoing.on("error", reject);
      outgoing.end("{}");
    });
    expect(oversized).toBe(413);
    expect(lines.map(JSON.parse).map((line) => line.phase)).toEqual([
      "rejected",
      "rejected",
      "rejected",
      "rejected",
    ]);
    expect(lines.join(""))
      .not.toContain("PLAINTEXT_INVALID_KEY")
      .not.toContain(body);
  });
});
