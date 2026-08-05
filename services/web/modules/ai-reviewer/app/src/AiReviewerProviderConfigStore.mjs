// @ts-check

import { AiReviewerProviderConfig } from "../models/AiReviewerProviderConfig.mjs";
import {
  parseAiReviewerProviderConfig,
  parseAiReviewerProviderConfigUpdate,
} from "./AiReviewerProviderConfig.mjs";
import { createAiReviewerProviderCredentialManager } from "./AiReviewerProviderCredentialManager.mjs";
import { resolveModelContextLength } from "./ModelContextLength.mjs";

const MAX_PROVIDER_CONFIG_SAVE_RETRIES = 5;

export class AiReviewerProviderConfigInputError extends TypeError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "AiReviewerProviderConfigInputError";
  }
}

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

/** @param {any} value */
function coreConfigInput(value) {
  return {
    provider: value?.provider,
    ...(value?.provider === "openai-compatible" || value?.provider === "ollama"
      ? { baseUrl: value?.baseUrl }
      : {}),
    model: value?.model,
    contextLength: value?.contextLength,
    ...(Object.hasOwn(value ?? {}, "contextLengthSource")
      ? { contextLengthSource: value?.contextLengthSource }
      : {}),
  };
}

/**
 * @param {ReturnType<typeof parseAiReviewerProviderConfig>} config
 */
function credentialDestination(config) {
  return config.provider === "openai-compatible"
    ? Object.freeze({
        provider: config.provider,
        baseUrl: config.baseUrl,
      })
    : Object.freeze({ provider: config.provider });
}

/**
 * @param {ReturnType<typeof parseAiReviewerProviderConfig> | null} current
 * @param {ReturnType<typeof parseAiReviewerProviderConfigUpdate>} next
 */
function isSameCredentialDestination(current, next) {
  if (current == null || current.provider !== next.provider) {
    return false;
  }
  return (
    next.provider !== "openai-compatible" ||
    (current.provider === "openai-compatible" &&
      current.baseUrl === next.baseUrl)
  );
}

/**
 * @param {any} record
 * @param {ReturnType<typeof parseAiReviewerProviderConfig>} destination
 * @param {ReturnType<typeof createAiReviewerProviderCredentialManager>} credentialManager
 */
async function storedCredential(record, destination, credentialManager) {
  if (record.credentialEncrypted == null) {
    return undefined;
  }
  if (record.credentialUpdatedAt == null) {
    throw new TypeError("The AI provider credential metadata is invalid.");
  }
  return await credentialManager.decrypt(record.credentialEncrypted, {
    ...credentialDestination(destination),
  });
}

/**
 * @param {any} record
 * @param {ReturnType<typeof createAiReviewerProviderCredentialManager>} credentialManager
 */
async function storedConfig(record, credentialManager) {
  if (record == null || record.contextLength === undefined) {
    return null;
  }
  const destination = parseAiReviewerProviderConfig(coreConfigInput(record));
  const credential = await storedCredential(
    record,
    destination,
    credentialManager,
  );
  if (
    destination.provider !== "openai-compatible" &&
    credential === undefined
  ) {
    throw new TypeError("The AI provider credential is required.");
  }
  return parseAiReviewerProviderConfig({
    provider: destination.provider,
    ...(destination.provider === "openai-compatible"
      ? { baseUrl: destination.baseUrl }
      : {}),
    model: destination.model,
    contextLength: destination.contextLength,
    ...(destination.contextLengthSource === undefined
      ? {}
      : { contextLengthSource: destination.contextLengthSource }),
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
 *   resolveContextLength?: typeof resolveModelContextLength,
 *   now?: () => Date | string,
 * }} [dependencies]
 */
export function createAiReviewerProviderConfigStore({
  model = AiReviewerProviderConfig,
  credentialManager = createAiReviewerProviderCredentialManager(),
  resolveContextLength = resolveModelContextLength,
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
            ...(config.provider === "openai-compatible"
              ? { baseUrl: config.baseUrl }
              : {}),
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
              : parseAiReviewerProviderConfig(coreConfigInput(currentRecord));
        } catch {
          current = null;
        }
        const sameDestination = isSameCredentialDestination(current, config);
        const hasStoredCredential =
          typeof currentRecord?.credentialEncrypted === "string" &&
          currentRecord.credentialEncrypted.length > 0;
        const clearingCredential =
          (credentialProvided && config.credential == null) ||
          (!credentialProvided && !sameDestination && hasStoredCredential);
        const hasEffectiveCredential =
          replacingCredential ||
          (!credentialProvided && sameDestination && hasStoredCredential);
        if (
          config.provider !== "openai-compatible" &&
          !hasEffectiveCredential
        ) {
          throw new AiReviewerProviderConfigInputError(
            "The AI provider credential is required.",
          );
        }
        const effectiveCredential = replacingCredential
          ? config.credential
          : !credentialProvided && sameDestination && hasStoredCredential
            ? await storedCredential(
                currentRecord,
                /** @type {ReturnType<typeof parseAiReviewerProviderConfig>} */ (
                  current
                ),
                credentialManager,
              )
            : undefined;
        const resolution = await resolveContextLength({
          provider: config.provider,
          ...(config.provider === "openai-compatible"
            ? { baseUrl: config.baseUrl }
            : {}),
          model: config.model,
          ...(Object.hasOwn(config, "contextLength")
            ? { contextLength: config.contextLength }
            : {}),
          ...(Object.hasOwn(config, "contextLengthOverride")
            ? { contextLengthOverride: config.contextLengthOverride }
            : {}),
          ...(effectiveCredential === undefined
            ? {}
            : { credential: effectiveCredential }),
        });
        const resolvedConfig = parseAiReviewerProviderConfig({
          provider: config.provider,
          ...(config.provider === "openai-compatible"
            ? { baseUrl: config.baseUrl }
            : {}),
          model: config.model,
          contextLength: resolution.contextLength,
          contextLengthSource: resolution.contextLengthSource,
        });
        const legacyContextLengthUpdate = Object.hasOwn(
          config,
          "contextLength",
        );
        const unset = {
          ...(config.provider === "openai-compatible" ? {} : { baseUrl: "" }),
          ...(clearingCredential ? { credentialEncrypted: "" } : {}),
          ...(legacyContextLengthUpdate &&
          Object.hasOwn(currentRecord ?? {}, "contextLengthSource")
            ? { contextLengthSource: "" }
            : {}),
        };
        /** @type {any} */
        const update = {
          $set: {
            provider: config.provider,
            ...(config.provider === "openai-compatible"
              ? { baseUrl: config.baseUrl }
              : {}),
            model: config.model,
            contextLength: resolvedConfig.contextLength,
            ...(legacyContextLengthUpdate
              ? {}
              : {
                  contextLengthSource: resolvedConfig.contextLengthSource,
                }),
          },
          $inc: { revision: 1 },
          ...(Object.keys(unset).length === 0 ? {} : { $unset: unset }),
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
