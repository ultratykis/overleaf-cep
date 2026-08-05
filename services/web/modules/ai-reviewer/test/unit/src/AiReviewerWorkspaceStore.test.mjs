import { describe, expect, it, vi } from "vitest";

import { AiReviewerWorkspaceSchema as AiReviewerWorkspaceModelSchema } from "../../../app/models/AiReviewerWorkspace.mjs";
import { createAiReviewerWorkspaceController } from "../../../app/src/AiReviewerWorkspaceController.mjs";
import {
  AiReviewerWorkspaceConflictError,
  AiReviewerWorkspaceLimitError,
  AiReviewerWorkspaceValidationError,
  createAiReviewerWorkspaceStore,
} from "../../../app/src/AiReviewerWorkspaceStore.mjs";
import {
  AI_REVIEWER_WORKSPACE_DISCUSSION_LIMIT,
  AI_REVIEWER_WORKSPACE_TURN_LIMIT,
} from "../../../shared/contracts.mjs";

const userId = "user-workspace-0001";
const otherUserId = "user-workspace-0002";
const projectId = "project-workspace-0001";
const otherProjectId = "project-workspace-0002";
const createdAt = "2026-07-25T00:00:00.000Z";
const hash = "a".repeat(64);

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function fakeQuery(work) {
  const query = {
    exec: vi.fn(async () => clone(work())),
  };
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
          (!records.has(key) && !options.upsert) ||
          (current != null &&
            filter.revision != null &&
            current.revision !== filter.revision) ||
          (current == null && filter.revision != null && filter.revision !== 0)
        ) {
          return null;
        }
        const record = {
          _id: filter._id,
          userId: filter.userId,
          projectId: filter.projectId,
          revision: (current?.revision ?? 0) + (update.$inc?.revision ?? 0),
          workspace: clone(update.$set.workspace),
        };
        records.set(key, record);
        return record;
      }),
    ),
    deleteOne: vi.fn((filter) =>
      fakeQuery(() => ({
        acknowledged: true,
        deletedCount: records.delete(recordKey(filter.userId, filter.projectId))
          ? 1
          : 0,
      })),
    ),
    deleteMany: vi.fn((filter) =>
      fakeQuery(() => {
        let deletedCount = 0;
        for (const [key, record] of records) {
          if (
            (filter.projectId == null ||
              record.projectId === filter.projectId) &&
            (filter.userId == null || record.userId === filter.userId)
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

function request(requestId, scopedProjectId = projectId) {
  return {
    requestId,
    projectId: scopedProjectId,
    action: "review",
    instruction: "Review this synthetic selection.",
    skill: "line-edit",
    scope: {
      kind: "selection",
      documentId: "document-workspace-0001",
      path: "chapters/introduction.tex",
      baseRevision: 12,
      baseTextHash: hash,
      range: { from: 0, to: 15 },
      text: "Synthetic text.",
    },
  };
}

function findingArtifact(sourceRequest, id) {
  return {
    id,
    requestId: sourceRequest.requestId,
    projectId: sourceRequest.projectId,
    severity: "warning",
    category: "synthetic",
    title: "Synthetic finding",
    message: "A deterministic finding.",
    evidence: [
      {
        path: "chapters/introduction.tex",
        range: { from: 0, to: 15 },
        revision: 12,
        textHash: hash,
      },
    ],
    suggestionIds: [],
    artifactKind: "finding",
  };
}

function suggestionArtifact(sourceRequest, id, status = "unresolved") {
  return {
    id,
    requestId: sourceRequest.requestId,
    projectId: sourceRequest.projectId,
    documentId: "document-workspace-0001",
    path: "chapters/introduction.tex",
    baseRevision: 12,
    baseTextHash: hash,
    range: { from: 0, to: 15 },
    original: "Synthetic text.",
    replacement: "Revised text.",
    rationale: "The shorter wording is clearer.",
    evidence: [
      {
        path: "chapters/introduction.tex",
        range: { from: 0, to: 15 },
        revision: 12,
        textHash: hash,
      },
    ],
    provider: "fake",
    model: "deterministic-v1",
    skill: "line-edit",
    createdAt,
    status,
  };
}

function workspaceRun({
  requestId,
  generation,
  createdOrder,
  text = `Stored summary for ${requestId}.`,
  findingStatus,
  suggestionStatus,
}) {
  const sourceRequest = request(requestId);
  return {
    generation,
    createdOrder,
    request: sourceRequest,
    text,
    findings:
      findingStatus == null
        ? []
        : [
            {
              artifact: findingArtifact(sourceRequest, `finding-${requestId}`),
              status: findingStatus,
            },
          ],
    suggestions:
      suggestionStatus == null
        ? []
        : [
            {
              artifact: suggestionArtifact(
                sourceRequest,
                `suggestion-${requestId}`,
                suggestionStatus,
              ),
              ...(suggestionStatus === "conflict"
                ? { conflictCode: "document-changed" }
                : {}),
            },
          ],
  };
}

function workspaceDiscussion(
  run,
  {
    id = `discussion-${run.request.requestId}`,
    createdOrder,
    turns = [
      { role: "user", text: "Explain this result." },
      { role: "assistant", text: "A stored explanation." },
    ],
    suggestionStatus,
  },
) {
  return {
    id,
    createdOrder,
    subjectKey: `${run.generation}:scope:${id}`,
    subject: {
      kind: "scope",
      sourceRequest: run.request,
    },
    sourceGeneration: run.generation,
    turns,
    suggestions:
      suggestionStatus == null
        ? []
        : [
            {
              artifact: suggestionArtifact(
                run.request,
                `suggestion-${id}`,
                suggestionStatus,
              ),
            },
          ],
    updatedAt: createdAt,
  };
}

function openWorkspaceDiscussion({
  id = "discussion-open",
  createdOrder = 1,
  turns = [
    { role: "user", text: "What should I clarify?" },
    { role: "assistant", text: "Clarify the central claim." },
  ],
} = {}) {
  return {
    id,
    createdOrder,
    subjectKey: null,
    subject: null,
    sourceGeneration: null,
    turns,
    suggestions: [],
    updatedAt: createdAt,
  };
}

function emptyWorkspace() {
  return { runs: [], discussions: [] };
}

async function captureError(work) {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject.");
}

function httpRequest({
  body,
  authenticatedUserId = userId,
  routedProjectId = projectId,
  discussionId = "discussion-requested",
} = {}) {
  return {
    body,
    params: {
      project_id: routedProjectId,
      discussion_id: discussionId,
    },
    user: {
      _id: {
        toString: () => authenticatedUserId,
      },
    },
  };
}

class FakeResponse {
  constructor() {
    this.statusCode = 200;
    this.body = undefined;
    this.writableEnded = false;
  }

  status(statusCode) {
    this.statusCode = statusCode;
    return this;
  }

  json(body) {
    this.body = body;
    return this;
  }

  end() {
    this.writableEnded = true;
    return this;
  }
}

describe("AI reviewer workspace persistence", function () {
  it("uses MongoDB's always-enforced string _id for one record per user/project scope", function () {
    expect(AiReviewerWorkspaceModelSchema.path("_id").instance).toBe("String");
    expect(AiReviewerWorkspaceModelSchema.indexes()).toEqual([]);
  });

  it("persists, reloads, and deletes an open discussion without a source run", async function () {
    const discussion = openWorkspaceDiscussion();
    const input = {
      runs: [],
      discussions: [discussion],
    };
    const { model, records } = inMemoryModel();
    const store = createAiReviewerWorkspaceStore({ model });

    expect(await store.save(userId, projectId, input, 0)).toEqual({
      revision: 1,
      workspace: input,
    });
    expect(await store.load(userId, projectId)).toEqual({
      revision: 1,
      workspace: input,
    });

    expect(
      await store.deleteDiscussion(userId, projectId, discussion.id),
    ).toEqual({
      revision: 2,
      workspace: emptyWorkspace(),
    });
    expect(records.get(recordKey(userId, projectId)).workspace).toEqual(
      emptyWorkspace(),
    );
  });

  it("keeps the selected model through every workspace rewrite", async function () {
    const selectedModel = {
      connectionId: "connection-workspace-0001",
      model: "deterministic-v1",
    };
    const discussion = openWorkspaceDiscussion({ createdOrder: 2 });
    const input = {
      runs: [
        workspaceRun({
          requestId: "request-resolved",
          generation: 1,
          createdOrder: 1,
          text: " \n ",
          findingStatus: "discarded",
        }),
      ],
      discussions: [discussion],
      selectedModel,
    };
    const { model, records } = inMemoryModel();
    const store = createAiReviewerWorkspaceStore({ model });

    expect(await store.save(userId, projectId, input, 0)).toEqual({
      revision: 1,
      workspace: input,
    });
    // Clearing artifacts resolved in a prior session and deleting a discussion
    // both rebuild the workspace, and the selection must survive both.
    expect(await store.load(userId, projectId)).toEqual({
      revision: 2,
      workspace: { runs: [], discussions: [discussion], selectedModel },
    });
    expect(
      await store.deleteDiscussion(userId, projectId, discussion.id),
    ).toEqual({
      revision: 3,
      workspace: { ...emptyWorkspace(), selectedModel },
    });
    expect(records.get(recordKey(userId, projectId)).workspace).toEqual({
      ...emptyWorkspace(),
      selectedModel,
    });
  });

  it("loads a workspace stored before the selected model existed", async function () {
    const input = {
      runs: [],
      discussions: [openWorkspaceDiscussion()],
    };
    const { model, records } = inMemoryModel();
    const store = createAiReviewerWorkspaceStore({ model });

    await store.save(userId, projectId, input, 0);
    const loaded = await store.load(userId, projectId);

    expect(loaded.workspace.selectedModel ?? null).toBeNull();
    // A record without the field must survive untouched, so no migration is
    // needed for workspaces stored before the selection was added.
    expect(loaded.workspace).toEqual(input);
    expect(records.get(recordKey(userId, projectId)).workspace).toEqual(input);
  });

  it("rejects a selected model that is not a connection and model pair", async function () {
    const { model } = inMemoryModel();
    const store = createAiReviewerWorkspaceStore({ model });

    expect(
      await captureError(
        store.save(
          userId,
          projectId,
          {
            ...emptyWorkspace(),
            selectedModel: { connectionId: "connection-workspace-0001" },
          },
          0,
        ),
      ),
    ).toBeInstanceOf(AiReviewerWorkspaceValidationError);
  });

  it("keeps review text on load while clearing resolved artifacts and truly empty runs", async function () {
    const unresolvedRun = workspaceRun({
      requestId: "request-unresolved",
      generation: 1,
      createdOrder: 1,
      findingStatus: "unresolved",
      suggestionStatus: "applied",
    });
    const proseAfterClearRun = workspaceRun({
      requestId: "request-discarded",
      generation: 2,
      createdOrder: 2,
      findingStatus: "discarded",
    });
    const postedRun = workspaceRun({
      requestId: "request-posted",
      generation: 3,
      createdOrder: 3,
      text: " \n\t ",
      findingStatus: "posted",
      suggestionStatus: "posted",
    });
    const discussionRun = workspaceRun({
      requestId: "request-discussion",
      generation: 4,
      createdOrder: 4,
      suggestionStatus: "conflict",
    });
    const discussion = workspaceDiscussion(discussionRun, {
      createdOrder: 5,
      suggestionStatus: "applied",
    });
    const input = {
      runs: [unresolvedRun, proseAfterClearRun, postedRun, discussionRun],
      discussions: [discussion],
    };
    const { model, records } = inMemoryModel();
    const store = createAiReviewerWorkspaceStore({ model });

    expect(await store.save(userId, projectId, input, 0)).toEqual({
      revision: 1,
      workspace: input,
    });
    expect(
      records.get(recordKey(userId, projectId)).workspace.runs[0].suggestions,
    ).toHaveLength(1);
    expect(
      records.get(recordKey(userId, projectId)).workspace.runs[1].findings,
    ).toHaveLength(1);
    expect(
      records.get(recordKey(userId, projectId)).workspace.runs[2].findings[0]
        .status,
    ).toBe("posted");
    expect(
      records.get(recordKey(userId, projectId)).workspace.runs[2].suggestions[0]
        .artifact.status,
    ).toBe("posted");

    const loaded = await store.load(userId, projectId);

    expect(loaded.revision).toBe(2);
    expect(loaded.workspace.runs.map((run) => run.request.requestId)).toEqual([
      "request-unresolved",
      "request-discarded",
      "request-discussion",
    ]);
    expect(loaded.workspace.runs[0].findings).toHaveLength(1);
    expect(loaded.workspace.runs[0].suggestions).toEqual([]);
    expect(loaded.workspace.runs[1].findings).toEqual([]);
    expect(loaded.workspace.runs[1].suggestions).toEqual([]);
    expect(loaded.workspace.runs[1].text).toBe(proseAfterClearRun.text);
    expect(loaded.workspace.runs[2].findings).toEqual([]);
    expect(loaded.workspace.runs[2].suggestions).toEqual([]);
    expect(loaded.workspace.discussions).toEqual([
      {
        ...discussion,
        suggestions: [],
      },
    ]);
    expect(records.get(recordKey(userId, projectId)).workspace).toEqual(
      loaded.workspace,
    );
    expect(model.findOneAndUpdate).toHaveBeenCalledTimes(2);

    expect(await store.load(userId, projectId)).toEqual(loaded);
    expect(model.findOneAndUpdate).toHaveBeenCalledTimes(2);
  });

  it("scopes every workspace read to both the authenticated user and project", async function () {
    const run = workspaceRun({
      requestId: "request-private",
      generation: 1,
      createdOrder: 1,
      findingStatus: "unresolved",
    });
    const privateWorkspace = { runs: [run], discussions: [] };
    const { model } = inMemoryModel();
    const store = createAiReviewerWorkspaceStore({ model });

    await store.save(userId, projectId, privateWorkspace, 0);

    expect(await store.load(otherUserId, projectId)).toEqual({
      revision: 0,
      workspace: emptyWorkspace(),
    });
    expect(await store.load(userId, otherProjectId)).toEqual({
      revision: 0,
      workspace: emptyWorkspace(),
    });
    expect(await store.load(userId, projectId)).toEqual({
      revision: 1,
      workspace: privateWorkspace,
    });
    const readFilters = model.findOne.mock.calls.map(([filter]) => filter);
    expect(readFilters).toEqual([
      expect.objectContaining({ userId: otherUserId, projectId }),
      expect.objectContaining({ userId, projectId: otherProjectId }),
      expect.objectContaining({ userId, projectId }),
    ]);
    expect(readFilters.map((filter) => filter._id)).toEqual([
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
    expect(new Set(readFilters.map((filter) => filter._id))).toHaveProperty(
      "size",
      3,
    );
  });

  it("canonicalizes ObjectId casing before deriving the user-project scope", async function () {
    const canonicalUserId = "abcdef0123456789abcdef01";
    const canonicalProjectId = "fedcba9876543210fedcba98";
    const { model, records } = inMemoryModel();
    const store = createAiReviewerWorkspaceStore({ model });

    await store.save(
      canonicalUserId.toUpperCase(),
      canonicalProjectId.toUpperCase(),
      emptyWorkspace(),
      0,
    );

    expect(await store.load(canonicalUserId, canonicalProjectId)).toEqual({
      revision: 1,
      workspace: emptyWorkspace(),
    });
    expect(records).toHaveProperty("size", 1);
    expect(records.has(recordKey(canonicalUserId, canonicalProjectId))).toBe(
      true,
    );

    await store.deleteWorkspace(canonicalUserId, canonicalProjectId);
    expect(
      await captureError(
        store.save(
          canonicalUserId.toUpperCase(),
          canonicalProjectId.toUpperCase(),
          emptyWorkspace(),
          1,
        ),
      ),
    ).toBeInstanceOf(AiReviewerWorkspaceConflictError);
  });

  it("rejects stale whole-workspace saves instead of overwriting or resurrecting data", async function () {
    const firstRun = workspaceRun({
      requestId: "request-first-session",
      generation: 1,
      createdOrder: 1,
      findingStatus: "unresolved",
    });
    const secondRun = workspaceRun({
      requestId: "request-second-session",
      generation: 2,
      createdOrder: 2,
      findingStatus: "unresolved",
    });
    const firstWorkspace = { runs: [firstRun], discussions: [] };
    const currentWorkspace = {
      runs: [firstRun, secondRun],
      discussions: [],
    };
    const { model } = inMemoryModel();
    const store = createAiReviewerWorkspaceStore({ model });

    await store.save(userId, projectId, firstWorkspace, 0);
    await store.save(userId, projectId, currentWorkspace, 1);

    expect(
      await captureError(store.save(userId, projectId, firstWorkspace, 1)),
    ).toBeInstanceOf(AiReviewerWorkspaceConflictError);
    expect(await store.load(userId, projectId)).toEqual({
      revision: 2,
      workspace: currentWorkspace,
    });

    await store.deleteWorkspace(userId, projectId);
    expect(
      await captureError(store.save(userId, projectId, currentWorkspace, 2)),
    ).toBeInstanceOf(AiReviewerWorkspaceConflictError);
    expect(
      await captureError(store.save(userId, projectId, currentWorkspace, 0)),
    ).toBeInstanceOf(AiReviewerWorkspaceConflictError);
    expect(await store.load(userId, projectId)).toEqual({
      revision: 3,
      workspace: emptyWorkspace(),
    });
  });

  it("rejects nested project data that does not match the routed project", async function () {
    const crossProjectRun = workspaceRun({
      requestId: "request-cross-project",
      generation: 1,
      createdOrder: 1,
      findingStatus: "unresolved",
    });
    crossProjectRun.request.projectId = otherProjectId;
    crossProjectRun.findings[0].artifact.projectId = otherProjectId;
    const { model } = inMemoryModel();
    const store = createAiReviewerWorkspaceStore({ model });

    expect(
      await captureError(
        store.save(
          userId,
          projectId,
          {
            runs: [crossProjectRun],
            discussions: [],
          },
          0,
        ),
      ),
    ).toBeInstanceOf(AiReviewerWorkspaceValidationError);
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });

  it("collects a truly empty run without clearing other artifacts", async function () {
    const removedRun = workspaceRun({
      requestId: "request-removed",
      generation: 1,
      createdOrder: 1,
      text: " \n ",
    });
    const retainedRun = workspaceRun({
      requestId: "request-retained",
      generation: 2,
      createdOrder: 2,
      findingStatus: "unresolved",
      suggestionStatus: "applied",
    });
    const removedDiscussion = workspaceDiscussion(removedRun, {
      id: "discussion-removed",
      createdOrder: 3,
    });
    const retainedDiscussion = workspaceDiscussion(retainedRun, {
      id: "discussion-retained",
      createdOrder: 4,
    });
    const { model } = inMemoryModel();
    const store = createAiReviewerWorkspaceStore({ model });
    await store.save(
      userId,
      projectId,
      {
        runs: [removedRun, retainedRun],
        discussions: [removedDiscussion, retainedDiscussion],
      },
      0,
    );

    const result = await store.deleteDiscussion(
      userId,
      projectId,
      removedDiscussion.id,
    );

    expect(result.revision).toBe(2);
    expect(result.workspace.runs).toEqual([retainedRun]);
    expect(result.workspace.discussions).toEqual([retainedDiscussion]);
    expect(result.workspace.runs[0].suggestions[0].artifact.status).toBe(
      "applied",
    );
    expect(model.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ userId, projectId }),
    );
    expect(model.findOneAndUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId, projectId }),
      {
        $set: { workspace: result.workspace },
        $inc: { revision: 1 },
      },
      expect.objectContaining({ upsert: false }),
    );
    const reloaded = await store.load(userId, projectId);
    expect(reloaded.workspace.discussions).toEqual([retainedDiscussion]);
    expect(reloaded.workspace.runs).toHaveLength(1);
    expect(reloaded.workspace.runs[0].findings).toEqual(retainedRun.findings);
  });

  it("keeps a prose-only review through discussion deletion and reload", async function () {
    const proseRun = workspaceRun({
      requestId: "request-prose-only",
      generation: 1,
      createdOrder: 1,
      text: "A complete prose review with no structured artifacts.",
    });
    const removedDiscussion = workspaceDiscussion(proseRun, {
      id: "discussion-prose-only",
      createdOrder: 2,
    });
    const { model } = inMemoryModel();
    const store = createAiReviewerWorkspaceStore({ model });
    await store.save(
      userId,
      projectId,
      {
        runs: [proseRun],
        discussions: [removedDiscussion],
      },
      0,
    );

    const result = await store.deleteDiscussion(
      userId,
      projectId,
      removedDiscussion.id,
    );

    expect(result.workspace).toEqual({
      runs: [proseRun],
      discussions: [],
    });
    const reloaded = await store.load(userId, projectId);
    expect(reloaded.workspace.runs).toEqual([proseRun]);
    expect(reloaded.workspace.runs[0].text).toBe(proseRun.text);
  });

  it("collects only the truly empty run orphaned by a discussion delete", async function () {
    const orphanedRun = workspaceRun({
      requestId: "request-orphaned-empty",
      generation: 1,
      createdOrder: 1,
      text: " \n ",
    });
    const unrelatedEmptyRun = workspaceRun({
      requestId: "request-unrelated-empty",
      generation: 2,
      createdOrder: 2,
      text: "",
    });
    const removedDiscussion = workspaceDiscussion(orphanedRun, {
      id: "discussion-orphaning-empty-run",
      createdOrder: 3,
    });
    const { model } = inMemoryModel();
    const store = createAiReviewerWorkspaceStore({ model });
    await store.save(
      userId,
      projectId,
      {
        runs: [orphanedRun, unrelatedEmptyRun],
        discussions: [removedDiscussion],
      },
      0,
    );

    const result = await store.deleteDiscussion(
      userId,
      projectId,
      removedDiscussion.id,
    );

    expect(result.workspace.discussions).toEqual([]);
    expect(result.workspace.runs).toEqual([unrelatedEmptyRun]);
  });

  it("retries clear-on-load instead of overwriting a concurrent save", async function () {
    const resolvedRun = workspaceRun({
      requestId: "request-resolved-before-load",
      generation: 1,
      createdOrder: 1,
      text: " \n ",
      suggestionStatus: "applied",
    });
    const concurrentRun = workspaceRun({
      requestId: "request-concurrent",
      generation: 2,
      createdOrder: 2,
      findingStatus: "unresolved",
    });
    const { model, records } = inMemoryModel();
    const store = createAiReviewerWorkspaceStore({ model });
    await store.save(
      userId,
      projectId,
      {
        runs: [resolvedRun],
        discussions: [],
      },
      0,
    );
    const current = records.get(recordKey(userId, projectId));

    model.findOneAndUpdate.mockImplementationOnce((filter) =>
      fakeQuery(() => {
        records.set(recordKey(userId, projectId), {
          ...current,
          revision: current.revision + 1,
          workspace: {
            runs: [resolvedRun, concurrentRun],
            discussions: [],
          },
        });
        expect(filter.revision).toBe(current.revision);
        return null;
      }),
    );

    const loaded = await store.load(userId, projectId);

    expect(loaded).toEqual({
      revision: 3,
      workspace: {
        runs: [concurrentRun],
        discussions: [],
      },
    });
    expect(records.get(recordKey(userId, projectId)).workspace).toEqual(
      loaded.workspace,
    );
    expect(model.findOne).toHaveBeenCalledTimes(2);
  });

  it("retries discussion deletion without dropping a concurrent save", async function () {
    const removedRun = workspaceRun({
      requestId: "request-delete-race",
      generation: 1,
      createdOrder: 1,
      text: " \n ",
    });
    const removedDiscussion = workspaceDiscussion(removedRun, {
      id: "discussion-delete-race",
      createdOrder: 2,
    });
    const concurrentRun = workspaceRun({
      requestId: "request-saved-during-delete",
      generation: 2,
      createdOrder: 3,
      findingStatus: "unresolved",
    });
    const { model, records } = inMemoryModel();
    const store = createAiReviewerWorkspaceStore({ model });
    await store.save(
      userId,
      projectId,
      {
        runs: [removedRun],
        discussions: [removedDiscussion],
      },
      0,
    );
    const current = records.get(recordKey(userId, projectId));

    model.findOneAndUpdate.mockImplementationOnce((filter) =>
      fakeQuery(() => {
        records.set(recordKey(userId, projectId), {
          ...current,
          revision: current.revision + 1,
          workspace: {
            runs: [removedRun, concurrentRun],
            discussions: [removedDiscussion],
          },
        });
        expect(filter.revision).toBe(current.revision);
        return null;
      }),
    );

    const result = await store.deleteDiscussion(
      userId,
      projectId,
      removedDiscussion.id,
    );

    expect(result).toEqual({
      revision: 3,
      workspace: {
        runs: [concurrentRun],
        discussions: [],
      },
    });
    expect(records.get(recordKey(userId, projectId)).workspace).toEqual(
      result.workspace,
    );
    expect(model.findOne).toHaveBeenCalledTimes(2);
  });

  it("deletes one workspace, every workspace for a project, and every workspace for a user", async function () {
    const { model, records } = inMemoryModel();
    const store = createAiReviewerWorkspaceStore({ model });
    await store.save(userId, projectId, emptyWorkspace(), 0);
    await store.save(otherUserId, projectId, emptyWorkspace(), 0);
    await store.save(userId, otherProjectId, emptyWorkspace(), 0);

    const clearedSnapshot = await store.deleteWorkspace(userId, otherProjectId);
    expect(clearedSnapshot).toEqual({
      revision: 2,
      workspace: emptyWorkspace(),
    });
    expect(records.get(recordKey(userId, otherProjectId))).toEqual(
      expect.objectContaining({
        userId,
        projectId: otherProjectId,
        revision: 2,
        workspace: emptyWorkspace(),
      }),
    );
    expect(model.findOneAndUpdate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        userId,
        projectId: otherProjectId,
      }),
      {
        $set: { workspace: emptyWorkspace() },
        $inc: { revision: 1 },
      },
      expect.objectContaining({ upsert: true }),
    );

    await store.deleteProject(projectId);
    expect(records.size).toBe(1);
    expect(model.deleteMany).toHaveBeenCalledWith({ projectId });
    await store.deleteProject(otherProjectId);
    expect(records.size).toBe(0);

    await store.save(userId, projectId, emptyWorkspace(), 0);
    await store.save(userId, otherProjectId, emptyWorkspace(), 0);
    await store.deleteUser(userId);
    expect(records.size).toBe(0);
    expect(model.deleteMany).toHaveBeenCalledWith({ userId });
  });

  it("rejects discussion and turn bounds without dropping stored content", async function () {
    const run = workspaceRun({
      requestId: "request-bounded",
      generation: 1,
      createdOrder: 0,
      findingStatus: "unresolved",
    });
    const tooManyDiscussions = {
      runs: [run],
      discussions: Array.from(
        { length: AI_REVIEWER_WORKSPACE_DISCUSSION_LIMIT + 1 },
        (_, index) =>
          workspaceDiscussion(run, {
            id: `discussion-${index}`,
            createdOrder: index + 1,
          }),
      ),
    };
    const tooManyTurns = {
      runs: [run],
      discussions: [
        workspaceDiscussion(run, {
          id: "discussion-too-many-turns",
          createdOrder: 1,
          turns: Array.from(
            { length: AI_REVIEWER_WORKSPACE_TURN_LIMIT + 1 },
            (_, index) => ({
              role: index % 2 === 0 ? "user" : "assistant",
              text: `Stored turn ${index}`,
            }),
          ),
        }),
      ],
    };
    const { model } = inMemoryModel();
    const store = createAiReviewerWorkspaceStore({ model });

    expect(
      await captureError(store.save(userId, projectId, tooManyDiscussions, 0)),
    ).toBeInstanceOf(AiReviewerWorkspaceLimitError);
    expect(
      await captureError(store.save(userId, projectId, tooManyTurns, 0)),
    ).toBeInstanceOf(AiReviewerWorkspaceLimitError);
    expect(tooManyDiscussions.discussions).toHaveLength(
      AI_REVIEWER_WORKSPACE_DISCUSSION_LIMIT + 1,
    );
    expect(tooManyTurns.discussions[0].turns).toHaveLength(
      AI_REVIEWER_WORKSPACE_TURN_LIMIT + 1,
    );
    expect(model.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe("AI reviewer workspace controller", function () {
  it("derives the scope and returns revisioned snapshots for reads, writes, and deletes", async function () {
    const workspace = emptyWorkspace();
    const snapshot = {
      revision: 7,
      workspace,
    };
    const workspaceStore = {
      load: vi.fn(async () => snapshot),
      save: vi.fn(async () => snapshot),
      deleteDiscussion: vi.fn(async () => snapshot),
      deleteWorkspace: vi.fn(async () => ({
        revision: 8,
        workspace,
      })),
    };
    const controller = createAiReviewerWorkspaceController({ workspaceStore });

    const getResponse = new FakeResponse();
    await controller.getWorkspace(httpRequest(), getResponse);
    expect(getResponse.body).toEqual(snapshot);
    expect(workspaceStore.load).toHaveBeenCalledExactlyOnceWith(
      userId,
      projectId,
    );

    const saveResponse = new FakeResponse();
    await controller.saveWorkspace(
      httpRequest({ body: snapshot }),
      saveResponse,
    );
    expect(saveResponse.body).toEqual(snapshot);
    expect(workspaceStore.save).toHaveBeenCalledExactlyOnceWith(
      userId,
      projectId,
      workspace,
      snapshot.revision,
    );

    const discussionResponse = new FakeResponse();
    await controller.deleteDiscussion(httpRequest(), discussionResponse);
    expect(workspaceStore.deleteDiscussion).toHaveBeenCalledExactlyOnceWith(
      userId,
      projectId,
      "discussion-requested",
    );
    expect(discussionResponse.statusCode).toBe(200);
    expect(discussionResponse.body).toEqual(snapshot);

    const workspaceResponse = new FakeResponse();
    await controller.deleteWorkspace(httpRequest(), workspaceResponse);
    expect(workspaceStore.deleteWorkspace).toHaveBeenCalledExactlyOnceWith(
      userId,
      projectId,
    );
    expect(workspaceResponse.statusCode).toBe(200);
    expect(workspaceResponse.body).toEqual({
      revision: 8,
      workspace,
    });
  });

  it("returns a deletion prompt for bounds and redacts validation and storage failures", async function () {
    const secret = "PRIVATE_WORKSPACE_FAILURE";
    const workspaceStore = {
      load: vi
        .fn()
        .mockRejectedValueOnce(new AiReviewerWorkspaceLimitError())
        .mockRejectedValueOnce(new AiReviewerWorkspaceConflictError())
        .mockRejectedValueOnce(new Error(secret)),
      save: vi.fn(),
      deleteDiscussion: vi.fn(),
      deleteWorkspace: vi.fn(),
    };
    const controller = createAiReviewerWorkspaceController({ workspaceStore });

    const limitResponse = new FakeResponse();
    await controller.getWorkspace(httpRequest(), limitResponse);
    expect(limitResponse.statusCode).toBe(409);
    expect(limitResponse.body).toEqual({
      error: {
        code: "AI_REVIEWER_WORKSPACE_LIMIT_REACHED",
        message:
          "Delete a discussion before adding more saved discussion content.",
      },
    });

    const conflictResponse = new FakeResponse();
    await controller.getWorkspace(httpRequest(), conflictResponse);
    expect(conflictResponse.statusCode).toBe(409);
    expect(conflictResponse.body).toEqual({
      error: {
        code: "AI_REVIEWER_WORKSPACE_CHANGED",
        message:
          "The saved review workspace changed in another session. Reload before continuing.",
      },
    });

    const invalidResponse = new FakeResponse();
    await controller.saveWorkspace(
      httpRequest({ authenticatedUserId: "" }),
      invalidResponse,
    );
    expect(invalidResponse.statusCode).toBe(400);
    expect(invalidResponse.body).toEqual({
      error: {
        code: "AI_REVIEWER_WORKSPACE_INVALID",
        message: "The AI reviewer workspace is invalid.",
      },
    });

    const failedResponse = new FakeResponse();
    await controller.getWorkspace(httpRequest(), failedResponse);
    expect(failedResponse.statusCode).toBe(500);
    expect(failedResponse.body).toEqual({
      error: {
        code: "AI_REVIEWER_WORKSPACE_FAILED",
        message: "The AI reviewer workspace request failed.",
      },
    });
    expect(JSON.stringify(failedResponse.body)).not.toContain(secret);
  });
});
