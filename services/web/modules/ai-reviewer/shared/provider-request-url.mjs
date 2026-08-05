// @ts-check

const CANONICAL_ENDPOINT =
  /^(https?):\/\/(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::([1-9][0-9]{0,4}))?((?:\/[A-Za-z0-9._~-]+)*)$/u;
const AZURE_RESOURCE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const AZURE_API_VERSION = /^[A-Za-z0-9][A-Za-z0-9.-]{0,63}$/u;
const AZURE_DEPLOYMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const AZURE_DEPLOYMENT_ENDPOINT =
  /^(https:\/\/[a-z0-9.-]+(?::[1-9][0-9]{0,4})?(?:\/[A-Za-z0-9._~-]+)*)\/deployments\/([A-Za-z0-9][A-Za-z0-9._-]{0,63})\/chat\/completions\?api-version=([A-Za-z0-9][A-Za-z0-9.-]{0,63})$/u;

export const DEFAULT_AZURE_OPENAI_API_VERSION = "v1";

function invalidRequestDestination() {
  return new TypeError("The AI provider request destination is invalid.");
}

/**
 * Parse the provider-independent, canonical URL shape used before the server
 * applies its network destination policy. Keeping this syntax check shared
 * lets the form reject incomplete URLs without weakening the transport's
 * stricter SSRF checks.
 *
 * @param {unknown} input
 */
export function parseCanonicalAiProviderBaseUrl(input) {
  if (typeof input !== "string") {
    throw invalidRequestDestination();
  }

  const match = CANONICAL_ENDPOINT.exec(input);
  if (match == null || match[0] !== input) {
    throw invalidRequestDestination();
  }

  const [, scheme, hostname, portText, path] = match;
  const port = portText === undefined ? null : Number(portText);
  if (
    (port !== null &&
      (!Number.isSafeInteger(port) || port < 1 || port > 65_535)) ||
    path
      .split("/")
      .slice(1)
      .some((segment) => segment === "." || segment === "..")
  ) {
    throw invalidRequestDestination();
  }

  return Object.freeze({
    baseUrl: input,
    scheme,
    hostname,
    port,
    path,
  });
}

/**
 * Transport encryption is a property of the URL scheme. Host-based endpoint
 * classification cannot answer this because localhost may be served over
 * either HTTP or HTTPS.
 *
 * @param {unknown} input
 */
export function isPlaintextAiProviderBaseUrl(input) {
  return parseCanonicalAiProviderBaseUrl(input).scheme === "http";
}

/**
 * Normalize the Azure endpoint shapes accepted by the settings boundary. The
 * server supplies its stricter base URL parser so normalization and network
 * policy remain one operation there; the form uses the shared syntax parser.
 *
 * @param {unknown} input
 * @param {(input: unknown) => { baseUrl: string }} [parseBaseUrl]
 */
export function normalizeAzureOpenAiEndpoint(
  input,
  parseBaseUrl = parseCanonicalAiProviderBaseUrl,
) {
  if (typeof input !== "string") {
    throw invalidRequestDestination();
  }
  if (AZURE_RESOURCE_NAME.exec(input)?.[0] === input) {
    return Object.freeze({
      baseUrl: `https://${input}.openai.azure.com/openai`,
      deployment: null,
      apiVersion: null,
    });
  }

  const deploymentEndpoint = AZURE_DEPLOYMENT_ENDPOINT.exec(input);
  if (deploymentEndpoint != null && deploymentEndpoint[0] === input) {
    const [, baseUrl, deployment, apiVersion] = deploymentEndpoint;
    return Object.freeze({
      baseUrl: parseBaseUrl(baseUrl).baseUrl,
      deployment,
      apiVersion,
    });
  }

  const withoutTrailingSlash = input.endsWith("/") ? input.slice(0, -1) : input;
  const parsed = parseBaseUrl(withoutTrailingSlash);
  const endpoint = new URL(parsed.baseUrl);
  let baseUrl = parsed.baseUrl;
  if (endpoint.hostname.endsWith(".openai.azure.com")) {
    if (endpoint.pathname === "/" || endpoint.pathname === "/openai/v1") {
      baseUrl = `${endpoint.origin}/openai`;
    }
  }
  return Object.freeze({ baseUrl, deployment: null, apiVersion: null });
}

/**
 * The sole composition rule for user-configured Chat Completions request
 * URLs. Both the guarded transport allowlist and the settings preview call
 * this function.
 *
 * @param {
 *   | { provider: "openai-compatible", baseUrl: unknown }
 *   | {
 *       provider: "azure",
 *       baseUrl: unknown,
 *       requestStyle: unknown,
 *       apiVersion?: unknown,
 *       model: unknown,
 *     }
 * } destination
 */
export function deriveAiReviewerChatRequestUrl(destination) {
  if (destination == null || typeof destination !== "object") {
    throw invalidRequestDestination();
  }

  if (destination.provider === "openai-compatible") {
    const endpoint = parseCanonicalAiProviderBaseUrl(destination.baseUrl);
    return `${endpoint.baseUrl}/chat/completions`;
  }
  if (
    destination.provider !== "azure" ||
    (destination.requestStyle !== "v1" &&
      destination.requestStyle !== "deployment") ||
    typeof destination.model !== "string" ||
    AZURE_DEPLOYMENT_NAME.exec(destination.model)?.[0] !== destination.model
  ) {
    throw invalidRequestDestination();
  }

  const normalizedEndpoint = normalizeAzureOpenAiEndpoint(destination.baseUrl);
  const endpoint = parseCanonicalAiProviderBaseUrl(normalizedEndpoint.baseUrl);
  const enteredApiVersion =
    destination.apiVersion == null || destination.apiVersion === ""
      ? null
      : destination.apiVersion;
  if (destination.requestStyle === "v1" && enteredApiVersion != null) {
    throw invalidRequestDestination();
  }
  if (
    destination.requestStyle === "deployment" &&
    enteredApiVersion != null &&
    normalizedEndpoint.apiVersion != null &&
    enteredApiVersion !== normalizedEndpoint.apiVersion
  ) {
    throw invalidRequestDestination();
  }
  const apiVersion =
    destination.requestStyle === "deployment"
      ? (enteredApiVersion ??
        normalizedEndpoint.apiVersion ??
        DEFAULT_AZURE_OPENAI_API_VERSION)
      : DEFAULT_AZURE_OPENAI_API_VERSION;
  if (
    typeof apiVersion !== "string" ||
    AZURE_API_VERSION.exec(apiVersion)?.[0] !== apiVersion
  ) {
    throw invalidRequestDestination();
  }

  if (destination.requestStyle === "deployment") {
    return `${endpoint.baseUrl}/deployments/${destination.model}/chat/completions?api-version=${apiVersion}`;
  }
  return endpoint.hostname.endsWith(".openai.azure.com")
    ? `${endpoint.baseUrl}/v1/chat/completions?api-version=${apiVersion}`
    : `${endpoint.baseUrl}/chat/completions`;
}
