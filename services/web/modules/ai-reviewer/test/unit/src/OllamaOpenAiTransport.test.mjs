import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { AiSdkAgentGateway } from "../../../app/src/AiSdkAgentGateway.mjs";
import { AgentGatewayError } from "../../../app/src/AgentGateway.mjs";
import { OllamaOpenAiTransport } from "../../../app/src/OllamaOpenAiTransport.mjs";

const appSourceDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../app/src",
);
const baseUrl = "http://127.0.0.1:11434/v1";
const modelTag = "overleaf-ai-reviewer-compat-8k:latest";

function listProductionSourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listProductionSourceFiles(absolutePath);
    }
    return /\.(?:cjs|js|mjs|ts|tsx)$/u.test(entry.name) ? [absolutePath] : [];
  });
}

function concreteModel() {
  return {
    specificationVersion: "v3",
    doStream: vi.fn(),
  };
}

function transportFixture(overrides = {}) {
  const model = concreteModel();
  const chat = vi.fn(() => model);
  const provider = { chat };
  const createProvider = vi.fn(() => provider);
  const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
  const transport = new OllamaOpenAiTransport({
    baseUrl,
    modelTag,
    createProvider,
    fetchImpl,
    ...overrides,
  });
  return {
    chat,
    createProvider,
    fetchImpl,
    model,
    provider,
    transport,
  };
}

async function captureError(work) {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject.");
}

describe("AI reviewer: Ollama OpenAI transport", function () {
  it("constructs only an explicit Chat Completions model", function () {
    const fixture = transportFixture();

    expect(fixture.createProvider).toHaveBeenCalledOnce();
    expect(fixture.createProvider).toHaveBeenCalledWith({
      apiKey: "ollama",
      baseURL: baseUrl,
      fetch: expect.any(Function),
      name: "ollama",
    });
    expect(fixture.chat).toHaveBeenCalledExactlyOnceWith(modelTag);
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
  });

  it("constructs the real function provider without making a request", function () {
    const fetchImpl = vi.fn();
    const transport = new OllamaOpenAiTransport({
      baseUrl,
      modelTag,
      fetchImpl,
    });
    const gateway = transport.createAgentGateway({
      readProjectFile: vi.fn(),
    });

    expect(gateway).toBeInstanceOf(AiSdkAgentGateway);
    expect(gateway).toMatchObject({
      provider: "ollama",
      modelId: modelTag,
    });
    expect(gateway.model).toMatchObject({
      specificationVersion: "v3",
    });
    expect(typeof gateway.model.doStream).toBe("function");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("creates the production gateway without exposing an SDK model getter", function () {
    const fixture = transportFixture();
    const readProjectFile = vi.fn();
    const gateway = fixture.transport.createAgentGateway({
      readProjectFile,
      now: () => "2026-07-25T00:00:00.000Z",
      createId: () => "synthetic-id",
    });

    expect(gateway).toBeInstanceOf(AiSdkAgentGateway);
    expect(gateway).toMatchObject({
      provider: "ollama",
      modelId: modelTag,
      readProjectFile,
    });
    expect("languageModel" in fixture.transport).toBe(false);
    expect("model" in fixture.transport).toBe(false);
    expect(Reflect.ownKeys(fixture.transport)).toEqual([]);
  });

  it.each(["qwen3.5:4b", "hf.co/org/repo:Q4_K_M", "library/model.v1:latest"])(
    "accepts canonical explicit model tag %s",
    function (tag) {
      const fixture = transportFixture({ modelTag: tag });

      expect(fixture.chat).toHaveBeenCalledExactlyOnceWith(tag);
      expect(fixture.fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([
    "qwen3.5",
    " qwen3.5:4b",
    "qwen3.5:4b ",
    "qwen3.5:",
    ":4b",
    "qwen3.5:4b\n",
    "qwen3.5:4b?remote=true",
  ])(
    "rejects noncanonical model tag %j before provider creation",
    function (tag) {
      const createProvider = vi.fn();
      const fetchImpl = vi.fn();

      expect(
        () =>
          new OllamaOpenAiTransport({
            baseUrl,
            modelTag: tag,
            createProvider,
            fetchImpl,
          }),
      ).toThrow("modelTag must be an explicit canonical Ollama tag");
      expect(createProvider).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("rejects a disallowed endpoint before provider construction", function () {
    const createProvider = vi.fn();
    const fetchImpl = vi.fn();

    expect(
      () =>
        new OllamaOpenAiTransport({
          baseUrl: "http://192.168.0.1:11434/v1",
          modelTag,
          createProvider,
          fetchImpl,
        }),
    ).toThrow("not an allowed local OpenAI-compatible URL");
    expect(createProvider).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects malformed provider factories and chat models", function () {
    expect(
      () =>
        new OllamaOpenAiTransport({
          baseUrl,
          modelTag,
          createProvider: /** @type {never} */ (null),
          fetchImpl: vi.fn(),
        }),
    ).toThrow("createProvider must be a function");
    expect(
      () =>
        new OllamaOpenAiTransport({
          baseUrl,
          modelTag,
          createProvider: vi.fn(() => ({})),
          fetchImpl: vi.fn(),
        }),
    ).toThrow("provider with a chat method");
    expect(
      () =>
        new OllamaOpenAiTransport({
          baseUrl,
          modelTag,
          createProvider: vi.fn(() => ({
            chat: () => "hosted:model",
          })),
          fetchImpl: vi.fn(),
        }),
    ).toThrow("concrete Chat Completions model");
  });

  it("rejects a chat model missing specificationVersion", function () {
    expect(
      () =>
        new OllamaOpenAiTransport({
          baseUrl,
          modelTag,
          createProvider: vi.fn(() => ({
            chat: () => ({
              doStream: vi.fn(),
            }),
          })),
          fetchImpl: vi.fn(),
        }),
    ).toThrow("concrete Chat Completions model");
  });

  it("rejects a chat model missing doStream", function () {
    expect(
      () =>
        new OllamaOpenAiTransport({
          baseUrl,
          modelTag,
          createProvider: vi.fn(() => ({
            chat: () => ({
              specificationVersion: "v3",
            }),
          })),
          fetchImpl: vi.fn(),
        }),
    ).toThrow("concrete Chat Completions model");
  });

  it("preserves cancellation and forces redirect rejection", async function () {
    const fixture = transportFixture();
    const providerOptions = fixture.createProvider.mock.calls[0][0];
    const controller = new AbortController();
    const response = await providerOptions.fetch(
      `${baseUrl}/chat/completions`,
      {
        method: "POST",
        redirect: "follow",
        signal: controller.signal,
      },
    );

    expect(response.status).toBe(200);
    expect(fixture.fetchImpl).toHaveBeenCalledExactlyOnceWith(
      `${baseUrl}/chat/completions`,
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        signal: controller.signal,
      }),
    );
  });

  it.each([
    "http://127.0.0.1:11434/v1/models",
    "http://127.0.0.1:11434/v1/chat/completions?model=x",
    "http://127.0.0.1:11435/v1/chat/completions",
    "http://localhost:11434/v1/chat/completions",
    "https://127.0.0.1:11434/v1/chat/completions",
  ])("rejects outbound URL %s before fetch", async function (requestUrl) {
    const fixture = transportFixture();
    const providerOptions = fixture.createProvider.mock.calls[0][0];

    const error = await captureError(providerOptions.fetch(requestUrl));

    expect(error).toMatchObject({
      code: "AI_OLLAMA_REQUEST_URL_NOT_ALLOWED",
      category: "configuration",
      retryable: false,
    });
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
  });

  it("accepts a Request input without replacing its abort signal", async function () {
    const fixture = transportFixture();
    const providerOptions = fixture.createProvider.mock.calls[0][0];
    const controller = new AbortController();
    const request = new Request(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
    });

    await providerOptions.fetch(request);

    expect(fixture.fetchImpl).toHaveBeenCalledOnce();
    const [forwardedRequest, forwardedInit] = fixture.fetchImpl.mock.calls[0];
    expect(forwardedRequest).toBe(request);
    expect(forwardedInit).toEqual({ redirect: "error" });
    const reason = new DOMException("Synthetic cancellation.", "AbortError");
    controller.abort(reason);
    expect(forwardedRequest.signal).toMatchObject({
      aborted: true,
      reason,
    });
  });

  it.each(Array.from({ length: 100 }, (_, index) => 300 + index))(
    "rejects returned redirect status %i after exactly one underlying request",
    async function (status) {
      const fetchImpl = vi.fn(async () => {
        return new Response(null, {
          status,
          headers: {
            location: "http://example.com/v1/chat/completions",
          },
        });
      });
      const fixture = transportFixture({ fetchImpl });
      const providerOptions = fixture.createProvider.mock.calls[0][0];

      const error = await captureError(
        providerOptions.fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
        }),
      );

      expect(error).toBeInstanceOf(AgentGatewayError);
      expect(error).toMatchObject({
        code: "AI_PROVIDER_REDIRECT_REJECTED",
        category: "provider",
        retryable: false,
      });
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(fetchImpl.mock.calls[0][1]).toMatchObject({
        redirect: "error",
      });
    },
  );

  it("keeps the OpenAI SDK import inside the transport adapter", function () {
    const productionImports = listProductionSourceFiles(appSourceDirectory)
      .flatMap((absolutePath) => {
        const source = fs.readFileSync(absolutePath, {
          encoding: "utf8",
        });
        return source.includes("@ai-sdk/openai") ? [absolutePath] : [];
      })
      .map((absolutePath) =>
        path
          .relative(appSourceDirectory, absolutePath)
          .split(path.sep)
          .join("/"),
      )
      .sort();

    expect(productionImports).toEqual(["OllamaOpenAiTransport.mjs"]);
  });
});
