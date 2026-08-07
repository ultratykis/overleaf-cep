// @ts-check

/**
 * @param {{
 *   authenticationController: {
 *     requireLogin: () => (...args: any[]) => unknown,
 *   },
 *   authorizationMiddleware: {
 *     blockRestrictedUserFromProject: (...args: any[]) => unknown,
 *     ensureUserCanReadProject: (...args: any[]) => unknown,
 *   },
 *   rateLimit: (...args: any[]) => unknown,
 *   listModels: (...args: any[]) => unknown,
 *   testConnection: (...args: any[]) => unknown,
 *   listConnections: (...args: any[]) => unknown,
 *   createConnection: (...args: any[]) => unknown,
 *   updateConnection: (...args: any[]) => unknown,
 *   deleteConnection: (...args: any[]) => unknown,
 *   resetCircuit: (...args: any[]) => unknown,
 *   listSkills: (...args: any[]) => unknown,
 *   uploadSkill: (...args: any[]) => unknown,
 *   previewSkillGitImport: (...args: any[]) => unknown,
 *   confirmSkillGitImport: (...args: any[]) => unknown,
 *   deleteSkill: (...args: any[]) => unknown,
 *   stream: (...args: any[]) => unknown,
 *   getAgentSession: (...args: any[]) => unknown,
 *   resolveAgentSession: (...args: any[]) => unknown,
 *   reopenAgentSession: (...args: any[]) => unknown,
 *   getModeInstructions: (...args: any[]) => unknown,
 *   saveModeInstructions: (...args: any[]) => unknown,
 *   getWorkspace: (...args: any[]) => unknown,
 *   saveWorkspace: (...args: any[]) => unknown,
 *   getCommentProvenance: (...args: any[]) => unknown,
 *   markCommentProvenance: (...args: any[]) => unknown,
 *   deleteCommentProvenance: (...args: any[]) => unknown,
 *   deleteDiscussion: (...args: any[]) => unknown,
 *   deleteWorkspace: (...args: any[]) => unknown,
 * }} dependencies
 */
export function createAiReviewerRouter({
  authenticationController,
  authorizationMiddleware,
  rateLimit,
  listModels,
  testConnection,
  listConnections,
  createConnection,
  updateConnection,
  deleteConnection,
  resetCircuit,
  listSkills,
  uploadSkill,
  previewSkillGitImport,
  confirmSkillGitImport,
  deleteSkill,
  stream,
  getAgentSession,
  resolveAgentSession,
  reopenAgentSession,
  getModeInstructions,
  saveModeInstructions,
  getWorkspace,
  saveWorkspace,
  getCommentProvenance,
  markCommentProvenance,
  deleteCommentProvenance,
  deleteDiscussion,
  deleteWorkspace,
}) {
  const appliedRouters = new WeakSet();
  return {
    /**
     * @param {{
     *   get: (...args: any[]) => unknown,
     *   put: (...args: any[]) => unknown,
     *   post: (...args: any[]) => unknown,
     *   delete: (...args: any[]) => unknown,
     * }} webRouter
     */
    apply(webRouter) {
      if (appliedRouters.has(webRouter)) {
        return;
      }
      appliedRouters.add(webRouter);

      const requireLogin = authenticationController.requireLogin();
      const commonMiddleware = [
        requireLogin,
        rateLimit,
        authorizationMiddleware.blockRestrictedUserFromProject,
        authorizationMiddleware.ensureUserCanReadProject,
      ];
      const userSettingsMiddleware = [requireLogin, rateLimit];

      webRouter.get(
        "/project/:project_id/ai-reviewer/provider/models",
        ...commonMiddleware,
        listModels,
      );
      webRouter.get(
        "/project/:project_id/ai-reviewer/workspace",
        ...commonMiddleware,
        getWorkspace,
      );
      webRouter.get(
        "/project/:project_id/ai-reviewer/mode-instructions",
        ...commonMiddleware,
        getModeInstructions,
      );
      webRouter.get(
        "/project/:project_id/ai-reviewer/comment-provenance",
        ...commonMiddleware,
        getCommentProvenance,
      );
      webRouter.put(
        "/project/:project_id/ai-reviewer/workspace",
        ...commonMiddleware,
        saveWorkspace,
      );
      webRouter.put(
        "/project/:project_id/ai-reviewer/mode-instructions",
        ...commonMiddleware,
        saveModeInstructions,
      );
      webRouter.put(
        "/project/:project_id/ai-reviewer/comment-provenance/:comment_id",
        ...commonMiddleware,
        markCommentProvenance,
      );
      webRouter.post(
        "/project/:project_id/ai-reviewer/connection-test",
        ...commonMiddleware,
        testConnection,
      );
      webRouter.post(
        "/project/:project_id/ai-reviewer/stream",
        ...commonMiddleware,
        stream,
      );
      webRouter.delete(
        "/project/:project_id/ai-reviewer/workspace/discussions/:discussion_id",
        ...commonMiddleware,
        deleteDiscussion,
      );
      webRouter.delete(
        "/project/:project_id/ai-reviewer/workspace",
        ...commonMiddleware,
        deleteWorkspace,
      );
      webRouter.delete(
        "/project/:project_id/ai-reviewer/comment-provenance/:comment_id",
        ...commonMiddleware,
        deleteCommentProvenance,
      );

      // Account settings are authenticated by the session. requireLogin
      // replaces request.user from that session, and the handlers never read
      // an owner from route parameters.
      webRouter.get(
        "/user/ai-reviewer/connections",
        ...userSettingsMiddleware,
        listConnections,
      );
      webRouter.post(
        "/user/ai-reviewer/connections",
        ...userSettingsMiddleware,
        createConnection,
      );
      webRouter.put(
        "/user/ai-reviewer/connections/:connection_id",
        ...userSettingsMiddleware,
        updateConnection,
      );
      webRouter.delete(
        "/user/ai-reviewer/connections/:connection_id",
        ...userSettingsMiddleware,
        deleteConnection,
      );

      // Keep the project entry point for editing while writing. It reaches the
      // same user-owned records without changing the project model selection.
      webRouter.get(
        "/project/:project_id/ai-reviewer/connections",
        ...commonMiddleware,
        listConnections,
      );
      webRouter.post(
        "/project/:project_id/ai-reviewer/connections",
        ...commonMiddleware,
        createConnection,
      );
      webRouter.put(
        "/project/:project_id/ai-reviewer/connections/:connection_id",
        ...commonMiddleware,
        updateConnection,
      );
      webRouter.delete(
        "/project/:project_id/ai-reviewer/connections/:connection_id",
        ...commonMiddleware,
        deleteConnection,
      );

      // Skills share the settings screen and are user-owned too, so account
      // settings receives session-scoped endpoints without changing storage.
      webRouter.get(
        "/user/ai-reviewer/skills",
        ...userSettingsMiddleware,
        listSkills,
      );
      webRouter.post(
        "/user/ai-reviewer/skills",
        ...userSettingsMiddleware,
        uploadSkill,
      );
      webRouter.post(
        "/user/ai-reviewer/skills/import/preview",
        ...userSettingsMiddleware,
        previewSkillGitImport,
      );
      webRouter.post(
        "/user/ai-reviewer/skills/import",
        ...userSettingsMiddleware,
        confirmSkillGitImport,
      );
      webRouter.delete(
        "/user/ai-reviewer/skills/:skill_id",
        ...userSettingsMiddleware,
        deleteSkill,
      );

      // The project entry point remains available while writing.
      webRouter.get(
        "/project/:project_id/ai-reviewer/skills",
        ...commonMiddleware,
        listSkills,
      );
      webRouter.post(
        "/project/:project_id/ai-reviewer/skills",
        ...commonMiddleware,
        uploadSkill,
      );
      webRouter.post(
        "/project/:project_id/ai-reviewer/skills/import/preview",
        ...commonMiddleware,
        previewSkillGitImport,
      );
      webRouter.post(
        "/project/:project_id/ai-reviewer/skills/import",
        ...commonMiddleware,
        confirmSkillGitImport,
      );
      webRouter.delete(
        "/project/:project_id/ai-reviewer/skills/:skill_id",
        ...commonMiddleware,
        deleteSkill,
      );

      webRouter.post(
        "/project/:project_id/ai-reviewer/connections/:connection_id/circuit-reset",
        ...commonMiddleware,
        resetCircuit,
      );
      webRouter.get(
        "/project/:project_id/ai-reviewer/agent-sessions/:agent_session_id",
        ...commonMiddleware,
        getAgentSession,
      );
      webRouter.post(
        "/project/:project_id/ai-reviewer/agent-sessions/:agent_session_id/resolve",
        ...commonMiddleware,
        resolveAgentSession,
      );
      webRouter.post(
        "/project/:project_id/ai-reviewer/agent-sessions/:agent_session_id/reopen",
        ...commonMiddleware,
        reopenAgentSession,
      );
    },
  };
}
