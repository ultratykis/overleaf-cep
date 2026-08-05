// @ts-check

import { AgentGatewayAbortError, AgentGatewayError } from "./AgentGateway.mjs";
import {
  parseAiReviewerConnection,
  parseAiReviewerProviderConfig,
} from "./AiReviewerProviderConfig.mjs";
import {
  modelContextLengthFromFields,
  resolveModelContextLength,
  resolveModelContextLengthWithoutDetection,
} from "./ModelContextLength.mjs";
import {
  assertOpenAiCompatibleCredentialTransport,
  parseOpenAiCompatibleBaseUrl,
  parseOpenAiCompatibleModelId,
} from "./OllamaEndpointPolicy.mjs";
import {
  AzureAiSdkTransport,
  ClaudeAiSdkTransport,
  createGuardedOpenAiCompatibleFetch,
  detectOpenAiCompatibleContextLength,
  GeminiAiSdkTransport,
  OllamaOpenAiTransport,
} from "./OllamaOpenAiTransport.mjs";

// Enough for a reasoning model to think and still answer. The check only has
// to prove the endpoint responded and accepted the credential.
const AZURE_CONNECTION_TEST_OUTPUT_TOKENS = 2048;

// The review route has a 60 second deadline. Reserve the former five-second
// metadata allowance for the fallback GETs after giving a cold model load the
// rest of that budget.
const CONTEXT_LENGTH_PROBE_TIMEOUT_MILLISECONDS = 55_000;
const MODEL_CACHE_TTL_MILLISECONDS = 60_000;
const MAX_MODEL_COUNT = 1_000;
const MAX_MODEL_RESPONSE_BYTES = 1_048_576;
const MAX_MODEL_RESPONSE_CHUNKS = 512;
const NATIVE_MODEL_ENDPOINTS = Object.freeze({
  gemini: "https://generativelanguage.googleapis.com/v1beta/models",
  claude: "https://api.anthropic.com/v1/models",
});
// Standard model-list responses usually omit output modality and tool support.
// Prefer advertised capabilities below; this version-independent family rule
// removes only names that unambiguously identify non-review workloads.
const NON_REVIEW_MODEL =
  /(?:^|[\s._:/-])(audio|computer[\s._:/-]*use|dall-e|deep[\s._:/-]*research|embed(?:ding)?s?|image|imagen|lyria|moderation|music|nano[\s._:/-]*banana|realtime|robotics|speech|transcri(?:be|ption)|tts|whisper)(?:$|[\s._:/-])/iu;

/** @param {AbortSignal | undefined} signal */
function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof AgentGatewayError
      ? signal.reason
      : new AgentGatewayAbortError();
  }
}

/** @param {{ provider: string, credential?: string | null }} config */
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
      provider === "gemini" &&
      (!Array.isArray(candidate.supportedGenerationMethods) ||
        !candidate.supportedGenerationMethods.includes("generateContent"))
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
    if (NON_REVIEW_MODEL.test(`${id} ${displayName}`)) continue;
    seen.add(id);
    const detectedContextLength = modelContextLengthFromFields(candidate);
    models.push(
      Object.freeze({
        id,
        displayName,
        ...(detectedContextLength == null ? {} : { detectedContextLength }),
      }),
    );
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
 * Ollama identifies its shim-owned models as `library` by default and uses
 * `ollama` for its hosted catalog. Requiring that marker keeps the native
 * extension behind evidence from the compatible response instead of guessing
 * a provider from its URL.
 *
 * @param {unknown} input
 */
function isOllamaCompatibleModelList(input) {
  const root = /** @type {any} */ (input);
  if (root?.object !== "list" || !Array.isArray(root.data)) {
    return false;
  }
  return (
    root.data.length > 0 &&
    root.data.every(
      (/** @type {any} */ entry) =>
        entry != null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        entry.object === "model" &&
        (entry.owned_by === "library" || entry.owned_by === "ollama"),
    )
  );
}

/** @param {string} baseUrl */
function ollamaNativeBaseUrl(baseUrl) {
  const nativeBaseUrl = baseUrl.replace(/\/v1$/u, "");
  return nativeBaseUrl === baseUrl ? null : nativeBaseUrl;
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
    (() => AbortSignal.timeout(CONTEXT_LENGTH_PROBE_TIMEOUT_MILLISECONDS));
  const openAiCompatibleTransportFactory =
    dependencies.openAiCompatibleTransportFactory ??
    dependencies.transportFactory ??
    ((
      /** @type {{ baseUrl: string, credential?: string, modelTag: string, reasoningModelCompatibility?: boolean }} */ options,
    ) => new OllamaOpenAiTransport(options));
  const geminiTransportFactory =
    dependencies.geminiTransportFactory ??
    ((/** @type {{ credential: string, modelTag: string, reasoningModelCompatibility?: boolean }} */ options) =>
      new GeminiAiSdkTransport(options));
  const claudeTransportFactory =
    dependencies.claudeTransportFactory ??
    ((/** @type {{ credential: string, modelTag: string, reasoningModelCompatibility?: boolean }} */ options) =>
      new ClaudeAiSdkTransport(options));
  const azureTransportFactory =
    dependencies.azureTransportFactory ??
    ((
      /** @type {{ baseUrl: string, requestStyle: "v1" | "deployment", apiVersion?: string, credential: string, modelTag: string, reasoningModelCompatibility?: boolean }} */ options,
    ) => new AzureAiSdkTransport(options));
  const modelFetchImpl = dependencies.modelFetchImpl ?? globalThis.fetch;
  const modelCacheTtlMilliseconds =
    dependencies.modelCacheTtlMilliseconds ?? MODEL_CACHE_TTL_MILLISECONDS;
  const contextLengthCacheTtlMilliseconds =
    dependencies.contextLengthCacheTtlMilliseconds ??
    MODEL_CACHE_TTL_MILLISECONDS;
  const modelNow = dependencies.modelNow ?? (() => Date.now());
  const modelCache = new Map();
  const contextLengthCache = new Map();
  const advertisedContextLengthCache = new Map();

  /**
   * @param {ReturnType<typeof parseAiReviewerConnection>} connection
   * @param {string} model
   */
  function contextLengthResolutionInput(
    connection,
    model,
    detectedContextLength = null,
  ) {
    const modelOverride =
      connection.provider === "azure"
        ? connection.contextLengthOverrides?.find(
            (entry) => entry.model === model,
          )?.contextLength
        : undefined;
    return {
      provider: connection.provider,
      ...(connection.provider === "openai-compatible" ||
      connection.provider === "azure"
        ? {
            baseUrl: connection.baseUrl,
            ...(connection.provider === "azure"
              ? {
                  requestStyle: connection.requestStyle,
                  apiVersion: connection.apiVersion,
                }
              : {}),
          }
        : {}),
      model,
      ...(typeof connection.credential === "string"
        ? { credential: connection.credential }
        : {}),
      contextLengthOverride:
        modelOverride ?? connection.contextLengthOverride ?? null,
      detectedContextLength,
    };
  }

  /**
   * Keep owner identity in the caller-provided prefix and credential material
   * out of the key. A credential rotation changes its server-owned timestamp.
   *
   * @param {ReturnType<typeof parseAiReviewerConnection>} connection
   * @param {string} model
   * @param {string} cacheKey
   */
  function contextLengthCacheKey(connection, model, cacheKey) {
    return [
      cacheKey || connection.id || "",
      connection.provider,
      connection.provider === "openai-compatible" ||
      connection.provider === "azure"
        ? connection.baseUrl
        : "",
      connection.provider === "azure" ? connection.requestStyle : "",
      connection.provider === "azure" ? (connection.apiVersion ?? "") : "",
      connection.credentialUpdatedAt ?? "",
      connection.contextLengthOverride ?? "",
      JSON.stringify(
        connection.provider === "azure"
          ? (connection.contextLengthOverrides ?? [])
          : [],
      ),
      model,
    ].join("\u0000");
  }

  /** @param {string} key */
  function cachedContextLength(key) {
    const cached = contextLengthCache.get(key);
    if (cached?.expiresAt > modelNow()) {
      return cached.resolution;
    }
    contextLengthCache.delete(key);
    return null;
  }

  /** @param {string} key */
  function cachedAdvertisedContextLength(key) {
    const cached = advertisedContextLengthCache.get(key);
    if (cached?.expiresAt > modelNow()) {
      return cached.contextLength;
    }
    advertisedContextLengthCache.delete(key);
    return null;
  }

  /** @param {ReturnType<typeof parseAiReviewerProviderConfig>} config */
  function createTransport(config) {
    switch (config.provider) {
      case "openai-compatible":
        return openAiCompatibleTransportFactory({
          baseUrl: config.baseUrl,
          credential: config.credential ?? undefined,
          modelTag: config.model,
          ...(config.reasoningModelCompatibility
            ? { reasoningModelCompatibility: true }
            : {}),
        });
      case "gemini":
        return geminiTransportFactory({
          credential: requireNativeCredential(config),
          modelTag: config.model,
          ...(config.reasoningModelCompatibility
            ? { reasoningModelCompatibility: true }
            : {}),
        });
      case "claude":
        return claudeTransportFactory({
          credential: requireNativeCredential(config),
          modelTag: config.model,
          ...(config.reasoningModelCompatibility
            ? { reasoningModelCompatibility: true }
            : {}),
        });
      case "azure":
        return azureTransportFactory({
          baseUrl: config.baseUrl,
          requestStyle: config.requestStyle,
          apiVersion: config.apiVersion,
          credential: requireNativeCredential(config),
          modelTag: config.model,
          ...(config.reasoningModelCompatibility
            ? { reasoningModelCompatibility: true }
            : {}),
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
    if ("baseUrl" in config) {
      // Check before cache lookup as well as before fetch: an entry populated by
      // an older process must not keep any plaintext credential connection usable.
      assertOpenAiCompatibleCredentialTransport(
        config.baseUrl,
        typeof config.credential === "string",
      );
    }
    if (config.provider === "azure") {
      // An Azure API key does not grant access to the management-plane
      // deployments listing. These are the deployment names the user entered,
      // not a catalogue inferred from an OpenAI-compatible endpoint.
      return Object.freeze(
        config.deployments.map((deployment) =>
          Object.freeze({ id: deployment, displayName: deployment }),
        ),
      );
    }
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
    // The standard list establishes both compatibility and Ollama identity
    // before the native route widens discovery beyond the configured base.
    const nativeBaseUrl = isOllamaCompatibleModelList(body)
      ? ollamaNativeBaseUrl(baseUrl)
      : null;
    const capabilities =
      config.provider === "openai-compatible" && nativeBaseUrl !== null
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
    const normalizedModels = normalizeModels(
      config.provider,
      body,
      capabilities,
    );
    const models = Object.freeze(
      normalizedModels.map(({ id, displayName }) =>
        Object.freeze({ id, displayName }),
      ),
    );
    for (const candidate of normalizedModels) {
      if (candidate.detectedContextLength == null) continue;
      advertisedContextLengthCache.set(
        contextLengthCacheKey(config, candidate.id, cacheKey),
        {
          expiresAt: now + modelCacheTtlMilliseconds,
          contextLength: candidate.detectedContextLength,
        },
      );
    }
    modelCache.set(effectiveCacheKey, {
      expiresAt: now + modelCacheTtlMilliseconds,
      models,
    });
    return models;
  }

  return {
    listModels,

    /**
     * Return a displayable value without starting metadata discovery. A prior
     * selected-model resolution wins while its cache entry is live; otherwise
     * the picker shows an override, an advertised value, or an unknown value.
     *
     * @param {unknown} input
     * @param {unknown} model
     * @param {{ cacheKey?: string }} [options]
     */
    contextLengthForModelList(input, model, { cacheKey = "" } = {}) {
      const connection = parseAiReviewerConnection(input);
      const parsedModel = parseOpenAiCompatibleModelId(model);
      const key = contextLengthCacheKey(connection, parsedModel, cacheKey);
      const advertised = cachedAdvertisedContextLength(key);
      return (
        cachedContextLength(key) ??
        resolveModelContextLengthWithoutDetection(
          contextLengthResolutionInput(connection, parsedModel, advertised),
        )
      );
    },

    /**
     * Resolve the context length of one (connection, model) pair. A connection
     * no longer stores this, so only the model a run actually selected may
     * start detection. A short-lived pair cache avoids repeating that request,
     * and only the connection's escape hatch overrides it.
     *
     * @param {unknown} input
     * @param {unknown} model
     * @param {{ signal?: AbortSignal, cacheKey?: string }} [options]
     */
    async resolveContextLength(input, model, { signal, cacheKey = "" } = {}) {
      throwIfAborted(signal);
      const connection = parseAiReviewerConnection(input);
      const parsedModel = parseOpenAiCompatibleModelId(model);
      const key = contextLengthCacheKey(connection, parsedModel, cacheKey);
      const cached = cachedContextLength(key);
      if (cached != null) {
        return cached;
      }
      const advertised = cachedAdvertisedContextLength(key);
      const resolution = await resolveModelContextLength(
        contextLengthResolutionInput(connection, parsedModel, advertised),
        {
          detectOpenAiCompatibleContextLength: async (candidate) => {
            const timeoutSignal = contextLengthDetectionSignalFactory();
            const probeSignal =
              signal == null
                ? timeoutSignal
                : timeoutSignal == null
                  ? signal
                  : AbortSignal.any([signal, timeoutSignal]);
            return await contextLengthDetector({
              ...candidate,
              ...(signal == null ? {} : { signal }),
              ...(probeSignal == null ? {} : { probeSignal }),
            });
          },
        },
      );
      // Detection is best-effort, but the caller's cancellation is not. The
      // resolver may convert detector failures to an advertised or unknown
      // value, so re-check the route signal before caching or starting a review.
      throwIfAborted(signal);
      if (resolution.contextLength != null) {
        contextLengthCache.set(key, {
          expiresAt: modelNow() + contextLengthCacheTtlMilliseconds,
          resolution,
        });
      }
      return resolution;
    },

    /**
     * Check one connection by asking it what it can run. Catalogue providers
     * can prove the endpoint and credential through their list. Azure has no
     * data-plane deployment list, so check its first user-entered deployment.
     *
     * @param {unknown} input
     * @param {{ signal?: AbortSignal, cacheKey?: string }} [options]
     */
    async testConnection(input, { signal, cacheKey } = {}) {
      const config = parseAiReviewerConnection(input);
      if ("baseUrl" in config) {
        // A connection test is an outbound credential path too, including the
        // Azure probe that does not pass through model listing.
        assertOpenAiCompatibleCredentialTransport(
          config.baseUrl,
          typeof config.credential === "string",
        );
      }
      if (config.provider === "azure") {
        await azureTransportFactory({
          baseUrl: config.baseUrl,
          requestStyle: config.requestStyle,
          apiVersion: config.apiVersion,
          credential: requireNativeCredential(config),
          modelTag: config.deployments[0],
          ...(config.reasoningModelCompatibility
            ? { reasoningModelCompatibility: true }
            : {}),
        }).generateChat(
          // A reasoning model spends its output budget thinking before it
          // writes anything, so a budget of one token makes the provider
          // reject the probe for running out rather than answer it. What this
          // check needs to learn is only that the endpoint answered and took
          // the credential, so leave room for a reply.
          {
            prompt: "Reply with OK.",
            maxOutputTokens: AZURE_CONNECTION_TEST_OUTPUT_TOKENS,
          },
          { signal },
        );
        return Object.freeze({
          ok: true,
          provider: config.provider,
          modelCount: config.deployments.length,
          classification: "remote",
        });
      }
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
     * @param {{
     *   skills?: readonly unknown[],
     *   modeInstructions?: unknown,
     *   readProjectFile: Function,
     *   projectContext?: unknown,
     *   searchZotero?: Function,
     *   validateEvidence?: Function,
     * }} options
     */
    createAgentGateway(
      input,
      {
        skills,
        modeInstructions,
        readProjectFile,
        projectContext,
        searchZotero,
        validateEvidence,
      },
    ) {
      const config = parseAiReviewerProviderConfig(input);
      if (typeof readProjectFile !== "function") {
        throw new TypeError("readProjectFile must be a function.");
      }
      return createTransport(config).createAgentGateway({
        contextLength: config.contextLength,
        contextLengthSource: config.contextLengthSource,
        ...(skills === undefined ? {} : { skills }),
        ...(modeInstructions === undefined ? {} : { modeInstructions }),
        readProjectFile,
        projectContext,
        searchZotero,
        validateEvidence,
      });
    },
  };
}

export const createOllamaProviderService = createAiReviewerProviderService;
