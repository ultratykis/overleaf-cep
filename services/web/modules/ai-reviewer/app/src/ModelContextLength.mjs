// @ts-check

export const MAX_DETECTED_MODEL_CONTEXT_LENGTH = 10_000_000;

// Provider model-list APIs use different names for the same limit. Keep the
// paths together so supporting another compatible server is a one-line change.
export const MODEL_CONTEXT_LENGTH_FIELD_PATHS = Object.freeze([
  Object.freeze(["max_input_tokens"]),
  Object.freeze(["inputTokenLimit"]),
  Object.freeze(["max_model_len"]),
  Object.freeze(["max_context_length"]),
  Object.freeze(["n_ctx"]),
  Object.freeze(["context_window"]),
  Object.freeze(["context_length"]),
  Object.freeze(["metadata", "context_length"]),
  Object.freeze(["contextLength"]),
]);

const PENDING_MODEL_CONTEXT_LENGTH = Object.freeze({
  contextLength: null,
  contextLengthSource: /** @type {const} */ ("pending"),
});
const UNAVAILABLE_MODEL_CONTEXT_LENGTH = Object.freeze({
  contextLength: null,
  contextLengthSource: /** @type {const} */ ("unavailable"),
});

/**
 * @param {unknown} value
 * @param {number} [maximum]
 */
export function isValidModelContextLength(
  value,
  maximum = Number.MAX_SAFE_INTEGER,
) {
  return (
    Number.isSafeInteger(value) &&
    /** @type {number} */ (value) > 0 &&
    /** @type {number} */ (value) <= maximum
  );
}

/** @param {unknown} value @param {string} key */
function ownDataProperty(value, key) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor != null && Object.hasOwn(descriptor, "value")
    ? descriptor.value
    : undefined;
}

/**
 * Read the first valid provider-advertised value in the shared path order.
 * Accessors are ignored because model metadata is untrusted even in tests.
 *
 * @param {unknown} input
 * @returns {number | null}
 */
export function modelContextLengthFromFields(input) {
  for (const path of MODEL_CONTEXT_LENGTH_FIELD_PATHS) {
    let value = input;
    for (const key of path) {
      value = ownDataProperty(value, key);
    }
    if (isValidModelContextLength(value, MAX_DETECTED_MODEL_CONTEXT_LENGTH)) {
      return /** @type {number} */ (value);
    }
  }
  return null;
}

/**
 * Resolve values already available to the process. Model listing uses this
 * path and never invents a fallback when neither metadata nor an override is
 * present.
 *
 * @param {{
 *   provider: "openai-compatible" | "gemini" | "claude" | "azure",
 *   contextLength?: number,
 *   contextLengthOverride?: number | null,
 *   detectedContextLength?: number | null,
 * }} input
 */
export function resolveModelContextLengthWithoutDetection(input) {
  const override = Object.hasOwn(input, "contextLengthOverride")
    ? input.contextLengthOverride
    : input.contextLength;
  if (override != null) {
    if (!isValidModelContextLength(override)) {
      throw new TypeError(
        "contextLengthOverride must be a positive safe integer.",
      );
    }
    return Object.freeze({
      contextLength: override,
      contextLengthSource: /** @type {const} */ ("override"),
    });
  }

  if (
    isValidModelContextLength(
      input.detectedContextLength,
      MAX_DETECTED_MODEL_CONTEXT_LENGTH,
    )
  ) {
    return Object.freeze({
      contextLength: /** @type {number} */ (input.detectedContextLength),
      contextLengthSource: /** @type {const} */ ("detected"),
    });
  }

  return input.provider === "openai-compatible"
    ? PENDING_MODEL_CONTEXT_LENGTH
    : UNAVAILABLE_MODEL_CONTEXT_LENGTH;
}

/**
 * @param {{
 *   provider: "openai-compatible" | "gemini" | "claude" | "azure",
 *   baseUrl?: string,
 *   model: string,
 *   credential?: unknown,
 *   contextLength?: number,
 *   contextLengthOverride?: number | null,
 *   detectedContextLength?: number | null,
 * }} input
 * @param {{
 *   detectOpenAiCompatibleContextLength?: (input: {
 *     baseUrl: string,
 *     model: string,
 *     credential?: string,
 *   }) => Promise<unknown>,
 * }} [dependencies]
 */
export async function resolveModelContextLength(
  input,
  { detectOpenAiCompatibleContextLength } = {},
) {
  const withoutDetection = resolveModelContextLengthWithoutDetection(input);
  if (
    withoutDetection.contextLengthSource === "override" ||
    withoutDetection.contextLengthSource === "detected" ||
    input.provider !== "openai-compatible" ||
    typeof input.baseUrl !== "string" ||
    typeof detectOpenAiCompatibleContextLength !== "function"
  ) {
    return withoutDetection;
  }

  try {
    const detected = await detectOpenAiCompatibleContextLength({
      baseUrl: input.baseUrl,
      model: input.model,
      ...(typeof input.credential === "string"
        ? { credential: input.credential }
        : {}),
    });
    if (
      isValidModelContextLength(detected, MAX_DETECTED_MODEL_CONTEXT_LENGTH)
    ) {
      return Object.freeze({
        contextLength: /** @type {number} */ (detected),
        contextLengthSource: /** @type {const} */ ("detected"),
      });
    }
  } catch {
    // Runtime allocation discovery is best-effort. Ollama /api/ps values enter
    // only through the detector after a successful probe, so its failed probe
    // is unavailable for this run and is refused before the review request. A
    // later run may probe again because failures are not cached.
  }

  return withoutDetection.contextLengthSource === "pending"
    ? UNAVAILABLE_MODEL_CONTEXT_LENGTH
    : withoutDetection;
}
