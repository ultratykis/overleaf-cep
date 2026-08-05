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
      await (await getWorkspaceCleanupStore()).deleteUser(userId);
    },
  },
};

export default AiReviewerCleanupHooks;
