// @ts-check

import { AgentGatewayAbortError, AgentGatewayError } from "./AgentGateway.mjs";
import { parseAiReviewerProviderConfig } from "./AiReviewerProviderConfig.mjs";
import { OllamaOpenAiTransport } from "./OllamaOpenAiTransport.mjs";

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
      "The Ollama provider failed the compatibility check.",
      {
        code: "AI_PROVIDER_COMPATIBILITY_FAILED",
        category: "provider",
        retryable: false,
      },
    );
  }
}

/** @param {any} [dependencies] */
export function createOllamaProviderService(dependencies = {}) {
  const transportFactory =
    dependencies.transportFactory ??
    ((/** @type {{ baseUrl: string, modelTag: string }} */ options) =>
      new OllamaOpenAiTransport(options));
  return {
    /**
     * @param {unknown} input
     * @param {{ signal?: AbortSignal }} [options]
     */
    async testConnection(input, { signal } = {}) {
      throwIfAborted(signal);
      const config = parseAiReviewerProviderConfig(input);
      const transport = transportFactory({
        baseUrl: config.baseUrl,
        modelTag: config.model,
      });
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
        provider: "ollama",
        model: config.model,
        classification: "local",
      });
    },

    /**
     * @param {unknown} input
     */
    createDiscussionGateway(input) {
      const config = parseAiReviewerProviderConfig(input);
      return transportFactory({
        baseUrl: config.baseUrl,
        modelTag: config.model,
      }).createDiscussionGateway({
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
      return transportFactory({
        baseUrl: config.baseUrl,
        modelTag: config.model,
      }).createAgentGateway({
        contextLength: config.contextLength,
        readProjectFile,
        projectContext,
        searchZotero,
        validateEvidence,
      });
    },
  };
}
