// @ts-check

import {
  AI_REVIEWER_CONNECTION_LIMIT,
  AiReviewerProviderConfig,
  newAiReviewerConnectionId,
} from "../models/AiReviewerProviderConfig.mjs";
import {
  parseAiReviewerConnection,
  parseAiReviewerConnectionUpdate,
} from "./AiReviewerProviderConfig.mjs";
import { createAiReviewerProviderCredentialManager } from "./AiReviewerProviderCredentialManager.mjs";

const MAX_PROVIDER_CONFIG_SAVE_RETRIES = 5;
// The single connection this module stored before connections became a list,
// together with the model and context length a connection no longer owns.
const LEGACY_CONNECTION_FIELDS = Object.freeze([
  "provider",
  "baseUrl",
  "model",
  "credentialEncrypted",
  "credentialUpdatedAt",
  "contextLength",
  "contextLengthSource",
]);

export { AI_REVIEWER_CONNECTION_LIMIT };

export class AiReviewerProviderConfigInputError extends TypeError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "AiReviewerProviderConfigInputError";
  }
}

export class AiReviewerConnectionLimitError extends AiReviewerProviderConfigInputError {
  constructor() {
    super("The AI provider connection limit has been reached.");
    this.name = "AiReviewerConnectionLimitError";
  }
}

export class AiReviewerConnectionNotFoundError extends Error {
  constructor() {
    super("The AI provider connection does not exist.");
    this.name = "AiReviewerConnectionNotFoundError";
  }
}

/**
 * Raised when a caller named no connection and the user keeps more than one.
 * Choosing between them here would be the silent decision this module stopped
 * making when the default connection was removed.
 */
export class AiReviewerConnectionAmbiguousError extends Error {
  constructor() {
    super("An AI provider connection must be selected.");
    this.name = "AiReviewerConnectionAmbiguousError";
  }
}

/**
 * Model listings are cached per destination, so a selected connection must not
 * be served another connection's cached list.
 *
 * @param {string} userId
 * @param {string | null} connectionId
 */
export function aiReviewerModelCacheKey(userId, connectionId) {
  return connectionId == null ? userId : `${userId}\u0000${connectionId}`;
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

/**
 * Take only the fields a connection still owns. A record written when a
 * connection also carried a model and a context length keeps its destination
 * and drops the rest, because a review now chooses the model itself.
 *
 * @param {any} value
 */
function coreConnectionInput(value) {
  return {
    provider: value?.provider,
    ...(value?.provider === "openai-compatible" || value?.provider === "ollama"
      ? { baseUrl: value?.baseUrl }
      : {}),
    ...(value?.label == null ? {} : { label: value.label }),
    ...(value?.contextLengthOverride == null
      ? {}
      : { contextLengthOverride: value.contextLengthOverride }),
  };
}

/**
 * A document written before connections became a list keeps its single
 * connection in top-level fields. Reusing the document id as that connection's
 * identifier keeps it stable for readers that arrive before the first write
 * persists the list, so no migration script is needed.
 *
 * @param {any} record
 * @returns {any[]}
 */
function connectionRecords(record) {
  if (Array.isArray(record?.connections)) {
    // A connection stored before the model moved to the run still carries
    // `model` and `contextLength`. Those paths no longer exist, and the schema
    // is `strict: "throw"`, so writing one back unchanged is rejected.
    return record.connections.map((connection) => ({
      _id: connection._id,
      ...coreConnectionInput(connection),
      ...(connection.credentialEncrypted == null
        ? {}
        : { credentialEncrypted: connection.credentialEncrypted }),
      ...(connection.credentialUpdatedAt == null
        ? {}
        : { credentialUpdatedAt: connection.credentialUpdatedAt }),
    }));
  }
  if (record?.provider == null) {
    return [];
  }
  return [
    {
      _id: record._id,
      ...coreConnectionInput(record),
      ...(record.credentialEncrypted == null
        ? {}
        : { credentialEncrypted: record.credentialEncrypted }),
      ...(record.credentialUpdatedAt == null
        ? {}
        : { credentialUpdatedAt: record.credentialUpdatedAt }),
    },
  ];
}

/**
 * @param {any} record
 * @param {string} connectionId
 */
function connectionIndex(record, connectionId) {
  return connectionRecords(record).findIndex(
    (connection) => String(connection._id) === connectionId,
  );
}

/**
 * @param {any} record
 * @param {string} connectionId
 */
function connectionRecord(record, connectionId) {
  const index = connectionIndex(record, connectionId);
  if (index < 0) {
    throw new AiReviewerConnectionNotFoundError();
  }
  return connectionRecords(record)[index];
}

/**
 * Describe every connection without decrypting anything: a listing reports
 * whether a credential is set, never the credential itself.
 *
 * @param {any} record
 */
function publicConnections(record) {
  return connectionRecords(record).map((connection) =>
    Object.freeze({
      id: String(connection._id),
      credentialSet:
        typeof connection.credentialEncrypted === "string" &&
        connection.credentialEncrypted.length > 0,
      ...parseAiReviewerConnection(coreConnectionInput(connection)),
      ...(connection.credentialUpdatedAt == null
        ? {}
        : { credentialUpdatedAt: connection.credentialUpdatedAt }),
    }),
  );
}

/**
 * @param {ReturnType<typeof parseAiReviewerConnection>} connection
 */
function credentialDestination(connection) {
  return connection.provider === "openai-compatible"
    ? Object.freeze({
        provider: connection.provider,
        baseUrl: connection.baseUrl,
      })
    : Object.freeze({ provider: connection.provider });
}

/**
 * @param {ReturnType<typeof parseAiReviewerConnection> | null} current
 * @param {ReturnType<typeof parseAiReviewerConnectionUpdate>} next
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
 * @param {ReturnType<typeof parseAiReviewerConnection>} destination
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
async function storedConnection(record, credentialManager) {
  const destination = parseAiReviewerConnection(coreConnectionInput(record));
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
  return Object.freeze({
    id: String(record._id),
    ...parseAiReviewerConnection({
      ...coreConnectionInput(record),
      ...(credential === undefined ? {} : { credential }),
      ...(record.credentialUpdatedAt == null
        ? {}
        : { credentialUpdatedAt: record.credentialUpdatedAt }),
    }),
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
 *   newConnectionId?: () => unknown,
 * }} [dependencies]
 */
export function createAiReviewerProviderConfigStore({
  model = AiReviewerProviderConfig,
  credentialManager = createAiReviewerProviderCredentialManager(),
  now = () => new Date(),
  newConnectionId = newAiReviewerConnectionId,
} = {}) {
  /**
   * Build the connection to store from its current state and a write. The
   * credential stays bound to its destination: a write that moves the
   * connection to another provider or base URL drops the stored credential
   * rather than re-binding it to somewhere the user never sent it.
   *
   * @param {any} currentConnection
   * @param {ReturnType<typeof parseAiReviewerConnectionUpdate>} config
   * @param {string | undefined} encryptedCredential
   */
  function nextConnection(currentConnection, config, encryptedCredential) {
    let current = null;
    try {
      current =
        currentConnection == null
          ? null
          : parseAiReviewerConnection(coreConnectionInput(currentConnection));
    } catch {
      current = null;
    }
    const credentialProvided = Object.hasOwn(config, "credential");
    const replacingCredential =
      credentialProvided && typeof config.credential === "string";
    const hasStoredCredential =
      typeof currentConnection?.credentialEncrypted === "string" &&
      currentConnection.credentialEncrypted.length > 0;
    const keepingCredential =
      !credentialProvided &&
      hasStoredCredential &&
      isSameCredentialDestination(current, config);
    if (
      config.provider !== "openai-compatible" &&
      !replacingCredential &&
      !keepingCredential
    ) {
      throw new AiReviewerProviderConfigInputError(
        "The AI provider credential is required.",
      );
    }
    return {
      _id: currentConnection?._id ?? newConnectionId(),
      provider: config.provider,
      ...(config.provider === "openai-compatible"
        ? { baseUrl: config.baseUrl }
        : {}),
      // Only a name the user typed is stored, so an unnamed connection keeps
      // following the endpoint it is derived from when that endpoint changes.
      ...(config.label == null ? {} : { label: config.label }),
      ...(config.contextLengthOverride == null
        ? {}
        : { contextLengthOverride: config.contextLengthOverride }),
      ...(replacingCredential
        ? {
            credentialEncrypted: encryptedCredential,
            credentialUpdatedAt: timestamp(now()),
          }
        : keepingCredential
          ? {
              credentialEncrypted: currentConnection.credentialEncrypted,
              credentialUpdatedAt: currentConnection.credentialUpdatedAt,
            }
          : hasStoredCredential
            ? { credentialUpdatedAt: timestamp(now()) }
            : {}),
    };
  }

  /**
   * @param {string} userId
   * @param {(record: any) => any} mutate
   */
  async function commit(userId, mutate) {
    for (
      let attempt = 0;
      attempt < MAX_PROVIDER_CONFIG_SAVE_RETRIES;
      attempt += 1
    ) {
      const currentRecord = await lean(model.findOne({ _id: userId }));
      const expectedRevision = storedRevision(currentRecord);
      const next = await mutate(currentRecord);
      // The first write after the list was introduced also removes the legacy
      // single-connection fields the list was migrated from.
      const unset = Object.fromEntries(
        LEGACY_CONNECTION_FIELDS.filter((field) =>
          Object.hasOwn(currentRecord ?? {}, field),
        ).map((field) => [field, ""]),
      );
      /** @type {any} */
      const update = {
        $set: { connections: next.connections },
        $inc: { revision: 1 },
        ...(Object.keys(unset).length === 0 ? {} : { $unset: unset }),
      };

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
          return next;
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
  }

  /**
   * @param {string} userId
   * @param {string | null} connectionId
   * @param {unknown} input
   */
  async function writeConnection(userId, connectionId, input) {
    const config = parseAiReviewerConnectionUpdate(input);
    // Encrypting before the compare-and-set keeps a credential-storage failure
    // from reaching the stored document at all, and keeps a retry from
    // re-encrypting the same value.
    const encryptedCredential =
      typeof config.credential === "string"
        ? await credentialManager.encrypt({
            provider: config.provider,
            ...(config.provider === "openai-compatible"
              ? { baseUrl: config.baseUrl }
              : {}),
            credential: config.credential,
          })
        : undefined;
    let writtenId = "";
    const written = await commit(userId, (currentRecord) => {
      const connections = connectionRecords(currentRecord);
      const index =
        connectionId == null
          ? -1
          : connectionIndex(currentRecord, connectionId);
      if (
        connectionId == null &&
        connections.length >= AI_REVIEWER_CONNECTION_LIMIT
      ) {
        throw new AiReviewerConnectionLimitError();
      }
      if (connectionId != null && index < 0) {
        throw new AiReviewerConnectionNotFoundError();
      }
      const connection = nextConnection(
        index < 0 ? null : connections[index],
        config,
        encryptedCredential,
      );
      writtenId = String(connection._id);
      return {
        connections:
          index < 0
            ? [...connections, connection]
            : connections.map((entry, position) =>
                position === index ? connection : entry,
              ),
      };
    });
    return publicConnections(written).find(
      (connection) => connection.id === writtenId,
    );
  }

  /**
   * Reading a connection only ever happens inside this user's own document, so
   * another user's identifier is absent rather than merely rejected.
   *
   * @param {string} userId
   * @param {string | null} [connectionId] the sole connection when omitted
   */
  async function readConnection(userId, connectionId = null) {
    const record = await lean(model.findOne({ _id: userId }));
    const connections = connectionRecords(record);
    if (connectionId != null) {
      return connectionRecord(record, connectionId);
    }
    if (connections.length > 1) {
      throw new AiReviewerConnectionAmbiguousError();
    }
    return connections[0] ?? null;
  }

  return {
    /**
     * @param {string} userId
     * @param {string | null} [connectionId] the sole connection when omitted
     */
    async get(userId, connectionId = null) {
      const connection = await readConnection(userId, connectionId);
      return connection == null
        ? null
        : await storedConnection(connection, credentialManager);
    },

    /**
     * Every connection with its credential, for a model listing that spans all
     * of them. Callers that answer a client use `list` instead.
     *
     * @param {string} userId
     */
    async getAll(userId) {
      const record = await lean(model.findOne({ _id: userId }));
      return await Promise.all(
        connectionRecords(record).map(
          async (connection) =>
            await storedConnection(connection, credentialManager),
        ),
      );
    },

    /** @param {string} userId */
    async list(userId) {
      return publicConnections(await lean(model.findOne({ _id: userId })));
    },

    /**
     * @param {string} userId
     * @param {unknown} input
     */
    async create(userId, input) {
      return await writeConnection(userId, null, input);
    },

    /**
     * @param {string} userId
     * @param {string} connectionId
     * @param {unknown} input
     */
    async update(userId, connectionId, input) {
      return await writeConnection(userId, connectionId, input);
    },

    /**
     * Removing a connection removes its encrypted credential with it.
     *
     * @param {string} userId
     * @param {string} connectionId
     */
    async remove(userId, connectionId) {
      return publicConnections(
        await commit(userId, (currentRecord) => {
          const index = connectionIndex(currentRecord, connectionId);
          if (index < 0) {
            throw new AiReviewerConnectionNotFoundError();
          }
          return {
            connections: connectionRecords(currentRecord).filter(
              (_, position) => position !== index,
            ),
          };
        }),
      );
    },

    /**
     * Remove the stored configuration and every encrypted credential it holds.
     * Deletion must not depend on the feature being enabled, so this runs from
     * the cleanup hooks rather than from a request path.
     *
     * @param {string} userId
     */
    async deleteUser(userId) {
      await model.deleteOne({ _id: userId }).exec();
    },
  };
}
