// @ts-check

import { AccessTokenEncryptor } from "../../../zotero/app/src/AccessTokenEncryptorHelper.mjs";

const ENVELOPE_KEYS = ["baseUrl", "credential", "provider"];

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
  if (
    keys.length !== ENVELOPE_KEYS.length ||
    keys.some((key, index) => key !== ENVELOPE_KEYS[index]) ||
    value.provider !== "openai-compatible" ||
    typeof value.baseUrl !== "string" ||
    typeof value.credential !== "string" ||
    value.credential.length === 0
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
     *   provider: "openai-compatible",
     *   baseUrl: string,
     *   credential: string,
     * }} input
     */
    async encrypt(input) {
      try {
        const encrypted = await encryptor.encryptJson({
          provider: input.provider,
          baseUrl: input.baseUrl,
          credential: input.credential,
        });
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
     * @param {{ provider: "openai-compatible", baseUrl: string }} destination
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
          envelope.baseUrl !== destination.baseUrl
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
