// @ts-check

const CONSERVATIVE_CHARACTERS_PER_TOKEN = 1;
const MODEL_INPUT_CONTEXT_SHARE = 0.5;

/**
 * @param {unknown} input
 */
export function parseModelContextLength(input) {
  if (typeof input !== "number" || !Number.isSafeInteger(input) || input <= 0) {
    throw new TypeError("contextLength must be a positive safe integer.");
  }
  return input;
}

/**
 * Treat one UTF-16 character as one token so CJK, LaTeX, and JSON do not
 * inherit an optimistic prose ratio. Reserve the other half of the context
 * window for the system instruction, provider schema overhead, tokenization
 * variance, and the model response.
 *
 * @param {unknown} contextLength
 */
export function modelInputCharacterBudget(contextLength) {
  const parsedContextLength = parseModelContextLength(contextLength);
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.floor(
      parsedContextLength *
        CONSERVATIVE_CHARACTERS_PER_TOKEN *
        MODEL_INPUT_CONTEXT_SHARE,
    ),
  );
}
