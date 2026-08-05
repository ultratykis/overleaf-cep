// @ts-check

import { createOpenAI } from "@ai-sdk/openai";
import Ajv from "ajv";

import { AgentGatewayError } from "./AgentGateway.mjs";
import {
  AiSdkAgentGateway,
  assertNoGlobalTelemetryIntegration,
  classifySdkError,
} from "./AiSdkAgentGateway.mjs";
import {
  OLLAMA_FETCH_REDIRECT,
  parseOllamaModelTag,
  parseOllamaOpenAiBaseUrl,
} from "./OllamaEndpointPolicy.mjs";

const CANONICAL_TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u;
const MAX_NONSTREAM_CONTENT_PARTS = 512;
const MAX_NONSTREAM_OUTPUT_CHARACTERS = 100_000;
const MAX_PROMPT_CHARACTERS = 100_000;
const MAX_PROVIDER_WARNING_ENTRIES = 512;
const MAX_STREAM_TEXT_CHARACTERS = 100_000;
const MAX_STREAM_TEXT_ID_CHARACTERS = 256;
const MAX_TOOL_CALL_ID_CHARACTERS = 256;
const INTRINSIC_PROMISE_THEN = Promise.prototype.then;
const LOCAL_TRANSPORT_ERRORS = new WeakSet();
const GENERATE_CONTENT_PART_PROPERTIES = Object.freeze([
  "type",
  "text",
  "mediaType",
  "data",
  "sourceType",
  "id",
  "url",
  "title",
  "filename",
  "toolCallId",
  "toolName",
  "input",
  "providerExecuted",
  "dynamic",
  "result",
  "isError",
  "preliminary",
  "approvalId",
]);
const UNSUPPORTED_STREAM_PART_PROPERTIES = Object.freeze({
  "reasoning-start": Object.freeze(["id"]),
  "reasoning-delta": Object.freeze(["id", "delta"]),
  "reasoning-end": Object.freeze(["id"]),
  "tool-input-start": Object.freeze([
    "id",
    "toolName",
    "providerExecuted",
    "dynamic",
    "title",
  ]),
  "tool-input-delta": Object.freeze(["id", "delta"]),
  "tool-input-end": Object.freeze(["id"]),
  "tool-approval-request": Object.freeze(["approvalId", "toolCallId"]),
  "tool-call": Object.freeze([
    "toolCallId",
    "toolName",
    "input",
    "providerExecuted",
    "dynamic",
  ]),
  "tool-result": Object.freeze([
    "toolCallId",
    "toolName",
    "result",
    "isError",
    "preliminary",
    "dynamic",
  ]),
  file: Object.freeze(["mediaType", "data"]),
  raw: Object.freeze(["rawValue"]),
  source: Object.freeze([
    "sourceType",
    "id",
    "url",
    "title",
    "mediaType",
    "filename",
  ]),
});

/**
 * @template {AgentGatewayError} T
 * @param {T} error
 * @returns {T}
 */
function localTransportError(error) {
  Object.freeze(error);
  LOCAL_TRANSPORT_ERRORS.add(error);
  return error;
}

/**
 * @param {unknown} error
 */
function isLocalTransportError(error) {
  if (
    error == null ||
    (typeof error !== "object" && typeof error !== "function")
  ) {
    return false;
  }
  return LOCAL_TRANSPORT_ERRORS.has(error);
}

/**
 * @param {unknown} error
 * @param {AbortSignal | undefined} signal
 */
function classifyTransportError(error, signal) {
  return localTransportError(classifySdkError(error, signal));
}

/**
 * @param {unknown} error
 * @param {AbortSignal | undefined} signal
 */
function classifyUntrustedProviderError(error, signal) {
  observeInvalidNativePromise(error);
  if (signal?.aborted) {
    return classifyTransportError(error, signal);
  }
  if (isLocalTransportError(error)) {
    return error;
  }
  try {
    const classified = classifyTransportError(error, signal);
    return signal?.aborted
      ? classifyTransportError(signal.reason, signal)
      : classified;
  } catch (classificationError) {
    observeInvalidNativePromise(classificationError);
    return classifyTransportError(undefined, signal);
  }
}

/**
 * @param {AbortSignal | undefined} signal
 */
function throwIfTransportSignalAborted(signal) {
  if (signal?.aborted) {
    throw classifyTransportError(signal.reason, signal);
  }
}

/**
 * @param {string} value
 */
function containsDisallowedToolCallIdCharacter(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x20 || codeUnit === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * @param {unknown} input
 */
function requestUrl(input) {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.url;
  }
  throw localTransportError(
    new AgentGatewayError(
      "The Ollama request URL is outside the configured local endpoint.",
      {
        code: "AI_OLLAMA_REQUEST_URL_NOT_ALLOWED",
        category: "configuration",
        retryable: false,
      },
    ),
  );
}

function requestUrlNotAllowed() {
  return localTransportError(
    new AgentGatewayError(
      "The Ollama request URL is outside the configured local endpoint.",
      {
        code: "AI_OLLAMA_REQUEST_URL_NOT_ALLOWED",
        category: "configuration",
        retryable: false,
      },
    ),
  );
}

function redirectRejected() {
  return localTransportError(
    new AgentGatewayError("The Ollama provider redirect was rejected.", {
      code: "AI_PROVIDER_REDIRECT_REJECTED",
      category: "provider",
      retryable: false,
    }),
  );
}

function invalidProviderResponse() {
  return localTransportError(
    new AgentGatewayError(
      "The AI provider returned an invalid Chat Completions response.",
      {
        code: "AI_PROVIDER_SCHEMA_INVALID",
        category: "schema",
        retryable: false,
      },
    ),
  );
}

/**
 * @param {unknown} input
 * @param {readonly string[]} expectedKeys
 * @param {string} message
 * @param {readonly string[]} [optionalKeys]
 */
function readExactRecord(input, expectedKeys, message, optionalKeys = []) {
  if (input == null || typeof input !== "object") {
    throw new TypeError(message);
  }
  let isArray;
  let prototype;
  try {
    isArray = Array.isArray(input);
    prototype = Object.getPrototypeOf(input);
  } catch {
    throw new TypeError(message);
  }
  if (isArray || ![Object.prototype, null].includes(prototype)) {
    throw new TypeError(message);
  }
  let keys;
  try {
    keys = Reflect.ownKeys(input);
  } catch {
    throw new TypeError(message);
  }
  const allowedKeys = [...expectedKeys, ...optionalKeys];
  if (
    keys.length < expectedKeys.length ||
    keys.length > allowedKeys.length ||
    keys.some((key) => typeof key !== "string" || !allowedKeys.includes(key)) ||
    expectedKeys.some((key) => !keys.includes(key))
  ) {
    throw new TypeError(message);
  }

  const values = Object.create(null);
  for (const key of allowedKeys) {
    if (!keys.includes(key)) {
      continue;
    }
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(input, key);
    } catch {
      throw new TypeError(message);
    }
    if (
      descriptor == null ||
      !descriptor.enumerable ||
      !Object.hasOwn(descriptor, "value")
    ) {
      throw new TypeError(message);
    }
    Object.defineProperty(values, key, {
      value: descriptor.value,
      enumerable: true,
    });
  }
  return Object.freeze(values);
}

/**
 * @template T
 * @param {() => T} work
 * @param {AbortSignal | undefined} signal
 * @returns {T}
 */
function runInputPreprocessing(work, signal) {
  if (signal?.aborted) {
    throw classifyTransportError(signal.reason, signal);
  }
  try {
    const result = work();
    if (signal?.aborted) {
      throw classifyTransportError(signal.reason, signal);
    }
    return result;
  } catch (error) {
    if (signal?.aborted) {
      throw classifyTransportError(error, signal);
    }
    throw error;
  }
}

/**
 * @param {unknown} input
 * @param {Set<object>} [ancestors]
 * @returns {any}
 */
function snapshotJsonValue(input, ancestors = new Set()) {
  if (
    input === null ||
    typeof input === "string" ||
    typeof input === "boolean"
  ) {
    return input;
  }
  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw new TypeError("The value must contain only finite JSON data.");
    }
    return input;
  }
  if (typeof input !== "object") {
    throw new TypeError("The value must contain only JSON data.");
  }
  if (ancestors.has(input)) {
    throw new TypeError("The value must not contain a cycle.");
  }

  ancestors.add(input);
  try {
    if (Array.isArray(input)) {
      const keys = Reflect.ownKeys(input);
      if (
        keys.length !== input.length + 1 ||
        keys.at(-1) !== "length" ||
        keys.slice(0, -1).some((key, index) => key !== String(index))
      ) {
        throw new TypeError("The value must be a dense JSON array.");
      }
      const output = [];
      for (let index = 0; index < input.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          input,
          String(index),
        );
        if (
          descriptor == null ||
          !descriptor.enumerable ||
          !Object.hasOwn(descriptor, "value")
        ) {
          throw new TypeError("The value must contain only JSON data.");
        }
        output.push(snapshotJsonValue(descriptor.value, ancestors));
      }
      return Object.freeze(output);
    }

    if (![Object.prototype, null].includes(Object.getPrototypeOf(input))) {
      throw new TypeError("The value must contain only plain JSON objects.");
    }
    const output = {};
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string") {
        throw new TypeError("The value must contain only string JSON keys.");
      }
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (
        descriptor == null ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, "value")
      ) {
        throw new TypeError("The value must contain only JSON data.");
      }
      Object.defineProperty(output, key, {
        value: snapshotJsonValue(descriptor.value, ancestors),
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    return Object.freeze(output);
  } catch {
    throw new TypeError("The value must contain only bounded JSON data.");
  } finally {
    ancestors.delete(input);
  }
}

/**
 * @param {unknown} input
 */
function snapshotJsonObject(input) {
  const snapshot = snapshotJsonValue(input);
  if (
    snapshot == null ||
    typeof snapshot !== "object" ||
    Array.isArray(snapshot)
  ) {
    throw new TypeError("The value must be a JSON object.");
  }
  return snapshot;
}

/**
 * @param {unknown} schema
 */
function compileJsonSchema(schema) {
  try {
    const validator = new Ajv({
      allErrors: false,
      coerceTypes: false,
      removeAdditional: false,
      strict: true,
      useDefaults: false,
    }).compile(/** @type {import("ajv").AnySchema} */ (schema));
    return /** @type {(value: unknown) => boolean} */ (
      (value) => {
        try {
          return validator(value) === true;
        } catch {
          return false;
        }
      }
    );
  } catch {
    throw new TypeError("schema must be a valid strict JSON Schema.");
  }
}

/**
 * @param {unknown} prompt
 * @param {unknown} maxOutputTokens
 */
function parsePromptAndMaxOutputTokens(prompt, maxOutputTokens) {
  if (
    typeof prompt !== "string" ||
    prompt.length === 0 ||
    prompt.length > MAX_PROMPT_CHARACTERS
  ) {
    throw new TypeError("prompt must be a non-empty bounded string.");
  }
  if (
    maxOutputTokens !== undefined &&
    (typeof maxOutputTokens !== "number" ||
      !Number.isSafeInteger(maxOutputTokens) ||
      maxOutputTokens < 1)
  ) {
    throw new TypeError(
      "maxOutputTokens must be a positive safe integer when provided.",
    );
  }
  return Object.freeze({
    prompt,
    maxOutputTokens,
  });
}

/**
 * @param {unknown} input
 */
function parseGenerateChatRequest(input) {
  if (input == null || typeof input !== "object") {
    throw new TypeError("prompt must be a non-empty bounded string.");
  }
  const prompt = Reflect.get(input, "prompt");
  const maxOutputTokens = Reflect.get(input, "maxOutputTokens");
  return parsePromptAndMaxOutputTokens(prompt, maxOutputTokens);
}

/**
 * @param {unknown} input
 */
function parseStreamChatRequest(input) {
  const record = readExactRecord(
    input,
    ["prompt"],
    "The streaming Chat Completions request is invalid.",
    ["maxOutputTokens"],
  );
  return parsePromptAndMaxOutputTokens(record.prompt, record.maxOutputTokens);
}

/**
 * @param {unknown} input
 */
function parseTokenCount(input) {
  return typeof input === "number" && Number.isSafeInteger(input) && input >= 0
    ? input
    : null;
}

/**
 * Read provider-owned data without invoking a returned Promise's settlement
 * methods. A thrown provider value is classified by the caller.
 *
 * @param {object} input
 * @param {PropertyKey} property
 */
function readProviderProperty(input, property) {
  let value;
  try {
    value = Reflect.get(input, property);
  } catch (error) {
    observeInvalidNativePromise(error);
    throw error;
  }
  observeInvalidNativePromise(value);
  return value;
}

/**
 * @param {unknown} input
 * @param {PropertyKey} property
 * @param {AbortSignal | undefined} signal
 */
function captureProviderProperty(input, property, signal) {
  throwIfTransportSignalAborted(signal);
  if (
    input == null ||
    (typeof input !== "object" && typeof input !== "function")
  ) {
    return Object.freeze({
      ok: false,
      value: undefined,
      threw: false,
      error: undefined,
    });
  }
  try {
    const value = readProviderProperty(input, property);
    throwIfTransportSignalAborted(signal);
    return Object.freeze({
      ok: true,
      value,
      threw: false,
      error: undefined,
    });
  } catch (error) {
    observeInvalidNativePromise(error);
    throwIfTransportSignalAborted(signal);
    return Object.freeze({
      ok: false,
      value: undefined,
      threw: true,
      error,
    });
  }
}

/**
 * Observe an optional provider-owned result sibling only when it is an own
 * data property. Accessor descriptors remain private and are never invoked.
 *
 * @param {unknown} input
 * @param {PropertyKey} property
 * @param {AbortSignal | undefined} signal
 */
function captureOptionalProviderOwnDataProperty(input, property, signal) {
  throwIfTransportSignalAborted(signal);
  if (
    input == null ||
    (typeof input !== "object" && typeof input !== "function")
  ) {
    return Object.freeze({
      ok: true,
      value: undefined,
      threw: false,
      error: undefined,
    });
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(input, property);
    throwIfTransportSignalAborted(signal);
    if (descriptor == null || !Object.hasOwn(descriptor, "value")) {
      return Object.freeze({
        ok: true,
        value: undefined,
        threw: false,
        error: undefined,
      });
    }
    observeInvalidNativePromise(descriptor.value);
    throwIfTransportSignalAborted(signal);
    return Object.freeze({
      ok: true,
      value: undefined,
      threw: false,
      error: undefined,
    });
  } catch (error) {
    observeInvalidNativePromise(error);
    throwIfTransportSignalAborted(signal);
    return Object.freeze({
      ok: false,
      value: undefined,
      threw: true,
      error,
    });
  }
}

/**
 * @param {ReadonlyArray<ReturnType<typeof captureProviderProperty>>} slots
 */
function throwFirstCapturedProviderError(slots) {
  for (const slot of slots) {
    if (slot.threw) {
      throw slot.error;
    }
  }
}

/**
 * @param {unknown} input
 * @param {AbortSignal | undefined} signal
 */
function parseGenerateResultEnvelope(input, signal) {
  throwIfTransportSignalAborted(signal);
  if (input == null || typeof input !== "object") {
    throw invalidProviderResponse();
  }
  const contentSlot = captureProviderProperty(input, "content", signal);
  const finishReasonSlot = captureProviderProperty(
    input,
    "finishReason",
    signal,
  );
  const usageSlot = captureProviderProperty(input, "usage", signal);
  const warningsSlot = captureProviderProperty(input, "warnings", signal);
  const resultSiblingSlots = ["request", "response", "providerMetadata"].map(
    (property) =>
      captureOptionalProviderOwnDataProperty(input, property, signal),
  );
  let contentIsArray = false;
  let warningsIsArray = false;
  try {
    contentIsArray = Array.isArray(contentSlot.value);
    warningsIsArray = Array.isArray(warningsSlot.value);
  } catch (error) {
    observeInvalidNativePromise(error);
  }
  throwIfTransportSignalAborted(signal);
  const contentLengthSlot = contentIsArray
    ? captureProviderProperty(contentSlot.value, "length", signal)
    : captureProviderProperty(undefined, "length", signal);
  const warningLengthSlot = warningsIsArray
    ? captureProviderProperty(warningsSlot.value, "length", signal)
    : captureProviderProperty(undefined, "length", signal);
  const finishReasonKindSlot = captureProviderProperty(
    finishReasonSlot.value,
    "unified",
    signal,
  );
  const inputTokenUsageSlot = captureProviderProperty(
    usageSlot.value,
    "inputTokens",
    signal,
  );
  const outputTokenUsageSlot = captureProviderProperty(
    usageSlot.value,
    "outputTokens",
    signal,
  );
  const inputTokenTotalSlot = captureProviderProperty(
    inputTokenUsageSlot.value,
    "total",
    signal,
  );
  const outputTokenTotalSlot = captureProviderProperty(
    outputTokenUsageSlot.value,
    "total",
    signal,
  );
  const contentLength = contentLengthSlot.value;
  const warningLength = warningLengthSlot.value;
  /** @type {unknown[]} */
  const content = [];
  /** @type {Array<ReturnType<typeof captureProviderProperty>>} */
  const contentPartSlots = [];
  /** @type {Array<ReturnType<typeof captureProviderProperty>>} */
  const warningEntrySlots = [];
  if (
    contentIsArray &&
    typeof contentLength === "number" &&
    Number.isSafeInteger(contentLength) &&
    contentLength >= 1
  ) {
    const observedContentLength = Math.min(
      contentLength,
      MAX_NONSTREAM_CONTENT_PARTS + 1,
    );
    for (let index = 0; index < observedContentLength; index += 1) {
      const partSlot = captureProviderProperty(
        contentSlot.value,
        String(index),
        signal,
      );
      contentPartSlots.push(partSlot);
      content.push(partSlot.value);
    }
  }
  if (
    warningsIsArray &&
    typeof warningLength === "number" &&
    Number.isSafeInteger(warningLength) &&
    warningLength >= 0
  ) {
    const observedWarningLength = Math.min(
      warningLength,
      MAX_PROVIDER_WARNING_ENTRIES + 1,
    );
    for (let index = 0; index < observedWarningLength; index += 1) {
      warningEntrySlots.push(
        captureProviderProperty(warningsSlot.value, String(index), signal),
      );
    }
  }
  const contentSnapshot = captureGenerateContentParts(content, signal);
  throwFirstCapturedProviderError([
    contentSlot,
    finishReasonSlot,
    usageSlot,
    warningsSlot,
    ...resultSiblingSlots,
    contentLengthSlot,
    warningLengthSlot,
    finishReasonKindSlot,
    inputTokenUsageSlot,
    outputTokenUsageSlot,
    inputTokenTotalSlot,
    outputTokenTotalSlot,
    ...contentPartSlots,
    ...warningEntrySlots,
    ...contentSnapshot.slots,
  ]);
  if (
    !contentSlot.ok ||
    !finishReasonSlot.ok ||
    !usageSlot.ok ||
    !warningsSlot.ok ||
    !contentLengthSlot.ok ||
    !warningLengthSlot.ok ||
    !finishReasonKindSlot.ok ||
    !inputTokenUsageSlot.ok ||
    !outputTokenUsageSlot.ok ||
    !inputTokenTotalSlot.ok ||
    !outputTokenTotalSlot.ok ||
    contentPartSlots.some((slot) => !slot.ok) ||
    warningEntrySlots.some((slot) => !slot.ok) ||
    contentSnapshot.parts.some((part) => !part.ok) ||
    contentSnapshot.outputCharacters > MAX_NONSTREAM_OUTPUT_CHARACTERS ||
    !contentIsArray ||
    typeof contentLength !== "number" ||
    !Number.isSafeInteger(contentLength) ||
    contentLength < 1 ||
    contentLength > MAX_NONSTREAM_CONTENT_PARTS ||
    !warningsIsArray ||
    warningLength !== 0
  ) {
    throw invalidProviderResponse();
  }

  const finishReasonKind = finishReasonKindSlot.value;
  if (
    typeof finishReasonKind !== "string" ||
    inputTokenUsageSlot.value == null ||
    typeof inputTokenUsageSlot.value !== "object" ||
    outputTokenUsageSlot.value == null ||
    typeof outputTokenUsageSlot.value !== "object"
  ) {
    throw invalidProviderResponse();
  }
  const inputTokens = parseTokenCount(inputTokenTotalSlot.value);
  const outputTokens = parseTokenCount(outputTokenTotalSlot.value);
  if (inputTokens == null || outputTokens == null) {
    throw invalidProviderResponse();
  }

  return Object.freeze({
    content: contentSnapshot.parts,
    contentLength,
    finishReason: finishReasonKind,
    usage: Object.freeze({
      inputTokens,
      outputTokens,
    }),
  });
}

/**
 * Acquire every safe LanguageModelV3 content slot for the bounded content
 * array before validating the surrounding result envelope. Provider metadata
 * remains intentionally unread.
 *
 * @param {readonly unknown[]} content
 * @param {AbortSignal | undefined} signal
 */
function captureGenerateContentParts(content, signal) {
  /** @type {Array<Readonly<{ ok: boolean, values: Record<string, unknown> }>>} */
  const parts = [];
  /** @type {Array<ReturnType<typeof captureProviderProperty>>} */
  const allSlots = [];
  let outputCharacters = 0;
  for (const part of content) {
    /** @type {Record<string, unknown>} */
    const values = Object.create(null);
    const slots = GENERATE_CONTENT_PART_PROPERTIES.map((property) => {
      const slot = captureProviderProperty(part, property, signal);
      Object.defineProperty(values, property, {
        value: slot.value,
        enumerable: true,
      });
      return slot;
    });
    allSlots.push(...slots);
    parts.push(
      Object.freeze({
        ok: slots.every((slot) => slot.ok),
        values: Object.freeze(values),
      }),
    );
    for (const property of ["text", "input"]) {
      const value = values[property];
      if (typeof value !== "string") {
        continue;
      }
      outputCharacters += value.length;
    }
  }
  return Object.freeze({
    parts: Object.freeze(parts),
    slots: Object.freeze(allSlots),
    outputCharacters,
  });
}

/**
 * @param {unknown} input
 * @param {AbortSignal | undefined} signal
 */
function normalizeGenerateChatResult(input, signal) {
  const envelope = parseGenerateResultEnvelope(input, signal);
  const content = envelope.content;
  if (!["stop", "length"].includes(envelope.finishReason)) {
    throw invalidProviderResponse();
  }
  const textParts = [];
  for (let index = 0; index < envelope.contentLength; index += 1) {
    const part = content[index].values;
    if (part.type !== "text" || typeof part.text !== "string") {
      throw invalidProviderResponse();
    }
    textParts.push(part.text);
  }

  return Object.freeze({
    type: "completed",
    text: textParts.join(""),
    toolCalls: Object.freeze([]),
    finishReason: envelope.finishReason,
    usage: envelope.usage,
  });
}

/**
 * @param {unknown} input
 */
function parseStructuredChatRequest(input) {
  const record = readExactRecord(
    input,
    ["prompt", "schema"],
    "The structured Chat Completions request is invalid.",
    ["maxOutputTokens"],
  );
  const request = parsePromptAndMaxOutputTokens(
    record.prompt,
    record.maxOutputTokens,
  );
  const schema = snapshotJsonObject(record.schema);
  const validate = compileJsonSchema(schema);
  return Object.freeze({
    ...request,
    schema,
    validate,
  });
}

/**
 * @param {unknown} input
 */
function parseForcedToolRequest(input) {
  const record = readExactRecord(
    input,
    ["prompt", "tool"],
    "The forced tool request is invalid.",
    ["maxOutputTokens"],
  );
  const request = parsePromptAndMaxOutputTokens(
    record.prompt,
    record.maxOutputTokens,
  );
  const tool = readExactRecord(
    record.tool,
    ["type", "function"],
    "The forced tool definition is invalid.",
  );
  if (tool.type !== "function") {
    throw new TypeError("The forced tool definition is invalid.");
  }
  const toolFunction = readExactRecord(
    tool.function,
    ["name", "description", "parameters"],
    "The forced tool definition is invalid.",
  );
  if (
    typeof toolFunction.name !== "string" ||
    CANONICAL_TOOL_NAME.exec(toolFunction.name)?.[0] !== toolFunction.name ||
    typeof toolFunction.description !== "string" ||
    toolFunction.description.length === 0 ||
    toolFunction.description.length > 1_000
  ) {
    throw new TypeError("The forced tool definition is invalid.");
  }
  const inputSchema = snapshotJsonObject(toolFunction.parameters);
  const validateInput = compileJsonSchema(inputSchema);
  return Object.freeze({
    ...request,
    tool: Object.freeze({
      name: toolFunction.name,
      description: toolFunction.description,
      inputSchema,
    }),
    validateInput,
  });
}

/**
 * @param {unknown} input
 * @param {(value: unknown) => boolean} validate
 * @param {AbortSignal | undefined} signal
 */
function normalizeStructuredResult(input, validate, signal) {
  const envelope = parseGenerateResultEnvelope(input, signal);
  const content = envelope.content;
  if (envelope.finishReason !== "stop" || envelope.contentLength !== 1) {
    throw invalidProviderResponse();
  }
  const part = content[0].values;
  if (part.type !== "text" || typeof part.text !== "string") {
    throw invalidProviderResponse();
  }
  const text = part.text;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalidProviderResponse();
  }
  if (
    value == null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !validate(value)
  ) {
    throw invalidProviderResponse();
  }
  const snapshot = snapshotJsonObject(value);
  return Object.freeze({
    type: "structured.completed",
    value: snapshot,
    finishReason: "stop",
    usage: envelope.usage,
  });
}

/**
 * @param {unknown} input
 * @param {{
 *   name: string,
 *   validateInput: (value: unknown) => boolean,
 * }} expected
 * @param {AbortSignal | undefined} signal
 */
function normalizeToolProposal(input, expected, signal) {
  const envelope = parseGenerateResultEnvelope(input, signal);
  const content = envelope.content;
  if (envelope.finishReason !== "tool-calls" || envelope.contentLength !== 1) {
    throw invalidProviderResponse();
  }
  const part = content[0].values;
  const id = part.toolCallId;
  const name = part.toolName;
  const rawInput = part.input;
  const providerExecuted = part.providerExecuted;
  const dynamic = part.dynamic;
  if (
    part.type !== "tool-call" ||
    typeof id !== "string" ||
    id.length === 0 ||
    id.length > MAX_TOOL_CALL_ID_CHARACTERS ||
    containsDisallowedToolCallIdCharacter(id) ||
    name !== expected.name ||
    typeof rawInput !== "string" ||
    (providerExecuted !== undefined && providerExecuted !== false) ||
    (dynamic !== undefined && dynamic !== false)
  ) {
    throw invalidProviderResponse();
  }
  let parsedInput;
  try {
    parsedInput = JSON.parse(rawInput);
  } catch {
    throw invalidProviderResponse();
  }
  if (
    parsedInput == null ||
    typeof parsedInput !== "object" ||
    Array.isArray(parsedInput) ||
    !expected.validateInput(parsedInput)
  ) {
    throw invalidProviderResponse();
  }
  const call = Object.freeze({
    id,
    name,
    input: snapshotJsonObject(parsedInput),
  });
  return Object.freeze({
    type: "tool.proposed",
    call,
    finishReason: "tool-calls",
    usage: envelope.usage,
  });
}

/**
 * @param {unknown} input
 * @param {AbortSignal | undefined} signal
 */
function normalizeToolContinuationResult(input, signal) {
  const envelope = parseGenerateResultEnvelope(input, signal);
  const content = envelope.content;
  if (envelope.finishReason !== "stop" || envelope.contentLength !== 1) {
    throw invalidProviderResponse();
  }
  const part = content[0].values;
  if (part.type !== "text" || typeof part.text !== "string") {
    throw invalidProviderResponse();
  }
  const text = part.text;
  return Object.freeze({
    type: "completed",
    text,
    toolCalls: Object.freeze([]),
    finishReason: "stop",
    usage: envelope.usage,
  });
}

/**
 * @param {unknown} input
 * @param {AbortSignal | undefined} signal
 */
function assertPlainProviderRecord(input, signal) {
  throwIfTransportSignalAborted(signal);
  if (input == null || typeof input !== "object") {
    throw invalidProviderResponse();
  }
  let isArray;
  let prototype;
  try {
    isArray = Array.isArray(input);
    throwIfTransportSignalAborted(signal);
    prototype = Object.getPrototypeOf(input);
    throwIfTransportSignalAborted(signal);
  } catch (error) {
    observeInvalidNativePromise(error);
    throwIfTransportSignalAborted(signal);
    throw invalidProviderResponse();
  }
  if (isArray || ![Object.prototype, null].includes(prototype)) {
    throw invalidProviderResponse();
  }
  return input;
}

/**
 * @param {unknown} input
 * @param {PropertyKey} property
 * @param {AbortSignal | undefined} signal
 */
function readProviderDataProperty(input, property, signal) {
  const record = assertPlainProviderRecord(input, signal);
  throwIfTransportSignalAborted(signal);
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(record, property);
    throwIfTransportSignalAborted(signal);
  } catch (error) {
    observeInvalidNativePromise(error);
    throwIfTransportSignalAborted(signal);
    throw invalidProviderResponse();
  }
  if (descriptor == null || !Object.hasOwn(descriptor, "value")) {
    throw invalidProviderResponse();
  }
  observeInvalidNativePromise(descriptor.value);
  throwIfTransportSignalAborted(signal);
  return descriptor.value;
}

/**
 * @param {unknown} input
 * @param {PropertyKey} property
 * @param {AbortSignal | undefined} signal
 */
function captureProviderDataProperty(input, property, signal) {
  throwIfTransportSignalAborted(signal);
  try {
    const value = readProviderDataProperty(input, property, signal);
    throwIfTransportSignalAborted(signal);
    return Object.freeze({ ok: true, value });
  } catch (error) {
    observeInvalidNativePromise(error);
    throwIfTransportSignalAborted(signal);
    return Object.freeze({ ok: false, value: undefined });
  }
}

/**
 * @param {unknown} input
 * @param {PropertyKey} property
 * @param {AbortSignal | undefined} signal
 */
function captureOptionalProviderDataProperty(input, property, signal) {
  throwIfTransportSignalAborted(signal);
  try {
    const record = assertPlainProviderRecord(input, signal);
    const descriptor = Object.getOwnPropertyDescriptor(record, property);
    throwIfTransportSignalAborted(signal);
    if (descriptor == null) {
      return Object.freeze({ ok: true, value: undefined });
    }
    if (!Object.hasOwn(descriptor, "value")) {
      return Object.freeze({ ok: false, value: undefined });
    }
    observeInvalidNativePromise(descriptor.value);
    return Object.freeze({ ok: true, value: descriptor.value });
  } catch (error) {
    observeInvalidNativePromise(error);
    throwIfTransportSignalAborted(signal);
    return Object.freeze({ ok: false, value: undefined });
  }
}

/**
 * @param {unknown} input
 * @param {AbortSignal | undefined} signal
 */
function readEmptyWarningArray(input, signal) {
  throwIfTransportSignalAborted(signal);
  let isArray;
  try {
    isArray = Array.isArray(input);
  } catch (error) {
    observeInvalidNativePromise(error);
    throw invalidProviderResponse();
  }
  throwIfTransportSignalAborted(signal);
  if (!isArray) {
    throw invalidProviderResponse();
  }
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(input, "length");
    throwIfTransportSignalAborted(signal);
  } catch (error) {
    observeInvalidNativePromise(error);
    throwIfTransportSignalAborted(signal);
    throw invalidProviderResponse();
  }
  if (descriptor != null && Object.hasOwn(descriptor, "value")) {
    observeInvalidNativePromise(descriptor.value);
  }
  const length =
    descriptor != null && Object.hasOwn(descriptor, "value")
      ? descriptor.value
      : undefined;
  if (
    descriptor == null ||
    !Object.hasOwn(descriptor, "value") ||
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length < 0
  ) {
    throw invalidProviderResponse();
  }
  /** @type {Array<ReturnType<typeof captureProviderProperty>>} */
  const entries = [];
  const observedLength = Math.min(length, MAX_PROVIDER_WARNING_ENTRIES + 1);
  for (let index = 0; index < observedLength; index += 1) {
    entries.push(captureProviderProperty(input, String(index), signal));
  }
  throwFirstCapturedProviderError(entries);
  if (
    entries.some((entry) => !entry.ok) ||
    length > MAX_PROVIDER_WARNING_ENTRIES ||
    length !== 0
  ) {
    throw invalidProviderResponse();
  }
}

/**
 * @param {unknown} input
 */
function parseStreamTextId(input) {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > MAX_STREAM_TEXT_ID_CHARACTERS ||
    containsDisallowedToolCallIdCharacter(input)
  ) {
    throw invalidProviderResponse();
  }
  return input;
}

/**
 * @param {unknown} input
 * @param {AbortSignal | undefined} signal
 */
function parseStreamFinish(input, signal) {
  const finishReasonSlot = captureProviderDataProperty(
    input,
    "finishReason",
    signal,
  );
  const usageSlot = captureProviderDataProperty(input, "usage", signal);
  const unifiedSlot = captureProviderDataProperty(
    finishReasonSlot.value,
    "unified",
    signal,
  );
  const inputUsageSlot = captureProviderDataProperty(
    usageSlot.value,
    "inputTokens",
    signal,
  );
  const outputUsageSlot = captureProviderDataProperty(
    usageSlot.value,
    "outputTokens",
    signal,
  );
  const inputTokenSlots = [
    captureProviderDataProperty(inputUsageSlot.value, "total", signal),
    ...["noCache", "cacheRead", "cacheWrite"].map((property) =>
      captureOptionalProviderDataProperty(
        inputUsageSlot.value,
        property,
        signal,
      ),
    ),
  ];
  const outputTokenSlots = [
    captureProviderDataProperty(outputUsageSlot.value, "total", signal),
    ...["text", "reasoning"].map((property) =>
      captureOptionalProviderDataProperty(
        outputUsageSlot.value,
        property,
        signal,
      ),
    ),
  ];
  const unified = unifiedSlot.value;
  const inputTokens = parseTokenCount(inputTokenSlots[0].value);
  const outputTokens = parseTokenCount(outputTokenSlots[0].value);
  if (
    !finishReasonSlot.ok ||
    !usageSlot.ok ||
    !unifiedSlot.ok ||
    !inputUsageSlot.ok ||
    !outputUsageSlot.ok ||
    inputTokenSlots.some((slot) => !slot.ok) ||
    outputTokenSlots.some((slot) => !slot.ok) ||
    !["stop", "length"].includes(unified) ||
    inputTokens == null ||
    outputTokens == null
  ) {
    throw invalidProviderResponse();
  }
  return Object.freeze({
    type: "completed",
    finishReason: unified,
    usage: Object.freeze({
      inputTokens,
      outputTokens,
    }),
  });
}

/**
 * @returns {{
 *   streamStarted: boolean,
 *   responseMetadataSeen: boolean,
 *   textStarted: boolean,
 *   textEnded: boolean,
 *   textId: string | null,
 *   textCharacters: number,
 *   nonemptyDeltaSeen: boolean,
 *   finishSeen: boolean,
 *   terminal: ReturnType<typeof parseStreamFinish> | null,
 * }}
 */
function createProviderStreamState() {
  return {
    streamStarted: false,
    responseMetadataSeen: false,
    textStarted: false,
    textEnded: false,
    textId: null,
    textCharacters: 0,
    nonemptyDeltaSeen: false,
    finishSeen: false,
    terminal: null,
  };
}

/**
 * @param {unknown} input
 * @param {readonly string[]} properties
 * @param {AbortSignal | undefined} signal
 */
function captureOptionalProviderStreamSlots(input, properties, signal) {
  /** @type {Record<string, unknown>} */
  const values = Object.create(null);
  const slots = properties.map((property) => {
    const slot = captureOptionalProviderDataProperty(input, property, signal);
    Object.defineProperty(values, property, {
      value: slot.value,
      enumerable: true,
    });
    return slot;
  });
  if (slots.some((slot) => !slot.ok)) {
    throw invalidProviderResponse();
  }
  return Object.freeze(values);
}

/**
 * @param {unknown} input
 * @param {string} type
 * @param {AbortSignal | undefined} signal
 */
function observeKnownUnsupportedProviderStreamPart(input, type, signal) {
  if (!Object.hasOwn(UNSUPPORTED_STREAM_PART_PROPERTIES, type)) {
    return false;
  }
  const properties = Reflect.get(UNSUPPORTED_STREAM_PART_PROPERTIES, type);
  if (!Array.isArray(properties)) {
    throw invalidProviderResponse();
  }
  captureOptionalProviderStreamSlots(input, properties, signal);
  return true;
}

/**
 * @param {unknown} input
 * @param {ReturnType<typeof createProviderStreamState>} state
 * @param {AbortSignal | undefined} signal
 * @returns {
 *   | Readonly<{ type: "text.delta", delta: string }>
 *   | { type: "provider.error", error: unknown }
 *   | null
 * }
 */
function normalizeProviderStreamPart(input, state, signal) {
  const typeSlot = captureProviderDataProperty(input, "type", signal);
  const type = typeSlot.value;
  if (!typeSlot.ok || typeof type !== "string") {
    throw invalidProviderResponse();
  }

  if (type === "stream-start") {
    const warningsSlot = captureProviderDataProperty(input, "warnings", signal);
    if (!warningsSlot.ok) {
      throw invalidProviderResponse();
    }
    readEmptyWarningArray(warningsSlot.value, signal);
    throwIfTransportSignalAborted(signal);
    if (
      state.finishSeen ||
      state.streamStarted ||
      state.responseMetadataSeen ||
      state.textStarted
    ) {
      throw invalidProviderResponse();
    }
    state.streamStarted = true;
    return null;
  }

  if (type === "response-metadata") {
    const metadata = captureOptionalProviderStreamSlots(
      input,
      ["id", "timestamp", "modelId"],
      signal,
    );
    if (
      (metadata.id !== undefined && typeof metadata.id !== "string") ||
      (metadata.timestamp !== undefined &&
        !(metadata.timestamp instanceof Date)) ||
      (metadata.modelId !== undefined && typeof metadata.modelId !== "string")
    ) {
      throw invalidProviderResponse();
    }
    if (
      state.finishSeen ||
      !state.streamStarted ||
      state.responseMetadataSeen ||
      state.textStarted
    ) {
      throw invalidProviderResponse();
    }
    state.responseMetadataSeen = true;
    return null;
  }

  if (type === "text-start") {
    const idSlot = captureProviderDataProperty(input, "id", signal);
    if (!idSlot.ok) {
      throw invalidProviderResponse();
    }
    const id = parseStreamTextId(idSlot.value);
    if (state.finishSeen || !state.streamStarted || state.textStarted) {
      throw invalidProviderResponse();
    }
    state.textId = id;
    state.textStarted = true;
    return null;
  }

  if (type === "text-delta") {
    const idSlot = captureProviderDataProperty(input, "id", signal);
    const deltaSlot = captureProviderDataProperty(input, "delta", signal);
    if (!idSlot.ok || !deltaSlot.ok) {
      throw invalidProviderResponse();
    }
    const id = parseStreamTextId(idSlot.value);
    const delta = deltaSlot.value;
    if (state.finishSeen || !state.textStarted || state.textEnded) {
      throw invalidProviderResponse();
    }
    if (id !== state.textId || typeof delta !== "string") {
      throw invalidProviderResponse();
    }
    if (delta.length === 0) {
      return null;
    }
    state.textCharacters += delta.length;
    if (state.textCharacters > MAX_STREAM_TEXT_CHARACTERS) {
      throw invalidProviderResponse();
    }
    state.nonemptyDeltaSeen = true;
    return Object.freeze({
      type: "text.delta",
      delta,
    });
  }

  if (type === "text-end") {
    const idSlot = captureProviderDataProperty(input, "id", signal);
    if (!idSlot.ok) {
      throw invalidProviderResponse();
    }
    const id = parseStreamTextId(idSlot.value);
    if (state.finishSeen || !state.textStarted || state.textEnded) {
      throw invalidProviderResponse();
    }
    if (id !== state.textId) {
      throw invalidProviderResponse();
    }
    state.textEnded = true;
    return null;
  }

  if (type === "finish") {
    const terminal = parseStreamFinish(input, signal);
    if (
      state.finishSeen ||
      !state.streamStarted ||
      !state.textStarted ||
      !state.textEnded ||
      !state.nonemptyDeltaSeen
    ) {
      throw invalidProviderResponse();
    }
    state.terminal = terminal;
    state.finishSeen = true;
    return null;
  }

  if (type === "error") {
    const errorSlot = captureProviderDataProperty(input, "error", signal);
    if (!errorSlot.ok) {
      throw invalidProviderResponse();
    }
    if (state.finishSeen || !state.streamStarted) {
      throw invalidProviderResponse();
    }
    return {
      type: "provider.error",
      error: errorSlot.value,
    };
  }

  observeKnownUnsupportedProviderStreamPart(input, type, signal);
  throw invalidProviderResponse();
}

/**
 * @param {unknown} input
 * @param {AbortSignal | undefined} signal
 */
function readProviderStreamStep(input, signal) {
  const doneSlot = captureProviderDataProperty(input, "done", signal);
  const valueSlot = captureProviderDataProperty(input, "value", signal);
  const done = doneSlot.value;
  if (!doneSlot.ok || !valueSlot.ok || typeof done !== "boolean") {
    throw invalidProviderResponse();
  }
  return {
    done,
    value: done ? undefined : valueSlot.value,
  };
}

/**
 * @template T
 * @param {PromiseLike<T> | T} work
 * @param {(value: T) => void} onFulfilled
 * @param {(error: unknown) => void} onRejected
 */
function observeProviderWork(work, onFulfilled, onRejected) {
  let settled = false;
  /** @param {T} value */
  const fulfill = (value) => {
    if (settled) {
      return;
    }
    settled = true;
    try {
      onFulfilled(value);
    } catch (error) {
      observeInvalidNativePromise(error);
      // Provider-controlled settlement cannot create a later unhandled error.
    }
  };
  /** @param {unknown} error */
  const reject = (error) => {
    observeInvalidNativePromise(error);
    if (settled) {
      return;
    }
    settled = true;
    try {
      onRejected(error);
    } catch (callbackError) {
      observeInvalidNativePromise(callbackError);
      // Provider-controlled settlement cannot create a later unhandled error.
    }
  };

  let normalized;
  try {
    normalized = Promise.resolve(work);
  } catch (error) {
    reject(error);
    return;
  }
  try {
    void Reflect.apply(INTRINSIC_PROMISE_THEN, normalized, [fulfill, reject]);
  } catch (error) {
    reject(error);
  }
}

/**
 * @template T
 * @param {PromiseLike<T> | T} work
 * @returns {Promise<T>}
 */
function providerWorkPromise(work) {
  return new Promise((resolve, reject) => {
    observeProviderWork(work, resolve, reject);
  });
}

/**
 * Observe an already-created native Promise without invoking an arbitrary
 * thenable that happened to occupy an invalid provider method slot.
 *
 * @param {unknown} value
 */
function observeInvalidNativePromise(value) {
  const ignore = () => {};
  try {
    void Reflect.apply(INTRINSIC_PROMISE_THEN, value, [ignore, ignore]);
  } catch {
    // Non-Promise values and hostile Promise species remain invalid provider
    // data; observation cannot replace the bounded primary outcome.
  }
}

/**
 * @param {unknown} stream
 * @param {unknown} reason
 */
function cancelProviderStream(stream, reason) {
  try {
    if (
      stream == null ||
      (typeof stream !== "object" && typeof stream !== "function")
    ) {
      return;
    }
    const cancel = Reflect.get(stream, "cancel");
    if (typeof cancel !== "function") {
      observeInvalidNativePromise(cancel);
      return;
    }
    const cancelWork = Reflect.apply(cancel, stream, [reason]);
    if (cancelWork != null) {
      observeProviderWork(
        cancelWork,
        () => {},
        () => {},
      );
    }
  } catch (error) {
    observeInvalidNativePromise(error);
    // Provider cleanup cannot replace the primary stream outcome.
  }
}

/**
 * Prefer a reader-owned cancellation after acquisition. The stream is locked
 * at that point, so its cancellation method is only a failure fallback.
 *
 * @param {object | Function} reader
 * @param {unknown} read
 * @param {unknown} cancel
 * @param {unknown} releaseLock
 * @param {unknown} stream
 * @param {unknown} reason
 * @param {AbortSignal | undefined} signal
 */
function cancelPartiallyAcquiredProviderReader(
  reader,
  read,
  cancel,
  releaseLock,
  stream,
  reason,
  signal,
) {
  const noop = () => {};
  if (typeof cancel !== "function") {
    tryReleaseProviderReader({
      reader,
      read: typeof read === "function" ? read : noop,
      cancel: noop,
      releaseLock: typeof releaseLock === "function" ? releaseLock : noop,
      cancelStarted: false,
      releaseAttempts: 0,
      released: false,
      signal,
    });
    cancelProviderStream(stream, reason);
    return;
  }
  cancelAndReleaseProviderReader(
    {
      reader,
      read: typeof read === "function" ? read : noop,
      cancel,
      releaseLock: typeof releaseLock === "function" ? releaseLock : noop,
      cancelStarted: false,
      releaseAttempts: 0,
      released: false,
      signal,
    },
    reason,
    null,
    () => cancelProviderStream(stream, reason),
  );
}

/**
 * Capture the stream data property before honoring an abort raised by the
 * descriptor trap, so an already-created provider stream is not orphaned.
 *
 * @param {unknown} result
 * @param {AbortSignal | undefined} signal
 */
function readProviderStreamFromResult(result, signal) {
  const record = assertPlainProviderRecord(result, signal);
  /** @type {PropertyDescriptor | undefined} */
  let descriptor;
  let stream;
  try {
    descriptor = Object.getOwnPropertyDescriptor(record, "stream");
    if (descriptor != null && Object.hasOwn(descriptor, "value")) {
      stream = descriptor.value;
      observeInvalidNativePromise(stream);
    }
  } catch (error) {
    observeInvalidNativePromise(error);
    throwIfTransportSignalAborted(signal);
    throw invalidProviderResponse();
  }
  try {
    const resultSiblingSlots = ["request", "response"].map((property) =>
      captureOptionalProviderOwnDataProperty(record, property, signal),
    );
    throwFirstCapturedProviderError(resultSiblingSlots);
  } catch (error) {
    observeInvalidNativePromise(error);
    cancelProviderStream(stream, signal?.reason);
    if (signal?.aborted) {
      throw classifyTransportError(error, signal);
    }
    throw error;
  }
  if (signal?.aborted) {
    cancelProviderStream(stream, signal.reason);
    throw classifyTransportError(signal.reason, signal);
  }
  if (descriptor == null || !Object.hasOwn(descriptor, "value")) {
    throw invalidProviderResponse();
  }
  return stream;
}

/**
 * @param {object | Function} reader
 * @param {unknown} stream
 * @param {unknown} reason
 * @param {AbortSignal | undefined} signal
 */
function cancelReaderReturnedDuringAbort(reader, stream, reason, signal) {
  let cancel;
  let releaseLock;
  for (const property of ["cancel", "releaseLock"]) {
    let value;
    try {
      value = Reflect.get(reader, property);
      observeInvalidNativePromise(value);
    } catch (error) {
      observeInvalidNativePromise(error);
    }
    if (property === "cancel") {
      cancel = value;
    } else {
      releaseLock = value;
    }
  }
  cancelPartiallyAcquiredProviderReader(
    reader,
    () => {},
    cancel,
    releaseLock,
    stream,
    reason,
    signal,
  );
}

/**
 * @param {unknown} result
 * @param {AbortSignal | undefined} signal
 */
function openProviderStreamReader(result, signal) {
  const stream = readProviderStreamFromResult(result, signal);
  if (signal?.aborted) {
    cancelProviderStream(stream, signal.reason);
    throw classifyTransportError(signal.reason, signal);
  }
  if (
    stream == null ||
    (typeof stream !== "object" && typeof stream !== "function")
  ) {
    throw invalidProviderResponse();
  }
  observeInvalidNativePromise(stream);
  let getReader;
  let reader;
  let read;
  let cancel;
  let releaseLock;
  try {
    getReader = Reflect.get(stream, "getReader");
    observeInvalidNativePromise(getReader);
    throwIfTransportSignalAborted(signal);
    if (typeof getReader !== "function") {
      throw new TypeError();
    }
    reader = Reflect.apply(getReader, stream, []);
    observeInvalidNativePromise(reader);
  } catch (error) {
    observeInvalidNativePromise(error);
    cancelProviderStream(stream, signal?.reason);
    if (signal?.aborted) {
      throw classifyTransportError(error, signal);
    }
    throw invalidProviderResponse();
  }
  if (
    signal?.aborted &&
    reader != null &&
    (typeof reader === "object" || typeof reader === "function")
  ) {
    cancelReaderReturnedDuringAbort(reader, stream, signal.reason, signal);
    throw classifyTransportError(signal.reason, signal);
  }
  if (
    reader == null ||
    (typeof reader !== "object" && typeof reader !== "function")
  ) {
    cancelProviderStream(stream, signal?.reason);
    throw invalidProviderResponse();
  }

  let accessorFailed = false;
  for (const property of ["read", "cancel", "releaseLock"]) {
    let value;
    try {
      value = Reflect.get(reader, property);
      observeInvalidNativePromise(value);
    } catch (error) {
      observeInvalidNativePromise(error);
      accessorFailed = true;
    }
    if (property === "read") {
      read = value;
    } else if (property === "cancel") {
      cancel = value;
    } else {
      releaseLock = value;
    }
    if (signal?.aborted) {
      cancelPartiallyAcquiredProviderReader(
        reader,
        read,
        cancel,
        releaseLock,
        stream,
        signal.reason,
        signal,
      );
      throw classifyTransportError(signal.reason, signal);
    }
  }

  if (
    accessorFailed ||
    typeof read !== "function" ||
    typeof cancel !== "function" ||
    typeof releaseLock !== "function"
  ) {
    for (const value of [read, cancel, releaseLock]) {
      if (typeof value !== "function") {
        observeInvalidNativePromise(value);
      }
    }
    const hasReaderCancel = typeof cancel === "function";
    const cancelReason = signal?.reason;
    const noop = () => {};
    cancelAndReleaseProviderReader(
      {
        reader,
        read: typeof read === "function" ? read : noop,
        cancel: typeof cancel === "function" ? cancel : noop,
        releaseLock: typeof releaseLock === "function" ? releaseLock : noop,
        cancelStarted: false,
        releaseAttempts: 0,
        released: false,
        signal,
      },
      cancelReason,
      null,
      hasReaderCancel
        ? () => cancelProviderStream(stream, cancelReason)
        : undefined,
    );
    if (!hasReaderCancel) {
      cancelProviderStream(stream, cancelReason);
    }
    throw invalidProviderResponse();
  }
  return {
    reader,
    read,
    cancel,
    releaseLock,
    cancelStarted: false,
    releaseAttempts: 0,
    released: false,
    signal,
  };
}

/**
 * @param {ReturnType<typeof openProviderStreamReader>} handle
 * @param {boolean} [retry]
 */
function tryReleaseProviderReader(handle, retry = false) {
  const expectedAttempts = retry ? 1 : 0;
  if (handle.released || handle.releaseAttempts !== expectedAttempts) {
    return;
  }
  const signalWasAborted = handle.signal?.aborted === true;
  handle.releaseAttempts += 1;
  try {
    const releaseWork = Reflect.apply(handle.releaseLock, handle.reader, []);
    handle.released = true;
    observeInvalidNativePromise(releaseWork);
  } catch (error) {
    observeInvalidNativePromise(error);
    if (!signalWasAborted && handle.signal?.aborted) {
      handle.releaseAttempts = 2;
    }
    // One cooperative settlement may trigger one final bounded retry.
  }
}

/**
 * @param {ReturnType<typeof openProviderStreamReader>} handle
 */
function releaseProviderReader(handle) {
  if (handle.released || handle.releaseAttempts !== 0) {
    return;
  }
  handle.releaseAttempts += 1;
  try {
    const releaseWork = Reflect.apply(handle.releaseLock, handle.reader, []);
    handle.released = true;
    observeInvalidNativePromise(releaseWork);
  } catch (error) {
    observeInvalidNativePromise(error);
    throw invalidProviderResponse();
  }
}

/**
 * @param {ReturnType<typeof openProviderStreamReader>} handle
 * @param {unknown} reason
 * @param {PromiseLike<unknown> | null} pendingRead
 * @param {(() => void) | undefined} [onCancelFailure]
 */
function cancelAndReleaseProviderReader(
  handle,
  reason,
  pendingRead,
  onCancelFailure,
) {
  let cancelWork = null;
  let cancelFailedSynchronously = false;
  if (!handle.cancelStarted) {
    handle.cancelStarted = true;
    try {
      cancelWork = Reflect.apply(handle.cancel, handle.reader, [reason]);
    } catch (error) {
      observeInvalidNativePromise(error);
      cancelWork = null;
      cancelFailedSynchronously = true;
    }
  }

  tryReleaseProviderReader(handle);
  const handleCancelFailure = () => {
    try {
      onCancelFailure?.();
    } catch (error) {
      observeInvalidNativePromise(error);
      // A fallback cleanup cannot replace the primary stream outcome.
    }
  };
  if (cancelFailedSynchronously) {
    handleCancelFailure();
  }
  if (pendingRead != null) {
    observeProviderWork(
      pendingRead,
      () => tryReleaseProviderReader(handle, true),
      () => tryReleaseProviderReader(handle, true),
    );
  }
  if (cancelWork != null) {
    observeProviderWork(
      cancelWork,
      () => tryReleaseProviderReader(handle, true),
      () => {
        tryReleaseProviderReader(handle, true);
        handleCancelFailure();
      },
    );
  }
}

/**
 * @param {unknown} result
 * @param {unknown} reason
 */
function cancelLateProviderStream(result, reason) {
  let stream;
  try {
    if (result == null || typeof result !== "object" || Array.isArray(result)) {
      return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(result, "stream");
    if (descriptor == null || !Object.hasOwn(descriptor, "value")) {
      return;
    }
    stream = descriptor.value;
    observeInvalidNativePromise(stream);
  } catch (error) {
    observeInvalidNativePromise(error);
    // Late provider settlement can only receive best-effort bounded cleanup.
    return;
  }
  cancelProviderStream(stream, reason);
}

/**
 * @template T
 * @param {PromiseLike<T> | T} work
 * @param {AbortSignal | undefined} signal
 * @param {(value: T, reason: unknown) => void} [onLateResolve]
 * @returns {Promise<T>}
 */
function waitForProviderWork(work, signal, onLateResolve) {
  if (signal == null) {
    return providerWorkPromise(work);
  }
  if (signal.aborted) {
    const reason = signal.reason;
    observeProviderWork(
      work,
      (value) => {
        try {
          onLateResolve?.(value, reason);
        } catch (error) {
          observeInvalidNativePromise(error);
          // Late cleanup must not surface after the caller has settled.
        }
      },
      () => {},
    );
    return Promise.reject(classifyTransportError(reason, signal));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      signal.removeEventListener("abort", handleAbort);
    };
    const handleAbort = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(classifyTransportError(signal.reason, signal));
    };

    signal.addEventListener("abort", handleAbort, {
      once: true,
    });
    if (signal.aborted) {
      handleAbort();
    }
    observeProviderWork(
      work,
      (value) => {
        if (settled) {
          try {
            onLateResolve?.(value, signal.reason);
          } catch (error) {
            observeInvalidNativePromise(error);
            // Late cleanup must not surface after the caller has settled.
          }
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

/**
 * @param {() => unknown} work
 */
function runProviderConstruction(work) {
  try {
    return work();
  } catch (error) {
    throw classifyUntrustedProviderError(error, undefined);
  }
}

/**
 * @param {{
 *   baseUrl: string,
 *   fetchImpl: typeof fetch,
 * }} options
 */
function createGuardedFetch({ baseUrl, fetchImpl }) {
  const allowedRequestUrl = `${baseUrl}/chat/completions`;

  /**
   * @param {Parameters<typeof fetch>[0]} input
   * @param {Parameters<typeof fetch>[1]} [init]
   */
  return async function guardedOllamaFetch(input, init) {
    const currentEndpoint = parseOllamaOpenAiBaseUrl(baseUrl);
    if (
      `${currentEndpoint.baseUrl}/chat/completions` !== allowedRequestUrl ||
      requestUrl(input) !== allowedRequestUrl
    ) {
      throw requestUrlNotAllowed();
    }

    let response;
    try {
      response = await fetchImpl(input, {
        ...init,
        redirect: OLLAMA_FETCH_REDIRECT,
      });
    } catch (error) {
      observeInvalidNativePromise(error);
      const signal =
        init?.signal ??
        (typeof Request !== "undefined" && input instanceof Request
          ? input.signal
          : undefined);
      if (signal?.aborted) {
        throw classifyTransportError(error, signal);
      }
      throw localTransportError(
        new AgentGatewayError("The AI provider could not be reached.", {
          code: "AI_PROVIDER_NETWORK_FAILED",
          category: "network",
          retryable: true,
        }),
      );
    }
    if (response.status >= 300 && response.status <= 399) {
      throw redirectRejected();
    }
    return response;
  };
}

/**
 * Sole production owner of the OpenAI-compatible provider SDK. The concrete
 * model remains private and can enter only the local AI SDK gateway.
 */
export class OllamaOpenAiTransport {
  #doGenerate;
  #doStream;
  #languageModel;
  #modelTag;
  #proposalState = new WeakMap();

  /**
   * @param {{
   *   baseUrl: unknown,
   *   modelTag: unknown,
   *   fetchImpl?: typeof fetch,
   *   createProvider?: typeof createOpenAI,
   * }} options
   */
  constructor({
    baseUrl,
    modelTag,
    fetchImpl = globalThis.fetch,
    createProvider = createOpenAI,
  }) {
    const endpoint = parseOllamaOpenAiBaseUrl(baseUrl);
    const parsedModelTag = parseOllamaModelTag(modelTag);
    if (typeof fetchImpl !== "function") {
      throw new TypeError("fetchImpl must be a function.");
    }
    if (typeof createProvider !== "function") {
      throw new TypeError("createProvider must be a function.");
    }

    const provider = runProviderConstruction(() =>
      createProvider({
        apiKey: "ollama",
        baseURL: endpoint.baseUrl,
        fetch: createGuardedFetch({
          baseUrl: endpoint.baseUrl,
          fetchImpl,
        }),
        name: "ollama",
      }),
    );
    observeInvalidNativePromise(provider);
    const chat =
      provider == null ||
      (typeof provider !== "object" && typeof provider !== "function")
        ? undefined
        : runProviderConstruction(() => Reflect.get(provider, "chat"));
    observeInvalidNativePromise(chat);
    if (
      provider == null ||
      (typeof provider !== "object" && typeof provider !== "function") ||
      typeof chat !== "function"
    ) {
      throw new TypeError(
        "createProvider must return a provider with a chat method.",
      );
    }

    const languageModel = runProviderConstruction(() =>
      Reflect.apply(chat, provider, [parsedModelTag]),
    );
    observeInvalidNativePromise(languageModel);
    const modelSlots = ["specificationVersion", "doGenerate", "doStream"].map(
      (property) =>
        captureProviderProperty(
          languageModel == null || typeof languageModel !== "object"
            ? undefined
            : languageModel,
          property,
          undefined,
        ),
    );
    try {
      throwFirstCapturedProviderError(modelSlots);
    } catch (error) {
      throw classifyUntrustedProviderError(error, undefined);
    }
    const [specificationVersionSlot, doGenerateSlot, doStreamSlot] = modelSlots;
    const specificationVersion = specificationVersionSlot.value;
    const doGenerate = doGenerateSlot.value;
    const doStream = doStreamSlot.value;
    if (
      languageModel == null ||
      typeof languageModel !== "object" ||
      specificationVersion !== "v3" ||
      typeof doGenerate !== "function" ||
      typeof doStream !== "function"
    ) {
      throw new TypeError(
        "The Ollama provider must return a concrete Chat Completions model.",
      );
    }

    this.#doGenerate = doGenerate;
    this.#doStream = doStream;
    this.#languageModel = languageModel;
    this.#modelTag = parsedModelTag;
  }

  /**
   * Execute one fixed, non-streaming compatibility request through the
   * production Chat Completions provider without exposing SDK result objects.
   *
   * @param {unknown} input
   * @param {{ signal?: AbortSignal }} [options]
   */
  async generateChat(input, { signal } = {}) {
    const request = runInputPreprocessing(
      () => parseGenerateChatRequest(input),
      signal,
    );
    return await this.#runGenerate(
      {
        prompt: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: request.prompt,
              },
            ],
          },
        ],
        ...(request.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: request.maxOutputTokens }),
        temperature: 0,
        topP: 1,
        seed: 424242,
        responseFormat: {
          type: "text",
        },
        providerOptions: {
          openai: {
            parallelToolCalls: false,
            reasoningEffort: "none",
            strictJsonSchema: true,
          },
        },
        abortSignal: signal,
      },
      (result, normalizeSignal) =>
        normalizeGenerateChatResult(result, normalizeSignal),
      signal,
    );
  }

  /**
   * Execute one direct streaming compatibility request. Empty provider deltas
   * are discarded, and the terminal DTO is withheld until the response body
   * has closed.
   *
   * @param {unknown} input
   * @param {{ signal?: AbortSignal }} [options]
   * @returns {AsyncGenerator<
   *   Readonly<
   *     { type: "text.delta", delta: string } |
   *     {
   *       type: "completed",
   *       finishReason: string,
   *       usage: Readonly<{ inputTokens: number, outputTokens: number }>,
   *     }
   *   >,
   *   void,
   *   void
   * >}
   */
  streamChat(input, { signal } = {}) {
    const request = runInputPreprocessing(
      () => parseStreamChatRequest(input),
      signal,
    );
    return this.#runStream(
      {
        prompt: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: request.prompt,
              },
            ],
          },
        ],
        ...(request.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: request.maxOutputTokens }),
        temperature: 0,
        topP: 1,
        seed: 424242,
        responseFormat: {
          type: "text",
        },
        providerOptions: {
          openai: {
            parallelToolCalls: false,
            reasoningEffort: "none",
            strictJsonSchema: true,
          },
        },
        abortSignal: signal,
      },
      signal,
    );
  }

  /**
   * Execute one strict-schema request and return only independently validated
   * JSON data.
   *
   * @param {unknown} input
   * @param {{ signal?: AbortSignal }} [options]
   */
  async generateStructuredChat(input, { signal } = {}) {
    const request = runInputPreprocessing(
      () => parseStructuredChatRequest(input),
      signal,
    );
    return await this.#runGenerate(
      {
        prompt: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: request.prompt,
              },
            ],
          },
        ],
        ...(request.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: request.maxOutputTokens }),
        temperature: 0,
        topP: 1,
        seed: 424242,
        responseFormat: {
          type: "json",
          schema: request.schema,
        },
        providerOptions: {
          openai: {
            parallelToolCalls: false,
            reasoningEffort: "none",
            strictJsonSchema: true,
          },
        },
        abortSignal: signal,
      },
      (result, normalizeSignal) =>
        normalizeStructuredResult(result, request.validate, normalizeSignal),
      signal,
    );
  }

  /**
   * Request one forced function-tool proposal without executing it or
   * continuing the model.
   *
   * @param {unknown} input
   * @param {{ signal?: AbortSignal }} [options]
   */
  async proposeForcedToolCall(input, { signal } = {}) {
    const request = runInputPreprocessing(
      () => parseForcedToolRequest(input),
      signal,
    );
    const proposal = await this.#runGenerate(
      {
        prompt: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: request.prompt,
              },
            ],
          },
        ],
        ...(request.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: request.maxOutputTokens }),
        temperature: 0,
        topP: 1,
        seed: 424242,
        responseFormat: {
          type: "text",
        },
        tools: [
          {
            type: "function",
            name: request.tool.name,
            description: request.tool.description,
            inputSchema: request.tool.inputSchema,
          },
        ],
        toolChoice: {
          type: "tool",
          toolName: request.tool.name,
        },
        providerOptions: {
          openai: {
            parallelToolCalls: false,
            reasoningEffort: "none",
            strictJsonSchema: true,
          },
        },
        abortSignal: signal,
      },
      (result, normalizeSignal) =>
        normalizeToolProposal(
          result,
          {
            name: request.tool.name,
            validateInput: request.validateInput,
          },
          normalizeSignal,
        ),
      signal,
    );
    this.#proposalState.set(proposal, {
      consumed: false,
      prompt: request.prompt,
      call: proposal.call,
    });
    return proposal;
  }

  /**
   * Continue exactly one proposal issued by this transport. The proposal is
   * consumed before dispatch and cannot be forged, shared, or retried.
   *
   * @param {unknown} input
   * @param {{ signal?: AbortSignal }} [options]
   */
  async continueToolCall(input, { signal } = {}) {
    const request = runInputPreprocessing(() => {
      const record = readExactRecord(
        input,
        ["proposal", "toolResult"],
        "The tool continuation request is invalid.",
        ["maxOutputTokens"],
      );
      const proposal =
        record.proposal != null &&
        typeof record.proposal === "object" &&
        !Array.isArray(record.proposal)
          ? record.proposal
          : null;
      const state =
        proposal == null ? undefined : this.#proposalState.get(proposal);
      if (state == null || state.consumed) {
        throw new TypeError(
          "proposal must be an unused proposal issued by this transport.",
        );
      }
      const { maxOutputTokens } = parsePromptAndMaxOutputTokens(
        state.prompt,
        record.maxOutputTokens,
      );
      return Object.freeze({
        state,
        maxOutputTokens,
        toolResult: snapshotJsonObject(record.toolResult),
      });
    }, signal);
    request.state.consumed = true;
    return await this.#runGenerate(
      {
        prompt: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: request.state.prompt,
              },
            ],
          },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolCallId: request.state.call.id,
                toolName: request.state.call.name,
                input: request.state.call.input,
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: request.state.call.id,
                toolName: request.state.call.name,
                output: {
                  type: "json",
                  value: request.toolResult,
                },
              },
            ],
          },
        ],
        ...(request.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: request.maxOutputTokens }),
        temperature: 0,
        topP: 1,
        seed: 424242,
        responseFormat: {
          type: "text",
        },
        providerOptions: {
          openai: {
            parallelToolCalls: false,
            reasoningEffort: "none",
            strictJsonSchema: true,
          },
        },
        abortSignal: signal,
      },
      (result, normalizeSignal) =>
        normalizeToolContinuationResult(result, normalizeSignal),
      signal,
    );
  }

  /**
   * @template T
   * @param {Record<string, unknown>} callOptions
   * @param {(result: unknown, signal: AbortSignal | undefined) => T} normalize
   * @param {AbortSignal | undefined} signal
   * @returns {Promise<T>}
   */
  async #runGenerate(callOptions, normalize, signal) {
    if (signal?.aborted) {
      throw classifyTransportError(signal.reason, signal);
    }
    assertNoGlobalTelemetryIntegration();
    let result;
    try {
      const providerWork = Reflect.apply(
        this.#doGenerate,
        this.#languageModel,
        [callOptions],
      );
      result = await waitForProviderWork(providerWork, signal);
      if (signal?.aborted) {
        throw classifyTransportError(signal.reason, signal);
      }
      const normalizedResult = normalize(result, signal);
      if (signal?.aborted) {
        throw classifyTransportError(signal.reason, signal);
      }
      return normalizedResult;
    } catch (error) {
      throw classifyUntrustedProviderError(error, signal);
    }
  }

  /**
   * @param {Record<string, unknown>} callOptions
   * @param {AbortSignal | undefined} signal
   * @returns {AsyncGenerator<
   *   Readonly<
   *     { type: "text.delta", delta: string } |
   *     {
   *       type: "completed",
   *       finishReason: string,
   *       usage: Readonly<{ inputTokens: number, outputTokens: number }>,
   *     }
   *   >,
   *   void,
   *   void
   * >}
   */
  async *#runStream(callOptions, signal) {
    if (signal?.aborted) {
      throw classifyTransportError(signal.reason, signal);
    }
    assertNoGlobalTelemetryIntegration();

    /** @type {ReturnType<typeof openProviderStreamReader> | null} */
    let readerHandle = null;
    /** @type {PromiseLike<unknown> | null} */
    let pendingRead = null;
    let bodyClosed = false;
    let streamFailed = false;
    let streamError;
    const state = createProviderStreamState();

    try {
      const providerWork = Reflect.apply(this.#doStream, this.#languageModel, [
        callOptions,
      ]);
      const result = await waitForProviderWork(
        providerWork,
        signal,
        (lateResult, reason) => cancelLateProviderStream(lateResult, reason),
      );
      if (signal?.aborted) {
        cancelLateProviderStream(result, signal.reason);
        throw classifyTransportError(signal.reason, signal);
      }
      readerHandle = openProviderStreamReader(result, signal);
      if (signal?.aborted) {
        throw classifyTransportError(signal.reason, signal);
      }

      while (true) {
        if (signal?.aborted) {
          throw classifyTransportError(signal.reason, signal);
        }
        let rawStep;
        try {
          const readWork = Reflect.apply(
            readerHandle.read,
            readerHandle.reader,
            [],
          );
          pendingRead = providerWorkPromise(readWork);
          rawStep = await waitForProviderWork(pendingRead, signal);
          pendingRead = null;
        } catch (error) {
          throw classifyUntrustedProviderError(error, signal);
        }
        if (signal?.aborted) {
          throw classifyTransportError(signal.reason, signal);
        }
        const step = readProviderStreamStep(rawStep, signal);
        if (signal?.aborted) {
          throw classifyTransportError(signal.reason, signal);
        }

        if (step.done) {
          bodyClosed = true;
          if (!state.finishSeen || state.terminal == null) {
            throw invalidProviderResponse();
          }
          if (signal?.aborted) {
            throw classifyTransportError(signal.reason, signal);
          }
          releaseProviderReader(readerHandle);
          readerHandle = null;
          if (signal?.aborted) {
            throw classifyTransportError(signal.reason, signal);
          }
          yield state.terminal;
          return;
        }

        const normalized = normalizeProviderStreamPart(
          step.value,
          state,
          signal,
        );
        if (signal?.aborted) {
          throw classifyTransportError(signal.reason, signal);
        }
        if (normalized?.type === "provider.error") {
          throw classifyUntrustedProviderError(normalized.error, signal);
        }
        if (normalized?.type === "text.delta") {
          yield normalized;
          if (signal?.aborted) {
            throw classifyTransportError(signal.reason, signal);
          }
        }
      }
    } catch (error) {
      streamFailed = true;
      streamError = error;
    } finally {
      if (readerHandle != null) {
        if (bodyClosed) {
          tryReleaseProviderReader(readerHandle);
        } else {
          cancelAndReleaseProviderReader(
            readerHandle,
            signal?.reason,
            pendingRead,
          );
        }
      }
    }
    if (streamFailed) {
      throw classifyUntrustedProviderError(streamError, signal);
    }
  }

  /**
   * Create the subject-bound discussion path from the same private concrete
   * model as review requests. Discussions expose no project-read tool.
   *
   * @param {{
   *   contextLength: ConstructorParameters<typeof AiSdkAgentGateway>[0]["contextLength"],
   *   now?: () => string,
   *   createId?: (kind: 'event' | 'finding' | 'suggestion') => string,
   * }} options
   */
  createDiscussionGateway({ contextLength, now, createId }) {
    return new AiSdkAgentGateway({
      model: this.#languageModel,
      provider: "ollama",
      modelId: this.#modelTag,
      contextLength,
      readProjectFile() {
        throw new AgentGatewayError(
          "Project reads are not available in a discussion.",
          {
            code: "AI_TOOL_NOT_ALLOWED",
            category: "schema",
            retryable: false,
          },
        );
      },
      now,
      createId,
    });
  }

  /**
   * @param {{
   *   contextLength: ConstructorParameters<typeof AiSdkAgentGateway>[0]["contextLength"],
   *   readProjectFile: ConstructorParameters<typeof AiSdkAgentGateway>[0]["readProjectFile"],
   *   projectContext?: ConstructorParameters<typeof AiSdkAgentGateway>[0]["projectContext"],
   *   searchZotero?: ConstructorParameters<typeof AiSdkAgentGateway>[0]["searchZotero"],
   *   validateEvidence?: ConstructorParameters<typeof AiSdkAgentGateway>[0]["validateEvidence"],
   *   now?: () => string,
   *   createId?: (kind: 'event' | 'finding' | 'suggestion') => string,
   * }} options
   */
  createAgentGateway({
    contextLength,
    readProjectFile,
    projectContext,
    searchZotero,
    validateEvidence,
    now,
    createId,
  }) {
    return new AiSdkAgentGateway({
      model: this.#languageModel,
      provider: "ollama",
      modelId: this.#modelTag,
      contextLength,
      readProjectFile,
      projectContext,
      searchZotero,
      validateEvidence,
      now,
      createId,
    });
  }
}
