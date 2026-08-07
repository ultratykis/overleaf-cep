// @ts-check

import logger from "@overleaf/logger";

import { AgentGatewayAbortError, AgentGatewayError } from "./AgentGateway.mjs";
import {
  parseAiReviewerConnectionId,
  parseAiReviewerConnectionDeleteRequest,
  parseAiReviewerConnectionUpdate,
  parseAiReviewerConnectionUpdateRequest,
  publicAiReviewerProviderConnection,
} from "./AiReviewerProviderConfig.mjs";
import {
  AiReviewerConnectionAmbiguousError,
  AiReviewerConnectionConflictError,
  AiReviewerConnectionLimitError,
  AiReviewerConnectionNotFoundError,
  AiReviewerPlaintextCredentialError,
  AiReviewerProviderConfigInputError,
  aiReviewerModelCacheKey,
} from "./AiReviewerProviderConfigStore.mjs";

/** @import { Request, Response } from 'express' */

const ERRORS = Object.freeze({
  invalid: Object.freeze({
    code: "AI_PROVIDER_CONFIGURATION_INVALID",
    category: "configuration",
    message: "The AI provider configuration is invalid.",
    retryable: false,
  }),
  plaintextCredential: Object.freeze({
    code: "AI_PROVIDER_PLAINTEXT_CREDENTIAL_BLOCKED",
    category: "configuration",
    message:
      "API keys cannot be saved or sent to HTTP endpoints. Use HTTPS or recreate the connection without a key.",
    retryable: false,
  }),
  missing: Object.freeze({
    code: "AI_PROVIDER_NOT_CONFIGURED",
    category: "configuration",
    message: "No AI provider is configured.",
    retryable: false,
  }),
  connectionMissing: Object.freeze({
    code: "AI_PROVIDER_CONNECTION_NOT_FOUND",
    category: "configuration",
    message: "The selected AI provider connection does not exist.",
    retryable: false,
  }),
  connectionRequired: Object.freeze({
    code: "AI_PROVIDER_CONNECTION_NOT_SELECTED",
    category: "configuration",
    message: "An AI provider connection must be selected.",
    retryable: false,
  }),
  connectionLimit: Object.freeze({
    code: "AI_PROVIDER_CONNECTION_LIMIT_REACHED",
    category: "configuration",
    message: "No more AI provider connections can be added.",
    retryable: false,
  }),
  connectionConflict: Object.freeze({
    code: "AI_PROVIDER_CONNECTION_CONFLICT",
    category: "configuration",
    message:
      "The AI provider connection changed elsewhere. Your change was not applied. Reload the settings and try again.",
    retryable: false,
  }),
  unsupported: Object.freeze({
    code: "AI_PROVIDER_MODEL_DISCOVERY_UNSUPPORTED",
    category: "configuration",
    message: "The AI provider does not expose a supported model list.",
    retryable: false,
  }),
  persistence: Object.freeze({
    code: "AI_PROVIDER_CONFIGURATION_PERSISTENCE_FAILED",
    category: "configuration",
    message:
      "AI Reviewer could not save the provider configuration on this server. Ask the server administrator to check AI Reviewer storage and permissions, then try again.",
    retryable: false,
  }),
  circuitOpen: Object.freeze({
    code: "AI_PROVIDER_CIRCUIT_OPEN",
    category: "configuration",
    message:
      "This AI provider connection was stopped after repeated failures. Enable the connection before trying again, or correct its endpoint or credentials and save it to enable it automatically.",
    retryable: false,
  }),
  cooldown: Object.freeze({
    code: "AI_PROVIDER_COOLDOWN",
    category: "rate-limit",
    message:
      "This AI provider connection is cooling down after a failure. Wait a few seconds before trying again.",
    retryable: true,
  }),
  timeout: Object.freeze({
    code: "AI_REQUEST_TIMEOUT",
    category: "timeout",
    message: "The AI reviewer request timed out.",
    retryable: true,
  }),
  aborted: Object.freeze({
    code: "AI_REQUEST_ABORTED",
    category: "aborted",
    message: "The AI reviewer request was cancelled.",
    retryable: false,
  }),
  authentication: Object.freeze({
    code: "AI_PROVIDER_AUTHENTICATION_ERROR",
    category: "authentication",
    message: "The AI provider rejected its credentials.",
    retryable: false,
  }),
  network: Object.freeze({
    code: "AI_PROVIDER_NETWORK_FAILED",
    category: "network",
    message: "The AI provider could not be reached.",
    retryable: true,
  }),
  "rate-limit": Object.freeze({
    code: "AI_PROVIDER_RATE_LIMITED",
    category: "rate-limit",
    message: "The AI provider rate limit was reached.",
    retryable: true,
  }),
  schema: Object.freeze({
    code: "AI_PROVIDER_SCHEMA_INVALID",
    category: "schema",
    message: "The AI provider returned invalid data.",
    retryable: false,
  }),
  provider: Object.freeze({
    code: "AI_PROVIDER_ERROR",
    category: "provider",
    message: "The AI provider request failed.",
    retryable: true,
  }),
});

/** @param {Request} request */
function userId(request) {
  const value = /** @type {any} */ (request.user)?._id?.toString?.();
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("authenticated user required");
  }
  return value;
}

/**
 * The selected connection travels in the route, the query or the body
 * depending on the request shape. Omitting it means the sole connection.
 *
 * @param {Request} request
 */
function selectedConnectionId(request) {
  const value =
    /** @type {any} */ (request.params)?.connection_id ??
    /** @type {any} */ (request.query)?.connectionId ??
    /** @type {any} */ (request.body)?.connectionId;
  return value == null ? null : parseAiReviewerConnectionId(value);
}

/** @param {unknown} value */
function parseModelRefresh(value) {
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new TypeError("refresh must be 'true' or 'false'.");
}

/**
 * @param {Response} response
 * @param {number} status
 * @param {keyof typeof ERRORS} kind
 */
function sendError(response, status, kind) {
  const error = ERRORS[kind];
  return response.status(status).json({
    error: {
      code: error.code,
      category: error.category,
      message: error.message,
      retryable: error.retryable,
    },
  });
}

/** @param {unknown} error */
function providerFailureKind(error) {
  if (error instanceof AgentGatewayError) {
    switch (error.category) {
      case "authentication":
      case "network":
      case "rate-limit":
      case "schema":
      case "provider":
        return error.category;
    }
  }
  return /** @type {const} */ ("provider");
}

/** @param {unknown} error */
function modelFailureKind(error) {
  if (
    error instanceof AgentGatewayError &&
    error.code === ERRORS.circuitOpen.code
  ) {
    return /** @type {const} */ ("circuitOpen");
  }
  if (
    error instanceof AgentGatewayError &&
    error.code === ERRORS.cooldown.code
  ) {
    return /** @type {const} */ ("cooldown");
  }
  if (
    error instanceof AgentGatewayError &&
    error.code === ERRORS.plaintextCredential.code
  ) {
    return /** @type {const} */ ("plaintextCredential");
  }
  if (
    error instanceof AgentGatewayError &&
    error.code === ERRORS.unsupported.code
  ) {
    return /** @type {const} */ ("unsupported");
  }
  return providerFailureKind(error);
}

/** @param {() => number} elapsedNow */
function readElapsedNow(elapsedNow) {
  try {
    const value = elapsedNow();
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * @param {number} startedAt
 * @param {() => number} elapsedNow
 */
function elapsedMilliseconds(startedAt, elapsedNow) {
  return Math.max(0, Math.round(readElapsedNow(elapsedNow) - startedAt));
}

/** @param {any} dependencies */
export function createAiReviewerProviderController(dependencies) {
  const {
    configStore,
    providerService,
    workspaceStore,
    circuitBreakerStore = null,
    failureRecorder = () => {},
    elapsedNow = () => performance.now(),
    externalHarnessEnabled = false,
  } = dependencies;
  const timeoutSignalFactory =
    dependencies.timeoutSignalFactory ?? (() => AbortSignal.timeout(30_000));
  const modelTimeoutSignalFactory =
    dependencies.modelTimeoutSignalFactory ??
    (() => AbortSignal.timeout(10_000));

  /**
   * @param {string | null} provider
   * @param {number} startedAt
   */
  function recordPersistenceFailure(provider, startedAt) {
    try {
      failureRecorder({
        requestId: null,
        provider,
        model: null,
        scopeKind: "none",
        failureCategory: ERRORS.persistence.category,
        failureCode: ERRORS.persistence.code,
        providerStatusCode: null,
        providerErrorType: null,
        elapsedMs: elapsedMilliseconds(startedAt, elapsedNow),
      });
    } catch {
      // Logging cannot replace the bounded public failure response.
    }
  }

  /**
   * @param {Response} response
   * @param {any[]} connections
   */
  async function sendConnections(response, authenticatedUserId, connections) {
    let projectUseCounts = null;
    try {
      projectUseCounts =
        (await workspaceStore?.countProjectsSelectingConnections?.(
          authenticatedUserId,
          connections.map((connection) => connection.id),
        )) ?? null;
    } catch (error) {
      logger.warn(
        { err: error },
        "AI reviewer connection project counts could not be read",
      );
    }
    return response.json({
      connections: connections.map((connection) => ({
        ...publicAiReviewerProviderConnection(connection),
        ...(projectUseCounts == null
          ? {}
          : { projectUseCount: projectUseCounts[connection.id] ?? 0 }),
      })),
    });
  }

  /**
   * @param {Request} request
   * @param {Response} response
   */
  async function listConnections(request, response) {
    try {
      const authenticatedUserId = userId(request);
      return await sendConnections(
        response,
        authenticatedUserId,
        await configStore.list(authenticatedUserId),
      );
    } catch {
      return sendError(response, 400, "invalid");
    }
  }

  /**
   * @param {Request} request
   * @param {Response} response
   * @param {boolean} create
   */
  async function writeConnection(request, response, create) {
    let config;
    let connectionId = null;
    let expectedRevision = null;
    try {
      if (create) {
        config = parseAiReviewerConnectionUpdate(request.body);
      } else {
        const update = parseAiReviewerConnectionUpdateRequest(request.body);
        config = update.config;
        expectedRevision = update.expectedRevision;
        connectionId = parseAiReviewerConnectionId(
          selectedConnectionId(request),
        );
      }
    } catch {
      return sendError(response, 400, "invalid");
    }

    const startedAt = readElapsedNow(elapsedNow);
    try {
      let saved;
      let destinationChanged = false;
      if (create) {
        saved = await configStore.create(userId(request), config);
      } else {
        const update = await configStore.updateWithDestinationChange(
          userId(request),
          connectionId,
          config,
          expectedRevision,
        );
        saved = update.connection;
        destinationChanged = update.destinationChanged;
      }
      if (destinationChanged) {
        try {
          await circuitBreakerStore?.reset(saved.id);
        } catch (error) {
          // Saving already committed the new revision. Circuit cleanup is
          // recoverable through the explicit reset route and must not make the
          // client retain the previous revision.
          logger.warn(
            { err: error },
            "AI reviewer saved connection circuit reset failed",
          );
        }
      }
      return response.json(publicAiReviewerProviderConnection(saved));
    } catch (error) {
      if (error instanceof AiReviewerConnectionNotFoundError) {
        return sendError(response, 404, "connectionMissing");
      }
      if (error instanceof AiReviewerConnectionLimitError) {
        return sendError(response, 409, "connectionLimit");
      }
      if (error instanceof AiReviewerConnectionConflictError) {
        return sendError(response, 409, "connectionConflict");
      }
      if (error instanceof AiReviewerPlaintextCredentialError) {
        return sendError(response, 400, "plaintextCredential");
      }
      if (error instanceof AiReviewerProviderConfigInputError) {
        return sendError(response, 400, "invalid");
      }
      // An unclassified write failure is a defect in this module, not a
      // provider fault. The public response stays bounded, but the cause has
      // to reach the log or it cannot be diagnosed.
      logger.error(
        { err: error, provider: config.provider },
        "AI reviewer connection write failed",
      );
      recordPersistenceFailure(config.provider, startedAt);
      return sendError(response, 500, "persistence");
    }
  }

  /**
   * @param {Request} request
   * @param {Response} response
   */
  async function deleteConnection(request, response) {
    let connectionId;
    let expectedRevision;
    try {
      connectionId = parseAiReviewerConnectionId(selectedConnectionId(request));
      expectedRevision = parseAiReviewerConnectionDeleteRequest(
        request.body,
      ).expectedRevision;
    } catch {
      return sendError(response, 400, "invalid");
    }

    const startedAt = readElapsedNow(elapsedNow);
    try {
      const authenticatedUserId = userId(request);
      const connections = await configStore.remove(
        authenticatedUserId,
        connectionId,
        expectedRevision,
      );
      try {
        await circuitBreakerStore?.reset(connectionId);
      } catch (error) {
        // The connection is already gone and its server-issued id is never
        // reused, so stale guard cleanup must not turn deletion into a retry.
        logger.warn(
          { err: error },
          "AI reviewer deleted connection circuit cleanup failed",
        );
      }
      return await sendConnections(
        response,
        authenticatedUserId,
        connections,
      );
    } catch (error) {
      if (error instanceof AiReviewerConnectionNotFoundError) {
        return sendError(response, 404, "connectionMissing");
      }
      if (error instanceof AiReviewerConnectionConflictError) {
        return sendError(response, 409, "connectionConflict");
      }
      recordPersistenceFailure(null, startedAt);
      return sendError(response, 500, "persistence");
    }
  }

  /**
   * Load the connection a single-connection route names, mapping the store's
   * typed absences onto their bounded public responses.
   *
   * @param {Request} request
   * @param {Response} response
   */
  async function loadSelectedConnection(request, response) {
    try {
      const connection = await configStore.get(
        userId(request),
        selectedConnectionId(request),
      );
      if (connection != null) {
        return connection;
      }
      sendError(response, 409, "missing");
    } catch (error) {
      if (error instanceof AiReviewerConnectionNotFoundError) {
        sendError(response, 404, "connectionMissing");
      } else if (error instanceof AiReviewerConnectionAmbiguousError) {
        sendError(response, 400, "connectionRequired");
      } else {
        sendError(response, 409, "invalid");
      }
    }
    return null;
  }

  /**
   * @param {any} connection
   * @param {unknown} error
   * @param {number} startedAt
   */
  function recordModelFailure(connection, error, startedAt) {
    const publicError = ERRORS[modelFailureKind(error)];
    try {
      failureRecorder({
        requestId: null,
        provider: connection.provider,
        model: null,
        scopeKind: "none",
        failureCategory: publicError.category,
        failureCode: publicError.code,
        providerStatusCode:
          error instanceof AgentGatewayError ? error.providerStatusCode : null,
        providerErrorType:
          error instanceof AgentGatewayError ? error.providerErrorType : null,
        elapsedMs: elapsedMilliseconds(startedAt, elapsedNow),
      });
    } catch {
      // Logging cannot replace the bounded public failure response.
    }
    return publicError;
  }

  /**
   * List every model the user can reach, across all of their connections. One
   * unreachable connection must not hide the models of the others, so each
   * failure is reported as a classification beside the models that did arrive.
   *
   * @param {Request} request
   * @param {Response} response
   */
  async function listModels(request, response) {
    let connections;
    let authenticatedUserId;
    let bypassNegativeCache;
    try {
      bypassNegativeCache = parseModelRefresh(
        /** @type {any} */ (request.query)?.refresh,
      );
    } catch {
      return sendError(response, 400, "invalid");
    }
    try {
      authenticatedUserId = userId(request);
      connections = await configStore.getAll(authenticatedUserId);
    } catch {
      return sendError(response, 409, "invalid");
    }
    if (connections.length === 0) {
      return sendError(response, 409, "missing");
    }
    if (externalHarnessEnabled) {
      return response.json({
        models: connections.flatMap((/** @type {any} */ connection) =>
          (connection.models ?? []).map(
            (/** @type {string} */ id) => ({
              id,
              displayName: id,
              connectionId: connection.id,
              connectionLabel: connection.label,
              contextLength: connection.contextLengthOverride ?? null,
              contextLengthSource:
                connection.contextLengthOverride == null
                  ? "unavailable"
                  : "override",
            }),
          ),
        ),
        failures: [],
      });
    }

    const startedAt = readElapsedNow(elapsedNow);
    const disconnected = new AbortController();
    const timeout = modelTimeoutSignalFactory();
    const signal = AbortSignal.any([disconnected.signal, timeout]);
    const onAborted = () => disconnected.abort(new AgentGatewayAbortError());
    request.once?.("aborted", onAborted);
    try {
      if (timeout.aborted) {
        throw timeout.reason;
      }
      const models = [];
      const failures = [];
      const listings = await Promise.all(
        connections.map(async (/** @type {any} */ connection) => {
          try {
            if (connection.credentialLoadFailed === true) {
              return { connection, credentialLoadFailed: true };
            }
            await circuitBreakerStore?.assertRequestAllowed(connection.id);
            const cacheKey = aiReviewerModelCacheKey(
              authenticatedUserId,
              connection.id,
            );
            let listedModels;
            try {
              listedModels = await providerService.listModels(connection, {
                signal,
                cacheKey,
                ...(bypassNegativeCache
                  ? { bypassNegativeCache: true }
                  : {}),
              });
            } catch (error) {
              if (
                error instanceof AgentGatewayError &&
                error.code === ERRORS.unsupported.code &&
                (connection.models?.length ?? 0) > 0
              ) {
                // These remain explicit candidates. The run controller already
                // validates the bounded id and accepts it only for unsupported
                // discovery; no model is selected on the connection's behalf.
                listedModels = connection.models.map((id) => ({
                  id,
                  displayName: id,
                }));
              } else {
                throw error;
              }
            }
            return {
              connection,
              // Opening the picker must not send credentials to one metadata
              // request per model. Keep the useful value/source display from
              // non-network policy and selected-model cache entries only.
              models: listedModels.map((/** @type {any} */ model) => ({
                ...model,
                ...providerService.contextLengthForModelList(
                  connection,
                  model.id,
                  { cacheKey },
                ),
              })),
            };
          } catch (error) {
            return { connection, error };
          }
        }),
      );
      if (timeout.aborted) {
        return sendError(response, 504, "timeout");
      }
      if (disconnected.signal.aborted) {
        return sendError(response, 499, "aborted");
      }
      for (const listing of listings) {
        if (listing.credentialLoadFailed === true) {
          failures.push({
            connectionId: listing.connection.id,
            connectionLabel: listing.connection.label,
            code: ERRORS.persistence.code,
            category: ERRORS.persistence.category,
          });
          continue;
        }
        if (listing.error !== undefined) {
          const publicError = recordModelFailure(
            listing.connection,
            listing.error,
            startedAt,
          );
          failures.push({
            connectionId: listing.connection.id,
            connectionLabel: listing.connection.label,
            code: publicError.code,
            category: publicError.category,
          });
          continue;
        }
        for (const model of listing.models) {
          models.push({
            id: model.id,
            displayName: model.displayName,
            connectionId: listing.connection.id,
            connectionLabel: listing.connection.label,
            contextLength: model.contextLength,
            contextLengthSource: model.contextLengthSource,
          });
        }
      }
      return response.json({ models, failures });
    } catch (error) {
      if (timeout.aborted) {
        return sendError(response, 504, "timeout");
      }
      if (
        disconnected.signal.aborted ||
        error instanceof AgentGatewayAbortError
      ) {
        return sendError(response, 499, "aborted");
      }
      return sendError(response, 502, "provider");
    } finally {
      request.removeListener?.("aborted", onAborted);
    }
  }

  /**
   * Check one connection. A connection carries no model, so the only thing
   * this can honestly report is that the endpoint answered and accepted the
   * stored credential.
   *
   * @param {Request} request
   * @param {Response} response
   */
  async function testConnection(request, response) {
    const connection = await loadSelectedConnection(request, response);
    if (connection == null) {
      return response;
    }

    const disconnected = new AbortController();
    const timeout = timeoutSignalFactory();
    const signal = AbortSignal.any([disconnected.signal, timeout]);
    const onAborted = () => disconnected.abort(new AgentGatewayAbortError());
    request.once?.("aborted", onAborted);
    try {
      if (timeout.aborted) {
        throw timeout.reason;
      }
      await circuitBreakerStore?.assertRequestAllowed(connection.id);
      return response.json(
        await providerService.testConnection(connection, {
          signal,
          cacheKey: aiReviewerModelCacheKey(
            userId(request),
            connection.id ?? null,
          ),
        }),
      );
    } catch (error) {
      if (timeout.aborted) {
        return sendError(response, 504, "timeout");
      }
      if (
        disconnected.signal.aborted ||
        error instanceof AgentGatewayAbortError ||
        /** @type {any} */ (error)?.category === "aborted"
      ) {
        return sendError(response, 499, "aborted");
      }
      const kind = modelFailureKind(error);
      return sendError(
        response,
        kind === "circuitOpen"
          ? 409
          : kind === "cooldown"
            ? 429
            : kind === "unsupported"
              ? 501
              : kind === "plaintextCredential"
                ? 409
                : 502,
        kind,
      );
    } finally {
      request.removeListener?.("aborted", onAborted);
    }
  }

  /**
   * Explicit recovery is authenticated and ownership-checked exactly like a
   * connection test. It never contacts the provider.
   *
   * @param {Request} request
   * @param {Response} response
   */
  async function resetCircuit(request, response) {
    const connection = await loadSelectedConnection(request, response);
    if (connection == null) {
      return response;
    }
    try {
      await circuitBreakerStore?.reset(connection.id);
      return response.json({ ok: true });
    } catch (error) {
      logger.error(
        { err: error },
        "AI reviewer connection circuit reset failed",
      );
      return sendError(response, 500, "persistence");
    }
  }

  return {
    listModels,
    testConnection,
    listConnections,
    /** @type {(request: Request, response: Response) => Promise<unknown>} */
    createConnection: (request, response) =>
      writeConnection(request, response, true),
    updateConnection: (request, response) =>
      writeConnection(request, response, false),
    deleteConnection,
    resetCircuit,
  };
}
