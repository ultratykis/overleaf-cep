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

function chatCompletionResponse() {
  return jsonResponse({
    id: "context-probe",
    object: "chat.completion",
    choices: [
      {
        index: 0,
        finish_reason: "length",
        message: { role: "assistant", content: "OK" },
      },
    ],
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
  it("probes Chat Completions before observing Ollama's request allocation", async function () {
    let runningContextLength = 32_768;
    const fetchImpl = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/chat/completions")) {
        expect(init).toMatchObject({ method: "POST" });
        expect(JSON.parse(init.body)).toEqual({
          model,
          messages: [{ role: "user", content: "." }],
          max_tokens: 1,
          stream: false,
        });
        expect(JSON.parse(init.body)).not.toHaveProperty("options");
        expect(JSON.parse(init.body)).not.toHaveProperty("num_ctx");
        runningContextLength = 4_096;
        return chatCompletionResponse();
      }
      if (url.endsWith("/api/ps")) {
        return jsonResponse({
          models: [{ name: model, context_length: runningContextLength }],
        });
      }
      return jsonResponse({ n_ctx: 131_072 });
    });

    expect(
      await detectOpenAiCompatibleContextLength({ baseUrl, model, fetchImpl }),
    ).toBe(4_096);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:11434/v1/chat/completions",
      "http://127.0.0.1:11434/api/ps",
    ]);
  });

  it("adds the configured API version to the probe and metadata URLs", async function () {
    const apiVersion = "2025-01-01-preview";
    const fetchImpl = vi.fn(async (input) => {
      const url = String(input);
      if (url.includes("/chat/completions?")) return chatCompletionResponse();
      if (url.includes("/api/ps?")) {
        return jsonResponse({
          models: [{ name: model, context_length: 16_384 }],
        });
      }
      return jsonResponse({}, 404);
    });

    expect(
      await detectOpenAiCompatibleContextLength({
        baseUrl,
        apiVersion,
        model,
        fetchImpl,
      }),
    ).toBe(16_384);
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      `${baseUrl}/chat/completions?api-version=${apiVersion}`,
      `http://127.0.0.1:11434/api/ps?api-version=${apiVersion}`,
    ]);
  });

  it("uses the smallest llama.cpp slot allocation before model properties", async function () {
    const fetchImpl = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/chat/completions")) return chatCompletionResponse();
      if (url.endsWith("/api/ps")) return jsonResponse({}, 404);
      if (url.endsWith("/slots")) {
        return jsonResponse([{ n_ctx: 16_384 }, { n_ctx: 8_192 }]);
      }
      return jsonResponse({ n_ctx: 131_072 });
    });

    expect(
      await detectOpenAiCompatibleContextLength({ baseUrl, model, fetchImpl }),
    ).toBe(8_192);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:11434/v1/chat/completions",
      "http://127.0.0.1:11434/api/ps",
      "http://127.0.0.1:11434/slots",
    ]);
  });

  it("uses llama.cpp properties when slots are unavailable", async function () {
    const fetchImpl = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/chat/completions")) return chatCompletionResponse();
      if (url.endsWith("/props")) {
        return jsonResponse({ default_generation_settings: { n_ctx: 32_768 } });
      }
      return jsonResponse({}, 404);
    });

    expect(
      await detectOpenAiCompatibleContextLength({ baseUrl, model, fetchImpl }),
    ).toBe(32_768);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("leaves missing runtime metadata unknown instead of using a model maximum", async function () {
    const fetchImpl = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/chat/completions")) return chatCompletionResponse();
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
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "http://127.0.0.1:11434/v1/chat/completions",
      "http://127.0.0.1:11434/api/ps",
      "http://127.0.0.1:11434/slots",
      "http://127.0.0.1:11434/props",
    ]);
  });

  it("uses llama.cpp slots after the probe exceeds its own timeout", async function () {
    const probeSignal = AbortSignal.timeout(5);
    const fetchImpl = vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/chat/completions")) {
        return await new Promise((_, reject) => {
          if (init.signal.aborted) {
            reject(init.signal.reason);
            return;
          }
          init.signal.addEventListener(
            "abort",
            () => reject(init.signal.reason),
            { once: true },
          );
        });
      }
      if (url.endsWith("/slots")) {
        return jsonResponse([{ model, n_ctx: 16_384 }]);
      }
      return jsonResponse({}, 404);
    });

    expect(
      await detectOpenAiCompatibleContextLength({
        baseUrl,
        model,
        probeSignal,
        fetchImpl,
      }),
    ).toBe(16_384);
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:11434/v1/chat/completions",
      "http://127.0.0.1:11434/slots",
    ]);
  });

  it("does not fall back after caller cancellation", async function () {
    const caller = new AbortController();
    /** @type {() => void} */
    let markProbeStarted = () => {};
    const probeStarted = new Promise((resolve) => {
      markProbeStarted = () => resolve();
    });
    const fetchImpl = vi.fn(async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:11434/v1/chat/completions");
      markProbeStarted();
      return await new Promise((_, reject) => {
        init.signal.addEventListener(
          "abort",
          () => reject(init.signal.reason),
          { once: true },
        );
      });
    });
    const captured = captureError(
      detectOpenAiCompatibleContextLength({
        baseUrl,
        model,
        signal: caller.signal,
        probeSignal: caller.signal,
        fetchImpl,
      }),
    );
    await probeStarted;
    caller.abort(new DOMException("cancelled", "AbortError"));

    expect(await captured).toMatchObject({
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("uses llama.cpp properties after a non-2xx probe response", async function () {
    const fetchImpl = vi.fn(async (input) => {
      const url = String(input);
      if (url.endsWith("/chat/completions")) {
        return jsonResponse(
          { error: { message: "PRIVATE_CHAT_TEMPLATE_FAILURE" } },
          503,
        );
      }
      if (url.endsWith("/props")) {
        return jsonResponse({ default_generation_settings: { n_ctx: 32_768 } });
      }
      return jsonResponse({}, 404);
    });

    expect(
      await detectOpenAiCompatibleContextLength({ baseUrl, model, fetchImpl }),
    ).toBe(32_768);
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:11434/v1/chat/completions",
      "http://127.0.0.1:11434/slots",
      "http://127.0.0.1:11434/props",
    ]);
  });

  it("keeps Ollama unavailable instead of reading stale /api/ps after a failed probe", async function () {
    const fetchImpl = vi.fn(async (input) => {
      if (String(input).endsWith("/chat/completions")) {
        return jsonResponse(
          { error: { message: "PRIVATE_PROBE_FAILURE" } },
          500,
        );
      }
      return String(input).endsWith("/api/ps")
        ? jsonResponse({
            models: [{ name: model, context_length: 32_768 }],
          })
        : jsonResponse({}, 404);
    });

    expect(
      await detectOpenAiCompatibleContextLength({ baseUrl, model, fetchImpl }),
    ).toBeNull();
    expect(fetchImpl.mock.calls.map(([url]) => String(url))).toEqual([
      "http://127.0.0.1:11434/v1/chat/completions",
      "http://127.0.0.1:11434/slots",
      "http://127.0.0.1:11434/props",
    ]);
    expect(fetchImpl.mock.calls.flat()).not.toContain(
      "http://127.0.0.1:11434/api/ps",
    );
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
    const fetchImpl = vi.fn(async (input) => {
      if (String(input).endsWith("/chat/completions")) {
        return chatCompletionResponse();
      }
      return String(input).endsWith("/props")
        ? jsonResponse({ n_ctx: 32_768 })
        : jsonResponse({}, 404);
    });

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
        fetchImpl: vi.fn(async (input) =>
          String(input).endsWith("/chat/completions")
            ? chatCompletionResponse()
            : jsonResponse({ details: {} }),
        ),
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
        String(input).endsWith("/chat/completions")
          ? chatCompletionResponse()
          : String(input).endsWith("/api/ps")
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
      expect(fetchImpl).toHaveBeenCalledTimes(4);
    },
  );

  it("rejects an oversized metadata response before parsing it", async function () {
    const fetchImpl = vi.fn(async (input) =>
      String(input).endsWith("/chat/completions")
        ? chatCompletionResponse()
        : String(input).endsWith("/props")
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
