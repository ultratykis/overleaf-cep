// @ts-check

/** @import { WebModule } from '../../../../types/web-module' */

/**
 * Startup remains inert. The authenticated router creates provider state only
 * when a user explicitly starts a request.
 */
async function start() {}

const configuredRouterPath = "./ConfiguredAiReviewerRouter.mjs";

const router = {
  /**
   * @param {any} webRouter
   * @param {any} privateApiRouter
   * @param {any} publicApiRouter
   */
  apply(webRouter, privateApiRouter, publicApiRouter) {
    return import(configuredRouterPath).then(
      (
        /** @type {{ default: { apply: Function } }} */ {
          default: AiReviewerRouter,
        },
      ) => AiReviewerRouter.apply(webRouter, privateApiRouter, publicApiRouter),
    );
  },
};

/** @type {WebModule} */
const EnabledAiReviewerModule = {
  router,
  start,
};

export default EnabledAiReviewerModule;
