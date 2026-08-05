// @ts-check

import { AiReviewerSkillParseError } from "./AiReviewerSkillParser.mjs";
import {
  AiReviewerSkillByteLimitError,
  AiReviewerSkillCountLimitError,
  AiReviewerSkillDuplicateNameError,
  AiReviewerSkillNotFoundError,
  AiReviewerSkillValidationError,
} from "./AiReviewerSkillStore.mjs";

/** @import { Request, Response } from 'express' */

/** @param {Request} request */
function userId(request) {
  const value = /** @type {any} */ (request.user)?._id?.toString?.();
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("authenticated user required");
  }
  return value;
}

/** @param {any} skill */
function publicSkill(skill) {
  return {
    id: skill.id,
    name: skill.name,
    description: skill.description,
  };
}

/** @param {Response} response @param {number} status @param {string} code @param {string} message */
function sendError(response, status, code, message) {
  return response.status(status).json({
    error: {
      code,
      category: "configuration",
      message,
      retryable: false,
    },
  });
}

/** @param {Response} response @param {any[]} skills */
function sendSkills(response, skills) {
  return response.json({ skills: skills.map(publicSkill) });
}

/**
 * Parser and store messages describe only bounded metadata constraints. They
 * are safe to return verbatim and let the settings UI tell the user which
 * local file needs correction without exposing stored skill content.
 *
 * @param {Response} response
 * @param {unknown} error
 */
function sendValidationError(response, error) {
  if (error instanceof AiReviewerSkillByteLimitError) {
    return sendError(
      response,
      413,
      "AI_REVIEWER_SKILL_BYTE_LIMIT_REACHED",
      error.message,
    );
  }
  if (error instanceof AiReviewerSkillCountLimitError) {
    return sendError(
      response,
      409,
      "AI_REVIEWER_SKILL_COUNT_LIMIT_REACHED",
      error.message,
    );
  }
  if (error instanceof AiReviewerSkillDuplicateNameError) {
    return sendError(
      response,
      409,
      "AI_REVIEWER_SKILL_DUPLICATE_NAME",
      error.message,
    );
  }
  if (
    error instanceof AiReviewerSkillParseError ||
    error instanceof AiReviewerSkillValidationError
  ) {
    return sendError(response, 400, "AI_REVIEWER_SKILL_INVALID", error.message);
  }
  return null;
}

/** @param {{ skillStore: any }} dependencies */
export function createAiReviewerSkillController({ skillStore }) {
  return {
    /** @param {Request} request @param {Response} response */
    async listSkills(request, response) {
      try {
        return sendSkills(response, await skillStore.list(userId(request)));
      } catch (error) {
        const validationResponse = sendValidationError(response, error);
        if (validationResponse != null) {
          return validationResponse;
        }
        return sendError(
          response,
          500,
          "AI_REVIEWER_SKILL_STORAGE_FAILED",
          "The AI reviewer skills could not be loaded.",
        );
      }
    },

    /** @param {Request} request @param {Response} response */
    async uploadSkill(request, response) {
      try {
        const skill = await skillStore.create(userId(request), {
          skillMarkdown: request.body?.skillMarkdown,
          referenceFiles: request.body?.referenceFiles,
        });
        return response.json(publicSkill(skill));
      } catch (error) {
        const validationResponse = sendValidationError(response, error);
        if (validationResponse != null) {
          return validationResponse;
        }
        return sendError(
          response,
          500,
          "AI_REVIEWER_SKILL_STORAGE_FAILED",
          "The AI reviewer skill could not be saved.",
        );
      }
    },

    /** @param {Request} request @param {Response} response */
    async deleteSkill(request, response) {
      try {
        await skillStore.remove(userId(request), request.params?.skill_id);
        return sendSkills(response, await skillStore.list(userId(request)));
      } catch (error) {
        if (error instanceof AiReviewerSkillNotFoundError) {
          return sendError(
            response,
            404,
            "AI_REVIEWER_SKILL_NOT_FOUND",
            error.message,
          );
        }
        const validationResponse = sendValidationError(response, error);
        if (validationResponse != null) {
          return validationResponse;
        }
        return sendError(
          response,
          500,
          "AI_REVIEWER_SKILL_STORAGE_FAILED",
          "The AI reviewer skill could not be deleted.",
        );
      }
    },
  };
}
