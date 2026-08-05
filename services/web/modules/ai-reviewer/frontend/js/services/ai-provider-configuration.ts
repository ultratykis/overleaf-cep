import {
  FetchError,
  getJSON,
  postJSON,
  putJSON,
} from "@/infrastructure/fetch-json";

export type AiProvider = "openai-compatible" | "gemini" | "claude";
export type AiProviderContextLengthSource =
  | "derived"
  | "detected"
  | "default"
  | "override";

type AiProviderConfigurationCommon = {
  model: string;
  contextLength: number;
  contextLengthSource: AiProviderContextLengthSource;
  credentialSet: boolean;
  credentialUpdatedAt: string | null;
};

export type AiProviderConfiguration =
  | (AiProviderConfigurationCommon & {
      provider: "openai-compatible";
      baseUrl: string;
    })
  | (AiProviderConfigurationCommon & {
      provider: "gemini";
    })
  | (AiProviderConfigurationCommon & {
      provider: "claude";
    });

type AiProviderConfigurationWriteCommon = {
  model: string;
  contextLengthOverride: number | null;
  credential?: string | null;
};

export type AiProviderConfigurationWrite =
  | (AiProviderConfigurationWriteCommon & {
      provider: "openai-compatible";
      baseUrl: string;
    })
  | (AiProviderConfigurationWriteCommon & {
      provider: "gemini";
    })
  | (AiProviderConfigurationWriteCommon & {
      provider: "claude";
    });

export type AiProviderConfigurationResponse = {
  configured: boolean;
  config: AiProviderConfiguration | null;
  classification: "local" | "remote" | null;
};

export type AiProviderConnectionResponse = {
  ok: true;
  provider: AiProvider;
  model: string;
  classification: "local" | "remote";
};

const errorCodes = new Set<AiProviderConfigurationClientErrorCode>([
  "AI_PROVIDER_AUTHENTICATION_ERROR",
  "AI_PROVIDER_CONFIGURATION_PERSISTENCE_FAILED",
  "AI_PROVIDER_NETWORK_FAILED",
  "AI_PROVIDER_NOT_CONFIGURED",
  "AI_PROVIDER_RATE_LIMITED",
  "AI_PROVIDER_SCHEMA_INVALID",
  "AI_REQUEST_TIMEOUT",
  "AI_PROVIDER_ERROR",
]);

export type AiProviderConfigurationClientErrorCode =
  | "AI_PROVIDER_AUTHENTICATION_ERROR"
  | "AI_PROVIDER_CONFIGURATION_PERSISTENCE_FAILED"
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
  let body: AiProviderConfigurationWrite;
  const credential =
    config.credential === undefined ? {} : { credential: config.credential };
  switch (config.provider) {
    case "openai-compatible":
      body = {
        provider: config.provider,
        baseUrl: config.baseUrl,
        model: config.model,
        contextLengthOverride: config.contextLengthOverride,
        ...credential,
      };
      break;
    case "gemini":
      body = {
        provider: config.provider,
        model: config.model,
        contextLengthOverride: config.contextLengthOverride,
        ...credential,
      };
      break;
    case "claude":
      body = {
        provider: config.provider,
        model: config.model,
        contextLengthOverride: config.contextLengthOverride,
        ...credential,
      };
      break;
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
