// @ts-check

import mongoose from "../../../../app/src/infrastructure/Mongoose.mjs";

const { Mixed, ObjectId } = mongoose.Schema.Types;

export const AI_REVIEWER_SKILL_MAX_BYTES = 1024 * 1024;
export const AI_REVIEWER_SKILL_COUNT_LIMIT = 20;
export const AI_REVIEWER_SKILL_NAME_MAX_LENGTH = 100;
export const AI_REVIEWER_SKILL_DESCRIPTION_MAX_LENGTH = 500;

export const AiReviewerStoredSkillSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    name: {
      type: String,
      required: true,
      maxlength: AI_REVIEWER_SKILL_NAME_MAX_LENGTH,
    },
    description: {
      type: String,
      required: true,
      maxlength: AI_REVIEWER_SKILL_DESCRIPTION_MAX_LENGTH,
    },
    body: { type: String, default: "" },
    referenceFiles: { type: Mixed, required: true },
  },
  { _id: false, strict: "throw", versionKey: false },
);

export const AiReviewerSkillSchema = new mongoose.Schema(
  {
    _id: { type: ObjectId, ref: "User", required: true },
    revision: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: "revision must be a non-negative safe integer.",
      },
    },
    skills: {
      type: [AiReviewerStoredSkillSchema],
      required: true,
      default: [],
      validate: {
        validator: (/** @type {unknown[]} */ value) =>
          value.length <= AI_REVIEWER_SKILL_COUNT_LIMIT,
        message: "A user may not keep more than 20 AI reviewer skills.",
      },
    },
  },
  {
    collection: "aiReviewerSkills",
    strict: "throw",
    timestamps: true,
    versionKey: false,
  },
);

export const AiReviewerSkill = mongoose.model(
  "AiReviewerSkill",
  AiReviewerSkillSchema,
);

export function newAiReviewerSkillId() {
  return new mongoose.Types.ObjectId().toString();
}
