import { describe, expect, it, vi } from "vitest";

import AuthorizationMiddleware from "../../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs";
import AdminAuthorizationHelper from "../../../../../app/src/Features/Helpers/AdminAuthorizationHelper.mjs";
import HttpErrorHandler from "../../../../../app/src/Features/Errors/HttpErrorHandler.mjs";
import AdminToolsRouter, {
  ensureAiReviewerHistoryPurgeCapability,
} from "../../../app/src/AdminToolsRouter.mjs";

const rateLimiterMocks = vi.hoisted(() => {
  const middleware = function aiReviewerHistoryRateLimit() {};
  return {
    construct: vi.fn(),
    middleware,
    rateLimit: vi.fn(() => middleware),
  };
});

vi.mock("../../../../../app/src/infrastructure/RateLimiter.mjs", () => ({
  RateLimiter: class {
    constructor(...args) {
      rateLimiterMocks.construct(...args);
    }
  },
}));
vi.mock(
  "../../../../../app/src/Features/Security/RateLimiterMiddleware.mjs",
  () => ({ default: { rateLimit: rateLimiterMocks.rateLimit } }),
);
vi.mock(
  "../../../../../app/src/Features/Authorization/AuthorizationMiddleware.mjs",
  () => ({ default: { ensureUserIsSiteAdmin: function siteAdmin() {} } }),
);
vi.mock(
  "../../../../../app/src/Features/Authentication/AuthenticationController.mjs",
  () => ({ default: { addEndpointToLoginWhitelist() {} } }),
);
vi.mock("../../../app/src/UserListController.mjs", () => {
  const handler = function handler() {};
  return {
    default: {
      activateAccountPage: handler,
      manageUsersPage: handler,
      registerNewUser: handler,
      sendActivationEmail: handler,
      getAdditionalUserInfo: handler,
      getUsersJson: handler,
      deleteUser: handler,
      updateUser: handler,
      purgeDeletedUser: handler,
      restoreDeletedUser: handler,
    },
  };
});
vi.mock("../../../app/src/ProjectListController.mjs", () => {
  const handler = function handler() {};
  return {
    default: {
      getProjectsJson: handler,
      manageProjectsPage: handler,
      trashProjectForUser: handler,
      untrashProjectForUser: handler,
      purgeDeletedProject: handler,
      deleteProject: handler,
      undeleteProject: handler,
    },
  };
});
vi.mock("../../../app/src/AdminToolsController.mjs", () => ({
  default: { activeProjects: function activeProjects() {} },
}));
vi.mock("../../../app/src/AiReviewerHistoryAdminController.mjs", () => ({
  default: {
    show: function show() {},
    dryRun: function dryRun() {},
    purge: function purge() {},
  },
}));

describe("AdminToolsRouter AI history purge", function () {
  it("registers only admin GET, dry-run POST, and purge POST routes", function () {
    const routes = [];
    const webRouter = {
      delete: vi.fn(),
      get: vi.fn((path, ...handlers) => routes.push(["GET", path, handlers])),
      post: vi.fn((path, ...handlers) => routes.push(["POST", path, handlers])),
    };

    AdminToolsRouter.apply(webRouter);

    const historyRoutes = routes.filter(([, path]) =>
      path.startsWith("/admin/ai-reviewer/history"),
    );
    expect(historyRoutes.map(([method, path]) => [method, path])).toEqual([
      ["GET", "/admin/ai-reviewer/history"],
      ["POST", "/admin/ai-reviewer/history/dry-run"],
      ["POST", "/admin/ai-reviewer/history/purge"],
    ]);
    expect(rateLimiterMocks.construct).toHaveBeenCalledWith(
      "ai-reviewer-history-admin",
      { points: 10, duration: 60 },
    );
    expect(rateLimiterMocks.rateLimit).toHaveBeenCalledOnce();
    for (const [, , handlers] of historyRoutes) {
      expect(handlers).toHaveLength(4);
      expect(handlers[0]).toBe(AuthorizationMiddleware.ensureUserIsSiteAdmin);
      expect(handlers[1]).toBe(ensureAiReviewerHistoryPurgeCapability);
      expect(handlers[2]).toBe(rateLimiterMocks.middleware);
      expect(handlers[3]).toBeTypeOf("function");
    }
  });

  it("uses the dedicated capability without requiring admin roles", function () {
    const next = vi.fn();
    const predicate = vi.fn(() => true);
    const helper = vi
      .spyOn(AdminAuthorizationHelper, "hasAdminCapability")
      .mockReturnValue(predicate);

    ensureAiReviewerHistoryPurgeCapability({ marker: true }, {}, next);

    expect(helper).toHaveBeenCalledWith("ai-reviewer-history-purge", false);
    expect(predicate).toHaveBeenCalledWith({ marker: true });
    expect(next).toHaveBeenCalledOnce();
  });

  it("returns not-found when the dedicated capability is absent", function () {
    vi.spyOn(AdminAuthorizationHelper, "hasAdminCapability").mockReturnValue(
      () => false,
    );
    const notFound = vi
      .spyOn(HttpErrorHandler, "notFound")
      .mockReturnValue(undefined);
    const req = { marker: true };
    const res = { marker: true };
    const next = vi.fn();

    ensureAiReviewerHistoryPurgeCapability(req, res, next);

    expect(notFound).toHaveBeenCalledWith(req, res);
    expect(next).not.toHaveBeenCalled();
  });
});
