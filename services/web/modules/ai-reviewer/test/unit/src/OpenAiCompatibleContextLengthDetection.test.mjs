import { describe, expect, it, vi } from "vitest";

import { AgentGatewayError } from "../../../app/src/AgentGateway.mjs";
import { detectOpenAiCompatibleContextLength } from "../../../app/src/OllamaOpenAiTransport.mjs";

const baseUrl = "http://127.0.0.1:11434/v1";
const model = "qwen3.5:4b";
const credential = "PRIVATE_CONTEXT_METADATA_CREDENTIAL";

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
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
  it("prefers Ollama's loaded allocation over the larger model limit", async function () {
    const fetchImpl = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/ps")) {
        return jsonResponse({
          models: [{ name: model, context_length: 4_096 }],
        });
      }
      return jsonResponse({ n_ctx: 131_072 });
    });

    expect(
      await detectOpenAiCompatibleContextLength({ baseUrl, model, fetchImpl }),
    ).toBe(4_096);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][0]).toBe("http://127.0.0.1:11434/api/ps");
  });

  it("uses the smallest llama.cpp slot allocation before model properties", async function () {
    const fetchImpl = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/ps")) return jsonResponse({}, 404);
      if (url.endsWith("/slots")) {
        return jsonResponse([{ n_ctx: 16_384 }, { n_ctx: 8_192 }]);
      }
      return jsonResponse({ n_ctx: 131_072 });
    });

    expect(
      await detectOpenAiCompatibleContextLength({ baseUrl, model, fetchImpl }),
    ).toBe(8_192);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:11434/api/ps",
      "http://127.0.0.1:11434/slots",
    ]);
  });

  it("uses llama.cpp properties when slots are unavailable", async function () {
    const fetchImpl = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/props")) {
        return jsonResponse({ default_generation_settings: { n_ctx: 32_768 } });
      }
      return jsonResponse({}, 404);
    });

    expect(
      await detectOpenAiCompatibleContextLength({ baseUrl, model, fetchImpl }),
    ).toBe(32_768);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("leaves an unloaded Ollama model unknown instead of using /api/show's maximum", async function () {
    const fetchImpl = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/ps")) return jsonResponse({ models: [] });
      if (url.endsWith("/api/show")) {
        return jsonResponse({
          model_info: {
            "general.architecture": "qwen35",
            "qwen35.context_length": 262_144,
          },
        });
      }
      return jsonResponse({}, 404);
    });

    expect(
      await detectOpenAiCompatibleContextLength({ baseUrl, model, fetchImpl }),
    ).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:11434/api/ps",
      "http://127.0.0.1:11434/slots",
      "http://127.0.0.1:11434/props",
    ]);
  });

  it("blocks an HTTP credential before any metadata request", async function () {
    const fetchImpl = vi.fn();
    const error = await captureError(
      detectOpenAiCompatibleContextLength({
        baseUrl,
        model,
        credential,
        fetchImpl,
      }),
    );
    expect(error).toMatchObject({
      code: "AI_PROVIDER_PLAINTEXT_CREDENTIAL_BLOCKED",
      category: "configuration",
      retryable: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("sends a credential only through guarded same-origin metadata requests", async function () {
    const encryptedLocalBaseUrl = "https://localhost:8443/v1";
    const fetchImpl = vi.fn(async (input) =>
      String(input).endsWith("/props")
        ? jsonResponse({ n_ctx: 32_768 })
        : jsonResponse({}, 404),
    );

    expect(
      await detectOpenAiCompatibleContextLength({
        baseUrl: encryptedLocalBaseUrl,
        model,
        credential,
        fetchImpl,
      }),
    ).toBe(32_768);
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(String(url).startsWith("https://localhost:8443/")).toBe(true);
      expect(new Headers(init.headers).get("authorization")).toBe(
        `Bearer ${credential}`,
      );
      expect(String(url)).not.toContain(credential);
    }
  });

  it("rejects a malformed runtime endpoint response", async function () {
    const error = await captureError(
      detectOpenAiCompatibleContextLength({
        baseUrl,
        model,
        fetchImpl: vi.fn(async () => jsonResponse({ details: {} })),
      }),
    );
    expect(error).toBeInstanceOf(AgentGatewayError);
    expect(error).toMatchObject({
      code: "AI_PROVIDER_SCHEMA_INVALID",
      category: "schema",
      retryable: false,
    });
  });

  it.each([
    { name: "string context length", contextLength: "32768" },
    { name: "implausibly large context length", contextLength: 10_000_001 },
  ])(
    "leaves unusable runtime metadata unknown: $name",
    async function ({ contextLength }) {
      const fetchImpl = vi.fn(async (input) =>
        String(input).endsWith("/api/ps")
          ? jsonResponse({
              models: [{ name: model, context_length: contextLength }],
            })
          : jsonResponse({}, 404),
      );

      expect(
        await detectOpenAiCompatibleContextLength({
          baseUrl,
          model,
          fetchImpl,
        }),
      ).toBeNull();
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    },
  );

  it("rejects an oversized metadata response before parsing it", async function () {
    const fetchImpl = vi.fn(async (input) =>
      String(input).endsWith("/props")
        ? new Response(
            JSON.stringify({
              n_ctx: 32_768,
              padding: "x".repeat(1_100_000),
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          )
        : jsonResponse({}, 404),
    );
    const error = await captureError(
      detectOpenAiCompatibleContextLength({ baseUrl, model, fetchImpl }),
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

  it("classifies authentication failure without reading provider prose", async function () {
    const cancel = vi.fn();
    const error = await captureError(
      detectOpenAiCompatibleContextLength({
        baseUrl: "https://localhost:11434/v1",
        model,
        credential,
        fetchImpl: vi.fn(
          async () =>
            new Response(
              new ReadableStream({
                pull() {},
                cancel,
              }),
              { status: 401 },
            ),
        ),
      }),
    );
    expect(error).toMatchObject({
      code: "AI_PROVIDER_AUTHENTICATION_ERROR",
      category: "authentication",
      retryable: false,
    });
    expect(String(error)).not.toContain(credential);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
