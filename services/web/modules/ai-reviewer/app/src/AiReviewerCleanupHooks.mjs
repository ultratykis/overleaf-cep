// @ts-check

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

/**
 * Remove everything this module stores for one user. Provider configuration
 * carries the encrypted credential, so it is deleted alongside the workspace
 * rather than left behind for a user that no longer exists.
 *
 * @param {string} userId
 */
async function deleteUserData(userId) {
  const [workspaceStore, providerConfigStore] = await Promise.all([
    getWorkspaceCleanupStore(),
    getProviderConfigCleanupStore(),
  ]);
  await Promise.all([
    workspaceStore.deleteUser(userId),
    providerConfigStore.deleteUser(userId),
  ]);
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
