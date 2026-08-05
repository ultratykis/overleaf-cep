import {
  deleteJSON,
  FetchError,
  getJSON,
  postJSON,
  putJSON,
} from "@/infrastructure/fetch-json";
import type {
  AiReviewerReasoningModelCompatibility,
} from "../../../shared/contract-types";

export type AiProvider = "openai-compatible" | "gemini" | "claude" | "azure";
export type AzureOpenAiRequestStyle = "v1" | "deployment";
export type ModelContextLengthOverride = {
  model: string;
  contextLength: number;
};

// A connection owns destination metadata and optional fallback candidates. The
// selected model is still chosen per review and is not part of this shape.
type AiProviderConfigurationCommon = {
  contextLengthOverride: number | null;
  reasoningModelCompatibility?: AiReviewerReasoningModelCompatibility;
  credentialSet: boolean;
  credentialUpdatedAt: string | null;
};

export type AiProviderConfiguration =
  | (AiProviderConfigurationCommon & {
      provider: "openai-compatible";
      baseUrl: string;
      models?: string[];
    })
  | (AiProviderConfigurationCommon & {
      provider: "gemini";
      models?: string[];
    })
  | (AiProviderConfigurationCommon & {
      provider: "claude";
      models?: string[];
    })
  | (AiProviderConfigurationCommon & {
      provider: "azure";
      baseUrl: string;
      requestStyle: AzureOpenAiRequestStyle;
      apiVersion?: string;
      deployments: string[];
      contextLengthOverrides: ModelContextLengthOverride[];
    });

type AiProviderConfigurationWriteCommon = {
  // An empty label asks the server to keep deriving one from the endpoint.
  label: string;
  contextLengthOverride: number | null;
  reasoningModelCompatibility?: AiReviewerReasoningModelCompatibility;
  credential?: string | null;
};

export type AiProviderConfigurationWrite =
  | (AiProviderConfigurationWriteCommon & {
      provider: "openai-compatible";
      baseUrl: string;
      models: string[];
    })
  | (AiProviderConfigurationWriteCommon & {
      provider: "gemini";
      models: string[];
    })
  | (AiProviderConfigurationWriteCommon & {
      provider: "claude";
      models: string[];
    })
  | (AiProviderConfigurationWriteCommon & {
      provider: "azure";
      baseUrl: string;
      requestStyle: AzureOpenAiRequestStyle;
      apiVersion?: string;
      deployments: string[];
      contextLengthOverrides: ModelContextLengthOverride[];
    });

export type AiProviderConnection = {
  id: string;
  revision: number;
  label: string;
  classification: "local" | "remote";
  projectUseCount?: number;
  config: AiProviderConfiguration;
};

export type AiProviderConnectionList = {
  connections: AiProviderConnection[];
};

export type AiProviderConnectionResponse = {
  ok: true;
  provider: AiProvider;
  modelCount: number;
  classification: "local" | "remote";
};

export type AiProviderModel = {
  id: string;
  displayName: string;
  connectionId: string;
  connectionLabel: string;
  contextLength: number | null;
  contextLengthSource: "detected" | "override" | "pending" | "unavailable";
};

/**
 * Why a connection could not be listed, as a classification only. The provider
 * response itself never reaches the client.
 */
export type AiProviderModelFailure = {
  connectionId: string;
  connectionLabel: string;
  code: string;
  category: string;
};

export type AiProviderModelCatalog = {
  models: AiProviderModel[];
  failures: AiProviderModelFailure[];
};

const errorCodes = new Set<AiProviderConfigurationClientErrorCode>([
  "AI_PROVIDER_AUTHENTICATION_ERROR",
  "AI_PROVIDER_CONFIGURATION_INVALID",
  "AI_PROVIDER_CONFIGURATION_PERSISTENCE_FAILED",
  "AI_PROVIDER_CONNECTION_CONFLICT",
  "AI_PROVIDER_CONNECTION_LIMIT_REACHED",
  "AI_PROVIDER_CONNECTION_NOT_FOUND",
  "AI_PROVIDER_CIRCUIT_OPEN",
  "AI_PROVIDER_COOLDOWN",
  "AI_PROVIDER_NETWORK_FAILED",
  "AI_PROVIDER_MODEL_DISCOVERY_UNSUPPORTED",
  "AI_PROVIDER_NOT_CONFIGURED",
  "AI_PROVIDER_PLAINTEXT_CREDENTIAL_BLOCKED",
  "AI_PROVIDER_RATE_LIMITED",
  "AI_PROVIDER_SCHEMA_INVALID",
  "AI_REQUEST_TIMEOUT",
  "AI_PROVIDER_ERROR",
]);

export type AiProviderConfigurationClientErrorCode =
  | "AI_PROVIDER_AUTHENTICATION_ERROR"
  | "AI_PROVIDER_CONFIGURATION_INVALID"
  | "AI_PROVIDER_CONFIGURATION_PERSISTENCE_FAILED"
  | "AI_PROVIDER_CONNECTION_CONFLICT"
  | "AI_PROVIDER_CONNECTION_LIMIT_REACHED"
  | "AI_PROVIDER_CONNECTION_NOT_FOUND"
  | "AI_PROVIDER_CIRCUIT_OPEN"
  | "AI_PROVIDER_COOLDOWN"
  | "AI_PROVIDER_NETWORK_FAILED"
  | "AI_PROVIDER_MODEL_DISCOVERY_UNSUPPORTED"
  | "AI_PROVIDER_NOT_CONFIGURED"
  | "AI_PROVIDER_PLAINTEXT_CREDENTIAL_BLOCKED"
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

function connectionsPath(projectId: string) {
  return `/project/${projectId}/ai-reviewer/connections`;
}

const userConnectionsPath = "/user/ai-reviewer/connections";

/**
 * Serialize exactly the fields the write routes accept. A draft carries render
 * state that must never reach the server, so each provider is spelled out.
 */
function connectionBody(config: AiProviderConfigurationWrite) {
  const credential =
    config.credential === undefined ? {} : { credential: config.credential };
  const reasoningModelCompatibility = config.reasoningModelCompatibility
    ? { reasoningModelCompatibility: true }
    : {};
  switch (config.provider) {
    case "openai-compatible":
      return {
        provider: config.provider,
        baseUrl: config.baseUrl,
        models: [...config.models],
        label: config.label,
        contextLengthOverride: config.contextLengthOverride,
        ...reasoningModelCompatibility,
        ...credential,
      };
    case "gemini":
    case "claude":
      return {
        provider: config.provider,
        models: [...config.models],
        label: config.label,
        contextLengthOverride: config.contextLengthOverride,
        ...reasoningModelCompatibility,
        ...credential,
      };
    case "azure":
      return {
        provider: config.provider,
        baseUrl: config.baseUrl,
        requestStyle: config.requestStyle,
        ...(config.apiVersion === undefined
          ? {}
          : { apiVersion: config.apiVersion }),
        deployments: [...config.deployments],
        contextLengthOverrides: config.contextLengthOverrides.map((entry) => ({
          ...entry,
        })),
        label: config.label,
        contextLengthOverride: null,
        ...reasoningModelCompatibility,
        ...credential,
      };
  }
}

export function getAiProviderConnections(
  projectId: string,
  signal: AbortSignal,
) {
  return request(signal, () =>
    getJSON<AiProviderConnectionList>(connectionsPath(projectId), {
      signal,
      swallowAbortError: false,
    }),
  );
}

export function createAiProviderConnection(
  projectId: string,
  config: AiProviderConfigurationWrite,
  signal: AbortSignal,
) {
  return request(signal, () =>
    postJSON<AiProviderConnection>(connectionsPath(projectId), {
      body: connectionBody(config),
      signal,
      swallowAbortError: false,
    }),
  );
}

export function updateAiProviderConnection(
  projectId: string,
  connectionId: string,
  expectedRevision: number,
  config: AiProviderConfigurationWrite,
  signal: AbortSignal,
) {
  return request(signal, () =>
    putJSON<AiProviderConnection>(
      `${connectionsPath(projectId)}/${connectionId}`,
      {
        body: { ...connectionBody(config), expectedRevision },
        signal,
        swallowAbortError: false,
      },
    ),
  );
}

export function deleteAiProviderConnection(
  projectId: string,
  connectionId: string,
  expectedRevision: number,
  signal: AbortSignal,
) {
  return request(signal, () =>
    deleteJSON<AiProviderConnectionList>(
      `${connectionsPath(projectId)}/${connectionId}`,
      {
        body: { expectedRevision },
        signal,
        swallowAbortError: false,
      },
    ),
  );
}

// These functions deliberately accept the view's opaque scope key but never
// turn it into a user identifier. The server resolves the owner from the
// authenticated session.
export function getUserAiProviderConnections(
  _scopeKey: string,
  signal: AbortSignal,
) {
  return request(signal, () =>
    getJSON<AiProviderConnectionList>(userConnectionsPath, {
      signal,
      swallowAbortError: false,
    }),
  );
}

export function createUserAiProviderConnection(
  _scopeKey: string,
  config: AiProviderConfigurationWrite,
  signal: AbortSignal,
) {
  return request(signal, () =>
    postJSON<AiProviderConnection>(userConnectionsPath, {
      body: connectionBody(config),
      signal,
      swallowAbortError: false,
    }),
  );
}

export function updateUserAiProviderConnection(
  _scopeKey: string,
  connectionId: string,
  expectedRevision: number,
  config: AiProviderConfigurationWrite,
  signal: AbortSignal,
) {
  return request(signal, () =>
    putJSON<AiProviderConnection>(`${userConnectionsPath}/${connectionId}`, {
      body: { ...connectionBody(config), expectedRevision },
      signal,
      swallowAbortError: false,
    }),
  );
}

export function deleteUserAiProviderConnection(
  _scopeKey: string,
  connectionId: string,
  expectedRevision: number,
  signal: AbortSignal,
) {
  return request(signal, () =>
    deleteJSON<AiProviderConnectionList>(
      `${userConnectionsPath}/${connectionId}`,
      {
        body: { expectedRevision },
        signal,
        swallowAbortError: false,
      },
    ),
  );
}

/**
 * Every model the user can reach, already unified across their connections.
 * Each entry names the connection it came from, so choosing a model chooses a
 * connection too.
 */
export function getAiProviderModels(projectId: string, signal: AbortSignal) {
  return request(signal, () =>
    getJSON<AiProviderModelCatalog>(
      `/project/${projectId}/ai-reviewer/provider/models`,
      { signal, swallowAbortError: false },
    ),
  );
}

export function testAiProviderConnection(
  projectId: string,
  connectionId: string | null,
  signal: AbortSignal,
) {
  return request(signal, () =>
    postJSON<AiProviderConnectionResponse>(
      `/project/${projectId}/ai-reviewer/connection-test`,
      {
        ...(connectionId == null ? {} : { body: { connectionId } }),
        signal,
        swallowAbortError: false,
      },
    ),
  );
}

export function resetAiProviderConnectionCircuit(
  projectId: string,
  connectionId: string,
  signal: AbortSignal,
) {
  return request(signal, () =>
    postJSON<{ ok: true }>(
      `${connectionsPath(projectId)}/${connectionId}/circuit-reset`,
      {
        signal,
        swallowAbortError: false,
      },
    ),
  );
}
