import { Readable } from "node:stream";

// Installed in the web container for image rendering.
// eslint-disable-next-line import/no-extraneous-dependencies
import { createCanvas, loadImage } from "@napi-rs/canvas";
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
  PROJECT_FIGURE_DOWNSCALE_MAX_INPUT_BYTES,
  PROJECT_FIGURE_DOWNSCALE_MAX_PIXELS,
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

function answer(text = "Figure reviewed.") {
  return streamResult([
    { type: "text-start", id: "figure-answer" },
    { type: "text-delta", id: "figure-answer", delta: text },
    { type: "text-end", id: "figure-answer" },
    finish(),
  ]);
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

function solidPagePdf(colors) {
  const pageObjectIds = colors.map((_, index) => 3 + index * 2);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${colors.length} /Kids [${pageObjectIds
      .map((id) => `${id} 0 R`)
      .join(" ")}] >>`,
  ];
  for (const [index, [red, green, blue]] of colors.entries()) {
    const content = `${red} ${green} ${blue} rg 0 0 72 72 re f`;
    const contentObjectId = 4 + index * 2;
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] /Resources << >> /Contents ${contentObjectId} 0 R >>`,
      `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    );
  }

  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body);
}

async function centerPixel(png) {
  const image = await loadImage(png);
  const canvas = createCanvas(1, 1);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0, 1, 1);
  return {
    width: image.width,
    height: image.height,
    rgba: Array.from(context.getImageData(0, 0, 1, 1).data),
  };
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
      parseAiReviewerProviderConfig({
        provider: "gemini",
        model: "gemini-3-pro-preview",
        contextLength: 8_192,
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
    const enabledModel = modelFor([answer()]);
    const disabledModel = modelFor([answer()]);

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
      answer(),
    ]);
    const readProjectFigure = vi.fn(async () => figure);

    const events = await collect(
      gateway(model, {
        supportsImages: true,
        readProjectFigure,
      }).stream(request),
    );

    expect(events.map(({ type }) => type)).toEqual([
      "started",
      "text.delta",
      "completed",
    ]);
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

  it.each(["openai-compatible", "azure"])(
    "injects figure files into a user message for %s",
    async function (provider) {
      const model = modelFor([
        streamResult([
          {
            type: "tool-call",
            toolCallId: "figure-call-chat-0001",
            toolName: "read_project_figure",
            input: JSON.stringify({ path: figure.path }),
          },
          finish("tool-calls"),
        ]),
        answer(),
      ]);

      await collect(
        gateway(model, {
          provider,
          supportsImages: true,
          readProjectFigure: vi.fn(async () => figure),
        }).stream(request),
      );

      const prompt = model.doStreamCalls[1].prompt;
      const toolMessageIndex = prompt.findIndex(
        (message) => message.role === "tool",
      );
      expect(prompt[toolMessageIndex]).toMatchObject({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "figure-call-chat-0001",
            toolName: "read_project_figure",
            output: {
              type: "content",
              value: [
                {
                  type: "text",
                  text: "figures/result.PNG (image/png, 4 bytes)",
                },
                {
                  type: "text",
                  text: "The figure image is attached in the user message that follows this tool result.",
                },
              ],
            },
          },
        ],
      });
      expect(JSON.stringify(prompt[toolMessageIndex])).not.toContain('"file"');
      expect(prompt[toolMessageIndex + 1]).toEqual({
        role: "user",
        content: [
          {
            type: "text",
            text: "Figure content from read_project_figure: figures/result.PNG (image/png, 4 bytes)",
          },
          {
            type: "file",
            mediaType: "image/png",
            // azure's nested @ai-sdk/openai 4.x requires the structured data
            // shape; @ai-sdk/openai-compatible requires the bare base64 string.
            data:
              provider === "azure"
                ? { type: "data", data: figure.data }
                : figure.data,
          },
        ],
      });
    },
  );

  it("re-injects replayed figure results once per stream step", async function () {
    const secondFigure = {
      path: "figures/detail.jpg",
      mediaType: "image/jpeg",
      bytes: 3,
      data: Buffer.from([4, 5, 6]).toString("base64"),
    };
    const model = modelFor([
      streamResult([
        {
          type: "tool-call",
          toolCallId: "figure-call-chat-step-1",
          toolName: "read_project_figure",
          input: JSON.stringify({ path: figure.path }),
        },
        finish("tool-calls"),
      ]),
      streamResult([
        {
          type: "tool-call",
          toolCallId: "figure-call-chat-step-2",
          toolName: "read_project_figure",
          input: JSON.stringify({ path: secondFigure.path }),
        },
        finish("tool-calls"),
      ]),
      answer(),
    ]);
    const readProjectFigure = vi.fn(async ({ path }) =>
      path === figure.path ? figure : secondFigure,
    );

    await collect(
      gateway(model, {
        provider: "openai-compatible",
        supportsImages: true,
        readProjectFigure,
      }).stream(request),
    );

    expect(readProjectFigure).toHaveBeenCalledTimes(2);
    const injectedMessages = (prompt) =>
      prompt.filter(
        (message) =>
          message.role === "user" &&
          Array.isArray(message.content) &&
          message.content[0]?.text?.startsWith(
            "Figure content from read_project_figure:",
          ),
      );
    expect(injectedMessages(model.doStreamCalls[1].prompt)).toHaveLength(1);
    expect(injectedMessages(model.doStreamCalls[2].prompt)).toEqual([
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Figure content from read_project_figure: figures/result.PNG (image/png, 4 bytes)",
          },
          {
            type: "file",
            mediaType: "image/png",
            data: figure.data,
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Figure content from read_project_figure: figures/detail.jpg (image/jpeg, 3 bytes)",
          },
          {
            type: "file",
            mediaType: "image/jpeg",
            data: secondFigure.data,
          },
        ],
      },
    ]);
    for (const prompt of model.doStreamCalls
      .slice(1)
      .map(({ prompt }) => prompt)) {
      for (const [index, message] of prompt.entries()) {
        if (message.role === "tool") {
          expect(prompt[index + 1]?.role).toBe("user");
        }
      }
    }
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
        contentLength: PROJECT_FIGURE_DOWNSCALE_MAX_INPUT_BYTES + 1,
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
          Buffer.alloc(PROJECT_FIGURE_DOWNSCALE_MAX_INPUT_BYTES),
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

  it.each([
    ["figures/result.PNG", "image/png"],
    ["figures/result.JpEg", "image/jpeg"],
  ])(
    "returns %s at the 5 MB limit byte-identically",
    async function (path, mediaType) {
      const input = Buffer.alloc(PROJECT_FIGURE_MAX_BYTES, 0x5a);
      const reader = createProjectFigureReader({
        getAllFiles: vi.fn(async () => ({
          [`/${path}`]: { hash: "figure-hash" },
        })),
        requestBlobWithProjectId: vi.fn(async () => ({
          stream: Readable.from([input]),
          contentLength: input.length,
        })),
        downscaleFigure: vi.fn(() => {
          throw new Error("The unchanged path must not convert.");
        }),
      });

      const result = await reader(request.projectId, { path });
      expect(result.mediaType).toBe(mediaType);
      expect(result.bytes).toBe(input.length);
      expect(Buffer.from(result.data, "base64").equals(input)).toBe(true);
    },
  );

  it("rasterises a one-page PDF at 144 DPI as image/png", async function () {
    const path = "figures/result.PDF";
    const input = solidPagePdf([[1, 0, 0]]);
    const reader = createProjectFigureReader({
      getAllFiles: vi.fn(async () => ({
        [`/${path}`]: { hash: "pdf-hash" },
      })),
      requestBlobWithProjectId: vi.fn(async () => ({
        stream: Readable.from([input]),
        contentLength: input.length,
      })),
    });

    const result = await reader(request.projectId, { path });
    const png = Buffer.from(result.data, "base64");
    expect(result).toMatchObject({ path, mediaType: "image/png" });
    expect(result.bytes).toBe(png.length);
    expect(await centerPixel(png)).toEqual({
      width: 144,
      height: 144,
      rgba: [255, 0, 0, 255],
    });
    expect(JSON.stringify(projectFigureModelOutput(result))).not.toContain(
      "application/pdf",
    );
  });

  it("renders only the first page of a multi-page PDF", async function () {
    const path = "figures/multi-page.pdf";
    const input = solidPagePdf([
      [1, 0, 0],
      [0, 0, 1],
    ]);
    const reader = createProjectFigureReader({
      getAllFiles: vi.fn(async () => ({
        [`/${path}`]: { hash: "pdf-hash" },
      })),
      requestBlobWithProjectId: vi.fn(async () => ({
        stream: Readable.from([input]),
        contentLength: input.length,
      })),
    });

    const result = await reader(request.projectId, { path });
    expect(await centerPixel(Buffer.from(result.data, "base64"))).toMatchObject(
      { rgba: [255, 0, 0, 255] },
    );
  });

  it("downscales a PDF raster above 5 MB through the existing path", async function () {
    const path = "figures/result.pdf";
    const smallPng = createCanvas(10, 10).toBuffer("image/png");
    const largePng = Buffer.concat([
      smallPng,
      Buffer.alloc(PROJECT_FIGURE_MAX_BYTES),
    ]);
    const downscaledPng = createCanvas(5, 5).toBuffer("image/png");
    const renderPdf = vi.fn(async () => largePng);
    const downscaleFigure = vi.fn(async () => downscaledPng);
    const reader = createProjectFigureReader({
      getAllFiles: vi.fn(async () => ({
        [`/${path}`]: { hash: "pdf-hash" },
      })),
      requestBlobWithProjectId: vi.fn(async () => ({
        stream: Readable.from([solidPagePdf([[1, 0, 0]])]),
      })),
      renderPdf,
      downscaleFigure,
    });

    const result = await reader(request.projectId, { path });
    expect(renderPdf).toHaveBeenCalledOnce();
    expect(downscaleFigure).toHaveBeenCalledOnce();
    expect(downscaleFigure.mock.calls[0][1]).toMatchObject({
      mediaType: "image/png",
      maxBytes: PROJECT_FIGURE_MAX_BYTES,
    });
    expect(result.mediaType).toBe("image/png");
    expect(Buffer.from(result.data, "base64").equals(downscaledPng)).toBe(true);
  });

  it("refuses an unparseable PDF with a bounded conversion error", async function () {
    const path = "figures/broken.pdf";
    const input = Buffer.from("not a PDF");
    const reader = createProjectFigureReader({
      getAllFiles: vi.fn(async () => ({
        [`/${path}`]: { hash: "pdf-hash" },
      })),
      requestBlobWithProjectId: vi.fn(async () => ({
        stream: Readable.from([input]),
        contentLength: input.length,
      })),
    });

    expect(
      await captureError(reader(request.projectId, { path })),
    ).toMatchObject({
      code: "AI_PROJECT_FIGURE_CONVERSION_FAILED",
      category: "configuration",
      retryable: false,
    });
  });

  it("bounds a stalled PDF render with the conversion timeout", async function () {
    const path = "figures/stalled.pdf";
    const input = solidPagePdf([[1, 0, 0]]);
    const reader = createProjectFigureReader({
      getAllFiles: vi.fn(async () => ({
        [`/${path}`]: { hash: "pdf-hash" },
      })),
      requestBlobWithProjectId: vi.fn(async () => ({
        stream: Readable.from([input]),
        contentLength: input.length,
      })),
      renderPdf: vi.fn(async () => await new Promise(() => {})),
      downscaleTimeoutMilliseconds: 10,
    });

    expect(
      await captureError(reader(request.projectId, { path })),
    ).toMatchObject({
      code: "AI_PROJECT_FIGURE_CONVERSION_TIMEOUT",
      category: "configuration",
      retryable: false,
    });
  });

  it("downscales a figure above 5 MB with the installed canvas", async function () {
    const canvas = createCanvas(10, 10);
    const input = Buffer.concat([
      canvas.toBuffer("image/png"),
      Buffer.alloc(PROJECT_FIGURE_MAX_BYTES),
    ]);
    const reader = createProjectFigureReader({
      getAllFiles: vi.fn(async () => ({
        "/figures/result.PNG": { hash: "figure-hash" },
      })),
      requestBlobWithProjectId: vi.fn(async () => ({
        stream: Readable.from([input]),
        contentLength: input.length,
      })),
    });

    const result = await reader(request.projectId, { path: figure.path });
    expect(result.bytes).toBeLessThanOrEqual(PROJECT_FIGURE_MAX_BYTES);
    expect(Buffer.from(result.data, "base64").equals(input)).toBe(false);
  });

  it("refuses a figure that remains above 5 MB after downscaling", async function () {
    const canvas = createCanvas(10, 10);
    const input = Buffer.concat([
      canvas.toBuffer("image/png"),
      Buffer.alloc(PROJECT_FIGURE_MAX_BYTES),
    ]);
    const reader = createProjectFigureReader({
      getAllFiles: vi.fn(async () => ({
        "/figures/result.PNG": { hash: "figure-hash" },
      })),
      requestBlobWithProjectId: vi.fn(async () => ({
        stream: Readable.from([input]),
        contentLength: input.length,
      })),
      downscaleFigure: vi.fn(async () => input),
    });

    expect(
      await captureError(reader(request.projectId, { path: figure.path })),
    ).toMatchObject({
      code: "AI_PROJECT_FIGURE_TOO_LARGE",
      category: "configuration",
      retryable: false,
    });
  });

  it("bounds a stalled downscale with a typed timeout error", async function () {
    const canvas = createCanvas(10, 10);
    const input = Buffer.concat([
      canvas.toBuffer("image/png"),
      Buffer.alloc(PROJECT_FIGURE_MAX_BYTES),
    ]);
    const reader = createProjectFigureReader({
      getAllFiles: vi.fn(async () => ({
        "/figures/result.PNG": { hash: "figure-hash" },
      })),
      requestBlobWithProjectId: vi.fn(async () => ({
        stream: Readable.from([input]),
        contentLength: input.length,
      })),
      downscaleFigure: vi.fn(async () => await new Promise(() => {})),
      downscaleTimeoutMilliseconds: 10,
    });

    expect(
      await captureError(reader(request.projectId, { path: figure.path })),
    ).toMatchObject({
      code: "AI_PROJECT_FIGURE_CONVERSION_TIMEOUT",
      category: "configuration",
      retryable: false,
    });
  });

  it("returns a typed conversion error for invalid oversized image data", async function () {
    const input = Buffer.alloc(PROJECT_FIGURE_MAX_BYTES + 1);
    const reader = createProjectFigureReader({
      getAllFiles: vi.fn(async () => ({
        "/figures/result.PNG": { hash: "figure-hash" },
      })),
      requestBlobWithProjectId: vi.fn(async () => ({
        stream: Readable.from([input]),
        contentLength: input.length,
      })),
    });

    expect(
      await captureError(reader(request.projectId, { path: figure.path })),
    ).toMatchObject({
      code: "AI_PROJECT_FIGURE_CONVERSION_FAILED",
      category: "configuration",
      retryable: false,
    });
  });

  it("refuses oversized conversion work above the pixel ceiling", async function () {
    const canvas = createCanvas(10, 10);
    const header = canvas.toBuffer("image/png");
    header.writeUInt32BE(10_000, 16);
    header.writeUInt32BE(5_000, 20);
    const input = Buffer.concat([
      header,
      Buffer.alloc(PROJECT_FIGURE_MAX_BYTES),
    ]);
    const downscaleFigure = vi.fn();
    const reader = createProjectFigureReader({
      getAllFiles: vi.fn(async () => ({
        "/figures/result.PNG": { hash: "figure-hash" },
      })),
      requestBlobWithProjectId: vi.fn(async () => ({
        stream: Readable.from([input]),
        contentLength: input.length,
      })),
      downscaleFigure,
    });

    expect(10_000 * 5_000).toBeGreaterThan(PROJECT_FIGURE_DOWNSCALE_MAX_PIXELS);
    expect(
      await captureError(reader(request.projectId, { path: figure.path })),
    ).toMatchObject({ code: "AI_PROJECT_FIGURE_CONVERSION_FAILED" });
    expect(downscaleFigure).not.toHaveBeenCalled();
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
      answer(),
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
    ).toMatchObject([
      { type: "started" },
      { type: "text.delta" },
      { type: "completed" },
    ]);
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain(
      "Figure is too large.",
    );
  });

  it("enables supported image routes and keeps untested routes closed", function () {
    const openAiTransport = { createAgentGateway: vi.fn(() => ({})) };
    const azureTransport = { createAgentGateway: vi.fn(() => ({})) };
    const geminiTransport = { createAgentGateway: vi.fn(() => ({})) };
    const claudeTransport = { createAgentGateway: vi.fn(() => ({})) };
    const service = createOllamaProviderService({
      transportFactory: vi.fn(() => openAiTransport),
      azureTransportFactory: vi.fn(() => azureTransport),
      geminiTransportFactory: vi.fn(() => geminiTransport),
      claudeTransportFactory: vi.fn(() => claudeTransport),
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
    service.createAgentGateway(
      {
        provider: "azure",
        baseUrl: "https://reviewer.openai.azure.com/openai",
        requestStyle: "deployment",
        model: "vision-deployment",
        contextLength: 8_192,
        credential: "fixture-credential",
        supportsImages: true,
      },
      {
        readProjectFile: vi.fn(),
        readProjectFigure: vi.fn(),
      },
    );
    service.createAgentGateway(
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
    service.createAgentGateway(
      {
        provider: "gemini",
        model: "gemini-2.5-pro",
        contextLength: 8_192,
        credential: "fixture-credential",
        supportsImages: true,
      },
      {
        readProjectFile: vi.fn(),
        readProjectFigure: vi.fn(),
      },
    );
    service.createAgentGateway(
      {
        provider: "claude",
        model: "claude-sonnet-4-5",
        contextLength: 8_192,
        credential: "fixture-credential",
        supportsImages: true,
      },
      {
        readProjectFile: vi.fn(),
        readProjectFigure: vi.fn(),
      },
    );

    expect(openAiTransport.createAgentGateway.mock.calls[0][0]).toMatchObject({
      supportsImages: true,
    });
    expect(azureTransport.createAgentGateway.mock.calls[0][0]).toMatchObject({
      supportsImages: true,
    });
    expect(geminiTransport.createAgentGateway.mock.calls[0][0]).toMatchObject({
      supportsImages: true,
    });
    expect(
      geminiTransport.createAgentGateway.mock.calls[1][0],
    ).not.toHaveProperty("supportsImages");
    expect(
      claudeTransport.createAgentGateway.mock.calls[0][0],
    ).not.toHaveProperty("supportsImages");
  });

  it.each([
    [["completion", "tools"], false],
    [["completion", "tools", "vision"], true],
  ])(
    "uses and caches Ollama /api/show capabilities %j",
    async function (capabilities, expected) {
      const transport = { createAgentGateway: vi.fn(() => ({})) };
      const modelFetchImpl = vi.fn(async (input) => {
        const url = String(input);
        const body = url.endsWith("/v1/models")
          ? {
              object: "list",
              data: [
                {
                  id: "fixture-model",
                  object: "model",
                  owned_by: "library",
                },
              ],
            }
          : url.endsWith("/api/tags")
            ? {
                models: [
                  {
                    name: "fixture-model",
                    capabilities: ["completion", "tools"],
                  },
                ],
              }
            : { capabilities };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });
      const service = createOllamaProviderService({
        transportFactory: vi.fn(() => transport),
        modelFetchImpl,
        contextLengthDetectionSignalFactory: () => undefined,
      });
      const connection = {
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:11434/v1",
      };

      await service.listModels(connection);
      const supported = await service.supportsImages(
        connection,
        "fixture-model",
      );
      expect(await service.supportsImages(connection, "fixture-model")).toBe(
        expected,
      );
      service.createAgentGateway(
        {
          ...connection,
          model: "fixture-model",
          contextLength: 8_192,
          supportsImages: supported,
        },
        { readProjectFile: vi.fn(), readProjectFigure: vi.fn() },
      );

      expect(
        modelFetchImpl.mock.calls.filter(([url]) =>
          String(url).endsWith("/api/show"),
        ),
      ).toHaveLength(1);
      if (expected) {
        expect(transport.createAgentGateway.mock.calls[0][0]).toMatchObject({
          supportsImages: true,
        });
      } else {
        expect(
          transport.createAgentGateway.mock.calls[0][0],
        ).not.toHaveProperty("supportsImages");
      }
    },
  );

  it("fails open when the Ollama /api/show probe is unavailable", async function () {
    const transport = { createAgentGateway: vi.fn(() => ({})) };
    const modelFetchImpl = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/show")) {
        throw new TypeError("unavailable");
      }
      return new Response(
        JSON.stringify(
          url.endsWith("/v1/models")
            ? {
                object: "list",
                data: [
                  {
                    id: "fixture-model",
                    object: "model",
                    owned_by: "library",
                  },
                ],
              }
            : {
                models: [
                  {
                    name: "fixture-model",
                    capabilities: ["completion", "tools"],
                  },
                ],
              },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const service = createOllamaProviderService({
      transportFactory: vi.fn(() => transport),
      modelFetchImpl,
      contextLengthDetectionSignalFactory: () => undefined,
    });
    const connection = {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
    };
    await service.listModels(connection);
    const supported = await service.supportsImages(connection, "fixture-model");
    service.createAgentGateway(
      {
        ...connection,
        model: "fixture-model",
        contextLength: 8_192,
        supportsImages: supported,
      },
      { readProjectFile: vi.fn(), readProjectFigure: vi.fn() },
    );

    expect(supported).toBe(true);
    expect(transport.createAgentGateway.mock.calls[0][0]).toMatchObject({
      supportsImages: true,
    });
  });

  it("always enables a non-Ollama provider before transport gating", async function () {
    const geminiTransport = { createAgentGateway: vi.fn(() => ({})) };
    const modelFetchImpl = vi.fn();
    const service = createOllamaProviderService({
      geminiTransportFactory: vi.fn(() => geminiTransport),
      modelFetchImpl,
    });
    const connection = {
      provider: "gemini",
      credential: "fixture-credential",
    };
    const supported = await service.supportsImages(
      connection,
      "gemini-3-pro-preview",
    );
    service.createAgentGateway(
      {
        ...connection,
        model: "gemini-3-pro-preview",
        contextLength: 8_192,
        supportsImages: supported,
      },
      { readProjectFile: vi.fn(), readProjectFigure: vi.fn() },
    );

    expect(supported).toBe(true);
    expect(modelFetchImpl).not.toHaveBeenCalled();
    expect(geminiTransport.createAgentGateway.mock.calls[0][0]).toMatchObject({
      supportsImages: true,
    });
  });
});
