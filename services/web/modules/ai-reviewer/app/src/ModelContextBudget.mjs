// @ts-check

const MODEL_INPUT_CONTEXT_SHARE = 0.7;
const MESSAGE_OVERHEAD_TOKENS = 4;
const CJK_CHARACTER =
  /[\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}\p{Script_Extensions=Hangul}\u3000-\u303f\uff00-\uffef]/u;

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
 * @param {string | ReadonlyArray<{ content: string }>} input
 *
 * @returns {number}
 */
export function estimateModelInputTokens(input) {
  const contents =
    typeof input === "string" ? [input] : input.map(({ content }) => content);
  let tokens =
    typeof input === "string" ? 0 : input.length * MESSAGE_OVERHEAD_TOKENS;

  for (const content of contents) {
    let cjkCharacters = 0;
    let otherCharacters = 0;
    for (const character of content) {
      if (CJK_CHARACTER.test(character)) {
        cjkCharacters += 1;
      } else {
        otherCharacters += 1;
      }
    }
    tokens += cjkCharacters + Math.ceil(otherCharacters / 4);
  }
  return tokens;
}

/**
 * Reserve 30% of the context window for system/schema overhead, tokenization
 * variance, and the model response.
 *
 * @param {unknown} contextLength
 */
export function modelInputTokenBudget(contextLength) {
  const parsedContextLength = parseModelContextLength(contextLength);
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.floor(parsedContextLength * MODEL_INPUT_CONTEXT_SHARE),
  );
}
