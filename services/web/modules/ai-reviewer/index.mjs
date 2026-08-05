// @ts-check

import Settings from "@overleaf/settings";

/** @import { WebModule } from '../../types/web-module' */

/** @type {WebModule} */
let AiReviewerModule = {};

if (Settings.aiReviewer?.enabled === true) {
  const { default: EnabledAiReviewerModule } =
    await import("./app/src/EnabledAiReviewerModule.mjs");
  AiReviewerModule = EnabledAiReviewerModule;
}

export default AiReviewerModule;
