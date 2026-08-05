import { describe, expect, it, vi } from "vitest";

import { AiReviewerModeInstructionsSchema as AiReviewerModeInstructionsModelSchema } from "../../../app/models/AiReviewerModeInstructions.mjs";
import { createAiReviewerModeInstructionController } from "../../../app/src/AiReviewerModeInstructionController.mjs";
import {
  AiReviewerModeInstructionConflictError,
  AiReviewerModeInstructionValidationError,
  createAiReviewerModeInstructionStore,
} from "../../../app/src/AiReviewerModeInstructionStore.mjs";
import { AI_REVIEWER_MODE_INSTRUCTION_MAX_LENGTH } from "../../../shared/contracts.mjs";

const userId = "user-mode-instructions-0001";
const otherUserId = "user-mode-instructions-0002";
const projectId = "project-mode-instructions-0001";
const otherProjectId = "project-mode-instructions-0002";

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function fakeQuery(work) {
  const query = { exec: vi.fn(async () => clone(work())) };
  query.lean = vi.fn(() => query);
  return query;
}

function recordKey(scopedUserId, scopedProjectId) {
  return `${scopedUserId}:${scopedProjectId}`;
}

function inMemoryModel() {
  const records = new Map();
  const model = {
    findOne: vi.fn((filter) =>
      fakeQuery(() => records.get(recordKey(filter.userId, filter.projectId))),
    ),
    findOneAndUpdate: vi.fn((filter, update, options) =>
      fakeQuery(() => {
        const key = recordKey(filter.userId, filter.projectId);
        const current = records.get(key);
        if (
          current != null &&
          current.revision !== filter.revision &&
          options.upsert
        ) {
          const error = new Error("duplicate key");
          error.code = 11000;
          throw error;
        }
        if (
          (current == null && !options.upsert) ||
          (current != null && current.revision !== filter.revision) ||
          (current == null && filter.revision !== 0)
        ) {
          return null;
        }
        const record = {
          _id: filter._id,
          userId: filter.userId,
          projectId: filter.projectId,
          revision: (current?.revision ?? 0) + update.$inc.revision,
          instructions: clone(update.$set.instructions),
        };
        records.set(key, record);
        return record;
      }),
    ),
    deleteMany: vi.fn((filter) =>
      fakeQuery(() => {
        let deletedCount = 0;
        for (const [key, record] of records) {
          if (
            (filter.userId == null || record.userId === filter.userId) &&
            (filter.projectId == null || record.projectId === filter.projectId)
          ) {
            records.delete(key);
            deletedCount += 1;
          }
        }
        return { acknowledged: true, deletedCount };
      }),
    ),
  };
  return { model, records };
}

async function captureError(work) {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject.");
}

function httpRequest({ body, authenticatedUserId = userId } = {}) {
  return {
    body,
    params: { project_id: projectId },
    user: { _id: { toString: () => authenticatedUserId } },
  };
}

class FakeResponse {
  constructor() {
    this.statusCode = 200;
    this.body = undefined;
  }

  status(statusCode) {
    this.statusCode = statusCode;
    return this;
  }

  json(body) {
    this.body = body;
    return this;
  }
}

describe("AI reviewer mode instruction persistence", function () {
  it("stores one strict record for each user and project pair", function () {
    expect(AiReviewerModeInstructionsModelSchema.path("_id").instance).toBe(
      "String",
    );
    expect(
      AiReviewerModeInstructionsModelSchema.path("userId").options.ref,
    ).toBe("User");
    expect(
      AiReviewerModeInstructionsModelSchema.path("projectId").options.ref,
    ).toBe("Project");
  });

  it("saves both modes independently and resets either one to its built-in", async function () {
    const { model } = inMemoryModel();
    const store = createAiReviewerModeInstructionStore({ model });
    const instructions = {
      "referee-review": "Check whether the evidence supports every claim.",
      brainstorm: "Generate rival framings before recommending one.",
    };

    expect(await store.save(userId, projectId, instructions, 0)).toEqual({
      revision: 1,
      instructions,
    });
    expect(
      await store.save(
        userId,
        projectId,
        { brainstorm: instructions.brainstorm },
        1,
      ),
    ).toEqual({
      revision: 2,
      instructions: { brainstorm: instructions.brainstorm },
    });
  });

  it("accepts the production limit and rejects one character more", async function () {
    const { model } = inMemoryModel();
    const store = createAiReviewerModeInstructionStore({ model });
    const maximum = "観".repeat(AI_REVIEWER_MODE_INSTRUCTION_MAX_LENGTH);

    expect(
      await store.save(userId, projectId, { "referee-review": maximum }, 0),
    ).toMatchObject({ revision: 1 });
    expect(
      await captureError(
        store.save(userId, otherProjectId, { brainstorm: `${maximum}点` }, 0),
      ),
    ).toBeInstanceOf(AiReviewerModeInstructionValidationError);
  });

  it("never mixes another user's perspective in the same project", async function () {
    const { model } = inMemoryModel();
    const store = createAiReviewerModeInstructionStore({ model });
    const mine = { "referee-review": "MY_PRIVATE_REVIEW_PERSPECTIVE" };
    const theirs = { "referee-review": "OTHER_PRIVATE_REVIEW_PERSPECTIVE" };

    await store.save(userId, projectId, mine, 0);
    await store.save(otherUserId, projectId, theirs, 0);

    expect(await store.load(userId, projectId)).toEqual({
      revision: 1,
      instructions: mine,
    });
    expect(await store.load(otherUserId, projectId)).toEqual({
      revision: 1,
      instructions: theirs,
    });
    const filters = model.findOne.mock.calls.map(([filter]) => filter);
    expect(filters).toEqual([
      expect.objectContaining({ userId, projectId }),
      expect.objectContaining({ userId: otherUserId, projectId }),
    ]);
    expect(filters[0]._id).not.toBe(filters[1]._id);
  });

  it("uses revision CAS and preserves the winning perspective", async function () {
    const { model } = inMemoryModel();
    const store = createAiReviewerModeInstructionStore({ model });
    const first = { brainstorm: "Explore the design space." };
    const winner = { brainstorm: "Compare two concrete designs." };

    await store.save(userId, projectId, first, 0);
    await store.save(userId, projectId, winner, 1);
    expect(
      await captureError(store.save(userId, projectId, first, 1)),
    ).toBeInstanceOf(AiReviewerModeInstructionConflictError);
    expect(await store.load(userId, projectId)).toEqual({
      revision: 2,
      instructions: winner,
    });
  });

  it("deletes settings by project and by user", async function () {
    const { model, records } = inMemoryModel();
    const store = createAiReviewerModeInstructionStore({ model });
    await store.save(userId, projectId, { brainstorm: "Mine." }, 0);
    await store.save(otherUserId, projectId, { brainstorm: "Theirs." }, 0);
    await store.save(userId, otherProjectId, { brainstorm: "Elsewhere." }, 0);

    await store.deleteProject(projectId);
    expect(records.size).toBe(1);
    await store.deleteUser(userId);
    expect(records.size).toBe(0);
  });
});

describe("AI reviewer mode instruction controller", function () {
  it("derives ownership only from the authenticated user and routed project", async function () {
    const modeInstructionStore = {
      load: vi.fn(async () => ({ revision: 3, instructions: {} })),
      save: vi.fn(async (_userId, _projectId, instructions) => ({
        revision: 4,
        instructions,
      })),
    };
    const controller = createAiReviewerModeInstructionController({
      modeInstructionStore,
    });
    const getResponse = new FakeResponse();
    const saveResponse = new FakeResponse();

    await controller.getModeInstructions(httpRequest(), getResponse);
    await controller.saveModeInstructions(
      httpRequest({
        body: {
          revision: 3,
          instructions: { brainstorm: "Question the framing." },
        },
      }),
      saveResponse,
    );

    expect(modeInstructionStore.load).toHaveBeenCalledExactlyOnceWith(
      userId,
      projectId,
    );
    expect(modeInstructionStore.save).toHaveBeenCalledExactlyOnceWith(
      userId,
      projectId,
      { brainstorm: "Question the framing." },
      3,
    );
    expect(saveResponse.body).toEqual({
      revision: 4,
      instructions: { brainstorm: "Question the framing." },
    });
  });

  it("maps invalid input and stale revisions without exposing internals", async function () {
    const modeInstructionStore = {
      load: vi.fn(),
      save: vi
        .fn()
        .mockRejectedValueOnce(new AiReviewerModeInstructionConflictError()),
    };
    const controller = createAiReviewerModeInstructionController({
      modeInstructionStore,
    });
    const invalidResponse = new FakeResponse();
    const conflictResponse = new FakeResponse();

    await controller.saveModeInstructions(
      httpRequest({ body: { revision: 0, instructions: {}, userId } }),
      invalidResponse,
    );
    await controller.saveModeInstructions(
      httpRequest({ body: { revision: 1, instructions: {} } }),
      conflictResponse,
    );

    expect(invalidResponse.statusCode).toBe(400);
    expect(invalidResponse.body.error.code).toBe(
      "AI_REVIEWER_MODE_INSTRUCTIONS_INVALID",
    );
    expect(conflictResponse.statusCode).toBe(409);
    expect(conflictResponse.body.error.code).toBe(
      "AI_REVIEWER_MODE_INSTRUCTIONS_CHANGED",
    );
  });
});
