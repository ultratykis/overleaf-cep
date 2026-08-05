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

type StreamCall = Parameters<typeof streamAgentEvents>[0];

const projectId = "panel-layout-project";
const createdAt = "2026-07-26T00:00:00.000Z";
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
  "AI Reviewer could not read all required manuscript content because the model context was insufficient. The review may be incomplete; use a model with a larger context length or narrow the scope.";
const streamFailureGuidance =
  "AI Reviewer could not complete the request or read its response. Check your network connection and AI Reviewer settings, then try again.";
const requestFailureGuidance =
  "AI Reviewer could not start because the request was invalid or no longer matched the active project. Refresh the project, then try again.";
const afterTerminalFailureGuidance =
  "AI Reviewer received data after completion. Try the review again; if it keeps happening, switch models or check the AI Reviewer settings.";
const concurrencyFailureGuidance =
  "An AI review is already running. Wait for it to finish, then try again.";
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
    type: "completed",
    eventId: "panel-layout-completed",
    requestId: call.request.requestId,
    sequence: 1,
    createdAt,
    finishReason: "stop",
  });
}

function renderPanel(
  props: Partial<React.ComponentProps<typeof AiReviewerPanelView>> = {},
) {
  return render(<AiReviewerPanelView projectId={projectId} {...props} />);
}

function modelOptions() {
  const select = screen.queryByRole("combobox", { name: "Model" });
  return select == null
    ? []
    : [...(select as HTMLSelectElement).options].map((option) => option.text);
}

// A model option is identified by its connection and its id together, because
// the same id can be reachable through more than one connection.
function modelValue(connectionId: string, id: string) {
  return JSON.stringify([connectionId, id]);
}

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

function primaryControls(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLButtonElement>(".btn-primary")];
}

function documentCapture(text: string) {
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
              kind: "document" as const,
              documentId: "document-1",
              path: "main.tex",
              baseRevision: 7,
              baseTextHash: "a".repeat(64),
              text,
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

// The override is the only context length a client can see, so it is what
// decides whether a document review has to be split.
function splitConnections(contextLengthOverride: number) {
  return {
    connections: [
      {
        ...localConnection,
        config: { ...localConnection.config, contextLengthOverride },
      },
    ],
  };
}

function splitCatalog() {
  return {
    models: [catalogModel(localConnection, "split-model", "Split model")],
    failures: [],
  };
}

describe("AI reviewer: panel layout", function () {
  it("shows the one-line empty state before any run and keeps controls at the bottom", function () {
    const { container } = renderPanel({
      captureSelectionSession: sinon.stub(),
      captureDocumentSession: sinon.stub(),
    });

    const panel = screen.getByTestId("ai-reviewer-panel");
    const header = panel.querySelector(".ai-reviewer-panel-header");
    const bottomControls = screen.getByTestId("ai-reviewer-bottom-controls");
    const empty = screen.getByText(emptyState);
    const composer = screen
      .getByRole("textbox", { name: "Discussion message" })
      .closest(".ai-reviewer-panel-composer-input");
    const send = screen.getByRole("button", { name: "Send message" });

    expect(header).not.to.equal(null);
    if (header == null) {
      throw new Error("The panel header must render.");
    }
    expect(empty.closest(".ai-reviewer-panel-body")).not.to.equal(null);
    expect(
      header.compareDocumentPosition(bottomControls) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).to.not.equal(0);
    expect(primaryControls(container)).to.have.length(1);
    expect(primaryControls(container)[0]).to.equal(
      screen.getByRole("button", { name: "Review selection" }),
    );
    expect(composer).not.to.equal(null);
    if (composer == null) {
      throw new Error("The discussion composer input must render.");
    }
    expect(
      within(composer).getByRole("button", { name: "Send message" }),
    ).to.equal(send);
    expect(send.classList.contains("icon-button-small")).to.equal(true);
    expect(send.classList.contains("ai-reviewer-panel-send")).to.equal(true);
    expect(send.textContent).to.equal("send");
  });

  it("renders selection-only transforms only for the selection scope", function () {
    const { container } = renderPanel({
      captureSelectionSession: sinon.stub(),
      captureDocumentSession: sinon.stub(),
    });
    const scope = screen.getByRole("combobox", {
      name: "Review scope",
    });

    expect(screen.getByTestId("ai-reviewer-selection-transforms")).to.exist;
    const rewrite = screen.getByRole("button", {
      name: "Rewrite selection",
    });
    const shorten = screen.getByRole("button", {
      name: "Shorten selection",
    });
    expect(rewrite.classList.contains("btn-link")).to.equal(true);
    expect(rewrite.classList.contains("btn-inline-link")).to.equal(true);
    expect(rewrite.classList.contains("btn-secondary")).to.equal(false);
    expect(shorten.classList.contains("btn-link")).to.equal(true);
    expect(shorten.classList.contains("btn-inline-link")).to.equal(true);
    expect(shorten.classList.contains("btn-secondary")).to.equal(false);
    expect(primaryControls(container)).to.have.length(1);

    fireEvent.change(scope, { target: { value: "document" } });
    expect(screen.queryByTestId("ai-reviewer-selection-transforms")).not.to
      .exist;
    expect(screen.queryByRole("button", { name: "Rewrite selection" })).not.to
      .exist;
    expect(screen.queryByRole("button", { name: "Shorten selection" })).not.to
      .exist;
    expect(screen.getByRole("button", { name: "Review current document" })).to
      .exist;
    expect(primaryControls(container)).to.have.length(1);

    fireEvent.change(scope, { target: { value: "project" } });
    expect(screen.queryByTestId("ai-reviewer-selection-transforms")).not.to
      .exist;
    expect(screen.queryByRole("button", { name: "Rewrite selection" })).not.to
      .exist;
    expect(screen.queryByRole("button", { name: "Shorten selection" })).not.to
      .exist;
    expect(screen.getByRole("button", { name: "Run review" })).to.exist;
    expect(primaryControls(container)).to.have.length(1);
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
    renderPanel({
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

    const modelSelect = await screen.findByRole("combobox", { name: "Model" });
    // Choosing a model is what chooses a connection: no separate picker.
    expect(screen.queryByRole("combobox", { name: "Connection" })).not.to.exist;
    fireEvent.change(modelSelect, {
      target: { value: modelValue(localConnection.id, selectedModel) },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run review" }));
    await screen.findByText("Completed");

    expect(streamRequest.firstCall.args[0].request.model).to.equal(
      selectedModel,
    );
    expect(streamRequest.firstCall.args[0].request.connectionId).to.equal(
      localConnection.id,
    );
    expect(screen.getByText(`openai-compatible · ${selectedModel}`)).to.exist;
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
    renderPanel({
      streamRequest,
      loadProviderConnections: sinon
        .stub()
        .resolves({ connections: [localConnection, claudeConnection] }),
      loadProviderModels,
    });

    const modelSelect = await screen.findByRole("combobox", { name: "Model" });
    expect(screen.queryByRole("combobox", { name: "Connection" })).not.to.exist;
    // The same model id from two connections stays two distinguishable options.
    expect(modelOptions()).to.deep.equal([
      `Shared model (${localConnection.label})`,
      `Shared model (${claudeConnection.label})`,
      `Claude Sonnet (${claudeConnection.label})`,
    ]);
    expect(loadProviderModels.firstCall.args[0]).to.equal(projectId);

    fireEvent.change(modelSelect, {
      target: { value: modelValue(claudeConnection.id, "shared-model") },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run review" }));
    await screen.findByText("Completed");

    expect(streamRequest.firstCall.args[0].request).to.include({
      connectionId: claudeConnection.id,
      model: "shared-model",
    });
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

    await screen.findByRole("combobox", { name: "Model" });
    expect(modelOptions()).to.deep.equal([
      `Claude Sonnet (${claudeConnection.label})`,
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

    fireEvent.click(await screen.findByRole("button", { name: "Run review" }));
    await screen.findByText("Completed");

    expect(screen.queryByRole("combobox", { name: "Connection" })).not.to.exist;
    expect(screen.queryByRole("combobox", { name: "Model" })).not.to.exist;
    expect(screen.queryByTestId("ai-reviewer-model-failures")).not.to.exist;
    expect(streamRequest.firstCall.args[0].request).not.to.have.property(
      "connectionId",
    );
    expect(streamRequest.firstCall.args[0].request).not.to.have.property(
      "model",
    );
  });

  it("suppresses the bottom controls during a run and keeps cancel in its header", async function () {
    const streamRequest = sinon.stub().callsFake(
      ({ signal }: StreamCall) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    renderPanel({ streamRequest });

    fireEvent.click(screen.getByRole("button", { name: "Run review" }));
    const run = await screen.findByRole("article", { name: "Review run 1" });

    expect(screen.queryByTestId("ai-reviewer-bottom-controls")).not.to.exist;
    expect(
      within(run).getByRole("button", {
        name: "Cancel",
      }),
    ).to.exist;
    expect(screen.queryByRole("combobox", { name: "Review scope" })).not.to
      .exist;
    expect(screen.queryByRole("textbox", { name: "Discussion message" })).not.to
      .exist;

    fireEvent.click(within(run).getByRole("button", { name: "Cancel" }));
    await screen.findByText("Cancelled");
    expect(screen.getByTestId("ai-reviewer-bottom-controls")).to.exist;
  });

  it("keeps reset out of the main flow and requires confirmation", async function () {
    const streamRequest = sinon.stub().callsFake(async (call: StreamCall) => {
      emitCompletedReview(call);
    });
    renderPanel({ streamRequest });

    fireEvent.click(screen.getByRole("button", { name: "Run review" }));
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
      renderPanel({ streamRequest });

      fireEvent.click(screen.getByRole("button", { name: "Run review" }));
      const alert = await screen.findByRole("alert");

      expect(alert.textContent).to.equal(
        codeFailureGuidance[failure.code] ??
          categoryFailureGuidance[failure.category],
      );
      expect(alert.textContent).not.to.include(failure.code);
      expect(alert.textContent).not.to.include(boundedMessage);
    });
  }

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
    renderPanel({ streamRequest });

    fireEvent.click(screen.getByRole("button", { name: "Run review" }));
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
    renderPanel({ streamRequest });

    fireEvent.click(screen.getByRole("button", { name: "Run review" }));
    const alert = await screen.findByRole("alert");

    expect(alert.textContent).to.equal(categoryFailureGuidance.unknown);
    expect(alert.textContent).not.to.include(boundedMessage);
  });

  it("keeps a fitting document as one document run", async function () {
    const text = "\\section{Only}\nShort.";
    const streamRequest = sinon.stub().callsFake(async (call: StreamCall) => {
      emitCompletedReview(call);
    });
    renderPanel({
      captureDocumentSession: documentCapture(text),
      streamRequest,
      loadProviderConnections: sinon.stub().resolves(splitConnections(4_096)),
      loadProviderModels: sinon.stub().resolves(splitCatalog()),
    });

    await screen.findByRole("combobox", { name: "Model" });
    fireEvent.change(screen.getByRole("combobox", { name: "Review scope" }), {
      target: { value: "document" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Review current document" }),
    );
    await screen.findByText("Completed");

    expect(streamRequest).to.have.been.calledOnce;
    expect(streamRequest.firstCall.args[0].request.scope.kind).to.equal(
      "document",
    );
  });

  it("runs oversized sections as grouped selection reviews with the selected model", async function () {
    const text = ["One", "Two", "Three"]
      .map((title) => `\\section{${title}}\n${title.repeat(70)}\n`)
      .join("");
    const streamRequest = sinon.stub().callsFake(async (call: StreamCall) => {
      emitCompletedReview(call);
    });
    renderPanel({
      createRequestId: (() => {
        let next = 0;
        return () => `split-request-${++next}`;
      })(),
      captureDocumentSession: documentCapture(text),
      streamRequest,
      loadProviderConnections: sinon.stub().resolves(splitConnections(1_600)),
      loadProviderModels: sinon.stub().resolves(splitCatalog()),
    });

    await screen.findByRole("combobox", { name: "Model" });
    fireEvent.change(screen.getByRole("combobox", { name: "Review scope" }), {
      target: { value: "document" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Review current document" }),
    );
    await waitFor(() => expect(streamRequest.callCount).to.equal(3));

    for (const [index, call] of streamRequest.getCalls().entries()) {
      const scope = call.args[0].request.scope;
      expect(scope.kind).to.equal("selection");
      if (scope.kind !== "selection") {
        throw new Error("Expected a selection review.");
      }
      expect(scope.text).to.equal(text.slice(scope.range.from, scope.range.to));
      expect(call.args[0].request.model).to.equal("split-model");
      expect(screen.getByText(`Selection ${index + 1}/3`)).to.exist;
    }
  });

  it("reports an oversized subsection while continuing with usable sections", async function () {
    const text = [
      "\\section{Large}",
      "\\subsection{Too large}",
      "x".repeat(500),
      "\\section{Usable}",
      "ok",
    ].join("\n");
    const streamRequest = sinon.stub().callsFake(async (call: StreamCall) => {
      emitCompletedReview(call);
    });
    renderPanel({
      captureDocumentSession: documentCapture(text),
      streamRequest,
      loadProviderConnections: sinon.stub().resolves(splitConnections(1_600)),
      loadProviderModels: sinon.stub().resolves(splitCatalog()),
    });

    await screen.findByRole("combobox", { name: "Model" });
    fireEvent.change(screen.getByRole("combobox", { name: "Review scope" }), {
      target: { value: "document" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Review current document" }),
    );

    expect(
      await screen.findByText(
        "1 oversized subsection(s) could not be split and were skipped.",
      ),
    ).to.exist;
    expect(streamRequest).to.have.been.calledOnce;
    expect(streamRequest.firstCall.args[0].request.scope.text).to.equal(
      "\\section{Usable}\nok",
    );
  });

  it("stops remaining split reviews after a concurrency rejection", async function () {
    const text = ["One", "Two", "Three"]
      .map((title) => `\\section{${title}}\n${title.repeat(70)}\n`)
      .join("");
    const streamRequest = sinon
      .stub()
      .onFirstCall()
      .callsFake(async (call: StreamCall) => emitCompletedReview(call));
    streamRequest.onSecondCall().rejects(
      new AgentStreamError({
        code: "AI_REVIEWER_CONCURRENCY_LIMITED",
        category: "rate-limit",
        message: "bounded",
        retryable: true,
      }),
    );
    renderPanel({
      captureDocumentSession: documentCapture(text),
      streamRequest,
      loadProviderConnections: sinon.stub().resolves(splitConnections(1_700)),
      loadProviderModels: sinon.stub().resolves(splitCatalog()),
    });

    await screen.findByRole("combobox", { name: "Model" });
    fireEvent.change(screen.getByRole("combobox", { name: "Review scope" }), {
      target: { value: "document" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Review current document" }),
    );

    expect(
      await screen.findByText(
        "1 remaining section(s) were not started because the concurrent review limit was reached.",
      ),
    ).to.exist;
    expect(streamRequest.callCount).to.equal(2);
  });
});
