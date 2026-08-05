// @ts-check

import { AgentGatewayError } from "./AgentGateway.mjs";

export const OLLAMA_FETCH_REDIRECT = "error";

const CANONICAL_ENDPOINT =
  /^http:\/\/(127\.0\.0\.1|\[::1\]|localhost|host\.docker\.internal):([1-9][0-9]{0,4})\/v1$/u;

export class OllamaEndpointPolicyError extends AgentGatewayError {
  constructor() {
    super(
      "The Ollama endpoint is not an allowed local OpenAI-compatible URL.",
      {
        code: "AI_OLLAMA_ENDPOINT_NOT_ALLOWED",
        category: "configuration",
        retryable: false,
      },
    );
    this.name = "OllamaEndpointPolicyError";
  }
}

/**
 * Accept only the exact local OpenAI-compatible endpoint forms registered by
 * EVAL-OLLAMA-01. Parsing must not turn encoded, numeric, dotted, traversing,
 * or otherwise noncanonical input into an allowed endpoint.
 *
 * @param {unknown} input
 * @returns {Readonly<{
 *   baseUrl: string,
 *   classification: 'local',
 *   host: string,
 *   port: number,
 * }>}
 */
export function parseOllamaOpenAiBaseUrl(input) {
  if (typeof input !== "string") {
    throw new OllamaEndpointPolicyError();
  }

  const match = CANONICAL_ENDPOINT.exec(input);
  if (match == null || match[0] !== input) {
    throw new OllamaEndpointPolicyError();
  }

  const host = match[1];
  const port = Number(match[2]);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new OllamaEndpointPolicyError();
  }

  return Object.freeze({
    baseUrl: input,
    classification: "local",
    host,
    port,
  });
}
