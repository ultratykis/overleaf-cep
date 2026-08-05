// @ts-check

import { RateLimiter } from "../../../../app/src/infrastructure/RateLimiter.mjs";
import AuthenticationController from "../../../../app/src/Features/Authentication/AuthenticationController.mjs";
import AuthorizationMiddleware from "../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs";
import RateLimiterMiddleware from "../../../../app/src/Features/Security/RateLimiterMiddleware.mjs";
import AiReviewerController from "./ConfiguredAiReviewerController.mjs";
import { createAiReviewerRouter } from "./AiReviewerRouter.mjs";

const requestRateLimiter = new RateLimiter("ai-reviewer-stream", {
  points: 30,
  duration: 60,
});

export default createAiReviewerRouter({
  authenticationController: AuthenticationController,
  authorizationMiddleware: AuthorizationMiddleware,
  rateLimit: RateLimiterMiddleware.rateLimit(requestRateLimiter, {
    params: ["project_id"],
  }),
  getConfiguration: AiReviewerController.getConfiguration,
  saveConfiguration: AiReviewerController.saveConfiguration,
  testConnection: AiReviewerController.testConnection,
  stream: AiReviewerController.stream,
  discussionStream: AiReviewerController.discussionStream,
});
