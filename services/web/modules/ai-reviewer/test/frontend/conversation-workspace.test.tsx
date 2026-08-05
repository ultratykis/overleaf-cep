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
import { streamAgentEvents } from "../../frontend/js/services/agent-stream";
import {
  AgentRequestSchema,
  DISCUSSION_CONTEXT_TURN_LIMIT,
} from "../../shared/contracts.mjs";
import type {
  AgentEvent,
  AgentRequest,
  Finding,
  UnresolvedSuggestion,
} from "../../shared/contract-types";
import { typeConversationMessage } from "./helpers/panel-composer";

const createdAt = "2026-07-25T00:00:00.000Z";
const projectId = "discussion-project";
const documentId = "discussion-document";
const path = "chapters/discussion.tex";
const baseText = "Alpha beta gamma.";
const baseTextHash =
  "aea23d46109af9b94c5f15085d69113cc2cefa85f05748897a4df172a1ee5104";

type ReviewStreamCall = Parameters<typeof streamAgentEvents>[0];

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

/**
 * One endpoint answers both an editor action and a message. Only the editor
 * action carries a captured scope, so that is what the stub uses to decide
 * which shape to answer with.
 */
function agentEvent(
  requestId: string,
  sequence: number,
  event: Record<string, unknown>,
): AgentEvent {
  return {
    ...event,
    eventId: `agent-event-${requestId}-${sequence}`,
    requestId,
    sequence,
    createdAt,
  } as AgentEvent;
}

function reviewingStream(onConversation: (call: ReviewStreamCall) => void) {
  return sinon.stub().callsFake(async (call: ReviewStreamCall) => {
    const { requestId, skill } = call.request;
    if (call.request.scope != null) {
      call.onEvent(
        agentEvent(requestId, 0, {
          type: "started",
          provider: "fake",
          model: "deterministic-v1",
          skill,
        }),
      );
      call.onEvent(
        agentEvent(requestId, 1, {
          type: "finding",
          finding: sourceFinding(call.request),
        }),
      );
      call.onEvent(
        agentEvent(requestId, 2, { type: "completed", finishReason: "stop" }),
      );
      return;
    }
    onConversation(call);
  });
}

async function renderCompletedFindingRun({
  onConversation,
  mountSuggestionPreview,
  applySelectionSuggestion,
  getSelectionContext,
}: {
  onConversation: (call: ReviewStreamCall) => void;
  mountSuggestionPreview?: sinon.SinonStub;
  applySelectionSuggestion?: sinon.SinonStub;
  getSelectionContext?: sinon.SinonStub;
}) {
  const request = sourceRequest();
  const session = sourceSession(request);
  const finding = sourceFinding(request);
  const streamRequest = reviewingStream(onConversation);

  let conversationRequestNumber = 0;
  const rendered = render(
    <AiReviewerPanelView
      projectId={projectId}
      createRequestId={() => request.requestId}
      createDiscussionId={() => "discussion-0001"}
      createDiscussionRequestId={() =>
        `discussion-request-${++conversationRequestNumber}`
      }
      now={() => createdAt}
      captureSelectionSession={async () => ({
        status: "ready",
        session,
      })}
      selectionPreview={{
        fileType: "tex",
        fromLine: 1,
        toLine: 1,
        wordCount: 3,
      }}
      streamRequest={streamRequest}
      getSelectionContext={getSelectionContext}
      mountSuggestionPreview={mountSuggestionPreview}
      applySelectionSuggestion={applySelectionSuggestion}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Review selection" }));
  await screen.findByText("Completed");
  fireEvent.click(screen.getByRole("button", { name: "Discuss finding" }));
  await screen.findByRole("article", { name: "AI reviewer discussion" });

  return {
    ...rendered,
    finding,
    request,
    session,
    streamRequest,
  };
}

async function sendConversationMessage(text: string) {
  typeConversationMessage(text);
  await waitFor(() => {
    expect(screen.queryByTestId("discussion-responding")).to.equal(null);
  });
}

function conversationCalls(streamRequest: sinon.SinonStub) {
  return streamRequest
    .getCalls()
    .map((call) => call.args[0].request as AgentRequest)
    .filter((request) => request.requestId.startsWith("discussion-request-"));
}

describe("AI reviewer: conversation workspace", function () {
  it("shows a responding indicator while an answer is still streaming", async function () {
    // A real answer can take tens of seconds. Without this the composer just
    // goes quiet, which reads as a hang.
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const streamRequest = sinon
      .stub()
      .callsFake(async (call: ReviewStreamCall) => {
        const { requestId } = call.request;
        call.onEvent(
          agentEvent(requestId, 0, {
            type: "started",
            provider: "fake",
            model: "deterministic-v1",
            skill: call.request.skill,
          }),
        );
        await held;
        call.onEvent(
          agentEvent(requestId, 1, {
            type: "text.delta",
            delta: "Delayed reply",
          }),
        );
        call.onEvent(
          agentEvent(requestId, 2, { type: "completed", finishReason: "stop" }),
        );
      });

    render(
      <AiReviewerPanelView
        projectId={projectId}
        createDiscussionId={() => "responding-discussion-0001"}
        createDiscussionRequestId={() => "responding-discussion-request-1"}
        now={() => createdAt}
        streamRequest={streamRequest}
      />,
    );

    typeConversationMessage("Please answer slowly");

    const indicator = await screen.findByTestId("discussion-responding");
    expect(indicator.textContent).to.equal("Responding");
    const discussionHeader = screen
      .getByTestId("discussion-subject")
      .closest<HTMLElement>(".ai-reviewer-discussion-header");
    expect(discussionHeader).not.to.equal(null);
    if (discussionHeader == null) {
      throw new Error("The active discussion header must render.");
    }
    expect(within(discussionHeader).getByRole("button", { name: "Stop" })).to
      .exist;

    release?.();
    await waitFor(() => {
      expect(screen.queryByTestId("discussion-responding")).not.to.exist;
    });
    expect(await screen.findByText("Delayed reply")).to.exist;
  });

  it("sends a scopeless message with only the 12 most recent prior turns", async function () {
    let responseNumber = 0;
    const streamRequest = sinon
      .stub()
      .callsFake(async (call: ReviewStreamCall) => {
        responseNumber += 1;
        const { requestId } = call.request;
        call.onEvent(
          agentEvent(requestId, 0, {
            type: "started",
            provider: "fake",
            model: "deterministic-v1",
            skill: call.request.skill,
          }),
        );
        call.onEvent(
          agentEvent(requestId, 1, {
            type: "text.delta",
            delta: `Open conversation reply ${responseNumber}`,
          }),
        );
        call.onEvent(
          agentEvent(requestId, 2, { type: "completed", finishReason: "stop" }),
        );
      });
    let requestNumber = 0;

    render(
      <AiReviewerPanelView
        projectId={projectId}
        createDiscussionId={() => "open-discussion-0001"}
        createDiscussionRequestId={() =>
          `open-conversation-request-${++requestNumber}`
        }
        now={() => createdAt}
        streamRequest={streamRequest}
      />,
    );

    for (let index = 1; index <= 13; index += 1) {
      await sendConversationMessage(`Open conversation message ${index}`);
    }

    expect(streamRequest.callCount).to.equal(13);
    for (const call of streamRequest.getCalls()) {
      const request = call.args[0].request as AgentRequest;
      expect(request.projectId).to.equal(projectId);
      // Nothing is pinned, so nothing constrains the request but the message.
      expect(request.skill).to.equal(null);
      expect(request.scope).to.equal(undefined);
      expect(request.turns?.length ?? 0).to.be.at.most(
        DISCUSSION_CONTEXT_TURN_LIMIT,
      );
      expect(AgentRequestSchema.safeParse(request).success).to.equal(true);
    }
    const finalRequest = streamRequest.lastCall.args[0].request as AgentRequest;
    expect(finalRequest.instruction).to.equal("Open conversation message 13");
    expect(finalRequest.turns).to.have.length(DISCUSSION_CONTEXT_TURN_LIMIT);
    // `instruction` is the message just sent, so `turns` ends on the answer
    // before it.
    expect(finalRequest.turns?.at(-1)).to.deep.equal({
      role: "assistant",
      text: "Open conversation reply 12",
    });
    expect(screen.getByTestId("discussion-subject").textContent).to.equal(
      "No subject",
    );
  });

  it("keeps the pinned subject, escapes model text, and caps the history", async function () {
    const maliciousModelText =
      '<img src=x onerror="globalThis.pwned=true"><a href="https://attacker.invalid/">click</a>';
    let responseNumber = 0;
    const workspace = await renderCompletedFindingRun({
      onConversation: (call) => {
        responseNumber += 1;
        const { requestId } = call.request;
        call.onEvent(
          agentEvent(requestId, 0, {
            type: "started",
            provider: "fake",
            model: "deterministic-v1",
            skill: call.request.skill,
          }),
        );
        call.onEvent(
          agentEvent(requestId, 1, {
            type: "text.delta",
            delta:
              responseNumber === 1
                ? maliciousModelText
                : `Conversation reply ${responseNumber}`,
          }),
        );
        call.onEvent(
          agentEvent(requestId, 2, { type: "completed", finishReason: "stop" }),
        );
      },
    });

    const thread = screen.getByRole("article", {
      name: "AI reviewer discussion",
    });
    const subject = within(thread).getByTestId("discussion-subject");
    const turns = within(thread).getByLabelText("Discussion turns");
    expect(subject.textContent).to.equal(
      "Finding: Ambiguous discussion phrase",
    );
    expect(subject.closest("header")).not.to.equal(null);
    expect(turns.classList.contains("ai-reviewer-discussion-turns")).to.equal(
      true,
    );
    // The conversation never replaces the rest of the panel.
    expect(screen.getByTestId("ai-reviewer-findings")).to.exist;
    expect(screen.getByTestId("ai-reviewer-mode-row")).to.exist;

    for (let index = 1; index <= 13; index += 1) {
      await sendConversationMessage(`Conversation message ${index}`);
    }

    expect(DISCUSSION_CONTEXT_TURN_LIMIT).to.equal(12);
    const requests = conversationCalls(workspace.streamRequest);
    expect(requests).to.have.length(13);
    for (const request of requests) {
      expect(request.turns?.length ?? 0).to.be.at.most(
        DISCUSSION_CONTEXT_TURN_LIMIT,
      );
      expect(AgentRequestSchema.safeParse(request).success).to.equal(true);
      expect(request.skill).to.equal(null);
      expect(request).not.to.have.property("scope");
    }
    const finalRequest = requests.at(-1);
    expect(finalRequest?.instruction).to.equal("Conversation message 13");
    expect(finalRequest?.turns).to.have.length(DISCUSSION_CONTEXT_TURN_LIMIT);
    expect(finalRequest?.turns?.at(-1)).to.deep.equal({
      role: "assistant",
      text: "Conversation reply 12",
    });

    const renderedTurns = [
      ...workspace.container.querySelectorAll(".message-content"),
    ].map((turn) => turn.textContent);
    expect(renderedTurns).to.include(maliciousModelText);
    expect(workspace.container.querySelector("img")).to.equal(null);
    expect(workspace.container.querySelector("script")).to.equal(null);
    expect((globalThis as unknown as { pwned?: boolean }).pwned).to.equal(
      undefined,
    );
    for (const link of workspace.container.querySelectorAll("a")) {
      expect(link.getAttribute("rel")).to.equal("noreferrer noopener");
    }
  });

  it("routes a conversation suggestion through the existing preview/apply callback with the exact source session", async function () {
    const request = sourceRequest();
    const emittedSuggestion = discussionSuggestion(request);
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
      onConversation: (call) => {
        const { requestId } = call.request;
        call.onEvent(
          agentEvent(requestId, 0, {
            type: "started",
            provider: "fake",
            model: "deterministic-v1",
            skill: call.request.skill,
          }),
        );
        call.onEvent(
          agentEvent(requestId, 1, {
            type: "text.delta",
            delta: "Here is a guarded suggestion.",
          }),
        );
        call.onEvent(
          agentEvent(requestId, 2, {
            type: "suggestion",
            suggestion: emittedSuggestion,
          }),
        );
        call.onEvent(
          agentEvent(requestId, 3, { type: "completed", finishReason: "stop" }),
        );
      },
      mountSuggestionPreview,
      applySelectionSuggestion,
      getSelectionContext,
    });

    expect(workspace.session.request).to.deep.equal(request);
    typeConversationMessage("Please propose a precise replacement.");
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
