// @ts-check

import logger from "@overleaf/logger";

const workspaceStorePath = "./AiReviewerWorkspaceStore.mjs";
/** @type {Promise<ReturnType<import("./AiReviewerWorkspaceStore.mjs").createAiReviewerWorkspaceStore>> | null} */
let workspaceCleanupStorePromise = null;

function getWorkspaceCleanupStore() {
  if (workspaceCleanupStorePromise == null) {
    workspaceCleanupStorePromise = import(workspaceStorePath).then(
      ({ createAiReviewerWorkspaceStore }) => createAiReviewerWorkspaceStore(),
    );
  }
  return workspaceCleanupStorePromise;
}

const provenanceStorePath = "./AiReviewerCommentProvenanceStore.mjs";
/** @type {Promise<ReturnType<import("./AiReviewerCommentProvenanceStore.mjs").createAiReviewerCommentProvenanceStore>> | null} */
let provenanceCleanupStorePromise = null;

function getProvenanceCleanupStore() {
  if (provenanceCleanupStorePromise == null) {
    provenanceCleanupStorePromise = import(provenanceStorePath).then(
      ({ createAiReviewerCommentProvenanceStore }) =>
        createAiReviewerCommentProvenanceStore(),
    );
  }
  return provenanceCleanupStorePromise;
}

const providerConfigStorePath = "./AiReviewerProviderConfigStore.mjs";
/** @type {Promise<ReturnType<import("./AiReviewerProviderConfigStore.mjs").createAiReviewerProviderConfigStore>> | null} */
let providerConfigCleanupStorePromise = null;

function getProviderConfigCleanupStore() {
  if (providerConfigCleanupStorePromise == null) {
    providerConfigCleanupStorePromise = import(providerConfigStorePath).then(
      ({ createAiReviewerProviderConfigStore }) =>
        createAiReviewerProviderConfigStore(),
    );
  }
  return providerConfigCleanupStorePromise;
}

const skillStorePath = "./AiReviewerSkillStore.mjs";
/** @type {Promise<ReturnType<import("./AiReviewerSkillStore.mjs").createAiReviewerSkillStore>> | null} */
let skillCleanupStorePromise = null;

function getSkillCleanupStore() {
  if (skillCleanupStorePromise == null) {
    skillCleanupStorePromise = import(skillStorePath).then(
      ({ createAiReviewerSkillStore }) => createAiReviewerSkillStore(),
    );
  }
  return skillCleanupStorePromise;
}

/**
 * Remove everything this module stores for one user. Provider configuration
 * carries the encrypted credential, so it is deleted alongside the workspace
 * rather than left behind for a user that no longer exists.
 *
 * @param {string} userId
 */
async function deleteUserData(userId) {
  const outcomes = await Promise.allSettled([
    getWorkspaceCleanupStore().then((store) => store.deleteUser(userId)),
    getProviderConfigCleanupStore().then((store) => store.deleteUser(userId)),
    getSkillCleanupStore().then((store) => store.deleteUser(userId)),
  ]);
  const dataKinds = ["workspace", "provider configuration", "skills"];
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === "rejected") {
      // A module cleanup failure must not prevent the host from deleting the
      // user or the other independent records from being removed.
      logger.warn(
        { err: outcome.reason, userId, dataKind: dataKinds[index] },
        "failed to remove AI reviewer data while deleting user",
      );
    }
  }
}

const AiReviewerCleanupHooks = {
  promises: {
    /** @param {string} projectId */
    async projectExpired(projectId) {
      const [workspaceStore, provenanceStore] = await Promise.all([
        getWorkspaceCleanupStore(),
        getProvenanceCleanupStore(),
      ]);
      await Promise.all([
        workspaceStore.deleteProject(projectId),
        provenanceStore.deleteProject(projectId),
      ]);
    },

    /** @param {string} userId */
    async deleteUser(userId) {
      await deleteUserData(userId);
    },

    /** @param {string} userId */
    async expireDeletedUser(userId) {
      await deleteUserData(userId);
    },
  },
};

export default AiReviewerCleanupHooks;
