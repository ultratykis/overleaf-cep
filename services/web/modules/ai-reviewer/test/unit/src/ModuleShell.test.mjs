import { beforeEach, describe, expect, it, vi } from "vitest";

describe("AI reviewer: module shell", function () {
  beforeEach(function () {
    vi.resetModules();
  });

  it("has no hooks, routes, or startup work when disabled", async function () {
    vi.doMock("@overleaf/settings", () => ({
      default: {
        aiReviewer: {
          enabled: false,
        },
      },
    }));

    const { default: module } = await import("../../../index.mjs");

    expect(module).toEqual({});
  });

  it("loads only the lazy enabled shell when enabled", async function () {
    vi.doMock("@overleaf/settings", () => ({
      default: {
        aiReviewer: {
          enabled: true,
        },
      },
    }));

    const { default: module } = await import("../../../index.mjs");

    expect(module).toEqual({
      hooks: {
        promises: {
          deleteUser: expect.any(Function),
          projectExpired: expect.any(Function),
        },
      },
      router: {
        apply: expect.any(Function),
      },
      start: expect.any(Function),
    });
    expect(await module.start()).toBeUndefined();
  });

  it("cleans stored workspaces through lazy host lifecycle hooks", async function () {
    const deleteProject = vi.fn();
    const deleteUser = vi.fn();
    const createAiReviewerWorkspaceStore = vi.fn(() => ({
      deleteProject,
      deleteUser,
    }));
    const createAiReviewerCommentProvenanceStore = vi.fn(() => ({
      deleteProject: vi.fn(),
    }));
    vi.doMock("@overleaf/settings", () => ({
      default: {
        aiReviewer: {
          enabled: true,
        },
      },
    }));
    vi.doMock("../../../app/src/AiReviewerWorkspaceStore.mjs", () => ({
      createAiReviewerWorkspaceStore,
    }));
    vi.doMock("../../../app/src/AiReviewerCommentProvenanceStore.mjs", () => ({
      createAiReviewerCommentProvenanceStore,
    }));

    const { default: module } = await import("../../../index.mjs");

    expect(createAiReviewerWorkspaceStore).not.toHaveBeenCalled();
    await module.hooks.promises.projectExpired("project-0001");
    await module.hooks.promises.deleteUser("user-0001");

    expect(createAiReviewerWorkspaceStore).toHaveBeenCalledOnce();
    expect(deleteProject).toHaveBeenCalledExactlyOnceWith("project-0001");
    expect(deleteUser).toHaveBeenCalledExactlyOnceWith("user-0001");
  });
});
