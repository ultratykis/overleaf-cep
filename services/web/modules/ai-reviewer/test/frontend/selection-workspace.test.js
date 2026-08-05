/* eslint-disable react/prop-types */
const {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
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
    status: "proposed",
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
  mountSuggestionPreview,
  applySelectionSuggestion,
}) {
  return render(
    React.createElement(AiReviewerPanelView, {
      projectId,
      createRequestId,
      captureSelectionSession,
      streamRequest,
      getSelectionContext,
      mountSuggestionPreview,
      applySelectionSuggestion,
    }),
  );
}
async function clickSelectionAction(buttonName, instruction) {
  fireEvent.change(screen.getByLabelText("Review instruction"), {
    target: {
      value: instruction,
    },
  });
  fireEvent.click(screen.getByRole("button", { name: buttonName }));
  await screen.findByText("Capturing selection");
}
describe("AI reviewer: single document selection workspace", function () {
  const actions = [
    {
      action: "review",
      buttonName: "Review selection",
    },
    {
      action: "rewrite",
      buttonName: "Rewrite selection",
    },
    {
      action: "shorten",
      buttonName: "Shorten selection",
    },
  ];
  for (const { action, buttonName } of actions) {
    it(`captures and displays a read-only ${action} result from the exact frozen request`, async function () {
      const instruction = `Synthetic ${action} instruction.`;
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
      expect(screen.getAllByText(`${path}:6-10`)).to.have.length(2);
      expect(screen.getByText("Original: beta")).to.exist;
      expect(screen.getByText("Replacement: clear")).to.exist;
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
    expect(screen.getByText("Replacement: clear")).to.exist;
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
    const mountSuggestionPreview = sinon.stub().resolves({
      hunkIds: Object.freeze(["ai-hunk-v1-workspace"]),
      destroy: sinon.stub(),
    });
    renderPanel({
      captureSelectionSession: async () => ({
        status: "ready",
        session,
      }),
      streamRequest,
      getSelectionContext: sinon.stub(),
      mountSuggestionPreview,
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
    expect(
      screen.queryByRole("button", {
        name: "Preview suggestion 1",
      }),
    ).not.to.exist;
    expect(mountSuggestionPreview.called).to.equal(false);
    await act(async () => {
      stream.resolve();
      await stream.promise;
    });
    await screen.findByText("Completed");
    expect(
      screen.getByRole("button", {
        name: "Preview suggestion 1",
      }),
    ).to.exist;
    expect(mountSuggestionPreview.called).to.equal(false);
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
    const mountSuggestionPreview = sinon.stub().resolves({
      hunkIds: Object.freeze(["ai-hunk-v1-workspace"]),
      destroy: sinon.stub(),
    });
    renderPanel({
      captureSelectionSession: async () => ({
        status: "ready",
        session,
      }),
      streamRequest,
      getSelectionContext: sinon.stub(),
      mountSuggestionPreview,
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
    expect(
      screen.queryByRole("button", {
        name: "Preview suggestion 1",
      }),
    ).not.to.exist;
    expect(mountSuggestionPreview.called).to.equal(false);
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
    expect(
      screen.queryByRole("button", {
        name: "Preview suggestion 1",
      }),
    ).not.to.exist;
    expect(mountSuggestionPreview.called).to.equal(false);
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
    expect(screen.getByText("Replacement: clear")).to.exist;
    expect(screen.queryByText("Replacement: different")).not.to.exist;
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
    expect(screen.queryByText("Replacement: clear")).not.to.exist;
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
  it("mounts and applies only the exact completed selection suggestion", async function () {
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
    let onSelectionChange;
    const destroy = sinon.stub();
    const mountSuggestionPreview = sinon.stub().callsFake(async (options) => {
      onSelectionChange = options.onSelectionChange;
      options.onSelectionChange([]);
      return {
        hunkIds: Object.freeze(["ai-hunk-v1-workspace"]),
        destroy,
      };
    });
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
      mountSuggestionPreview,
      applySelectionSuggestion,
    });
    await clickSelectionAction(
      "Rewrite selection",
      "Rewrite the selected phrase.",
    );
    await screen.findByText("Completed");
    expect(mountSuggestionPreview.called).to.equal(false);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Preview suggestion 1",
      }),
    );
    await screen.findByText("Suggestion preview ready");
    expect(mountSuggestionPreview.calledOnce).to.equal(true);
    expect(mountSuggestionPreview.firstCall.args[0].request).to.equal(
      session.request,
    );
    expect(mountSuggestionPreview.firstCall.args[0].suggestion).to.equal(
      emittedSuggestion,
    );
    expect(getSelectionContext.called).to.equal(false);
    act(() => {
      onSelectionChange(["ai-hunk-v1-workspace"]);
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Apply selected changes",
      }),
    );

    await screen.findByText("Applied");
    expect(applySelectionSuggestion.calledOnce).to.equal(true);
    const application = applySelectionSuggestion.firstCall.args[0];
    expect(application.session).to.equal(session);
    expect(application.suggestion).to.equal(emittedSuggestion);
    expect(application.getContext).to.equal(getSelectionContext);
    expect(application.selectedHunkIds).to.deep.equal(["ai-hunk-v1-workspace"]);
    expect(Object.isFrozen(application.selectedHunkIds)).to.equal(true);
    expect(destroy.calledOnce).to.equal(true);
    expect(
      screen.queryByRole("button", {
        name: "Preview suggestion 1",
      }),
    ).not.to.exist;
  });
  it("synchronously aborts and destroys an applying preview before a new run", async function () {
    const sessionA = selectionSession({
      action: "rewrite",
      instruction: "Rewrite the selected phrase.",
    });
    const sessionB = selectionSession({
      action: "review",
      instruction: "Rewrite the selected phrase.",
    });
    let applicationSignal;
    const destroy = sinon.stub();
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
        expect(destroy.calledOnce).to.equal(true);
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
    let onSelectionChange;
    const mountSuggestionPreview = sinon.stub().callsFake(async (options) => {
      onSelectionChange = options.onSelectionChange;
      options.onSelectionChange([]);
      return {
        hunkIds: Object.freeze(["ai-hunk-v1-workspace"]),
        destroy,
      };
    });
    const application = deferred();
    const applySelectionSuggestion = sinon.stub().returns(application.promise);
    const rendered = renderPanel({
      captureSelectionSession,
      streamRequest,
      getSelectionContext: sinon.stub(),
      mountSuggestionPreview,
      applySelectionSuggestion,
    });
    await clickSelectionAction(
      "Rewrite selection",
      "Rewrite the selected phrase.",
    );
    await screen.findByText("Completed");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Preview suggestion 1",
      }),
    );
    await screen.findByText("Suggestion preview ready");
    act(() => {
      onSelectionChange(["ai-hunk-v1-workspace"]);
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Apply selected changes",
      }),
    );
    applicationSignal = applySelectionSuggestion.firstCall.args[0].signal;
    expect(applicationSignal.aborted).to.equal(false);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Review selection",
      }),
    );
    expect(applicationSignal.aborted).to.equal(true);
    expect(destroy.calledOnce).to.equal(true);
    expect(screen.queryByLabelText("Suggestion preview")).not.to.exist;
    await waitFor(() => expect(streamRequest.callCount).to.equal(2));
    expect(screen.getByText("Streaming")).to.exist;

    await act(async () => {
      application.resolve({
        status: "applied",
      });
      await application.promise;
    });
    expect(screen.queryByText("Applied")).not.to.exist;
    rendered.unmount();
    replacementStream.resolve();
  });
  it("destroys the active preview before switching to another suggestion", async function () {
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
    const firstDestroy = sinon.stub();
    const secondDestroy = sinon.stub();
    const mountSuggestionPreview = sinon.stub();
    mountSuggestionPreview.onFirstCall().callsFake(async (options) => {
      options.onSelectionChange([]);
      return {
        hunkIds: Object.freeze(["ai-hunk-v1-first"]),
        destroy: firstDestroy,
      };
    });
    mountSuggestionPreview.onSecondCall().callsFake(async (options) => {
      options.onSelectionChange([]);
      return {
        hunkIds: Object.freeze(["ai-hunk-v1-second"]),
        destroy: secondDestroy,
      };
    });
    renderPanel({
      captureSelectionSession: async () => ({
        status: "ready",
        session,
      }),
      streamRequest,
      getSelectionContext: sinon.stub(),
      mountSuggestionPreview,
      applySelectionSuggestion: sinon.stub(),
    });
    await clickSelectionAction(
      "Rewrite selection",
      "Rewrite the selected phrase.",
    );
    await screen.findByText("Completed");

    fireEvent.click(
      screen.getByRole("button", {
        name: "Preview suggestion 1",
      }),
    );
    await waitFor(() => expect(mountSuggestionPreview.callCount).to.equal(1));
    await screen.findByText("Suggestion preview ready");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Preview suggestion 2",
      }),
    );
    expect(firstDestroy.calledOnce).to.equal(true);
    await waitFor(() => expect(mountSuggestionPreview.callCount).to.equal(2));
    expect(mountSuggestionPreview.secondCall.args[0].suggestion).to.equal(
      secondSuggestion,
    );
    expect(secondDestroy.called).to.equal(false);
  });
  it("keeps project-scope suggestions read-only without a selection session", async function () {
    const request = {
      requestId: "request-project-0001",
      projectId,
      action: "review",
      instruction: "Review the synthetic project.",
      skill: "referee-review",
      scope: {
        kind: "project",
      },
    };
    const streamRequest = sinon.stub().callsFake(async (call) => {
      call.onEvent(startedEvent(request));
      call.onEvent({
        ...eventBase(request.requestId, 1, "suggestion"),
        type: "suggestion",
        suggestion: {
          ...suggestion({
            ...request,
            scope: {
              kind: "selection",
            },
          }),
          requestId: request.requestId,
        },
      });
      call.onEvent({
        ...eventBase(request.requestId, 2, "completed"),
        type: "completed",
        finishReason: "stop",
      });
    });
    renderPanel({
      createRequestId: () => request.requestId,
      streamRequest,
      getSelectionContext: sinon.stub(),
      mountSuggestionPreview: sinon.stub(),
    });
    fireEvent.change(screen.getByLabelText("Review instruction"), {
      target: {
        value: request.instruction,
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Run review" }));
    await screen.findByText("Completed");
    expect(screen.getByText("Replacement: clear")).to.exist;
    expect(
      screen.queryByRole("button", {
        name: "Preview suggestion 1",
      }),
    ).not.to.exist;
  });
  it("offers a preview for a prototype-shaped suggestion ID with no decision", async function () {
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
    const mountSuggestionPreview = sinon.stub().callsFake(async (options) => {
      options.onSelectionChange([]);
      return {
        hunkIds: Object.freeze(["ai-hunk-v1-prototype"]),
        destroy: sinon.stub(),
      };
    });
    renderPanel({
      captureSelectionSession: async () => ({
        status: "ready",
        session,
      }),
      streamRequest,
      getSelectionContext: sinon.stub(),
      mountSuggestionPreview,
    });
    await clickSelectionAction(
      "Rewrite selection",
      "Rewrite the selected phrase.",
    );
    await screen.findByText("Completed");

    fireEvent.click(
      screen.getByRole("button", {
        name: "Preview suggestion 1",
      }),
    );
    await screen.findByText("Suggestion preview ready");
    expect(mountSuggestionPreview.firstCall.args[0].suggestion).to.equal(
      prototypeSuggestion,
    );
  });
  it("stores decisions for prototype-shaped suggestion IDs as own entries", function () {
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
        suggestionDecisions: {},
      };
      const decided = reduceSelectionWorkspaceState(state, {
        type: "suggestion-decision",
        generation: 7,
        requestId: session.request.requestId,
        suggestionId,
        decision: {
          status: "rejected",
        },
      });

      expect(decided).not.to.equal(state);
      expect(
        Object.prototype.hasOwnProperty.call(
          decided.suggestionDecisions,
          suggestionId,
        ),
      ).to.equal(true);
      expect(decided.suggestionDecisions[suggestionId]).to.deep.equal({
        status: "rejected",
      });
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
  it("does not revive a stale preview closure across a same-identity generation", async function () {
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
    const mountSuggestionPreview = sinon.stub().callsFake(async (options) => {
      options.onSelectionChange([]);
      return {
        hunkIds: Object.freeze(["ai-hunk-v1-generation"]),
        destroy: sinon.stub(),
      };
    });
    renderPanel({
      captureSelectionSession,
      streamRequest,
      createRequestId: () => session.request.requestId,
      getSelectionContext: sinon.stub(),
      mountSuggestionPreview,
    });
    await clickSelectionAction(
      "Rewrite selection",
      "Rewrite the selected phrase.",
    );
    await screen.findByText("Completed");
    const replacementRunButton = screen.getByRole("button", {
      name: "Rewrite selection",
    });
    const stalePreviewButton = screen.getByRole("button", {
      name: "Preview suggestion 1",
    });

    await act(async () => {
      replacementRunButton.click();
      stalePreviewButton.click();
    });
    await waitFor(() => expect(streamRequest.callCount).to.equal(2));
    await screen.findByText("Completed");

    expect(captureSelectionSession.callCount).to.equal(2);
    expect(mountSuggestionPreview.called).to.equal(false);
    expect(screen.queryByLabelText("Suggestion preview")).not.to.exist;
    expect(
      screen.getByRole("button", {
        name: "Preview suggestion 1",
      }),
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
    await clickSelectionAction("Review selection", "Instruction A.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await screen.findByText("Cancelled");
    await clickSelectionAction("Rewrite selection", "Instruction B.");
    await act(async () => {
      captureA.resolve({
        status: "ready",
        session: selectionSession({
          action: "review",
          instruction: "Instruction A.",
        }),
      });
      await Promise.resolve();
    });
    expect(streamRequest.called).to.equal(false);
    expect(screen.getByText("Capturing selection")).to.exist;
    const sessionB = selectionSession({
      action: "rewrite",
      instruction: "Instruction B.",
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
      instruction: "Instruction A.",
    });
    const sessionB = selectionSession({
      action: "rewrite",
      instruction: "Instruction B.",
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
    await clickSelectionAction("Review selection", "Instruction A.");
    await waitFor(() => expect(streamCalls).to.have.length(1));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(streamCalls[0].signal.aborted).to.equal(true);
    await clickSelectionAction("Rewrite selection", "Instruction B.");
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
    expect(screen.getByRole("button", { name: "Cancel" })).to.exist;
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
