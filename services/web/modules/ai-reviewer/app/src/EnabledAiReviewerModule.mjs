// @ts-check

/** @import { WebModule } from '../../../../types/web-module' */

import hooks from "./AiReviewerCleanupHooks.mjs";

async function start() {
  // The enabled shell has no background runtime.
}

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
  hooks,
  router,
  start,
};

export default EnabledAiReviewerModule;
