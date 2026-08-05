// @ts-check

import { AgentGatewayAbortError, AgentGatewayError } from "./AgentGateway.mjs";
import {
  parseAiReviewerConnection,
  parseAiReviewerProviderConfig,
} from "./AiReviewerProviderConfig.mjs";
import { resolveModelContextLength } from "./ModelContextLength.mjs";
import {
  parseOpenAiCompatibleBaseUrl,
  parseOpenAiCompatibleModelId,
} from "./OllamaEndpointPolicy.mjs";
import {
  ClaudeAiSdkTransport,
  createGuardedOpenAiCompatibleFetch,
  detectOpenAiCompatibleContextLength,
  GeminiAiSdkTransport,
  OllamaOpenAiTransport,
} from "./OllamaOpenAiTransport.mjs";

const MODEL_CACHE_TTL_MILLISECONDS = 60_000;
const MAX_MODEL_COUNT = 1_000;
const MAX_MODEL_RESPONSE_BYTES = 1_048_576;
const MAX_MODEL_RESPONSE_CHUNKS = 512;
const NATIVE_MODEL_ENDPOINTS = Object.freeze({
  gemini: "https://generativelanguage.googleapis.com/v1beta/models",
  claude: "https://api.anthropic.com/v1/models",
});
const NON_GENERATION_OPENAI_MODEL =
  /(?:^|[-_.:/])(audio|dall-e|embed(?:ding)?s?|image|moderation|realtime|speech|transcri(?:be|ption)|tts|whisper)(?:$|[-_.:/])/iu;
const NON_GENERATION_CLAUDE_MODEL =
  /(?:^|[-_.:/])(audio|embed(?:ding)?s?|image)(?:$|[-_.:/])/iu;

/** @param {AbortSignal | undefined} signal */
function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof AgentGatewayError
      ? signal.reason
      : new AgentGatewayAbortError();
  }
}

/** @param {ReturnType<typeof parseAiReviewerProviderConfig>} config */
function requireNativeCredential(config) {
  if (
    config.provider !== "openai-compatible" &&
    typeof config.credential !== "string"
  ) {
    throw new AgentGatewayError("The AI provider credential is required.", {
      code: "AI_PROVIDER_NOT_CONFIGURED",
      category: "configuration",
      retryable: false,
    });
  }
  return config.credential;
}

function modelDiscoveryUnsupported() {
  return new AgentGatewayError(
    "The AI provider does not expose a supported model list.",
    {
      code: "AI_PROVIDER_MODEL_DISCOVERY_UNSUPPORTED",
      category: "configuration",
      retryable: false,
    },
  );
}

function invalidModelResponse() {
  return new AgentGatewayError("The AI provider returned invalid data.", {
    code: "AI_PROVIDER_SCHEMA_INVALID",
    category: "schema",
    retryable: false,
  });
}

/** @param {Response} response */
function cancelResponseBody(response) {
  try {
    const cancelled = response.body?.cancel();
    if (cancelled && typeof cancelled.catch === "function") {
      cancelled.catch(() => {});
    }
  } catch {
    // Rejected response bodies are never exposed or logged.
  }
}

/** @param {Response} response */
function providerHttpError(response) {
  cancelResponseBody(response);
  if (response.status === 401 || response.status === 403) {
    return new AgentGatewayError("The AI provider rejected its credentials.", {
      code: "AI_PROVIDER_AUTHENTICATION_ERROR",
      category: "authentication",
      retryable: false,
      providerStatusCode: response.status,
    });
  }
  if (
    response.status === 404 ||
    response.status === 405 ||
    response.status === 501
  ) {
    return modelDiscoveryUnsupported();
  }
  if (response.status === 429) {
    return new AgentGatewayError("The AI provider rate limit was reached.", {
      code: "AI_PROVIDER_RATE_LIMITED",
      category: "rate-limit",
      retryable: true,
      providerStatusCode: response.status,
    });
  }
  return new AgentGatewayError("The AI provider request failed.", {
    code: "AI_PROVIDER_ERROR",
    category: "provider",
    retryable: response.status >= 500,
    providerStatusCode: response.status,
  });
}

/**
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {AbortSignal | undefined} signal
 */
async function readModelChunk(reader, signal) {
  if (signal == null) {
    return await reader.read();
  }
  throwIfAborted(signal);
  let onAborted = () => {};
  const aborted = new Promise((_, reject) => {
    onAborted = () => {
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener("abort", onAborted, { once: true });
  });
  try {
    return await Promise.race([reader.read(), aborted]);
  } finally {
    signal.removeEventListener("abort", onAborted);
  }
}

/** @param {Response} response @param {AbortSignal | undefined} signal */
async function readBoundedModelResponse(response, signal) {
  const contentLength = Number(response.headers.get("content-length"));
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_MODEL_RESPONSE_BYTES
  ) {
    cancelResponseBody(response);
    throw invalidModelResponse();
  }
  if (response.body == null) {
    throw modelDiscoveryUnsupported();
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let chunks = 0;
  let text = "";
  try {
    while (true) {
      throwIfAborted(signal);
      const step = await readModelChunk(reader, signal);
      if (step.done) break;
      chunks += 1;
      bytes += step.value.byteLength;
      if (
        chunks > MAX_MODEL_RESPONSE_CHUNKS ||
        bytes > MAX_MODEL_RESPONSE_BYTES
      ) {
        throw invalidModelResponse();
      }
      text += decoder.decode(step.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    try {
      const cancelled = reader.cancel();
      if (cancelled && typeof cancelled.catch === "function") {
        cancelled.catch(() => {});
      }
    } catch {
      // The bounded public error does not depend on cancellation success.
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw modelDiscoveryUnsupported();
  }
}

/** @param {unknown} value */
function safeDisplayName(value) {
  return typeof value === "string" &&
    value.trim().length > 0 &&
    value.trim().length <= 256 &&
    // eslint-disable-next-line no-control-regex -- display names reject controls
    !/[\u0000-\u001f\u007f]/u.test(value)
    ? value.trim()
    : null;
}

/** @param {unknown} value */
function safeModelId(value) {
  try {
    return parseOpenAiCompatibleModelId(value);
  } catch {
    return null;
  }
}

/**
 * Ollama reports what each model can actually do, but only on its own
 * `/api/tags` route: the OpenAI-compatible `/v1/models` list carries no
 * capabilities. When those are available they decide inclusion, because a name
 * pattern cannot tell that `bge-m3` is embedding-only. Anything not named in
 * the map falls back to the pattern.
 *
 * @param {ReturnType<typeof parseAiReviewerProviderConfig>["provider"]} provider
 * @param {unknown} input
 * @param {Map<string, string[]> | null} [capabilities]
 */
function normalizeModels(provider, input, capabilities = null) {
  const root = /** @type {any} */ (input);
  const entries =
    provider === "openai-compatible"
      ? root?.data
      : provider === "gemini"
        ? root?.models
        : root?.data;
  if (!Array.isArray(entries) || entries.length > MAX_MODEL_COUNT) {
    throw modelDiscoveryUnsupported();
  }
  const seen = new Set();
  const models = [];
  for (const entry of entries) {
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const candidate = /** @type {any} */ (entry);
    const rawId =
      provider === "gemini" && typeof candidate.name === "string"
        ? candidate.name.replace(/^models\//u, "")
        : candidate.id;
    const id = safeModelId(rawId);
    if (id == null || seen.has(id)) continue;
    const declared = capabilities?.get(id) ?? null;
    if (provider === "openai-compatible" && declared !== null) {
      // A review needs a tool round trip, so a model that only completes text
      // is as unusable here as an embedding model.
      if (!declared.includes("tools")) {
        continue;
      }
    } else if (
      (provider === "openai-compatible" &&
        NON_GENERATION_OPENAI_MODEL.test(id)) ||
      (provider === "gemini" &&
        (!Array.isArray(candidate.supportedGenerationMethods) ||
          !candidate.supportedGenerationMethods.includes("generateContent"))) ||
      (provider === "claude" && NON_GENERATION_CLAUDE_MODEL.test(id))
    ) {
      continue;
    }
    const displayName =
      safeDisplayName(
        provider === "gemini"
          ? candidate.displayName
          : provider === "claude"
            ? candidate.display_name
            : candidate.name,
      ) ?? id;
    seen.add(id);
    models.push(Object.freeze({ id, displayName }));
  }
  if (models.length === 0) {
    throw modelDiscoveryUnsupported();
  }
  return Object.freeze(models);
}

/**
 * Ask an OpenAI-compatible endpoint for Ollama's native model list, which is
 * the only place its capabilities appear. Servers that are not Ollama answer
 * 404 and the caller keeps its pattern-based filter, so this never turns a
 * working list into a failure.
 *
 * @param {string} baseUrl
 * @param {(input: string, init: any) => Promise<Response>} guardedFetch
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<Map<string, string[]> | null>}
 */
async function fetchOllamaCapabilities(baseUrl, guardedFetch, signal) {
  try {
    const response = await guardedFetch(`${baseUrl}/api/tags`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal,
    });
    if (!response.ok) {
      cancelResponseBody(response);
      return null;
    }
    const body = /** @type {any} */ (
      await readBoundedModelResponse(response, signal)
    );
    if (!Array.isArray(body?.models)) {
      return null;
    }
    const capabilities = new Map();
    for (const entry of body.models) {
      const id = safeModelId(entry?.name ?? entry?.model);
      if (id == null || !Array.isArray(entry?.capabilities)) {
        continue;
      }
      capabilities.set(
        id,
        entry.capabilities.filter(
          (/** @type {unknown} */ value) => typeof value === "string",
        ),
      );
    }
    return capabilities.size === 0 ? null : capabilities;
  } catch {
    return null;
  }
}

/**
 * @param {ReturnType<typeof parseAiReviewerConnection>} config
 * @returns {{ endpoint: string, baseUrl: string }}
 */
function modelEndpoint(config) {
  switch (config.provider) {
    case "openai-compatible": {
      const parsedEndpoint = parseOpenAiCompatibleBaseUrl(config.baseUrl);
      return {
        endpoint: `${parsedEndpoint.baseUrl}/models`,
        baseUrl: parsedEndpoint.baseUrl,
      };
    }
    case "gemini":
      return {
        endpoint: NATIVE_MODEL_ENDPOINTS.gemini,
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      };
    case "claude":
      return {
        endpoint: NATIVE_MODEL_ENDPOINTS.claude,
        baseUrl: "https://api.anthropic.com/v1",
      };
  }
  throw new TypeError("Unsupported AI provider.");
}

/** @param {any} [dependencies] */
export function createAiReviewerProviderService(dependencies = {}) {
  const contextLengthDetector =
    dependencies.contextLengthDetector ?? detectOpenAiCompatibleContextLength;
  const contextLengthDetectionSignalFactory =
    dependencies.contextLengthDetectionSignalFactory ??
    (() => AbortSignal.timeout(5_000));
  const openAiCompatibleTransportFactory =
    dependencies.openAiCompatibleTransportFactory ??
    dependencies.transportFactory ??
    ((
      /** @type {{ baseUrl: string, credential?: string, modelTag: string }} */ options,
    ) => new OllamaOpenAiTransport(options));
  const geminiTransportFactory =
    dependencies.geminiTransportFactory ??
    ((/** @type {{ credential: string, modelTag: string }} */ options) =>
      new GeminiAiSdkTransport(options));
  const claudeTransportFactory =
    dependencies.claudeTransportFactory ??
    ((/** @type {{ credential: string, modelTag: string }} */ options) =>
      new ClaudeAiSdkTransport(options));
  const modelFetchImpl = dependencies.modelFetchImpl ?? globalThis.fetch;
  const modelCacheTtlMilliseconds =
    dependencies.modelCacheTtlMilliseconds ?? MODEL_CACHE_TTL_MILLISECONDS;
  const modelNow = dependencies.modelNow ?? (() => Date.now());
  const modelCache = new Map();

  /** @param {ReturnType<typeof parseAiReviewerProviderConfig>} config */
  function createTransport(config) {
    switch (config.provider) {
      case "openai-compatible":
        return openAiCompatibleTransportFactory({
          baseUrl: config.baseUrl,
          credential: config.credential ?? undefined,
          modelTag: config.model,
        });
      case "gemini":
        return geminiTransportFactory({
          credential: requireNativeCredential(config),
          modelTag: config.model,
        });
      case "claude":
        return claudeTransportFactory({
          credential: requireNativeCredential(config),
          modelTag: config.model,
        });
    }
  }

  /**
   * @param {unknown} input
   * @param {{ signal?: AbortSignal, cacheKey?: string }} [options]
   */
  async function listModels(input, { signal, cacheKey = "" } = {}) {
    throwIfAborted(signal);
    const config = parseAiReviewerConnection(input);
    const { endpoint, baseUrl } = modelEndpoint(config);
    const effectiveCacheKey = [
      cacheKey,
      config.provider,
      baseUrl,
      config.credentialUpdatedAt ?? "",
    ].join("\u0000");
    const now = modelNow();
    const cached = modelCache.get(effectiveCacheKey);
    if (cached?.expiresAt > now) {
      return cached.models;
    }
    modelCache.delete(effectiveCacheKey);

    /** @type {Record<string, string>} */
    const headers = { Accept: "application/json" };
    if (typeof config.credential === "string") {
      if (config.provider === "gemini") {
        headers["x-goog-api-key"] = config.credential;
      } else if (config.provider === "claude") {
        headers["x-api-key"] = config.credential;
        headers["anthropic-version"] = "2023-06-01";
      } else {
        headers.Authorization = `Bearer ${config.credential}`;
      }
    }
    // Ollama serves its OpenAI shim under `/v1` and its native routes at the
    // origin root, so drop one trailing `/v1` to reach `/api/tags`.
    const nativeBaseUrl = baseUrl.replace(/\/v1$/u, "");
    const guardedFetch = createGuardedOpenAiCompatibleFetch({
      baseUrl,
      allowedRequestUrl: endpoint,
      fetchImpl: modelFetchImpl,
    });
    const response = await guardedFetch(endpoint, {
      method: "GET",
      headers,
      signal,
    });
    if (!response.ok) {
      throw providerHttpError(response);
    }
    const body = await readBoundedModelResponse(response, signal);
    // Only an OpenAI-compatible endpoint can be Ollama, and its native list
    // sits outside the configured base, so it needs its own pinned fetch.
    const capabilities =
      config.provider === "openai-compatible"
        ? await fetchOllamaCapabilities(
            nativeBaseUrl,
            createGuardedOpenAiCompatibleFetch({
              baseUrl: nativeBaseUrl,
              allowedRequestUrl: `${nativeBaseUrl}/api/tags`,
              fetchImpl: modelFetchImpl,
            }),
            signal,
          )
        : null;
    const models = normalizeModels(config.provider, body, capabilities);
    modelCache.set(effectiveCacheKey, {
      expiresAt: now + modelCacheTtlMilliseconds,
      models,
    });
    return models;
  }

  return {
    listModels,

    /**
     * Resolve the context length of one (connection, model) pair. A connection
     * no longer stores this, so every run resolves it again from the model it
     * actually selected, and only the connection's escape hatch overrides it.
     *
     * @param {unknown} input
     * @param {unknown} model
     */
    async resolveContextLength(input, model) {
      const connection = parseAiReviewerConnection(input);
      return await resolveModelContextLength(
        {
          provider: connection.provider,
          ...(connection.provider === "openai-compatible"
            ? { baseUrl: connection.baseUrl }
            : {}),
          model: parseOpenAiCompatibleModelId(model),
          ...(typeof connection.credential === "string"
            ? { credential: connection.credential }
            : {}),
          contextLengthOverride: connection.contextLengthOverride ?? null,
        },
        {
          detectOpenAiCompatibleContextLength: async (candidate) =>
            await contextLengthDetector({
              ...candidate,
              signal: contextLengthDetectionSignalFactory(),
            }),
        },
      );
    },

    /**
     * Check one connection by asking it what it can run. Without a model there
     * is nothing else to try, and a listing already proves the endpoint
     * answered and accepted the stored credential.
     *
     * @param {unknown} input
     * @param {{ signal?: AbortSignal, cacheKey?: string }} [options]
     */
    async testConnection(input, { signal, cacheKey } = {}) {
      const config = parseAiReviewerConnection(input);
      const models = await listModels(config, { signal, cacheKey });
      return Object.freeze({
        ok: true,
        provider: config.provider,
        modelCount: models.length,
        classification:
          config.provider === "openai-compatible"
            ? parseOpenAiCompatibleBaseUrl(config.baseUrl).classification
            : "remote",
      });
    },

    /**
     * @param {unknown} input
     */
    createDiscussionGateway(input) {
      const config = parseAiReviewerProviderConfig(input);
      return createTransport(config).createDiscussionGateway({
        contextLength: config.contextLength,
      });
    },

    /**
     * @param {unknown} input
     * @param {{
     *   readProjectFile: Function,
     *   projectContext?: unknown,
     *   searchZotero?: Function,
     *   validateEvidence?: Function,
     * }} options
     */
    createAgentGateway(
      input,
      { readProjectFile, projectContext, searchZotero, validateEvidence },
    ) {
      const config = parseAiReviewerProviderConfig(input);
      if (typeof readProjectFile !== "function") {
        throw new TypeError("readProjectFile must be a function.");
      }
      return createTransport(config).createAgentGateway({
        contextLength: config.contextLength,
        readProjectFile,
        projectContext,
        searchZotero,
        validateEvidence,
      });
    },
  };
}

export const createOllamaProviderService = createAiReviewerProviderService;
