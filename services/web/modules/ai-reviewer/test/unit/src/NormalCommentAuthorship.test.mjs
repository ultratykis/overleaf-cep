import sinon from "sinon";
import { beforeEach, describe, expect, it, vi } from "vitest";

const modulePath = new URL(
  "../../../../track-changes/app/src/TrackChangesController.mjs",
  import.meta.url,
).pathname;

describe("AI reviewer: normal comment authorship", function () {
  beforeEach(async function (ctx) {
    ctx.ChatApiHandler = {
      promises: {
        sendComment: sinon.stub().resolves({
          id: "message-0001",
        }),
      },
    };
    ctx.ChatManager = {
      promises: {},
    };
    ctx.EditorRealTimeController = {
      emitToRoom: sinon.stub(),
    };
    ctx.SessionManager = {
      getLoggedInUserId: sinon.stub().returns("posting-user-0001"),
    };
    ctx.UserInfoManager = {
      promises: {
        getPersonalInfo: sinon.stub().resolves({
          _id: "posting-user-0001",
        }),
      },
    };
    ctx.UserInfoController = {
      formatPersonalInfo: sinon.stub().returns({
        id: "posting-user-0001",
      }),
    };

    vi.doMock(
      "../../../../../app/src/Features/Chat/ChatApiHandler.mjs",
      () => ({
        default: ctx.ChatApiHandler,
      }),
    );
    vi.doMock("../../../../../app/src/Features/Chat/ChatManager.mjs", () => ({
      default: ctx.ChatManager,
    }));
    vi.doMock(
      "../../../../../app/src/Features/Editor/EditorRealTimeController.mjs",
      () => ({
        default: ctx.EditorRealTimeController,
      }),
    );
    vi.doMock(
      "../../../../../app/src/Features/Authentication/SessionManager.mjs",
      () => ({
        default: ctx.SessionManager,
      }),
    );
    vi.doMock(
      "../../../../../app/src/Features/User/UserInfoManager.mjs",
      () => ({
        default: ctx.UserInfoManager,
      }),
    );
    vi.doMock(
      "../../../../../app/src/Features/User/UserInfoController.mjs",
      () => ({
        default: ctx.UserInfoController,
      }),
    );
    vi.doMock(
      "../../../../../app/src/Features/Docstore/DocstoreManager.mjs",
      () => ({
        default: {
          promises: {},
        },
      }),
    );
    vi.doMock(
      "../../../../../app/src/Features/DocumentUpdater/DocumentUpdaterHandler.mjs",
      () => ({
        default: {
          promises: {},
        },
      }),
    );
    vi.doMock(
      "../../../../../app/src/Features/Collaborators/CollaboratorsGetter.mjs",
      () => ({
        default: {},
      }),
    );
    vi.doMock("../../../../../app/src/models/Project.mjs", () => ({
      Project: {},
    }));

    ctx.TrackChangesController = (await import(modulePath)).default;
  });

  for (const { description, content } of [
    {
      description: "the unedited AI draft",
      content: "The synthetic phrase needs attention.",
    },
    {
      description: "a user-edited body",
      content:
        "Please replace this phrase; I adjusted the draft before posting.",
    },
  ]) {
    it(`uses the authenticated posting user for ${description}`, async function (ctx) {
      const session = {
        user: {
          _id: "posting-user-0001",
        },
      };
      const req = {
        params: {
          project_id: "project-0001",
          thread_id: "thread-0001",
        },
        body: {
          content,
        },
        session,
      };
      const res = {
        sendStatus: sinon.stub(),
      };
      const next = sinon.stub();

      await ctx.TrackChangesController.sendComment(req, res, next);

      expect(
        ctx.SessionManager.getLoggedInUserId,
      ).to.have.been.calledOnceWithExactly(session);
      expect(
        ctx.ChatApiHandler.promises.sendComment,
      ).to.have.been.calledOnceWithExactly(
        "project-0001",
        "thread-0001",
        "posting-user-0001",
        content,
      );
      expect(next).not.to.have.been.called;
      expect(res.sendStatus).to.have.been.calledOnceWithExactly(204);
    });
  }
});
