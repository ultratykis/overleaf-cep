import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("AI reviewer: module shell", function () {
  beforeEach(function () {
    vi.resetModules();
  });

  afterEach(function () {
    vi.useRealTimers();
  });

  it("keeps deletion hooks but no routes or startup work when disabled", async function () {
    vi.doMock("@overleaf/settings", () => ({
      default: {
        aiReviewer: {
          enabled: false,
        },
      },
    }));

    const { default: module } = await import("../../../index.mjs");

    expect(module).toEqual({
      hooks: {
        promises: {
          deleteUser: expect.any(Function),
          expireDeletedUser: expect.any(Function),
          projectExpired: expect.any(Function),
        },
      },
    });
    expect(module.router).toBeUndefined();
    expect(module.start).toBeUndefined();
  });

  it("loads the enabled shell without a reconciliation runtime", async function () {
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
          expireDeletedUser: expect.any(Function),
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

  /** @param {boolean} enabled */
  function mockCleanupStores(enabled) {
    const stores = {
      workspaceDeleteProject: vi.fn(),
      workspaceDeleteUser: vi.fn(),
      provenanceDeleteProject: vi.fn(),
      providerConfigDeleteUser: vi.fn(),
    };
    const createAiReviewerWorkspaceStore = vi.fn(() => ({
      deleteProject: stores.workspaceDeleteProject,
      deleteUser: stores.workspaceDeleteUser,
    }));
    vi.doMock("@overleaf/settings", () => ({
      default: { aiReviewer: { enabled } },
    }));
    vi.doMock("../../../app/src/AiReviewerWorkspaceStore.mjs", () => ({
      createAiReviewerWorkspaceStore,
    }));
    vi.doMock("../../../app/src/AiReviewerCommentProvenanceStore.mjs", () => ({
      createAiReviewerCommentProvenanceStore: vi.fn(() => ({
        deleteProject: stores.provenanceDeleteProject,
      })),
    }));
    vi.doMock("../../../app/src/AiReviewerProviderConfigStore.mjs", () => ({
      createAiReviewerProviderConfigStore: vi.fn(() => ({
        deleteUser: stores.providerConfigDeleteUser,
      })),
    }));
    return { ...stores, createAiReviewerWorkspaceStore };
  }

  it("cleans stored workspaces through lazy host lifecycle hooks", async function () {
    const stores = mockCleanupStores(true);

    const { default: module } = await import("../../../index.mjs");

    expect(stores.createAiReviewerWorkspaceStore).not.toHaveBeenCalled();
    await module.hooks.promises.projectExpired("project-0001");
    await module.hooks.promises.deleteUser("user-0001");

    expect(stores.createAiReviewerWorkspaceStore).toHaveBeenCalledOnce();
    expect(stores.workspaceDeleteProject).toHaveBeenCalledExactlyOnceWith(
      "project-0001",
    );
    expect(stores.provenanceDeleteProject).toHaveBeenCalledExactlyOnceWith(
      "project-0001",
    );
    expect(stores.workspaceDeleteUser).toHaveBeenCalledExactlyOnceWith(
      "user-0001",
    );
  });

  it("deletes user data including the credential-bearing configuration", async function () {
    const stores = mockCleanupStores(true);

    const { default: module } = await import("../../../index.mjs");
    await module.hooks.promises.deleteUser("user-0001");

    expect(stores.providerConfigDeleteUser).toHaveBeenCalledExactlyOnceWith(
      "user-0001",
    );
  });

  it("expires a deleted user through the same removal path", async function () {
    const stores = mockCleanupStores(true);

    const { default: module } = await import("../../../index.mjs");
    await module.hooks.promises.expireDeletedUser("user-0002");

    expect(stores.workspaceDeleteUser).toHaveBeenCalledExactlyOnceWith(
      "user-0002",
    );
    expect(stores.providerConfigDeleteUser).toHaveBeenCalledExactlyOnceWith(
      "user-0002",
    );
  });

  it("still deletes project and user data while the feature is disabled", async function () {
    const stores = mockCleanupStores(false);

    const { default: module } = await import("../../../index.mjs");
    await module.hooks.promises.projectExpired("project-0002");
    await module.hooks.promises.deleteUser("user-0003");

    expect(stores.workspaceDeleteProject).toHaveBeenCalledExactlyOnceWith(
      "project-0002",
    );
    expect(stores.provenanceDeleteProject).toHaveBeenCalledExactlyOnceWith(
      "project-0002",
    );
    expect(stores.workspaceDeleteUser).toHaveBeenCalledExactlyOnceWith(
      "user-0003",
    );
    expect(stores.providerConfigDeleteUser).toHaveBeenCalledExactlyOnceWith(
      "user-0003",
    );
  });
});
