// @ts-check

import mongoose from "../../../../app/src/infrastructure/Mongoose.mjs";

const { ObjectId } = mongoose.Schema.Types;

const nonNegativeSafeInteger = {
  type: Number,
  required: true,
  min: 0,
  validate: {
    validator: Number.isSafeInteger,
    message: "value must be a non-negative safe integer.",
  },
};

const AiReviewerExternalAgentOperationClaimSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    type: {
      type: String,
      enum: ["turn", "resolve", "reopen", "purge"],
      required: true,
    },
    claimedAt: { type: Date, required: true },
  },
  { _id: false, strict: "throw", versionKey: false },
);

export const AiReviewerExternalAgentSessionSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    userId: { type: ObjectId, ref: "User", required: true },
    projectId: { type: ObjectId, ref: "Project", required: true },
    clientSessionId: { type: String, required: true },
    mode: { type: String, enum: ["review", "agent"], required: true },
    threadId: { type: String, default: null },
    stateRootKey: { type: String, required: true },
    connectionFingerprint: { type: String, required: true },
    status: {
      type: String,
      enum: ["active", "resolved", "purge_failed"],
      required: true,
    },
    lastActivityAt: { type: Date, required: true },
    stateBytes: nonNegativeSafeInteger,
    revision: nonNegativeSafeInteger,
    operationClaim: {
      type: AiReviewerExternalAgentOperationClaimSchema,
      default: null,
    },
  },
  {
    collection: "aiReviewerExternalAgentSessions",
    strict: "throw",
    timestamps: false,
    versionKey: false,
  },
);

export const AiReviewerExternalAgentSession = mongoose.model(
  "AiReviewerExternalAgentSession",
  AiReviewerExternalAgentSessionSchema,
);
