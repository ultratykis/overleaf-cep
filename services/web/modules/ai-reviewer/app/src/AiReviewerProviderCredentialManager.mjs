// @ts-check

import { AccessTokenEncryptor } from "../../../zotero/app/src/AccessTokenEncryptorHelper.mjs";

const NATIVE_ENVELOPE_KEYS = ["credential", "provider"];
const OPENAI_COMPATIBLE_ENVELOPE_KEYS = ["baseUrl", "credential", "provider"];

function credentialError() {
  return new TypeError("The AI provider credential could not be read.");
}

/** @param {unknown} input */
function exactEnvelope(input) {
  if (
    input == null ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Reflect.ownKeys(input).some((key) => typeof key !== "string")
  ) {
    throw credentialError();
  }
  const value = /** @type {Record<string, unknown>} */ (input);
  const keys = Object.keys(value).sort();
  if (typeof value.credential !== "string" || value.credential.length === 0) {
    throw credentialError();
  }
  if (value.provider === "openai-compatible") {
    if (
      keys.length !== OPENAI_COMPATIBLE_ENVELOPE_KEYS.length ||
      keys.some(
        (key, index) => key !== OPENAI_COMPATIBLE_ENVELOPE_KEYS[index],
      ) ||
      typeof value.baseUrl !== "string"
    ) {
      throw credentialError();
    }
    return value;
  }
  if (
    (value.provider !== "gemini" && value.provider !== "claude") ||
    keys.length !== NATIVE_ENVELOPE_KEYS.length ||
    keys.some((key, index) => key !== NATIVE_ENVELOPE_KEYS[index])
  ) {
    throw credentialError();
  }
  return value;
}

/**
 * @param {{
 *   encryptor?: Pick<typeof AccessTokenEncryptor, "decryptToJson" | "encryptJson">,
 * }} [dependencies]
 */
export function createAiReviewerProviderCredentialManager({
  encryptor = AccessTokenEncryptor,
} = {}) {
  return Object.freeze({
    /**
     * @param {{
     *   provider: "openai-compatible" | "gemini" | "claude",
     *   baseUrl?: string,
     *   credential: string,
     * }} input
     */
    async encrypt(input) {
      try {
        const envelope =
          input.provider === "openai-compatible"
            ? {
                provider: input.provider,
                baseUrl: input.baseUrl,
                credential: input.credential,
              }
            : {
                provider: input.provider,
                credential: input.credential,
              };
        const encrypted = await encryptor.encryptJson(envelope);
        if (typeof encrypted !== "string" || encrypted.length === 0) {
          throw credentialError();
        }
        return encrypted;
      } catch {
        throw credentialError();
      }
    },

    /**
     * @param {unknown} encrypted
     * @param {{
     *   provider: "openai-compatible" | "gemini" | "claude",
     *   baseUrl?: string,
     * }} destination
     */
    async decrypt(encrypted, destination) {
      if (typeof encrypted !== "string" || encrypted.length === 0) {
        throw credentialError();
      }
      try {
        const envelope = exactEnvelope(
          await encryptor.decryptToJson(encrypted),
        );
        if (
          envelope.provider !== destination.provider ||
          (destination.provider === "openai-compatible" &&
            envelope.baseUrl !== destination.baseUrl)
        ) {
          throw credentialError();
        }
        return envelope.credential;
      } catch {
        throw credentialError();
      }
    },
  });
}
