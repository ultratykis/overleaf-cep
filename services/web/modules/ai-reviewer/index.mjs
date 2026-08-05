// @ts-check

import Settings from "@overleaf/settings";

import hooks from "./app/src/AiReviewerCleanupHooks.mjs";

/** @import { WebModule } from '../../types/web-module' */

/**
 * Cleanup runs whether or not the feature is enabled. Data written while the
 * feature was on must still follow project and user deletion after it is
 * turned off, so the hooks are registered unconditionally and only the router
 * and background runtime sit behind the flag.
 *
 * @type {WebModule}
 */
let AiReviewerModule = { hooks };

if (Settings.aiReviewer?.enabled === true) {
  const { default: EnabledAiReviewerModule } =
    await import("./app/src/EnabledAiReviewerModule.mjs");
  AiReviewerModule = EnabledAiReviewerModule;
}

export default AiReviewerModule;
