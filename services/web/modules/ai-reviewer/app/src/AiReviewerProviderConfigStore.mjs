// @ts-check

import {
  AI_REVIEWER_CONNECTION_LIMIT,
  AiReviewerProviderConfig,
  newAiReviewerConnectionId,
} from "../models/AiReviewerProviderConfig.mjs";
import { isPlaintextAiProviderBaseUrl } from "../../shared/provider-request-url.mjs";
import {
  parseAiReviewerConnection,
  parseAiReviewerConnectionRevision,
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

export class AiReviewerPlaintextCredentialError extends AiReviewerProviderConfigInputError {
  constructor() {
    super(
      "API keys cannot be saved for HTTP endpoints. Use HTTPS or recreate the connection without a key.",
    );
    this.name = "AiReviewerPlaintextCredentialError";
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

export class AiReviewerConnectionConflictError extends Error {
  constructor() {
    super("The AI provider connection changed elsewhere.");
    this.name = "AiReviewerConnectionConflictError";
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

/** @param {any} connection */
function storedConnectionRevision(connection) {
  return parseAiReviewerConnectionRevision(connection?.revision ?? 0);
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
      : value?.provider === "azure"
        ? {
            baseUrl: value?.baseUrl,
            ...(value != null && Object.hasOwn(value, "requestStyle")
              ? { requestStyle: value.requestStyle }
              : {}),
            ...(value != null && Object.hasOwn(value, "apiVersion")
              ? { apiVersion: value.apiVersion }
              : {}),
            deployments: value?.deployments,
            ...(value?.contextLengthOverrides == null
              ? {}
              : { contextLengthOverrides: value.contextLengthOverrides }),
          }
        : {}),
    ...(value?.provider !== "azure" &&
    value?.provider != null &&
    value?.models != null
      ? { models: value?.models }
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
    return record.connections.map((/** @type {any} */ connection) => ({
      _id: connection._id,
      revision: storedConnectionRevision(connection),
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
      revision: 0,
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
  const connections = [];
  for (const connection of connectionRecords(record)) {
    try {
      connections.push(
        Object.freeze({
          id: String(connection._id),
          revision: storedConnectionRevision(connection),
          credentialSet:
            typeof connection.credentialEncrypted === "string" &&
            connection.credentialEncrypted.length > 0,
          ...parseAiReviewerConnection(coreConnectionInput(connection)),
          ...(connection.credentialUpdatedAt == null
            ? {}
            : { credentialUpdatedAt: connection.credentialUpdatedAt }),
        }),
      );
    } catch {
      // One unreadable legacy entry must not hide independent connections.
    }
  }
  return connections;
}

/**
 * @param {ReturnType<typeof parseAiReviewerConnection>} connection
 */
function credentialDestination(connection) {
  return connection.provider === "openai-compatible" ||
    connection.provider === "azure"
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
    (next.provider !== "openai-compatible" && next.provider !== "azure") ||
    (current.provider === "openai-compatible" &&
      next.provider === "openai-compatible" &&
      current.baseUrl === next.baseUrl) ||
    (current.provider === "azure" &&
      next.provider === "azure" &&
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
 * HTTP versus HTTPS decides whether a credential would cross the network in
 * plaintext. Host classification is intentionally irrelevant: localhost can
 * have TLS, while an allowed local HTTP endpoint does not.
 *
 * @param {ReturnType<typeof parseAiReviewerConnectionUpdate>} config
 * @param {boolean} credentialPresent
 */
function assertCredentialStorageAllowed(config, credentialPresent) {
  if (
    "baseUrl" in config &&
    credentialPresent &&
    isPlaintextAiProviderBaseUrl(config.baseUrl)
  ) {
    throw new AiReviewerPlaintextCredentialError();
  }
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
   * A connection is a destination: provider plus endpoint. Projects reference
   * that destination by id, so changing its provider in place would silently
   * redirect every project that selected it.
   *
   * @param {any} currentConnection
   * @param {ReturnType<typeof parseAiReviewerConnectionUpdate>} config
   */
  function assertProviderUnchanged(currentConnection, config) {
    const current = parseAiReviewerConnection(
      coreConnectionInput(currentConnection),
    );
    if (current.provider !== config.provider) {
      throw new AiReviewerProviderConfigInputError(
        "The provider of an existing AI provider connection cannot be changed.",
      );
    }
  }

  /**
   * The parent record can move because another connection changed. That is
   * safe to retry. A changed revision on this connection means the replacement
   * was prepared from stale state and must be refused.
   *
   * @param {any} currentConnection
   * @param {number} expectedRevision
   */
  function assertConnectionUnchanged(currentConnection, expectedRevision) {
    if (storedConnectionRevision(currentConnection) !== expectedRevision) {
      throw new AiReviewerConnectionConflictError();
    }
  }

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
    // Do not silently delete a pre-existing plaintext-bound credential during
    // an unrelated edit. Refuse the write until the destination is made HTTPS
    // or the connection is explicitly recreated without the credential.
    assertCredentialStorageAllowed(
      config,
      replacingCredential || keepingCredential,
    );
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
      revision:
        currentConnection == null
          ? 1
          : storedConnectionRevision(currentConnection) + 1,
      provider: config.provider,
      ...(config.provider === "openai-compatible" || config.provider === "azure"
        ? {
            baseUrl: config.baseUrl,
            ...(config.provider === "azure"
              ? {
                  requestStyle: config.requestStyle,
                  ...(config.apiVersion == null
                    ? {}
                    : { apiVersion: config.apiVersion }),
                  deployments: config.deployments,
                }
              : {}),
          }
        : {}),
      ...(config.provider === "azure" || config.models == null
        ? {}
        : { models: config.models }),
      // Only a name the user typed is stored, so an unnamed connection keeps
      // following the endpoint it is derived from when that endpoint changes.
      ...(config.label == null ? {} : { label: config.label }),
      ...(config.contextLengthOverride == null
        ? {}
        : { contextLengthOverride: config.contextLengthOverride }),
      ...(config.contextLengthOverrides == null
        ? {}
        : { contextLengthOverrides: config.contextLengthOverrides }),
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
   * @param {unknown} expectedRevisionInput
   */
  async function writeConnection(
    userId,
    connectionId,
    input,
    expectedRevisionInput,
  ) {
    const config = parseAiReviewerConnectionUpdate(input);
    // Reject a newly supplied plaintext-bound credential before encryption so
    // a failed write has no credential-storage side effect.
    assertCredentialStorageAllowed(
      config,
      typeof config.credential === "string",
    );
    const expectedRevision =
      connectionId == null
        ? null
        : parseAiReviewerConnectionRevision(expectedRevisionInput);
    if (connectionId != null) {
      const currentRecord = await lean(model.findOne({ _id: userId }));
      const currentConnection = connectionRecord(currentRecord, connectionId);
      assertConnectionUnchanged(
        currentConnection,
        /** @type {number} */ (expectedRevision),
      );
      assertProviderUnchanged(currentConnection, config);
    }
    // Encrypting before the compare-and-set keeps a credential-storage failure
    // from reaching the stored document at all, and keeps a retry from
    // re-encrypting the same value.
    const encryptedCredential =
      typeof config.credential === "string"
        ? await credentialManager.encrypt({
            provider: config.provider,
            ...(config.provider === "openai-compatible" ||
            config.provider === "azure"
              ? {
                  baseUrl: config.baseUrl,
                }
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
      if (connectionId != null) {
        assertConnectionUnchanged(
          connections[index],
          /** @type {number} */ (expectedRevision),
        );
        assertProviderUnchanged(connections[index], config);
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
      const records = connectionRecords(record);
      // Credentials have independent envelopes. Settling them independently
      // preserves usable destinations while marking only the unreadable one.
      const settled = await Promise.allSettled(
        records.map(
          async (connection) =>
            await storedConnection(connection, credentialManager),
        ),
      );
      return settled.flatMap((result, index) => {
        if (result.status === "fulfilled") return [result.value];
        try {
          const connection = parseAiReviewerConnection(
            coreConnectionInput(records[index]),
          );
          return [
            Object.freeze({
              id: String(records[index]._id),
              ...connection,
              credentialLoadFailed: true,
            }),
          ];
        } catch {
          return [];
        }
      });
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
      return await writeConnection(userId, null, input, null);
    },

    /**
     * @param {string} userId
     * @param {string} connectionId
     * @param {unknown} input
     * @param {unknown} expectedRevision
     */
    async update(userId, connectionId, input, expectedRevision) {
      return await writeConnection(
        userId,
        connectionId,
        input,
        expectedRevision,
      );
    },

    /**
     * Removing a connection removes its encrypted credential with it.
     *
     * @param {string} userId
     * @param {string} connectionId
     * @param {unknown} expectedRevisionInput
     */
    async remove(userId, connectionId, expectedRevisionInput) {
      const expectedRevision = parseAiReviewerConnectionRevision(
        expectedRevisionInput,
      );
      return publicConnections(
        await commit(userId, (currentRecord) => {
          const index = connectionIndex(currentRecord, connectionId);
          if (index < 0) {
            throw new AiReviewerConnectionNotFoundError();
          }
          assertConnectionUnchanged(
            connectionRecords(currentRecord)[index],
            expectedRevision,
          );
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
