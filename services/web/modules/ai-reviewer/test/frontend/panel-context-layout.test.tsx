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
const claudeConnection: AiProviderConnection = {
  id: "connection-claude",
  revision: 1,
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
  contextLength: number | null = null,
  contextLengthSource:
    | "detected"
    | "override"
    | "pending"
    | "unavailable" = "pending",
) {
  return {
    id,
    displayName,
    connectionId: connection.id,
    connectionLabel: connection.label,
    contextLength,
    contextLengthSource,
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
  200_000,
  "detected",
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

function ChangedProviderSettings({
  onHide,
}: {
  onHide: (connectionsChanged: boolean) => void;
}) {
  return (
    <button type="button" onClick={() => onHide(true)}>
      Close changed settings
    </button>
  );
}

function UnchangedProviderSettings({
  onHide,
}: {
  onHide: (connectionsChanged: boolean) => void;
}) {
  return (
    <button type="button" onClick={() => onHide(false)}>
      Close unchanged settings
    </button>
  );
}

function composerField() {
  return screen.getByRole("textbox", {
    name: hostChatInputLabel,
  }) as HTMLTextAreaElement;
}

async function chooseModel(name: string) {
  fireEvent.click(
    await screen.findByRole("button", { name: /^Selected model/u }),
  );
  fireEvent.click(
    screen
      .getAllByRole("menuitem")
      .find((item) => item.textContent?.startsWith(name)) as HTMLElement,
  );
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
    expect(screen.queryByRole("button", { name: /^Selected model/u })).not.to
      .exist;
    expect(screen.queryByRole("textbox")).not.to.exist;
    expect(screen.queryByRole("button", { name: "Review selection" })).not.to
      .exist;
    expect(screen.queryByRole("button", { name: "Review whole project" })).not
      .to.exist;
  });

  it("refreshes a changed settings catalogue and renders its new connection and model", async function () {
    const loadProviderConnections = sinon.stub();
    loadProviderConnections.onFirstCall().resolves({ connections: [] });
    loadProviderConnections.resolves({ connections: [claudeConnection] });
    const loadProviderModels = sinon.stub();
    loadProviderModels.onFirstCall().resolves({ models: [], failures: [] });
    loadProviderModels.resolves({ models: [alternateModel], failures: [] });
    renderPanel({
      loadProviderConnections,
      loadProviderModels,
      providerSettingsComponent: ChangedProviderSettings,
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Add connection" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Close changed settings" }),
    );

    const modelChip = await screen.findByRole("button", {
      name: "Selected model — None",
    });
    expect(screen.queryByTestId("ai-reviewer-onboarding")).not.to.exist;
    expect(loadProviderConnections).to.have.been.calledTwice;
    expect(loadProviderModels).to.have.been.calledTwice;
    fireEvent.click(modelChip);
    expect(
      screen.getByRole("menuitem", {
        name: /Claude Sonnet.*Anthropic Claude/u,
      }),
    ).to.exist;
  });

  it("does not refresh the provider catalogue when settings close unchanged", async function () {
    const loadProviderConnections = sinon
      .stub()
      .resolves({ connections: [] });
    const loadProviderModels = sinon
      .stub()
      .resolves({ models: [], failures: [] });
    renderPanel({
      loadProviderConnections,
      loadProviderModels,
      providerSettingsComponent: UnchangedProviderSettings,
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Add connection" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Close unchanged settings" }),
    );
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Close unchanged settings" }),
      ).not.to.exist;
    });

    expect(loadProviderConnections).to.have.been.calledOnce;
    expect(loadProviderModels).to.have.been.calledOnce;
  });

  it("offers a retry when the connection refresh fails after settings changed", async function () {
    const loadProviderConnections = sinon.stub();
    loadProviderConnections.onFirstCall().resolves({
      connections: [localConnection],
    });
    loadProviderConnections.onSecondCall().rejects(new Error("HTTP 504"));
    loadProviderConnections.resolves({ connections: [] });
    const loadProviderModels = sinon.stub();
    loadProviderModels.onFirstCall().resolves({
      models: [defaultModel],
      failures: [],
    });
    loadProviderModels.resolves({ models: [], failures: [] });
    const streamRequest = sinon
      .stub()
      .callsFake(async (call: ReviewStreamCall) => {
        call.onEvent({
          type: "error",
          eventId: "context-too-small-before-deletion",
          requestId: call.request.requestId,
          sequence: 0,
          createdAt,
          error: {
            code: "AI_MODEL_CONTEXT_TOO_SMALL",
            category: "configuration",
            message: "Bounded server wording.",
            retryable: false,
          },
        });
      });
    renderPanel({
      captureSelectionSession: captureSelectionSession(),
      selectionPreview,
      streamRequest,
      loadProviderConnections,
      loadProviderModels,
      providerSettingsComponent: ChangedProviderSettings,
    });

    expect(
      await screen.findByRole("button", { name: "Selected model — None" }),
    ).to.exist;
    fireEvent.click(screen.getByRole("button", { name: "Review selection" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Open connection settings" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Close changed settings" }),
    );

    expect(
      (await screen.findByTestId("ai-reviewer-connection-catalog-error"))
        .textContent,
    ).to.equal("Connections could not be loaded.");
    expect(screen.queryByRole("button", { name: /^Selected model/u })).not.to
      .exist;
    fireEvent.click(
      screen.getByRole("button", { name: "Retry loading connections" }),
    );

    expect(await screen.findByTestId("ai-reviewer-onboarding")).to.exist;
    expect(loadProviderConnections.callCount).to.equal(3);
    expect(loadProviderModels.callCount).to.equal(3);
  });

  it("hides the sole connection's stale model when its refresh fails after deletion", async function () {
    const loadProviderConnections = sinon.stub();
    loadProviderConnections.onFirstCall().resolves({
      connections: [localConnection],
    });
    loadProviderConnections.resolves({ connections: [] });
    const loadProviderModels = sinon.stub();
    loadProviderModels.onFirstCall().resolves({
      models: [defaultModel],
      failures: [],
    });
    loadProviderModels.rejects(new Error("HTTP 409"));
    const streamRequest = sinon
      .stub()
      .callsFake(async (call: ReviewStreamCall) => {
        call.onEvent({
          type: "error",
          eventId: "context-too-small",
          requestId: call.request.requestId,
          sequence: 0,
          createdAt,
          error: {
            code: "AI_MODEL_CONTEXT_TOO_SMALL",
            category: "configuration",
            message: "Bounded server wording.",
            retryable: false,
          },
        });
      });
    renderPanel({
      captureSelectionSession: captureSelectionSession(),
      selectionPreview,
      streamRequest,
      loadProviderConnections,
      loadProviderModels,
      providerSettingsComponent: ChangedProviderSettings,
    });

    expect(
      await screen.findByRole("button", { name: "Selected model — None" }),
    ).to.exist;
    fireEvent.click(screen.getByRole("button", { name: "Review selection" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Open connection settings" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Close changed settings" }),
    );

    expect(await screen.findByTestId("ai-reviewer-onboarding")).to.exist;
    expect(loadProviderConnections).to.have.been.calledTwice;
    expect(loadProviderModels).to.have.been.calledTwice;
    expect(screen.queryByRole("button", { name: /^Selected model/u })).not.to
      .exist;
  });

  it("hides the saved unresolved count while no connection onboarding is shown", async function () {
    const store = new MemoryWorkspace();
    const request = sourceRequest("saved-onboarding-finding");
    store.workspace = {
      runs: [
        {
          generation: 1,
          createdOrder: 1,
          request,
          text: "Saved review text.",
          findings: [
            {
              artifact: sourceFinding(request),
              status: "unresolved",
            },
          ],
          suggestions: [],
        },
      ],
      discussions: [],
    };

    renderPanel({
      workspacePersistence: store,
      ...providerProps([], []),
    });

    expect(await screen.findByTestId("ai-reviewer-onboarding")).to.exist;
    expect(
      screen.queryByRole("button", {
        name: "Go to unresolved findings (1)",
      }),
    ).not.to.exist;
  });

  it("keeps the conversation as the default surface", async function () {
    renderPanel({
      captureSelectionSession: sinon.stub(),
      ...providerProps(),
    });
    await screen.findByRole("button", { name: "Selected model — None" });

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
      screen.getByRole("button", { name: "Selected mode — Freeform" })
        .textContent,
    ).to.equal("Freeform");
  });

  it("sends a typed message with the selected review mode and no scope", async function () {
    const streamRequest = unifiedStream();
    renderPanel({
      createDiscussionId: () => "review-mode-discussion",
      createDiscussionRequestId: () => "review-mode-request",
      streamRequest,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Selected mode — Freeform" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Review mode" }));
    typeConversationMessage("Review chapter 3 as a referee.");
    await screen.findByText("A precise explanation.");

    const request = streamRequest.firstCall.args[0].request;
    expect(request.instruction).to.equal("Review chapter 3 as a referee.");
    expect(request.skill).to.equal("referee-review");
    expect(request).not.to.have.property("scope");
    expect(
      screen.getByRole("button", { name: "Selected mode — Review mode" })
        .textContent,
    ).to.equal("Review mode");
  });

  it("sends a typed message with brainstorm mode and no scope", async function () {
    const streamRequest = unifiedStream();
    renderPanel({
      createDiscussionId: () => "brainstorm-mode-discussion",
      createDiscussionRequestId: () => "brainstorm-mode-request",
      streamRequest,
    });

    fireEvent.click(
      screen.getByRole("button", { name: "Selected mode — Freeform" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Brainstorm mode" }));
    typeConversationMessage("Generate alternative explanations.");
    await screen.findByText("A precise explanation.");

    const request = streamRequest.firstCall.args[0].request;
    expect(request.skill).to.equal("brainstorm");
    expect(request).not.to.have.property("scope");
    expect(
      screen.getByRole("button", {
        name: "Selected mode — Brainstorm mode",
      }).textContent,
    ).to.equal("Brainstorm mode");
  });

  it("keeps earlier run findings visible while brainstorm mode is active", async function () {
    await reviewedSelection();
    const run = screen.getByRole("article", { name: "Review run 1" });
    expect(within(run).getByRole("region", { name: "Review findings" })).to
      .exist;

    fireEvent.click(
      screen.getByRole("button", { name: "Selected mode — Freeform" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Brainstorm mode" }));

    expect(within(run).getByRole("region", { name: "Review findings" })).to
      .exist;
    expect(
      screen.getByRole("button", { name: "Go to unresolved findings (1)" }),
    ).to.exist;
  });

  // Spec case 5
  it("sends a typed message with no skill or scope in Freeform", async function () {
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
  it("keeps each finding in its run and jumps back from a growing discussion", async function () {
    await reviewedSelection();

    const run = screen.getByRole("article", { name: "Review run 1" });
    const findings = within(run).getByRole("region", {
      name: "Review findings",
    });
    const conversation = screen.getByTestId("ai-reviewer-conversation");
    const finding = screen.getByText("Ambiguous phrase");
    const findingCard = finding.closest<HTMLElement>(".ai-reviewer-artifact");
    expect(findingCard).not.to.equal(null);
    if (findingCard == null) {
      throw new Error("The finding card must render in its source run.");
    }

    expect(findings.contains(finding)).to.equal(true);
    expect(run.contains(findings)).to.equal(true);
    expect(conversation.contains(run)).to.equal(true);
    expect(findings.classList.contains("ai-reviewer-run-artifacts")).to.equal(
      true,
    );
    expect(document.querySelector(".ai-reviewer-panel-findings")).to.equal(
      null,
    );

    const scrollIntoView = sinon.spy();
    findingCard.scrollIntoView = scrollIntoView;
    fireEvent.click(
      screen.getByRole("button", { name: "Go to unresolved findings (1)" }),
    );
    await waitFor(() => expect(scrollIntoView.calledOnce).to.equal(true));
    expect(document.activeElement).to.equal(findingCard);

    typeConversationMessage("Why is it ambiguous?");
    await screen.findByText("A precise explanation.");

    expect(screen.queryByRole("article", { name: "Review run 1" })).not.to
      .exist;
    fireEvent.click(
      screen.getByRole("button", { name: "Go to unresolved findings (1)" }),
    );
    expect(await screen.findByText("Ambiguous phrase")).to.exist;
  });

  it("returns to the timeline when a review starts from an open discussion", async function () {
    let requestNumber = 0;
    const streamRequest = sinon
      .stub()
      .callsFake(async (call: ReviewStreamCall) => {
        const { requestId, skill } = call.request;
        call.onEvent({
          type: "started",
          eventId: `${requestId}-started`,
          requestId,
          sequence: 0,
          createdAt,
          provider: "fake",
          model: "deterministic-v1",
          skill,
        });
        if (streamRequest.callCount === 1) {
          call.onEvent({
            type: "finding",
            eventId: `${requestId}-finding`,
            requestId,
            sequence: 1,
            createdAt,
            finding: sourceFinding(call.request),
          });
          call.onEvent({
            type: "completed",
            eventId: `${requestId}-completed`,
            requestId,
            sequence: 2,
            createdAt,
            finishReason: "stop",
          });
          return;
        }
        await new Promise<void>((_resolve, reject) => {
          call.signal.addEventListener(
            "abort",
            () => reject(call.signal.reason),
            { once: true },
          );
        });
      });
    await reviewedSelection({
      createRequestId: () => `discussion-review-request-${++requestNumber}`,
      streamRequest,
    });
    fireEvent.click(screen.getByRole("button", { name: "Discuss finding" }));
    expect(
      await screen.findByRole("article", { name: "AI reviewer discussion" }),
    ).to.exist;

    fireEvent.click(screen.getByRole("button", { name: "Review selection" }));

    const activeRun = await screen.findByRole("article", {
      name: "Review run 2",
    });
    expect(document.querySelector(".ai-reviewer-panel-timeline")).not.to.equal(
      null,
    );
    expect(screen.queryByRole("article", { name: "AI reviewer discussion" }))
      .not.to.exist;
    const stop = within(activeRun).getByRole("button", { name: "Stop" });
    fireEvent.click(stop);
    expect(await within(activeRun).findByText("Cancelled")).to.exist;
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
  it("collapses a dismissed finding to one line and expands on demand", async function () {
    await reviewedSelection();

    fireEvent.click(screen.getByRole("button", { name: "Discard finding" }));

    const finding = await screen.findByText("Ambiguous phrase");
    const card = finding.closest<HTMLElement>(".ai-reviewer-artifact");
    expect(card).not.to.equal(null);
    if (card == null) {
      throw new Error("The dismissed finding must remain in its source run.");
    }
    expect(card.classList.contains("ai-reviewer-artifact-resolved")).to.equal(
      true,
    );
    const disclosure = card.querySelector("details");
    const summary = disclosure?.querySelector("summary");
    expect(disclosure?.open).to.equal(false);
    expect(summary?.textContent).to.contain("Ambiguous phrase");
    expect(summary?.textContent).to.contain("Status: Discarded");
    expect(
      within(card)
        .getByRole("button", { name: "Discuss finding" })
        .closest(".ai-reviewer-artifact-body"),
    ).not.to.equal(null);
    fireEvent.click(summary!);
    expect(disclosure?.open).to.equal(true);
    expect(within(card).getByRole("button", { name: "Discuss finding" })).to
      .exist;
    const unresolved = screen.getByRole("button", {
      name: "Go to unresolved findings (0)",
    }) as HTMLButtonElement;
    expect(unresolved.disabled).to.equal(true);
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
      name: "Selected mode — Freeform",
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
      name: "Selected mode — Freeform",
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
    // The composer stays with the active discussion while the header keeps a
    // direct route back to its unresolved source finding.
    expect(composerField()).to.exist;
    expect(screen.queryByRole("article", { name: "Review run 1" })).not.to
      .exist;
    fireEvent.click(
      screen.getByRole("button", { name: "Go to unresolved findings (1)" }),
    );
    expect(await screen.findByRole("article", { name: "Review run 1" })).to
      .exist;
    expect(document.activeElement?.textContent).to.contain("Ambiguous phrase");
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

  it("distinguishes the selected model from the model recorded by a run", async function () {
    renderPanel({
      createRequestId: () => "model-label-request",
      now: () => createdAt,
      captureSelectionSession: captureSelectionSession(),
      selectionPreview,
      streamRequest: unifiedStream(),
      ...providerProps(),
    });

    await chooseModel(`Claude Sonnet (${claudeConnection.label})`);
    fireEvent.click(screen.getByRole("button", { name: "Review selection" }));

    const run = await screen.findByRole("article", { name: "Review run 1" });
    expect(
      screen.getByRole("button", {
        name: "Selected model — Claude Sonnet. Context length — 200,000 tokens · provider-detected value",
      }),
    ).to.exist;
    expect(
      within(run).getByText("Model used for this run: fake · deterministic-v1"),
    ).to.exist;
  });

  it("distinguishes a pending compatible probe from unavailable Azure metadata", async function () {
    const azureConnection: AiProviderConnection = {
      id: "connection-azure",
      revision: 1,
      label: "Azure OpenAI",
      classification: "remote",
      config: {
        provider: "azure",
        baseUrl: "https://reviewer.openai.azure.com",
        requestStyle: "v1",
        deployments: ["reviewer-deployment"],
        contextLengthOverrides: [],
        contextLengthOverride: null,
        credentialSet: true,
        credentialUpdatedAt: createdAt,
      },
    };
    const azureModel = catalogModel(
      azureConnection,
      "reviewer-deployment",
      "Azure reviewer",
      null,
      "unavailable",
    );
    renderPanel({
      ...providerProps(
        [localConnection, azureConnection],
        [defaultModel, azureModel],
      ),
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Selected model — None" }),
    );

    expect(
      screen.getByRole("menuitem", {
        name: `Default reviewer (${localConnection.label}) · Will be detected during review.`,
      }),
    ).to.exist;
    expect(
      screen.getByRole("menuitem", {
        name: `Azure reviewer (${azureConnection.label}) · Unknown. Set it in Connection settings.`,
      }),
    ).to.exist;
    expect(screen.getByText("· Detect during review")).to.exist;
    expect(screen.getByText("· Context unknown")).to.exist;
  });

  it("names an unprobed selected model without repeating Context length", async function () {
    renderPanel({ ...providerProps() });

    await chooseModel(`Default reviewer (${localConnection.label})`);

    const selectedModel = screen.getByRole("button", {
      name: "Selected model — Default reviewer. Context length — Will be detected during review.",
    });
    expect(
      selectedModel.getAttribute("aria-label")?.match(/Context length/gu),
    ).to.have.length(1);
  });

  it("filters a 49-model catalogue by display name or id", async function () {
    const models = Array.from({ length: 49 }, (_, index) =>
      catalogModel(
        localConnection,
        `reviewer-model-${index + 1}`,
        index === 47 ? "Specialized reviewer" : `Reviewer ${index + 1}`,
      ),
    );
    renderPanel({ ...providerProps([localConnection], models) });

    fireEvent.click(
      await screen.findByRole("button", { name: "Selected model — None" }),
    );
    const filter = screen.getByRole("textbox", { name: "Filter models" });
    expect(screen.getAllByRole("menuitem")).to.have.length(49);
    fireEvent.change(filter, { target: { value: "model-48" } });

    const matches = screen.getAllByRole("menuitem");
    expect(matches).to.have.length(1);
    expect(matches[0].textContent).to.contain("Specialized reviewer");
    fireEvent.change(filter, { target: { value: "does-not-exist" } });
    expect(screen.getByRole("status").textContent).to.equal(
      "No matching models",
    );
  });

  it("moves from the model filter into its options and lets Escape close the menu", async function () {
    renderPanel({ ...providerProps() });

    const toggle = await screen.findByRole("button", {
      name: "Selected model — None",
    });
    fireEvent.click(toggle);
    const filter = screen.getByLabelText("Filter models");
    const options = screen.getAllByRole("menuitem");

    filter.focus();
    fireEvent.keyDown(filter, { key: "ArrowDown" });
    expect(document.activeElement).to.equal(options[0]);

    filter.focus();
    fireEvent.keyDown(filter, { key: "ArrowUp" });
    expect(document.activeElement).to.equal(options.at(-1));

    filter.focus();
    fireEvent.keyDown(filter, { key: "Escape" });
    await waitFor(() =>
      expect(toggle.getAttribute("aria-expanded")).to.equal("false"),
    );
    expect(
      document
        .querySelector(".ai-reviewer-panel-model-menu")
        ?.classList.contains("show"),
    ).to.equal(false);
  });

  it("shows model ids only when display names are duplicated", async function () {
    const duplicates = [
      catalogModel(localConnection, "reviewer/duplicate-a", "Same reviewer"),
      catalogModel(localConnection, "reviewer/duplicate-b", "Same reviewer"),
      catalogModel(localConnection, "reviewer/unique", "Unique reviewer"),
    ];
    renderPanel({ ...providerProps([localConnection], duplicates) });

    fireEvent.click(
      await screen.findByRole("button", { name: "Selected model — None" }),
    );

    const optionText = screen
      .getAllByRole("menuitem")
      .map((option) => option.textContent);
    expect(
      optionText.some((text) =>
        text?.includes("Same reviewer — reviewer/duplicate-a"),
      ),
    ).to.equal(true);
    expect(
      optionText.some((text) =>
        text?.includes("Same reviewer — reviewer/duplicate-b"),
      ),
    ).to.equal(true);
    expect(
      optionText.find((text) => text?.startsWith("Unique reviewer")),
    ).not.to.include("reviewer/unique");
  });

  it("shows a model-catalogue error when the request fails", async function () {
    renderPanel({
      loadProviderConnections: sinon
        .stub()
        .resolves({ connections: [localConnection] }),
      loadProviderModels: sinon.stub().rejects(new Error("HTTP 409")),
    });

    expect((await screen.findByRole("alert")).textContent).to.equal(
      "Models could not be loaded.",
    );
    expect(screen.queryByRole("button", { name: /^Selected model/u })).not.to
      .exist;
    expect(
      screen.getByRole("button", { name: "Retry loading models" }),
    ).to.exist;
  });

  it("manually retries a failed initial model catalogue load", async function () {
    const loadProviderModels = sinon.stub();
    loadProviderModels.onFirstCall().rejects(new Error("HTTP 504"));
    loadProviderModels.resolves({ models: [defaultModel], failures: [] });
    renderPanel({
      loadProviderConnections: sinon
        .stub()
        .resolves({ connections: [localConnection] }),
      loadProviderModels,
    });

    fireEvent.click(
      await screen.findByRole("button", { name: "Retry loading models" }),
    );

    expect(
      await screen.findByRole("button", { name: "Selected model — None" }),
    ).to.exist;
    expect(loadProviderModels).to.have.been.calledTwice;
    expect(screen.queryByTestId("ai-reviewer-model-catalog-error")).not.to
      .exist;
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
      (
        await screen.findByRole("button", {
          name: "Selected model — Claude Sonnet. Context length — 200,000 tokens · provider-detected value",
        })
      ).textContent,
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

  for (const failureDelivery of ["emitted", "thrown"] as const) {
    it(`clears and refreshes a missing discussion connection from an ${failureDelivery} error`, async function () {
      const loadProviderConnections = sinon
        .stub()
        .resolves({ connections: [localConnection] });
      const loadProviderModels = sinon
        .stub()
        .resolves({ models: [defaultModel], failures: [] });
      const streamRequest = sinon
        .stub()
        .callsFake(async (call: ReviewStreamCall) => {
          const details = {
            code: "AI_PROVIDER_CONNECTION_NOT_FOUND",
            category: "configuration" as const,
            message: "Bounded server wording.",
            retryable: false,
          };
          if (failureDelivery === "thrown") {
            throw new AgentStreamError(details);
          }
          call.onEvent({
            type: "error",
            eventId: "discussion-connection-not-found",
            requestId: call.request.requestId,
            sequence: 0,
            createdAt,
            error: details,
          });
        });
      renderPanel({
        createDiscussionId: () => `missing-discussion-${failureDelivery}`,
        createDiscussionRequestId: () =>
          `missing-discussion-request-${failureDelivery}`,
        streamRequest,
        loadProviderConnections,
        loadProviderModels,
      });

      await chooseModel(`Default reviewer (${localConnection.label})`);
      typeConversationMessage("Explain the selected connection.");

      expect((await screen.findByRole("alert")).textContent).to.equal(
        "The selected connection could not be found. Choose a model again, then retry the review.",
      );
      await waitFor(() => {
        expect(loadProviderConnections).to.have.been.calledTwice;
        expect(loadProviderModels).to.have.been.calledTwice;
      });
      fireEvent.click(
        screen.getByRole("button", { name: "Back to review list" }),
      );
      expect(
        await screen.findByRole("button", { name: "Selected model — None" }),
      ).to.exist;
    });
  }

  it("clears a stored selection when its connection is gone without choosing a fallback", async function () {
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
      (
        await screen.findByRole("button", {
          name: "Selected model — None",
        })
      ).textContent,
    ).to.equal("No model");
    // The next workspace write omits the stale destination instead of choosing
    // another connection for the manuscript.
    await waitFor(() => {
      expect(store.workspace).not.to.have.property("selectedModel");
    });
  });

  it("clears and refreshes a selected connection rejected by the run", async function () {
    const loadProviderConnections = sinon.stub();
    loadProviderConnections.onFirstCall().resolves({
      connections: [localConnection],
    });
    loadProviderConnections.resolves({ connections: [localConnection] });
    const loadProviderModels = sinon.stub();
    loadProviderModels.onFirstCall().resolves({
      models: [defaultModel],
      failures: [
        {
          connectionId: "connection-slow",
          connectionLabel: "Slow gateway",
          code: "AI_REQUEST_TIMEOUT",
          category: "timeout",
        },
      ],
    });
    loadProviderModels.rejects(new Error("HTTP 504"));
    const streamRequest = sinon
      .stub()
      .callsFake(async (call: ReviewStreamCall) => {
        call.onEvent({
          type: "error",
          eventId: "connection-not-found",
          requestId: call.request.requestId,
          sequence: 0,
          createdAt,
          error: {
            code: "AI_PROVIDER_CONNECTION_NOT_FOUND",
            category: "configuration",
            message: "Bounded server wording.",
            retryable: false,
          },
        });
      });
    renderPanel({
      captureSelectionSession: captureSelectionSession(),
      selectionPreview,
      streamRequest,
      loadProviderConnections,
      loadProviderModels,
    });

    await chooseModel(`Default reviewer (${localConnection.label})`);
    fireEvent.click(screen.getByRole("button", { name: "Review selection" }));

    expect(
      await screen.findByText(
        "The selected connection could not be found. Choose a model again, then retry the review.",
      ),
    ).to.exist;
    await waitFor(() => {
      expect(loadProviderConnections).to.have.been.calledTwice;
      expect(loadProviderModels).to.have.been.calledTwice;
      expect(
        screen.getByRole("button", { name: "Selected model — None" }),
      ).to.exist;
      expect(screen.getByTestId("ai-reviewer-model-catalog-error")).to.exist;
      expect(screen.getByTestId("ai-reviewer-model-failures").textContent).to
        .include("Slow gateway");
      expect(
        screen.getByRole("button", { name: "Retry loading models" }),
      ).to.exist;
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
