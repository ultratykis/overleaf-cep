import { beforeEach, describe, expect, it, vi } from "vitest";

describe("AI reviewer cleanup hooks", function () {
  beforeEach(function () {
    vi.resetModules();
  });

  it("deletes shared provenance with its project but never with one user", async function () {
    const deleteWorkspaceProject = vi.fn();
    const deleteWorkspaceUser = vi.fn();
    const deleteProvenanceProject = vi.fn();
    const deleteSkillsUser = vi.fn();
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
    vi.doMock("../../../app/src/AiReviewerProviderConfigStore.mjs", () => ({
      createAiReviewerProviderConfigStore: vi.fn(() => ({
        deleteUser: vi.fn(),
      })),
    }));
    vi.doMock("../../../app/src/AiReviewerSkillStore.mjs", () => ({
      createAiReviewerSkillStore: vi.fn(() => ({
        deleteUser: deleteSkillsUser,
      })),
    }));

    const { default: hooks } =
      await import("../../../app/src/AiReviewerCleanupHooks.mjs");

    expect(createAiReviewerWorkspaceStore).not.toHaveBeenCalled();
    expect(createAiReviewerCommentProvenanceStore).not.toHaveBeenCalled();

    await hooks.promises.deleteUser("669e48d55ee80e3a12940701");
    expect(deleteWorkspaceUser).toHaveBeenCalledExactlyOnceWith(
      "669e48d55ee80e3a12940701",
    );
    expect(deleteSkillsUser).toHaveBeenCalledExactlyOnceWith(
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

  it("does not stop user deletion when independent cleanup operations fail", async function () {
    const deleteWorkspaceUser = vi.fn(async () => {
      throw new Error("workspace cleanup failed");
    });
    const deleteProviderConfigUser = vi.fn(async () => {
      throw new Error("provider configuration cleanup failed");
    });
    const deleteSkillsUser = vi.fn(async () => {
      throw new Error("skills cleanup failed");
    });
    vi.doMock("../../../app/src/AiReviewerWorkspaceStore.mjs", () => ({
      createAiReviewerWorkspaceStore: vi.fn(() => ({
        deleteUser: deleteWorkspaceUser,
      })),
    }));
    vi.doMock("../../../app/src/AiReviewerProviderConfigStore.mjs", () => ({
      createAiReviewerProviderConfigStore: vi.fn(() => ({
        deleteUser: deleteProviderConfigUser,
      })),
    }));
    vi.doMock("../../../app/src/AiReviewerSkillStore.mjs", () => ({
      createAiReviewerSkillStore: vi.fn(() => ({
        deleteUser: deleteSkillsUser,
      })),
    }));

    const { default: hooks } =
      await import("../../../app/src/AiReviewerCleanupHooks.mjs");

    await hooks.promises.deleteUser("669e48d55ee80e3a12940701");
    expect(deleteWorkspaceUser).toHaveBeenCalledOnce();
    expect(deleteProviderConfigUser).toHaveBeenCalledOnce();
    expect(deleteSkillsUser).toHaveBeenCalledOnce();
  });
});
