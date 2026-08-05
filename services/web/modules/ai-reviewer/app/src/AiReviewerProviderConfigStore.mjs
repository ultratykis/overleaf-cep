// @ts-check

import { AiReviewerProviderConfig } from "../models/AiReviewerProviderConfig.mjs";
import {
  parseAiReviewerProviderConfig,
  parseAiReviewerProviderConfigUpdate,
} from "./AiReviewerProviderConfig.mjs";
import { createAiReviewerProviderCredentialManager } from "./AiReviewerProviderCredentialManager.mjs";

const MAX_PROVIDER_CONFIG_SAVE_RETRIES = 5;

/** @param {any} query */
async function lean(query) {
  return await query.lean().exec();
}

/** @param {unknown} error */
function isDuplicateKeyError(error) {
  return (
    typeof error === "object" &&
    error != null &&
    "code" in error &&
    error.code === 11000
  );
}

/** @param {any} record */
function storedRevision(record) {
  const revision = record?.revision ?? 0;
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new TypeError("The AI provider configuration revision is invalid.");
  }
  return /** @type {number} */ (revision);
}

/**
 * Legacy records have no revision and are treated as revision zero. Matching
 * both representations lets the first successful CAS migrate them in place.
 *
 * @param {string} userId
 * @param {number} revision
 */
function revisionFilter(userId, revision) {
  return revision === 0
    ? {
        _id: userId,
        $or: [{ revision: 0 }, { revision: { $exists: false } }],
      }
    : { _id: userId, revision };
}

/**
 * @param {any} record
 * @param {ReturnType<typeof createAiReviewerProviderCredentialManager>} credentialManager
 */
async function storedConfig(record, credentialManager) {
  if (record == null || record.contextLength === undefined) {
    return null;
  }
  const destination = parseAiReviewerProviderConfig({
    provider: record.provider,
    baseUrl: record.baseUrl,
    model: record.model,
    contextLength: record.contextLength,
  });
  let credential;
  if (record.credentialEncrypted != null) {
    if (record.credentialUpdatedAt == null) {
      throw new TypeError("The AI provider credential metadata is invalid.");
    }
    credential = await credentialManager.decrypt(record.credentialEncrypted, {
      provider: destination.provider,
      baseUrl: destination.baseUrl,
    });
  }
  return parseAiReviewerProviderConfig({
    provider: destination.provider,
    baseUrl: destination.baseUrl,
    model: destination.model,
    contextLength: destination.contextLength,
    ...(credential === undefined ? {} : { credential }),
    ...(record.credentialUpdatedAt == null
      ? {}
      : { credentialUpdatedAt: record.credentialUpdatedAt }),
  });
}

/** @param {unknown} value */
function timestamp(value) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.valueOf())) {
    throw new TypeError("now must return a valid timestamp.");
  }
  return date;
}

/**
 * @param {{
 *   model?: typeof AiReviewerProviderConfig,
 *   credentialManager?: ReturnType<typeof createAiReviewerProviderCredentialManager>,
 *   now?: () => Date | string,
 * }} [dependencies]
 */
export function createAiReviewerProviderConfigStore({
  model = AiReviewerProviderConfig,
  credentialManager = createAiReviewerProviderCredentialManager(),
  now = () => new Date(),
} = {}) {
  return {
    /** @param {string} userId */
    async get(userId) {
      return await storedConfig(
        await lean(model.findOne({ _id: userId })),
        credentialManager,
      );
    },

    /**
     * @param {string} userId
     * @param {unknown} input
     */
    async save(userId, input) {
      const config = parseAiReviewerProviderConfigUpdate(input);
      const credentialProvided = Object.hasOwn(config, "credential");
      const replacingCredential =
        credentialProvided && typeof config.credential === "string";
      const encryptedCredential = replacingCredential
        ? await credentialManager.encrypt({
            provider: config.provider,
            baseUrl: config.baseUrl,
            credential: config.credential,
          })
        : undefined;

      for (
        let attempt = 0;
        attempt < MAX_PROVIDER_CONFIG_SAVE_RETRIES;
        attempt += 1
      ) {
        const currentRecord = await lean(model.findOne({ _id: userId }));
        const expectedRevision = storedRevision(currentRecord);
        let current = null;
        try {
          current =
            currentRecord == null
              ? null
              : parseAiReviewerProviderConfig({
                  provider: currentRecord.provider,
                  baseUrl: currentRecord.baseUrl,
                  model: currentRecord.model,
                  contextLength: currentRecord.contextLength,
                });
        } catch {
          current = null;
        }
        const sameDestination =
          current?.provider === config.provider &&
          current?.baseUrl === config.baseUrl;
        const hasStoredCredential =
          typeof currentRecord?.credentialEncrypted === "string" &&
          currentRecord.credentialEncrypted.length > 0;
        const clearingCredential =
          (credentialProvided && config.credential == null) ||
          (!credentialProvided && !sameDestination && hasStoredCredential);
        /** @type {any} */
        const update = {
          $set: {
            provider: config.provider,
            baseUrl: config.baseUrl,
            model: config.model,
            contextLength: config.contextLength,
          },
          $inc: { revision: 1 },
          ...(clearingCredential
            ? { $unset: { credentialEncrypted: "" } }
            : {}),
        };

        if (replacingCredential) {
          update.$set.credentialEncrypted = encryptedCredential;
          update.$set.credentialUpdatedAt = timestamp(now());
        } else if (clearingCredential && hasStoredCredential) {
          update.$set.credentialUpdatedAt = timestamp(now());
        }

        try {
          const record = await lean(
            model.findOneAndUpdate(
              revisionFilter(userId, expectedRevision),
              update,
              {
                new: true,
                runValidators: true,
                setDefaultsOnInsert: true,
                upsert: currentRecord == null,
              },
            ),
          );
          if (record != null) {
            return await storedConfig(record, credentialManager);
          }
        } catch (error) {
          if (!isDuplicateKeyError(error)) {
            throw error;
          }
        }
      }
      throw new Error(
        "The AI provider configuration changed while it was being saved.",
      );
    },
  };
}
