// @ts-check

import mongoose from "../../../../app/src/infrastructure/Mongoose.mjs";

const { Mixed, ObjectId } = mongoose.Schema.Types;

export const AiReviewerWorkspaceSchema = new mongoose.Schema(
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
    workspace: { type: Mixed, required: true },
  },
  {
    collection: "aiReviewerWorkspaces",
    minimize: false,
    strict: "throw",
    timestamps: true,
    versionKey: false,
  },
);

export const AiReviewerWorkspace = mongoose.model(
  "AiReviewerWorkspace",
  AiReviewerWorkspaceSchema,
);
