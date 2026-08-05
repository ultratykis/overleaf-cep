// @ts-check

import { z } from "zod";

import {
  parseOpenAiCompatibleBaseUrl,
  parseOpenAiCompatibleModelId,
} from "./OllamaEndpointPolicy.mjs";

const ContextLengthSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
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
]);
const CredentialSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    // eslint-disable-next-line no-control-regex -- credentials reject ASCII controls
    (value) => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value),
  );

/** @param {unknown} input */
export function parseAiReviewerProviderCredential(input) {
  return CredentialSchema.parse(input);
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
      return Object.freeze({
        provider: value.provider,
        baseUrl: endpoint.baseUrl,
        model: parseOpenAiCompatibleModelId(value.model),
      });
    }
    case "gemini":
    case "claude":
      return Object.freeze({
        provider: value.provider,
        model: parseOpenAiCompatibleModelId(value.model),
      });
  }
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
 * Parse the private server-side configuration used by provider requests.
 * Legacy `ollama` records are normalized without requiring the user to save
 * their local configuration again.
 *
 * @param {unknown} input
 */
export function parseAiReviewerProviderConfig(input) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("AI provider configuration must be an object.");
  }
  const value = /** @type {Record<string, unknown>} */ (input);
  const allowedKeys = new Set([
    "provider",
    "baseUrl",
    "model",
    "contextLength",
    "contextLengthSource",
    "credential",
    "credentialUpdatedAt",
  ]);
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !allowedKeys.has(key),
    )
  ) {
    throw new TypeError("AI provider configuration has unknown fields.");
  }
  const config = parseCoreProviderConfig(coreProviderConfigInput(value));
  const contextLength = ContextLengthSchema.parse(value.contextLength);
  const contextLengthSource = Object.hasOwn(value, "contextLengthSource")
    ? ContextLengthSourceSchema.parse(value.contextLengthSource)
    : undefined;
  if (
    (contextLengthSource === "derived" &&
      config.provider === "openai-compatible") ||
    (contextLengthSource === "detected" &&
      config.provider !== "openai-compatible")
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
      ? { baseUrl: config.baseUrl }
      : {}),
    model: config.model,
    contextLength,
    ...(contextLengthSource === undefined ? {} : { contextLengthSource }),
    ...(credential === undefined ? {} : { credential }),
    ...(credentialUpdatedAt === undefined ? {} : { credentialUpdatedAt }),
  });
}

/**
 * Parse a configuration write from the HTTP boundary. Credential metadata is
 * server-owned and therefore not part of this schema.
 *
 * @param {unknown} input
 */
export function parseAiReviewerProviderConfigUpdate(input) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("AI provider configuration must be an object.");
  }
  const value = /** @type {Record<string, unknown>} */ (input);
  const allowedKeys = new Set([
    "provider",
    "baseUrl",
    "model",
    "contextLength",
    "contextLengthOverride",
    "credential",
  ]);
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !allowedKeys.has(key),
    )
  ) {
    throw new TypeError("AI provider configuration has unknown fields.");
  }
  if (
    Object.hasOwn(value, "contextLength") &&
    Object.hasOwn(value, "contextLengthOverride")
  ) {
    throw new TypeError(
      "Only one AI provider context length override may be supplied.",
    );
  }
  const config = parseCoreProviderConfig(coreProviderConfigInput(value));
  const legacyContextLength = Object.hasOwn(value, "contextLength")
    ? ContextLengthSchema.parse(value.contextLength)
    : undefined;
  const contextLengthOverride = Object.hasOwn(value, "contextLengthOverride")
    ? ContextLengthSchema.nullable().parse(value.contextLengthOverride)
    : undefined;
  const credential = Object.hasOwn(value, "credential")
    ? value.credential == null
      ? null
      : parseAiReviewerProviderCredential(value.credential)
    : undefined;
  return Object.freeze({
    provider: config.provider,
    ...(config.provider === "openai-compatible"
      ? { baseUrl: config.baseUrl }
      : {}),
    model: config.model,
    ...(legacyContextLength === undefined
      ? {}
      : { contextLength: legacyContextLength }),
    ...(contextLengthOverride === undefined ? {} : { contextLengthOverride }),
    ...(credential === undefined ? {} : { credential }),
  });
}

/**
 * @param {unknown} input
 */
export function publicAiReviewerProviderConfig(input) {
  if (input == null) {
    return Object.freeze({
      configured: false,
      config: null,
      classification: null,
    });
  }
  const config = parseAiReviewerProviderConfig(input);
  const credentialSet = typeof config.credential === "string";
  const credentialUpdatedAt = config.credentialUpdatedAt ?? null;
  const contextLengthSource = config.contextLengthSource ?? "override";
  if (config.provider === "openai-compatible") {
    const endpoint = parseOpenAiCompatibleBaseUrl(config.baseUrl);
    return Object.freeze({
      configured: true,
      config: Object.freeze({
        provider: config.provider,
        baseUrl: config.baseUrl,
        model: config.model,
        contextLength: config.contextLength,
        contextLengthSource,
        credentialSet,
        credentialUpdatedAt,
      }),
      classification: endpoint.classification,
    });
  }
  return Object.freeze({
    configured: true,
    config: Object.freeze({
      provider: config.provider,
      model: config.model,
      contextLength: config.contextLength,
      contextLengthSource,
      credentialSet,
      credentialUpdatedAt,
    }),
    classification: "remote",
  });
}
