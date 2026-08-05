// @ts-check

import mongoose from "../../../../app/src/infrastructure/Mongoose.mjs";

const { ObjectId } = mongoose.Schema;

export const AI_REVIEWER_CONNECTION_LIMIT = 10;

const contextLength = {
  type: Number,
  min: 1,
  max: Number.MAX_SAFE_INTEGER,
  validate: {
    validator: Number.isSafeInteger,
    message: "contextLength must be a positive safe integer.",
  },
};

const ModelContextLengthOverrideSchema = new mongoose.Schema(
  {
    model: { type: String, required: true },
    contextLength: { ...contextLength, required: true },
  },
  { _id: false, strict: "throw", versionKey: false },
);

export const AiReviewerProviderConnectionSchema = new mongoose.Schema(
  {
    // Connection identifiers are server-issued so a user cannot name one after
    // another user's connection or smuggle a lookup key of their own choosing.
    _id: { type: ObjectId, required: true },
    provider: { type: String, required: true },
    baseUrl: { type: String },
    requestStyle: { type: String, enum: ["v1", "deployment"] },
    apiVersion: { type: String },
    deployments: { type: [String], default: undefined },
    // Azure deployment names cannot identify their underlying model. Bind each
    // user-supplied limit to that exact name rather than sharing one guess.
    contextLengthOverrides: {
      type: [ModelContextLengthOverrideSchema],
      default: undefined,
    },
    // These are fallback catalogue entries, not a selected model. They are used
    // only when the destination cannot expose a model list of its own.
    models: { type: [String], default: undefined },
    // Only a name the user typed is stored. An absent one is derived on read,
    // so an existing connection gains a name without a migration.
    label: { type: String },
    credentialEncrypted: { type: String },
    credentialUpdatedAt: { type: Date },
    // The escape hatch for a model whose advertised context length is wrong.
    // The effective value is resolved per review, not stored here.
    contextLengthOverride: contextLength,
    // The parent document revision serializes all connection writes. This
    // connection-local revision distinguishes a real edit/delete conflict
    // from a harmless write to another connection in the same document.
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
  },
  { strict: "throw", versionKey: false },
);

export const AiReviewerProviderConfigSchema = new mongoose.Schema(
  {
    _id: { type: ObjectId, ref: "User", required: true },
    connections: {
      type: [AiReviewerProviderConnectionSchema],
      default: undefined,
      validate: {
        validator: (/** @type {unknown[] | null} */ value) =>
          value == null || value.length <= AI_REVIEWER_CONNECTION_LIMIT,
        message: "A user may not keep more than 10 AI provider connections.",
      },
    },
    // The fields below hold the single connection this module stored before
    // connections became a list, together with the model and context length a
    // connection no longer owns. They are read once and unset by the first
    // write, so they are no longer required.
    provider: { type: String },
    baseUrl: { type: String },
    model: { type: String },
    credentialEncrypted: { type: String },
    credentialUpdatedAt: { type: Date },
    contextLength,
    contextLengthSource: {
      type: String,
      enum: ["derived", "detected", "default", "override"],
    },
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

export function newAiReviewerConnectionId() {
  return new mongoose.Types.ObjectId();
}
