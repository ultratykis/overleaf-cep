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
const replyMessageId = "669e48d55ee80e3a12940724";
const runId = "run-141";
const artifactId = "artifact-141";
const otherArtifactId = "artifact-142";

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
    findOne: vi.fn((filter) =>
      fakeQuery(() =>
        [...records.values()].find((record) =>
          Object.entries(filter).every(([key, value]) => record[key] === value),
        ),
      ),
    ),
    updateOne: vi.fn((filter, update, options = {}) =>
      fakeQuery(() => {
        const current = [...records.values()].find((record) =>
          Object.entries(filter).every(([key, value]) => record[key] === value),
        );
        if (current != null) {
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
        if (update.$setOnInsert != null) {
          const duplicate = [...records.values()].some(
            (record) =>
              record._id === update.$setOnInsert._id ||
              (record.projectId === update.$setOnInsert.projectId &&
                record.runId === update.$setOnInsert.runId &&
                record.artifactId === update.$setOnInsert.artifactId),
          );
          if (duplicate) {
            const error = new Error("duplicate provenance key");
            error.code = 11000;
            throw error;
          }
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
        records.set(update.$setOnInsert._id, clone(update.$setOnInsert));
        return {
          acknowledged: true,
          matchedCount: 0,
          modifiedCount: 0,
          upsertedCount: 1,
          upsertedId: update.$setOnInsert._id,
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
  it("stores only the keyed identifiers and confirmation state", function () {
    expect(Object.keys(AiReviewerCommentProvenanceSchema.paths).sort()).toEqual(
      [
        "_id",
        "artifactId",
        "projectId",
        "replyMessageId",
        "replyThreadId",
        "runId",
        "uncertain",
      ],
    );
    expect(AiReviewerCommentProvenanceSchema.options).toEqual(
      expect.objectContaining({
        collection: "aiReviewerCommentProvenances",
        strict: "throw",
        timestamps: false,
        versionKey: false,
      }),
    );
    expect(AiReviewerCommentProvenanceSchema.indexes()).toContainEqual([
      { projectId: 1, runId: 1, artifactId: 1 },
      expect.objectContaining({
        unique: true,
        partialFilterExpression: {
          runId: { $exists: true },
          artifactId: { $exists: true },
        },
      }),
    ]);
  });

  it("marks idempotently, lists by project, rolls back by id, and deletes by project", async function () {
    const { model, records } = inMemoryModel();
    const getThreadState = vi.fn(async () => ({ state: "current" }));
    const store = createAiReviewerCommentProvenanceStore({
      model,
      getThreadState,
    });

    expect(
      await store.mark(
        projectId.toUpperCase(),
        commentId.toUpperCase(),
        runId,
        artifactId,
      ),
    ).toEqual({
      commentId,
      created: true,
      confirmed: false,
    });
    expect(
      await store.mark(projectId, otherCommentId, runId, artifactId),
    ).toEqual({
      commentId,
      created: false,
      confirmed: false,
    });
    await store.mark(projectId, otherCommentId, runId, otherArtifactId);
    await store.mark(
      otherProjectId,
      "669e48d55ee80e3a12940723",
      runId,
      artifactId,
    );

    expect(await store.list(projectId)).toEqual([commentId, otherCommentId]);
    expect(await store.list(otherProjectId)).toEqual([
      "669e48d55ee80e3a12940723",
    ]);
    expect([...records.values()]).toEqual(
      expect.arrayContaining([
        { _id: commentId, projectId, runId, artifactId, uncertain: false },
        {
          _id: otherCommentId,
          projectId,
          runId,
          artifactId: otherArtifactId,
          uncertain: false,
        },
      ]),
    );
    for (const record of records.values()) {
      expect(Object.keys(record).sort()).toEqual([
        "_id",
        "artifactId",
        "projectId",
        "runId",
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

    await store.mark(projectId, commentId, runId, artifactId);
    await store.mark(projectId, otherCommentId, runId, otherArtifactId);

    expect(await store.list(projectId)).toEqual([commentId]);
    expect(records.get(commentId)).toEqual({
      _id: commentId,
      projectId,
      runId,
      artifactId,
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

    await store.mark(projectId, commentId, runId, artifactId);

    expect(await store.list(projectId)).toEqual([commentId]);
    expect(records.get(commentId)).toEqual({
      _id: commentId,
      projectId,
      runId,
      artifactId,
      uncertain: true,
    });
  });

  it("looks up one keyed claim and confirms it only from an existing thread", async function () {
    const { model } = inMemoryModel();
    const getThreadState = vi
      .fn()
      .mockResolvedValueOnce({ state: "absent" })
      .mockResolvedValueOnce({ state: "current" });
    const store = createAiReviewerCommentProvenanceStore({
      model,
      getThreadState,
    });

    await store.mark(projectId, commentId, runId, artifactId);
    expect(await store.lookup(projectId, runId, artifactId)).toEqual({
      commentId,
      confirmed: false,
    });
    expect(await store.lookup(projectId, runId, artifactId)).toEqual({
      commentId,
      confirmed: true,
    });
    expect(await store.lookup(projectId, runId, otherArtifactId)).toBeNull();
  });

  it("marks one reply message without marking its human-started thread", async function () {
    const { model, records } = inMemoryModel();
    const getThreadState = vi.fn();
    const store = createAiReviewerCommentProvenanceStore({
      model,
      getThreadState,
    });

    expect(
      await store.mark(projectId, commentId, runId, artifactId, otherCommentId),
    ).toEqual({
      commentId,
      created: true,
      confirmed: false,
      threadId: otherCommentId,
      messageId: null,
    });
    expect(await store.list(projectId)).toEqual([]);
    expect(await store.lookup(projectId, runId, artifactId)).toEqual({
      commentId,
      confirmed: false,
      threadId: otherCommentId,
      messageId: null,
    });

    expect(
      await store.confirmReply(
        projectId,
        commentId,
        runId,
        artifactId,
        otherCommentId,
        replyMessageId,
      ),
    ).toEqual({
      commentId,
      confirmed: true,
      threadId: otherCommentId,
      messageId: replyMessageId,
    });
    expect(await store.list(projectId)).toEqual([replyMessageId]);
    expect(records.get(commentId)).toEqual({
      _id: commentId,
      projectId,
      runId,
      artifactId,
      replyThreadId: otherCommentId,
      replyMessageId,
      uncertain: false,
    });
    expect(getThreadState).not.toHaveBeenCalled();
  });

  it("rejects a keyed collision between a new thread and a reply", async function () {
    const { model } = inMemoryModel();
    const store = createAiReviewerCommentProvenanceStore({
      model,
      getThreadState: vi.fn(),
    });

    await store.mark(projectId, commentId, runId, artifactId);
    expect(
      await captureError(
        store.mark(projectId, otherCommentId, runId, artifactId, commentId),
      ),
    ).toBeInstanceOf(AiReviewerCommentProvenanceValidationError);
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
      await captureError(
        store.mark(projectId, "comment-not-an-object-id", runId, artifactId),
      ),
    ).toBeInstanceOf(AiReviewerCommentProvenanceValidationError);
    expect(
      await captureError(store.unmark(projectId, "comment-not-an-object-id")),
    ).toBeInstanceOf(AiReviewerCommentProvenanceValidationError);
    for (const malformed of ["", "x".repeat(201)]) {
      expect(
        await captureError(store.lookup(projectId, malformed, artifactId)),
      ).toBeInstanceOf(AiReviewerCommentProvenanceValidationError);
      expect(
        await captureError(store.lookup(projectId, runId, malformed)),
      ).toBeInstanceOf(AiReviewerCommentProvenanceValidationError);
      expect(
        await captureError(
          store.mark(projectId, commentId, malformed, artifactId),
        ),
      ).toBeInstanceOf(AiReviewerCommentProvenanceValidationError);
      expect(
        await captureError(store.mark(projectId, commentId, runId, malformed)),
      ).toBeInstanceOf(AiReviewerCommentProvenanceValidationError);
    }
    expect(model.find).not.toHaveBeenCalled();
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
        query: { runId, artifactId },
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

    expect(markResponse.body).toEqual({
      commentId,
      created: true,
      confirmed: false,
    });
    expect(listResponse.body).toEqual({ commentIds: [commentId] });
    expect([...records.values()]).toEqual([
      { _id: commentId, projectId, runId, artifactId, uncertain: false },
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

  it("looks up a reservation through the existing provenance collection route", async function () {
    const provenanceStore = {
      lookup: vi.fn(async () => ({ commentId, confirmed: false })),
      list: vi.fn(),
    };
    const controller = createAiReviewerCommentProvenanceController({
      provenanceStore,
    });
    const response = fakeResponse();

    await controller.getCommentProvenance(
      {
        params: { project_id: projectId },
        query: { runId, artifactId },
      },
      response,
    );

    expect(response.body).toEqual({
      reservation: { commentId, confirmed: false },
    });
    expect(provenanceStore.lookup).toHaveBeenCalledWith(
      projectId,
      runId,
      artifactId,
    );
    expect(provenanceStore.list).not.toHaveBeenCalled();
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
