// @ts-check

import {
  parseOpenAiCompatibleBaseUrl,
  parseOpenAiCompatibleModelId,
} from "./OllamaEndpointPolicy.mjs";
import { normalizeAzureOpenAiEndpoint } from "../../shared/provider-request-url.mjs";

export const DEFAULT_AZURE_OPENAI_REQUEST_STYLE = "v1";
export const LEGACY_AZURE_OPENAI_REQUEST_STYLE = "deployment";

const AZURE_API_VERSION = /^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/u;
const AZURE_DEPLOYMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const MAX_AZURE_DEPLOYMENTS = 100;

function invalidAzureConfiguration() {
  return new TypeError("The Azure OpenAI configuration is invalid.");
}

/**
 * @param {unknown} input
 * @param {"v1" | "deployment"} fallback
 */
export function parseAzureOpenAiRequestStyle(input, fallback) {
  if (input == null) {
    return fallback;
  }
  if (input !== "v1" && input !== "deployment") {
    throw invalidAzureConfiguration();
  }
  return input;
}

/** @param {unknown} input */
export function parseAzureOpenAiApiVersion(input) {
  if (
    typeof input !== "string" ||
    AZURE_API_VERSION.exec(input)?.[0] !== input
  ) {
    throw invalidAzureConfiguration();
  }
  return input;
}

/** @param {unknown} input */
export function parseAzureOpenAiDeploymentName(input) {
  if (
    typeof input !== "string" ||
    AZURE_DEPLOYMENT_NAME.exec(input)?.[0] !== input
  ) {
    throw invalidAzureConfiguration();
  }
  // Keep the shared model identifier contract at the run boundary too.
  return parseOpenAiCompatibleModelId(input);
}

/**
 * Accept either the Azure resource name, an endpoint root, or the complete
 * deployment URL copied from the Azure portal. The stored endpoint is always
 * the root that `createAzure` expects before it appends either `/v1` or the
 * deployment-based path.
 *
 * @param {unknown} input
 */
export function parseAzureOpenAiEndpoint(input) {
  if (typeof input !== "string") {
    throw invalidAzureConfiguration();
  }
  const endpoint = normalizeAzureOpenAiEndpoint(
    input,
    parseOpenAiCompatibleBaseUrl,
  );
  return Object.freeze({
    baseUrl: endpoint.baseUrl,
    deployment:
      endpoint.deployment == null
        ? null
        : parseAzureOpenAiDeploymentName(endpoint.deployment),
    apiVersion:
      endpoint.apiVersion == null
        ? null
        : parseAzureOpenAiApiVersion(endpoint.apiVersion),
  });
}

/**
 * @param {unknown} input
 * @param {string | null} endpointDeployment
 */
export function parseAzureOpenAiDeployments(input, endpointDeployment = null) {
  if (!Array.isArray(input) || input.length > MAX_AZURE_DEPLOYMENTS) {
    throw invalidAzureConfiguration();
  }
  const deployments = endpointDeployment == null ? [] : [endpointDeployment];
  const seen = new Set(deployments);
  for (const candidate of input) {
    const deployment = parseAzureOpenAiDeploymentName(candidate);
    if (!seen.has(deployment)) {
      seen.add(deployment);
      deployments.push(deployment);
    }
  }
  if (deployments.length === 0 || deployments.length > MAX_AZURE_DEPLOYMENTS) {
    throw invalidAzureConfiguration();
  }
  return Object.freeze(deployments);
}

/**
 * @param {unknown} input
 * @param {string | null} endpointApiVersion
 */
function parseConnectionApiVersion(input, endpointApiVersion) {
  const supplied =
    input == null || input === "" ? null : parseAzureOpenAiApiVersion(input);
  if (
    supplied != null &&
    endpointApiVersion != null &&
    supplied !== endpointApiVersion
  ) {
    throw invalidAzureConfiguration();
  }
  return supplied ?? endpointApiVersion;
}

/**
 * @param {{ baseUrl: unknown, requestStyle?: unknown, apiVersion?: unknown, deployments: unknown }} input
 * @param {{ defaultRequestStyle?: "v1" | "deployment" }} [options]
 */
export function parseAzureOpenAiConnection(
  input,
  { defaultRequestStyle = LEGACY_AZURE_OPENAI_REQUEST_STYLE } = {},
) {
  const endpoint = parseAzureOpenAiEndpoint(input.baseUrl);
  const requestStyle = parseAzureOpenAiRequestStyle(
    input.requestStyle,
    defaultRequestStyle,
  );
  if (
    requestStyle === "v1" &&
    input.apiVersion != null &&
    input.apiVersion !== ""
  ) {
    throw invalidAzureConfiguration();
  }
  const apiVersion =
    requestStyle === "deployment"
      ? parseConnectionApiVersion(input.apiVersion, endpoint.apiVersion)
      : null;
  return Object.freeze({
    provider: /** @type {const} */ ("azure"),
    baseUrl: endpoint.baseUrl,
    requestStyle,
    ...(apiVersion == null ? {} : { apiVersion }),
    deployments: parseAzureOpenAiDeployments(
      input.deployments,
      endpoint.deployment,
    ),
  });
}

/**
 * @param {{ baseUrl: unknown, requestStyle?: unknown, apiVersion?: unknown, model: unknown }} input
 * @param {{ defaultRequestStyle?: "v1" | "deployment" }} [options]
 */
export function parseAzureOpenAiRunDestination(
  input,
  { defaultRequestStyle = LEGACY_AZURE_OPENAI_REQUEST_STYLE } = {},
) {
  const endpoint = parseAzureOpenAiEndpoint(input.baseUrl);
  const model = parseAzureOpenAiDeploymentName(input.model);
  if (endpoint.deployment != null && endpoint.deployment !== model) {
    throw invalidAzureConfiguration();
  }
  const requestStyle = parseAzureOpenAiRequestStyle(
    input.requestStyle,
    defaultRequestStyle,
  );
  if (
    requestStyle === "v1" &&
    input.apiVersion != null &&
    input.apiVersion !== ""
  ) {
    throw invalidAzureConfiguration();
  }
  const apiVersion =
    requestStyle === "deployment"
      ? parseConnectionApiVersion(input.apiVersion, endpoint.apiVersion)
      : null;
  return Object.freeze({
    provider: /** @type {const} */ ("azure"),
    baseUrl: endpoint.baseUrl,
    requestStyle,
    ...(apiVersion == null ? {} : { apiVersion }),
    model,
  });
}
