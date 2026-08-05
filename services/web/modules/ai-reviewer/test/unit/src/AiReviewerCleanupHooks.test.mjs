import { beforeEach, describe, expect, it, vi } from "vitest";

describe("AI reviewer cleanup hooks", function () {
  beforeEach(function () {
    vi.resetModules();
  });

  it("deletes shared provenance with its project but never with one user", async function () {
    const deleteWorkspaceProject = vi.fn();
    const deleteWorkspaceUser = vi.fn();
    const deleteProvenanceProject = vi.fn();
    const createAiReviewerWorkspaceStore = vi.fn(() => ({
      deleteProject: deleteWorkspaceProject,
      deleteUser: deleteWorkspaceUser,
    }));
    const createAiReviewerCommentProvenanceStore = vi.fn(() => ({
      deleteProject: deleteProvenanceProject,
    }));
    vi.doMock("../../../app/src/AiReviewerWorkspaceStore.mjs", () => ({
      createAiReviewerWorkspaceStore,
    }));
    vi.doMock("../../../app/src/AiReviewerCommentProvenanceStore.mjs", () => ({
      createAiReviewerCommentProvenanceStore,
    }));

    const { default: hooks } =
      await import("../../../app/src/AiReviewerCleanupHooks.mjs");

    expect(createAiReviewerWorkspaceStore).not.toHaveBeenCalled();
    expect(createAiReviewerCommentProvenanceStore).not.toHaveBeenCalled();

    await hooks.promises.deleteUser("669e48d55ee80e3a12940701");
    expect(deleteWorkspaceUser).toHaveBeenCalledExactlyOnceWith(
      "669e48d55ee80e3a12940701",
    );
    expect(createAiReviewerCommentProvenanceStore).not.toHaveBeenCalled();
    expect(deleteProvenanceProject).not.toHaveBeenCalled();

    await hooks.promises.projectExpired("669e48d55ee80e3a12940711");
    expect(deleteWorkspaceProject).toHaveBeenCalledExactlyOnceWith(
      "669e48d55ee80e3a12940711",
    );
    expect(deleteProvenanceProject).toHaveBeenCalledExactlyOnceWith(
      "669e48d55ee80e3a12940711",
    );
  });
});
