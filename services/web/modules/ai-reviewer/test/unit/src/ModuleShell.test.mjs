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
      router: {
        apply: expect.any(Function),
      },
      start: expect.any(Function),
    });
    expect(await module.start()).toBeUndefined();
  });
});
