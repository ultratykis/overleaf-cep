// @ts-check

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";

import {
  createGuardedOpenAiCompatibleFetch,
  createPinnedOpenAiCompatibleDispatcher,
} from "./OllamaOpenAiTransport.mjs";
import {
  OpenAiCompatibleEndpointPolicyError,
  parseOpenAiCompatibleBaseUrl,
} from "./OllamaEndpointPolicy.mjs";
import {
  AI_REVIEWER_SKILL_COUNT_LIMIT,
  AI_REVIEWER_SKILL_MAX_BYTES,
  aiReviewerSkillContentBytes,
  prepareAiReviewerSkill,
} from "./AiReviewerSkillStore.mjs";
import { parseAiReviewerSkill } from "./AiReviewerSkillParser.mjs";

const GIT_IMPORT_TIMEOUT_MS = 60_000;
const MAX_GIT_API_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_GIT_RESPONSE_CHUNKS = 512;
const MAX_GIT_ARCHIVE_COMPRESSED_BYTES = 16 * 1024 * 1024;
const MAX_GIT_ARCHIVE_EXPANDED_BYTES = 128 * 1024 * 1024;
const MAX_GIT_ARCHIVE_CHUNKS = 65_536;
const MAX_TAR_METADATA_BYTES = 64 * 1024;
const MAX_REPOSITORY_TREE_ENTRIES = 10_000;
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_REFERENCE_MENTIONS = 100;
const MAX_REPOSITORY_LENGTH = 1_000;
const MAX_REVISION_LENGTH = 1_000;
const MAX_REPOSITORY_PATH_LENGTH = 1_000;
const MAX_MANIFEST_METADATA_LENGTH = 1_000;
const GIT_SHA = /^[0-9a-f]{40}$/u;
const GITHUB_SHORTHAND = /^([A-Za-z0-9._~-]+)\/([A-Za-z0-9._~-]+)$/u;
const SAFE_REPOSITORY_SEGMENT = /^[A-Za-z0-9._~-]+$/u;
const CONTROL_OR_LINE_SEPARATOR = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const MARKDOWN_PATH_MENTION = new RegExp(
  String.raw`(?:^|[^\p{L}\p{N}._~:/-])((?:/)?(?:(?:\.{1,2}|[\p{L}\p{N}._~-]+)/)*[\p{L}\p{N}._~-]+\.md)(?=$|[^\p{L}\p{N}._~/?#-])`,
  "giu",
);
const MARKETPLACE_MANIFEST_PATH = ".claude-plugin/marketplace.json";
const PLUGIN_MANIFEST_PATH = ".claude-plugin/plugin.json";
const ARCHIVE_CONTENT_TYPES = Object.freeze([
  "application/gzip",
  "application/octet-stream",
  "application/x-gzip",
  "application/x-tar",
]);

/**
 * @typedef {"outside-skill-directory" | "not-reference-file" | "not-readable" | "size-limit"} SkippedReferenceReason
 */

/** @typedef {{ path: string, reason: SkippedReferenceReason }} SkippedReference */

/**
 * @typedef {{ name: string, url?: string }} ManifestOwner
 */

/**
 * @typedef {{
 *   name: string,
 *   version: string | null,
 *   license: string | null,
 *   owner: ManifestOwner | null,
 *   homepage: string | null,
 * }} PreviewPlugin
 */

/**
 * @typedef {{
 *   pluginName?: string,
 *   pluginVersion?: string,
 *   license?: string,
 *   owner?: ManifestOwner,
 *   homepage?: string,
 * }} ManifestFacts
 */

export class AiReviewerSkillGitImportError extends Error {
  /**
   * @param {string} message
   * @param {{ code: string, status?: number, category?: string }} options
   */
  constructor(message, { code, status = 400, category = "configuration" }) {
    super(message);
    this.name = "AiReviewerSkillGitImportError";
    this.code = code;
    this.status = status;
    this.category = category;
  }
}

function invalidSource(message = "Enter a canonical repository.") {
  return new AiReviewerSkillGitImportError(message, {
    code: "AI_REVIEWER_SKILL_GIT_SOURCE_INVALID",
  });
}

function manifestInvalid(
  message = "The repository skill manifest is invalid.",
) {
  return new AiReviewerSkillGitImportError(message, {
    code: "AI_REVIEWER_SKILL_GIT_MANIFEST_INVALID",
    status: 422,
  });
}

function destinationNotAllowed() {
  return new AiReviewerSkillGitImportError(
    "The repository host is not an allowed network destination.",
    { code: "AI_REVIEWER_SKILL_GIT_DESTINATION_NOT_ALLOWED" },
  );
}

function responseInvalid() {
  return new AiReviewerSkillGitImportError(
    "The git host returned an invalid repository response.",
    {
      code: "AI_REVIEWER_SKILL_GIT_RESPONSE_INVALID",
      status: 502,
      category: "network",
    },
  );
}

function responseTooLarge() {
  return new AiReviewerSkillGitImportError(
    "The git host response exceeded the import size limit.",
    {
      code: "AI_REVIEWER_SKILL_GIT_RESPONSE_TOO_LARGE",
      status: 413,
    },
  );
}

/** @param {string} name @param {string} path @param {number} totalBytes */
function skillTooLarge(name, path, totalBytes) {
  const overage = totalBytes - AI_REVIEWER_SKILL_MAX_BYTES;
  return new AiReviewerSkillGitImportError(
    `The skill ${JSON.stringify(name)} at ${JSON.stringify(path)} exceeds the ${AI_REVIEWER_SKILL_MAX_BYTES}-byte storage limit by ${overage} bytes.`,
    {
      code: "AI_REVIEWER_SKILL_GIT_SKILL_SIZE_LIMIT_EXCEEDED",
      status: 413,
    },
  );
}

function requestFailed() {
  return new AiReviewerSkillGitImportError(
    "The public repository or revision could not be read.",
    {
      code: "AI_REVIEWER_SKILL_GIT_FETCH_FAILED",
      status: 502,
      category: "network",
    },
  );
}

/** @param {"github" | "gitlab"} service @param {string | null} resetTime */
function rateLimited(service, resetTime) {
  const hostName = service === "github" ? "GitHub" : "GitLab";
  return new AiReviewerSkillGitImportError(
    resetTime == null
      ? `The ${hostName} rate limit was reached. Try again after it resets.`
      : `The ${hostName} rate limit was reached. Try again after ${resetTime}.`,
    {
      code: "AI_REVIEWER_SKILL_GIT_RATE_LIMITED",
      status: 429,
      category: "rate-limit",
    },
  );
}

function requestTimedOut() {
  return new AiReviewerSkillGitImportError(
    "The git host did not finish the import request in time.",
    {
      code: "AI_REVIEWER_SKILL_GIT_TIMEOUT",
      status: 504,
      category: "network",
    },
  );
}

function hostTypeRequired() {
  return new AiReviewerSkillGitImportError(
    "Choose GitHub or GitLab for this self-hosted repository.",
    { code: "AI_REVIEWER_SKILL_GIT_HOST_TYPE_REQUIRED" },
  );
}

function tooManyRepositorySkills() {
  return new AiReviewerSkillGitImportError(
    `The repository contains more than ${AI_REVIEWER_SKILL_COUNT_LIMIT} skills. Import from a repository with at most ${AI_REVIEWER_SKILL_COUNT_LIMIT} skills.`,
    { code: "AI_REVIEWER_SKILL_GIT_SKILL_COUNT_LIMIT_REACHED", status: 409 },
  );
}

/** @param {unknown} input */
function gitHostType(input) {
  if (input == null || input === "" || input === "auto") return null;
  if (input === "github" || input === "gitlab") return input;
  throw invalidSource("The git host type is invalid.");
}

/** @param {string} hostname */
function isLoopbackHostname(hostname) {
  const unwrapped = hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  if (
    unwrapped === "localhost" ||
    unwrapped === "::" ||
    unwrapped === "::1" ||
    /^::(?:ffff:)?(?:127\.|7f[0-9a-f]{2}:)/u.test(unwrapped)
  ) {
    return true;
  }
  if (isIP(unwrapped) !== 4) return false;
  const firstOctet = Number(unwrapped.split(".", 1)[0]);
  return firstOctet === 0 || firstOctet === 127;
}

/** @param {string} address */
function assertNotLoopbackAddress(address) {
  if (isLoopbackHostname(address)) {
    throw new OpenAiCompatibleEndpointPolicyError();
  }
}

/** @param {string[]} segments */
function repositoryFromSegments(segments) {
  const normalised = [...segments];
  const last = normalised.at(-1);
  if (last?.endsWith(".git")) {
    normalised[normalised.length - 1] = last.slice(0, -4);
  }
  if (
    normalised.length < 2 ||
    normalised.some(
      (segment) =>
        segment.length === 0 ||
        segment.length > 200 ||
        segment === "." ||
        segment === ".." ||
        !SAFE_REPOSITORY_SEGMENT.test(segment),
    )
  ) {
    throw invalidSource("The repository path is invalid.");
  }
  const repository = normalised.join("/");
  if (repository.length > MAX_REPOSITORY_LENGTH) {
    throw invalidSource("The repository path is too long.");
  }
  return repository;
}

/** @param {unknown} input */
function requestedRevision(input) {
  if (input == null || input === "") return null;
  if (
    typeof input !== "string" ||
    input.length > MAX_REVISION_LENGTH ||
    CONTROL_OR_LINE_SEPARATOR.test(input) ||
    input.trim() !== input
  ) {
    throw invalidSource("Enter a valid branch, tag, ref, or commit.");
  }
  return input;
}

/**
 * A bare owner/repo is GitHub. Public vendor hosts are detected by hostname;
 * custom hosts remain explicit because GitHub Enterprise and GitLab repository
 * URLs have the same shape.
 *
 * @param {unknown} input
 */
export function parseAiReviewerSkillGitSource(input) {
  if (typeof input !== "object" || input == null || Array.isArray(input)) {
    throw invalidSource();
  }
  const value = /** @type {Record<string, unknown>} */ (input);
  const repositoryInput = value.repository;
  const selectedType = gitHostType(value.gitHostType);
  const revision = requestedRevision(value.ref);
  if (
    typeof repositoryInput !== "string" ||
    repositoryInput.length === 0 ||
    repositoryInput.length > MAX_REPOSITORY_LENGTH
  ) {
    throw invalidSource(
      "Enter a repository as owner/repository or a full URL.",
    );
  }

  const shorthand = GITHUB_SHORTHAND.exec(repositoryInput);
  if (shorthand != null) {
    if (selectedType != null && selectedType !== "github") {
      throw invalidSource("A bare owner/repository is GitHub shorthand.");
    }
    return Object.freeze({
      service: /** @type {const} */ ("github"),
      host: "github.com",
      origin: "https://github.com",
      repository: repositoryFromSegments(shorthand.slice(1)),
      requestedRevision: revision,
    });
  }

  let endpoint;
  try {
    endpoint = parseOpenAiCompatibleBaseUrl(repositoryInput);
  } catch {
    throw destinationNotAllowed();
  }
  const url = new URL(endpoint.baseUrl);
  if (
    url.protocol !== "https:" ||
    endpoint.classification === "local" ||
    isLoopbackHostname(url.hostname)
  ) {
    throw destinationNotAllowed();
  }
  const segments = url.pathname.slice(1).split("/");
  const repository = repositoryFromSegments(segments);
  const publicType =
    url.hostname === "github.com"
      ? "github"
      : url.hostname === "gitlab.com"
        ? "gitlab"
        : null;
  if (
    publicType != null &&
    selectedType != null &&
    selectedType !== publicType
  ) {
    throw invalidSource("The selected git host type does not match the URL.");
  }
  const service = publicType ?? selectedType;
  if (service == null) throw hostTypeRequired();
  if (service === "github" && segments.length !== 2) {
    throw invalidSource(
      "A GitHub repository URL must contain owner/repository.",
    );
  }
  return Object.freeze({
    service,
    host: url.host,
    origin: url.origin,
    repository,
    requestedRevision: revision,
  });
}

/** @param {string} value */
function encodePathSegment(value) {
  return encodeURIComponent(value);
}

/** @param {ReturnType<typeof parseAiReviewerSkillGitSource>} source */
function githubAdapter(source) {
  const apiBaseUrl =
    source.host === "github.com"
      ? "https://api.github.com"
      : `${source.origin}/api/v3`;
  const [owner, repository] = source.repository.split("/");
  const repositoryApiPath = `${encodePathSegment(owner)}/${encodePathSegment(repository)}`;
  const resolveUrl =
    source.requestedRevision == null
      ? `${apiBaseUrl}/repos/${repositoryApiPath}/commits?per_page=1`
      : `${apiBaseUrl}/repos/${repositoryApiPath}/commits/${encodePathSegment(source.requestedRevision)}`;
  return {
    apiBaseUrl,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
    resolveUrl,
    treeUrl(sha) {
      return `${apiBaseUrl}/repos/${repositoryApiPath}/git/trees/${sha}?recursive=1`;
    },
    archiveRequest(sha) {
      if (source.host === "github.com") {
        return Object.freeze({
          baseUrl: "https://codeload.github.com",
          url: `https://codeload.github.com/${repositoryApiPath}/tar.gz/${sha}`,
          headers: { accept: "application/x-gzip" },
        });
      }
      return Object.freeze({
        baseUrl: source.origin,
        url: `${source.origin}/${repositoryApiPath}/archive/${sha}.tar.gz`,
        headers: { accept: "application/x-gzip" },
      });
    },
    commitSha(response) {
      const commit = Array.isArray(response) ? response[0] : response;
      return plainRecord(commit).sha;
    },
    treeEntries(response, _headers) {
      const tree = plainRecord(response);
      if (tree.truncated !== false || !Array.isArray(tree.tree)) {
        throw responseInvalid();
      }
      return tree.tree.map((entry) => {
        const record = plainRecord(entry);
        return {
          path: record.path,
          mode: record.mode,
          type: record.type,
          sha: record.sha,
          size: record.size,
        };
      });
    },
  };
}

/** @param {ReturnType<typeof parseAiReviewerSkillGitSource>} source */
function gitlabAdapter(source) {
  const apiBaseUrl = `${source.origin}/api/v4`;
  const project = encodePathSegment(source.repository);
  const resolveUrl =
    source.requestedRevision == null
      ? `${apiBaseUrl}/projects/${project}/repository/commits?per_page=1`
      : `${apiBaseUrl}/projects/${project}/repository/commits/${encodePathSegment(source.requestedRevision)}`;
  return {
    apiBaseUrl,
    headers: { accept: "application/json" },
    resolveUrl,
    treeUrl(sha) {
      return `${apiBaseUrl}/projects/${project}/repository/tree?ref=${sha}&recursive=true&per_page=${MAX_REPOSITORY_TREE_ENTRIES}`;
    },
    archiveRequest(sha) {
      return Object.freeze({
        baseUrl: apiBaseUrl,
        url: `${apiBaseUrl}/projects/${project}/repository/archive.tar.gz?sha=${sha}&include_lfs_blobs=false`,
        headers: { accept: "application/octet-stream" },
      });
    },
    commitSha(response) {
      const commit = Array.isArray(response) ? response[0] : response;
      return plainRecord(commit).id;
    },
    treeEntries(response, headers) {
      const nextPage = headers.get("x-next-page");
      const link = headers.get("link");
      if (
        (nextPage != null && nextPage !== "") ||
        (link != null && /rel="next"/iu.test(link)) ||
        !Array.isArray(response)
      ) {
        throw responseInvalid();
      }
      return response.map((entry) => {
        const record = plainRecord(entry);
        return {
          path: record.path,
          mode: record.mode,
          type: record.type,
          sha: record.id,
          size: record.size,
        };
      });
    },
  };
}

/**
 * Keep all vendor-specific URL and response differences behind one adapter.
 * @param {ReturnType<typeof parseAiReviewerSkillGitSource>} source
 */
function adapterFor(source) {
  return source.service === "github"
    ? githubAdapter(source)
    : gitlabAdapter(source);
}

/** @param {unknown} value */
function plainRecord(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw responseInvalid();
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw responseInvalid();
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/** @param {Response} response @param {unknown} reason */
function cancelResponse(response, reason) {
  try {
    const cancellation = response.body?.cancel(reason);
    Promise.resolve(cancellation).catch(() => {});
  } catch {}
}

/** @param {Headers} headers */
function rateLimitResetTime(headers) {
  for (const header of ["x-ratelimit-reset", "ratelimit-reset"]) {
    const value = headers.get(header);
    if (value != null && /^(?:0|[1-9][0-9]*)$/u.test(value)) {
      const milliseconds = Number(value) * 1_000;
      if (Number.isSafeInteger(milliseconds)) {
        const date = new Date(milliseconds);
        if (!Number.isNaN(date.getTime())) return date.toISOString();
      }
    }
  }
  const resetTime = headers.get("ratelimit-resettime");
  if (resetTime != null && resetTime.length <= 100) {
    const date = new Date(resetTime);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  const retryAfter = headers.get("retry-after");
  if (retryAfter != null && retryAfter.length <= 100) {
    if (/^(?:0|[1-9][0-9]*)$/u.test(retryAfter)) {
      const milliseconds = Date.now() + Number(retryAfter) * 1_000;
      if (Number.isSafeInteger(milliseconds)) {
        return new Date(milliseconds).toISOString();
      }
    }
    const date = new Date(retryAfter);
    if (!Number.isNaN(date.getTime())) return date.toISOString();
  }
  return null;
}

/** @param {Response} response */
function responseIsRateLimited(response) {
  return (
    response.status === 429 ||
    (response.status === 403 &&
      ["x-ratelimit-remaining", "ratelimit-remaining"].some(
        (header) => response.headers.get(header) === "0",
      ))
  );
}

/** @param {unknown} error */
function endpointPolicyFailure(error) {
  return (
    error instanceof OpenAiCompatibleEndpointPolicyError ||
    (typeof error === "object" &&
      error != null &&
      "code" in error &&
      error.code === "AI_OPENAI_COMPATIBLE_ENDPOINT_NOT_ALLOWED")
  );
}

/**
 * @param {{
 *   fetchImpl: typeof fetch,
 *   lookupAll: typeof dnsLookup,
 *   dispatcherFactory: typeof createPinnedOpenAiCompatibleDispatcher,
 * }} dependencies
 * @param {ReturnType<typeof parseAiReviewerSkillGitSource>} source
 * @param {string} baseUrl
 * @param {string} url
 * @param {Record<string, string>} headers
 * @param {AbortSignal} signal
 * @param {{ method?: string, body?: string }} [request]
 */
async function fetchResponse(
  { fetchImpl, lookupAll, dispatcherFactory },
  source,
  baseUrl,
  url,
  headers,
  signal,
  request = {},
) {
  const guarded = createGuardedOpenAiCompatibleFetch({
    baseUrl,
    allowedRequestUrl: url,
    fetchImpl,
    async lookupAll(hostname, options) {
      const addresses = await lookupAll(hostname, options);
      for (const address of addresses) {
        if (typeof address?.address === "string") {
          assertNotLoopbackAddress(address.address);
        }
      }
      return addresses;
    },
    dispatcherFactory,
  });
  let response;
  try {
    response = await guarded(url, {
      method: request.method ?? "GET",
      headers,
      signal,
      ...(request.body == null ? {} : { body: request.body }),
    });
  } catch (error) {
    if (signal.aborted) throw requestTimedOut();
    if (endpointPolicyFailure(error)) throw destinationNotAllowed();
    throw requestFailed();
  }
  if (!(response instanceof Response)) throw responseInvalid();
  if (responseIsRateLimited(response)) {
    const error = rateLimited(
      source.service,
      rateLimitResetTime(response.headers),
    );
    cancelResponse(response, error);
    throw error;
  }
  if (response.status < 200 || response.status >= 300) {
    const error = requestFailed();
    cancelResponse(response, error);
    throw error;
  }
  return response;
}

/**
 * The response body is pulled explicitly so a missing or dishonest
 * Content-Length cannot postpone enforcement until after buffering.
 *
 * @param {Response} response
 * @param {AbortSignal} signal
 * @param {number} maximumBytes
 * @param {readonly string[]} allowedContentTypes
 */
async function readBoundedBody(
  response,
  signal,
  maximumBytes,
  allowedContentTypes,
) {
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  const contentLength = response.headers.get("content-length");
  if (contentType == null || !allowedContentTypes.includes(contentType)) {
    const error = responseInvalid();
    cancelResponse(response, error);
    throw error;
  }
  if (
    contentLength != null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength) ||
      Number(contentLength) > maximumBytes)
  ) {
    const error = responseTooLarge();
    cancelResponse(response, error);
    throw error;
  }
  const reader = response.body?.getReader();
  if (reader == null) throw responseInvalid();
  /** @type {Uint8Array[]} */
  const chunks = [];
  let bytes = 0;
  let chunkCount = 0;
  try {
    while (true) {
      if (signal.aborted) throw requestTimedOut();
      const part = await reader.read();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) throw responseInvalid();
      chunkCount += 1;
      bytes += part.value.byteLength;
      if (chunkCount > MAX_GIT_RESPONSE_CHUNKS || bytes > maximumBytes) {
        throw responseTooLarge();
      }
      chunks.push(part.value);
    }
  } catch (error) {
    try {
      await reader.cancel(error);
    } catch {}
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
  return Buffer.concat(chunks, bytes);
}

/** @param {Buffer} bytes */
function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw responseInvalid();
  }
}

/** @param {Response} response @param {AbortSignal} signal */
async function readBoundedJson(response, signal) {
  const bytes = await readBoundedBody(
    response,
    signal,
    MAX_GIT_API_RESPONSE_BYTES,
    ["application/json", "application/vnd.github+json"],
  );
  try {
    return JSON.parse(decodeUtf8(bytes));
  } catch (error) {
    if (error instanceof AiReviewerSkillGitImportError) throw error;
    throw responseInvalid();
  }
}

/** @param {Buffer} bytes */
function tarString(bytes) {
  const end = bytes.indexOf(0);
  const value = end < 0 ? bytes : bytes.subarray(0, end);
  return decodeUtf8(value);
}

/** @param {Buffer} bytes */
function tarOctal(bytes) {
  const text = tarString(bytes).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/u.test(text)) throw responseInvalid();
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw responseInvalid();
  return value;
}

/** @param {Buffer} header */
function assertTarChecksum(header) {
  const recorded = tarOctal(header.subarray(148, 156));
  let actual = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    actual += index >= 148 && index < 156 ? 32 : header[index];
  }
  if (recorded !== actual) throw responseInvalid();
}

/** @param {Buffer} bytes */
function parsePaxHeaders(bytes) {
  /** @type {Map<string, string>} */
  const fields = new Map();
  let offset = 0;
  while (offset < bytes.byteLength) {
    const space = bytes.indexOf(32, offset);
    if (space < 0) throw responseInvalid();
    const lengthText = bytes.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/u.test(lengthText)) throw responseInvalid();
    const length = Number(lengthText);
    if (
      !Number.isSafeInteger(length) ||
      length <= space - offset + 2 ||
      offset + length > bytes.byteLength
    ) {
      throw responseInvalid();
    }
    const record = bytes.subarray(space + 1, offset + length);
    if (record.at(-1) !== 10) throw responseInvalid();
    const separator = record.indexOf(61);
    if (separator <= 0) throw responseInvalid();
    const key = record.subarray(0, separator).toString("ascii");
    const value = decodeUtf8(record.subarray(separator + 1, -1));
    if (key === "path" || key === "size") fields.set(key, value);
    offset += length;
  }
  return fields;
}

class ArchiveByteReader {
  /** @param {ReadableStreamDefaultReader<Uint8Array>} reader */
  constructor(reader) {
    this.reader = reader;
    /** @type {Uint8Array | null} */
    this.current = null;
    this.offset = 0;
    this.done = false;
  }

  /**
   * @param {number} length
   * @param {boolean} collect
   * @param {boolean} [allowEof]
   */
  async consume(length, collect, allowEof = false) {
    /** @type {Uint8Array[]} */
    const pieces = [];
    let consumed = 0;
    while (consumed < length) {
      if (this.current == null || this.offset === this.current.byteLength) {
        const part = await this.reader.read();
        if (part.done) {
          this.done = true;
          if (allowEof && consumed === 0) return null;
          throw responseInvalid();
        }
        if (
          !(part.value instanceof Uint8Array) ||
          part.value.byteLength === 0
        ) {
          throw responseInvalid();
        }
        this.current = part.value;
        this.offset = 0;
      }
      const available = this.current.byteLength - this.offset;
      const take = Math.min(length - consumed, available);
      if (collect) {
        pieces.push(this.current.subarray(this.offset, this.offset + take));
      }
      this.offset += take;
      consumed += take;
    }
    return collect ? Buffer.concat(pieces, length) : Buffer.alloc(0);
  }

  /** @param {number} length @param {boolean} [allowEof] */
  async read(length, allowEof = false) {
    return await this.consume(length, true, allowEof);
  }

  /** @param {number} length */
  async skip(length) {
    await this.consume(length, false);
  }
}

/** @param {string} fullPath @param {{ value: string | null }} archiveRoot */
function repositoryPathFromArchive(fullPath, archiveRoot) {
  const withoutTrailingSlash = fullPath.replace(/\/+$/u, "");
  if (
    withoutTrailingSlash.length === 0 ||
    withoutTrailingSlash.startsWith("/") ||
    withoutTrailingSlash.includes("\\") ||
    CONTROL_OR_LINE_SEPARATOR.test(withoutTrailingSlash)
  ) {
    throw responseInvalid();
  }
  const segments = withoutTrailingSlash.split("/");
  if (
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment === "__proto__" ||
        segment === "constructor" ||
        segment === "prototype",
    )
  ) {
    throw responseInvalid();
  }
  if (archiveRoot.value == null) archiveRoot.value = segments[0];
  if (segments[0] !== archiveRoot.value) throw responseInvalid();
  if (segments.length === 1) return null;
  return assertRepositoryPath(segments.slice(1).join("/"));
}

/**
 * Parse a host-generated tar.gz without materialising the repository. Every
 * compressed and expanded chunk is bounded before it can be buffered, and a
 * caller chooses the small set of regular files whose bodies are retained.
 *
 * @param {Response} response
 * @param {AbortSignal} signal
 * @param {{
 *   retain(path: string, size: number, mode: number): number | null,
 *   file(path: string, bytes: Buffer): void,
 * }} receiver
 */
async function readRepositoryArchive(response, signal, receiver) {
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  const contentLength = response.headers.get("content-length");
  if (
    contentType == null ||
    !ARCHIVE_CONTENT_TYPES.includes(contentType) ||
    response.headers.get("content-encoding") != null
  ) {
    const error = responseInvalid();
    cancelResponse(response, error);
    throw error;
  }
  if (
    contentLength != null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength) ||
      Number(contentLength) > MAX_GIT_ARCHIVE_COMPRESSED_BYTES)
  ) {
    const error = responseTooLarge();
    cancelResponse(response, error);
    throw error;
  }
  if (response.body == null) throw responseInvalid();

  let compressedBytes = 0;
  let compressedChunks = 0;
  let expandedBytes = 0;
  let expandedChunks = 0;
  const compressed = response.body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        if (!(chunk instanceof Uint8Array)) throw responseInvalid();
        compressedBytes += chunk.byteLength;
        compressedChunks += 1;
        if (
          compressedBytes > MAX_GIT_ARCHIVE_COMPRESSED_BYTES ||
          compressedChunks > MAX_GIT_ARCHIVE_CHUNKS
        ) {
          throw responseTooLarge();
        }
        controller.enqueue(chunk);
      },
    }),
  );
  const expanded = compressed
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          if (!(chunk instanceof Uint8Array)) throw responseInvalid();
          expandedBytes += chunk.byteLength;
          expandedChunks += 1;
          if (
            expandedBytes > MAX_GIT_ARCHIVE_EXPANDED_BYTES ||
            expandedChunks > MAX_GIT_ARCHIVE_CHUNKS
          ) {
            throw responseTooLarge();
          }
          controller.enqueue(chunk);
        },
      }),
    );
  const streamReader = expanded.getReader();
  const reader = new ArchiveByteReader(streamReader);
  const timeoutError = requestTimedOut();
  const abort = () => {
    Promise.resolve(streamReader.cancel(timeoutError)).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  const archiveRoot = { value: /** @type {string | null} */ (null) };
  const seenPaths = new Set();
  let nextPax = new Map();
  let nextLongPath = null;
  let zeroBlocks = 0;
  try {
    while (true) {
      if (signal.aborted) throw timeoutError;
      const header = await reader.read(512, true);
      if (header == null) {
        if (zeroBlocks < 2) throw responseInvalid();
        break;
      }
      if (header.every((byte) => byte === 0)) {
        zeroBlocks += 1;
        continue;
      }
      if (zeroBlocks > 0) throw responseInvalid();
      assertTarChecksum(header);
      const magic = tarString(header.subarray(257, 263));
      if (magic !== "" && magic !== "ustar") throw responseInvalid();
      const name = tarString(header.subarray(0, 100));
      const prefix = tarString(header.subarray(345, 500));
      let fullPath = prefix === "" ? name : `${prefix}/${name}`;
      if (nextLongPath != null) fullPath = nextLongPath;
      if (nextPax.has("path")) fullPath = nextPax.get("path");
      let size = tarOctal(header.subarray(124, 136));
      if (nextPax.has("size")) {
        const paxSize = nextPax.get("size");
        if (!/^(?:0|[1-9][0-9]*)$/u.test(paxSize)) throw responseInvalid();
        size = Number(paxSize);
        if (!Number.isSafeInteger(size)) throw responseInvalid();
      }
      nextPax = new Map();
      nextLongPath = null;
      const mode = tarOctal(header.subarray(100, 108));
      const type = String.fromCharCode(header[156] ?? 0);
      const padding = (512 - (size % 512)) % 512;

      if (type === "x" || type === "g") {
        if (size > MAX_TAR_METADATA_BYTES) throw responseTooLarge();
        const metadata = await reader.read(size);
        await reader.skip(padding);
        const parsed = parsePaxHeaders(metadata);
        if (type === "x") nextPax = parsed;
        continue;
      }
      if (type === "L") {
        if (size > MAX_TAR_METADATA_BYTES) throw responseTooLarge();
        const longName = await reader.read(size);
        await reader.skip(padding);
        nextLongPath = tarString(longName);
        continue;
      }

      const path = repositoryPathFromArchive(fullPath, archiveRoot);
      if (path == null || type === "5") {
        await reader.skip(size + padding);
        continue;
      }
      if (seenPaths.has(path)) throw responseInvalid();
      seenPaths.add(path);
      const regular = type === "0" || type === "\0";
      const maximumBytes = regular ? receiver.retain(path, size, mode) : null;
      if (maximumBytes != null && size > maximumBytes) {
        throw responseTooLarge();
      }
      const bytes =
        regular && maximumBytes != null ? await reader.read(size) : null;
      if (bytes == null) await reader.skip(size);
      await reader.skip(padding);
      if (bytes != null) receiver.file(path, bytes);
    }
    if (signal.aborted) throw timeoutError;
  } catch (error) {
    try {
      await streamReader.cancel(error);
    } catch {}
    if (signal.aborted) throw timeoutError;
    if (error instanceof AiReviewerSkillGitImportError) throw error;
    throw responseInvalid();
  } finally {
    signal.removeEventListener("abort", abort);
    try {
      streamReader.releaseLock();
    } catch {}
  }
}

/** @param {string} path */
function assertRepositoryPath(path) {
  if (
    path.length === 0 ||
    path.length > MAX_REPOSITORY_PATH_LENGTH ||
    path.startsWith("/") ||
    path.endsWith("/") ||
    path.includes("\\") ||
    CONTROL_OR_LINE_SEPARATOR.test(path)
  ) {
    throw responseInvalid();
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment === "__proto__" ||
        segment === "constructor" ||
        segment === "prototype",
    )
  ) {
    throw responseInvalid();
  }
  return path;
}

/**
 * @typedef {{ path: string, mode: string, type: string, sha: string, size: number | null }} RepositoryTreeEntry
 */

/** @param {unknown[]} rawEntries */
function repositoryTree(rawEntries) {
  if (rawEntries.length > MAX_REPOSITORY_TREE_ENTRIES) {
    throw responseTooLarge();
  }
  /** @type {Map<string, RepositoryTreeEntry>} */
  const entries = new Map();
  for (const rawEntry of rawEntries) {
    const record = plainRecord(rawEntry);
    const { path, mode, type, sha, size } = record;
    if (
      typeof path !== "string" ||
      typeof mode !== "string" ||
      typeof type !== "string" ||
      typeof sha !== "string" ||
      !GIT_SHA.test(sha) ||
      (size != null && (!Number.isSafeInteger(size) || Number(size) < 0))
    ) {
      throw responseInvalid();
    }
    assertRepositoryPath(path);
    if (entries.has(path)) throw responseInvalid();
    entries.set(
      path,
      Object.freeze({
        path,
        mode,
        type,
        sha,
        size: size == null ? null : Number(size),
      }),
    );
  }
  return entries;
}

/** @param {RepositoryTreeEntry | undefined} entry */
function readableBlob(entry) {
  return entry?.type === "blob" && entry.mode === "100644";
}

/** @param {RepositoryTreeEntry} entry @param {Buffer} bytes */
function assertBlobMatchesTree(entry, bytes) {
  if (entry.size != null && entry.size !== bytes.byteLength) {
    throw responseInvalid();
  }
  const oid = createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`, "utf8")
    .update(bytes)
    .digest("hex");
  if (oid !== entry.sha) throw responseInvalid();
}

/**
 * @param {ReturnType<typeof parseAiReviewerSkillGitSource>} source
 * @param {string} resolvedSha
 * @param {Map<string, RepositoryTreeEntry>} entries
 */
function repositorySnapshotHash(source, resolvedSha, entries) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "ai-reviewer-skill-git-preview-v4",
        source.service,
        source.host,
        source.repository,
        resolvedSha,
        [...entries.values()]
          .map(({ path, mode, type, sha }) => [path, mode, type, sha])
          .sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
          ),
      ]),
      "utf8",
    )
    .digest("hex");
}

/** @param {Map<string, Buffer>} files @param {string} path @param {number} maximumBytes */
function requiredTextFile(files, path, maximumBytes) {
  const bytes = files.get(path);
  if (bytes == null || bytes.byteLength > maximumBytes) throw responseInvalid();
  return decodeUtf8(bytes);
}

/** @param {unknown} value @param {string} field @param {boolean} [required] */
function manifestString(value, field, required = false) {
  if (value == null && !required) return null;
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_MANIFEST_METADATA_LENGTH ||
    CONTROL_OR_LINE_SEPARATOR.test(value)
  ) {
    throw manifestInvalid(`The repository manifest ${field} is invalid.`);
  }
  return value.trim();
}

/** @param {unknown} value @param {string} field */
function manifestOwner(value, field) {
  if (value == null) return null;
  if (typeof value === "string") {
    return Object.freeze({ name: manifestString(value, field, true) });
  }
  let record;
  try {
    record = plainRecord(value);
  } catch {
    throw manifestInvalid(`The repository manifest ${field} is invalid.`);
  }
  const name = manifestString(record.name, `${field} name`, true);
  const url = manifestString(record.url, `${field} URL`);
  return Object.freeze({ name, ...(url == null ? {} : { url }) });
}

/** @param {string} value @param {boolean} allowRoot */
function manifestRelativePath(value, allowRoot) {
  const withoutPrefix = value.startsWith("./") ? value.slice(2) : value;
  if (allowRoot && (value === "." || value === "./")) return "";
  if (
    withoutPrefix.length === 0 ||
    withoutPrefix.length > MAX_REPOSITORY_PATH_LENGTH ||
    withoutPrefix.startsWith("/") ||
    withoutPrefix.includes("\\") ||
    CONTROL_OR_LINE_SEPARATOR.test(withoutPrefix)
  ) {
    throw manifestInvalid(
      "The repository manifest contains an unsafe skill path.",
    );
  }
  const segments = withoutPrefix.replace(/\/$/u, "").split("/");
  if (
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment === "__proto__" ||
        segment === "constructor" ||
        segment === "prototype",
    )
  ) {
    throw manifestInvalid(
      "The repository manifest contains an unsafe skill path.",
    );
  }
  return segments.join("/");
}

/** @param {Map<string, Buffer>} files @param {string} root */
function pluginManifest(files, root) {
  const path =
    root === "" ? PLUGIN_MANIFEST_PATH : `${root}/${PLUGIN_MANIFEST_PATH}`;
  if (!files.has(path)) return null;
  try {
    return plainRecord(
      JSON.parse(requiredTextFile(files, path, MAX_MANIFEST_BYTES)),
    );
  } catch (error) {
    if (error instanceof AiReviewerSkillGitImportError) throw error;
    throw manifestInvalid("The repository plugin manifest is invalid JSON.");
  }
}

/** @param {Map<string, Buffer>} files */
function marketplacePluginRoots(files) {
  if (!files.has(MARKETPLACE_MANIFEST_PATH)) return Object.freeze([]);
  let marketplace;
  try {
    marketplace = plainRecord(
      JSON.parse(
        requiredTextFile(files, MARKETPLACE_MANIFEST_PATH, MAX_MANIFEST_BYTES),
      ),
    );
  } catch (error) {
    if (error instanceof AiReviewerSkillGitImportError) throw error;
    throw manifestInvalid(
      "The repository marketplace manifest is invalid JSON.",
    );
  }
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
    throw manifestInvalid(
      "The repository marketplace manifest declares no plugins.",
    );
  }
  if (marketplace.plugins.length > AI_REVIEWER_SKILL_COUNT_LIMIT) {
    throw tooManyRepositorySkills();
  }
  const roots = new Set();
  for (const rawPlugin of marketplace.plugins) {
    let plugin;
    try {
      plugin = plainRecord(rawPlugin);
    } catch {
      throw manifestInvalid("The repository marketplace plugin is invalid.");
    }
    roots.add(
      manifestRelativePath(
        manifestString(plugin.source ?? "./", "plugin source", true),
        true,
      ),
    );
  }
  return Object.freeze([...roots]);
}

/** @param {Map<string, Buffer>} files */
function marketplaceDeclaredSkillPaths(files) {
  let marketplace;
  try {
    marketplace = plainRecord(
      JSON.parse(
        requiredTextFile(files, MARKETPLACE_MANIFEST_PATH, MAX_MANIFEST_BYTES),
      ),
    );
  } catch (error) {
    if (error instanceof AiReviewerSkillGitImportError) throw error;
    throw manifestInvalid(
      "The repository marketplace manifest is invalid JSON.",
    );
  }
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
    throw manifestInvalid(
      "The repository marketplace manifest declares no plugins.",
    );
  }
  if (marketplace.plugins.length > AI_REVIEWER_SKILL_COUNT_LIMIT) {
    throw tooManyRepositorySkills();
  }
  const paths = [];
  const seen = new Set();
  for (const rawPlugin of marketplace.plugins) {
    let plugin;
    try {
      plugin = plainRecord(rawPlugin);
    } catch {
      throw manifestInvalid("The repository marketplace plugin is invalid.");
    }
    const root = manifestRelativePath(
      manifestString(plugin.source ?? "./", "plugin source", true),
      true,
    );
    if (!Array.isArray(plugin.skills) || plugin.skills.length === 0) {
      throw manifestInvalid(
        "A repository marketplace plugin declares no skills.",
      );
    }
    for (const rawSkillPath of plugin.skills) {
      const declared = manifestRelativePath(
        manifestString(rawSkillPath, "skill path", true),
        false,
      );
      const directory = [root, declared].filter(Boolean).join("/");
      const path =
        directory.endsWith("/SKILL.md") || directory === "SKILL.md"
          ? directory
          : `${directory}/SKILL.md`;
      if (seen.has(path)) {
        throw manifestInvalid(
          "The repository manifest declares a skill more than once.",
        );
      }
      seen.add(path);
      paths.push(path);
      if (paths.length > AI_REVIEWER_SKILL_COUNT_LIMIT) {
        throw tooManyRepositorySkills();
      }
    }
  }
  return Object.freeze(paths);
}

/**
 * @param {Map<string, Buffer>} files
 * @param {Map<string, RepositoryTreeEntry>} entries
 * @returns {{ manifestFound: boolean, plugins: readonly PreviewPlugin[], declarations: readonly { path: string, facts: ManifestFacts }[] }}
 */
function discoverSkillDeclarations(files, entries) {
  if (!readableBlob(entries.get(MARKETPLACE_MANIFEST_PATH))) {
    const paths = [...entries.values()]
      .filter(
        (entry) =>
          readableBlob(entry) &&
          (entry.path === "SKILL.md" || entry.path.endsWith("/SKILL.md")),
      )
      .map(({ path }) => path)
      .sort();
    if (paths.length === 0) {
      throw manifestInvalid("The repository does not contain a SKILL.md file.");
    }
    if (paths.length > AI_REVIEWER_SKILL_COUNT_LIMIT) {
      throw tooManyRepositorySkills();
    }
    return Object.freeze({
      manifestFound: false,
      plugins: Object.freeze([]),
      declarations: Object.freeze(
        paths.map((path) => Object.freeze({ path, facts: Object.freeze({}) })),
      ),
    });
  }

  let marketplace;
  try {
    marketplace = plainRecord(
      JSON.parse(
        requiredTextFile(files, MARKETPLACE_MANIFEST_PATH, MAX_MANIFEST_BYTES),
      ),
    );
  } catch (error) {
    if (error instanceof AiReviewerSkillGitImportError) throw error;
    throw manifestInvalid(
      "The repository marketplace manifest is invalid JSON.",
    );
  }
  const owner = manifestOwner(marketplace.owner, "owner");
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
    throw manifestInvalid(
      "The repository marketplace manifest declares no plugins.",
    );
  }
  /** @type {PreviewPlugin[]} */
  const plugins = [];
  /** @type {{ path: string, facts: ManifestFacts }[]} */
  const declarations = [];
  const declaredPaths = new Set();
  for (const rawPlugin of marketplace.plugins) {
    let plugin;
    try {
      plugin = plainRecord(rawPlugin);
    } catch {
      throw manifestInvalid("The repository marketplace plugin is invalid.");
    }
    const root = manifestRelativePath(
      manifestString(plugin.source ?? "./", "plugin source", true),
      true,
    );
    const localPlugin = pluginManifest(files, root);
    const name = manifestString(
      plugin.name ?? localPlugin?.name,
      "plugin name",
      true,
    );
    const version = manifestString(
      plugin.version ?? localPlugin?.version,
      "plugin version",
    );
    const license = manifestString(
      plugin.license ?? localPlugin?.license,
      "plugin license",
    );
    const pluginOwner =
      owner ?? manifestOwner(localPlugin?.author, "plugin author");
    const homepage = manifestString(
      plugin.homepage ?? localPlugin?.homepage,
      "plugin homepage",
    );
    if (!Array.isArray(plugin.skills) || plugin.skills.length === 0) {
      throw manifestInvalid(
        `The repository plugin ${JSON.stringify(name)} declares no skills.`,
      );
    }
    const previewPlugin = Object.freeze({
      name,
      version,
      license,
      owner: pluginOwner,
      homepage,
    });
    plugins.push(previewPlugin);
    for (const rawSkillPath of plugin.skills) {
      const declared = manifestRelativePath(
        manifestString(rawSkillPath, "skill path", true),
        false,
      );
      const directory = [root, declared].filter(Boolean).join("/");
      const path =
        directory.endsWith("/SKILL.md") || directory === "SKILL.md"
          ? directory
          : `${directory}/SKILL.md`;
      if (declaredPaths.has(path)) {
        throw manifestInvalid(
          "The repository manifest declares a skill more than once.",
        );
      }
      declaredPaths.add(path);
      const facts = Object.freeze({
        pluginName: name,
        ...(version == null ? {} : { pluginVersion: version }),
        ...(license == null ? {} : { license }),
        ...(pluginOwner == null ? {} : { owner: pluginOwner }),
        ...(homepage == null ? {} : { homepage }),
      });
      declarations.push(Object.freeze({ path, facts }));
      if (declarations.length > AI_REVIEWER_SKILL_COUNT_LIMIT) {
        throw tooManyRepositorySkills();
      }
    }
  }
  return Object.freeze({
    manifestFound: true,
    plugins: Object.freeze(plugins),
    declarations: Object.freeze(declarations),
  });
}

/** @param {string} body */
function markdownPathMentions(body) {
  const paths = new Set();
  for (const match of body.matchAll(MARKDOWN_PATH_MENTION)) {
    paths.add(match[1]);
    if (paths.size > MAX_REFERENCE_MENTIONS) {
      throw invalidSource("SKILL.md mentions too many reference files.");
    }
  }
  return [...paths].sort();
}

/** @param {string} skillPath @param {string} mention */
function resolveReferenceMention(skillPath, mention) {
  const absolute = mention.startsWith("/");
  const rawSegments = (absolute ? mention.slice(1) : mention).split("/");
  if (
    rawSegments.some(
      (segment) =>
        segment === ".." ||
        segment === "__proto__" ||
        segment === "constructor" ||
        segment === "prototype",
    )
  ) {
    throw invalidSource("SKILL.md mentions an unsafe reference path.");
  }
  if (absolute) {
    return Object.freeze({
      skipped: /** @type {SkippedReference} */ ({
        path: mention,
        reason: "outside-skill-directory",
      }),
    });
  }
  const relativeSegments = rawSegments.filter((segment) => segment !== ".");
  const relativePath = relativeSegments.join("/");
  if (
    relativePath.length === 0 ||
    relativePath.length > MAX_REPOSITORY_PATH_LENGTH
  ) {
    return Object.freeze({
      skipped: /** @type {SkippedReference} */ ({
        path: mention,
        reason: "not-readable",
      }),
    });
  }
  if (relativeSegments.at(-1)?.toLowerCase() === "skill.md") {
    return Object.freeze({
      skipped: /** @type {SkippedReference} */ ({
        path: mention,
        reason: "not-reference-file",
      }),
    });
  }
  const directorySegments = skillPath.split("/").slice(0, -1);
  return Object.freeze({
    candidate: Object.freeze({
      mention,
      relativePath,
      repositoryPath: [...directorySegments, ...relativeSegments].join("/"),
    }),
  });
}

/** @param {ManifestFacts} facts */
function provenanceFacts(facts) {
  return {
    ...(facts.pluginName == null ? {} : { pluginName: facts.pluginName }),
    ...(facts.pluginVersion == null
      ? {}
      : { pluginVersion: facts.pluginVersion }),
    ...(facts.license == null ? {} : { license: facts.license }),
    ...(facts.owner == null ? {} : { owner: facts.owner }),
    ...(facts.homepage == null ? {} : { homepage: facts.homepage }),
  };
}

/**
 * @param {ReturnType<typeof parseAiReviewerSkillGitSource>} source
 * @param {string} resolvedSha
 * @param {Map<string, RepositoryTreeEntry>} entries
 * @param {Map<string, Buffer>} files
 * @param {ReturnType<typeof discoverSkillDeclarations>} discovery
 * @param {string} contentHash
 */
function buildRepositoryPreview(
  source,
  resolvedSha,
  entries,
  files,
  discovery,
  contentHash,
) {
  /** @type {any[]} */
  const internalSkills = [];
  for (const declaration of discovery.declarations) {
    const skillBytes = files.get(declaration.path);
    if (
      skillBytes == null ||
      skillBytes.byteLength > AI_REVIEWER_SKILL_MAX_BYTES
    ) {
      throw manifestInvalid(
        `The declared skill ${JSON.stringify(declaration.path)} could not be read within the skill size limit.`,
      );
    }
    const skillMarkdown = decodeUtf8(skillBytes);
    const mentions = markdownPathMentions(skillMarkdown);
    /** @type {SkippedReference[]} */
    const skippedReferences = [];
    /** @type {Map<string, { mention: string, relativePath: string, repositoryPath: string }>} */
    const candidates = new Map();
    for (const mention of mentions) {
      const resolved = resolveReferenceMention(declaration.path, mention);
      if (resolved.skipped != null) {
        skippedReferences.push(resolved.skipped);
      } else if (!candidates.has(resolved.candidate.relativePath)) {
        candidates.set(resolved.candidate.relativePath, resolved.candidate);
      }
    }
    const provenance = Object.freeze({
      kind: /** @type {const} */ ("git"),
      service: source.service,
      host: source.host,
      repository: source.repository,
      path: declaration.path,
      resolvedSha,
      ...provenanceFacts(declaration.facts),
    });
    const prepared = prepareAiReviewerSkill({
      skillMarkdown,
      referenceFiles: {},
      provenance,
    });
    let aggregateBytes = aiReviewerSkillContentBytes(prepared.body, {});
    const referenceCandidates = [];
    for (const candidate of candidates.values()) {
      const entry = entries.get(candidate.repositoryPath);
      if (!readableBlob(entry)) {
        skippedReferences.push({
          path: candidate.mention,
          reason: "not-readable",
        });
        continue;
      }
      if (entry.size == null) throw responseInvalid();
      referenceCandidates.push(
        Object.freeze({
          mention: candidate.mention,
          relativePath: candidate.relativePath,
          repositoryPath: candidate.repositoryPath,
          entry,
        }),
      );
      aggregateBytes += entry.size;
    }
    if (aggregateBytes > AI_REVIEWER_SKILL_MAX_BYTES) {
      throw skillTooLarge(prepared.name, declaration.path, aggregateBytes);
    }
    skippedReferences.sort(({ path: left }, { path: right }) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    internalSkills.push(
      Object.freeze({
        path: declaration.path,
        prepared,
        provenance,
        skillMarkdown,
        referenceCandidates: Object.freeze(referenceCandidates),
        skippedReferences: Object.freeze(
          skippedReferences.map((reference) => Object.freeze(reference)),
        ),
        totalSizeBytes: aggregateBytes,
      }),
    );
  }

  const preview = Object.freeze({
    source: Object.freeze({
      service: source.service,
      host: source.host,
      repository: source.repository,
      requestedRevision: source.requestedRevision,
      resolvedSha,
    }),
    manifestFound: discovery.manifestFound,
    plugins: discovery.plugins,
    skills: Object.freeze(
      internalSkills.map((skill) =>
        Object.freeze({
          path: skill.path,
          name: skill.prepared.name,
          description: skill.prepared.description,
          bodySizeBytes: Buffer.byteLength(skill.prepared.body, "utf8"),
          totalSizeBytes: skill.totalSizeBytes,
          referenceFiles: Object.freeze(
            skill.referenceCandidates.map(({ relativePath, entry }) =>
              Object.freeze({
                path: relativePath,
                sizeBytes: entry.size,
              }),
            ),
          ),
          skippedReferences: skill.skippedReferences,
          ...(skill.provenance.pluginName == null
            ? {}
            : { pluginName: skill.provenance.pluginName }),
        }),
      ),
    ),
    contentHash,
  });
  return Object.freeze({
    preview,
    internalSkills: Object.freeze(internalSkills),
  });
}

/** @param {string} [message] */
function previewChanged(
  message = "The fetched skills did not match the preview. Preview them again before importing.",
) {
  return new AiReviewerSkillGitImportError(message, {
    code: "AI_REVIEWER_SKILL_GIT_PREVIEW_CHANGED",
    status: 409,
  });
}

/** @param {unknown} input */
function confirmation(input) {
  if (typeof input !== "object" || input == null || Array.isArray(input)) {
    throw invalidSource();
  }
  const value = /** @type {Record<string, unknown>} */ (input);
  const source = parseAiReviewerSkillGitSource(value);
  if (
    typeof value.resolvedSha !== "string" ||
    !GIT_SHA.test(value.resolvedSha) ||
    typeof value.contentHash !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.contentHash) ||
    !Array.isArray(value.selectedPaths) ||
    value.selectedPaths.length === 0 ||
    value.selectedPaths.length > AI_REVIEWER_SKILL_COUNT_LIMIT
  ) {
    throw invalidSource("The import confirmation is invalid.");
  }
  const selectedPaths = value.selectedPaths.map((path) => {
    if (typeof path !== "string") {
      throw invalidSource("The import confirmation is invalid.");
    }
    return manifestRelativePath(path, false);
  });
  if (new Set(selectedPaths).size !== selectedPaths.length) {
    throw invalidSource(
      "The import confirmation selects a skill more than once.",
    );
  }
  return Object.freeze({
    source,
    resolvedSha: value.resolvedSha,
    contentHash: value.contentHash,
    selectedPaths: Object.freeze(selectedPaths),
  });
}

/**
 * @param {{
 *   fetchImpl?: typeof fetch,
 *   lookupAll?: typeof dnsLookup,
 *   dispatcherFactory?: typeof createPinnedOpenAiCompatibleDispatcher,
 *   timeoutSignal?: (milliseconds: number) => AbortSignal,
 * }} [dependencies]
 */
export function createAiReviewerSkillGitImporter({
  fetchImpl = globalThis.fetch,
  lookupAll = dnsLookup,
  dispatcherFactory = createPinnedOpenAiCompatibleDispatcher,
  timeoutSignal = (milliseconds) => AbortSignal.timeout(milliseconds),
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new TypeError("fetchImpl must be a function.");
  }
  const dependencies = { fetchImpl, lookupAll, dispatcherFactory };

  /**
   * @param {ReturnType<typeof parseAiReviewerSkillGitSource>} source
   * @param {string} resolvedSha
   * @param {AbortSignal} signal
   */
  async function fetchRepositoryTree(source, resolvedSha, signal) {
    if (!GIT_SHA.test(resolvedSha)) throw responseInvalid();
    const adapter = adapterFor(source);
    const response = await fetchResponse(
      dependencies,
      source,
      adapter.apiBaseUrl,
      adapter.treeUrl(resolvedSha),
      adapter.headers,
      signal,
    );
    const value = await readBoundedJson(response, signal);
    return repositoryTree(adapter.treeEntries(value, response.headers));
  }

  /** @param {Map<string, RepositoryTreeEntry>} entries */
  function assertKnownArchiveSize(entries) {
    let expandedBytes = 3 * 512;
    for (const entry of entries.values()) {
      expandedBytes += 512;
      if (entry.type !== "blob") continue;
      if (entry.size == null) return;
      expandedBytes += entry.size + ((512 - (entry.size % 512)) % 512);
      if (expandedBytes > MAX_GIT_ARCHIVE_EXPANDED_BYTES) {
        throw responseTooLarge();
      }
    }
  }

  /**
   * @param {ReturnType<typeof parseAiReviewerSkillGitSource>} source
   * @param {string} resolvedSha
   * @param {Map<string, RepositoryTreeEntry>} entries
   * @param {readonly string[] | null} selectedPaths
   * @param {AbortSignal} signal
   */
  async function fetchArchiveFiles(
    source,
    resolvedSha,
    entries,
    selectedPaths,
    signal,
  ) {
    assertKnownArchiveSize(entries);
    const adapter = adapterFor(source);
    const request = adapter.archiveRequest(resolvedSha);
    const response = await fetchResponse(
      dependencies,
      source,
      request.baseUrl,
      request.url,
      request.headers,
      signal,
    );
    /** @type {Map<string, Buffer>} */
    const files = new Map();
    /** @type {Map<string, "manifest" | "skill" | "reference">} */
    const desired = new Map();
    /** @type {Map<string, { name: string, baseBytes: number, references: Set<string> }>} */
    const skillStates = new Map();
    /** @type {Map<string, Set<string>>} */
    const referenceOwners = new Map();
    const passed = new Set();
    const selected = selectedPaths == null ? null : new Set(selectedPaths);
    const maximumRetainedBytes =
      AI_REVIEWER_SKILL_COUNT_LIMIT * AI_REVIEWER_SKILL_MAX_BYTES +
      (2 * AI_REVIEWER_SKILL_COUNT_LIMIT + 1) * MAX_MANIFEST_BYTES;
    let retainedBytes = 0;

    /** @param {string} path @param {"manifest" | "skill" | "reference"} kind */
    const retain = (path, kind) => {
      if (passed.has(path) && !files.has(path)) throw responseInvalid();
      desired.set(path, kind);
    };

    /** @param {string} path */
    const checkSkillSize = (path) => {
      const state = skillStates.get(path);
      if (state == null) return;
      let totalBytes = state.baseBytes;
      for (const referencePath of state.references) {
        const size = entries.get(referencePath)?.size;
        if (size == null) return;
        totalBytes += size;
      }
      if (totalBytes > AI_REVIEWER_SKILL_MAX_BYTES) {
        throw skillTooLarge(state.name, path, totalBytes);
      }
    };

    /** @param {string} path @param {Buffer} bytes */
    const inspectSkill = (path, bytes) => {
      const skillMarkdown = decodeUtf8(bytes);
      const parsed = parseAiReviewerSkill(skillMarkdown);
      const baseBytes = Buffer.byteLength(parsed.body, "utf8");
      if (baseBytes > AI_REVIEWER_SKILL_MAX_BYTES) {
        throw skillTooLarge(parsed.name, path, baseBytes);
      }
      const prepared = prepareAiReviewerSkill({
        skillMarkdown,
        referenceFiles: {},
      });
      const references = new Set();
      const relativePaths = new Set();
      for (const mention of markdownPathMentions(skillMarkdown)) {
        const resolved = resolveReferenceMention(path, mention);
        const candidate = resolved.candidate;
        if (
          candidate == null ||
          relativePaths.has(candidate.relativePath) ||
          !readableBlob(entries.get(candidate.repositoryPath))
        ) {
          continue;
        }
        relativePaths.add(candidate.relativePath);
        references.add(candidate.repositoryPath);
        retain(candidate.repositoryPath, "reference");
        const owners =
          referenceOwners.get(candidate.repositoryPath) ?? new Set();
        owners.add(path);
        referenceOwners.set(candidate.repositoryPath, owners);
      }
      skillStates.set(
        path,
        Object.freeze({
          name: prepared.name,
          baseBytes,
          references,
        }),
      );
      checkSkillSize(path);
    };

    /** @param {readonly string[]} declaredPaths */
    const retainDeclaredSkills = (declaredPaths) => {
      const declared = new Set(declaredPaths);
      if (
        selected != null &&
        [...selected].some((path) => !declared.has(path))
      ) {
        throw previewChanged(
          "The selected skills did not match the preview. Preview them again before importing.",
        );
      }
      for (const path of declaredPaths) {
        if (selected == null || selected.has(path)) retain(path, "skill");
      }
    };

    const marketplaceEntry = entries.get(MARKETPLACE_MANIFEST_PATH);
    if (readableBlob(marketplaceEntry)) {
      retain(MARKETPLACE_MANIFEST_PATH, "manifest");
    } else {
      const fallback = discoverSkillDeclarations(files, entries);
      retainDeclaredSkills(fallback.declarations.map(({ path }) => path));
    }

    await readRepositoryArchive(response, signal, {
      retain(path, size, mode) {
        passed.add(path);
        const kind = desired.get(path);
        if (kind == null) return null;
        const entry = entries.get(path);
        if (!readableBlob(entry) || (mode & 0o111) !== 0) {
          throw responseInvalid();
        }
        if (entry.size != null && entry.size !== size) {
          throw responseInvalid();
        }
        if (entry.size == null) {
          entries.set(path, Object.freeze({ ...entry, size }));
        }
        for (const owner of referenceOwners.get(path) ?? []) {
          checkSkillSize(owner);
        }
        if (kind === "manifest") return MAX_MANIFEST_BYTES;
        if (kind === "skill") {
          return AI_REVIEWER_SKILL_MAX_BYTES + MAX_MANIFEST_BYTES;
        }
        return AI_REVIEWER_SKILL_MAX_BYTES;
      },
      file(path, bytes) {
        const entry = entries.get(path);
        if (entry == null) throw responseInvalid();
        assertBlobMatchesTree(entry, bytes);
        retainedBytes += bytes.byteLength;
        if (retainedBytes > maximumRetainedBytes) throw responseTooLarge();
        files.set(path, bytes);
        const kind = desired.get(path);
        if (path === MARKETPLACE_MANIFEST_PATH) {
          for (const root of marketplacePluginRoots(files)) {
            const pluginPath =
              root === ""
                ? PLUGIN_MANIFEST_PATH
                : `${root}/${PLUGIN_MANIFEST_PATH}`;
            if (readableBlob(entries.get(pluginPath))) {
              retain(pluginPath, "manifest");
            }
          }
          retainDeclaredSkills(marketplaceDeclaredSkillPaths(files));
        } else if (kind === "skill") {
          inspectSkill(path, bytes);
        }
      },
    });

    for (const path of desired.keys()) {
      if (!files.has(path)) throw responseInvalid();
    }
    const discovery = discoverSkillDeclarations(files, entries);
    const declarationsByPath = new Map(
      discovery.declarations.map((declaration) => [
        declaration.path,
        declaration,
      ]),
    );
    const declarations =
      selectedPaths == null
        ? discovery.declarations
        : selectedPaths.map((path) => declarationsByPath.get(path));
    if (declarations.some((declaration) => declaration == null)) {
      throw previewChanged(
        "The selected skills did not match the preview. Preview them again before importing.",
      );
    }
    return Object.freeze({
      files,
      discovery: Object.freeze({
        ...discovery,
        declarations: Object.freeze(declarations),
      }),
    });
  }

  /** @param {readonly any[]} internalSkills @param {Map<string, Buffer>} files */
  function materializeSkills(internalSkills, files) {
    const materialized = [];
    for (const skill of internalSkills) {
      /** @type {Record<string, string>} */
      const referenceFiles = {};
      for (const candidate of skill.referenceCandidates) {
        const bytes = files.get(candidate.repositoryPath);
        if (bytes == null) throw responseInvalid();
        referenceFiles[candidate.relativePath] = decodeUtf8(bytes);
      }
      const prepared = prepareAiReviewerSkill({
        skillMarkdown: skill.skillMarkdown,
        referenceFiles,
        provenance: skill.provenance,
      });
      materialized.push(
        Object.freeze({
          skillMarkdown: skill.skillMarkdown,
          referenceFiles: Object.freeze({ ...prepared.referenceFiles }),
          provenance: skill.provenance,
        }),
      );
    }
    return Object.freeze(materialized);
  }

  return {
    /** @param {unknown} input */
    async preview(input) {
      const source = parseAiReviewerSkillGitSource(input);
      const adapter = adapterFor(source);
      const signal = timeoutSignal(GIT_IMPORT_TIMEOUT_MS);
      const commitResponse = await fetchResponse(
        dependencies,
        source,
        adapter.apiBaseUrl,
        adapter.resolveUrl,
        adapter.headers,
        signal,
      );
      const commit = await readBoundedJson(commitResponse, signal);
      const resolvedSha = adapter.commitSha(commit);
      if (typeof resolvedSha !== "string" || !GIT_SHA.test(resolvedSha)) {
        throw responseInvalid();
      }
      const entries = await fetchRepositoryTree(source, resolvedSha, signal);
      const { files, discovery } = await fetchArchiveFiles(
        source,
        resolvedSha,
        entries,
        null,
        signal,
      );
      return buildRepositoryPreview(
        source,
        resolvedSha,
        entries,
        files,
        discovery,
        repositorySnapshotHash(source, resolvedSha, entries),
      ).preview;
    },

    /** @param {unknown} input */
    async confirm(input) {
      const accepted = confirmation(input);
      const signal = timeoutSignal(GIT_IMPORT_TIMEOUT_MS);
      const entries = await fetchRepositoryTree(
        accepted.source,
        accepted.resolvedSha,
        signal,
      );
      if (
        repositorySnapshotHash(
          accepted.source,
          accepted.resolvedSha,
          entries,
        ) !== accepted.contentHash
      ) {
        throw previewChanged();
      }
      const { files, discovery } = await fetchArchiveFiles(
        accepted.source,
        accepted.resolvedSha,
        entries,
        accepted.selectedPaths,
        signal,
      );
      const selected = buildRepositoryPreview(
        accepted.source,
        accepted.resolvedSha,
        entries,
        files,
        discovery,
        accepted.contentHash,
      ).internalSkills;
      return Object.freeze({
        skills: materializeSkills(selected, files),
      });
    },
  };
}
