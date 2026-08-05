import { describe, expect, it, vi } from "vitest";

import { AiReviewerCommentProvenanceSchema } from "../../../app/models/AiReviewerCommentProvenance.mjs";
import { createAiReviewerCommentProvenanceController } from "../../../app/src/AiReviewerCommentProvenanceController.mjs";
import {
  AiReviewerCommentProvenanceValidationError,
  createAiReviewerCommentProvenanceStore,
} from "../../../app/src/AiReviewerCommentProvenanceStore.mjs";

const projectId = "669e48d55ee80e3a12940711";
const otherProjectId = "669e48d55ee80e3a12940712";
const commentId = "669e48d55ee80e3a12940721";
const otherCommentId = "669e48d55ee80e3a12940722";

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function fakeQuery(work) {
  return {
    exec: vi.fn(async () => clone(work())),
    lean() {
      return this;
    },
  };
}

function inMemoryModel() {
  const records = new Map();
  const model = {
    find: vi.fn((filter) =>
      fakeQuery(() =>
        [...records.values()].filter(
          (record) => record.projectId === filter.projectId,
        ),
      ),
    ),
    updateOne: vi.fn((filter, update, options = {}) =>
      fakeQuery(() => {
        const current = records.get(filter._id);
        if (current != null) {
          if (current.projectId !== filter.projectId) {
            const error = new Error("duplicate comment identifier");
            error.code = 11000;
            throw error;
          }
          if (update.$set != null) {
            Object.assign(current, clone(update.$set));
          }
          return {
            acknowledged: true,
            matchedCount: 1,
            modifiedCount: 0,
            upsertedCount: 0,
            upsertedId: null,
          };
        }
        if (!options.upsert) {
          return {
            acknowledged: true,
            matchedCount: 0,
            modifiedCount: 0,
            upsertedCount: 0,
            upsertedId: null,
          };
        }
        records.set(filter._id, clone(update.$setOnInsert));
        return {
          acknowledged: true,
          matchedCount: 0,
          modifiedCount: 0,
          upsertedCount: 1,
          upsertedId: filter._id,
        };
      }),
    ),
    deleteOne: vi.fn((filter) =>
      fakeQuery(() => {
        const current = records.get(filter._id);
        const deleted =
          current != null && current.projectId === filter.projectId;
        if (deleted) {
          records.delete(filter._id);
        }
        return {
          acknowledged: true,
          deletedCount: deleted ? 1 : 0,
        };
      }),
    ),
    deleteMany: vi.fn((filter) =>
      fakeQuery(() => {
        let deletedCount = 0;
        for (const [id, record] of records) {
          if (record.projectId === filter.projectId) {
            records.delete(id);
            deletedCount += 1;
          }
        }
        return { acknowledged: true, deletedCount };
      }),
    ),
  };
  return { model, records };
}

function fakeResponse() {
  return {
    statusCode: 200,
    body: undefined,
    ended: false,
    status: vi.fn(function (statusCode) {
      this.statusCode = statusCode;
      return this;
    }),
    json: vi.fn(function (body) {
      this.body = body;
      return this;
    }),
    end: vi.fn(function () {
      this.ended = true;
      return this;
    }),
  };
}

async function captureError(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the promise to reject.");
}

describe("AI reviewer comment provenance model and store", function () {
  it("stores only the project and comment identifiers", function () {
    expect(Object.keys(AiReviewerCommentProvenanceSchema.paths).sort()).toEqual(
      ["_id", "projectId", "uncertain"],
    );
    expect(AiReviewerCommentProvenanceSchema.options).toEqual(
      expect.objectContaining({
        collection: "aiReviewerCommentProvenances",
        strict: "throw",
        timestamps: false,
        versionKey: false,
      }),
    );
  });

  it("marks idempotently, lists by project, rolls back by id, and deletes by project", async function () {
    const { model, records } = inMemoryModel();
    const getThreadState = vi.fn(async () => ({ state: "current" }));
    const store = createAiReviewerCommentProvenanceStore({
      model,
      getThreadState,
    });

    expect(
      await store.mark(projectId.toUpperCase(), commentId.toUpperCase()),
    ).toEqual({
      commentId,
      created: true,
    });
    expect(await store.mark(projectId, commentId)).toEqual({
      commentId,
      created: false,
    });
    await store.mark(projectId, otherCommentId);
    await store.mark(otherProjectId, "669e48d55ee80e3a12940723");

    expect(await store.list(projectId)).toEqual([commentId, otherCommentId]);
    expect(await store.list(otherProjectId)).toEqual([
      "669e48d55ee80e3a12940723",
    ]);
    expect([...records.values()]).toEqual(
      expect.arrayContaining([
        { _id: commentId, projectId, uncertain: false },
        { _id: otherCommentId, projectId, uncertain: false },
      ]),
    );
    for (const record of records.values()) {
      expect(Object.keys(record).sort()).toEqual([
        "_id",
        "projectId",
        "uncertain",
      ]);
    }

    expect(await store.unmark(otherProjectId, commentId)).toBe(false);
    expect(await store.unmark(projectId, commentId)).toBe(true);
    expect(await store.list(projectId)).toEqual([otherCommentId]);

    await store.deleteProject(projectId);
    expect(await store.list(projectId)).toEqual([]);
    expect(await store.list(otherProjectId)).toEqual([
      "669e48d55ee80e3a12940723",
    ]);
    expect(model.deleteMany).toHaveBeenCalledWith({ projectId });
  });

  it("resolves uncertain reservations while listing comment provenance", async function () {
    const { model, records } = inMemoryModel();
    const states = new Map([
      [commentId, "current"],
      [otherCommentId, "absent"],
    ]);
    const getThreadState = vi.fn(async (_projectId, id) => ({
      state: states.get(id),
    }));
    const store = createAiReviewerCommentProvenanceStore({
      model,
      getThreadState,
    });

    await store.mark(projectId, commentId);
    await store.mark(projectId, otherCommentId);

    expect(await store.list(projectId)).toEqual([commentId]);
    expect(records.get(commentId)).toEqual({
      _id: commentId,
      projectId,
      uncertain: false,
    });
    expect(records.has(otherCommentId)).toBe(false);
    expect(getThreadState).toHaveBeenCalledTimes(2);
  });

  it("still lists provenance when the thread state cannot be reached", async function () {
    const { model, records } = inMemoryModel();
    const getThreadState = vi.fn(async () => {
      throw new Error("chat service unavailable");
    });
    const store = createAiReviewerCommentProvenanceStore({
      model,
      getThreadState,
    });

    await store.mark(projectId, commentId);

    expect(await store.list(projectId)).toEqual([commentId]);
    expect(records.get(commentId)).toEqual({
      _id: commentId,
      projectId,
      uncertain: true,
    });
  });

  it("rejects identifiers outside the existing ThreadId shape before storage", async function () {
    const { model } = inMemoryModel();
    const store = createAiReviewerCommentProvenanceStore({
      model,
      getThreadState: vi.fn(),
    });

    expect(
      await captureError(store.list("project-not-an-object-id")),
    ).toBeInstanceOf(AiReviewerCommentProvenanceValidationError);
    expect(
      await captureError(store.mark(projectId, "comment-not-an-object-id")),
    ).toBeInstanceOf(AiReviewerCommentProvenanceValidationError);
    expect(
      await captureError(store.unmark(projectId, "comment-not-an-object-id")),
    ).toBeInstanceOf(AiReviewerCommentProvenanceValidationError);
    expect(model.find).not.toHaveBeenCalled();
    expect(model.updateOne).not.toHaveBeenCalled();
    expect(model.deleteOne).not.toHaveBeenCalled();
  });
});

describe("AI reviewer comment provenance controller", function () {
  it("shares project provenance across authenticated users without accepting content", async function () {
    const { model, records } = inMemoryModel();
    const provenanceStore = createAiReviewerCommentProvenanceStore({
      model,
      getThreadState: vi.fn(async () => ({ state: "current" })),
    });
    const controller = createAiReviewerCommentProvenanceController({
      provenanceStore,
    });
    const markResponse = fakeResponse();
    const listResponse = fakeResponse();
    const deleteResponse = fakeResponse();

    await controller.markCommentProvenance(
      {
        user: { _id: "posting-user" },
        params: {
          project_id: projectId,
          comment_id: commentId,
        },
        body: {
          content: "PRIVATE_MANUSCRIPT_SENTINEL",
          modelOutput: "PRIVATE_MODEL_OUTPUT_SENTINEL",
        },
      },
      markResponse,
    );
    await controller.getCommentProvenance(
      {
        user: { _id: "collaborating-user" },
        params: { project_id: projectId },
      },
      listResponse,
    );

    expect(markResponse.body).toEqual({ commentId, created: true });
    expect(listResponse.body).toEqual({ commentIds: [commentId] });
    expect([...records.values()]).toEqual([
      { _id: commentId, projectId, uncertain: false },
    ]);

    await controller.deleteCommentProvenance(
      {
        user: { _id: "posting-user" },
        params: {
          project_id: projectId,
          comment_id: commentId,
        },
      },
      deleteResponse,
    );
    expect(deleteResponse.statusCode).toBe(204);
    expect(deleteResponse.ended).toBe(true);
    expect(records.size).toBe(0);
  });

  it("returns bounded validation and internal errors without private data", async function () {
    const validationController = createAiReviewerCommentProvenanceController({
      provenanceStore: createAiReviewerCommentProvenanceStore({
        model: inMemoryModel().model,
      }),
    });
    const validationResponse = fakeResponse();
    const privateSentinel = "PRIVATE_MANUSCRIPT_SENTINEL";
    const failureController = createAiReviewerCommentProvenanceController({
      provenanceStore: {
        list: vi.fn(async () => {
          throw new Error(privateSentinel);
        }),
      },
    });
    const failureResponse = fakeResponse();

    await validationController.getCommentProvenance(
      { params: { project_id: "invalid-project-id" } },
      validationResponse,
    );
    await failureController.getCommentProvenance(
      { params: { project_id: projectId } },
      failureResponse,
    );

    expect(validationResponse.statusCode).toBe(400);
    expect(validationResponse.body).toEqual({
      error: {
        code: "AI_REVIEWER_COMMENT_PROVENANCE_INVALID",
        message: "The AI-assisted comment provenance identifier is invalid.",
      },
    });
    expect(failureResponse.statusCode).toBe(500);
    expect(JSON.stringify(failureResponse.body)).not.toContain(privateSentinel);
    expect(failureResponse.body).toEqual({
      error: {
        code: "AI_REVIEWER_COMMENT_PROVENANCE_FAILED",
        message: "The AI-assisted comment provenance request failed.",
      },
    });
  });
});
