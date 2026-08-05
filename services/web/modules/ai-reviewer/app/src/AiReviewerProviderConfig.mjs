// @ts-check

import { z } from "zod";

import {
  parseOpenAiCompatibleBaseUrl,
  parseOpenAiCompatibleModelId,
} from "./OllamaEndpointPolicy.mjs";

const CoreProviderConfigSchema = z
  .object({
    provider: z.union([z.literal("openai-compatible"), z.literal("ollama")]),
    baseUrl: z.string(),
    model: z.string(),
    contextLength: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
const CredentialSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) => value.trim().length > 0 && !/[\u0000-\u001f\u007f]/u.test(value),
  );

/** @param {unknown} input */
export function parseAiReviewerProviderCredential(input) {
  return CredentialSchema.parse(input);
}

/** @param {unknown} input */
function parseCoreProviderConfig(input) {
  const value = CoreProviderConfigSchema.parse(input);
  const endpoint = parseOpenAiCompatibleBaseUrl(value.baseUrl);
  return Object.freeze({
    provider: /** @type {const} */ ("openai-compatible"),
    baseUrl: endpoint.baseUrl,
    model: parseOpenAiCompatibleModelId(value.model),
    contextLength: value.contextLength,
  });
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
  const config = parseCoreProviderConfig({
    provider: value.provider,
    baseUrl: value.baseUrl,
    model: value.model,
    contextLength: value.contextLength,
  });
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
    baseUrl: config.baseUrl,
    model: config.model,
    contextLength: config.contextLength,
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
    "credential",
  ]);
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !allowedKeys.has(key),
    )
  ) {
    throw new TypeError("AI provider configuration has unknown fields.");
  }
  const config = parseCoreProviderConfig({
    provider: value.provider,
    baseUrl: value.baseUrl,
    model: value.model,
    contextLength: value.contextLength,
  });
  const credential = Object.hasOwn(value, "credential")
    ? value.credential == null
      ? null
      : parseAiReviewerProviderCredential(value.credential)
    : undefined;
  return Object.freeze({
    provider: config.provider,
    baseUrl: config.baseUrl,
    model: config.model,
    contextLength: config.contextLength,
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
  const endpoint = parseOpenAiCompatibleBaseUrl(config.baseUrl);
  return Object.freeze({
    configured: true,
    config: Object.freeze({
      provider: config.provider,
      baseUrl: config.baseUrl,
      model: config.model,
      contextLength: config.contextLength,
      credentialSet: typeof config.credential === "string",
      credentialUpdatedAt: config.credentialUpdatedAt ?? null,
    }),
    classification: endpoint.classification,
  });
}
