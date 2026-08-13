import { Readable } from "node:stream";

import { simulateReadableStream } from "ai";
// eslint-disable-next-line import/no-unresolved
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import { AgentGatewayError } from "../../../app/src/AgentGateway.mjs";
import {
  AiSdkAgentGateway,
  projectFigureModelOutput,
} from "../../../app/src/AiSdkAgentGateway.mjs";
import {
  parseAiReviewerConnection,
  parseAiReviewerConnectionUpdate,
  parseAiReviewerProviderConfig,
  publicAiReviewerProviderConnection,
} from "../../../app/src/AiReviewerProviderConfig.mjs";
import { createOllamaProviderService } from "../../../app/src/OllamaProviderService.mjs";
import {
  createProjectFigureReader,
  PROJECT_FIGURE_MAX_BYTES,
} from "../../../app/src/ProjectFigureReader.mjs";
import { createRequestScopeReader } from "../../../app/src/RequestScopeReader.mjs";

const request = Object.freeze({
  requestId: "request-figure-0001",
  projectId: "project-figure-0001",
  action: "review",
  instruction: "Review the figures.",
  skill: "referee-review",
  scope: Object.freeze({ kind: "project" }),
});
const figure = Object.freeze({
  path: "figures/result.PNG",
  mediaType: "image/png",
  bytes: 4,
  data: Buffer.from([0, 1, 2, 3]).toString("base64"),
});

function streamResult(chunks) {
  return {
    stream: simulateReadableStream({
      chunks,
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}

function finish(reason = "stop") {
  return {
    type: "finish",
    finishReason: { unified: reason, raw: reason },
    usage: {
      inputTokens: { total: 1, noCache: 1 },
      outputTokens: { total: 1, text: 1 },
    },
  };
}

function modelFor(results) {
  let index = 0;
  return new MockLanguageModelV3({
    provider: "fixture",
    modelId: "gemini-3-pro-preview",
    doStream: async () => results[index++],
  });
}

function gateway(model, overrides = {}) {
  let id = 0;
  return new AiSdkAgentGateway({
    model,
    provider: "gemini",
    modelId: "gemini-3-pro-preview",
    contextLength: 8_192,
    readProjectFile: vi.fn(),
    now: () => "2026-08-13T00:00:00.000Z",
    createId: (kind) => `${kind}-${++id}`,
    ...overrides,
  });
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function captureError(work) {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject.");
}

describe("AI reviewer: on-demand project figures", function () {
  it("round-trips the optional supportsImages connection flag", function () {
    const write = parseAiReviewerConnectionUpdate({
      provider: "gemini",
      credential: "fixture-credential",
      supportsImages: true,
    });
    expect(write).toMatchObject({ supportsImages: true });
    const { label: _label, ...storedInput } = write;
    const stored = parseAiReviewerConnection(storedInput);
    expect(stored).toMatchObject({ supportsImages: true });
    expect(
      publicAiReviewerProviderConnection({
        id: "connection-figure-0001",
        revision: 1,
        credentialSet: true,
        ...stored,
      }).config,
    ).toMatchObject({ supportsImages: true });
    expect(
      parseAiReviewerProviderConfig({
        provider: "gemini",
        model: "gemini-3-pro-preview",
        contextLength: 8_192,
        supportsImages: true,
      }),
    ).toMatchObject({ supportsImages: true });
    expect(
      parseAiReviewerConnectionUpdate({
        provider: "gemini",
        credential: "fixture-credential",
        supportsImages: false,
      }),
    ).not.toHaveProperty("supportsImages");
    for (const invalid of [null, 1, "true", {}]) {
      expect(() =>
        parseAiReviewerConnectionUpdate({
          provider: "gemini",
          credential: "fixture-credential",
          supportsImages: invalid,
        }),
      ).toThrow();
    }
  });

  it("declares the tool only when image support and a reader are active", async function () {
    const enabledModel = modelFor([streamResult([finish()])]);
    const disabledModel = modelFor([streamResult([finish()])]);

    await collect(
      gateway(enabledModel, {
        supportsImages: true,
        readProjectFigure: vi.fn(async () => figure),
      }).stream(request),
    );
    await collect(
      gateway(disabledModel, {
        readProjectFigure: vi.fn(async () => figure),
      }).stream(request),
    );

    expect(
      enabledModel.doStreamCalls[0].tools.map(({ name }) => name),
    ).toContain("read_project_figure");
    expect(
      disabledModel.doStreamCalls[0].tools.map(({ name }) => name),
    ).not.toContain("read_project_figure");
    expect(enabledModel.doStreamCalls[0].prompt[0].content).toContain(
      "Use read_project_figure only when",
    );
    expect(disabledModel.doStreamCalls[0].prompt[0].content).not.toContain(
      "read_project_figure only when",
    );
  });

  it("returns the base64 image as file-data model output", async function () {
    const model = modelFor([
      streamResult([
        {
          type: "tool-call",
          toolCallId: "figure-call-0001",
          toolName: "read_project_figure",
          input: JSON.stringify({ path: figure.path }),
        },
        finish("tool-calls"),
      ]),
      streamResult([finish()]),
    ]);
    const readProjectFigure = vi.fn(async () => figure);

    const events = await collect(
      gateway(model, {
        supportsImages: true,
        readProjectFigure,
      }).stream(request),
    );

    expect(events.map(({ type }) => type)).toEqual(["started", "completed"]);
    expect(readProjectFigure).toHaveBeenCalledExactlyOnceWith(
      { path: figure.path },
      { request, signal: undefined },
    );
    expect(projectFigureModelOutput(figure)).toEqual({
      type: "content",
      value: [
        {
          type: "text",
          text: "figures/result.PNG (image/png, 4 bytes)",
        },
        {
          type: "file-data",
          data: figure.data,
          mediaType: "image/png",
        },
      ],
    });
    expect(model.doStreamCalls[1].prompt.at(-1)).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "figure-call-0001",
          toolName: "read_project_figure",
          output: {
            type: "content",
            value: [
              {
                type: "text",
                text: "figures/result.PNG (image/png, 4 bytes)",
              },
              {
                type: "file-data",
                data: figure.data,
                mediaType: "image/png",
              },
            ],
          },
        },
      ],
    });
  });

  it("resolves fileRefs by project path and rejects media and size limits", async function () {
    const getAllFiles = vi.fn(async () => ({
      "/figures/result.PNG": { hash: "figure-hash" },
    }));
    const requestBlobWithProjectId = vi.fn(async () => ({
      stream: Readable.from([Buffer.from([0, 1]), Buffer.from([2, 3])]),
      contentLength: 4,
    }));
    const readProjectFigure = createProjectFigureReader({
      getAllFiles,
      requestBlobWithProjectId,
    });

    expect(
      await readProjectFigure(request.projectId, { path: figure.path }),
    ).toEqual(figure);
    expect(requestBlobWithProjectId).toHaveBeenCalledExactlyOnceWith(
      request.projectId,
      "figure-hash",
      "GET",
    );
    expect(
      await captureError(
        readProjectFigure(request.projectId, { path: "figures/result.gif" }),
      ),
    ).toMatchObject({ code: "AI_PROJECT_FIGURE_TYPE_UNSUPPORTED" });
    const missingReader = createProjectFigureReader({
      getAllFiles: vi.fn(async () => ({})),
      requestBlobWithProjectId,
    });
    expect(
      await captureError(
        missingReader(request.projectId, { path: figure.path }),
      ),
    ).toMatchObject({ code: "AI_PROJECT_FIGURE_NOT_FOUND" });

    const oversizedReader = createProjectFigureReader({
      getAllFiles,
      requestBlobWithProjectId: vi.fn(async () => ({
        stream: Readable.from([]),
        contentLength: PROJECT_FIGURE_MAX_BYTES + 1,
      })),
    });
    expect(
      await captureError(
        oversizedReader(request.projectId, { path: figure.path }),
      ),
    ).toMatchObject({ code: "AI_PROJECT_FIGURE_TOO_LARGE" });

    const underreportedReader = createProjectFigureReader({
      getAllFiles,
      requestBlobWithProjectId: vi.fn(async () => ({
        stream: Readable.from([
          Buffer.alloc(PROJECT_FIGURE_MAX_BYTES),
          Buffer.from([0]),
        ]),
        contentLength: 1,
      })),
    });
    expect(
      await captureError(
        underreportedReader(request.projectId, { path: figure.path }),
      ),
    ).toMatchObject({ code: "AI_PROJECT_FIGURE_TOO_LARGE" });
  });

  it("charges 1600 tokens to the shared snapshot budget and rejects overflow", async function () {
    const loadProjectFigure = vi.fn(async () => figure);
    const scopeReader = createRequestScopeReader({
      loadProjectDocuments: vi.fn(async () => ({
        "main.tex": {
          _id: { toString: () => "document-figure-0001" },
          version: 1,
          lines: ["Synthetic manuscript."],
        },
      })),
      loadProjectFigure,
    });
    const scope = await scopeReader.read(
      {
        body: request,
        params: { project_id: request.projectId },
        user: { _id: { toString: () => "user-figure-0001" } },
      },
      { contextLength: 4_096, contextLengthSource: "override" },
    );

    expect(
      await scope.readProjectFigure({ path: figure.path }, { request }),
    ).toEqual(figure);
    expect(
      await captureError(
        scope.readProjectFigure({ path: figure.path }, { request }),
      ),
    ).toMatchObject({
      code: "AI_MODEL_CONTEXT_TOO_SMALL",
      contextLength: 4_096,
      contextLengthSource: "override",
    });
    expect(loadProjectFigure).toHaveBeenCalledTimes(2);
  });

  it("keeps a figure read failure non-terminal", async function () {
    const model = modelFor([
      streamResult([
        {
          type: "tool-call",
          toolCallId: "figure-call-error",
          toolName: "read_project_figure",
          input: JSON.stringify({ path: figure.path }),
        },
        finish("tool-calls"),
      ]),
      streamResult([finish()]),
    ]);
    const readProjectFigure = vi.fn(async () => {
      throw new AgentGatewayError("Figure is too large.", {
        code: "AI_PROJECT_FIGURE_TOO_LARGE",
        category: "configuration",
        retryable: false,
      });
    });

    expect(
      await collect(
        gateway(model, {
          supportsImages: true,
          readProjectFigure,
        }).stream(request),
      ),
    ).toMatchObject([{ type: "started" }, { type: "completed" }]);
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain(
      "Figure is too large.",
    );
  });

  it("fails closed for Chat Completions transports", function () {
    const transport = { createAgentGateway: vi.fn(() => ({})) };
    const service = createOllamaProviderService({
      transportFactory: vi.fn(() => transport),
    });
    service.createAgentGateway(
      {
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:11434/v1",
        model: "vision-model",
        contextLength: 8_192,
        supportsImages: true,
      },
      {
        readProjectFile: vi.fn(),
        readProjectFigure: vi.fn(),
      },
    );
    expect(transport.createAgentGateway.mock.calls[0][0]).not.toHaveProperty(
      "supportsImages",
    );

    const geminiTransport = { createAgentGateway: vi.fn(() => ({})) };
    const geminiService = createOllamaProviderService({
      geminiTransportFactory: vi.fn(() => geminiTransport),
    });
    geminiService.createAgentGateway(
      {
        provider: "gemini",
        model: "gemini-3-pro-preview",
        contextLength: 8_192,
        credential: "fixture-credential",
        supportsImages: true,
      },
      {
        readProjectFile: vi.fn(),
        readProjectFigure: vi.fn(),
      },
    );
    expect(geminiTransport.createAgentGateway.mock.calls[0][0]).toMatchObject({
      supportsImages: true,
    });
  });
});
