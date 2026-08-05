import {
  FetchError,
  getJSON,
  postJSON,
  putJSON,
} from "@/infrastructure/fetch-json";

export type AiProviderConfiguration = {
  provider: "openai-compatible";
  baseUrl: string;
  model: string;
  contextLength: number;
  credentialSet: boolean;
  credentialUpdatedAt: string | null;
};

export type AiProviderConfigurationWrite = {
  provider: "openai-compatible";
  baseUrl: string;
  model: string;
  contextLength: number;
  credential?: string | null;
};

export type AiProviderConfigurationResponse = {
  configured: boolean;
  config: AiProviderConfiguration | null;
  classification: "local" | "remote" | null;
};

export type AiProviderConnectionResponse = {
  ok: true;
  provider: "openai-compatible";
  model: string;
  classification: "local" | "remote";
};

const errorCodes = new Set<AiProviderConfigurationClientErrorCode>([
  "AI_PROVIDER_AUTHENTICATION_ERROR",
  "AI_PROVIDER_NETWORK_FAILED",
  "AI_PROVIDER_NOT_CONFIGURED",
  "AI_PROVIDER_RATE_LIMITED",
  "AI_PROVIDER_SCHEMA_INVALID",
  "AI_REQUEST_TIMEOUT",
  "AI_PROVIDER_ERROR",
]);

export type AiProviderConfigurationClientErrorCode =
  | "AI_PROVIDER_AUTHENTICATION_ERROR"
  | "AI_PROVIDER_NETWORK_FAILED"
  | "AI_PROVIDER_NOT_CONFIGURED"
  | "AI_PROVIDER_RATE_LIMITED"
  | "AI_PROVIDER_SCHEMA_INVALID"
  | "AI_REQUEST_TIMEOUT"
  | "AI_PROVIDER_ERROR";

export class AiProviderConfigurationClientError extends Error {
  constructor(public readonly code: AiProviderConfigurationClientErrorCode) {
    super(code);
    this.name = "AiProviderConfigurationClientError";
  }
}

function toClientError(error: unknown) {
  const code =
    error instanceof FetchError && typeof error.data?.error?.code === "string"
      ? error.data.error.code
      : "AI_PROVIDER_ERROR";
  const safeCode = errorCodes.has(
    code as AiProviderConfigurationClientErrorCode,
  )
    ? (code as AiProviderConfigurationClientErrorCode)
    : "AI_PROVIDER_ERROR";
  return new AiProviderConfigurationClientError(safeCode);
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
  config: AiProviderConfigurationWrite,
  signal: AbortSignal,
) {
  const body: AiProviderConfigurationWrite = {
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    contextLength: config.contextLength,
  };
  if (config.credential !== undefined) {
    body.credential = config.credential;
  }
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
