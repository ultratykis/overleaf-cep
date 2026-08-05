import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import Path from "node:path";

import Settings from "@overleaf/settings";
import { expect } from "chai";
import sinon from "sinon";

import {
  AgentGatewayError,
  ScriptedFakeAgentGateway,
} from "../../../app/src/AgentGateway.mjs";
import { createAiReviewerController } from "../../../app/src/AiReviewerController.mjs";
import { AgentEventSchema } from "../../../shared/contracts.mjs";
import { createPrivacySinkProbe } from "./helpers/PrivacySinkProbe.mjs";

const createdAt = "2026-07-24T00:00:00.000Z";

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.headers = new Map();
    this.chunks = [];
    this.writableEnded = false;
    this.destroyed = false;
  }

  status(code) {
    this.statusCode = code;
    return this;
  }

  setHeader(name, value) {
    this.headers.set(name.toLowerCase(), value);
  }

  flushHeaders() {}

  write(chunk) {
    this.chunks.push(String(chunk));
    this.emit("write");
    return true;
  }

  end(chunk) {
    if (chunk != null) {
      this.chunks.push(String(chunk));
    }
    this.writableEnded = true;
    this.emit("finish");
  }

  json(value) {
    this.setHeader("content-type", "application/json");
    this.end(JSON.stringify(value));
  }
}

function privacyRequest(lifecycle) {
  return {
    requestId: `privacy-${lifecycle}`,
    projectId: "privacy-project",
    action: "review",
    instruction: `AI_REVIEWER_PROMPT_SENTINEL_${lifecycle}`,
    skill: "referee-review",
    scope: {
      kind: "document",
      documentId: "privacy-document",
      path: "main.tex",
      baseRevision: 1,
      baseTextHash: "b".repeat(64),
      text: `AI_REVIEWER_MANUSCRIPT_SENTINEL_${lifecycle}`,
    },
  };
}

function lifecycleEvents(requestId, responseSentinel) {
  return [
    {
      type: "started",
      eventId: `${requestId}-started`,
      requestId,
      sequence: 0,
      createdAt,
      provider: "fake",
      model: "deterministic-v1",
      skill: "referee-review",
    },
    {
      type: "text.delta",
      eventId: `${requestId}-delta`,
      requestId,
      sequence: 1,
      createdAt,
      delta: responseSentinel,
    },
    {
      type: "completed",
      eventId: `${requestId}-completed`,
      requestId,
      sequence: 2,
      createdAt,
      finishReason: "stop",
    },
  ];
}

function httpRequest(body) {
  return Object.assign(new EventEmitter(), {
    body,
    params: {
      project_id: body.projectId,
    },
  });
}

function parseNdjson(response) {
  return response.chunks
    .join("")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => AgentEventSchema.parse(JSON.parse(line)));
}

async function waitForWrites(response, count) {
  if (response.chunks.length >= count) {
    return;
  }
  await new Promise((resolve) => {
    const handleWrite = () => {
      if (response.chunks.length >= count) {
        response.removeListener("write", handleWrite);
        resolve();
      }
    };
    response.on("write", handleWrite);
  });
}

async function executeLifecycle(lifecycle) {
  const request = privacyRequest(lifecycle);
  const responseSentinel = `AI_REVIEWER_RESPONSE_SENTINEL_${lifecycle}`;
  const secretSentinel = `AI_REVIEWER_SECRET_SENTINEL_${lifecycle}`;
  const events = lifecycleEvents(request.requestId, responseSentinel);
  const response = new FakeResponse();
  const timeout = new AbortController();
  let gateway;

  if (lifecycle === "completion") {
    gateway = new ScriptedFakeAgentGateway({ events });
  } else if (lifecycle === "cancellation" || lifecycle === "timeout") {
    gateway = new ScriptedFakeAgentGateway({
      events,
      beforeEvent: ({ index }) =>
        index === 2 ? new Promise(() => {}) : undefined,
    });
  } else {
    gateway = {
      async *stream() {
        yield events[0];
        yield events[1];
        throw new AgentGatewayError(secretSentinel, {
          code: secretSentinel,
          category: "provider",
          retryable: false,
        });
      },
    };
  }

  const controller = createAiReviewerController({
    gatewayFactory: () => gateway,
    timeoutSignalFactory: () => timeout.signal,
    now: () => createdAt,
    eventId: () => `${request.requestId}-error`,
  });
  const streaming = controller.stream(httpRequest(request), response);

  if (lifecycle === "cancellation") {
    await waitForWrites(response, 2);
    response.destroyed = true;
    response.emit("close");
  } else if (lifecycle === "timeout") {
    await waitForWrites(response, 2);
    timeout.abort(new DOMException("Synthetic timeout", "TimeoutError"));
  }
  await streaming;

  return {
    request,
    response,
    responseSentinel,
    secretSentinel,
  };
}

describe("AI reviewer: module shell privacy persistence", function () {
  before(function () {
    if (Settings.aiReviewer.enabled !== true) {
      this.skip();
    }
  });

  for (const lifecycle of ["completion", "cancellation", "timeout", "error"]) {
    it(`does not persist synthetic content after ${lifecycle}`, async function () {
      const temporaryRoot = await mkdtemp(
        Path.join(tmpdir(), "overleaf-ai-reviewer-privacy-"),
      );
      const originalDumpFolder = Settings.path.dumpFolder;
      const originalUploadFolder = Settings.path.uploadFolder;
      Settings.path.dumpFolder = Path.join(temporaryRoot, "dump");
      Settings.path.uploadFolder = Path.join(temporaryRoot, "uploads");
      await Promise.all([
        mkdir(Settings.path.dumpFolder, { recursive: true }),
        mkdir(Settings.path.uploadFolder, { recursive: true }),
      ]);

      const sandbox = sinon.createSandbox();
      const privacyProbe = createPrivacySinkProbe(sandbox);
      try {
        const result = await executeLifecycle(lifecycle);
        const streamed = parseNdjson(result.response);
        expect(streamed.some((event) => event.type === "text.delta")).to.equal(
          true,
        );
        expect(result.response.chunks.join("")).to.include(
          result.responseSentinel,
        );
        expect(result.response.chunks.join("")).not.to.include(
          result.request.instruction,
        );
        expect(result.response.chunks.join("")).not.to.include(
          result.request.scope.text,
        );
        expect(result.response.chunks.join("")).not.to.include(
          result.secretSentinel,
        );

        for (const sentinel of [
          result.request.instruction,
          result.request.scope.text,
          result.responseSentinel,
          result.secretSentinel,
        ]) {
          expect(await privacyProbe.findSentinel(sentinel)).to.equal(null);
        }
      } finally {
        sandbox.restore();
        Settings.path.dumpFolder = originalDumpFolder;
        Settings.path.uploadFolder = originalUploadFolder;
        await rm(temporaryRoot, { force: true, recursive: true });
      }
    });
  }
});
