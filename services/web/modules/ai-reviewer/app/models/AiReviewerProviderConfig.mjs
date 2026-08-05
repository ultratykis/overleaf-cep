// @ts-check

import mongoose from "../../../../app/src/infrastructure/Mongoose.mjs";

const { ObjectId } = mongoose.Schema;

export const AiReviewerProviderConfigSchema = new mongoose.Schema(
  {
    _id: { type: ObjectId, ref: "User", required: true },
    provider: { type: String, required: true },
    baseUrl: { type: String, required: true },
    model: { type: String, required: true },
  },
  {
    collection: "aiReviewerProviderConfigs",
    strict: "throw",
    timestamps: true,
    versionKey: false,
  },
);

export const AiReviewerProviderConfig = mongoose.model(
  "AiReviewerProviderConfig",
  AiReviewerProviderConfigSchema,
);
