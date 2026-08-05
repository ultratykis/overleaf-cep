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
  return Object.freeze({
    configured: true,
    config: parseAiReviewerProviderConfig(input),
    classification: "local",
  });
}
