import {
  FetchError,
  getJSON,
  postJSON,
  putJSON,
} from "@/infrastructure/fetch-json";

export type AiProviderConfiguration = {
  provider: "ollama";
  baseUrl: string;
  model: string;
  contextLength: number;
};

export type AiProviderConfigurationResponse = {
  configured: boolean;
  config: AiProviderConfiguration | null;
  classification: "local" | null;
};

export type AiProviderConnectionResponse = {
  ok: true;
  provider: "ollama";
  model: string;
  classification: "local";
};

const errorMessages = {
  AI_PROVIDER_NETWORK_FAILED:
    "Ollama is unavailable. Start Ollama and try the connection again.",
  AI_PROVIDER_NOT_CONFIGURED:
    "No AI provider is configured. Save the provider settings first.",
  AI_REQUEST_TIMEOUT: "Ollama did not respond in time. Try the request again.",
  AI_PROVIDER_ERROR:
    "The AI provider request failed. Check Ollama and try again.",
} as const;

type ErrorCode = keyof typeof errorMessages;

export class AiProviderConfigurationClientError extends Error {}

function toClientError(error: unknown) {
  const code =
    error instanceof FetchError && typeof error.data?.error?.code === "string"
      ? error.data.error.code
      : "AI_PROVIDER_ERROR";
  const safeCode = Object.hasOwn(errorMessages, code)
    ? (code as ErrorCode)
    : "AI_PROVIDER_ERROR";
  return new AiProviderConfigurationClientError(errorMessages[safeCode]);
}

async function request<T>(
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (signal.aborted) {
      throw new DOMException("The request was cancelled.", "AbortError");
    }
    throw toClientError(error);
  }
}

export function getAiProviderConfiguration(
  projectId: string,
  signal: AbortSignal,
) {
  return request(signal, () =>
    getJSON<AiProviderConfigurationResponse>(
      `/project/${projectId}/ai-reviewer/config`,
      { signal, swallowAbortError: false },
    ),
  );
}

export function saveAiProviderConfiguration(
  projectId: string,
  config: AiProviderConfiguration,
  signal: AbortSignal,
) {
  const body = {
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    contextLength: config.contextLength,
  };
  return request(signal, () =>
    putJSON<AiProviderConfigurationResponse>(
      `/project/${projectId}/ai-reviewer/config`,
      { body, signal, swallowAbortError: false },
    ),
  );
}

export function testAiProviderConnection(
  projectId: string,
  signal: AbortSignal,
) {
  return request(signal, () =>
    postJSON<AiProviderConnectionResponse>(
      `/project/${projectId}/ai-reviewer/connection-test`,
      { signal, swallowAbortError: false },
    ),
  );
}
