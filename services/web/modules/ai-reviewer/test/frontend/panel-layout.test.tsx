import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect } from "chai";
import i18next from "i18next";
import React from "react";
import sinon from "sinon";

import { AiReviewerPanelView } from "../../frontend/js/components/ai-reviewer-panel";
import {
  AgentStreamError,
  streamAgentEvents,
} from "../../frontend/js/services/agent-stream";
import type { AiProviderConnection } from "../../frontend/js/services/ai-provider-configuration";
import type { AiReviewerModeInstructionPersistence } from "../../frontend/js/services/ai-reviewer-mode-instructions";
import type { AiReviewerWorkspacePersistence } from "../../frontend/js/services/ai-reviewer-workspace-persistence";
import { AI_REVIEWER_MODE_INSTRUCTION_MAX_LENGTH } from "../../shared/contracts.mjs";

type StreamCall = Parameters<typeof streamAgentEvents>[0];

const projectId = "panel-layout-project";
const createdAt = "2026-07-26T00:00:00.000Z";
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
    credentialUpdatedAt: "2026-07-26T01:02:03.000Z",
  },
};
const emptyState =
  "Review a selection, document, or project, then discuss the results here.";
const categoryFailureGuidance = {
  aborted:
    "The AI reviewer request was cancelled. Run it again if you still need the result.",
  authentication:
    "The AI provider rejected the credentials. Check the credential in AI Reviewer settings, then try again.",
  configuration:
    "AI Reviewer is not configured correctly. Check the provider and model in AI Reviewer settings, then try again.",
  network:
    "AI Reviewer could not reach the provider. Check the provider endpoint and network connection, then try again.",
  provider:
    "The AI provider could not complete the request. Try again; if it keeps failing, switch models or check the AI Reviewer settings.",
  "rate-limit":
    "The AI provider rate limit was reached. Wait a little, then try again.",
  schema:
    "AI Reviewer could not use the model response. Try narrowing the review scope, switching to a more capable model, or checking the AI Reviewer settings.",
  timeout:
    "The AI reviewer request timed out. Try again or narrow the review scope.",
  unknown:
    "AI Reviewer could not complete the request. Try again; if it keeps failing, check the AI Reviewer settings.",
} as const;
const projectContentFailureGuidance =
  "AI Reviewer could not read the required project content. Check that the project files are available, then try again.";
const modelContextTooSmallGuidance =
  "The request does not fit this model's context length (4,096 tokens; provider-detected value). Narrow the scope, choose a model with a larger context length, or set the context length in Connection settings.";
const streamFailureGuidance =
  "AI Reviewer could not complete the request or read its response. Check your network connection and AI Reviewer settings, then try again.";
const requestFailureGuidance =
  "AI Reviewer could not start because the request was invalid or no longer matched the active project. Refresh the project, then try again.";
const afterTerminalFailureGuidance =
  "AI Reviewer received data after completion. Try the review again; if it keeps happening, switch models or check the AI Reviewer settings.";
const concurrencyFailureGuidance =
  "An AI review is already running. Wait for it to finish, then try again.";
const plaintextCredentialFailureGuidance =
  "API key blocked. Use HTTPS or recreate without a key.";
const codeFailureGuidance: Partial<Record<string, string>> = {
  AI_PROJECT_CONTENT_NOT_AVAILABLE: projectContentFailureGuidance,
  AI_STREAM_NETWORK_ERROR: streamFailureGuidance,
  AI_HTTP_ERROR: streamFailureGuidance,
  AI_STREAM_BODY_MISSING: streamFailureGuidance,
  AI_STREAM_INCOMPLETE: streamFailureGuidance,
  AI_REQUEST_SCHEMA_INVALID: requestFailureGuidance,
  AI_REQUEST_PROJECT_MISMATCH: requestFailureGuidance,
  AI_STREAM_REQUEST_INVALID: requestFailureGuidance,
  AI_DISCUSSION_REQUEST_INVALID: requestFailureGuidance,
  AI_STREAM_AFTER_TERMINAL: afterTerminalFailureGuidance,
  AI_REVIEWER_CONCURRENCY_LIMITED: concurrencyFailureGuidance,
  AI_PROVIDER_PLAINTEXT_CREDENTIAL_BLOCKED: plaintextCredentialFailureGuidance,
};
const emittedFailureGuidanceCases = [
  { code: "AI_REQUEST_ABORTED", category: "aborted", retryable: false },
  {
    code: "AI_PROVIDER_AUTHENTICATION_ERROR",
    category: "authentication",
    retryable: false,
  },
  {
    code: "AI_PROVIDER_NOT_CONFIGURED",
    category: "configuration",
    retryable: false,
  },
  {
    code: "AI_PROVIDER_PLAINTEXT_CREDENTIAL_BLOCKED",
    category: "configuration",
    retryable: false,
  },
  {
    code: "AI_PROJECT_CONTENT_NOT_AVAILABLE",
    category: "configuration",
    retryable: false,
  },
  {
    code: "AI_PROVIDER_NETWORK_ERROR",
    category: "network",
    retryable: true,
  },
  { code: "AI_STREAM_NETWORK_ERROR", category: "network", retryable: true },
  { code: "AI_HTTP_ERROR", category: "network", retryable: true },
  { code: "AI_STREAM_BODY_MISSING", category: "network", retryable: true },
  { code: "AI_STREAM_INCOMPLETE", category: "network", retryable: true },
  { code: "AI_PROVIDER_ERROR", category: "provider", retryable: true },
  {
    code: "AI_PROVIDER_RATE_LIMITED",
    category: "rate-limit",
    retryable: true,
  },
  {
    code: "AI_REVIEWER_CONCURRENCY_LIMITED",
    category: "rate-limit",
    retryable: true,
  },
  { code: "AI_STREAM_PROTOCOL_ERROR", category: "schema", retryable: false },
  { code: "AI_REQUEST_SCHEMA_INVALID", category: "schema", retryable: false },
  { code: "AI_REQUEST_PROJECT_MISMATCH", category: "schema", retryable: false },
  {
    code: "AI_STREAM_EVENT_SCOPE_INVALID",
    category: "schema",
    retryable: false,
  },
  {
    code: "AI_STREAM_CONTENT_TYPE_INVALID",
    category: "schema",
    retryable: false,
  },
  {
    code: "AI_STREAM_AFTER_TERMINAL",
    category: "schema",
    retryable: false,
  },
  { code: "AI_STREAM_JSON_INVALID", category: "schema", retryable: false },
  { code: "AI_STREAM_EVENT_INVALID", category: "schema", retryable: false },
  { code: "AI_STREAM_REQUEST_INVALID", category: "schema", retryable: false },
  {
    code: "AI_DISCUSSION_EVENT_SCOPE_INVALID",
    category: "schema",
    retryable: false,
  },
  {
    code: "AI_DISCUSSION_REQUEST_INVALID",
    category: "schema",
    retryable: false,
  },
  { code: "AI_REQUEST_TIMEOUT", category: "timeout", retryable: true },
  { code: "AI_PROVIDER_ERROR", category: "unknown", retryable: true },
] as const;

function emitCompletedReview(call: StreamCall) {
  call.onEvent({
    type: "started",
    eventId: "panel-layout-started",
    requestId: call.request.requestId,
    sequence: 0,
    createdAt,
    provider: "fake",
    model: "deterministic-v1",
    skill: call.request.skill,
  });
  call.onEvent({
    type: "subject",
    eventId: "panel-layout-subject",
    requestId: call.request.requestId,
    sequence: 1,
    createdAt,
    subject: "Claim support",
  });
  call.onEvent({
    type: "completed",
    eventId: "panel-layout-completed",
    requestId: call.request.requestId,
    sequence: 2,
    createdAt,
    finishReason: "stop",
  });
}

function renderPanel(
  props: Partial<React.ComponentProps<typeof AiReviewerPanelView>> = {},
) {
  return render(<AiReviewerPanelView projectId={projectId} {...props} />);
}

function runSelectionReview() {
  fireEvent.click(screen.getByRole("button", { name: "Review selection" }));
}

async function openModelChip() {
  const chip = await screen.findByRole("button", {
    name: /^Selected model/u,
  });
  fireEvent.click(chip);
  return chip;
}

function modelOptions() {
  return screen.queryAllByRole("menuitem").map((item) => item.textContent);
}

function catalogModel(
  connection: AiProviderConnection,
  id: string,
  displayName: string,
  contextLength = 4_096,
  contextLengthSource: "detected" | "override" | "unknown" = "detected",
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

function primaryControls(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLButtonElement>(".btn-primary")];
}

function selectionCapture() {
  return sinon
    .stub()
    .callsFake(
      async ({
        requestId,
        action,
        instruction,
      }: {
        requestId: string;
        action: "review";
        instruction: string;
      }) => ({
        status: "ready" as const,
        session: Object.freeze({
          request: Object.freeze({
            requestId,
            projectId,
            action,
            instruction,
            skill: "referee-review",
            scope: Object.freeze({
              kind: "selection" as const,
              documentId: "document-1",
              path: "main.tex",
              baseRevision: 7,
              baseTextHash: "a".repeat(64),
              range: Object.freeze({ from: 0, to: 4 }),
              text: "Body",
            }),
          }),
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

function renderReviewPanel(
  props: Partial<React.ComponentProps<typeof AiReviewerPanelView>> = {},
) {
  return renderPanel({
    captureSelectionSession: selectionCapture(),
    selectionPreview: {
      filename: "main.tex",
      fromLine: 1,
      toLine: 1,
      wordCount: 1,
    },
    ...props,
  });
}

describe("AI reviewer: panel layout", function () {
  it("shows the one-line empty state before any run and keeps controls at the bottom", function () {
    const { container } = renderPanel({
      captureSelectionSession: sinon.stub(),
    });

    const panel = screen.getByTestId("ai-reviewer-panel");
    const header = panel.querySelector(".ai-reviewer-panel-header");
    const bottomControls = screen.getByTestId("ai-reviewer-bottom-controls");
    const empty = screen.getByText(emptyState);

    expect(header).not.to.equal(null);
    if (header == null) {
      throw new Error("The panel header must render.");
    }
    expect(empty.closest(".ai-reviewer-panel-body")).not.to.equal(null);
    expect(
      header.compareDocumentPosition(bottomControls) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).to.not.equal(0);
    // The conversation is the default surface, so the composer stands even
    // before a run; only the selection transforms wait for a target.
    expect(primaryControls(container)).to.have.length(0);
    expect(screen.queryByRole("button", { name: "Send" })).not.to.exist;
    expect(screen.queryByRole("button", { name: "Rewrite selection" })).not.to
      .exist;
    expect(screen.queryByTestId("ai-reviewer-review-shortcuts")).not.to.exist;
    expect(screen.getByTestId("ai-reviewer-mode-row")).to.exist;
  });

  it("renders selection-only transforms while text is selected and drops them when it is deselected", function () {
    const { container, rerender } = renderPanel({
      captureSelectionSession: sinon.stub(),
      selectionPreview: {
        filename: "main.tex",
        fromLine: 1,
        toLine: 117,
        wordCount: 800,
      },
    });

    const transforms = screen.getByTestId("ai-reviewer-selection-transforms");
    expect(within(transforms).getByText("main.tex L1–117 (800 words)")).to
      .exist;
    expect(screen.getByRole("button", { name: "Rewrite selection" })).to.exist;
    expect(screen.getByRole("button", { name: "Shorten selection" })).to.exist;
    // Reviewing the selection is the primary act while one exists.
    expect(primaryControls(container)).to.have.length(1);
    expect(primaryControls(container)[0]).to.equal(
      screen.getByRole("button", { name: "Review selection" }),
    );

    rerender(
      <AiReviewerPanelView
        projectId={projectId}
        captureSelectionSession={sinon.stub()}
        selectionPreview={null}
      />,
    );

    expect(screen.queryByTestId("ai-reviewer-selection-transforms")).not.to
      .exist;
    expect(screen.queryByRole("button", { name: "Review selection" })).not.to
      .exist;
    expect(screen.queryByRole("button", { name: "Rewrite selection" })).not.to
      .exist;
    expect(screen.queryByRole("button", { name: "Shorten selection" })).not.to
      .exist;
    expect(screen.getByTestId("ai-reviewer-mode-row")).to.exist;
  });

  it("selects a model per run and displays the persisted run origin", async function () {
    const selectedModel = "reviewer-unavailable-v2";
    const streamRequest = sinon.stub().callsFake(async (call: StreamCall) => {
      call.onEvent({
        type: "started",
        eventId: "panel-model-started",
        requestId: call.request.requestId,
        sequence: 0,
        createdAt,
        provider: "openai-compatible",
        model: selectedModel,
        skill: call.request.skill,
      });
      call.onEvent({
        type: "completed",
        eventId: "panel-model-completed",
        requestId: call.request.requestId,
        sequence: 1,
        createdAt,
        finishReason: "stop",
      });
    });
    renderReviewPanel({
      streamRequest,
      loadProviderConnections: sinon
        .stub()
        .resolves({ connections: [localConnection] }),
      loadProviderModels: sinon.stub().resolves({
        models: [
          catalogModel(
            localConnection,
            "reviewer-default-v1",
            "Default reviewer",
          ),
          catalogModel(localConnection, selectedModel, "Alternate reviewer"),
        ],
        failures: [],
      }),
    });

    await openModelChip();
    // Choosing a model is what chooses a connection: no separate picker.
    expect(screen.queryByRole("combobox", { name: "Connection" })).not.to.exist;
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: `Alternate reviewer (${localConnection.label}) · 4,096 tokens · provider-detected value`,
      }),
    );
    runSelectionReview();
    await screen.findByText("Completed");

    expect(streamRequest.firstCall.args[0].request.model).to.equal(
      selectedModel,
    );
    expect(streamRequest.firstCall.args[0].request.connectionId).to.equal(
      localConnection.id,
    );
    expect(
      screen.getByText(
        `Model used for this run: openai-compatible · ${selectedModel}`,
      ),
    ).to.exist;
  });

  it("offers the models of every connection in one dropdown", async function () {
    const streamRequest = sinon.stub().callsFake(async (call: StreamCall) => {
      call.onEvent({
        type: "completed",
        eventId: "panel-connection-completed",
        requestId: call.request.requestId,
        sequence: 0,
        createdAt,
        finishReason: "stop",
      });
    });
    const loadProviderModels = sinon.stub().resolves({
      models: [
        catalogModel(localConnection, "shared-model", "Shared model"),
        catalogModel(claudeConnection, "shared-model", "Shared model"),
        catalogModel(
          claudeConnection,
          "claude-sonnet-4-20250514",
          "Claude Sonnet",
        ),
      ],
      failures: [],
    });
    renderReviewPanel({
      streamRequest,
      loadProviderConnections: sinon
        .stub()
        .resolves({ connections: [localConnection, claudeConnection] }),
      loadProviderModels,
    });

    await openModelChip();
    expect(screen.queryByRole("combobox", { name: "Connection" })).not.to.exist;
    // The same model id from two connections stays two distinguishable options.
    expect(modelOptions()).to.deep.equal([
      `Shared model — shared-model (${localConnection.label})· 4,096 tokens · detected`,
      `Shared model — shared-model (${claudeConnection.label})· 4,096 tokens · detected`,
      `Claude Sonnet (${claudeConnection.label})· 4,096 tokens · detected`,
    ]);
    expect(loadProviderModels.firstCall.args[0]).to.equal(projectId);

    fireEvent.click(
      screen.getAllByRole("menuitem", {
        name: `Shared model — shared-model (${claudeConnection.label}) · 4,096 tokens · provider-detected value`,
      })[0],
    );
    runSelectionReview();
    await screen.findByText("Completed");

    expect(streamRequest.firstCall.args[0].request).to.include({
      connectionId: claudeConnection.id,
      model: "shared-model",
    });
  });

  it("portals all three menus outside the clipped panel with the editor theme boundary", async function () {
    renderPanel({
      loadProviderConnections: sinon
        .stub()
        .resolves({ connections: [localConnection] }),
      loadProviderModels: sinon.stub().resolves({
        models: [catalogModel(localConnection, "portal-model", "Portal model")],
        failures: [],
      }),
    });

    await openModelChip();
    const panel = screen.getByTestId("ai-reviewer-panel");
    const modelMenu = document.querySelector<HTMLElement>(
      ".ai-reviewer-panel-model-menu",
    );
    expect(modelMenu).not.to.equal(null);
    expect(panel.contains(modelMenu)).to.equal(false);
    expect(modelMenu?.parentElement).to.equal(document.body);
    expect(modelMenu?.classList.contains("ide-redesign-main")).to.equal(true);

    fireEvent.click(
      screen.getByRole("menuitem", {
        name: `Portal model (${localConnection.label}) · 4,096 tokens · provider-detected value`,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Selected mode — Freeform" }),
    );
    const modeMenu = document.querySelector<HTMLElement>(
      ".ai-reviewer-panel-mode-menu",
    );
    expect(modeMenu).not.to.equal(null);
    expect(panel.contains(modeMenu)).to.equal(false);
    expect(modeMenu?.parentElement).to.equal(document.body);
    expect(modeMenu?.classList.contains("ide-redesign-main")).to.equal(true);

    fireEvent.click(screen.getByRole("menuitem", { name: "Freeform" }));
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    const overflowMenu = document.querySelector<HTMLElement>(
      ".ai-reviewer-panel-overflow-menu",
    );
    expect(overflowMenu).not.to.equal(null);
    expect(panel.contains(overflowMenu)).to.equal(false);
    expect(overflowMenu?.parentElement).to.equal(document.body);
    expect(overflowMenu?.classList.contains("ide-redesign-main")).to.equal(
      true,
    );
  });

  it("keeps a reachable connection's models when another one fails", async function () {
    renderPanel({
      loadProviderConnections: sinon
        .stub()
        .resolves({ connections: [localConnection, claudeConnection] }),
      loadProviderModels: sinon.stub().resolves({
        models: [
          catalogModel(
            claudeConnection,
            "claude-sonnet-4-20250514",
            "Claude Sonnet",
          ),
        ],
        failures: [
          {
            connectionId: localConnection.id,
            connectionLabel: localConnection.label,
            code: "AI_PROVIDER_NETWORK_FAILED",
            category: "network",
          },
        ],
      }),
    });

    await openModelChip();
    expect(modelOptions()).to.deep.equal([
      `Claude Sonnet (${claudeConnection.label})· 4,096 tokens · detected`,
    ]);
    const failures = screen.getByTestId("ai-reviewer-model-failures");
    expect(failures.textContent).to.equal(
      `Models could not be loaded from: ${localConnection.label}`,
    );
    // A classification never carries the provider's own words to the screen.
    expect(failures.textContent).not.to.include("AI_PROVIDER_NETWORK_FAILED");
  });

  it("omits the connection when none is registered", async function () {
    const streamRequest = sinon.stub().callsFake(async (call: StreamCall) => {
      call.onEvent({
        type: "completed",
        eventId: "panel-no-connection-completed",
        requestId: call.request.requestId,
        sequence: 0,
        createdAt,
        finishReason: "stop",
      });
    });
    renderPanel({
      streamRequest,
      loadProviderConnections: sinon.stub().resolves({ connections: [] }),
      loadProviderModels: sinon.stub().resolves({ models: [], failures: [] }),
    });

    expect(await screen.findByTestId("ai-reviewer-onboarding")).to.exist;
    expect(screen.getByRole("button", { name: "Add connection" })).to.exist;
    // Nothing else is offered, because nothing else would reach a provider.
    expect(screen.queryByTestId("ai-reviewer-bottom-controls")).not.to.exist;
    expect(screen.queryByRole("button", { name: "Review whole project" })).not
      .to.exist;
    expect(screen.queryByRole("button", { name: /^Selected model/u })).not.to
      .exist;
    expect(screen.queryByTestId("ai-reviewer-model-failures")).not.to.exist;
    expect(streamRequest.called).to.equal(false);
  });

  it("shows stop in the run header while active", async function () {
    const streamRequest = sinon.stub().callsFake(
      ({ signal }: StreamCall) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    renderReviewPanel({ streamRequest });

    runSelectionReview();
    await screen.findByRole("article", { name: "Review run 1" });

    expect(screen.getByTestId("ai-reviewer-bottom-controls")).to.exist;
    const run = screen.getByRole("article", { name: "Review run 1" });
    const headerAction = within(run).getByTestId(
      "ai-reviewer-run-header-action",
    );
    expect(within(headerAction).getByRole("button", { name: "Stop" })).to.exist;
    // A review already running is the one thing left to act on.
    expect(
      screen.getByRole("button", { name: "Review selection" }),
    ).to.have.property("disabled", true);

    fireEvent.click(within(headerAction).getByRole("button", { name: "Stop" }));
    await screen.findByText("Cancelled");
    expect(within(headerAction).queryByRole("button")).not.to.exist;
    expect(screen.queryByRole("button", { name: "Send" })).not.to.exist;
  });

  it("brings a newly started run into view below a long history", async function () {
    const streamRequest = sinon.stub().callsFake(async (call: StreamCall) => {
      call.onEvent({
        type: "completed",
        eventId: `panel-scroll-completed-${streamRequest.callCount}`,
        requestId: call.request.requestId,
        sequence: 0,
        createdAt,
        finishReason: "stop",
      });
    });
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    const scrollIntoView = sinon.spy(function (
      this: HTMLElement,
      _options?: boolean | ScrollIntoViewOptions,
    ) {
      const panelBody = screen.getByTestId(
        "ai-reviewer-conversation",
      ) as HTMLElement;
      panelBody.scrollTop = 2_521;
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    try {
      renderReviewPanel({ streamRequest });
      for (let index = 1; index <= 3; index += 1) {
        runSelectionReview();
        const run = await screen.findByRole("article", {
          name: `Review run ${index}`,
        });
        await within(run).findByText("Completed");
      }

      const panelBody = screen.getByTestId(
        "ai-reviewer-conversation",
      ) as HTMLElement;
      Object.defineProperties(panelBody, {
        clientHeight: { configurable: true, value: 677 },
        scrollHeight: { configurable: true, value: 3_109 },
      });
      panelBody.scrollTop = 0;
      scrollIntoView.resetHistory();

      runSelectionReview();
      const newRun = await screen.findByRole("article", {
        name: "Review run 4",
      });
      await within(newRun).findByText("Completed");
      Object.defineProperty(panelBody, "getBoundingClientRect", {
        configurable: true,
        value: () => ({
          x: 0,
          y: 79,
          top: 79,
          right: 320,
          bottom: 756,
          left: 0,
          width: 320,
          height: 677,
          toJSON: () => ({}),
        }),
      });
      Object.defineProperty(newRun, "getBoundingClientRect", {
        configurable: true,
        value: () => ({
          x: 0,
          y: 2_600 - panelBody.scrollTop,
          top: 2_600 - panelBody.scrollTop,
          right: 320,
          bottom: 3_182 - panelBody.scrollTop,
          left: 0,
          width: 320,
          height: 582,
          toJSON: () => ({}),
        }),
      });

      expect(panelBody.scrollHeight).to.be.greaterThan(panelBody.clientHeight);
      expect(scrollIntoView.calledOnceWith({ block: "start" })).to.equal(true);
      expect(scrollIntoView.firstCall.thisValue).to.equal(newRun);
      const panelBounds = panelBody.getBoundingClientRect();
      const runBounds = newRun.getBoundingClientRect();
      expect(runBounds.top).to.be.at.least(panelBounds.top);
      expect(runBounds.bottom).to.be.at.most(panelBounds.bottom);
    } finally {
      if (originalScrollIntoView == null) {
        delete (HTMLElement.prototype as { scrollIntoView?: unknown })
          .scrollIntoView;
      } else {
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
          configurable: true,
          value: originalScrollIntoView,
        });
      }
    }
  });

  it("reuses the run header action slot for discuss after completion", async function () {
    const streamRequest = sinon.stub().callsFake(async (call: StreamCall) => {
      emitCompletedReview(call);
    });
    renderReviewPanel({ streamRequest });

    runSelectionReview();
    const run = await screen.findByRole("article", { name: "Review run 1" });
    await within(run).findByText("Completed");
    const headerAction = within(run).getByTestId(
      "ai-reviewer-run-header-action",
    );

    expect(within(headerAction).queryByRole("button", { name: "Stop" })).not.to
      .exist;
    expect(within(headerAction).getByRole("button", { name: "Discuss" })).to
      .exist;
    expect(within(run).getByRole("heading", { name: "Claim support" })).to
      .exist;
  });

  it("shows No subject when a completed review emitted none", async function () {
    const streamRequest = sinon.stub().callsFake(async (call: StreamCall) => {
      call.onEvent({
        type: "completed",
        eventId: "panel-no-subject-completed",
        requestId: call.request.requestId,
        sequence: 0,
        createdAt,
        finishReason: "stop",
      });
    });
    renderReviewPanel({ streamRequest });

    runSelectionReview();
    const run = await screen.findByRole("article", { name: "Review run 1" });

    expect(within(run).getByRole("heading", { name: "No subject" })).to.exist;
  });

  it("shows when a completed review did not call the offered finding tool", async function () {
    const streamRequest = sinon.stub().callsFake(async (call: StreamCall) => {
      call.onEvent({
        type: "completed",
        eventId: "panel-no-structured-findings-completed",
        requestId: call.request.requestId,
        sequence: 0,
        createdAt,
        finishReason: "stop",
        findingToolNotCalled: true,
      });
    });
    renderReviewPanel({ streamRequest });

    runSelectionReview();
    const run = await screen.findByRole("article", { name: "Review run 1" });

    expect(
      within(run).getByText("This model did not return structured findings."),
    ).to.exist;
  });

  it("keeps reset out of the main flow and requires confirmation", async function () {
    const streamRequest = sinon.stub().callsFake(async (call: StreamCall) => {
      emitCompletedReview(call);
    });
    renderReviewPanel({ streamRequest });

    runSelectionReview();
    await screen.findByText("Completed");
    expect(
      screen.queryByRole("menuitem", {
        name: "Delete all saved review work",
      }),
    ).not.to.exist;

    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: "Delete all saved review work",
      }),
    );

    expect(screen.getByLabelText("Review run 1")).to.exist;
    expect(await screen.findByText("Delete all saved review work?")).to.exist;
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(screen.queryByLabelText("Review run 1")).not.to.exist;
    });
    expect(screen.getByText(emptyState)).to.exist;
  });

  it("edits each project perspective separately and resets one to built-in", async function () {
    const persistence: AiReviewerModeInstructionPersistence = {
      load: sinon.stub().resolves({
        revision: 7,
        instructions: {
          "referee-review": "Check causal claims.",
          brainstorm: "Generate competing explanations.",
        },
      }),
      save: sinon.stub().resolves({
        revision: 8,
        instructions: { brainstorm: "Compare two concrete framings." },
      }),
    };
    renderPanel({
      modeInstructionPersistence: persistence,
      loadProviderConnections: sinon.stub().resolves({ connections: [] }),
      loadProviderModels: sinon.stub().resolves({ models: [], failures: [] }),
    });

    await waitFor(() => {
      expect(persistence.load).to.have.been.calledWith(
        projectId,
        sinon.match.has("aborted", false),
      );
    });
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Review perspectives" }),
    );

    const review = screen.getByRole("textbox", { name: "Review mode" });
    const brainstorm = screen.getByRole("textbox", {
      name: "Brainstorm mode",
    });
    expect(review).to.have.property("value", "Check causal claims.");
    expect(brainstorm).to.have.property(
      "value",
      "Generate competing explanations.",
    );
    expect(review).to.have.property(
      "maxLength",
      AI_REVIEWER_MODE_INSTRUCTION_MAX_LENGTH,
    );

    fireEvent.click(screen.getAllByRole("button", { name: "Use built-in" })[0]);
    fireEvent.change(brainstorm, {
      target: { value: "Compare two concrete framings." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(persistence.save).to.have.been.calledWith(
        projectId,
        { brainstorm: "Compare two concrete framings." },
        7,
        sinon.match.has("aborted", false),
      );
    });
  });

  for (const failure of emittedFailureGuidanceCases) {
    it(`shows actionable guidance for ${failure.category}:${failure.code} without matching message prose`, async function () {
      const boundedMessage = `Unrelated bounded wording for ${failure.code}.`;
      const streamRequest = sinon.stub().rejects(
        new AgentStreamError({
          code: failure.code,
          category: failure.category,
          message: boundedMessage,
          retryable: failure.retryable,
        }),
      );
      renderReviewPanel({ streamRequest });

      runSelectionReview();
      const alert = await screen.findByRole("alert");

      expect(alert.textContent).to.equal(
        codeFailureGuidance[failure.code] ??
          categoryFailureGuidance[failure.category],
      );
      expect(alert.textContent).not.to.include(failure.code);
      expect(alert.textContent).not.to.include(boundedMessage);
      expect(screen.getByRole("heading", { name: "Response Failed" })).to.exist;
    });
  }

  it("shows the context value, source, and settings link when the model budget is too small", async function () {
    const streamRequest = sinon.stub().callsFake(async (call: StreamCall) => {
      call.onEvent({
        type: "error",
        eventId: "panel-model-context-too-small",
        requestId: call.request.requestId,
        sequence: 0,
        createdAt,
        error: {
          code: "AI_MODEL_CONTEXT_TOO_SMALL",
          category: "configuration",
          message: "Bounded server wording that the panel must not display.",
          retryable: false,
          contextLength: 4_096,
          contextLengthSource: "detected",
        },
      });
    });
    renderReviewPanel({ streamRequest });

    runSelectionReview();
    const alert = await screen.findByRole("alert");

    expect(alert.textContent).to.include(modelContextTooSmallGuidance);
    expect(
      within(alert).getByRole("button", { name: "Open connection settings" }),
    ).to.exist;
  });

  it("renders a sequence-zero model-context error delivered by the stream", async function () {
    const streamRequest = sinon.stub().callsFake(async (call: StreamCall) => {
      call.onEvent({
        type: "error",
        eventId: "panel-model-context-unknown",
        requestId: call.request.requestId,
        sequence: 0,
        createdAt,
        error: {
          code: "AI_MODEL_CONTEXT_UNKNOWN",
          category: "configuration",
          message: "The selected model context length is unknown.",
          retryable: false,
        },
      });
    });
    renderReviewPanel({ streamRequest });

    runSelectionReview();

    const run = await screen.findByRole("article", { name: "Review run 1" });
    expect(within(run).getByText("Error")).to.exist;
    expect(
      within(run).getByText(
        "For Ollama, load the model first or set its context length in Connection settings, then run the review again.",
      ),
    ).to.exist;
  });

  it("renders a provider error delivered after the started event", async function () {
    const streamRequest = sinon.stub().callsFake(async (call: StreamCall) => {
      call.onEvent({
        type: "started",
        eventId: "panel-provider-started",
        requestId: call.request.requestId,
        sequence: 0,
        createdAt,
        provider: "azure",
        model: "gpt-5.6-luna",
        skill: call.request.skill,
      });
      call.onEvent({
        type: "error",
        eventId: "panel-provider-error",
        requestId: call.request.requestId,
        sequence: 1,
        createdAt,
        error: {
          code: "AI_PROVIDER_ERROR",
          category: "provider",
          message: "The AI provider could not complete the request.",
          retryable: true,
        },
      });
    });
    renderReviewPanel({ streamRequest });

    runSelectionReview();

    const run = await screen.findByRole("article", { name: "Review run 1" });
    expect(within(run).getByText("Error")).to.exist;
    expect(
      within(run).getByText(
        "The AI provider could not complete the request. Try again; if it keeps failing, switch models or check the AI Reviewer settings.",
      ),
    ).to.exist;
    expect(
      within(run).getByText("Model used for this run: azure · gpt-5.6-luna"),
    ).to.exist;
  });

  it("keeps both terminal error paths when translation resources refresh", async function () {
    const workspacePersistence: AiReviewerWorkspacePersistence = {
      load: sinon.stub().resolves({
        revision: 0,
        workspace: { runs: [], discussions: [] },
      }),
      save: sinon.stub().resolves({
        revision: 1,
        workspace: { runs: [], discussions: [] },
      }),
      deleteDiscussion: sinon.stub().resolves({
        revision: 1,
        workspace: { runs: [], discussions: [] },
      }),
      deleteAll: sinon.stub().resolves({
        revision: 1,
        workspace: { runs: [], discussions: [] },
      }),
    };
    const streamRequest = sinon.stub().callsFake(async (call: StreamCall) => {
      if (streamRequest.callCount === 1) {
        call.onEvent({
          type: "error",
          eventId: "panel-refresh-model-context-unknown",
          requestId: call.request.requestId,
          sequence: 0,
          createdAt,
          error: {
            code: "AI_MODEL_CONTEXT_UNKNOWN",
            category: "configuration",
            message: "The selected model context length is unknown.",
            retryable: false,
          },
        });
        return;
      }
      call.onEvent({
        type: "started",
        eventId: "panel-refresh-provider-started",
        requestId: call.request.requestId,
        sequence: 0,
        createdAt,
        provider: "azure",
        model: "gpt-5.6-luna",
        skill: call.request.skill,
      });
      call.onEvent({
        type: "error",
        eventId: "panel-refresh-provider-error",
        requestId: call.request.requestId,
        sequence: 1,
        createdAt,
        error: {
          code: "AI_PROVIDER_ERROR",
          category: "provider",
          message: "The AI provider could not complete the request.",
          retryable: true,
        },
      });
    });
    renderReviewPanel({ streamRequest, workspacePersistence });

    await waitFor(() => {
      expect(
        screen
          .getByRole("button", { name: "Review selection" })
          .hasAttribute("disabled"),
      ).to.equal(false);
    });
    runSelectionReview();
    await screen.findByRole("article", { name: "Review run 1" });
    runSelectionReview();
    await screen.findByRole("article", { name: "Review run 2" });

    await act(async () => {
      i18next.addResource(
        "en",
        "translation",
        "ai_reviewer_issue_43_resource_refresh",
        "Issue 43 resource refresh",
      );
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(workspacePersistence.load).to.have.been.calledOnce;
      expect(screen.getByRole("article", { name: "Review run 1" })).to.exist;
      expect(screen.getByRole("article", { name: "Review run 2" })).to.exist;
    });
  });

  it("explains where to set an unknown context length without showing server prose", async function () {
    const serverMessage = "PRIVATE_UNKNOWN_CONTEXT_SERVER_WORDING";
    const streamRequest = sinon.stub().rejects(
      new AgentStreamError({
        code: "AI_MODEL_CONTEXT_UNKNOWN",
        category: "configuration",
        message: serverMessage,
        retryable: false,
      }),
    );
    renderReviewPanel({ streamRequest });

    runSelectionReview();
    const alert = await screen.findByRole("alert");

    expect(alert.textContent).to.include(
      "For Ollama, load the model first or set its context length in Connection settings, then run the review again.",
    );
    expect(alert.textContent).not.to.include(serverMessage);
    expect(
      within(alert).getByRole("button", { name: "Open connection settings" }),
    ).to.exist;
  });

  it("uses category guidance for an unrecognised code", async function () {
    const boundedMessage = "Future wording that the panel must not match.";
    const streamRequest = sinon.stub().rejects(
      new AgentStreamError({
        code: "AI_FUTURE_NETWORK_FAILURE",
        category: "network",
        message: boundedMessage,
        retryable: true,
      }),
    );
    renderReviewPanel({ streamRequest });

    runSelectionReview();
    const alert = await screen.findByRole("alert");

    expect(alert.textContent).to.equal(categoryFailureGuidance.network);
    expect(alert.textContent).not.to.include(boundedMessage);
  });

  it("uses generic guidance for an unrecognised category", async function () {
    const boundedMessage = "Future wording that the panel must not match.";
    const streamRequest = sinon.stub().rejects(
      new AgentStreamError({
        code: "AI_FUTURE_FAILURE",
        category: "future-category" as "unknown",
        message: boundedMessage,
        retryable: true,
      }),
    );
    renderReviewPanel({ streamRequest });

    runSelectionReview();
    const alert = await screen.findByRole("alert");

    expect(alert.textContent).to.equal(categoryFailureGuidance.unknown);
    expect(alert.textContent).not.to.include(boundedMessage);
  });
});
