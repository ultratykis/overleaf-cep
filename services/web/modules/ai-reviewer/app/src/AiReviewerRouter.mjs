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
}) {
  const appliedRouters = new WeakSet();

  return {
    /**
     * @param {{
     *   get: (...args: any[]) => unknown,
     *   put: (...args: any[]) => unknown,
     *   post: (...args: any[]) => unknown,
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
      webRouter.put(
        "/project/:project_id/ai-reviewer/config",
        ...commonMiddleware,
        saveConfiguration,
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
    },
  };
}
