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
 *   getConfiguration: (...args: any[]) => unknown,
 *   saveConfiguration: (...args: any[]) => unknown,
 *   testConnection: (...args: any[]) => unknown,
 *   stream: (...args: any[]) => unknown,
 *   discussionStream: (...args: any[]) => unknown,
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
  getConfiguration,
  saveConfiguration,
  testConnection,
  stream,
  discussionStream,
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

      webRouter.get(
        "/project/:project_id/ai-reviewer/config",
        ...commonMiddleware,
        getConfiguration,
      );
      webRouter.get(
        "/project/:project_id/ai-reviewer/workspace",
        ...commonMiddleware,
        getWorkspace,
      );
      webRouter.get(
        "/project/:project_id/ai-reviewer/comment-provenance",
        ...commonMiddleware,
        getCommentProvenance,
      );
      webRouter.put(
        "/project/:project_id/ai-reviewer/config",
        ...commonMiddleware,
        saveConfiguration,
      );
      webRouter.put(
        "/project/:project_id/ai-reviewer/workspace",
        ...commonMiddleware,
        saveWorkspace,
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
      webRouter.post(
        "/project/:project_id/ai-reviewer/discussion-stream",
        ...commonMiddleware,
        discussionStream,
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
    },
  };
}
