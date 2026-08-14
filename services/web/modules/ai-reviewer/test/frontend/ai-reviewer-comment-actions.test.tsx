import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect } from "chai";
import React from "react";
import sinon from "sinon";

import { PermissionsContext } from "@/features/ide-react/context/permissions-context";
import { ReviewPanelMessage } from "@/features/review-panel/components/review-panel-message";
import { UserContext } from "@/shared/context/user-context";
import type { CommentId, ThreadId } from "@ol-types/review-panel/review-panel";
import type { AiProviderConnection } from "../../frontend/js/services/ai-provider-configuration";
import type { UserId } from "@ol-types/user";
import AiReviewerCommentActions from "../../frontend/js/components/ai-reviewer-comment-actions";
import { AiReviewerPanelView } from "../../frontend/js/components/ai-reviewer-panel";
import {
  AI_REVIEWER_COMMENT_ACTION_EVENT,
  dispatchAiReviewerCommentAction,
  dispatchAiReviewerCommentActionBusy,
} from "../../frontend/js/services/comment-action-events";
import { typeConversationMessage } from "./helpers/panel-composer";

const threadId = "comment-thread-138" as ThreadId;
const replyProjectId = "a".repeat(24);
const replyThreadId = "b".repeat(24) as ThreadId;

// The panel only runs once its connection catalog has loaded, so a test that
// exercises the run path has to supply one.
const localConnection: AiProviderConnection = {
  id: "connection-local",
  revision: 1,
  label: "127.0.0.1:11434",
  classification: "local",
  config: {
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    contextLengthOverride: null,
    credentialSet: false,
    credentialUpdatedAt: null,
  },
};

function loadedCatalogProps() {
  return {
    loadProviderConnections: sinon
      .stub()
      .resolves({ connections: [localConnection] }),
    loadProviderModels: sinon.stub().resolves({
      models: [
        {
          id: "reviewer-default-v1",
          displayName: "Default reviewer",
          connectionId: localConnection.id,
          connectionLabel: localConnection.label,
          contextLength: null,
          contextLengthSource: "pending" as const,
        },
      ],
      failures: [],
    }),
  };
}

function completedConversationProps(projectId: string) {
  return {
    captureSelectionSession: sinon.stub().callsFake(async (request) => ({
      status: "ready",
      session: {
        request: {
          ...request,
          projectId,
          skill: null,
          scope: {
            kind: "document",
            documentId: "c".repeat(24),
            path: "main.tex",
            baseRevision: 1,
            baseTextHash: "d".repeat(64),
            text: "Synthetic document.",
          },
        },
        binding: {},
      },
    })),
    streamRequest: sinon.stub().callsFake(async (call) => {
      call.onEvent({
        type: "text.delta",
        requestId: call.request.requestId,
        delta: "Use this explicit AI proposal.",
      });
      call.onEvent({
        type: "completed",
        requestId: call.request.requestId,
        finishReason: "stop",
      });
    }),
  };
}

describe("AI reviewer: comment actions", function () {
  afterEach(function () {
    dispatchAiReviewerCommentActionBusy(false);
  });

  it("dispatches the thread ID and opens the AI reviewer rail", function () {
    const commentAction = sinon.spy((event: Event) => event.preventDefault());
    const railAction = sinon.spy();
    window.addEventListener(AI_REVIEWER_COMMENT_ACTION_EVENT, commentAction);
    window.addEventListener("ui:select-rail-tab", railAction);

    try {
      render(<AiReviewerCommentActions commentId={threadId} />);
      fireEvent.click(screen.getByRole("button", { name: "Ask AI" }));

      expect(commentAction).to.have.been.calledOnce;
      expect(
        (commentAction.firstCall.args[0] as CustomEvent).detail,
      ).to.deep.equal({ threadId });
      expect(railAction).to.have.been.calledOnce;
      expect(
        (railAction.firstCall.args[0] as CustomEvent).detail,
      ).to.deep.equal({ tab: "ai-reviewer", open: true });
    } finally {
      window.removeEventListener(
        AI_REVIEWER_COMMENT_ACTION_EVENT,
        commentAction,
      );
      window.removeEventListener("ui:select-rail-tab", railAction);
    }
  });

  it("submits a document conversation instruction containing the thread ID", async function () {
    const captureSelectionSession = sinon.stub().resolves({
      status: "conflict",
      code: "AI_SELECTION_REQUIRED",
    });
    render(
      <AiReviewerPanelView
        projectId="comment-action-project"
        createDiscussionId={() => "comment-action-discussion"}
        createDiscussionRequestId={() => "comment-action-request"}
        captureSelectionSession={captureSelectionSession}
        {...loadedCatalogProps()}
      />,
    );

    // The catalog resolves asynchronously, and the panel holds comment actions
    // until it has, so retry the dispatch the way the button's pending path does.
    let handled = false;
    await waitFor(() => {
      act(() => {
        handled = dispatchAiReviewerCommentAction(threadId);
      });
      expect(handled).to.equal(true);
    });
    await waitFor(() => {
      expect(captureSelectionSession).to.have.been.calledOnce;
    });
    expect(captureSelectionSession.firstCall.args[0]).to.include({
      action: "review",
      // Naming the tool keeps a weak local model from hunting through the
      // document for a thread id it can only get from read_project_comments.
      instruction:
        "Read the review comment with threadId comment-thread-138 using read_project_comments, then propose how to address it.",
      target: "document",
    });
  });

  // The button lives in the review panel, so it is reachable before this panel
  // has ever been opened. Running then would fail with no model selected (#144).
  it("holds the action until the connection catalog has loaded", async function () {
    const captureSelectionSession = sinon.stub().resolves({
      status: "conflict",
      code: "AI_SELECTION_REQUIRED",
    });
    render(
      <AiReviewerPanelView
        projectId="comment-action-project"
        createDiscussionId={() => "comment-action-pending-discussion"}
        createDiscussionRequestId={() => "comment-action-pending-request"}
        captureSelectionSession={captureSelectionSession}
        loadProviderConnections={sinon.stub().returns(new Promise(() => {}))}
        loadProviderModels={sinon.stub().returns(new Promise(() => {}))}
      />,
    );

    let handled = false;
    act(() => {
      handled = dispatchAiReviewerCommentAction(threadId);
    });

    expect(handled).to.equal(false);
    expect(captureSelectionSession).not.to.have.been.called;
  });

  it("offers an explicit reply action only for a thread-scoped conversation", async function () {
    const postReply = sinon.stub().resolves({ commentId: "e".repeat(24) });
    render(
      <AiReviewerPanelView
        projectId={replyProjectId}
        createDiscussionId={() => "comment-reply-discussion"}
        createDiscussionRequestId={() => "comment-reply-request"}
        postReply={postReply}
        {...completedConversationProps(replyProjectId)}
        {...loadedCatalogProps()}
      />,
    );

    await waitFor(() => {
      expect(dispatchAiReviewerCommentAction(replyThreadId)).to.equal(true);
    });
    expect(await screen.findByText("Use this explicit AI proposal.")).to.exist;
    const postAction = await screen.findByRole("button", {
      name: "Post reply to thread",
    });
    expect(postReply).not.to.have.been.called;

    fireEvent.click(postAction);
    const body = screen.getByRole("textbox", { name: "Comment body" });
    expect(body).to.have.property("value", "Use this explicit AI proposal.");
    fireEvent.click(screen.getByRole("button", { name: "Post comment" }));

    await waitFor(() => expect(postReply).to.have.been.calledOnce);
    expect(postReply).to.have.been.calledWithExactly({
      projectId: replyProjectId,
      runId: "comment-reply-discussion",
      artifactId: "reply:1",
      threadId: replyThreadId,
      content: "Use this explicit AI proposal.",
    });
  });

  it("does not offer or auto-post a reply for a conversation without a thread", async function () {
    const postReply = sinon.stub().resolves({ commentId: "e".repeat(24) });
    render(
      <AiReviewerPanelView
        projectId={replyProjectId}
        createDiscussionId={() => "ordinary-discussion"}
        createDiscussionRequestId={() => "ordinary-request"}
        postReply={postReply}
        {...completedConversationProps(replyProjectId)}
        {...loadedCatalogProps()}
      />,
    );

    typeConversationMessage("Propose an answer without a comment thread.");
    expect(await screen.findByText("Use this explicit AI proposal.")).to.exist;
    expect(screen.queryByRole("button", { name: "Post reply to thread" })).not
      .to.exist;
    expect(postReply).not.to.have.been.called;
  });

  it("is disabled and dispatches nothing while busy", function () {
    const commentAction = sinon.spy();
    const railAction = sinon.spy();
    window.addEventListener(AI_REVIEWER_COMMENT_ACTION_EVENT, commentAction);
    window.addEventListener("ui:select-rail-tab", railAction);
    dispatchAiReviewerCommentActionBusy(true);

    try {
      render(<AiReviewerCommentActions commentId={threadId} />);
      const button = screen.getByRole("button", { name: "Ask AI" });
      expect(button).to.have.property("disabled", true);
      fireEvent.click(button);
      expect(commentAction).not.to.have.been.called;
      expect(railAction).not.to.have.been.called;
    } finally {
      window.removeEventListener(
        AI_REVIEWER_COMMENT_ACTION_EVENT,
        commentAction,
      );
      window.removeEventListener("ui:select-rail-tab", railAction);
    }
  });

  it("renders no Ask AI control when the core module slot is absent", function () {
    render(
      <UserContext.Provider value={{ id: "user-138" } as never}>
        <PermissionsContext.Provider
          value={{
            read: true,
            write: false,
            admin: false,
            comment: true,
            resolveOwnComments: false,
            resolveAllComments: false,
            trackedWrite: false,
            labelVersion: false,
          }}
        >
          <ReviewPanelMessage
            threadId={threadId}
            message={{
              content: "Please clarify this claim.",
              id: "comment-message-138" as CommentId,
              timestamp: new Date("2026-08-14T00:00:00.000Z"),
              user_id: "user-138" as UserId,
            }}
            hasReplies={false}
            isReply={false}
            isThreadResolved={false}
          />
        </PermissionsContext.Provider>
      </UserContext.Provider>,
    );

    expect(screen.queryByRole("button", { name: "Ask AI" })).not.to.exist;
  });
});
