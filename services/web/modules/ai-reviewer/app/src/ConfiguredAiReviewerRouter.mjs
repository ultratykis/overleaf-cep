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
  listModels: AiReviewerController.listModels,
  testConnection: AiReviewerController.testConnection,
  listConnections: AiReviewerController.listConnections,
  createConnection: AiReviewerController.createConnection,
  updateConnection: AiReviewerController.updateConnection,
  deleteConnection: AiReviewerController.deleteConnection,
  resetCircuit: AiReviewerController.resetCircuit,
  listSkills: AiReviewerController.listSkills,
  uploadSkill: AiReviewerController.uploadSkill,
  previewSkillGitImport: AiReviewerController.previewSkillGitImport,
  confirmSkillGitImport: AiReviewerController.confirmSkillGitImport,
  deleteSkill: AiReviewerController.deleteSkill,
  stream: AiReviewerController.stream,
  completion: AiReviewerController.completion,
  getAgentSession: AiReviewerController.getAgentSession,
  resolveAgentSession: AiReviewerController.resolveAgentSession,
  reopenAgentSession: AiReviewerController.reopenAgentSession,
  getModeInstructions: AiReviewerController.getModeInstructions,
  saveModeInstructions: AiReviewerController.saveModeInstructions,
  getWorkspace: AiReviewerController.getWorkspace,
  saveWorkspace: AiReviewerController.saveWorkspace,
  getCommentProvenance: AiReviewerController.getCommentProvenance,
  markCommentProvenance: AiReviewerController.markCommentProvenance,
  deleteCommentProvenance: AiReviewerController.deleteCommentProvenance,
  deleteDiscussion: AiReviewerController.deleteDiscussion,
  deleteWorkspace: AiReviewerController.deleteWorkspace,
});
