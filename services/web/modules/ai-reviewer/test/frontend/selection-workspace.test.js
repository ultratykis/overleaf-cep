/* eslint-disable react/prop-types */
const {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} = require("@testing-library/react");
const { expect } = require("chai");
const React = require("react");
const { Suspense, useLayoutEffect } = React;
const sinon = require("sinon");

const {
  AiReviewerPanelView,
} = require("../../frontend/js/components/ai-reviewer-panel");
const { AgentStreamError } = require("../../frontend/js/services/agent-stream");
const {
  compileSelectedSuggestionHunks,
  DetachedSuggestionDiffError,
} = require("../../frontend/js/services/detached-suggestion-diff");
const {
  useLatestCommittedEditorSelectionSessionContext,
} = require("../../frontend/js/hooks/use-editor-selection-session-context");
const {
  initialSelectionWorkspaceState,
  reduceSelectionWorkspaceState,
} = require("../../frontend/js/services/selection-workspace-state");
const createdAt = "2026-07-24T00:00:00.000Z";
const projectId = "project-0001";
const documentId = "document-0001";
const path = "chapters/main.tex";
const baseText = "Alpha beta gamma.";
const baseTextHash =
  "aea23d46109af9b94c5f15085d69113cc2cefa85f05748897a4df172a1ee5104";
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    resolve,
    reject,
  };
}
function selectionRequest({
  action,
  instruction,
  requestId = "request-duplicate",
  requestProjectId = projectId,
}) {
  return Object.freeze({
    requestId,
    projectId: requestProjectId,
    action,
    instruction,
    skill: action === "review" ? "referee-review" : "line-edit",
    scope: Object.freeze({
      kind: "selection",
      documentId,
      path,
      baseRevision: 7,
      baseTextHash,
      range: Object.freeze({
        from: 6,
        to: 10,
      }),
      text: "beta",
    }),
  });
}
function selectionSession(options) {
  const currentDocument = {
    doc_id: documentId,
    joined: true,
    doc: {
      connection: {
        state: "ok",
      },
      getVersion: () => 7,
    },
    getSnapshot: () => baseText,
    hasBufferedOps: () => false,
    getTrackingChanges: () => false,
  };
  return Object.freeze({
    request: selectionRequest(options),
    binding: Object.freeze({
      currentDocument,
      shareDocument: currentDocument.doc,
      trackChanges: false,
    }),
  });
}
function eventBase(requestId, sequence, type) {
  return {
    type,
    eventId: `event-${requestId}-${sequence}`,
    requestId,
    sequence,
    createdAt,
  };
}
function startedEvent(request, sequence = 0) {
  return {
    ...eventBase(request.requestId, sequence, "started"),
    type: "started",
    provider: "fake",
    model: "deterministic-v1",
    skill: request.skill,
  };
}
function finding(request) {
  return {
    id: "finding-0001",
    requestId: request.requestId,
    projectId: request.projectId,
    artifactKind: "finding",
    severity: "warning",
    category: "clarity",
    title: "Ambiguous synthetic phrase",
    message: "The selected phrase needs a more precise term.",
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
    suggestionIds: ["suggestion-0001"],
  };
}
function suggestion(request) {
  return {
    id: "suggestion-0001",
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
    rationale: "Use a more precise synthetic term.",
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
    skill: request.skill ?? "line-edit",
    createdAt,
    status: "unresolved",
  };
}
function reviewEvents(request) {
  return [
    startedEvent(request),
    {
      ...eventBase(request.requestId, 1, "text.delta"),
      type: "text.delta",
      delta: "Synthetic selection review.",
    },
    {
      ...eventBase(request.requestId, 2, "finding"),
      type: "finding",
      finding: finding(request),
    },
    {
      ...eventBase(request.requestId, 3, "suggestion"),
      type: "suggestion",
      suggestion: suggestion(request),
    },
    {
      ...eventBase(request.requestId, 4, "completed"),
      type: "completed",
      finishReason: "stop",
    },
  ];
}
function renderPanel({
  captureSelectionSession,
  streamRequest,
  createRequestId = () => "request-duplicate",
  getSelectionContext,
  navigateEvidence,
  resolveEvidenceDocument,
  openEvidenceDocument,
  getSuggestionHunkIds,
  applySelectionSuggestion,
  copyText,
}) {
  return render(
    React.createElement(AiReviewerPanelView, {
      projectId,
      createRequestId,
      captureSelectionSession,
      selectionPreview: {
        filename: "main.tex",
        fromLine: 1,
        toLine: 1,
        wordCount: 3,
      },
      streamRequest,
      getSelectionContext,
      navigateEvidence,
      resolveEvidenceDocument,
      openEvidenceDocument,
      getSuggestionHunkIds,
      applySelectionSuggestion,
      copyText,
    }),
  );
}
async function clickSelectionAction(buttonName, instruction) {
  void instruction;
  fireEvent.click(screen.getByRole("button", { name: buttonName }));
  await screen.findByText("Capturing review target");
}
describe("AI reviewer: single document selection workspace", function () {
  const actions = [
    {
      action: "review",
      buttonName: "Review selection",
      instruction: "Review the selected phrase.",
    },
    {
      action: "rewrite",
      buttonName: "Rewrite selection",
      instruction: "Rewrite the selected phrase.",
    },
    {
      action: "shorten",
      buttonName: "Shorten selection",
      instruction: "Shorten the selected phrase.",
    },
  ];
  for (const { action, buttonName, instruction } of actions) {
    it(`captures and displays a read-only ${action} result from the exact frozen request`, async function () {
      const capture = deferred();
      const stream = deferred();
      const captureSelectionSession = sinon
        .stub()
        .callsFake(() => capture.promise);
      let streamCall;
      const streamRequest = sinon.stub().callsFake((call) => {
        streamCall = call;
        return stream.promise;
      });
      renderPanel({
        captureSelectionSession,
        streamRequest,
      });
      await clickSelectionAction(buttonName, instruction);
      expect(
        captureSelectionSession.calledOnceWithExactly({
          requestId: "request-duplicate",
          action,
          instruction,
        }),
      ).to.equal(true);
      expect(streamRequest.called).to.equal(false);
      const session = selectionSession({
        action,
        instruction,
      });
      await act(async () => {
        capture.resolve({
          status: "ready",
          session,
        });
        await Promise.resolve();
      });
      await waitFor(() => expect(streamRequest.calledOnce).to.equal(true));
      expect(streamCall?.projectId).to.equal(session.request.projectId);
      expect(streamCall?.request).to.equal(session.request);
      expect(streamCall?.signal.aborted).to.equal(false);
      expect(screen.getByText("Streaming")).to.exist;
      act(() => {
        for (const event of reviewEvents(session.request)) {
          streamCall?.onEvent(event);
        }
      });
      expect(screen.getByText("Finalizing")).to.exist;
      expect(screen.getByText("Synthetic selection review.")).to.exist;
      expect(screen.getByText("Ambiguous synthetic phrase")).to.exist;
      expect(screen.getByText("The selected phrase needs a more precise term."))
        .to.exist;
      expect(screen.getAllByText(`${path} (chars 6\u201310)`)).to.have.length(
        2,
      );
      expect(screen.queryByText("Original: beta")).not.to.exist;
      expect(screen.queryByText("Replacement: clear")).not.to.exist;
      expect(screen.getByText("beta", { selector: "del" })).to.exist;
      expect(screen.getByText("clear", { selector: "ins" })).to.exist;
      expect(screen.getByText("Rationale: Use a more precise synthetic term."))
        .to.exist;
      expect(screen.queryByRole("button", { name: /accept/i })).not.to.exist;
      expect(session.binding.currentDocument.getSnapshot()).to.equal(baseText);
      await act(async () => {
        stream.resolve();
        await stream.promise;
      });
      await screen.findByText("Completed");
      expect(session.binding.currentDocument.getSnapshot()).to.equal(baseText);
    });
  }
  it("pins distinct actions and discard states for findings, citation findings, and suggestions", async function () {
    const instruction = "Review the selected phrase.";
    const session = selectionSession({
      action: "review",
      instruction,
    });
    const ordinaryFinding = {
      ...finding(session.request),
      category: "citation-audit",
      suggestionIds: [],
    };
    const citationFinding = {
      ...finding(session.request),
      id: "citation-finding-0001",
      artifactKind: "citation-finding",
      category: "clarity",
      title: "Synthetic citation issue",
      proposedText: "Add the missing synthetic bibliography entry.",
      suggestionIds: [],
    };
    const emittedSuggestion = {
      ...suggestion(session.request),
      rationale: "Use a **more precise** synthetic term.",
    };
    const stream = deferred();
    const streamRequest = sinon.stub().callsFake((call) => {
      call.onEvent(startedEvent(session.request));
      call.onEvent({
        ...eventBase(session.request.requestId, 1, "finding"),
        type: "finding",
        finding: ordinaryFinding,
      });
      call.onEvent({
        ...eventBase(session.request.requestId, 2, "finding"),
        type: "finding",
        finding: citationFinding,
      });
      call.onEvent({
        ...eventBase(session.request.requestId, 3, "suggestion"),
        type: "suggestion",
        suggestion: emittedSuggestion,
      });
      call.onEvent({
        ...eventBase(session.request.requestId, 4, "completed"),
        type: "completed",
        finishReason: "stop",
      });
      return stream.promise;
    });
    const copyText = sinon.stub().resolves();
    renderPanel({
      captureSelectionSession: sinon.stub().resolves({
        status: "ready",
        session,
      }),
      streamRequest,
      getSelectionContext: sinon.stub(),
      copyText,
    });

    await clickSelectionAction("Review selection", instruction);
    await act(async () => {
      stream.resolve();
      await stream.promise;
    });
    await screen.findByText("Completed");

    // Both kinds of finding stay under the run that produced them.
    const run = screen.getByRole("article", { name: "Review run 1" });
    const findingsSection = within(run).getByRole("region", {
      name: "Review findings",
    });
    const findingCard = within(findingsSection)
      .getByText("Ambiguous synthetic phrase")
      .closest(".ai-reviewer-artifact");
    const citationCard = within(findingsSection)
      .getByText("Synthetic citation issue")
      .closest(".ai-reviewer-artifact");
    const findingHeadingActions = findingCard.querySelector(
      ".ai-reviewer-artifact-heading-actions",
    );
    expect(
      within(findingCard)
        .getAllByRole("button")
        .map(
          (button) => button.getAttribute("aria-label") ?? button.textContent,
        ),
    ).to.deep.equal([
      "Discuss finding",
      "Discard finding",
      "More options",
      "Go to text",
    ]);
    expect(
      within(findingHeadingActions)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).to.deep.equal(["forum", "delete", "more_vert"]);
    expect(within(findingCard).queryByText(/Apply/u)).not.to.exist;
    expect(within(findingCard).queryByText(/Copy proposed text/u)).not.to.exist;

    const citationHeadingActions = citationCard.querySelector(
      ".ai-reviewer-artifact-heading-actions",
    );
    expect(
      within(citationCard)
        .getAllByRole("button")
        .map(
          (button) => button.getAttribute("aria-label") ?? button.textContent,
        ),
    ).to.deep.equal([
      "Discuss citation finding",
      "Copy proposed text",
      "Discard citation finding",
      "More options",
      "Go to text",
    ]);
    expect(
      within(citationHeadingActions)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).to.deep.equal(["forum", "content_copy", "delete", "more_vert"]);
    expect(within(citationCard).queryByText(/Apply/u)).not.to.exist;

    const suggestionsSection = within(run).getByRole("region", {
      name: "Review suggestions",
    });
    const suggestionCard = within(suggestionsSection)
      .getByRole("heading", { name: "Suggestion 1" })
      .closest(".ai-reviewer-artifact");
    expect(suggestionCard.querySelector("strong")?.textContent).to.equal(
      "more precise",
    );
    expect(suggestionCard.textContent).not.to.contain("**");
    expect(
      within(suggestionsSection)
        .getAllByRole("button")
        .map(
          (button) => button.getAttribute("aria-label") ?? button.textContent,
        ),
    ).to.deep.equal([
      "Discuss suggestion",
      "Discard suggestion",
      "Apply",
      "More options",
    ]);
    const suggestionHeadingActions = suggestionCard.querySelector(
      ".ai-reviewer-artifact-heading-actions",
    );
    expect(
      within(suggestionHeadingActions)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).to.deep.equal(["forum", "delete", "check", "more_vert"]);
    expect(
      within(suggestionHeadingActions)
        .getByRole("button", { name: "Apply" })
        .closest(".ai-reviewer-artifact-apply"),
    ).not.to.equal(null);
    fireEvent.click(
      within(citationCard).getByRole("button", {
        name: "Copy proposed text",
      }),
    );
    await screen.findByText("Proposed text copied");
    expect(
      copyText.calledOnceWithExactly(
        "Add the missing synthetic bibliography entry.",
      ),
    ).to.equal(true);

    fireEvent.click(
      within(findingCard).getByRole("button", {
        name: "Discard finding",
      }),
    );
    // A resolved finding keeps its place but hides its controls until opened.
    expect(within(findingCard).getByText("Status: Discarded")).to.exist;
    expect(
      findingCard.classList.contains("ai-reviewer-artifact-resolved"),
    ).to.equal(true);
    const findingDisclosure = findingCard.querySelector("details");
    expect(findingDisclosure.open).to.equal(false);
    expect(
      within(findingCard)
        .queryAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).to.deep.equal(["Discuss finding", "More options"]);
    fireEvent.click(findingCard.querySelector("summary"));
    expect(findingDisclosure.open).to.equal(true);
    expect(
      within(findingCard).getByRole("button", {
        name: "Discuss finding",
      }),
    ).to.exist;

    fireEvent.click(
      within(citationCard).getByRole("button", {
        name: "Discard citation finding",
      }),
    );
    expect(within(citationCard).getByText("Status: Discarded")).to.exist;
    expect(
      citationCard.classList.contains("ai-reviewer-artifact-resolved"),
    ).to.equal(true);
    const citationDisclosure = citationCard.querySelector("details");
    expect(citationDisclosure.open).to.equal(false);
    expect(
      within(citationCard)
        .queryAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).to.deep.equal(["Discuss citation finding", "More options"]);
    fireEvent.click(citationCard.querySelector("summary"));
    expect(citationDisclosure.open).to.equal(true);
    expect(
      within(citationCard).getByRole("button", {
        name: "Discuss citation finding",
      }),
    ).to.exist;

    fireEvent.click(
      within(suggestionsSection).getByRole("button", {
        name: "Discard suggestion",
      }),
    );
    expect(within(suggestionsSection).getByText("Status: Discarded")).to.exist;
    expect(
      suggestionCard.classList.contains("ai-reviewer-artifact-resolved"),
    ).to.equal(true);
    const suggestionDisclosure = suggestionCard.querySelector("details");
    expect(suggestionDisclosure.open).to.equal(false);
    expect(
      within(suggestionCard)
        .queryAllByRole("button")
        .map((button) => button.getAttribute("aria-label")),
    ).to.deep.equal(["Discuss suggestion", "Apply", "More options"]);
    expect(
      within(suggestionCard).getByRole("button", { name: "Apply" }).disabled,
    ).to.equal(true);
    fireEvent.click(suggestionCard.querySelector("summary"));
    expect(suggestionDisclosure.open).to.equal(true);
    expect(
      within(suggestionCard).getByRole("button", {
        name: "Discuss suggestion",
      }),
    ).to.exist;
  });
  it("retains the exact capture-time session and binding in workspace state", function () {
    const session = selectionSession({
      action: "rewrite",
      instruction: "Rewrite the selected phrase.",
    });
    const capturing = reduceSelectionWorkspaceState(
      initialSelectionWorkspaceState,
      {
        type: "begin",
        status: "capturing",
        generation: 1,
        requestId: session.request.requestId,
      },
    );
    const streaming = reduceSelectionWorkspaceState(capturing, {
      type: "session",
      generation: 1,
      requestId: session.request.requestId,
      session,
    });

    expect(streaming.status).to.equal("streaming");
    expect(streaming.session).to.equal(session);
    expect(streaming.session.binding).to.equal(session.binding);
    expect(streaming.session.binding.currentDocument).to.equal(
      session.binding.currentDocument,
    );
  });
  it("renders a typed selection conflict without contacting the provider", async function () {
    const streamRequest = sinon.stub().resolves();
    const captureSelectionSession = sinon.stub().resolves({
      status: "conflict",
      code: "AI_SELECTION_REQUIRED",
    });
    renderPanel({
      captureSelectionSession,
      streamRequest,
    });
    await clickSelectionAction(
      "Review selection",
      "Review the selected phrase.",
    );
    await screen.findByText("Conflict");
    expect(screen.getByRole("alert").textContent).to.include(
      "AI_SELECTION_REQUIRED",
    );
    expect(streamRequest.called).to.equal(false);
  });
  it("rejects a captured session for another project before streaming", async function () {
    const streamRequest = sinon.stub().resolves();
    const captureSelectionSession = sinon.stub().resolves({
      status: "ready",
      session: selectionSession({
        action: "review",
        instruction: "Review the selected phrase.",
        requestProjectId: "project-other",
      }),
    });
    renderPanel({
      captureSelectionSession,
      streamRequest,
    });
    await clickSelectionAction(
      "Review selection",
      "Review the selected phrase.",
    );
    await screen.findByText("Error");
    expect(screen.getByRole("alert").textContent).to.include("active project");
    expect(streamRequest.called).to.equal(false);
  });
  it("registers the active run before a synchronous stream emits events", async function () {
    const session = selectionSession({
      action: "review",
      instruction: "Review the selected phrase.",
    });
    const streamRequest = sinon.stub().callsFake(async (call) => {
      for (const event of reviewEvents(session.request)) {
        call.onEvent(event);
      }
    });
    renderPanel({
      captureSelectionSession: async () => ({
        status: "ready",
        session,
      }),
      streamRequest,
    });
    await clickSelectionAction(
      "Review selection",
      "Review the selected phrase.",
    );
    await screen.findByText("Completed");
    expect(screen.getByText("Ambiguous synthetic phrase")).to.exist;
    expect(screen.getByText("clear", { selector: "ins" })).to.exist;
  });
  it("keeps completed events non-final until the stream promise resolves", async function () {
    const session = selectionSession({
      action: "review",
      instruction: "Review the selected phrase.",
    });
    const stream = deferred();
    let streamCall;
    const streamRequest = sinon.stub().callsFake((call) => {
      streamCall = call;
      return stream.promise;
    });
    const getSuggestionHunkIds = sinon.stub();
    renderPanel({
      captureSelectionSession: async () => ({
        status: "ready",
        session,
      }),
      streamRequest,
      getSelectionContext: sinon.stub(),
      getSuggestionHunkIds,
    });
    await clickSelectionAction(
      "Review selection",
      "Review the selected phrase.",
    );
    await waitFor(() => expect(streamCall).not.to.equal(void 0));
    act(() => {
      streamCall?.onEvent(startedEvent(session.request));
      streamCall?.onEvent({
        ...eventBase(session.request.requestId, 1, "suggestion"),
        type: "suggestion",
        suggestion: suggestion(session.request),
      });
      streamCall?.onEvent({
        ...eventBase(session.request.requestId, 2, "completed"),
        type: "completed",
        finishReason: "stop",
      });
    });
    expect(screen.getByText("Finalizing")).to.exist;
    expect(screen.queryByText("Completed")).not.to.exist;
    expect(screen.getByRole("button", { name: "Apply" }).disabled).to.equal(
      true,
    );
    expect(getSuggestionHunkIds.called).to.equal(false);
    await act(async () => {
      stream.resolve();
      await stream.promise;
    });
    await screen.findByText("Completed");
    expect(screen.getByRole("button", { name: "Apply" }).disabled).to.equal(
      false,
    );
    expect(getSuggestionHunkIds.called).to.equal(false);
  });
  it("turns a parser rejection after completed into an error without an actionable window", async function () {
    const session = selectionSession({
      action: "rewrite",
      instruction: "Rewrite the selected phrase.",
    });
    const stream = deferred();
    let streamCall;
    const streamRequest = sinon.stub().callsFake((call) => {
      streamCall = call;
      return stream.promise;
    });
    const getSuggestionHunkIds = sinon.stub();
    renderPanel({
      captureSelectionSession: async () => ({
        status: "ready",
        session,
      }),
      streamRequest,
      getSelectionContext: sinon.stub(),
      getSuggestionHunkIds,
    });
    await clickSelectionAction(
      "Rewrite selection",
      "Rewrite the selected phrase.",
    );
    await waitFor(() => expect(streamCall).not.to.equal(void 0));
    act(() => {
      streamCall?.onEvent(startedEvent(session.request));
      streamCall?.onEvent({
        ...eventBase(session.request.requestId, 1, "suggestion"),
        type: "suggestion",
        suggestion: suggestion(session.request),
      });
      streamCall?.onEvent({
        ...eventBase(session.request.requestId, 2, "completed"),
        type: "completed",
        finishReason: "stop",
      });
    });
    expect(screen.getByText("Finalizing")).to.exist;
    expect(screen.queryByRole("button", { name: /accept/i })).not.to.exist;
    expect(screen.getByRole("button", { name: "Apply" }).disabled).to.equal(
      true,
    );
    expect(getSuggestionHunkIds.called).to.equal(false);
    await act(async () => {
      stream.reject(
        new AgentStreamError({
          code: "AI_STREAM_AFTER_TERMINAL",
          category: "schema",
          message: "The stream returned data after completion.",
          retryable: false,
        }),
      );
      try {
        await stream.promise;
      } catch {}
    });
    await screen.findByText("Error");
    expect(screen.getByRole("alert").textContent).to.include(
      "after completion",
    );
    expect(screen.queryByText("Completed")).not.to.exist;
    expect(screen.queryByRole("button", { name: /accept/i })).not.to.exist;
    expect(screen.getByRole("button", { name: "Apply" }).disabled).to.equal(
      true,
    );
    expect(getSuggestionHunkIds.called).to.equal(false);
  });
  it("rejects duplicate suggestion identities instead of overwriting them", async function () {
    const session = selectionSession({
      action: "rewrite",
      instruction: "Rewrite the selected phrase.",
    });
    const stream = deferred();
    let streamCall;
    const streamRequest = sinon.stub().callsFake((call) => {
      streamCall = call;
      return stream.promise;
    });
    renderPanel({
      captureSelectionSession: async () => ({
        status: "ready",
        session,
      }),
      streamRequest,
    });
    await clickSelectionAction(
      "Rewrite selection",
      "Rewrite the selected phrase.",
    );
    await waitFor(() => expect(streamCall).not.to.equal(void 0));
    act(() => {
      streamCall?.onEvent(startedEvent(session.request));
      streamCall?.onEvent({
        ...eventBase(session.request.requestId, 1, "suggestion"),
        type: "suggestion",
        suggestion: suggestion(session.request),
      });
      streamCall?.onEvent({
        ...eventBase(session.request.requestId, 2, "suggestion"),
        type: "suggestion",
        suggestion: {
          ...suggestion(session.request),
          replacement: "different",
          rationale: "A conflicting duplicate payload.",
        },
      });
    });
    await screen.findByText("Error");
    expect(screen.getByRole("alert").textContent).to.include(
      "duplicate suggestion",
    );
    expect(streamCall?.signal.aborted).to.equal(true);
    expect(screen.getByText("clear", { selector: "ins" })).to.exist;
    expect(screen.queryByText("different", { selector: "ins" })).not.to.exist;
    stream.resolve();
  });
  it("rejects duplicate finding identities instead of overwriting them", async function () {
    const session = selectionSession({
      action: "review",
      instruction: "Review the selected phrase.",
    });
    const stream = deferred();
    let streamCall;
    const streamRequest = sinon.stub().callsFake((call) => {
      streamCall = call;
      return stream.promise;
    });
    renderPanel({
      captureSelectionSession: async () => ({
        status: "ready",
        session,
      }),
      streamRequest,
    });
    await clickSelectionAction(
      "Review selection",
      "Review the selected phrase.",
    );
    await waitFor(() => expect(streamCall).not.to.equal(void 0));

    act(() => {
      streamCall?.onEvent(startedEvent(session.request));
      streamCall?.onEvent({
        ...eventBase(session.request.requestId, 1, "finding"),
        type: "finding",
        finding: finding(session.request),
      });
      streamCall?.onEvent({
        ...eventBase(session.request.requestId, 2, "finding"),
        type: "finding",
        finding: {
          ...finding(session.request),
          title: "Conflicting duplicate finding",
        },
      });
    });

    await screen.findByText("Error");
    expect(screen.getByRole("alert").textContent).to.include(
      "duplicate finding",
    );
    expect(streamCall?.signal.aborted).to.equal(true);
    expect(screen.getByText("Ambiguous synthetic phrase")).to.exist;
    expect(screen.queryByText("Conflicting duplicate finding")).not.to.exist;
    stream.resolve();
  });
  it("rejects a completed stream whose finding references a missing suggestion", async function () {
    const session = selectionSession({
      action: "review",
      instruction: "Review the selected phrase.",
    });
    const streamRequest = sinon.stub().callsFake(async (call) => {
      call.onEvent(startedEvent(session.request));
      call.onEvent({
        ...eventBase(session.request.requestId, 1, "finding"),
        type: "finding",
        finding: finding(session.request),
      });
      call.onEvent({
        ...eventBase(session.request.requestId, 2, "completed"),
        type: "completed",
        finishReason: "stop",
      });
    });
    renderPanel({
      captureSelectionSession: async () => ({
        status: "ready",
        session,
      }),
      streamRequest,
    });
    await clickSelectionAction(
      "Review selection",
      "Review the selected phrase.",
    );

    await screen.findByText("Error");
    expect(screen.getByRole("alert").textContent).to.include(
      "missing suggestion",
    );
    expect(screen.queryByText("Completed")).not.to.exist;
  });
  it("rejects callbacks delivered after a terminal event", async function () {
    const session = selectionSession({
      action: "rewrite",
      instruction: "Rewrite the selected phrase.",
    });
    const stream = deferred();
    let streamCall;
    const streamRequest = sinon.stub().callsFake((call) => {
      streamCall = call;
      return stream.promise;
    });
    renderPanel({
      captureSelectionSession: async () => ({
        status: "ready",
        session,
      }),
      streamRequest,
    });
    await clickSelectionAction(
      "Rewrite selection",
      "Rewrite the selected phrase.",
    );
    await waitFor(() => expect(streamCall).not.to.equal(void 0));

    act(() => {
      streamCall?.onEvent(startedEvent(session.request));
      streamCall?.onEvent({
        ...eventBase(session.request.requestId, 1, "completed"),
        type: "completed",
        finishReason: "stop",
      });
      streamCall?.onEvent({
        ...eventBase(session.request.requestId, 2, "suggestion"),
        type: "suggestion",
        suggestion: suggestion(session.request),
      });
    });

    await screen.findByText("Error");
    expect(screen.getByRole("alert").textContent).to.include(
      "after a terminal event",
    );
    expect(streamCall?.signal.aborted).to.equal(true);
    expect(screen.queryByText("clear", { selector: "ins" })).not.to.exist;
    expect(screen.queryByText("Completed")).not.to.exist;
    stream.resolve();
  });
  it("treats a stream that resolves without a completed event as incomplete", async function () {
    const session = selectionSession({
      action: "review",
      instruction: "Review the selected phrase.",
    });
    const streamRequest = sinon.stub().callsFake(async (call) => {
      call.onEvent(startedEvent(session.request));
    });
    renderPanel({
      captureSelectionSession: async () => ({
        status: "ready",
        session,
      }),
      streamRequest,
    });
    await clickSelectionAction(
      "Review selection",
      "Review the selected phrase.",
    );
    await screen.findByText("Error");
    expect(screen.getByRole("alert").textContent).to.include(
      "before completion",
    );
  });
  it("applies every hunk of the exact completed selection suggestion from its card", async function () {
    const session = selectionSession({
      action: "rewrite",
      instruction: "Rewrite the selected phrase.",
    });
    const emittedSuggestion = suggestion(session.request);
    const streamRequest = sinon.stub().callsFake(async (call) => {
      call.onEvent(startedEvent(session.request));
      call.onEvent({
        ...eventBase(session.request.requestId, 1, "suggestion"),
        type: "suggestion",
        suggestion: emittedSuggestion,
      });
      call.onEvent({
        ...eventBase(session.request.requestId, 2, "completed"),
        type: "completed",
        finishReason: "stop",
      });
    });
    const getSuggestionHunkIds = sinon
      .stub()
      .resolves(
        Object.freeze(["ai-hunk-v1-workspace-a", "ai-hunk-v1-workspace-b"]),
      );
    const applySelectionSuggestion = sinon.stub().resolves({
      status: "applied",
    });
    const getSelectionContext = sinon.stub();
    renderPanel({
      captureSelectionSession: async () => ({
        status: "ready",
        session,
      }),
      streamRequest,
      getSelectionContext,
      getSuggestionHunkIds,
      applySelectionSuggestion,
    });
    await clickSelectionAction(
      "Rewrite selection",
      "Rewrite the selected phrase.",
    );
    await screen.findByText("Completed");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Apply",
      }),
    );
    expect(getSuggestionHunkIds.calledOnce).to.equal(true);
    expect(getSuggestionHunkIds.firstCall.args[0].request).to.equal(
      session.request,
    );
    expect(getSuggestionHunkIds.firstCall.args[0].suggestion).to.equal(
      emittedSuggestion,
    );
    expect(getSelectionContext.called).to.equal(false);

    await waitFor(() => expect(screen.queryByText("Completed")).not.to.exist);
    expect(applySelectionSuggestion.calledOnce).to.equal(true);
    const application = applySelectionSuggestion.firstCall.args[0];
    expect(application.session).to.equal(session);
    expect(application.suggestion).to.equal(emittedSuggestion);
    expect(application.getContext).to.equal(getSelectionContext);
    expect(application.selectedHunkIds).to.deep.equal([
      "ai-hunk-v1-workspace-a",
      "ai-hunk-v1-workspace-b",
    ]);
    expect(Object.isFrozen(application.selectedHunkIds)).to.equal(true);
    expect(screen.queryByRole("button", { name: "Apply" })).not.to.exist;
  });
  it("fails closed on AI_DIFF_PLAN_MISMATCH from the card Apply entry point", async function () {
    const session = selectionSession({
      action: "rewrite",
      instruction: "Rewrite the selected phrase.",
    });
    const streamRequest = sinon.stub().callsFake(async (call) => {
      call.onEvent(startedEvent(session.request));
      call.onEvent({
        ...eventBase(session.request.requestId, 1, "suggestion"),
        type: "suggestion",
        suggestion: suggestion(session.request),
      });
      call.onEvent({
        ...eventBase(session.request.requestId, 2, "completed"),
        type: "completed",
        finishReason: "stop",
      });
    });
    const getSuggestionHunkIds = sinon
      .stub()
      .rejects(
        new DetachedSuggestionDiffError(
          "AI_DIFF_PLAN_MISMATCH",
          "private plan mismatch detail",
        ),
      );
    renderPanel({
      captureSelectionSession: sinon.stub().resolves({
        status: "ready",
        session,
      }),
      streamRequest,
      getSelectionContext: sinon.stub(),
      getSuggestionHunkIds,
    });

    await clickSelectionAction(
      "Rewrite selection",
      "Rewrite the selected phrase.",
    );
    await screen.findByText("Completed");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect((await screen.findByRole("alert")).textContent).to.equal(
      "The suggestion could not be applied.",
    );
    expect(document.body.textContent).not.to.include(
      "private plan mismatch detail",
    );
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(getSuggestionHunkIds.callCount).to.equal(2));
  });
  it("rejects a foreign hunk ID from the card Apply entry point", async function () {
    const session = selectionSession({
      action: "rewrite",
      instruction: "Rewrite the selected phrase.",
    });
    const emittedSuggestion = suggestion(session.request);
    const streamRequest = sinon.stub().callsFake(async (call) => {
      call.onEvent(startedEvent(session.request));
      call.onEvent({
        ...eventBase(session.request.requestId, 1, "suggestion"),
        type: "suggestion",
        suggestion: emittedSuggestion,
      });
      call.onEvent({
        ...eventBase(session.request.requestId, 2, "completed"),
        type: "completed",
        finishReason: "stop",
      });
    });
    const applySelectionSuggestion = sinon.stub().callsFake((options) =>
      compileSelectedSuggestionHunks({
        request: options.session.request,
        suggestion: options.suggestion,
        selectedHunkIds: options.selectedHunkIds,
        documentLength: baseText.length,
      }),
    );
    renderPanel({
      captureSelectionSession: sinon.stub().resolves({
        status: "ready",
        session,
      }),
      streamRequest,
      getSelectionContext: sinon.stub(),
      getSuggestionHunkIds: sinon
        .stub()
        .resolves(Object.freeze(["ai-hunk-v1-foreign"])),
      applySelectionSuggestion,
    });

    await clickSelectionAction(
      "Rewrite selection",
      "Rewrite the selected phrase.",
    );
    await screen.findByText("Completed");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    expect((await screen.findByRole("alert")).textContent).to.equal(
      "The suggestion could not be applied.",
    );
    expect(applySelectionSuggestion.calledOnce).to.equal(true);
    expect(screen.getByText("Status: Unresolved")).to.exist;
  });
  it("fails closed on a stale plan and disables card Apply", async function () {
    const instruction = "Rewrite the selected phrase.";
    const session = selectionSession({
      action: "rewrite",
      instruction,
    });
    const streamRequest = sinon.stub().callsFake(async (call) => {
      call.onEvent(startedEvent(session.request));
      call.onEvent({
        ...eventBase(session.request.requestId, 1, "suggestion"),
        type: "suggestion",
        suggestion: suggestion(session.request),
      });
      call.onEvent({
        ...eventBase(session.request.requestId, 2, "completed"),
        type: "completed",
        finishReason: "stop",
      });
    });
    const getSuggestionHunkIds = sinon
      .stub()
      .resolves(Object.freeze(["ai-hunk-v1-conflict"]));
    renderPanel({
      captureSelectionSession: sinon.stub().resolves({
        status: "ready",
        session,
      }),
      streamRequest,
      getSelectionContext: sinon.stub(),
      getSuggestionHunkIds,
      applySelectionSuggestion: sinon.stub().resolves({
        status: "conflict",
        code: "AI_SUGGESTION_HASH_STALE",
      }),
    });

    await clickSelectionAction("Rewrite selection", instruction);
    await screen.findByText("Completed");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));

    await screen.findByText("Conflict: AI_SUGGESTION_HASH_STALE");
    const suggestionsSection = screen.getByRole("region", {
      name: "Review suggestions",
    });
    expect(
      within(suggestionsSection)
        .getAllByRole("button")
        .map(
          (button) => button.getAttribute("aria-label") ?? button.textContent,
        ),
    ).to.deep.equal([
      "Discuss suggestion",
      "Discard suggestion",
      "Apply",
      "More options",
    ]);
    expect(
      within(suggestionsSection).getByRole("button", { name: "Apply" })
        .disabled,
    ).to.equal(true);
    const conflictStatus =
      within(suggestionsSection).getByText("Status: Conflict");
    const conflictCard = conflictStatus.closest(".ai-reviewer-artifact");
    expect(conflictCard).not.to.equal(null);
    expect(
      conflictCard.classList.contains("ai-reviewer-artifact-resolved"),
    ).to.equal(false);
    expect(conflictCard.querySelector("details")).to.equal(null);
    expect(
      within(conflictCard)
        .getByRole("button", { name: "Discard suggestion" })
        .closest("details"),
    ).to.equal(null);
  });
  it("synchronously aborts an in-flight card application before a new run", async function () {
    const sessionA = selectionSession({
      action: "rewrite",
      instruction: "Rewrite the selected phrase.",
    });
    const sessionB = selectionSession({
      action: "review",
      instruction: "Review the selected phrase.",
    });
    let applicationSignal;
    const captureSelectionSession = sinon
      .stub()
      .onFirstCall()
      .resolves({
        status: "ready",
        session: sessionA,
      })
      .onSecondCall()
      .callsFake(async () => {
        expect(applicationSignal?.aborted).to.equal(true);
        return {
          status: "ready",
          session: sessionB,
        };
      });
    const replacementStream = deferred();
    const streamRequest = sinon.stub();
    streamRequest.onFirstCall().callsFake(async (call) => {
      call.onEvent(startedEvent(sessionA.request));
      call.onEvent({
        ...eventBase(sessionA.request.requestId, 1, "suggestion"),
        type: "suggestion",
        suggestion: suggestion(sessionA.request),
      });
      call.onEvent({
        ...eventBase(sessionA.request.requestId, 2, "completed"),
        type: "completed",
        finishReason: "stop",
      });
    });
    streamRequest.onSecondCall().callsFake(() => replacementStream.promise);
    const getSuggestionHunkIds = sinon
      .stub()
      .resolves(Object.freeze(["ai-hunk-v1-workspace"]));
    const application = deferred();
    const applySelectionSuggestion = sinon.stub().returns(application.promise);
    const rendered = renderPanel({
      captureSelectionSession,
      streamRequest,
      getSelectionContext: sinon.stub(),
      getSuggestionHunkIds,
      applySelectionSuggestion,
    });
    await clickSelectionAction(
      "Rewrite selection",
      "Rewrite the selected phrase.",
    );
    await screen.findByText("Completed");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() =>
      expect(applySelectionSuggestion.calledOnce).to.equal(true),
    );
    applicationSignal = applySelectionSuggestion.firstCall.args[0].signal;
    expect(applicationSignal.aborted).to.equal(false);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Review selection",
      }),
    );
    expect(applicationSignal.aborted).to.equal(true);
    await waitFor(() => expect(streamRequest.callCount).to.equal(2));
    expect(screen.getByText("Streaming")).to.exist;

    await act(async () => {
      application.resolve({
        status: "applied",
      });
      await application.promise;
    });
    expect(screen.queryByText("Status: Applied")).not.to.exist;
    rendered.unmount();
    replacementStream.resolve();
  });
  it("does not start a second card application while one is in flight", async function () {
    const session = selectionSession({
      action: "rewrite",
      instruction: "Rewrite the selected phrase.",
    });
    const firstSuggestion = suggestion(session.request);
    const secondSuggestion = {
      ...suggestion(session.request),
      id: "suggestion-0002",
      replacement: "precise",
      rationale: "Use another deterministic synthetic term.",
    };
    const streamRequest = sinon.stub().callsFake(async (call) => {
      call.onEvent(startedEvent(session.request));
      call.onEvent({
        ...eventBase(session.request.requestId, 1, "suggestion"),
        type: "suggestion",
        suggestion: firstSuggestion,
      });
      call.onEvent({
        ...eventBase(session.request.requestId, 2, "suggestion"),
        type: "suggestion",
        suggestion: secondSuggestion,
      });
      call.onEvent({
        ...eventBase(session.request.requestId, 3, "completed"),
        type: "completed",
        finishReason: "stop",
      });
    });
    const getSuggestionHunkIds = sinon
      .stub()
      .resolves(Object.freeze(["ai-hunk-v1-first"]));
    const application = deferred();
    const applySelectionSuggestion = sinon.stub().returns(application.promise);
    renderPanel({
      captureSelectionSession: async () => ({
        status: "ready",
        session,
      }),
      streamRequest,
      getSelectionContext: sinon.stub(),
      getSuggestionHunkIds,
      applySelectionSuggestion,
    });
    await clickSelectionAction(
      "Rewrite selection",
      "Rewrite the selected phrase.",
    );
    await screen.findByText("Completed");

    const applyButtons = screen.getAllByRole("button", { name: "Apply" });
    fireEvent.click(applyButtons[0]);
    await waitFor(() =>
      expect(applySelectionSuggestion.calledOnce).to.equal(true),
    );
    fireEvent.click(applyButtons[1]);
    expect(getSuggestionHunkIds.calledOnce).to.equal(true);
    expect(getSuggestionHunkIds.firstCall.args[0].suggestion).to.equal(
      firstSuggestion,
    );
    application.resolve({ status: "cancelled" });
  });
  it("applies a prototype-shaped suggestion ID from its card", async function () {
    const session = selectionSession({
      action: "rewrite",
      instruction: "Rewrite the selected phrase.",
    });
    const prototypeSuggestion = {
      ...suggestion(session.request),
      id: "constructor",
    };
    const streamRequest = sinon.stub().callsFake(async (call) => {
      call.onEvent(startedEvent(session.request));
      call.onEvent({
        ...eventBase(session.request.requestId, 1, "suggestion"),
        type: "suggestion",
        suggestion: prototypeSuggestion,
      });
      call.onEvent({
        ...eventBase(session.request.requestId, 2, "completed"),
        type: "completed",
        finishReason: "stop",
      });
    });
    const getSuggestionHunkIds = sinon
      .stub()
      .resolves(Object.freeze(["ai-hunk-v1-prototype"]));
    const applySelectionSuggestion = sinon.stub().resolves({
      status: "applied",
    });
    renderPanel({
      captureSelectionSession: async () => ({
        status: "ready",
        session,
      }),
      streamRequest,
      getSelectionContext: sinon.stub(),
      getSuggestionHunkIds,
      applySelectionSuggestion,
    });
    await clickSelectionAction(
      "Rewrite selection",
      "Rewrite the selected phrase.",
    );
    await screen.findByText("Completed");

    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(screen.queryByText("Completed")).not.to.exist);
    expect(getSuggestionHunkIds.firstCall.args[0].suggestion).to.equal(
      prototypeSuggestion,
    );
  });
  it("stores statuses for prototype-shaped suggestion IDs as own entries", function () {
    const session = selectionSession({
      action: "rewrite",
      instruction: "Rewrite the selected phrase.",
    });
    for (const suggestionId of ["constructor", "__proto__", "toString"]) {
      const prototypeSuggestion = {
        ...suggestion(session.request),
        id: suggestionId,
      };
      const state = {
        ...initialSelectionWorkspaceState,
        status: "completed",
        generation: 7,
        requestId: session.request.requestId,
        session,
        suggestions: [prototypeSuggestion],
        suggestionStatuses: {
          [suggestionId]: "unresolved",
        },
      };
      const decided = reduceSelectionWorkspaceState(state, {
        type: "suggestion-decision",
        generation: 7,
        requestId: session.request.requestId,
        suggestionId,
        decision: {
          status: "discarded",
        },
      });

      expect(decided).not.to.equal(state);
      expect(
        Object.prototype.hasOwnProperty.call(
          decided.suggestionStatuses,
          suggestionId,
        ),
      ).to.equal(true);
      expect(decided.suggestionStatuses[suggestionId]).to.equal("discarded");
      expect(
        reduceSelectionWorkspaceState(decided, {
          type: "suggestion-decision",
          generation: 7,
          requestId: session.request.requestId,
          suggestionId,
          decision: {
            status: "applied",
          },
        }),
      ).to.equal(decided);
    }
  });
  it("keeps a prior run suggestion actionable across a same-identity generation", async function () {
    const session = selectionSession({
      action: "rewrite",
      instruction: "Rewrite the selected phrase.",
    });
    const emittedSuggestion = suggestion(session.request);
    const captureSelectionSession = sinon.stub().resolves({
      status: "ready",
      session,
    });
    const streamRequest = sinon.stub().callsFake(async (call) => {
      call.onEvent(startedEvent(session.request));
      call.onEvent({
        ...eventBase(session.request.requestId, 1, "suggestion"),
        type: "suggestion",
        suggestion: emittedSuggestion,
      });
      call.onEvent({
        ...eventBase(session.request.requestId, 2, "completed"),
        type: "completed",
        finishReason: "stop",
      });
    });
    const getSuggestionHunkIds = sinon
      .stub()
      .resolves(Object.freeze(["ai-hunk-v1-generation"]));
    renderPanel({
      captureSelectionSession,
      streamRequest,
      createRequestId: () => session.request.requestId,
      getSelectionContext: sinon.stub(),
      getSuggestionHunkIds,
      applySelectionSuggestion: sinon.stub().resolves({
        status: "cancelled",
      }),
    });
    await clickSelectionAction(
      "Rewrite selection",
      "Rewrite the selected phrase.",
    );
    await screen.findByText("Completed");
    const replacementRunButton = screen.getByRole("button", {
      name: "Rewrite selection",
    });
    fireEvent.click(replacementRunButton);
    await waitFor(() => expect(streamRequest.callCount).to.equal(2));
    await waitFor(() =>
      expect(screen.getAllByText("Completed")).to.have.length(2),
    );

    expect(captureSelectionSession.callCount).to.equal(2);
    const applyButtons = screen.getAllByRole("button", { name: "Apply" });
    expect(applyButtons).to.have.length(2);
    fireEvent.click(applyButtons[1]);
    await waitFor(() => expect(getSuggestionHunkIds.calledOnce).to.equal(true));
    expect(getSuggestionHunkIds.firstCall.args[0].request).to.equal(
      session.request,
    );
    expect(getSuggestionHunkIds.firstCall.args[0].suggestion).to.equal(
      emittedSuggestion,
    );
  });
});
async function renderCompletedEvidenceWorkspace({
  navigateEvidence,
  evidence,
  getSelectionContext = sinon.stub(),
  streamRequest: receivedStreamRequest,
  createRequestId = () => "request-duplicate",
} = {}) {
  const instruction = "Review the selected phrase.";
  const session = selectionSession({
    action: "review",
    instruction,
  });
  const emittedFinding = {
    ...finding(session.request),
    evidence: evidence ?? finding(session.request).evidence,
    suggestionIds: [],
  };
  const captureSelectionSession = sinon.stub().resolves({
    status: "ready",
    session,
  });
  const streamRequest =
    receivedStreamRequest ??
    sinon.stub().callsFake(async (call) => {
      call.onEvent(startedEvent(session.request));
      call.onEvent({
        ...eventBase(session.request.requestId, 1, "finding"),
        type: "finding",
        finding: emittedFinding,
      });
      call.onEvent({
        ...eventBase(session.request.requestId, 2, "completed"),
        type: "completed",
        finishReason: "stop",
      });
    });
  const rendered = renderPanel({
    captureSelectionSession,
    streamRequest,
    createRequestId,
    getSelectionContext,
    navigateEvidence,
  });

  await clickSelectionAction("Review selection", instruction);
  await screen.findByText("Completed");
  return {
    captureSelectionSession,
    emittedFinding,
    getSelectionContext,
    rendered,
    session,
    streamRequest,
  };
}

describe("AI reviewer: single document evidence navigation workspace", function () {
  it("passes one exact completed finding target to the injected navigator", async function () {
    const navigateEvidence = sinon.stub().resolves({
      status: "navigated",
    });
    const workspace = await renderCompletedEvidenceWorkspace({
      navigateEvidence,
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Go to text",
      }),
    );
    await waitFor(() => expect(navigateEvidence.calledOnce).to.equal(true));

    const options = navigateEvidence.firstCall.args[0];
    expect(options.target).to.include({
      requestId: workspace.session.request.requestId,
      findingId: workspace.emittedFinding.id,
      projectId,
      documentId,
      path,
      baseRevision: 7,
      baseTextHash,
    });
    expect(options.target.range).to.deep.equal({
      from: 6,
      to: 10,
    });
    expect(options.target.currentDocument).to.equal(
      workspace.session.binding.currentDocument,
    );
    expect(options.target.shareDocument).to.equal(
      workspace.session.binding.shareDocument,
    );
    expect(options.getContext).to.equal(workspace.getSelectionContext);
    expect(options.signal.addEventListener).to.be.a("function");
    expect(options.signal.removeEventListener).to.be.a("function");
    expect(options.signal.aborted).to.equal(false);
    expect(workspace.streamRequest.calledOnce).to.equal(true);
    expect(await screen.findByText("Evidence selected")).to.exist;
  });

  it("normalizes a malformed resolved navigator result without unmounting", async function () {
    const navigateEvidence = sinon.stub().resolves(null);
    await renderCompletedEvidenceWorkspace({
      navigateEvidence,
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Go to text",
      }),
    );

    expect(
      await screen.findByText(
        "Evidence navigation failed: AI_EVIDENCE_NAVIGATION_FAILED",
      ),
    ).to.exist;
    expect(screen.getByText("Completed")).to.exist;
    expect(screen.getByText("Ambiguous synthetic phrase")).to.exist;
    expect(
      screen.getByRole("button", {
        name: "Go to text",
      }),
    ).to.exist;
  });

  const malformedNavigatorResults = [
    {
      name: "an unknown status",
      value: {
        status: "AI_EVIDENCE_PRIVATE_STATUS",
      },
    },
    {
      name: "an unknown conflict code",
      value: {
        status: "conflict",
        code: "AI_EVIDENCE_PRIVATE_CONFLICT",
      },
    },
    {
      name: "an unknown error code",
      value: {
        status: "error",
        code: "AI_EVIDENCE_PRIVATE_ERROR",
      },
    },
  ];

  for (const malformedResult of malformedNavigatorResults) {
    it(`normalizes ${malformedResult.name} without exposing it`, async function () {
      const navigateEvidence = sinon.stub().resolves(malformedResult.value);
      await renderCompletedEvidenceWorkspace({
        navigateEvidence,
      });

      fireEvent.click(
        screen.getByRole("button", {
          name: "Go to text",
        }),
      );

      expect(
        await screen.findByText(
          "Evidence navigation failed: AI_EVIDENCE_NAVIGATION_FAILED",
        ),
      ).to.exist;
      expect(document.body.textContent).not.to.contain(
        malformedResult.value.code ?? malformedResult.value.status,
      );
      expect(screen.getByText("Completed")).to.exist;
    });
  }

  it("normalizes a rejected navigator without exposing its raw error", async function () {
    const navigateEvidence = sinon
      .stub()
      .rejects(new Error("AI_EVIDENCE_PRIVATE_REJECTION"));
    await renderCompletedEvidenceWorkspace({
      navigateEvidence,
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Go to text",
      }),
    );

    expect(
      await screen.findByText(
        "Evidence navigation failed: AI_EVIDENCE_NAVIGATION_FAILED",
      ),
    ).to.exist;
    expect(document.body.textContent).not.to.contain(
      "AI_EVIDENCE_PRIVATE_REJECTION",
    );
    expect(screen.getByText("Completed")).to.exist;
  });

  it("keeps range-less selection evidence as read-only text", async function () {
    const navigateEvidence = sinon.stub().resolves({
      status: "navigated",
    });
    await renderCompletedEvidenceWorkspace({
      navigateEvidence,
      evidence: [
        {
          path,
          revision: 7,
          textHash: baseTextHash,
        },
      ],
    });

    expect(screen.getByText(path)).to.exist;
    expect(
      screen.queryByRole("button", {
        name: /Go to location/,
      }),
    ).not.to.exist;
    expect(navigateEvidence.called).to.equal(false);
  });

  it("aborts an earlier evidence click and ignores its late result", async function () {
    const navigationA = deferred();
    const navigationB = deferred();
    const navigateEvidence = sinon.stub();
    navigateEvidence.onFirstCall().returns(navigationA.promise);
    navigateEvidence.onSecondCall().returns(navigationB.promise);
    await renderCompletedEvidenceWorkspace({
      navigateEvidence,
      evidence: [
        {
          path,
          range: {
            from: 6,
            to: 8,
          },
          revision: 7,
          textHash: baseTextHash,
        },
        {
          path,
          range: {
            from: 8,
            to: 10,
          },
          revision: 7,
          textHash: baseTextHash,
        },
      ],
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Go to location 1",
      }),
    );
    await waitFor(() => expect(navigateEvidence.callCount).to.equal(1));
    const firstSignal = navigateEvidence.firstCall.args[0].signal;
    fireEvent.click(
      screen.getByRole("button", {
        name: "Go to location 2",
      }),
    );
    await waitFor(() => expect(navigateEvidence.callCount).to.equal(2));
    expect(firstSignal.aborted).to.equal(true);

    await act(async () => {
      navigationB.resolve({
        status: "navigated",
      });
      await navigationB.promise;
    });
    expect(await screen.findByText("Evidence selected")).to.exist;

    await act(async () => {
      navigationA.resolve({
        status: "conflict",
        code: "AI_EVIDENCE_STATE_STALE",
      });
      await navigationA.promise;
    });
    expect(screen.getByText("Evidence selected")).to.exist;
    expect(screen.queryByText(/AI_EVIDENCE_STATE_STALE/)).not.to.exist;
  });

  it("aborts pending evidence navigation before a replacement review starts", async function () {
    const navigation = deferred();
    const secondStream = deferred();
    const navigateEvidence = sinon.stub().returns(navigation.promise);
    let streamCount = 0;
    const streamRequest = sinon.stub().callsFake(async (call) => {
      streamCount += 1;
      if (streamCount === 2) {
        return secondStream.promise;
      }
      call.onEvent(startedEvent(call.request));
      call.onEvent({
        ...eventBase(call.request.requestId, 1, "finding"),
        type: "finding",
        finding: {
          ...finding(call.request),
          suggestionIds: [],
        },
      });
      call.onEvent({
        ...eventBase(call.request.requestId, 2, "completed"),
        type: "completed",
        finishReason: "stop",
      });
    });
    await renderCompletedEvidenceWorkspace({
      navigateEvidence,
      streamRequest,
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Go to text",
      }),
    );
    await waitFor(() => expect(navigateEvidence.calledOnce).to.equal(true));
    const navigationSignal = navigateEvidence.firstCall.args[0].signal;

    fireEvent.click(
      screen.getByRole("button", {
        name: "Review selection",
      }),
    );
    expect(navigationSignal.aborted).to.equal(true);
    await waitFor(() => expect(streamRequest.callCount).to.equal(2));

    await act(async () => {
      navigation.resolve({
        status: "navigated",
      });
      await navigation.promise;
    });
    expect(screen.queryByText("Evidence selected")).not.to.exist;
    expect(screen.getByText("Streaming")).to.exist;
    secondStream.resolve();
  });

  it("keeps prior run evidence actionable across a same-identity generation", async function () {
    const navigateEvidence = sinon.stub().resolves({
      status: "navigated",
    });
    const workspace = await renderCompletedEvidenceWorkspace({
      navigateEvidence,
    });
    const replacementRunButton = screen.getByRole("button", {
      name: "Review selection",
    });
    const staleEvidenceButton = screen.getByRole("button", {
      name: "Go to text",
    });

    await act(async () => {
      replacementRunButton.click();
      staleEvidenceButton.click();
    });
    await waitFor(() => expect(workspace.streamRequest.callCount).to.equal(2));
    await waitFor(() =>
      expect(screen.getAllByText("Completed")).to.have.length(2),
    );

    expect(workspace.captureSelectionSession.callCount).to.equal(2);
    expect(navigateEvidence.calledOnce).to.equal(true);
    expect(navigateEvidence.firstCall.args[0].target.findingId).to.equal(
      workspace.emittedFinding.id,
    );
    expect(screen.queryByText("Selecting evidence")).not.to.exist;
    expect(screen.getByText("Evidence selected")).to.exist;
    expect(
      screen.getAllByRole("button", {
        name: "Go to text",
      }),
    ).to.have.length(2);
  });

  it("aborts pending evidence navigation on unmount", async function () {
    const navigation = deferred();
    const navigateEvidence = sinon.stub().returns(navigation.promise);
    const workspace = await renderCompletedEvidenceWorkspace({
      navigateEvidence,
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Go to text",
      }),
    );
    await waitFor(() => expect(navigateEvidence.calledOnce).to.equal(true));
    const navigationSignal = navigateEvidence.firstCall.args[0].signal;

    workspace.rendered.unmount();
    expect(navigationSignal.aborted).to.equal(true);
    await act(async () => {
      navigation.resolve({
        status: "navigated",
      });
      await navigation.promise;
    });
  });

  it("shows only the bounded conflict code from the active navigation", async function () {
    const navigateEvidence = sinon.stub().resolves({
      status: "conflict",
      code: "AI_EVIDENCE_STATE_STALE",
    });
    await renderCompletedEvidenceWorkspace({
      navigateEvidence,
    });

    fireEvent.click(
      screen.getByRole("button", {
        name: "Go to text",
      }),
    );

    expect(
      await screen.findByText("Evidence unavailable: AI_EVIDENCE_STATE_STALE"),
    ).to.exist;
  });
});
describe("AI reviewer: OT safety selection workspace", function () {
  it("does not revive a cancelled capture when a same-ID replacement run starts", async function () {
    const captureA = deferred();
    const captureB = deferred();
    const stream = deferred();
    const captureSelectionSession = sinon.stub();
    captureSelectionSession.onFirstCall().returns(captureA.promise);
    captureSelectionSession.onSecondCall().returns(captureB.promise);
    const streamRequest = sinon.stub().callsFake((_call) => stream.promise);
    renderPanel({
      captureSelectionSession,
      streamRequest,
      createRequestId: () => "request-duplicate",
    });
    await clickSelectionAction(
      "Review selection",
      "Review the selected phrase.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await screen.findByText("Cancelled");
    await clickSelectionAction(
      "Rewrite selection",
      "Rewrite the selected phrase.",
    );
    await act(async () => {
      captureA.resolve({
        status: "ready",
        session: selectionSession({
          action: "review",
          instruction: "Review the selected phrase.",
        }),
      });
      await Promise.resolve();
    });
    expect(streamRequest.called).to.equal(false);
    expect(screen.getByText("Capturing review target")).to.exist;
    const sessionB = selectionSession({
      action: "rewrite",
      instruction: "Rewrite the selected phrase.",
    });
    await act(async () => {
      captureB.resolve({
        status: "ready",
        session: sessionB,
      });
      await Promise.resolve();
    });
    await waitFor(() => expect(streamRequest.calledOnce).to.equal(true));
    expect(streamRequest.firstCall.args[0].request).to.equal(sessionB.request);
    expect(screen.getByText("Streaming")).to.exist;
    stream.resolve();
  });
  it("uses run-object identity to discard old callbacks and settlement with duplicate request IDs", async function () {
    const sessionA = selectionSession({
      action: "review",
      instruction: "Review the selected phrase.",
    });
    const sessionB = selectionSession({
      action: "rewrite",
      instruction: "Rewrite the selected phrase.",
    });
    const streamA = deferred();
    const streamB = deferred();
    const streamCalls = [];
    const streamRequest = sinon.stub().callsFake((call) => {
      streamCalls.push(call);
      return streamCalls.length === 1 ? streamA.promise : streamB.promise;
    });
    const captureSelectionSession = sinon
      .stub()
      .onFirstCall()
      .resolves({
        status: "ready",
        session: sessionA,
      })
      .onSecondCall()
      .resolves({
        status: "ready",
        session: sessionB,
      });
    renderPanel({
      captureSelectionSession,
      streamRequest,
      createRequestId: () => "request-duplicate",
    });
    await clickSelectionAction(
      "Review selection",
      "Review the selected phrase.",
    );
    await waitFor(() => expect(streamCalls).to.have.length(1));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(streamCalls[0].signal.aborted).to.equal(true);
    await clickSelectionAction(
      "Rewrite selection",
      "Rewrite the selected phrase.",
    );
    await waitFor(() => expect(streamCalls).to.have.length(2));
    act(() => {
      streamCalls[0].onEvent({
        ...eventBase("request-duplicate", 0, "text.delta"),
        type: "text.delta",
        delta: "Stale result A.",
      });
      streamCalls[0].onEvent({
        ...eventBase("request-duplicate", 1, "finding"),
        type: "finding",
        finding: {
          ...finding(sessionA.request),
          title: "Stale finding A",
          suggestionIds: [],
        },
      });
      streamCalls[0].onEvent({
        ...eventBase("request-duplicate", 2, "completed"),
        type: "completed",
        finishReason: "stop",
      });
    });
    await act(async () => {
      streamA.resolve();
      await streamA.promise;
    });
    expect(screen.queryByText("Stale result A.")).not.to.exist;
    expect(screen.queryByText("Stale finding A")).not.to.exist;
    expect(screen.getByText("Streaming")).to.exist;
    expect(screen.getByRole("button", { name: "Stop" })).to.exist;
    act(() => {
      streamCalls[1].onEvent(startedEvent(sessionB.request));
      streamCalls[1].onEvent({
        ...eventBase("request-duplicate", 1, "text.delta"),
        type: "text.delta",
        delta: "Current result B.",
      });
      streamCalls[1].onEvent({
        ...eventBase("request-duplicate", 2, "completed"),
        type: "completed",
        finishReason: "stop",
      });
    });
    expect(screen.getByText("Current result B.")).to.exist;
    expect(screen.getByText("Finalizing")).to.exist;
    await act(async () => {
      streamB.resolve();
      await streamB.promise;
    });
    await screen.findByText("Completed");
    expect(screen.queryByText("Stale result A.")).not.to.exist;
  });
  it("does not start streaming after unmounting during capture", async function () {
    const capture = deferred();
    const streamRequest = sinon.stub().resolves();
    const rendered = renderPanel({
      captureSelectionSession: () => capture.promise,
      streamRequest,
    });
    await clickSelectionAction(
      "Review selection",
      "Review the selected phrase.",
    );
    rendered.unmount();
    await act(async () => {
      capture.resolve({
        status: "ready",
        session: selectionSession({
          action: "review",
          instruction: "Review the selected phrase.",
        }),
      });
      await Promise.resolve();
    });
    expect(streamRequest.called).to.equal(false);
  });
});
function context(project) {
  return {
    view: null,
    projectId: project,
    currentDocumentId: null,
    path: null,
    currentDocument: null,
    sourceMode: true,
    connected: true,
    permissions: {
      read: true,
      write: true,
      trackedWrite: true,
    },
    trackChanges: false,
    wantTrackChanges: false,
  };
}
function CommittedContextProbe({ value, suspend, expose }) {
  const getContext = useLatestCommittedEditorSelectionSessionContext(value);
  useLayoutEffect(() => {
    expose(getContext);
  }, [expose, getContext]);
  if (suspend != null) {
    throw suspend;
  }
  return null;
}
describe("AI reviewer: OT safety committed selection context", function () {
  it("exposes the latest committed host context through one stable getter", function () {
    let getter;
    const expose = (candidate) => {
      getter = candidate;
    };
    const rendered = render(
      React.createElement(CommittedContextProbe, {
        value: context("project-a"),
        suspend: null,
        expose,
      }),
    );
    const initialGetter = getter;
    rendered.rerender(
      React.createElement(CommittedContextProbe, {
        value: context("project-b"),
        suspend: null,
        expose,
      }),
    );
    expect(getter).to.equal(initialGetter);
    expect(initialGetter?.().projectId).to.equal("project-b");
  });
  it("does not leak context from an abandoned suspended render", async function () {
    let getter;
    const expose = (candidate) => {
      getter = candidate;
    };
    const never = new Promise(() => {});
    const rendered = render(
      React.createElement(
        Suspense,
        {
          fallback: React.createElement("div", null, "Suspended context"),
        },
        React.createElement(CommittedContextProbe, {
          value: context("project-committed"),
          suspend: null,
          expose,
        }),
      ),
    );
    const committedGetter = getter;
    rendered.rerender(
      React.createElement(
        Suspense,
        {
          fallback: React.createElement("div", null, "Suspended context"),
        },
        React.createElement(CommittedContextProbe, {
          value: context("project-uncommitted"),
          suspend: never,
          expose,
        }),
      ),
    );
    await screen.findByText("Suspended context");
    expect(getter).to.equal(committedGetter);
    expect(committedGetter?.().projectId).to.equal("project-committed");
  });
});
