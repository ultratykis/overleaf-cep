// @ts-check

import { isIP } from "node:net";

import { AgentGatewayError } from "./AgentGateway.mjs";

export const OPENAI_COMPATIBLE_FETCH_REDIRECT = "error";

const CANONICAL_ENDPOINT =
  /^(https?):\/\/(\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::([1-9][0-9]{0,4}))?((?:\/[A-Za-z0-9._~-]+)*)$/u;
const CANONICAL_DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const CANONICAL_IPV4_OCTET = /^(?:0|[1-9][0-9]{0,2})$/u;
const IPV4_NUMBER_LIKE_HOST =
  /^(?:(?:0x[0-9a-f]+|[0-9]+)\.)*(?:0x[0-9a-f]+|[0-9]+)$/u;
const CANONICAL_MODEL_ID =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*(?::[A-Za-z0-9][A-Za-z0-9._-]*)?$/u;
const LOCAL_HOSTS = new Set([
  "127.0.0.1",
  "[::1]",
  "localhost",
  "host.docker.internal",
]);
const MAX_DNS_HOST_LENGTH = 253;
const MAX_MODEL_NAME_LENGTH = 255;
const MAX_MODEL_TAG_LENGTH = 128;

export class OpenAiCompatibleEndpointPolicyError extends AgentGatewayError {
  constructor() {
    super("The OpenAI-compatible endpoint is not allowed.", {
      code: "AI_OPENAI_COMPATIBLE_ENDPOINT_NOT_ALLOWED",
      category: "configuration",
      retryable: false,
    });
    this.name = "OpenAiCompatibleEndpointPolicyError";
  }
}

/**
 * @param {string} host
 *
 * @returns {number[] | null}
 */
function parseCanonicalIpv4(host) {
  if (!IPV4_NUMBER_LIKE_HOST.test(host)) {
    return null;
  }

  const parts = host.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !CANONICAL_IPV4_OCTET.test(part))
  ) {
    throw new OpenAiCompatibleEndpointPolicyError();
  }

  const octets = parts.map(Number);
  if (octets.some((octet) => octet > 255)) {
    throw new OpenAiCompatibleEndpointPolicyError();
  }
  return octets;
}

/**
 * @param {string} host
 */
function assertCanonicalDnsHost(host) {
  if (
    host.length > MAX_DNS_HOST_LENGTH ||
    !host.split(".").every((label) => CANONICAL_DNS_LABEL.test(label))
  ) {
    throw new OpenAiCompatibleEndpointPolicyError();
  }
}

/**
 * The lexical endpoint grammar excludes dotted IPv4 tails, so expanding a
 * validated IPv6 address only needs to handle hexadecimal hextets.
 *
 * @param {string} address
 * @returns {number[]}
 */
function ipv6Words(address) {
  const halves = address.split("::");
  const left = halves[0] === "" ? [] : halves[0].split(":");
  const right =
    halves.length === 1 || halves[1] === "" ? [] : halves[1].split(":");
  const omitted = halves.length === 2 ? 8 - left.length - right.length : 0;
  return [
    ...left.map((word) => Number.parseInt(word, 16)),
    ...Array.from({ length: omitted }, () => 0),
    ...right.map((word) => Number.parseInt(word, 16)),
  ];
}

/**
 * @param {number[]} words
 */
function isIpv4MappedOrCompatible(words) {
  const firstFiveZero = words.slice(0, 5).every((word) => word === 0);
  const firstSixZero = firstFiveZero && words[5] === 0;
  const mapped = firstFiveZero && words[5] === 0xffff;
  const compatible =
    firstSixZero && !(words[6] === 0 && (words[7] === 0 || words[7] === 1));
  return mapped || compatible;
}

/**
 * @param {string} host
 * @returns {number[] | null}
 */
function parseCanonicalIpv6(host) {
  if (!host.startsWith("[") || !host.endsWith("]")) {
    return null;
  }
  const address = host.slice(1, -1);
  if (isIP(address) !== 6) {
    throw new OpenAiCompatibleEndpointPolicyError();
  }
  const words = ipv6Words(address);
  if (
    words.length !== 8 ||
    (words[0] & 0xffc0) === 0xfe80 ||
    isIpv4MappedOrCompatible(words)
  ) {
    throw new OpenAiCompatibleEndpointPolicyError();
  }
  return words;
}

/**
 * Accept canonical OpenAI-compatible base URLs without first normalizing them
 * through URL parsing. Encoded, numeric-shortened, dotted, traversing, and
 * otherwise noncanonical input must fail before a request is constructed.
 *
 * @param {unknown} input
 * @returns {Readonly<{
 *   baseUrl: string,
 *   classification: 'local' | 'remote',
 *   host: string,
 *   port: number | null,
 * }>}
 */
export function parseOpenAiCompatibleBaseUrl(input) {
  if (typeof input !== "string") {
    throw new OpenAiCompatibleEndpointPolicyError();
  }

  const match = CANONICAL_ENDPOINT.exec(input);
  if (match == null || match[0] !== input) {
    throw new OpenAiCompatibleEndpointPolicyError();
  }

  const [, scheme, host, portText, path] = match;
  const port = portText === undefined ? null : Number(portText);
  if (
    (port !== null &&
      (!Number.isSafeInteger(port) || port < 1 || port > 65_535)) ||
    path
      .split("/")
      .slice(1)
      .some((segment) => segment === "." || segment === "..")
  ) {
    throw new OpenAiCompatibleEndpointPolicyError();
  }

  const ipv6 = parseCanonicalIpv6(host);
  const ipv4 = ipv6 === null ? parseCanonicalIpv4(host) : null;
  if (ipv6 === null && ipv4 === null) {
    assertCanonicalDnsHost(host);
  }

  if (
    (ipv4?.[0] === 169 && ipv4[1] === 254) ||
    host === "metadata.google.internal" ||
    (scheme === "http" && (!LOCAL_HOSTS.has(host) || port === null))
  ) {
    throw new OpenAiCompatibleEndpointPolicyError();
  }

  return Object.freeze({
    baseUrl: input,
    classification: LOCAL_HOSTS.has(host) ? "local" : "remote",
    host,
    port,
  });
}

/**
 * Accept canonical hosted model identifiers and explicit Ollama-style tags.
 * Surrounding whitespace, query-like suffixes, and control characters remain
 * invalid.
 *
 * @param {unknown} input
 * @returns {string}
 */
export function parseOpenAiCompatibleModelId(input) {
  const [name, tag, ...extra] =
    typeof input === "string" ? input.split(":") : [];
  if (
    typeof input !== "string" ||
    CANONICAL_MODEL_ID.exec(input)?.[0] !== input ||
    name.length > MAX_MODEL_NAME_LENGTH ||
    (tag !== undefined && tag.length > MAX_MODEL_TAG_LENGTH) ||
    extra.length !== 0
  ) {
    throw new TypeError(
      "modelId must be a canonical OpenAI-compatible model identifier.",
    );
  }
  return input;
}
