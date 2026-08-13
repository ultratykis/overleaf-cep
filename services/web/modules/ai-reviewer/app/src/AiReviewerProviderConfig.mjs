// @ts-check

import { z } from "zod";

import {
  AiReviewerReasoningModelCompatibilitySchema,
} from "../../shared/contracts.mjs";

import {
  parseOpenAiCompatibleBaseUrl,
  parseOpenAiCompatibleModelId,
} from "./OllamaEndpointPolicy.mjs";
import {
  DEFAULT_AZURE_OPENAI_REQUEST_STYLE,
  LEGACY_AZURE_OPENAI_REQUEST_STYLE,
  parseAzureOpenAiConnection,
  parseAzureOpenAiRunDestination,
  parseOpenAiCompatibleApiVersion,
} from "./AzureOpenAiEndpointPolicy.mjs";

const ContextLengthSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const SupportsImagesSchema = z.boolean();
const ContextLengthOverridesSchema = z
  .array(
    z
      .object({
        model: z.string(),
        contextLength: ContextLengthSchema,
      })
      .strict(),
  )
  .max(100);
const ContextLengthSourceSchema = z.enum([
  "derived",
  "detected",
  "default",
  "override",
]);
const CoreProviderConfigSchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("openai-compatible"),
      baseUrl: z.string(),
      apiVersion: z.string().optional(),
      model: z.string(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("gemini"),
      model: z.string(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("claude"),
      model: z.string(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("azure"),
      baseUrl: z.string(),
      requestStyle: z.enum(["v1", "deployment"]).optional(),
      apiVersion: z.string().optional(),
      model: z.string(),
    })
    .strict(),
]);
const DestinationSchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("openai-compatible"),
      baseUrl: z.string(),
      apiVersion: z.string().optional(),
      models: z.array(z.string()).max(100).optional(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("gemini"),
      models: z.array(z.string()).max(100).optional(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("claude"),
      models: z.array(z.string()).max(100).optional(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("azure"),
      baseUrl: z.string(),
      requestStyle: z.enum(["v1", "deployment"]).optional(),
      apiVersion: z.string().optional(),
      deployments: z.array(z.string()).max(100).default([]),
    })
    .strict(),
]);
const CredentialSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    // eslint-disable-next-line no-control-regex -- credentials reject ASCII controls
    (value) => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value),
  );
const LabelSchema = z
  .string()
  .min(1)
  .max(100)
  .refine(
    // eslint-disable-next-line no-control-regex -- labels reject ASCII controls
    (value) => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value),
  )
  .transform((value) => value.trim());

const ConnectionIdSchema = z.string().min(1).max(200);
const ConnectionRevisionSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

const NATIVE_PROVIDER_LABELS = Object.freeze({
  gemini: "Google Gemini",
  claude: "Anthropic Claude",
});

/** @param {unknown} input */
function parseOptionalConnectionApiVersion(input) {
  return input == null || input === ""
    ? undefined
    : parseOpenAiCompatibleApiVersion(input);
}

/** @param {unknown} input */
export function parseAiReviewerProviderCredential(input) {
  return CredentialSchema.parse(input);
}

/** @param {unknown} input */
export function parseAiReviewerConnectionId(input) {
  return ConnectionIdSchema.parse(input);
}

/** @param {unknown} input */
function parseCoreProviderConfig(input) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("AI provider configuration must be an object.");
  }
  const candidate = /** @type {Record<string, unknown>} */ ({ ...input });
  if (candidate.provider === "ollama") {
    candidate.provider = "openai-compatible";
  }
  const value = CoreProviderConfigSchema.parse(candidate);
  switch (value.provider) {
    case "openai-compatible": {
      const endpoint = parseOpenAiCompatibleBaseUrl(value.baseUrl);
      const apiVersion = parseOptionalConnectionApiVersion(value.apiVersion);
      return Object.freeze({
        provider: value.provider,
        baseUrl: endpoint.baseUrl,
        ...(apiVersion === undefined ? {} : { apiVersion }),
        model: parseOpenAiCompatibleModelId(value.model),
      });
    }
    case "gemini":
    case "claude":
      return Object.freeze({
        provider: value.provider,
        // Gemini names models `models/<id>` in its own listing and accepts
        // either form on the wire. Model discovery reports the bare id, so
        // store that form too or a configured model stops matching the list.
        model: parseOpenAiCompatibleModelId(
          value.provider === "gemini" && typeof value.model === "string"
            ? value.model.replace(/^models\//u, "")
            : value.model,
        ),
      });
    case "azure":
      return parseAzureOpenAiRunDestination(value);
  }
}

/**
 * Parse the provider and endpoint a connection points at. Legacy `ollama`
 * records are normalized without requiring the user to save their local
 * configuration again.
 *
 * @param {Record<string, unknown>} value
 */
function parseDestination(
  value,
  azureDefaultRequestStyle = LEGACY_AZURE_OPENAI_REQUEST_STYLE,
) {
  const candidate = {
    provider:
      value.provider === "ollama" ? "openai-compatible" : value.provider,
    ...(Object.hasOwn(value, "baseUrl") ? { baseUrl: value.baseUrl } : {}),
    ...(Object.hasOwn(value, "requestStyle")
      ? { requestStyle: value.requestStyle }
      : {}),
    ...(Object.hasOwn(value, "apiVersion")
      ? { apiVersion: value.apiVersion }
      : {}),
    ...(Object.hasOwn(value, "deployments")
      ? { deployments: value.deployments }
      : {}),
    ...(Object.hasOwn(value, "models") ? { models: value.models } : {}),
  };
  const destination = DestinationSchema.parse(candidate);
  const hasModels = Object.hasOwn(destination, "models");
  const models =
    destination.provider === "azure"
      ? []
      : (destination.models ?? []).map((model) =>
          parseOpenAiCompatibleModelId(
            destination.provider === "gemini"
              ? model.replace(/^models\//u, "")
              : model,
          ),
        );
  if (new Set(models).size !== models.length) {
    throw new TypeError("AI provider fallback models must be unique.");
  }
  if (destination.provider === "openai-compatible") {
    const apiVersion = parseOptionalConnectionApiVersion(
      destination.apiVersion,
    );
    return Object.freeze({
      provider: destination.provider,
      baseUrl: parseOpenAiCompatibleBaseUrl(destination.baseUrl).baseUrl,
      ...(apiVersion === undefined ? {} : { apiVersion }),
      ...(hasModels ? { models: Object.freeze(models) } : {}),
    });
  }
  return destination.provider === "azure"
    ? parseAzureOpenAiConnection(destination, {
        defaultRequestStyle: azureDefaultRequestStyle,
      })
    : Object.freeze({
        provider: destination.provider,
        ...(hasModels ? { models: Object.freeze(models) } : {}),
      });
}

/**
 * Name a connection the user never named. The endpoint host identifies a
 * self-hosted server on screen, the vendor name identifies a hosted one.
 * Deriving this on read is what lets an existing connection gain a label
 * without a migration.
 *
 * @param {{ provider: "openai-compatible" | "gemini" | "claude" | "azure", baseUrl?: string }} destination
 */
export function deriveAiReviewerConnectionLabel(destination) {
  if (
    destination.provider !== "openai-compatible" &&
    destination.provider !== "azure"
  ) {
    return NATIVE_PROVIDER_LABELS[destination.provider];
  }
  const endpoint = parseOpenAiCompatibleBaseUrl(destination.baseUrl);
  return endpoint.port === null
    ? endpoint.host
    : `${endpoint.host}:${endpoint.port}`;
}

/**
 * Reconstruct only the provider-specific connection fields before the
 * discriminated-union parse. In particular, a native provider carrying a
 * base URL remains an invalid shape rather than having the field ignored.
 *
 * @param {Record<string, unknown>} value
 */
function coreProviderConfigInput(value) {
  return {
    provider: value.provider,
    ...(Object.hasOwn(value, "baseUrl") ? { baseUrl: value.baseUrl } : {}),
    ...(Object.hasOwn(value, "requestStyle")
      ? { requestStyle: value.requestStyle }
      : {}),
    ...(Object.hasOwn(value, "apiVersion")
      ? { apiVersion: value.apiVersion }
      : {}),
    model: value.model,
  };
}

/** @param {unknown} input */
function parseCredentialTimestamp(input) {
  if (input == null) {
    return null;
  }
  const date =
    input instanceof Date
      ? input
      : typeof input === "string"
        ? new Date(input)
        : null;
  if (date == null || !Number.isFinite(date.valueOf())) {
    throw new TypeError("credentialUpdatedAt must be a valid timestamp.");
  }
  return date.toISOString();
}

/**
 * @param {unknown} input
 * @param {Set<string>} allowedKeys
 */
function objectWithKnownKeys(input, allowedKeys) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("AI provider configuration must be an object.");
  }
  const value = /** @type {Record<string, unknown>} */ (input);
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !allowedKeys.has(key),
    )
  ) {
    throw new TypeError("AI provider configuration has unknown fields.");
  }
  return value;
}

// The identifier is server-issued, so it belongs to a connection that was read
// back but never to one a client writes.
const CONNECTION_KEYS = new Set([
  "id",
  "provider",
  "baseUrl",
  "requestStyle",
  "apiVersion",
  "deployments",
  "models",
  "label",
  "contextLengthOverride",
  "contextLengthOverrides",
  "supportsImages",
  "reasoningModelCompatibility",
  "credential",
  "credentialUpdatedAt",
]);
const CONNECTION_UPDATE_KEYS = new Set([
  "provider",
  "baseUrl",
  "requestStyle",
  "apiVersion",
  "deployments",
  "models",
  "label",
  "contextLengthOverride",
  "contextLengthOverrides",
  "supportsImages",
  "reasoningModelCompatibility",
  "credential",
]);
const CONNECTION_UPDATE_REQUEST_KEYS = new Set([
  ...CONNECTION_UPDATE_KEYS,
  "expectedRevision",
]);
const CONNECTION_DELETE_REQUEST_KEYS = new Set(["expectedRevision"]);
const RUN_CONFIG_KEYS = new Set([
  "provider",
  "baseUrl",
  "requestStyle",
  "apiVersion",
  "model",
  "contextLength",
  "contextLengthSource",
  "supportsImages",
  "reasoningModelCompatibility",
  "credential",
  "credentialUpdatedAt",
]);

/**
 * Azure deployment names are user-defined, so their context limits must be
 * bound to the exact model name instead of one connection-wide value.
 *
 * @param {Record<string, unknown>} value
 * @param {ReturnType<typeof parseDestination>} destination
 */
function parseContextLengthOverrides(value, destination) {
  if (!Object.hasOwn(value, "contextLengthOverrides")) return undefined;
  if (destination.provider !== "azure") {
    throw new TypeError(
      "Per-model context length overrides are supported only for Azure.",
    );
  }
  const entries = ContextLengthOverridesSchema.parse(
    value.contextLengthOverrides,
  ).map((entry) =>
    Object.freeze({
      model: parseOpenAiCompatibleModelId(entry.model),
      contextLength: entry.contextLength,
    }),
  );
  const models = entries.map((entry) => entry.model);
  if (
    new Set(models).size !== models.length ||
    models.some((model) => !destination.deployments.includes(model))
  ) {
    throw new TypeError(
      "Azure context length overrides must name unique configured deployments.",
    );
  }
  return Object.freeze(entries);
}

/**
 * Parse a stored connection: a destination plus how to reach it. Fallback
 * candidates belong here, while the selected model is chosen per review.
 *
 * @param {unknown} input
 */
export function parseAiReviewerConnection(input) {
  const value = objectWithKnownKeys(input, CONNECTION_KEYS);
  const destination = parseDestination(value);
  const label = Object.hasOwn(value, "label")
    ? LabelSchema.parse(value.label)
    : deriveAiReviewerConnectionLabel(destination);
  const contextLengthOverride = Object.hasOwn(value, "contextLengthOverride")
    ? ContextLengthSchema.nullable().parse(value.contextLengthOverride)
    : undefined;
  const contextLengthOverrides = parseContextLengthOverrides(
    value,
    destination,
  );
  const supportsImages = Object.hasOwn(value, "supportsImages")
    ? SupportsImagesSchema.parse(value.supportsImages)
    : false;
  const reasoningModelCompatibility = Object.hasOwn(
    value,
    "reasoningModelCompatibility",
  )
    ? AiReviewerReasoningModelCompatibilitySchema.parse(
        value.reasoningModelCompatibility,
      )
    : false;
  const credential = Object.hasOwn(value, "credential")
    ? value.credential == null
      ? null
      : parseAiReviewerProviderCredential(value.credential)
    : undefined;
  const credentialUpdatedAt = Object.hasOwn(value, "credentialUpdatedAt")
    ? parseCredentialTimestamp(value.credentialUpdatedAt)
    : undefined;
  return Object.freeze({
    ...(Object.hasOwn(value, "id")
      ? { id: parseAiReviewerConnectionId(value.id) }
      : {}),
    ...destination,
    label,
    ...(contextLengthOverride == null ? {} : { contextLengthOverride }),
    ...(contextLengthOverrides === undefined ? {} : { contextLengthOverrides }),
    ...(supportsImages ? { supportsImages: true } : {}),
    ...(reasoningModelCompatibility ? { reasoningModelCompatibility } : {}),
    ...(credential === undefined ? {} : { credential }),
    ...(credentialUpdatedAt === undefined ? {} : { credentialUpdatedAt }),
  });
}

/**
 * Parse a connection write from the HTTP boundary. Credential metadata is
 * server-owned and therefore not part of this schema, and an omitted label
 * stays omitted so it keeps following the endpoint it was derived from.
 *
 * @param {unknown} input
 */
export function parseAiReviewerConnectionUpdate(input) {
  const value = objectWithKnownKeys(input, CONNECTION_UPDATE_KEYS);
  const destination = parseDestination(
    value,
    DEFAULT_AZURE_OPENAI_REQUEST_STYLE,
  );
  // An empty label is how the client asks to go back to the derived name.
  const label =
    !Object.hasOwn(value, "label") ||
    value.label == null ||
    (typeof value.label === "string" && value.label.trim().length === 0)
      ? null
      : LabelSchema.parse(value.label);
  const contextLengthOverride = Object.hasOwn(value, "contextLengthOverride")
    ? ContextLengthSchema.nullable().parse(value.contextLengthOverride)
    : undefined;
  const contextLengthOverrides = parseContextLengthOverrides(
    value,
    destination,
  );
  const supportsImages = Object.hasOwn(value, "supportsImages")
    ? SupportsImagesSchema.parse(value.supportsImages)
    : false;
  const reasoningModelCompatibility = Object.hasOwn(
    value,
    "reasoningModelCompatibility",
  )
    ? AiReviewerReasoningModelCompatibilitySchema.parse(
        value.reasoningModelCompatibility,
      )
    : false;
  const credential = Object.hasOwn(value, "credential")
    ? value.credential == null
      ? null
      : parseAiReviewerProviderCredential(value.credential)
    : undefined;
  return Object.freeze({
    ...destination,
    label,
    ...(contextLengthOverride === undefined ? {} : { contextLengthOverride }),
    ...(contextLengthOverrides === undefined ? {} : { contextLengthOverrides }),
    ...(supportsImages ? { supportsImages: true } : {}),
    ...(reasoningModelCompatibility ? { reasoningModelCompatibility } : {}),
    ...(credential === undefined ? {} : { credential }),
  });
}

/** @param {unknown} input */
export function parseAiReviewerConnectionRevision(input) {
  return ConnectionRevisionSchema.parse(input);
}

/**
 * Classify a stored connection through the same endpoint policy used by its
 * public DTO. Native providers have no configurable local endpoint.
 *
 * @param {unknown} input
 */
export function classifyAiReviewerProviderConnection(input) {
  const connection = parseAiReviewerConnection(input);
  return connection.provider === "openai-compatible"
    ? parseOpenAiCompatibleBaseUrl(connection.baseUrl).classification
    : "remote";
}

/**
 * An edit replaces one connection, so the HTTP request must identify the
 * exact connection revision the form was loaded from.
 *
 * @param {unknown} input
 */
export function parseAiReviewerConnectionUpdateRequest(input) {
  const value = objectWithKnownKeys(input, CONNECTION_UPDATE_REQUEST_KEYS);
  const configInput = Object.fromEntries(
    [...CONNECTION_UPDATE_KEYS]
      .filter((key) => Object.hasOwn(value, key))
      .map((key) => [key, value[key]]),
  );
  return Object.freeze({
    expectedRevision: parseAiReviewerConnectionRevision(value.expectedRevision),
    config: parseAiReviewerConnectionUpdate(configInput),
  });
}

/**
 * Delete is also conditional: confirming deletion of an old view must not
 * remove a connection that was edited elsewhere after that view loaded.
 *
 * @param {unknown} input
 */
export function parseAiReviewerConnectionDeleteRequest(input) {
  const value = objectWithKnownKeys(input, CONNECTION_DELETE_REQUEST_KEYS);
  return Object.freeze({
    expectedRevision: parseAiReviewerConnectionRevision(value.expectedRevision),
  });
}

/**
 * Parse the private configuration one review run uses: the connection it was
 * resolved from, plus the model the request selected and the context length
 * that pair resolved to.
 *
 * @param {unknown} input
 */
export function parseAiReviewerProviderConfig(input) {
  const value = objectWithKnownKeys(input, RUN_CONFIG_KEYS);
  const config = parseCoreProviderConfig(coreProviderConfigInput(value));
  const contextLength = ContextLengthSchema.parse(value.contextLength);
  const contextLengthSource = Object.hasOwn(value, "contextLengthSource")
    ? ContextLengthSourceSchema.parse(value.contextLengthSource)
    : undefined;
  const supportsImages = Object.hasOwn(value, "supportsImages")
    ? SupportsImagesSchema.parse(value.supportsImages)
    : false;
  const reasoningModelCompatibility = Object.hasOwn(
    value,
    "reasoningModelCompatibility",
  )
    ? AiReviewerReasoningModelCompatibilitySchema.parse(
        value.reasoningModelCompatibility,
      )
    : false;
  if (
    contextLengthSource === "derived" &&
    config.provider === "openai-compatible"
  ) {
    throw new TypeError(
      "The AI provider context length source is inconsistent.",
    );
  }
  const credential = Object.hasOwn(value, "credential")
    ? value.credential == null
      ? null
      : parseAiReviewerProviderCredential(value.credential)
    : undefined;
  const credentialUpdatedAt = Object.hasOwn(value, "credentialUpdatedAt")
    ? parseCredentialTimestamp(value.credentialUpdatedAt)
    : undefined;
  return Object.freeze({
    provider: config.provider,
    ...(config.provider === "openai-compatible"
      ? {
          baseUrl: config.baseUrl,
          ...(config.apiVersion == null
            ? {}
            : { apiVersion: config.apiVersion }),
        }
      : config.provider === "azure"
        ? {
            baseUrl: config.baseUrl,
            requestStyle: config.requestStyle,
            ...(config.apiVersion == null
              ? {}
              : { apiVersion: config.apiVersion }),
          }
        : {}),
    model: config.model,
    contextLength,
    ...(contextLengthSource === undefined ? {} : { contextLengthSource }),
    ...(supportsImages ? { supportsImages: true } : {}),
    ...(reasoningModelCompatibility ? { reasoningModelCompatibility } : {}),
    ...(credential === undefined ? {} : { credential }),
    ...(credentialUpdatedAt === undefined ? {} : { credentialUpdatedAt }),
  });
}

/**
 * Public view of one stored connection. A listing never decrypts a stored
 * credential, so whether one is set is reported by the caller from the stored
 * envelope rather than derived from a plaintext value.
 *
 * @param {unknown} input
 */
export function publicAiReviewerProviderConnection(input) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("AI provider connection must be an object.");
  }
  const { credentialSet, revision, ...rest } = /** @type {any} */ (input);
  const connection = parseAiReviewerConnection(rest);
  return Object.freeze({
    id: parseAiReviewerConnectionId(connection.id),
    revision: parseAiReviewerConnectionRevision(revision),
    label: connection.label,
    classification: classifyAiReviewerProviderConnection(connection),
    config: Object.freeze({
      provider: connection.provider,
      ...(connection.provider === "openai-compatible"
        ? {
            baseUrl: connection.baseUrl,
            ...(connection.apiVersion == null
              ? {}
              : { apiVersion: connection.apiVersion }),
          }
        : connection.provider === "azure"
          ? {
              baseUrl: connection.baseUrl,
              requestStyle: connection.requestStyle,
              ...(connection.apiVersion == null
                ? {}
                : { apiVersion: connection.apiVersion }),
              deployments: connection.deployments,
              contextLengthOverrides:
                connection.contextLengthOverrides ?? [],
            }
          : {}),
      ...(connection.provider === "azure"
        ? {}
        : connection.models == null
          ? {}
          : { models: connection.models }),
      contextLengthOverride: connection.contextLengthOverride ?? null,
      ...(connection.supportsImages ? { supportsImages: true } : {}),
      ...(connection.reasoningModelCompatibility
        ? { reasoningModelCompatibility: true }
        : {}),
      credentialSet: credentialSet === true,
      credentialUpdatedAt: connection.credentialUpdatedAt ?? null,
    }),
  });
}
