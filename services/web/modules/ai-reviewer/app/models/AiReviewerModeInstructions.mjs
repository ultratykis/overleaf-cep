// @ts-check

import mongoose from "../../../../app/src/infrastructure/Mongoose.mjs";

const { Mixed, ObjectId } = mongoose.Schema.Types;

export const AiReviewerModeInstructionsSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    userId: { type: ObjectId, ref: "User", required: true },
    projectId: { type: ObjectId, ref: "Project", required: true },
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
    instructions: { type: Mixed, required: true },
  },
  {
    collection: "aiReviewerModeInstructions",
    minimize: false,
    strict: "throw",
    timestamps: true,
    versionKey: false,
  },
);

export const AiReviewerModeInstructions = mongoose.model(
  "AiReviewerModeInstructions",
  AiReviewerModeInstructionsSchema,
);
