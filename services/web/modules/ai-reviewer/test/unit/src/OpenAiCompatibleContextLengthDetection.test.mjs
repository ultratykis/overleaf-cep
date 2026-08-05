import { describe, expect, it, vi } from "vitest";

import { AgentGatewayError } from "../../../app/src/AgentGateway.mjs";
import { detectOpenAiCompatibleContextLength } from "../../../app/src/OllamaOpenAiTransport.mjs";

const baseUrl = "http://127.0.0.1:11434/v1";
const model = "qwen3.5:4b";
const credential = "PRIVATE_CONTEXT_METADATA_CREDENTIAL";

function metadataResponse(contextLength = 32_768) {
  return new Response(
    JSON.stringify({
      parameters: "num_ctx 2048",
      model_info: {
        "general.architecture": "qwen35",
        "qwen35.context_length": contextLength,
      },
      unrelated: "untrusted metadata is ignored",
    }),
    {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}

async function captureError(work) {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject.");
}

describe("AI reviewer OpenAI-compatible context detection", function () {
  it("posts the model to the fixed same-origin Ollama metadata path", async function () {
    const fetchImpl = vi.fn(async () => metadataResponse(131_072));

    expect(
      await detectOpenAiCompatibleContextLength({
        baseUrl,
        model,
        credential,
        fetchImpl,
      }),
    ).toBe(131_072);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://127.0.0.1:11434/api/show");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      model,
      verbose: false,
    });
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBe(`Bearer ${credential}`);
    expect(String(url)).not.toContain(credential);
    expect(String(init.body)).not.toContain(credential);
  });

  it.each([
    {
      name: "missing model_info",
      body: { details: {} },
    },
    {
      name: "noncanonical architecture",
      body: {
        model_info: {
          "general.architecture": "../qwen",
          "../qwen.context_length": 32_768,
        },
      },
    },
    {
      name: "string context length",
      body: {
        model_info: {
          "general.architecture": "qwen35",
          "qwen35.context_length": "32768",
        },
      },
    },
    {
      name: "unrelated suffix key",
      body: {
        model_info: {
          "general.architecture": "qwen35",
          "other.context_length": 32_768,
        },
      },
    },
    {
      name: "implausibly large context length",
      body: {
        model_info: {
          "general.architecture": "qwen35",
          "qwen35.context_length": 10_000_001,
        },
      },
    },
  ])("rejects malformed metadata: $name", async function ({ body }) {
    const error = await captureError(
      detectOpenAiCompatibleContextLength({
        baseUrl,
        model,
        fetchImpl: vi.fn(async () => {
          return new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }),
      }),
    );

    expect(error).toBeInstanceOf(AgentGatewayError);
    expect(error).toMatchObject({
      code: "AI_PROVIDER_SCHEMA_INVALID",
      category: "schema",
      retryable: false,
    });
  });

  it("rejects an oversized metadata response before parsing it", async function () {
    const error = await captureError(
      detectOpenAiCompatibleContextLength({
        baseUrl,
        model,
        fetchImpl: vi.fn(async () => {
          return new Response(
            JSON.stringify({
              model_info: {
                "general.architecture": "qwen35",
                "qwen35.context_length": 32_768,
              },
              padding: "x".repeat(70_000),
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }),
      }),
    );

    expect(error).toMatchObject({
      code: "AI_PROVIDER_SCHEMA_INVALID",
      category: "schema",
    });
  });

  it("refuses redirects through the shared outbound policy", async function () {
    const error = await captureError(
      detectOpenAiCompatibleContextLength({
        baseUrl,
        model,
        fetchImpl: vi.fn(async () =>
          Response.redirect("http://127.0.0.1:11434/redirected", 302),
        ),
      }),
    );

    expect(error).toMatchObject({
      code: "AI_PROVIDER_REDIRECT_REJECTED",
      category: "provider",
      retryable: false,
    });
  });

  it("classifies an authentication failure without reading provider prose", async function () {
    const privateProviderText = "PRIVATE_AUTHENTICATION_FAILURE";
    const cancel = vi.fn();
    const error = await captureError(
      detectOpenAiCompatibleContextLength({
        baseUrl,
        model,
        credential,
        fetchImpl: vi.fn(async () => {
          return new Response(
            new ReadableStream({
              pull() {},
              cancel,
            }),
            { status: 401 },
          );
        }),
      }),
    );

    expect(error).toMatchObject({
      code: "AI_PROVIDER_AUTHENTICATION_ERROR",
      category: "authentication",
      retryable: false,
    });
    expect(String(error)).not.toContain(privateProviderText);
    expect(String(error)).not.toContain(credential);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("cancels a bounded success response before rejecting invalid headers", async function () {
    const cancel = vi.fn();
    const error = await captureError(
      detectOpenAiCompatibleContextLength({
        baseUrl,
        model,
        fetchImpl: vi.fn(async () => {
          return new Response(
            new ReadableStream({
              pull() {},
              cancel,
            }),
            {
              status: 200,
              headers: { "content-type": "text/plain" },
            },
          );
        }),
      }),
    );

    expect(error).toMatchObject({
      code: "AI_PROVIDER_SCHEMA_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
