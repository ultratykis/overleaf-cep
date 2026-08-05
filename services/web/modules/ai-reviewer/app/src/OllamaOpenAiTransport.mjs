// @ts-check

import { createOpenAI } from "@ai-sdk/openai";

import { AgentGatewayError } from "./AgentGateway.mjs";
import { AiSdkAgentGateway } from "./AiSdkAgentGateway.mjs";
import {
  OLLAMA_FETCH_REDIRECT,
  parseOllamaOpenAiBaseUrl,
} from "./OllamaEndpointPolicy.mjs";

const CANONICAL_MODEL_TAG =
  /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

/**
 * @param {unknown} input
 */
function parseModelTag(input) {
  if (
    typeof input !== "string" ||
    CANONICAL_MODEL_TAG.exec(input)?.[0] !== input
  ) {
    throw new TypeError("modelTag must be an explicit canonical Ollama tag.");
  }
  return input;
}

/**
 * @param {unknown} input
 */
function requestUrl(input) {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.url;
  }
  throw new AgentGatewayError(
    "The Ollama request URL is outside the configured local endpoint.",
    {
      code: "AI_OLLAMA_REQUEST_URL_NOT_ALLOWED",
      category: "configuration",
      retryable: false,
    },
  );
}

function requestUrlNotAllowed() {
  return new AgentGatewayError(
    "The Ollama request URL is outside the configured local endpoint.",
    {
      code: "AI_OLLAMA_REQUEST_URL_NOT_ALLOWED",
      category: "configuration",
      retryable: false,
    },
  );
}

function redirectRejected() {
  return new AgentGatewayError("The Ollama provider redirect was rejected.", {
    code: "AI_PROVIDER_REDIRECT_REJECTED",
    category: "provider",
    retryable: false,
  });
}

/**
 * @param {{
 *   baseUrl: string,
 *   fetchImpl: typeof fetch,
 * }} options
 */
function createGuardedFetch({ baseUrl, fetchImpl }) {
  const allowedRequestUrl = `${baseUrl}/chat/completions`;

  /**
   * @param {Parameters<typeof fetch>[0]} input
   * @param {Parameters<typeof fetch>[1]} [init]
   */
  return async function guardedOllamaFetch(input, init) {
    const currentEndpoint = parseOllamaOpenAiBaseUrl(baseUrl);
    if (
      `${currentEndpoint.baseUrl}/chat/completions` !== allowedRequestUrl ||
      requestUrl(input) !== allowedRequestUrl
    ) {
      throw requestUrlNotAllowed();
    }

    const response = await fetchImpl(input, {
      ...init,
      redirect: OLLAMA_FETCH_REDIRECT,
    });
    if (response.status >= 300 && response.status <= 399) {
      throw redirectRejected();
    }
    return response;
  };
}

/**
 * Sole production owner of the OpenAI-compatible provider SDK. The concrete
 * model remains private and can enter only the local AI SDK gateway.
 */
export class OllamaOpenAiTransport {
  #languageModel;
  #modelTag;

  /**
   * @param {{
   *   baseUrl: unknown,
   *   modelTag: unknown,
   *   fetchImpl?: typeof fetch,
   *   createProvider?: typeof createOpenAI,
   * }} options
   */
  constructor({
    baseUrl,
    modelTag,
    fetchImpl = globalThis.fetch,
    createProvider = createOpenAI,
  }) {
    const endpoint = parseOllamaOpenAiBaseUrl(baseUrl);
    const parsedModelTag = parseModelTag(modelTag);
    if (typeof fetchImpl !== "function") {
      throw new TypeError("fetchImpl must be a function.");
    }
    if (typeof createProvider !== "function") {
      throw new TypeError("createProvider must be a function.");
    }

    const provider = createProvider({
      apiKey: "ollama",
      baseURL: endpoint.baseUrl,
      fetch: createGuardedFetch({
        baseUrl: endpoint.baseUrl,
        fetchImpl,
      }),
      name: "ollama",
    });
    if (
      provider == null ||
      (typeof provider !== "object" && typeof provider !== "function") ||
      typeof Reflect.get(provider, "chat") !== "function"
    ) {
      throw new TypeError(
        "createProvider must return a provider with a chat method.",
      );
    }

    const languageModel = Reflect.apply(
      Reflect.get(provider, "chat"),
      provider,
      [parsedModelTag],
    );
    if (
      languageModel == null ||
      typeof languageModel !== "object" ||
      !("specificationVersion" in languageModel) ||
      typeof Reflect.get(languageModel, "doStream") !== "function"
    ) {
      throw new TypeError(
        "The Ollama provider must return a concrete Chat Completions model.",
      );
    }

    this.#languageModel = languageModel;
    this.#modelTag = parsedModelTag;
  }

  /**
   * @param {{
   *   readProjectFile: ConstructorParameters<typeof AiSdkAgentGateway>[0]["readProjectFile"],
   *   now?: () => string,
   *   createId?: (kind: 'event' | 'finding' | 'suggestion') => string,
   * }} options
   */
  createAgentGateway({ readProjectFile, now, createId }) {
    return new AiSdkAgentGateway({
      model: this.#languageModel,
      provider: "ollama",
      modelId: this.#modelTag,
      readProjectFile,
      now,
      createId,
    });
  }
}
