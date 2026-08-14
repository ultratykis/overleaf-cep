// @ts-check

import mongoose from "../../../../app/src/infrastructure/Mongoose.mjs";

const { ObjectId } = mongoose.Schema.Types;

export const AiReviewerCommentProvenanceSchema = new mongoose.Schema(
  {
    _id: { type: ObjectId, required: true },
    projectId: { type: ObjectId, ref: "Project", required: true },
    runId: { type: String, required: true, maxlength: 200 },
    artifactId: { type: String, required: true, maxlength: 200 },
    uncertain: { type: Boolean, required: true, default: true },
  },
  {
    collection: "aiReviewerCommentProvenances",
    strict: "throw",
    timestamps: false,
    versionKey: false,
  },
);

AiReviewerCommentProvenanceSchema.index(
  { projectId: 1, runId: 1, artifactId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      runId: { $exists: true },
      artifactId: { $exists: true },
    },
  },
);

export const AiReviewerCommentProvenance = mongoose.model(
  "AiReviewerCommentProvenance",
  AiReviewerCommentProvenanceSchema,
);
