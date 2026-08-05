import { APICallError, simulateReadableStream } from "ai";
import { describe, expect, it, vi } from "vitest";

import { AgentGatewayError } from "../../../app/src/AgentGateway.mjs";
import {
  ClaudeAiSdkTransport,
  GeminiAiSdkTransport,
} from "../../../app/src/OllamaOpenAiTransport.mjs";

const credential = "PRIVATE_NATIVE_PROVIDER_CREDENTIAL";
const createdAt = "2026-07-26T00:00:00.000Z";

const providers = [
  {
    name: "gemini",
    model: "gemini-2.5-pro",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    Transport: GeminiAiSdkTransport,
  },
  {
    name: "claude",
    model: "claude-sonnet-4-20250514",
    baseUrl: "https://api.anthropic.com/v1",
    Transport: ClaudeAiSdkTransport,
  },
];

function usage(inputTokens = 12, outputTokens = 3) {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: inputTokens,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: outputTokens,
      text: outputTokens,
      reasoning: undefined,
    },
  };
}

function generateResult(overrides = {}) {
  return {
    content: [{ type: "text", text: "COMPAT_OK" }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: usage(),
    warnings: [],
    ...overrides,
  };
}

function nativeTransportFixture({ Transport, model: modelId, fetchImpl } = {}) {
  const model = {
    specificationVersion: "v3",
    provider: "untrusted-provider-name",
    modelId,
    supportedUrls: {},
    doGenerate: vi.fn(),
    doStream: vi.fn(),
  };
  const provider = vi.fn(() => model);
  const createProvider = vi.fn(() => provider);
  const transport = new Transport({
    credential,
    modelTag: modelId,
    createProvider,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
  return { createProvider, model, provider, transport };
}

async function captureError(work) {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject.");
}

async function collect(stream) {
  const values = [];
  for await (const value of stream) {
    values.push(value);
  }
  return values;
}

function discussionRequest() {
  return {
    requestId: "native-discussion-request-0001",
    discussionId: "native-discussion-0001",
    projectId: "native-project-0001",
    subject: null,
    turns: [{ role: "user", text: "Explain this synthetic case." }],
  };
}

describe("AI reviewer: native AI SDK provider transports", function () {
  it.each(providers)(
    "constructs the real $name package without making a request",
    function ({ name, model: modelId, Transport }) {
      const fetchImpl = vi.fn();
      const transport = new Transport({
        credential,
        modelTag: modelId,
        fetchImpl,
      });
      const gateway = transport.createDiscussionGateway({
        contextLength: 8_192,
      });

      expect(gateway).toMatchObject({
        provider: name,
        modelId,
        providerOptions: {},
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each(providers)(
    "constructs $name from its provider package with only the fixed official base URL",
    async function ({ name, model: modelId, baseUrl, Transport }) {
      const fixture = nativeTransportFixture({ Transport, model: modelId });
      fixture.model.doGenerate.mockResolvedValue(generateResult());

      expect(fixture.createProvider).toHaveBeenCalledOnce();
      const providerOptions = fixture.createProvider.mock.calls[0][0];
      expect(providerOptions).toEqual({
        apiKey: credential,
        baseURL: baseUrl,
        fetch: expect.any(Function),
        name,
      });
      expect(fixture.provider).toHaveBeenCalledExactlyOnceWith(modelId);

      expect(
        await fixture.transport.generateChat({
          prompt: "Return exactly COMPAT_OK and nothing else.",
        }),
      ).toEqual({
        type: "completed",
        text: "COMPAT_OK",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 12, outputTokens: 3 },
      });
      expect(fixture.model.doGenerate.mock.calls[0][0]).toMatchObject({
        providerOptions: {},
      });
      expect(fixture.model.doGenerate.mock.calls[0][0]).not.toHaveProperty(
        "maxOutputTokens",
      );
    },
  );

  it.each(providers)(
    "applies the shared strict non-stream envelope to $name",
    async function ({ model: modelId, Transport }) {
      const secret = "PRIVATE_NATIVE_PROVIDER_WARNING";
      const fixture = nativeTransportFixture({ Transport, model: modelId });
      fixture.model.doGenerate.mockResolvedValue(
        generateResult({
          warnings: [{ type: "other", message: secret }],
        }),
      );

      const error = await captureError(
        fixture.transport.generateChat({
          prompt: "Return exactly COMPAT_OK and nothing else.",
        }),
      );
      expect(error).toBeInstanceOf(AgentGatewayError);
      expect(error).toMatchObject({
        code: "AI_PROVIDER_SCHEMA_INVALID",
        category: "schema",
        retryable: false,
      });
      expect(String(error)).not.toContain(secret);
    },
  );

  it.each(providers)(
    "passes $name discussion streams through the shared bounded gateway normalizer",
    async function ({ name, model: modelId, Transport }) {
      const secret = "PRIVATE_NATIVE_STREAM_WARNING";
      const fixture = nativeTransportFixture({ Transport, model: modelId });
      fixture.model.doStream.mockResolvedValue({
        stream: simulateReadableStream({
          chunks: [
            {
              type: "stream-start",
              warnings: [{ type: "other", message: secret }],
            },
            { type: "text-start", id: "native-text-0001" },
            {
              type: "text-delta",
              id: "native-text-0001",
              delta: "Bounded native response.",
            },
            { type: "text-end", id: "native-text-0001" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: usage(),
            },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      });
      let id = 0;
      const gateway = fixture.transport.createDiscussionGateway({
        contextLength: 8_192,
        now: () => createdAt,
        createId: (kind) => `${kind}-${(id += 1)}`,
      });

      const events = await collect(
        gateway.streamDiscussion(discussionRequest()),
      );
      expect(events).toEqual([
        expect.objectContaining({
          type: "started",
          provider: name,
          model: modelId,
        }),
        expect.objectContaining({
          type: "text.delta",
          delta: "Bounded native response.",
        }),
        expect.objectContaining({
          type: "completed",
          finishReason: "stop",
        }),
      ]);
      expect(JSON.stringify(events)).not.toContain(secret);
      expect(fixture.model.doStream.mock.calls[0][0]).toMatchObject({
        providerOptions: {},
      });
      expect(
        fixture.model.doStream.mock.calls[0][0].maxOutputTokens,
      ).toBeUndefined();
    },
  );

  it.each(providers)(
    "classifies a marked 429 from $name as a provider rate limit",
    async function ({ model: modelId, Transport }) {
      const sentinel = "PRIVATE_NATIVE_RATE_LIMIT_BODY";
      const fixture = nativeTransportFixture({ Transport, model: modelId });
      fixture.model.doStream.mockRejectedValue(
        new APICallError({
          message: sentinel,
          url: "https://provider.invalid/v1/review",
          requestBodyValues: { prompt: sentinel },
          statusCode: 429,
          responseBody: sentinel,
          isRetryable: true,
        }),
      );
      const gateway = fixture.transport.createDiscussionGateway({
        contextLength: 8_192,
      });

      const error = await captureError(
        collect(gateway.streamDiscussion(discussionRequest())),
      );

      expect(error).toMatchObject({
        code: "AI_PROVIDER_RATE_LIMITED",
        category: "rate-limit",
        retryable: true,
        providerStatusCode: 429,
        providerErrorType: "AI_APICallError",
      });
      expect(String(error)).not.toContain(sentinel);
      expect(JSON.stringify(error)).not.toContain(sentinel);
    },
  );

  it.each(providers)(
    "refuses $name redirects in the provider fetch seam",
    async function ({ model: modelId, baseUrl, Transport }) {
      const fetchImpl = vi.fn(async () =>
        Response.redirect("https://redirect.example.test/", 302),
      );
      const fixture = nativeTransportFixture({
        Transport,
        model: modelId,
        fetchImpl,
      });
      const providerFetch = fixture.createProvider.mock.calls[0][0].fetch;

      const error = await captureError(
        providerFetch(`${baseUrl}/models/test:generateContent`, {
          method: "POST",
        }),
      );
      expect(error).toBeInstanceOf(AgentGatewayError);
      expect(error).toMatchObject({
        code: "AI_PROVIDER_REDIRECT_REJECTED",
        category: "provider",
        retryable: false,
      });
      expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
        `${baseUrl}/models/test:generateContent`,
        expect.objectContaining({ redirect: "error" }),
      );
    },
  );

  it.each(providers)(
    "refuses a nonofficial $name request URL before sending credentials",
    async function ({ model: modelId, Transport }) {
      const fetchImpl = vi.fn();
      const fixture = nativeTransportFixture({
        Transport,
        model: modelId,
        fetchImpl,
      });
      const providerFetch = fixture.createProvider.mock.calls[0][0].fetch;

      const error = await captureError(
        providerFetch("https://untrusted-provider.example.test/v1/messages", {
          method: "POST",
        }),
      );
      expect(error).toBeInstanceOf(AgentGatewayError);
      expect(error).toMatchObject({
        code: "AI_PROVIDER_CONFIGURATION_INVALID",
        category: "configuration",
        retryable: false,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
});
