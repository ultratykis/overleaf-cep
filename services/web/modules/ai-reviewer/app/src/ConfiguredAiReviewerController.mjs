// @ts-check

import { expressify } from "@overleaf/promise-utils";

import { DiscussionRequestSchema } from "../../shared/contracts.mjs";
import ProjectEntityHandler from "../../../../app/src/Features/Project/ProjectEntityHandler.mjs";
import ZoteroApiClient from "../../../zotero/app/src/ZoteroApiClient.mjs";
import { AgentGatewayAbortError, AgentGatewayError } from "./AgentGateway.mjs";
import { createAiReviewerCommentProvenanceController } from "./AiReviewerCommentProvenanceController.mjs";
import { createAiReviewerCommentProvenanceStore } from "./AiReviewerCommentProvenanceStore.mjs";
import { createAiReviewerController } from "./AiReviewerController.mjs";
import { recordAiReviewerFailure } from "./AiReviewerFailureLogger.mjs";
import {
  AiReviewerConnectionAmbiguousError,
  AiReviewerConnectionNotFoundError,
  aiReviewerModelCacheKey,
  createAiReviewerProviderConfigStore,
} from "./AiReviewerProviderConfigStore.mjs";
import { createAiReviewerProviderController } from "./AiReviewerProviderController.mjs";
import { createAiReviewerWorkspaceController } from "./AiReviewerWorkspaceController.mjs";
import { createAiReviewerWorkspaceStore } from "./AiReviewerWorkspaceStore.mjs";
import { createAiReviewerProviderService } from "./OllamaProviderService.mjs";
import { parseOpenAiCompatibleModelId } from "./OllamaEndpointPolicy.mjs";
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

/** @param {any} gateway @param {any} scope */
function enforceProjectReviewCoverage(gateway, scope) {
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

/**
 * Load the connection the request selected. A connection identifier that is
 * not this user's own is absent rather than readable, and is reported as an
 * unconfigured provider instead of leaking that it exists for somebody else.
 * With several connections and no selection there is nothing to fall back to,
 * so the run asks for a model rather than picking a destination on its own.
 *
 * @param {any} configStore @param {any} context
 */
async function loadRunConnection(configStore, context) {
  try {
    return await configStore.get(
      authenticatedUserId(context.httpRequest),
      context.request.connectionId ?? null,
    );
  } catch (error) {
    if (error instanceof AiReviewerConnectionAmbiguousError) {
      throw modelSelectionRequired();
    }
    if (error instanceof AiReviewerConnectionNotFoundError) {
      return null;
    }
    throw error;
  }
}

/**
 * Decide which model this run uses. Discovery answers both questions: whether
 * a named model belongs to this connection, and — when the request named none
 * — whether the connection leaves anything to choose between.
 *
 * @param {any} connection @param {any} context @param {any} providerService
 */
async function resolveRunModel(connection, context, providerService) {
  const requestedModel = context.request.model ?? null;
  let models;
  try {
    if (requestedModel != null) {
      parseOpenAiCompatibleModelId(requestedModel);
    }
    models = await providerService.listModels(connection, {
      signal: context.signal,
      cacheKey: aiReviewerModelCacheKey(
        authenticatedUserId(context.httpRequest),
        connection.id ?? null,
      ),
    });
  } catch (error) {
    if (
      error instanceof AgentGatewayError &&
      error.code === "AI_PROVIDER_MODEL_DISCOVERY_UNSUPPORTED"
    ) {
      // Providers without discovery still receive the existing bounded ID
      // check, but cannot say which model a request that named none wanted.
      if (requestedModel == null) {
        throw modelSelectionRequired();
      }
      return requestedModel;
    }
    throw error instanceof AgentGatewayError ? error : invalidRunModel();
  }
  if (requestedModel == null) {
    if (models.length !== 1) {
      throw modelSelectionRequired();
    }
    return models[0].id;
  }
  if (!models.some((candidate) => candidate.id === requestedModel)) {
    throw invalidRunModel();
  }
  return requestedModel;
}

/** @param {any} connection @param {any} context @param {any} providerService */
async function resolveRunConfiguration(connection, context, providerService) {
  const model = await resolveRunModel(connection, context, providerService);
  const resolution = await providerService.resolveContextLength(
    connection,
    model,
  );
  return Object.freeze({
    provider: connection.provider,
    ...(connection.provider === "openai-compatible"
      ? { baseUrl: connection.baseUrl }
      : {}),
    ...(typeof connection.credential === "string"
      ? { credential: connection.credential }
      : {}),
    model,
    ...resolution,
  });
}

/** @param {any} dependencies */
export function createConfiguredAiReviewerController({
  configStore,
  providerService,
  requestScopeReader,
  timeoutSignalFactory,
  now,
  eventId,
  elapsedNow,
  failureRecorder,
}) {
  return createAiReviewerController({
    async gatewayFactory(context) {
      if (testGatewayFactory != null) {
        return await testGatewayFactory(context);
      }

      const configuration = await loadRunConnection(configStore, context);
      if (configuration == null) {
        throw new AgentGatewayError("No AI provider is configured.", {
          code: "AI_PROVIDER_NOT_CONFIGURED",
          category: "configuration",
          retryable: false,
        });
      }
      const runConfiguration = await resolveRunConfiguration(
        configuration,
        context,
        providerService,
      );
      context.setFailureProvider(
        runConfiguration.provider,
        runConfiguration.model,
      );
      if (DiscussionRequestSchema.safeParse(context.request).success) {
        return providerService.createDiscussionGateway(runConfiguration);
      }
      const scope = await requestScopeReader.read(context.httpRequest, {
        signal: context.signal,
        contextLength: runConfiguration.contextLength,
      });
      const gateway = providerService.createAgentGateway(runConfiguration, {
        readProjectFile: scope.readProjectFile,
        projectContext: scope.projectContext,
        searchZotero: scope.searchZotero,
        validateEvidence: scope.validateEvidence,
      });
      return enforceProjectReviewCoverage(gateway, scope);
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

const providerService = createAiReviewerProviderService();
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
const providerController = createAiReviewerProviderController({
  configStore,
  providerService,
  failureRecorder: recordAiReviewerFailure,
});
const configuredController = createConfiguredAiReviewerController({
  configStore,
  providerService,
  requestScopeReader,
  failureRecorder: recordAiReviewerFailure,
});
const workspaceStore = createAiReviewerWorkspaceStore();
const workspaceController = createAiReviewerWorkspaceController({
  workspaceStore,
});
const provenanceStore = createAiReviewerCommentProvenanceStore();
const provenanceController = createAiReviewerCommentProvenanceController({
  provenanceStore,
});

export default {
  listModels: expressify(providerController.listModels),
  testConnection: expressify(providerController.testConnection),
  listConnections: expressify(providerController.listConnections),
  createConnection: expressify(providerController.createConnection),
  updateConnection: expressify(providerController.updateConnection),
  deleteConnection: expressify(providerController.deleteConnection),
  stream: expressify(configuredController.stream),
  discussionStream: expressify(configuredController.discussionStream),
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
