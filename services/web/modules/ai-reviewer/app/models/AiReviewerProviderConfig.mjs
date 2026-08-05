// @ts-check

import mongoose from "../../../../app/src/infrastructure/Mongoose.mjs";

const { ObjectId } = mongoose.Schema;

export const AiReviewerProviderConfigSchema = new mongoose.Schema(
  {
    _id: { type: ObjectId, ref: "User", required: true },
    provider: { type: String, required: true },
    baseUrl: { type: String, required: true },
    model: { type: String, required: true },
    credentialEncrypted: { type: String },
    credentialUpdatedAt: { type: Date },
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
    contextLength: {
      type: Number,
      required: true,
      min: 1,
      max: Number.MAX_SAFE_INTEGER,
      validate: {
        validator: Number.isSafeInteger,
        message: "contextLength must be a positive safe integer.",
      },
    },
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
