// @ts-check

export const DEFAULT_MODEL_CONTEXT_LENGTH = 4_096;
export const MAX_DETECTED_MODEL_CONTEXT_LENGTH = 10_000_000;

const GEMINI_ONE_MILLION_CONTEXT_MODELS = new Set([
  "gemini-2.5-pro",
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-3.1-pro-preview",
  "gemini-3.1-pro-preview-customtools",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite",
  "gemini-3.5-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.6-flash",
]);
const CLAUDE_ONE_MILLION_CONTEXT_MODELS = new Set([
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-fable-5",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-mythos-5",
  "claude-mythos-preview",
]);
const CLAUDE_TWO_HUNDRED_THOUSAND_CONTEXT_MODEL =
  /^(?:claude-3(?:-(?:5|7))?-(?:haiku|sonnet|opus)(?:-\d{8})?|claude-(?:haiku|sonnet|opus)-4(?:-(?:1|5))?(?:-\d{8})?)$/u;

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

/**
 * Keep this table explicit. A broad provider-family prefix can overstate a
 * specialised model such as a TTS model by orders of magnitude.
 *
 * @param {"gemini" | "claude"} provider
 * @param {string} model
 * @returns {number | null}
 */
export function deriveNativeModelContextLength(provider, model) {
  if (provider === "gemini") {
    const canonicalModel = model.startsWith("models/")
      ? model.slice("models/".length)
      : model;
    return GEMINI_ONE_MILLION_CONTEXT_MODELS.has(canonicalModel)
      ? 1_048_576
      : null;
  }

  if (CLAUDE_ONE_MILLION_CONTEXT_MODELS.has(model)) {
    return 1_000_000;
  }
  return CLAUDE_TWO_HUNDRED_THOUSAND_CONTEXT_MODEL.test(model) ? 200_000 : null;
}

/**
 * @param {{
 *   provider: "openai-compatible" | "gemini" | "claude",
 *   baseUrl?: string,
 *   model: string,
 *   credential?: unknown,
 *   contextLength?: number,
 *   contextLengthOverride?: number | null,
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

  if (input.provider === "gemini" || input.provider === "claude") {
    const derived = deriveNativeModelContextLength(input.provider, input.model);
    if (derived != null) {
      return Object.freeze({
        contextLength: derived,
        contextLengthSource: /** @type {const} */ ("derived"),
      });
    }
  } else if (
    input.provider === "openai-compatible" &&
    typeof input.baseUrl === "string" &&
    typeof detectOpenAiCompatibleContextLength === "function"
  ) {
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
      // Detection is best-effort. An unusable response takes the safe default.
    }
  }

  return Object.freeze({
    contextLength: DEFAULT_MODEL_CONTEXT_LENGTH,
    contextLengthSource: /** @type {const} */ ("default"),
  });
}
