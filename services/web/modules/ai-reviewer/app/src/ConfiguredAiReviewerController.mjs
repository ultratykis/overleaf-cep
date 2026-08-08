// @ts-check

import { createHash } from "node:crypto";

import { expressify } from "@overleaf/promise-utils";
import Settings from "@overleaf/settings";

import ProjectEntityHandler from "../../../../app/src/Features/Project/ProjectEntityHandler.mjs";
import ZoteroApiClient from "../../../zotero/app/src/ZoteroApiClient.mjs";
import { createAiReviewerProviderCircuitBreakerStore } from "../models/AiReviewerProviderCircuitBreaker.mjs";
import { AgentGatewayAbortError, AgentGatewayError } from "./AgentGateway.mjs";
import { createAiReviewerCommentProvenanceController } from "./AiReviewerCommentProvenanceController.mjs";
import { createAiReviewerCommentProvenanceStore } from "./AiReviewerCommentProvenanceStore.mjs";
import { createAiReviewerController } from "./AiReviewerController.mjs";
import { recordAiReviewerFailure } from "./AiReviewerFailureLogger.mjs";
import { createAiReviewerModeInstructionController } from "./AiReviewerModeInstructionController.mjs";
import { createAiReviewerModeInstructionStore } from "./AiReviewerModeInstructionStore.mjs";
import {
  AiReviewerConnectionNotFoundError,
  aiReviewerModelCacheKey,
  createAiReviewerProviderConfigStore,
} from "./AiReviewerProviderConfigStore.mjs";
import { parseAiReviewerProviderCredential } from "./AiReviewerProviderConfig.mjs";
import { createAiReviewerProviderController } from "./AiReviewerProviderController.mjs";
import { createAiReviewerSkillController } from "./AiReviewerSkillController.mjs";
import { createAiReviewerSkillGitImporter } from "./AiReviewerSkillGitImporter.mjs";
import { createAiReviewerSkillStore } from "./AiReviewerSkillStore.mjs";
import { createAiReviewerWorkspaceController } from "./AiReviewerWorkspaceController.mjs";
import { createAiReviewerWorkspaceStore } from "./AiReviewerWorkspaceStore.mjs";
import { createExternalAgentCheckpoint } from "./ExternalAgentCheckpoint.mjs";
import { createExternalAgentGateway } from "./ExternalAgentGateway.mjs";
import { ExternalAgentRunnerClient } from "./ExternalAgentRunnerService.mjs";
import { createExternalAgentSessionController } from "./ExternalAgentSessionController.mjs";
import {
  AiReviewerExternalAgentSessionConflictError,
  AiReviewerExternalAgentSessionNotFoundError,
  AiReviewerExternalAgentSessionValidationError,
  createExternalAgentSessionStore,
} from "./ExternalAgentSessionStore.mjs";
import { MODEL_CONTEXT_UNKNOWN_ERROR_MESSAGE } from "./ModelContextLength.mjs";
import { createAiReviewerProviderService } from "./OllamaProviderService.mjs";
import {
  assertOpenAiCompatibleCredentialTransport,
  parseOpenAiCompatibleBaseUrl,
  parseOpenAiCompatibleModelId,
} from "./OllamaEndpointPolicy.mjs";
import { PROJECT_SNAPSHOT_DOCUMENT_LIMIT } from "./ProjectSnapshot.mjs";
import {
  authenticatedUserId,
  createRequestScopeReader,
} from "./RequestScopeReader.mjs";

/** @type {((context: any) => any) | null} */
let testGatewayFactory = null;

/**
 * @param {(context: any) => any} gatewayFactory
 * @returns {() => void}
 */
export function setAiReviewerGatewayFactoryForTests(gatewayFactory) {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("The AI reviewer test gateway requires NODE_ENV=test.");
  }
  if (typeof gatewayFactory !== "function") {
    throw new TypeError("gatewayFactory must be a function.");
  }
  if (testGatewayFactory != null) {
    throw new Error("An AI reviewer test gateway is already installed.");
  }

  testGatewayFactory = gatewayFactory;
  return () => {
    if (testGatewayFactory === gatewayFactory) {
      testGatewayFactory = null;
    }
  };
}

/**
 * @param {any} gateway
 * @param {any} scope
 * @param {{ contextLength: unknown, contextLengthSource: unknown }} context
 */
function enforceProjectReviewCoverage(gateway, scope, context) {
  const reviewCoverage = scope.readProjectFile?.reviewCoverage;
  if (scope.kind !== "project" || typeof reviewCoverage !== "function") {
    return gateway;
  }
  return {
    async *stream(request, options) {
      for await (const event of gateway.stream(request, options)) {
        if (event.type !== "completed") {
          yield event;
          continue;
        }
        const coverage = reviewCoverage();
        if (coverage.successfulReadCount === 0) {
          if (coverage.modelInputBudgetFailureCount > 0) {
            // A model may recover from a rejected read and still complete. The
            // coverage guard retains the actual budget cause in that path.
            throw new AgentGatewayError(
              "The request does not fit the selected model context.",
              {
                code: "AI_MODEL_CONTEXT_TOO_SMALL",
                category: "configuration",
                retryable: false,
                contextLength: context.contextLength,
                contextLengthSource: context.contextLengthSource,
              },
            );
          }
          throw new AgentGatewayError(
            "The review could not read any manuscript content. Use a model with a larger context length or narrow the scope.",
            {
              code: "AI_PROJECT_CONTENT_NOT_AVAILABLE",
              category: "configuration",
              retryable: false,
            },
          );
        }
        const contextTruncated =
          (coverage.fileExclusionCount ?? 0) > 0 ||
          coverage.relationshipsTruncated ||
          coverage.modelInputBudgetFailureCount > 0;
        yield contextTruncated ? { ...event, contextTruncated: true } : event;
        return;
      }
    },
  };
}

function invalidRunModel() {
  return new AgentGatewayError("The requested AI model is unavailable.", {
    code: "AI_PROVIDER_CONFIGURATION_INVALID",
    category: "configuration",
    retryable: false,
  });
}

function modelSelectionRequired() {
  return new AgentGatewayError("This review did not select an AI model.", {
    code: "AI_PROVIDER_MODEL_NOT_SELECTED",
    category: "configuration",
    retryable: false,
  });
}

function selectedConnectionMissing() {
  return new AgentGatewayError(
    "The selected AI provider connection does not exist.",
    {
      code: "AI_PROVIDER_CONNECTION_NOT_FOUND",
      category: "configuration",
      retryable: false,
    },
  );
}

function modelContextLengthRequired() {
  return new AgentGatewayError(MODEL_CONTEXT_UNKNOWN_ERROR_MESSAGE, {
    code: "AI_MODEL_CONTEXT_UNKNOWN",
    category: "configuration",
    retryable: false,
  });
}

function invalidExternalHarnessConfiguration() {
  return new AgentGatewayError(
    "The selected provider is not available to the external reviewer harness.",
    {
      code: "AI_EXTERNAL_HARNESS_CONFIGURATION_INVALID",
      category: "configuration",
      retryable: false,
    },
  );
}

function externalSessionConflict() {
  return new AgentGatewayError(
    "The external AI reviewer session cannot safely continue.",
    {
      code: "AI_EXTERNAL_SESSION_INTERMEDIATE_STATE",
      category: "configuration",
      retryable: true,
    },
  );
}

/** @param {unknown} error */
function mapExternalSessionError(error) {
  if (
    error instanceof AiReviewerExternalAgentSessionConflictError ||
    error instanceof AiReviewerExternalAgentSessionNotFoundError
  ) {
    return externalSessionConflict();
  }
  if (error instanceof AiReviewerExternalAgentSessionValidationError) {
    return invalidExternalHarnessConfiguration();
  }
  return error;
}

/** @param {any} connection @param {any} request */
function externalRunConfiguration(connection, request) {
  let endpoint;
  let model;
  let credential;
  try {
    endpoint = parseOpenAiCompatibleBaseUrl(connection?.baseUrl);
    model = parseOpenAiCompatibleModelId(request.model);
    credential =
      connection?.credential == null
        ? null
        : parseAiReviewerProviderCredential(connection.credential);
    assertOpenAiCompatibleCredentialTransport(
      endpoint.baseUrl,
      credential != null,
    );
  } catch {
    throw invalidExternalHarnessConfiguration();
  }
  if (
    connection?.provider !== "openai-compatible" ||
    endpoint.classification !== "local" ||
    connection.apiVersion != null ||
    !Array.isArray(connection.models) ||
    !connection.models.includes(model)
  ) {
    throw invalidExternalHarnessConfiguration();
  }
  return Object.freeze({
    provider: "openai-compatible",
    baseUrl: endpoint.baseUrl,
    model,
    ...(credential == null ? {} : { credential }),
  });
}

/** @param {any} connection @param {{ provider: string, baseUrl: string, model: string, credential?: string }} configuration */
function externalConnectionFingerprint(connection, configuration) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        connection.id,
        configuration.provider,
        configuration.baseUrl,
        configuration.model,
        connection.credentialUpdatedAt ?? null,
        configuration.credential ?? null,
      ]),
    )
    .digest("hex");
}

/**
 * Load the connection the request selected. A connection identifier that is
 * not this user's own is absent rather than readable. The public error says
 * only that the selected connection is unavailable to this user, without
 * revealing whether the identifier exists in another user's configuration.
 * With no selection there is no destination to fall back to, even when only
 * one connection remains: sending manuscript content requires an explicit
 * project choice.
 *
 * @param {any} configStore @param {any} context @param {string} userId
 */
async function loadRunConnection(configStore, context, userId) {
  const connectionId = context.request.connectionId ?? null;
  if (connectionId == null) {
    throw modelSelectionRequired();
  }
  try {
    return await configStore.get(userId, connectionId);
  } catch (error) {
    if (error instanceof AiReviewerConnectionNotFoundError) {
      throw selectedConnectionMissing();
    }
    throw error;
  }
}

/**
 * Validate the explicitly selected model against this connection. A model is
 * never inferred from catalog size because that would choose a destination
 * for manuscript content on the user's behalf.
 *
 * @param {any} connection @param {any} context @param {any} providerService
 * @param {string} userId
 */
async function resolveRunModel(connection, context, providerService, userId) {
  const requestedModel = context.request.model ?? null;
  if (requestedModel == null) {
    throw modelSelectionRequired();
  }
  let models;
  try {
    parseOpenAiCompatibleModelId(requestedModel);
    models = await providerService.listModels(connection, {
      signal: context.signal,
      cacheKey: aiReviewerModelCacheKey(userId, connection.id ?? null),
    });
  } catch (error) {
    if (
      error instanceof AgentGatewayError &&
      error.code === "AI_PROVIDER_MODEL_DISCOVERY_UNSUPPORTED"
    ) {
      // Providers without discovery still receive the existing bounded ID
      // check for the model the user explicitly selected.
      return requestedModel;
    }
    throw error instanceof AgentGatewayError ? error : invalidRunModel();
  }
  if (!models.some((candidate) => candidate.id === requestedModel)) {
    throw invalidRunModel();
  }
  return requestedModel;
}

/**
 * @param {any} connection @param {any} context @param {any} providerService
 * @param {string} userId
 */
async function resolveRunConfiguration(
  connection,
  context,
  providerService,
  userId,
) {
  const model = await resolveRunModel(
    connection,
    context,
    providerService,
    userId,
  );
  const resolution = await providerService.resolveContextLength(
    connection,
    model,
    {
      signal: context.signal,
      cacheKey: aiReviewerModelCacheKey(userId, connection.id ?? null),
    },
  );
  if (resolution.contextLength == null) {
    // Stop before RequestScopeReader, ProjectSnapshot, or AiSdkAgentGateway can
    // calculate a budget. No provider generation request is made for an
    // invented context length.
    throw modelContextLengthRequired();
  }
  return Object.freeze({
    provider: connection.provider,
    ...(connection.provider === "openai-compatible"
      ? {
          baseUrl: connection.baseUrl,
          ...(connection.apiVersion == null
            ? {}
            : { apiVersion: connection.apiVersion }),
        }
      : connection.provider === "azure"
        ? {
            baseUrl: connection.baseUrl,
            requestStyle: connection.requestStyle,
            apiVersion: connection.apiVersion,
          }
        : {}),
    ...(typeof connection.credential === "string"
      ? { credential: connection.credential }
      : {}),
    ...(connection.reasoningModelCompatibility === true
      ? { reasoningModelCompatibility: true }
      : {}),
    model,
    ...resolution,
  });
}

/** @param {any} skillStore @param {string} userId */
async function loadRunSkills(skillStore, userId) {
  if (typeof skillStore?.listForReview !== "function") {
    return [];
  }
  try {
    return await skillStore.listForReview(userId);
  } catch {
    // A broken optional reference must not discard the review itself. The
    // gateway receives an explicit empty set and keeps its no-skill behavior.
    return [];
  }
}

/** @param {any} modeInstructionStore @param {any} request @param {string} userId */
async function loadRunModeInstructions(modeInstructionStore, request, userId) {
  if (typeof modeInstructionStore?.load !== "function") {
    return {};
  }
  // The project half of the owner scope comes from the authorized route, not
  // from the model request body, so a caller cannot select another project.
  const snapshot = await modeInstructionStore.load(
    userId,
    request.params?.project_id,
  );
  return snapshot.instructions;
}

/** @param {any} dependencies */
export function createConfiguredAiReviewerController({
  configStore,
  providerService,
  skillStore,
  modeInstructionStore,
  requestScopeReader,
  timeoutSignalFactory,
  now,
  eventId,
  elapsedNow,
  failureRecorder,
  circuitBreakerStore = null,
  harness = "native",
  externalCheckpoint = createExternalAgentCheckpoint,
  externalSessionStore = null,
  externalRunnerClient = null,
  externalGatewayFactory = createExternalAgentGateway,
}) {
  if (harness !== "native" && harness !== "external") {
    throw new TypeError("The AI reviewer harness is invalid.");
  }
  return createAiReviewerController({
    async gatewayFactory(context) {
      if (testGatewayFactory != null) {
        return await testGatewayFactory(context);
      }

      const userId = authenticatedUserId(context.httpRequest);
      if (harness === "external") {
        const snapshot = await externalCheckpoint(context.request, {
          signal: context.signal,
        });
        const connection = await loadRunConnection(
          configStore,
          context,
          userId,
        );
        const configuration = externalRunConfiguration(
          connection,
          context.request,
        );
        context.setFailureProvider(configuration.provider, configuration.model);
        if (externalSessionStore == null || externalRunnerClient == null) {
          throw invalidExternalHarnessConfiguration();
        }
        const mode =
          context.request.agentSessionId == null ? "review" : "agent";
        const clientSessionId =
          context.request.agentSessionId ?? context.request.requestId;
        let session;
        let claim;
        try {
          session = await externalSessionStore.create({
            userId,
            projectId: context.request.projectId,
            clientSessionId,
            mode,
            connectionFingerprint: externalConnectionFingerprint(
              connection,
              configuration,
            ),
          });
          if (mode === "review" && session.threadId != null) {
            throw externalSessionConflict();
          }
          claim = await externalSessionStore.claim({
            userId,
            projectId: context.request.projectId,
            clientSessionId,
            type: "turn",
            expectedRevision: session.revision,
            expectedThreadId: session.threadId,
          });
        } catch (error) {
          throw mapExternalSessionError(error);
        }
        return externalGatewayFactory({
          request: context.request,
          snapshot,
          configuration,
          session,
          claim,
          runnerClient: externalRunnerClient,
          sessionStore: externalSessionStore,
          userId,
          projectId: context.request.projectId,
          clientSessionId,
          ...(eventId == null ? {} : { createId: eventId }),
          ...(now == null ? {} : { now }),
        });
      }
      const configuration = await loadRunConnection(
        configStore,
        context,
        userId,
      );
      if (configuration == null) {
        throw new AgentGatewayError("No AI provider is configured.", {
          code: "AI_PROVIDER_NOT_CONFIGURED",
          category: "configuration",
          retryable: false,
        });
      }
      context.setFailureProvider(
        configuration.provider,
        context.request.model ?? null,
      );
      await circuitBreakerStore?.assertRequestAllowed(configuration.id);
      const runConfiguration = await resolveRunConfiguration(
        configuration,
        context,
        providerService,
        userId,
      );
      context.setFailureProvider(
        runConfiguration.provider,
        runConfiguration.model,
      );
      const scope = await requestScopeReader.read(context.httpRequest, {
        signal: context.signal,
        contextLength: runConfiguration.contextLength,
        contextLengthSource: runConfiguration.contextLengthSource,
      });
      const [skills, modeInstructions] = await Promise.all([
        loadRunSkills(skillStore, userId),
        loadRunModeInstructions(
          modeInstructionStore,
          context.httpRequest,
          userId,
        ),
      ]);
      const gateway = providerService.createAgentGateway(runConfiguration, {
        connectionId: configuration.id,
        skills,
        modeInstructions,
        readProjectFile: scope.readProjectFile,
        projectContext: scope.projectContext,
        searchZotero: scope.searchZotero,
        validateEvidence: scope.validateEvidence,
      });
      // Coverage is a guard on an explicitly scoped project review: if it read
      // nothing, it reviewed nothing. A scope-free message may legitimately
      // answer without opening a file, so its visible mode does not opt it into
      // this rule.
      return context.request.skill != null &&
        context.request.scope?.kind === "project"
        ? enforceProjectReviewCoverage(gateway, scope, runConfiguration)
        : gateway;
    },
    timeoutSignalFactory,
    now,
    eventId,
    elapsedNow,
    failureRecorder,
  });
}

/** @param {AbortSignal | undefined} signal */
function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new AgentGatewayAbortError();
  }
}

/**
 * @param {string} projectId
 * @param {{ signal?: AbortSignal }} [options]
 */
async function loadProjectDocuments(projectId, { signal } = {}) {
  throwIfAborted(signal);
  const paths =
    await ProjectEntityHandler.promises.getAllDocPathsFromProjectById(
      projectId,
    );
  const entries = Object.entries(paths);
  if (entries.length > PROJECT_SNAPSHOT_DOCUMENT_LIMIT) {
    throw new AgentGatewayError(
      "The project has too many documents to review.",
      {
        code: "AI_PROJECT_CONTENT_NOT_AVAILABLE",
        category: "configuration",
        retryable: false,
      },
    );
  }
  return Object.fromEntries(
    await Promise.all(
      entries.map(async ([documentId, path]) => {
        throwIfAborted(signal);
        const document = await ProjectEntityHandler.promises.getDoc(
          projectId,
          documentId,
          { peek: true },
        );
        throwIfAborted(signal);
        return [path, { _id: documentId, ...document }];
      }),
    ),
  );
}

const circuitBreakerStore = createAiReviewerProviderCircuitBreakerStore();
const providerService = createAiReviewerProviderService({
  circuitBreakerStore,
});
const configStore = createAiReviewerProviderConfigStore();
const requestScopeReader = createRequestScopeReader({
  loadProjectDocuments,
  isZoteroLinked(userId) {
    return ZoteroApiClient.isLinked(userId);
  },
  searchZoteroItems(userId, input, { signal }) {
    return ZoteroApiClient.searchItems(userId, {
      query: input.query,
      signal,
    });
  },
});
const workspaceStore = createAiReviewerWorkspaceStore({
  connectionStore: configStore,
});
const externalHarnessEnabled = Settings.aiReviewer?.harness === "external";
const providerController = createAiReviewerProviderController({
  configStore,
  providerService,
  workspaceStore,
  failureRecorder: recordAiReviewerFailure,
  circuitBreakerStore,
  externalHarnessEnabled,
});
const skillStore = createAiReviewerSkillStore();
const modeInstructionStore = createAiReviewerModeInstructionStore();
const externalSessionStore = createExternalAgentSessionStore();
const externalRunnerClient = new ExternalAgentRunnerClient();
const skillGitImporter = createAiReviewerSkillGitImporter();
const skillController = createAiReviewerSkillController({
  skillStore,
  skillGitImporter,
});
const configuredController = createConfiguredAiReviewerController({
  configStore,
  providerService,
  skillStore,
  modeInstructionStore,
  requestScopeReader,
  failureRecorder: recordAiReviewerFailure,
  circuitBreakerStore,
  harness: externalHarnessEnabled ? "external" : "native",
  externalSessionStore,
  externalRunnerClient,
});
const workspaceController = createAiReviewerWorkspaceController({
  workspaceStore,
});
const modeInstructionController = createAiReviewerModeInstructionController({
  modeInstructionStore,
});
const provenanceStore = createAiReviewerCommentProvenanceStore();
const provenanceController = createAiReviewerCommentProvenanceController({
  provenanceStore,
});
const externalSessionController = createExternalAgentSessionController({
  sessionStore: externalSessionStore,
  runnerClient: externalRunnerClient,
  enabled: externalHarnessEnabled,
});

export default {
  listModels: expressify(providerController.listModels),
  testConnection: expressify(providerController.testConnection),
  listConnections: expressify(providerController.listConnections),
  createConnection: expressify(providerController.createConnection),
  updateConnection: expressify(providerController.updateConnection),
  deleteConnection: expressify(providerController.deleteConnection),
  resetCircuit: expressify(providerController.resetCircuit),
  listSkills: expressify(skillController.listSkills),
  uploadSkill: expressify(skillController.uploadSkill),
  previewSkillGitImport: expressify(skillController.previewGitImport),
  confirmSkillGitImport: expressify(skillController.confirmGitImport),
  deleteSkill: expressify(skillController.deleteSkill),
  stream: expressify(configuredController.stream),
  getAgentSession: expressify(externalSessionController.getSession),
  resolveAgentSession: expressify(externalSessionController.resolveSession),
  reopenAgentSession: expressify(externalSessionController.reopenSession),
  getModeInstructions: expressify(
    modeInstructionController.getModeInstructions,
  ),
  saveModeInstructions: expressify(
    modeInstructionController.saveModeInstructions,
  ),
  getWorkspace: expressify(workspaceController.getWorkspace),
  saveWorkspace: expressify(workspaceController.saveWorkspace),
  getCommentProvenance: expressify(provenanceController.getCommentProvenance),
  markCommentProvenance: expressify(provenanceController.markCommentProvenance),
  deleteCommentProvenance: expressify(
    provenanceController.deleteCommentProvenance,
  ),
  deleteDiscussion: expressify(workspaceController.deleteDiscussion),
  deleteWorkspace: expressify(workspaceController.deleteWorkspace),
};
