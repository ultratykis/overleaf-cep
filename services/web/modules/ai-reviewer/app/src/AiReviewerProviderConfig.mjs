// @ts-check

import { z } from "zod";

import {
  parseOllamaModelTag,
  parseOllamaOpenAiBaseUrl,
} from "./OllamaEndpointPolicy.mjs";

const ProviderConfigSchema = z
  .object({
    provider: z.literal("ollama"),
    baseUrl: z.string(),
    model: z.string(),
    contextLength: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

/**
 * @param {unknown} input
 */
export function parseAiReviewerProviderConfig(input) {
  const value = ProviderConfigSchema.parse(input);
  const endpoint = parseOllamaOpenAiBaseUrl(value.baseUrl);
  return Object.freeze({
    provider: "ollama",
    baseUrl: endpoint.baseUrl,
    model: parseOllamaModelTag(value.model),
    contextLength: value.contextLength,
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
  return Object.freeze({
    configured: true,
    config: Object.freeze({
      provider: config.provider,
      baseUrl: config.baseUrl,
      model: config.model,
      contextLength: config.contextLength,
    }),
    classification: "local",
  });
}
