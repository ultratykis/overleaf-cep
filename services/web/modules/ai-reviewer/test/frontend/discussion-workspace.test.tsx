import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect } from "chai";
import React from "react";
import sinon from "sinon";

import { AiReviewerPanelView } from "../../frontend/js/components/ai-reviewer-panel";
import type { EditorSelectionSession } from "../../frontend/js/services/editor-selection-session";
import {
  streamAgentEvents,
  streamDiscussionEvents,
} from "../../frontend/js/services/agent-stream";
import {
  DISCUSSION_CONTEXT_TURN_LIMIT,
  DiscussionRequestSchema,
} from "../../shared/contracts.mjs";
import type {
  AgentRequest,
  DiscussionEvent,
  Finding,
  UnresolvedSuggestion,
} from "../../shared/contract-types";

const createdAt = "2026-07-25T00:00:00.000Z";
const projectId = "discussion-project";
const documentId = "discussion-document";
const path = "chapters/discussion.tex";
const baseText = "Alpha beta gamma.";
const baseTextHash =
  "aea23d46109af9b94c5f15085d69113cc2cefa85f05748897a4df172a1ee5104";

type ReviewStreamCall = Parameters<typeof streamAgentEvents>[0];
type DiscussionStreamCall = Parameters<typeof streamDiscussionEvents>[0];

function sourceRequest(): AgentRequest {
  return {
    requestId: "discussion-source-request",
    projectId,
    action: "review",
    instruction: "Review the selected phrase.",
    skill: "referee-review",
    scope: {
      kind: "selection",
      documentId,
      path,
      baseRevision: 7,
      baseTextHash,
      range: {
        from: 6,
        to: 10,
      },
      text: "beta",
    },
  };
}

function sourceSession(request: AgentRequest): EditorSelectionSession {
  const shareDocument = {
    connection: {
      state: "ok",
    },
    getVersion: () => 7,
  };
  const currentDocument = {
    doc_id: documentId,
    joined: true,
    doc: shareDocument,
    getSnapshot: () => baseText,
    hasBufferedOps: () => false,
    getTrackingChanges: () => false,
  };

  return Object.freeze({
    request,
    binding: Object.freeze({
      currentDocument,
      shareDocument,
      trackChanges: false,
      connectionEpoch: 17,
    }),
  });
}

function sourceFinding(request: AgentRequest): Finding {
  return {
    id: "discussion-finding",
    requestId: request.requestId,
    projectId: request.projectId,
    artifactKind: "finding",
    severity: "warning",
    category: "clarity",
    title: "Ambiguous discussion phrase",
    message: "The selected phrase needs a more precise explanation.",
    evidence: [
      {
        path,
        range: {
          from: 6,
          to: 10,
        },
        revision: 7,
        textHash: baseTextHash,
      },
    ],
    suggestionIds: [],
  };
}

function discussionSuggestion(request: AgentRequest): UnresolvedSuggestion {
  return {
    id: "discussion-suggestion",
    requestId: request.requestId,
    projectId: request.projectId,
    documentId,
    path,
    baseRevision: 7,
    baseTextHash,
    range: {
      from: 6,
      to: 10,
    },
    original: "beta",
    replacement: "clear",
    rationale: "Use a precise term from the discussion.",
    evidence: [
      {
        path,
        range: {
          from: 6,
          to: 10,
        },
        revision: 7,
        textHash: baseTextHash,
      },
    ],
    provider: "fake",
    model: "deterministic-v1",
    skill: "referee-review",
    createdAt,
    status: "unresolved",
  };
}

function discussionEvent(
  requestId: string,
  sequence: number,
  event: Omit<
    DiscussionEvent,
    "eventId" | "requestId" | "sequence" | "createdAt"
  >,
): DiscussionEvent {
  return {
    ...event,
    eventId: `discussion-event-${requestId}-${sequence}`,
    requestId,
    sequence,
    createdAt,
  } as DiscussionEvent;
}

async function renderCompletedFindingRun({
  streamDiscussionRequest,
  mountSuggestionPreview,
  applySelectionSuggestion,
  getSelectionContext,
}: {
  streamDiscussionRequest: sinon.SinonStub;
  mountSuggestionPreview?: sinon.SinonStub;
  applySelectionSuggestion?: sinon.SinonStub;
  getSelectionContext?: sinon.SinonStub;
}) {
  const request = sourceRequest();
  const session = sourceSession(request);
  const finding = sourceFinding(request);
  const streamRequest = sinon
    .stub()
    .callsFake(async ({ onEvent }: ReviewStreamCall) => {
      onEvent({
        type: "started",
        eventId: "review-started",
        requestId: request.requestId,
        sequence: 0,
        createdAt,
        provider: "fake",
        model: "deterministic-v1",
        skill: request.skill,
      });
      onEvent({
        type: "finding",
        eventId: "review-finding",
        requestId: request.requestId,
        sequence: 1,
        createdAt,
        finding,
      });
      onEvent({
        type: "completed",
        eventId: "review-completed",
        requestId: request.requestId,
        sequence: 2,
        createdAt,
        finishReason: "stop",
      });
    });

  let discussionRequestNumber = 0;
  const rendered = render(
    <AiReviewerPanelView
      projectId={projectId}
      createRequestId={() => request.requestId}
      createDiscussionId={() => "discussion-0001"}
      createDiscussionRequestId={() =>
        `discussion-request-${++discussionRequestNumber}`
      }
      now={() => createdAt}
      captureSelectionSession={async () => ({
        status: "ready",
        session,
      })}
      streamRequest={streamRequest}
      streamDiscussionRequest={streamDiscussionRequest}
      getSelectionContext={getSelectionContext}
      mountSuggestionPreview={mountSuggestionPreview}
      applySelectionSuggestion={applySelectionSuggestion}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Review selection" }));
  await screen.findByText("Completed");
  fireEvent.click(screen.getByRole("button", { name: "Discuss finding" }));
  await screen.findByRole("region", { name: "AI reviewer discussion" });

  return {
    ...rendered,
    finding,
    request,
    session,
    streamRequest,
  };
}

async function sendDiscussionMessage(text: string) {
  fireEvent.change(screen.getByLabelText("Discussion message"), {
    target: {
      value: text,
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
  await waitFor(() => {
    expect(
      (screen.getByLabelText("Discussion message") as HTMLTextAreaElement)
        .disabled,
    ).to.equal(false);
  });
}

describe("AI reviewer: discussion workspace", function () {
  it("shows a responding indicator while an answer is still streaming", async function () {
    // A real answer can take tens of seconds. Without this the composer just
    // goes quiet, which reads as a hang.
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const streamDiscussionRequest = sinon
      .stub()
      .callsFake(async (call: DiscussionStreamCall) => {
        const { requestId } = call.request;
        call.onEvent(
          discussionEvent(requestId, 0, {
            type: "started",
            provider: "fake",
            model: "deterministic-v1",
          }),
        );
        await held;
        call.onEvent(
          discussionEvent(requestId, 1, {
            type: "text.delta",
            delta: "Delayed reply",
          }),
        );
        call.onEvent(
          discussionEvent(requestId, 2, {
            type: "completed",
            finishReason: "stop",
          }),
        );
      });

    render(
      <AiReviewerPanelView
        projectId={projectId}
        createDiscussionId={() => "responding-discussion-0001"}
        createDiscussionRequestId={() => "responding-discussion-request-1"}
        now={() => createdAt}
        streamDiscussionRequest={streamDiscussionRequest}
      />,
    );

    fireEvent.change(screen.getByLabelText("Discussion message"), {
      target: { value: "Please answer slowly" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    const indicator = await screen.findByTestId("discussion-responding");
    expect(indicator.textContent).to.equal("Responding");
    expect(screen.getByRole("button", { name: "Cancel response" })).to.exist;

    release?.();
    await waitFor(() => {
      expect(screen.queryByTestId("discussion-responding")).not.to.exist;
    });
  });

  it("starts an open discussion from the list input, sends only 12 recent turns, and returns to one collapsed row with no subject", async function () {
    let responseNumber = 0;
    const streamDiscussionRequest = sinon
      .stub()
      .callsFake(async (call: DiscussionStreamCall) => {
        responseNumber += 1;
        const { requestId } = call.request;
        call.onEvent(
          discussionEvent(requestId, 0, {
            type: "started",
            provider: "fake",
            model: "deterministic-v1",
          }),
        );
        call.onEvent(
          discussionEvent(requestId, 1, {
            type: "text.delta",
            delta: `Open discussion reply ${responseNumber}`,
          }),
        );
        call.onEvent(
          discussionEvent(requestId, 2, {
            type: "completed",
            finishReason: "stop",
          }),
        );
      });
    let requestNumber = 0;

    render(
      <AiReviewerPanelView
        projectId={projectId}
        createDiscussionId={() => "open-discussion-0001"}
        createDiscussionRequestId={() =>
          `open-discussion-request-${++requestNumber}`
        }
        now={() => createdAt}
        streamDiscussionRequest={streamDiscussionRequest}
      />,
    );

    expect(screen.getByLabelText("Review list")).to.exist;
    await sendDiscussionMessage("Open discussion message 1");
    const discussion = await screen.findByRole("region", {
      name: "AI reviewer discussion",
    });
    const subject = within(discussion).getByTestId("discussion-subject");
    expect(subject.textContent).to.equal("No subject");
    expect(within(discussion).queryByRole("button", { name: "Run review" })).not
      .to.exist;

    for (let index = 2; index <= 13; index += 1) {
      await sendDiscussionMessage(`Open discussion message ${index}`);
    }

    expect(streamDiscussionRequest.callCount).to.equal(13);
    for (const call of streamDiscussionRequest.getCalls()) {
      expect(call.args[0].request).to.include({
        discussionId: "open-discussion-0001",
        projectId,
        subject: null,
      });
      expect(call.args[0].request.turns.length).to.be.at.most(
        DISCUSSION_CONTEXT_TURN_LIMIT,
      );
      expect(
        DiscussionRequestSchema.safeParse(call.args[0].request).success,
      ).to.equal(true);
    }
    const finalRequest = streamDiscussionRequest.lastCall.args[0].request;
    expect(finalRequest.turns).to.have.length(DISCUSSION_CONTEXT_TURN_LIMIT);
    expect(finalRequest.turns[0]).to.deep.equal({
      role: "assistant",
      text: "Open discussion reply 7",
    });
    expect(finalRequest.turns.at(-1)).to.deep.equal({
      role: "user",
      text: "Open discussion message 13",
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Back to review list" }),
    );
    const summary = await screen.findByRole("article", {
      name: "Discussion summary",
    });
    expect(within(summary).getByRole("button", { name: "No subject" })).to
      .exist;
    expect(
      screen.getAllByRole("article", {
        name: "Discussion summary",
      }),
    ).to.have.length(1);
    expect(screen.queryByLabelText("Discussion turns")).not.to.exist;
  });

  it("navigates through a pinned subject, sends only 12 recent turns, escapes model text, and returns to one collapsed row", async function () {
    const maliciousModelText =
      '<img src=x onerror="globalThis.pwned=true"><a href="https://attacker.invalid/">click</a>';
    let responseNumber = 0;
    const streamDiscussionRequest = sinon
      .stub()
      .callsFake(async (call: DiscussionStreamCall) => {
        responseNumber += 1;
        const { requestId } = call.request;
        call.onEvent(
          discussionEvent(requestId, 0, {
            type: "started",
            provider: "fake",
            model: "deterministic-v1",
          }),
        );
        call.onEvent(
          discussionEvent(requestId, 1, {
            type: "text.delta",
            delta:
              responseNumber === 1
                ? maliciousModelText
                : `Discussion reply ${responseNumber}`,
          }),
        );
        call.onEvent(
          discussionEvent(requestId, 2, {
            type: "completed",
            finishReason: "stop",
          }),
        );
      });

    const workspace = await renderCompletedFindingRun({
      streamDiscussionRequest,
    });

    const discussion = screen.getByRole("region", {
      name: "AI reviewer discussion",
    });
    const subject = within(discussion).getByTestId("discussion-subject");
    const subjectHeader = subject.closest("header");
    const turns = within(discussion).getByLabelText("Discussion turns");
    expect(subject.textContent).to.equal(
      "Finding: Ambiguous discussion phrase",
    );
    expect(subjectHeader).not.to.equal(null);
    expect(
      subjectHeader?.classList.contains("ai-reviewer-discussion-header"),
    ).to.equal(true);
    expect(subjectHeader?.nextElementSibling).to.equal(turns);
    expect(turns.classList.contains("ai-reviewer-discussion-turns")).to.equal(
      true,
    );
    expect(within(discussion).queryByRole("button", { name: "Run review" })).not
      .to.exist;

    for (let index = 1; index <= 13; index += 1) {
      await sendDiscussionMessage(`Discussion message ${index}`);
      await waitFor(() => {
        expect(streamDiscussionRequest.callCount).to.equal(index);
      });
    }

    expect(DISCUSSION_CONTEXT_TURN_LIMIT).to.equal(12);
    for (const call of streamDiscussionRequest.getCalls()) {
      expect(call.args[0].request.turns.length).to.be.at.most(
        DISCUSSION_CONTEXT_TURN_LIMIT,
      );
      expect(
        DiscussionRequestSchema.safeParse(call.args[0].request).success,
      ).to.equal(true);
      expect(call.args[0].request.subject).to.deep.equal({
        kind: "finding",
        sourceRequest: workspace.request,
        artifact: workspace.finding,
      });
    }
    const finalRequest = streamDiscussionRequest.lastCall.args[0].request;
    expect(finalRequest.turns).to.have.length(DISCUSSION_CONTEXT_TURN_LIMIT);
    expect(finalRequest.turns[0]).to.deep.equal({
      role: "assistant",
      text: "Discussion reply 7",
    });
    expect(finalRequest.turns.at(-1)).to.deep.equal({
      role: "user",
      text: "Discussion message 13",
    });

    expect(screen.getByText(maliciousModelText)).to.exist;
    expect(workspace.container.querySelector("img")).to.equal(null);
    expect(workspace.container.querySelector("a")).to.equal(null);

    fireEvent.click(
      screen.getByRole("button", { name: "Back to review list" }),
    );
    const summary = await screen.findByRole("article", {
      name: "Discussion summary",
    });
    expect(
      within(summary).getByRole("button", {
        name: "Finding: Ambiguous discussion phrase",
      }),
    ).to.exist;
    expect(within(summary).queryByText(maliciousModelText)).not.to.exist;
    expect(screen.queryByLabelText("Discussion turns")).not.to.exist;

    fireEvent.click(
      within(summary).getByRole("button", {
        name: "Finding: Ambiguous discussion phrase",
      }),
    );
    await screen.findByRole("region", { name: "AI reviewer discussion" });
    expect(streamDiscussionRequest.callCount).to.equal(13);

    fireEvent.click(
      screen.getByRole("button", { name: "Back to review list" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Review selection" }));
    await waitFor(() => {
      expect(screen.getAllByText("Completed")).to.have.length(2);
    });
    const reviewList = screen.getByLabelText("Review list");
    const timeline = reviewList.querySelector(".ai-reviewer-panel-timeline");
    expect(timeline).not.to.equal(null);
    expect(
      Array.from(timeline?.children ?? []).map((entry) =>
        entry.getAttribute("aria-label"),
      ),
    ).to.deep.equal(["Review run 1", "Discussion summary", "Review run 2"]);
  });

  it("routes a discussion suggestion through the existing preview/apply callback with the exact source session", async function () {
    const request = sourceRequest();
    const emittedSuggestion = discussionSuggestion(request);
    const streamDiscussionRequest = sinon
      .stub()
      .callsFake(async (call: DiscussionStreamCall) => {
        const { requestId } = call.request;
        call.onEvent(
          discussionEvent(requestId, 0, {
            type: "started",
            provider: "fake",
            model: "deterministic-v1",
          }),
        );
        call.onEvent(
          discussionEvent(requestId, 1, {
            type: "text.delta",
            delta: "Here is a guarded suggestion.",
          }),
        );
        call.onEvent(
          discussionEvent(requestId, 2, {
            type: "suggestion",
            suggestion: emittedSuggestion,
          }),
        );
        call.onEvent(
          discussionEvent(requestId, 3, {
            type: "completed",
            finishReason: "stop",
          }),
        );
      });
    const destroy = sinon.stub();
    const mountSuggestionPreview = sinon.stub().callsFake(async (options) => {
      options.onSelectionChange(["ai-hunk-v1-discussion"]);
      return {
        hunkIds: Object.freeze(["ai-hunk-v1-discussion"]),
        destroy,
      };
    });
    const applySelectionSuggestion = sinon.stub().resolves({
      status: "applied",
    });
    const getSelectionContext = sinon.stub();
    const workspace = await renderCompletedFindingRun({
      streamDiscussionRequest,
      mountSuggestionPreview,
      applySelectionSuggestion,
      getSelectionContext,
    });

    expect(workspace.session.request).to.deep.equal(request);
    fireEvent.change(screen.getByLabelText("Discussion message"), {
      target: {
        value: "Please propose a precise replacement.",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    const previewButton = await screen.findByRole("button", {
      name: "Preview discussion diff 1",
    });
    fireEvent.click(previewButton);
    await screen.findByText("Suggestion preview ready");

    expect(mountSuggestionPreview.calledOnce).to.equal(true);
    expect(mountSuggestionPreview.firstCall.args[0].request).to.equal(
      workspace.session.request,
    );
    expect(mountSuggestionPreview.firstCall.args[0].suggestion).to.equal(
      emittedSuggestion,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Apply selected changes" }),
    );
    await waitFor(() => {
      expect(applySelectionSuggestion.calledOnce).to.equal(true);
    });
    const applyOptions = applySelectionSuggestion.firstCall.args[0];
    expect(applyOptions.session).to.equal(workspace.session);
    expect(applyOptions.suggestion).to.equal(emittedSuggestion);
    expect(applyOptions.getContext).to.equal(getSelectionContext);
    expect(applyOptions.selectedHunkIds).to.deep.equal([
      "ai-hunk-v1-discussion",
    ]);
    expect(Object.isFrozen(applyOptions.selectedHunkIds)).to.equal(true);
    await screen.findByText("Status: Applied");
    expect(destroy.calledOnce).to.equal(true);
  });
});
