// @ts-check

import { AgentGatewayAbortError, AgentGatewayError } from "./AgentGateway.mjs";
import {
  parseAiReviewerProviderConfig,
  parseAiReviewerProviderConfigUpdate,
} from "./AiReviewerProviderConfig.mjs";
import { resolveModelContextLength } from "./ModelContextLength.mjs";
import { parseOpenAiCompatibleBaseUrl } from "./OllamaEndpointPolicy.mjs";
import {
  ClaudeAiSdkTransport,
  detectOpenAiCompatibleContextLength,
  GeminiAiSdkTransport,
  OllamaOpenAiTransport,
} from "./OllamaOpenAiTransport.mjs";

/** @param {AbortSignal | undefined} signal */
function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof AgentGatewayError
      ? signal.reason
      : new AgentGatewayAbortError();
  }
}

/** @param {unknown} result */
function assertCompatible(result) {
  const value = /** @type {any} */ (result);
  if (
    value?.type !== "completed" ||
    value.text !== "COMPAT_OK" ||
    value.finishReason !== "stop" ||
    !Array.isArray(value.toolCalls) ||
    value.toolCalls.length !== 0 ||
    value.usage == null ||
    typeof value.usage !== "object"
  ) {
    throw new AgentGatewayError(
      "The AI provider failed the compatibility check.",
      {
        code: "AI_PROVIDER_COMPATIBILITY_FAILED",
        category: "provider",
        retryable: false,
      },
    );
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

  return {
    /**
     * @param {unknown} input
     */
    async resolveContextLength(input) {
      const config = parseAiReviewerProviderConfigUpdate(input);
      return await resolveModelContextLength(config, {
        detectOpenAiCompatibleContextLength: async (candidate) =>
          await contextLengthDetector({
            ...candidate,
            signal: contextLengthDetectionSignalFactory(),
          }),
      });
    },

    /**
     * @param {unknown} input
     * @param {{ signal?: AbortSignal }} [options]
     */
    async testConnection(input, { signal } = {}) {
      throwIfAborted(signal);
      const config = parseAiReviewerProviderConfig(input);
      const transport = createTransport(config);
      const result = await transport.generateChat(
        {
          prompt: "Return exactly COMPAT_OK and nothing else.",
        },
        { signal },
      );
      throwIfAborted(signal);
      assertCompatible(result);
      return Object.freeze({
        ok: true,
        provider: config.provider,
        model: config.model,
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
