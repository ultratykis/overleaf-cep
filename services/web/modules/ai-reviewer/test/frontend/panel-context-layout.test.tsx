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
import {
  AgentStreamError,
  streamAgentEvents,
} from "../../frontend/js/services/agent-stream";
import type { AiProviderConnection } from "../../frontend/js/services/ai-provider-configuration";
import type {
  AgentRequest,
  AiReviewerWorkspace,
  AiReviewerWorkspaceSnapshot,
  Finding,
} from "../../shared/contract-types";
import {
  hostChatInputLabel,
  typeConversationMessage,
} from "./helpers/panel-composer";

type ReviewStreamCall = Parameters<typeof streamAgentEvents>[0];

const createdAt = "2026-07-30T00:00:00.000Z";
const projectId = "context-layout-project";
const documentId = "context-layout-document";
const path = "chapters/context.tex";
const baseTextHash =
  "aea23d46109af9b94c5f15085d69113cc2cefa85f05748897a4df172a1ee5104";
const selectedText = "beta";
const selectionPreview = {
  filename: "main.tex",
  fromLine: 1,
  toLine: 1,
  wordCount: 1,
} as const;
const projectReviewInstruction =
  "Review this project and identify the most important issue.";

const localConnection: AiProviderConnection = {
  id: "connection-local",
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
const claudeConnection: AiProviderConnection = {
  id: "connection-claude",
  label: "Anthropic Claude",
  classification: "remote",
  config: {
    provider: "claude",
    contextLengthOverride: null,
    credentialSet: true,
    credentialUpdatedAt: createdAt,
  },
};

function catalogModel(
  connection: AiProviderConnection,
  id: string,
  displayName: string,
) {
  return {
    id,
    displayName,
    connectionId: connection.id,
    connectionLabel: connection.label,
  };
}

const defaultModel = catalogModel(
  localConnection,
  "reviewer-default-v1",
  "Default reviewer",
);
const alternateModel = catalogModel(
  claudeConnection,
  "claude-sonnet-4-20250514",
  "Claude Sonnet",
);

function providerProps(
  connections: AiProviderConnection[] = [localConnection, claudeConnection],
  models = [defaultModel, alternateModel],
) {
  return {
    loadProviderConnections: sinon.stub().resolves({ connections }),
    loadProviderModels: sinon.stub().resolves({ models, failures: [] }),
  };
}

function sourceRequest(
  requestId: string,
  action: AgentRequest["action"] = "review",
  instruction = "Review the selected phrase.",
): AgentRequest {
  return {
    requestId,
    projectId,
    action,
    instruction,
    skill: "referee-review",
    scope: {
      kind: "selection",
      documentId,
      path,
      baseRevision: 7,
      baseTextHash,
      range: { from: 6, to: 10 },
      text: selectedText,
    },
  };
}

function sourceFinding(
  request: AgentRequest,
  message = "The selected phrase needs a more precise explanation.",
): Finding {
  return {
    id: "context-layout-finding",
    requestId: request.requestId,
    projectId: request.projectId,
    artifactKind: "finding",
    severity: "warning",
    category: "clarity",
    title: "Ambiguous phrase",
    message,
    evidence: [
      {
        path,
        range: { from: 6, to: 10 },
        revision: 7,
        textHash: baseTextHash,
      },
    ],
    suggestionIds: [],
  };
}

// The capture echoes the action it was asked for, because the panel refuses a
// session whose request does not match the one it started.
function captureSelectionSession() {
  return sinon
    .stub()
    .callsFake(
      async ({
        requestId,
        action,
        instruction,
      }: {
        requestId: string;
        action: AgentRequest["action"];
        instruction: string;
      }) => ({
        status: "ready" as const,
        session: Object.freeze({
          request: Object.freeze(sourceRequest(requestId, action, instruction)),
          binding: Object.freeze({
            currentDocument: {},
            shareDocument: {},
            trackChanges: false,
            connectionEpoch: 1,
          }),
        }),
      }),
    );
}

/**
 * One endpoint now answers both a review and a message. An editor action
 * carries its captured scope, while a typed message stays scope-free.
 */
function unifiedStream(
  answer = "A precise explanation.",
  findingMessage?: string,
) {
  return sinon.stub().callsFake(async (call: ReviewStreamCall) => {
    const { requestId, skill } = call.request;
    const reviewing = call.request.scope != null;
    let sequence = 0;
    const emit = (event: Record<string, unknown>) =>
      call.onEvent({
        eventId: `${requestId}-${sequence}`,
        requestId,
        sequence: sequence++,
        createdAt,
        ...event,
      } as Parameters<ReviewStreamCall["onEvent"]>[0]);

    emit({
      type: "started",
      provider: "fake",
      model: "deterministic-v1",
      skill,
    });
    if (reviewing) {
      emit({
        type: "finding",
        finding: sourceFinding(call.request, findingMessage),
      });
    } else {
      emit({ type: "text.delta", delta: answer });
    }
    emit({ type: "completed", finishReason: "stop" });
  });
}

/**
 * The saved model choice has to outlive a reload, so the store keeps the whole
 * workspace exactly as the panel wrote it.
 */
class MemoryWorkspace {
  workspace: AiReviewerWorkspace = { runs: [], discussions: [] };
  revision = 1;

  load = async (): Promise<AiReviewerWorkspaceSnapshot> => ({
    revision: this.revision,
    workspace: JSON.parse(JSON.stringify(this.workspace)),
  });

  save = async (
    _projectId: string,
    workspace: AiReviewerWorkspace,
  ): Promise<AiReviewerWorkspaceSnapshot> => {
    this.workspace = JSON.parse(JSON.stringify(workspace));
    this.revision += 1;
    return { revision: this.revision, workspace: this.workspace };
  };

  deleteDiscussion = async () => ({
    revision: this.revision,
    workspace: this.workspace,
  });

  deleteAll = async () => ({
    revision: this.revision,
    workspace: this.workspace,
  });
}

function renderPanel(
  props: Partial<React.ComponentProps<typeof AiReviewerPanelView>> = {},
) {
  return render(<AiReviewerPanelView projectId={projectId} {...props} />);
}

function composerField() {
  return screen.getByRole("textbox", {
    name: hostChatInputLabel,
  }) as HTMLTextAreaElement;
}

async function chooseModel(name: string) {
  fireEvent.click(await screen.findByRole("button", { name: "Model" }));
  fireEvent.click(screen.getByRole("menuitem", { name }));
}

async function reviewedSelection(
  props: Partial<React.ComponentProps<typeof AiReviewerPanelView>> = {},
) {
  const streamRequest = unifiedStream();
  const rendered = renderPanel({
    createRequestId: () => "context-layout-request",
    createDiscussionId: () => "context-layout-discussion",
    createDiscussionRequestId: () => "context-layout-discussion-request",
    now: () => createdAt,
    captureSelectionSession: captureSelectionSession(),
    selectionPreview,
    streamRequest,
    ...props,
  });
  fireEvent.click(screen.getByRole("button", { name: "Review selection" }));
  await screen.findByText("Ambiguous phrase");
  return { ...rendered, streamRequest };
}

describe("AI reviewer: context-driven panel", function () {
  // Spec case 11
  it("offers only the way to add a connection when none exists", async function () {
    renderPanel({
      captureSelectionSession: sinon.stub(),
      selectionPreview,
      ...providerProps([], []),
    });

    expect(await screen.findByTestId("ai-reviewer-onboarding")).to.exist;
    expect(screen.getByRole("button", { name: "Add connection" })).to.exist;
    expect(screen.queryByTestId("ai-reviewer-bottom-controls")).not.to.exist;
    expect(screen.queryByRole("button", { name: "Model" })).not.to.exist;
    expect(screen.queryByRole("textbox")).not.to.exist;
    expect(screen.queryByRole("button", { name: "Review selection" })).not.to
      .exist;
    expect(screen.queryByRole("button", { name: "Review whole project" })).not
      .to.exist;
  });

  it("keeps the conversation as the default surface", async function () {
    renderPanel({
      captureSelectionSession: sinon.stub(),
      ...providerProps(),
    });
    await screen.findByRole("button", { name: "Model" });

    const conversation = screen.getByTestId("ai-reviewer-conversation");
    expect(
      screen.getByText(
        "Review a selection, document, or project, then discuss the results here.",
      ),
    ).to.exist;
    expect(conversation).to.exist;
    expect(composerField()).to.exist;
    expect(screen.queryByRole("button", { name: "Send" })).not.to.exist;
    expect(screen.queryByTestId("ai-reviewer-review-shortcuts")).not.to.exist;
    expect(screen.getByTestId("ai-reviewer-mode-row")).to.exist;
    expect(
      screen.getByRole("button", { name: "Review mode" }).textContent,
    ).to.equal("No mode");
  });

  it("sends a typed message with the selected review mode and no scope", async function () {
    const streamRequest = unifiedStream();
    renderPanel({
      createDiscussionId: () => "review-mode-discussion",
      createDiscussionRequestId: () => "review-mode-request",
      streamRequest,
    });

    fireEvent.click(screen.getByRole("button", { name: "Review mode" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Review mode" }));
    typeConversationMessage("Review chapter 3 as a referee.");
    await screen.findByText("A precise explanation.");

    const request = streamRequest.firstCall.args[0].request;
    expect(request.instruction).to.equal("Review chapter 3 as a referee.");
    expect(request.skill).to.equal("referee-review");
    expect(request).not.to.have.property("scope");
    expect(
      screen.getByRole("button", { name: "Review mode" }).textContent,
    ).to.equal("Review mode");
  });

  it("sends a typed message with brainstorm mode and no scope", async function () {
    const streamRequest = unifiedStream();
    renderPanel({
      createDiscussionId: () => "brainstorm-mode-discussion",
      createDiscussionRequestId: () => "brainstorm-mode-request",
      streamRequest,
    });

    fireEvent.click(screen.getByRole("button", { name: "Review mode" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Brainstorm mode" }));
    typeConversationMessage("Generate alternative explanations.");
    await screen.findByText("A precise explanation.");

    const request = streamRequest.firstCall.args[0].request;
    expect(request.skill).to.equal("brainstorm");
    expect(request).not.to.have.property("scope");
  });

  it("hides the findings area while brainstorm mode is active", async function () {
    await reviewedSelection();
    expect(screen.getByTestId("ai-reviewer-findings")).to.exist;

    fireEvent.click(screen.getByRole("button", { name: "Review mode" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Brainstorm mode" }));

    expect(screen.queryByTestId("ai-reviewer-findings")).not.to.exist;
  });

  // Spec case 5
  it("sends a typed message with no skill or scope in No mode", async function () {
    const streamRequest = unifiedStream();
    renderPanel({
      createDiscussionId: () => "typed-message-discussion",
      createDiscussionRequestId: () => "typed-message-request",
      now: () => createdAt,
      streamRequest,
    });

    typeConversationMessage(`${projectReviewInstruction} But only chapter 2.`);
    await screen.findByText("A precise explanation.");

    expect(streamRequest.calledOnce).to.equal(true);
    const request = streamRequest.firstCall.args[0].request;
    expect(request.instruction).to.equal(
      `${projectReviewInstruction} But only chapter 2.`,
    );
    expect(request.skill).to.equal(null);
    expect(request).not.to.have.property("scope");
    expect(screen.queryByLabelText("Review run 1")).not.to.exist;
  });

  // Spec case 6
  it("keeps the findings out of the conversation as it grows", async function () {
    await reviewedSelection();

    const findings = screen.getByTestId("ai-reviewer-findings");
    const conversation = screen.getByTestId("ai-reviewer-conversation");
    const finding = screen.getByText("Ambiguous phrase");

    expect(findings.contains(finding)).to.equal(true);
    expect(conversation.contains(finding)).to.equal(false);
    expect(findings.contains(conversation)).to.equal(false);
    expect(conversation.contains(findings)).to.equal(false);
    // The list is a separate scroller, so a long thread cannot carry it away.
    expect(
      findings.compareDocumentPosition(conversation) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).to.not.equal(0);

    typeConversationMessage("Why is it ambiguous?");
    await screen.findByText("A precise explanation.");

    expect(screen.getByTestId("ai-reviewer-findings").textContent).to.contain(
      "Ambiguous phrase",
    );
  });

  it("renders markdown in review findings", async function () {
    const streamRequest = unifiedStream(
      undefined,
      "A **clear finding** with `inline evidence`.",
    );
    const { container } = await reviewedSelection({ streamRequest });
    const finding = container.querySelector(".ai-reviewer-artifact");

    expect(finding?.querySelector("strong")?.textContent).to.equal(
      "clear finding",
    );
    expect(finding?.querySelector("code")?.textContent).to.equal(
      "inline evidence",
    );
  });

  // Spec case 7
  it("keeps a dismissed finding in the list, dimmed", async function () {
    await reviewedSelection();

    fireEvent.click(screen.getByRole("button", { name: "Discard finding" }));

    const finding = await screen.findByText("Ambiguous phrase");
    const card = finding.closest(".ai-reviewer-artifact");
    expect(card).not.to.equal(null);
    expect(card?.classList.contains("ai-reviewer-artifact-resolved")).to.equal(
      true,
    );
    expect(
      screen.getByTestId("ai-reviewer-findings").contains(finding),
    ).to.equal(true);
    expect(screen.getByText("Status: Discarded")).to.exist;
    // The heading counts only what still needs the reader.
    expect(screen.getByText("Findings (0 unresolved)")).to.exist;
  });

  // Spec case 9
  it("keeps the selection controls above the composer with and without results", async function () {
    await reviewedSelection();

    const transforms = screen.getByTestId("ai-reviewer-selection-transforms");
    const composer = composerField();
    expect(screen.getByRole("button", { name: "Rewrite selection" })).to.exist;
    expect(screen.getByRole("button", { name: "Shorten selection" })).to.exist;
    // No disclosure stands between a selection and what can be done with it.
    expect(transforms.closest("details")).to.equal(null);
    expect(
      transforms.compareDocumentPosition(composer) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).to.not.equal(0);
  });

  // Spec case 10
  it("shows the tools used without their arguments or results", async function () {
    const streamRequest = sinon
      .stub()
      .callsFake(async (call: ReviewStreamCall) => {
        const { requestId } = call.request;
        let sequence = 0;
        const emit = (event: Record<string, unknown>) =>
          call.onEvent({
            eventId: `${requestId}-${sequence}`,
            requestId,
            sequence: sequence++,
            createdAt,
            ...event,
          } as Parameters<ReviewStreamCall["onEvent"]>[0]);
        emit({
          type: "started",
          provider: "fake",
          model: "deterministic-v1",
          skill: call.request.skill,
        });
        emit({
          type: "tool.call",
          call: {
            id: "tool-read",
            name: "read_project_file",
            arguments: { path: "main.tex", range: { from: 12, to: 48 } },
          },
        });
        emit({
          type: "tool.call",
          call: {
            id: "tool-zotero",
            name: "search_zotero",
            arguments: { query: "greenwade" },
          },
        });
        emit({ type: "text.delta", delta: "The citation checks out." });
        emit({ type: "completed", finishReason: "stop" });
      });
    renderPanel({
      createDiscussionId: () => "tool-discussion",
      createDiscussionRequestId: () => "tool-request",
      now: () => createdAt,
      streamRequest,
    });

    typeConversationMessage("Does Greenwade support this?");
    await screen.findByText("The citation checks out.");

    const conversation = screen.getByTestId("ai-reviewer-conversation");
    expect(conversation.textContent).to.contain("read_project_file · main.tex");
    expect(conversation.textContent).to.contain("search_zotero · greenwade");
    // The range is part of the arguments, and a result is never shown at all.
    expect(document.body.textContent).not.to.contain("12");
    expect(document.body.textContent).not.to.contain("48");
    expect(document.body.textContent).not.to.contain("tool-read");
  });

  // Spec case 10, for a review rather than a message
  it("shows the tools a review used in its own run", async function () {
    const streamRequest = sinon
      .stub()
      .callsFake(async (call: ReviewStreamCall) => {
        const { requestId } = call.request;
        call.onEvent({
          type: "started",
          eventId: `${requestId}-started`,
          requestId,
          sequence: 0,
          createdAt,
          provider: "fake",
          model: "deterministic-v1",
          skill: call.request.skill,
        });
        call.onEvent({
          type: "tool.call",
          eventId: `${requestId}-tool`,
          requestId,
          sequence: 1,
          createdAt,
          call: {
            id: "review-tool-read",
            name: "read_project_file",
            arguments: { path: "chapters/two.tex" },
          },
        });
        call.onEvent({
          type: "completed",
          eventId: `${requestId}-completed`,
          requestId,
          sequence: 2,
          createdAt,
          finishReason: "stop",
        });
      });
    renderPanel({
      captureSelectionSession: captureSelectionSession(),
      selectionPreview,
      streamRequest,
    });
    fireEvent.click(screen.getByRole("button", { name: "Review selection" }));
    const run = await screen.findByRole("article", { name: "Review run 1" });

    expect(run.textContent).to.contain("read_project_file · chapters/two.tex");
    // The wording that ran is shown beside what it did.
    expect(run.textContent).to.contain("Review the selected phrase.");
    expect(document.body.textContent).not.to.contain("review-tool-read");
  });

  it("locks the mode selector while a review streams", async function () {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const streamRequest = sinon
      .stub()
      .callsFake(async (call: ReviewStreamCall) => {
        const { requestId } = call.request;
        call.onEvent({
          type: "started",
          eventId: `${requestId}-started`,
          requestId,
          sequence: 0,
          createdAt,
          provider: "fake",
          model: "deterministic-v1",
          skill: call.request.skill,
        });
        await held;
        call.onEvent({
          type: "completed",
          eventId: `${requestId}-completed`,
          requestId,
          sequence: 1,
          createdAt,
          finishReason: "stop",
        });
      });
    renderPanel({
      captureSelectionSession: captureSelectionSession(),
      selectionPreview,
      streamRequest,
    });

    fireEvent.click(screen.getByRole("button", { name: "Review selection" }));
    await screen.findByRole("article", { name: "Review run 1" });

    const modeSelector = screen.getByRole("button", {
      name: "Review mode",
    }) as HTMLButtonElement;
    expect(modeSelector.disabled).to.equal(true);

    release();
    await waitFor(() => expect(modeSelector.disabled).to.equal(false));
  });

  // Spec case 12
  it("shows stop and locks the mode selector while an answer streams", async function () {
    let release: (() => void) | null = null;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const streamRequest = sinon
      .stub()
      .callsFake(async (call: ReviewStreamCall) => {
        const { requestId } = call.request;
        call.onEvent({
          type: "started",
          eventId: `${requestId}-started`,
          requestId,
          sequence: 0,
          createdAt,
          provider: "fake",
          model: "deterministic-v1",
          skill: call.request.skill,
        });
        await held;
        call.onEvent({
          type: "completed",
          eventId: `${requestId}-completed`,
          requestId,
          sequence: 1,
          createdAt,
          finishReason: "stop",
        });
      });
    renderPanel({
      createDiscussionId: () => "stop-discussion",
      createDiscussionRequestId: () => "stop-request",
      now: () => createdAt,
      streamRequest,
    });

    typeConversationMessage("Take your time");

    const discussionHeader = (
      await screen.findByTestId("discussion-subject")
    ).closest<HTMLElement>(".ai-reviewer-discussion-header");
    expect(discussionHeader).not.to.equal(null);
    if (discussionHeader == null) {
      throw new Error("The active discussion header must render.");
    }
    const stop = within(discussionHeader).getByRole("button", { name: "Stop" });
    expect(screen.queryByRole("button", { name: "Send" })).not.to.exist;
    expect(await screen.findByTestId("discussion-responding")).to.exist;
    const modeSelector = screen.getByRole("button", {
      name: "Review mode",
    }) as HTMLButtonElement;
    expect(modeSelector.disabled).to.equal(true);

    fireEvent.click(stop);

    await waitFor(
      () =>
        expect(within(discussionHeader).queryByRole("button", { name: "Stop" }))
          .not.to.exist,
    );
    expect(screen.queryByTestId("discussion-responding")).not.to.exist;
    expect(modeSelector.disabled).to.equal(false);
    release?.();
  });

  it("pins the finding as the subject of the conversation", async function () {
    await reviewedSelection();

    fireEvent.click(screen.getByRole("button", { name: "Discuss finding" }));

    const conversation = screen.getByTestId("ai-reviewer-conversation");
    expect(screen.getByTestId("discussion-subject").textContent).to.equal(
      "Finding: Ambiguous phrase",
    );
    // The subject is pinned inside the thread, not on a screen of its own.
    expect(
      conversation.contains(screen.getByTestId("discussion-subject")),
    ).to.equal(true);
    const quote = screen.getByTestId("discussion-quote");
    expect(quote.textContent).to.contain("What this is about");
    expect(quote.textContent).to.contain(`${path} (chars 6–10)`);
    expect(quote.textContent).to.contain(selectedText);
    // The composer and the findings both survive the pin.
    expect(composerField()).to.exist;
    expect(screen.getByTestId("ai-reviewer-findings")).to.exist;
  });

  it("uses the visible mode and omits scope in the pinned conversation", async function () {
    const { streamRequest } = await reviewedSelection();

    fireEvent.click(screen.getByRole("button", { name: "Discuss finding" }));
    typeConversationMessage("Why is it ambiguous?");
    await screen.findByText("A precise explanation.");

    const request = streamRequest.secondCall.args[0].request;
    expect(request.instruction).to.equal("Why is it ambiguous?");
    expect(request.skill).to.equal(null);
    expect(request).not.to.have.property("scope");
    // The pinned finding leads the history as the assistant turn it was.
    expect(request.turns[0]).to.deep.equal({
      role: "assistant",
      text: "Ambiguous phrase\n\nThe selected phrase needs a more precise explanation.",
    });
  });

  it("keeps host chat bubble structure while splitting turns by author", async function () {
    const { container } = await reviewedSelection();
    fireEvent.click(screen.getByRole("button", { name: "Discuss finding" }));
    typeConversationMessage("Why is it ambiguous?");
    await screen.findByText("A precise explanation.");

    const groups = [...container.querySelectorAll(".chat-message")];
    expect(groups).to.have.length(2);

    const [own, answer] = groups;
    expect(
      own
        .querySelector(".message-container")
        ?.classList.contains("message-from-self"),
    ).to.equal(true);
    expect(own.querySelector(".message-author")).to.equal(null);
    expect(own.textContent).to.contain("Why is it ambiguous?");

    expect(
      answer
        .querySelector(".message-container")
        ?.classList.contains("message-from-self"),
    ).to.equal(false);
    expect(answer.querySelector(".message-author")?.textContent).to.equal(
      "AI reviewer",
    );
    expect(answer.textContent).to.contain("A precise explanation.");
  });

  it("saves the chosen model and restores it after a reload", async function () {
    const store = new MemoryWorkspace();
    const first = renderPanel({
      workspacePersistence: store,
      ...providerProps(),
    });

    await chooseModel(`Claude Sonnet (${claudeConnection.label})`);
    await waitFor(() => {
      expect(store.workspace.selectedModel).to.deep.equal({
        connectionId: claudeConnection.id,
        model: alternateModel.id,
      });
    });
    first.unmount();

    renderPanel({ workspacePersistence: store, ...providerProps() });

    expect(
      (await screen.findByRole("button", { name: "Model" })).textContent,
    ).to.equal("Claude Sonnet");
  });

  it("sends the same choice from a review, a transform, and a message", async function () {
    const streamRequest = unifiedStream();
    renderPanel({
      createRequestId: () => "context-layout-request",
      createDiscussionId: () => "context-layout-discussion",
      createDiscussionRequestId: () => "context-layout-discussion-request",
      now: () => createdAt,
      captureSelectionSession: captureSelectionSession(),
      selectionPreview,
      streamRequest,
      ...providerProps(),
    });

    await chooseModel(`Claude Sonnet (${claudeConnection.label})`);
    fireEvent.click(screen.getByRole("button", { name: "Review selection" }));
    await screen.findByText("Ambiguous phrase");
    typeConversationMessage("Why is it ambiguous?");
    await screen.findByText("A precise explanation.");
    fireEvent.click(screen.getByRole("button", { name: "Rewrite selection" }));
    await waitFor(() => {
      expect(streamRequest.callCount).to.equal(3);
    });

    for (const call of streamRequest.getCalls()) {
      expect(call.args[0].request).to.include({
        connectionId: claudeConnection.id,
        model: alternateModel.id,
      });
    }
  });

  it("falls back to the first model when the stored connection is gone", async function () {
    const store = new MemoryWorkspace();
    store.workspace = {
      runs: [],
      discussions: [],
      selectedModel: {
        connectionId: "connection-removed",
        model: "removed-model",
      },
    };
    renderPanel({
      workspacePersistence: store,
      ...providerProps([localConnection], [defaultModel, alternateModel]),
    });

    expect(
      (await screen.findByRole("button", { name: "Model" })).textContent,
    ).to.equal("Default reviewer");
    // The recovered choice is written back, so the next reload is not stale too.
    await waitFor(() => {
      expect(store.workspace.selectedModel).to.deep.equal({
        connectionId: localConnection.id,
        model: defaultModel.id,
      });
    });
  });

  it("separates waiting, switching, and everything else without quoting the provider", async function () {
    const providerProse = "Upstream said: the manuscript title leaked here.";
    const cases = [
      {
        code: "AI_PROVIDER_MODEL_BUSY",
        category: "rate-limit" as const,
        guidance:
          "This model is busy right now. Wait a moment, then try again.",
      },
      {
        code: "AI_PROVIDER_MODEL_UNAVAILABLE",
        category: "configuration" as const,
        guidance: "This model is not available. Choose a different model.",
      },
      {
        code: "AI_PROVIDER_ERROR",
        category: "provider" as const,
        guidance:
          "The AI provider could not complete the request. Try again; if it keeps failing, switch models or check the AI Reviewer settings.",
      },
    ];

    for (const failure of cases) {
      const rendered = renderPanel({
        captureSelectionSession: captureSelectionSession(),
        selectionPreview,
        streamRequest: sinon.stub().rejects(
          new AgentStreamError({
            code: failure.code,
            category: failure.category,
            message: providerProse,
            retryable: true,
          }),
        ),
      });

      fireEvent.click(screen.getByRole("button", { name: "Review selection" }));
      const alert = await screen.findByRole("alert");

      expect(alert.textContent, failure.code).to.equal(failure.guidance);
      expect(document.body.textContent).not.to.contain(providerProse);
      rendered.unmount();
    }
  });
});
