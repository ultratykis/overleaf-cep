// @ts-check

import mongoose from "../../../../app/src/infrastructure/Mongoose.mjs";

const { ObjectId } = mongoose.Schema.Types;

export const AiReviewerCommentProvenanceSchema = new mongoose.Schema(
  {
    _id: { type: ObjectId, required: true },
    projectId: { type: ObjectId, ref: "Project", required: true },
  },
  {
    collection: "aiReviewerCommentProvenances",
    strict: "throw",
    timestamps: false,
    versionKey: false,
  },
);

export const AiReviewerCommentProvenance = mongoose.model(
  "AiReviewerCommentProvenance",
  AiReviewerCommentProvenanceSchema,
);
