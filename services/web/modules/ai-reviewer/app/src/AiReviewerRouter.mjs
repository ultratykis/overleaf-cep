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
 *   stream: (...args: any[]) => unknown,
 * }} dependencies
 */
export function createAiReviewerRouter({
  authenticationController,
  authorizationMiddleware,
  rateLimit,
  stream,
}) {
  const appliedRouters = new WeakSet();

  return {
    /**
     * @param {{ post: (...args: any[]) => unknown }} webRouter
     */
    apply(webRouter) {
      if (appliedRouters.has(webRouter)) {
        return;
      }
      appliedRouters.add(webRouter);

      webRouter.post(
        "/project/:project_id/ai-reviewer/stream",
        authenticationController.requireLogin(),
        rateLimit,
        authorizationMiddleware.blockRestrictedUserFromProject,
        authorizationMiddleware.ensureUserCanReadProject,
        stream,
      );
    },
  };
}
