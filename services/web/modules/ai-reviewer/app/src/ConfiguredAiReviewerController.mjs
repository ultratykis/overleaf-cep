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
import { createAiReviewerProviderConfigStore } from "./AiReviewerProviderConfigStore.mjs";
import { createAiReviewerProviderController } from "./AiReviewerProviderController.mjs";
import { createAiReviewerWorkspaceController } from "./AiReviewerWorkspaceController.mjs";
import { createAiReviewerWorkspaceStore } from "./AiReviewerWorkspaceStore.mjs";
import { createAiReviewerProviderService } from "./OllamaProviderService.mjs";
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

      const configuration = await configStore.get(
        authenticatedUserId(context.httpRequest),
      );
      if (configuration == null) {
        throw new AgentGatewayError("No AI provider is configured.", {
          code: "AI_PROVIDER_NOT_CONFIGURED",
          category: "configuration",
          retryable: false,
        });
      }
      context.setFailureProvider(configuration.provider, configuration.model);
      if (DiscussionRequestSchema.safeParse(context.request).success) {
        return providerService.createDiscussionGateway(configuration);
      }
      const scope = await requestScopeReader.read(context.httpRequest, {
        signal: context.signal,
        contextLength: configuration.contextLength,
      });
      return providerService.createAgentGateway(configuration, {
        readProjectFile: scope.readProjectFile,
        projectContext: scope.projectContext,
        searchZotero: scope.searchZotero,
        validateEvidence: scope.validateEvidence,
      });
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
const configStore = createAiReviewerProviderConfigStore({
  resolveContextLength: providerService.resolveContextLength,
});
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
  getConfiguration: expressify(providerController.getConfiguration),
  saveConfiguration: expressify(providerController.saveConfiguration),
  testConnection: expressify(providerController.testConnection),
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
