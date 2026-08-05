/* eslint-disable react/prop-types */
const {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} = require("@testing-library/react");
const { history, undo } = require("@codemirror/commands");
const { EditorState, Transaction } = require("@codemirror/state");
const { EditorView } = require("@codemirror/view");
const { expect } = require("chai");
const React = require("react");
const sinon = require("sinon");

require("../../../../test/frontend/cut-log-noise");

const {
  realtime,
} = require("../../../../frontend/js/features/source-editor/extensions/realtime");
const {
  AiReviewerSuggestionPreview,
} = require("../../frontend/js/components/ai-reviewer-suggestion-preview");
const {
  extension: documentIdentityExtension,
} = require("../../frontend/js/extensions/document-identity");
const {
  applySelectedEditorSelectionSuggestion,
} = require("../../frontend/js/services/editor-suggestion-host-application");
const {
  createStatefulLegacyDocument,
} = require("./helpers/stateful-share-doc");

const request = Object.freeze({
  requestId: "request-preview-0001",
  projectId: "project-0001",
  action: "rewrite",
  instruction: "Rewrite the selected phrase.",
  skill: "line-edit",
  scope: Object.freeze({
    kind: "selection",
    documentId: "document-0001",
    path: "chapters/main.tex",
    baseRevision: 7,
    baseTextHash:
      "aea23d46109af9b94c5f15085d69113cc2cefa85f05748897a4df172a1ee5104",
    range: Object.freeze({
      from: 6,
      to: 10,
    }),
    text: "beta",
  }),
});

const session = Object.freeze({
  request,
  binding: Object.freeze({
    currentDocument: Object.freeze({
      doc_id: "document-0001",
    }),
    shareDocument: Object.freeze({}),
    trackChanges: false,
    connectionEpoch: 17,
  }),
});

const suggestion = Object.freeze({
  id: "suggestion-preview-0001",
  requestId: request.requestId,
  projectId: request.projectId,
  documentId: request.scope.documentId,
  path: request.scope.path,
  baseRevision: request.scope.baseRevision,
  baseTextHash: request.scope.baseTextHash,
  range: request.scope.range,
  original: "beta",
  replacement: "clear",
  rationale: "Use a more precise synthetic term.",
  evidence: Object.freeze([
    Object.freeze({
      path: request.scope.path,
      range: request.scope.range,
      revision: request.scope.baseRevision,
      textHash: request.scope.baseTextHash,
    }),
  ]),
  provider: "fake",
  model: "deterministic-v1",
  skill: "line-edit",
  createdAt: "2026-07-24T00:00:00.000Z",
  status: "proposed",
});

const shortenText =
  "start\nalpha very old omega\nkeep-1\nkeep-2\nkeep-3\nkeep-4\nkeep-5\nalpha extremely old omega\nend\n";
const shortenReplacement =
  "start\nalpha old omega\nkeep-1\nkeep-2\nkeep-3\nkeep-4\nkeep-5\nalpha old omega\nend\n";
const shortenTextHash =
  "0b6b0b887aaf43e83757b08efc83c1e3ff2d70f00504901b461b41e0d5794a21";
const shortenRequest = Object.freeze({
  requestId: "request-preview-shorten-0001",
  projectId: "project-0001",
  action: "shorten",
  instruction: "Shorten two separated synthetic phrases.",
  skill: "line-edit",
  scope: Object.freeze({
    kind: "selection",
    documentId: "document-0001",
    path: "chapters/main.tex",
    baseRevision: 11,
    baseTextHash: shortenTextHash,
    range: Object.freeze({
      from: 0,
      to: shortenText.length,
    }),
    text: shortenText,
  }),
});
const shortenSuggestion = Object.freeze({
  id: "suggestion-preview-shorten-0001",
  requestId: shortenRequest.requestId,
  projectId: shortenRequest.projectId,
  documentId: shortenRequest.scope.documentId,
  path: shortenRequest.scope.path,
  baseRevision: shortenRequest.scope.baseRevision,
  baseTextHash: shortenRequest.scope.baseTextHash,
  range: shortenRequest.scope.range,
  original: shortenText,
  replacement: shortenReplacement,
  rationale: "Remove redundant modifiers from two synthetic phrases.",
  evidence: Object.freeze([
    Object.freeze({
      path: shortenRequest.scope.path,
      range: shortenRequest.scope.range,
      revision: shortenRequest.scope.baseRevision,
      textHash: shortenRequest.scope.baseTextHash,
    }),
  ]),
  provider: "fake",
  model: "deterministic-v1",
  skill: "line-edit",
  createdAt: "2026-07-24T00:00:00.000Z",
  status: "proposed",
});

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

function renderPreview({
  hunkIds = ["ai-hunk-v1-a", "ai-hunk-v1-b"],
  mountPreview,
  applySuggestion = sinon.stub().resolves({
    status: "applied",
  }),
  getContext = sinon.stub(),
  onDecision = sinon.stub(),
  registerLease,
} = {}) {
  const destroy = sinon.stub();
  let onSelectionChange;
  const effectiveMount =
    mountPreview ??
    sinon.stub().callsFake(async (options) => {
      onSelectionChange = options.onSelectionChange;
      options.onSelectionChange([]);
      return {
        hunkIds: Object.freeze([...hunkIds]),
        destroy,
      };
    });
  let registeredDispose;
  const unregister = sinon.stub();
  const effectiveRegister =
    registerLease ??
    sinon.stub().callsFake((dispose) => {
      registeredDispose = dispose;
      return unregister;
    });
  const rendered = render(
    React.createElement(AiReviewerSuggestionPreview, {
      session,
      suggestion,
      getContext,
      mountPreview: effectiveMount,
      applySuggestion,
      onDecision,
      registerLease: effectiveRegister,
    }),
  );
  return {
    ...rendered,
    applySuggestion,
    destroy,
    getContext,
    mountPreview: effectiveMount,
    onDecision,
    unregister,
    get registeredDispose() {
      return registeredDispose;
    },
    get onSelectionChange() {
      return (
        onSelectionChange ??
        effectiveMount.firstCall?.args[0]?.onSelectionChange
      );
    },
  };
}

async function waitForReady() {
  await screen.findByText("Suggestion preview ready");
}

describe("AI reviewer: single document suggestion workspace", function () {
  it("mounts a detached preview without applying before explicit hunk acceptance", async function () {
    const destroy = sinon.stub();
    const mountPreview = sinon.stub().resolves({
      hunkIds: Object.freeze(["ai-hunk-v1-preview"]),
      destroy,
    });
    const applySuggestion = sinon.stub().resolves({
      status: "applied",
    });

    render(
      React.createElement(AiReviewerSuggestionPreview, {
        session,
        suggestion,
        getContext: () => {
          throw new Error("Application context must not be read yet.");
        },
        mountPreview,
        applySuggestion,
      }),
    );

    await waitFor(() => expect(mountPreview.calledOnce).to.equal(true));
    expect(mountPreview.firstCall.args[0].request).to.equal(session.request);
    expect(mountPreview.firstCall.args[0].suggestion).to.equal(suggestion);
    expect(
      screen.getByRole("button", {
        name: "Apply selected changes",
      }).disabled,
    ).to.equal(true);
    expect(applySuggestion.called).to.equal(false);
  });

  it("passes one frozen plan-ordered opaque hunk snapshot to one exact application", async function () {
    const application = deferred();
    const applySuggestion = sinon.stub().returns(application.promise);
    const harness = renderPreview({
      applySuggestion,
    });
    await waitForReady();

    const mutableSelection = ["ai-hunk-v1-b", "ai-hunk-v1-a"];
    act(() => {
      harness.onSelectionChange(mutableSelection);
    });
    mutableSelection.splice(0, mutableSelection.length, "ai-hunk-v1-b");

    const applyButton = screen.getByRole("button", {
      name: "Apply selected changes",
    });
    const rejectButton = screen.getByRole("button", {
      name: "Discard suggestion",
    });
    expect(applyButton.disabled).to.equal(false);
    act(() => {
      applyButton.click();
      applyButton.click();
      rejectButton.click();
    });

    expect(applySuggestion.calledOnce).to.equal(true);
    const options = applySuggestion.firstCall.args[0];
    expect(options.session).to.equal(session);
    expect(options.suggestion).to.equal(suggestion);
    expect(options.getContext).to.equal(harness.getContext);
    expect(options.signal.aborted).to.equal(false);
    expect(options.selectedHunkIds).to.deep.equal([
      "ai-hunk-v1-a",
      "ai-hunk-v1-b",
    ]);
    expect(Object.isFrozen(options.selectedHunkIds)).to.equal(true);
    expect(harness.getContext.called).to.equal(false);
    expect(screen.getByText("Applying selected changes")).to.exist;
    expect(harness.onDecision.called).to.equal(false);

    await act(async () => {
      application.resolve({
        status: "applied",
      });
      await application.promise;
    });
    await screen.findByText("Selected changes applied");
    expect(
      harness.onDecision.calledOnceWithExactly({ status: "applied" }),
    ).to.equal(true);
    expect(harness.destroy.calledOnce).to.equal(true);
  });

  it("ignores delayed selection callbacks after application locks its hunk snapshot", async function () {
    const application = deferred();
    const applySuggestion = sinon.stub().returns(application.promise);
    const harness = renderPreview({
      applySuggestion,
    });
    await waitForReady();
    act(() => {
      harness.onSelectionChange(["ai-hunk-v1-a"]);
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Apply selected changes",
      }),
    );
    const signal = applySuggestion.firstCall.args[0].signal;

    act(() => {
      harness.onSelectionChange(["ai-hunk-v1-foreign"]);
    });
    expect(signal.aborted).to.equal(false);
    expect(screen.getByText("Applying selected changes")).to.exist;
    expect(harness.onDecision.called).to.equal(false);

    await act(async () => {
      application.resolve({
        status: "applied",
      });
      await application.promise;
    });
    await screen.findByText("Selected changes applied");
    expect(
      harness.onDecision.calledOnceWithExactly({
        status: "applied",
      }),
    ).to.equal(true);
    expect(harness.destroy.calledOnce).to.equal(true);
  });

  it("rejects without reading editor context or invoking the application", async function () {
    const harness = renderPreview();
    await waitForReady();

    fireEvent.click(
      screen.getByRole("button", {
        name: "Discard suggestion",
      }),
    );
    await screen.findByText("Suggestion discarded");

    expect(harness.applySuggestion.called).to.equal(false);
    expect(harness.getContext.called).to.equal(false);
    expect(
      harness.onDecision.calledOnceWithExactly({
        status: "discarded",
      }),
    ).to.equal(true);
    expect(harness.destroy.calledOnce).to.equal(true);
    act(() => {
      harness.onSelectionChange(["ai-hunk-v1-a"]);
    });
    expect(
      screen.getByRole("button", {
        name: "Apply selected changes",
      }).disabled,
    ).to.equal(true);
  });

  it("destroys a mount that resolves after rejection exactly once", async function () {
    const mounting = deferred();
    const lateDestroy = sinon.stub();
    const mountPreview = sinon.stub().returns(mounting.promise);
    const harness = renderPreview({
      mountPreview,
    });

    await waitFor(() => expect(mountPreview.calledOnce).to.equal(true));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Discard suggestion",
      }),
    );
    await screen.findByText("Suggestion discarded");
    await act(async () => {
      mounting.resolve({
        hunkIds: Object.freeze(["ai-hunk-v1-late"]),
        destroy: lateDestroy,
      });
      await mounting.promise;
    });

    expect(lateDestroy.calledOnce).to.equal(true);
    expect(
      harness.onDecision.calledOnceWithExactly({ status: "discarded" }),
    ).to.equal(true);
  });

  it("destroys a mount that resolves after unmount exactly once", async function () {
    const mounting = deferred();
    const lateDestroy = sinon.stub();
    const mountPreview = sinon.stub().returns(mounting.promise);
    const harness = renderPreview({
      mountPreview,
    });
    await waitFor(() => expect(mountPreview.calledOnce).to.equal(true));

    harness.unmount();
    expect(harness.unregister.calledOnce).to.equal(true);
    await act(async () => {
      mounting.resolve({
        hunkIds: Object.freeze(["ai-hunk-v1-late"]),
        destroy: lateDestroy,
      });
      await mounting.promise;
    });

    expect(lateDestroy.calledOnce).to.equal(true);
    expect(harness.onDecision.called).to.equal(false);
  });

  it("destroys a pending mount resolved after its external lease is disposed", async function () {
    const mounting = deferred();
    const lateDestroy = sinon.stub();
    const mountPreview = sinon.stub().returns(mounting.promise);
    const harness = renderPreview({
      mountPreview,
    });
    await waitFor(() => expect(mountPreview.calledOnce).to.equal(true));

    act(() => {
      harness.registeredDispose(
        new DOMException("Replaced preview", "AbortError"),
      );
    });
    await act(async () => {
      mounting.resolve({
        hunkIds: Object.freeze(["ai-hunk-v1-late"]),
        destroy: lateDestroy,
      });
      await mounting.promise;
    });

    expect(lateDestroy.calledOnce).to.equal(true);
    expect(harness.onDecision.called).to.equal(false);
  });

  for (const invalidSelection of [
    ["ai-hunk-v1-unknown"],
    ["ai-hunk-v1-a", "ai-hunk-v1-a"],
    [42],
  ]) {
    it(`fails closed for invalid selected hunk IDs ${JSON.stringify(
      invalidSelection,
    )}`, async function () {
      const harness = renderPreview();
      await waitForReady();

      act(() => {
        harness.onSelectionChange(invalidSelection);
      });
      await screen.findByText("Suggestion preview error");

      expect(harness.applySuggestion.called).to.equal(false);
      expect(harness.getContext.called).to.equal(false);
      expect(
        harness.onDecision.calledOnceWithExactly({ status: "error" }),
      ).to.equal(true);
      expect(harness.destroy.calledOnce).to.equal(true);
    });
  }

  for (const invalidPlan of [
    ["ai-hunk-v1-a", "ai-hunk-v1-a"],
    [42],
    "ai-hunk-v1-a",
  ]) {
    it(`destroys an invalid preview hunk plan ${JSON.stringify(
      invalidPlan,
    )}`, async function () {
      const destroy = sinon.stub();
      const mountPreview = sinon.stub().callsFake(async (options) => {
        options.onSelectionChange([]);
        return {
          hunkIds: invalidPlan,
          destroy,
        };
      });
      const harness = renderPreview({
        mountPreview,
      });

      await screen.findByText("Suggestion preview error");
      expect(harness.applySuggestion.called).to.equal(false);
      expect(
        harness.onDecision.calledOnceWithExactly({ status: "error" }),
      ).to.equal(true);
      expect(destroy.calledOnce).to.equal(true);
    });
  }

  it("snapshots a pre-resolution selection before the producer can mutate it", async function () {
    const mounting = deferred();
    const selected = ["ai-hunk-v1-a"];
    const mountPreview = sinon.stub().callsFake((options) => {
      options.onSelectionChange(selected);
      return mounting.promise;
    });
    const harness = renderPreview({
      mountPreview,
    });
    selected[0] = "ai-hunk-v1-foreign";

    await act(async () => {
      mounting.resolve({
        hunkIds: Object.freeze(["ai-hunk-v1-a"]),
        destroy: harness.destroy,
      });
      await mounting.promise;
    });
    await waitForReady();
    expect(
      screen.getByRole("button", {
        name: "Apply selected changes",
      }).disabled,
    ).to.equal(false);
  });

  for (const { result, expectedDecision, expectedText } of [
    {
      result: {
        status: "conflict",
        code: "AI_SUGGESTION_HASH_STALE",
      },
      expectedDecision: {
        status: "conflict",
        code: "AI_SUGGESTION_HASH_STALE",
      },
      expectedText: "Suggestion conflict",
    },
    {
      result: {
        status: "cancelled",
      },
      expectedDecision: {
        status: "cancelled",
      },
      expectedText: "Suggestion application cancelled",
    },
    {
      result: {
        status: "empty",
      },
      expectedDecision: {
        status: "error",
      },
      expectedText: "Suggestion preview error",
    },
  ]) {
    it(`maps the ${result.status} application result to one terminal decision`, async function () {
      const harness = renderPreview({
        applySuggestion: sinon.stub().resolves(result),
      });
      await waitForReady();
      act(() => {
        harness.onSelectionChange(["ai-hunk-v1-a"]);
      });
      fireEvent.click(
        screen.getByRole("button", {
          name: "Apply selected changes",
        }),
      );

      await screen.findByText(expectedText);
      expect(
        harness.onDecision.calledOnceWithExactly(expectedDecision),
      ).to.equal(true);
      expect(harness.destroy.calledOnce).to.equal(true);
    });
  }

  it("maps a synchronous application failure to one bounded error", async function () {
    const applySuggestion = sinon.stub().throws(new Error("private detail"));
    const harness = renderPreview({
      applySuggestion,
    });
    await waitForReady();
    act(() => {
      harness.onSelectionChange(["ai-hunk-v1-a"]);
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Apply selected changes",
      }),
    );

    await screen.findByText("Suggestion preview error");
    expect(screen.queryByText("private detail")).not.to.exist;
    expect(
      harness.onDecision.calledOnceWithExactly({ status: "error" }),
    ).to.equal(true);
    expect(harness.destroy.calledOnce).to.equal(true);
  });

  it("maps an asynchronous application failure to one bounded error", async function () {
    const applySuggestion = sinon
      .stub()
      .rejects(new Error("private async detail"));
    const harness = renderPreview({
      applySuggestion,
    });
    await waitForReady();
    act(() => {
      harness.onSelectionChange(["ai-hunk-v1-a"]);
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Apply selected changes",
      }),
    );

    await screen.findByText("Suggestion preview error");
    expect(screen.queryByText("private async detail")).not.to.exist;
    expect(
      harness.onDecision.calledOnceWithExactly({ status: "error" }),
    ).to.equal(true);
    expect(harness.destroy.calledOnce).to.equal(true);
  });

  it("fails before mounting when the parent lifecycle registration throws", async function () {
    const mountPreview = sinon.stub();
    const onDecision = sinon.stub();
    render(
      React.createElement(AiReviewerSuggestionPreview, {
        session,
        suggestion,
        getContext: sinon.stub(),
        mountPreview,
        registerLease: sinon.stub().throws(new Error("private lease detail")),
        onDecision,
      }),
    );

    await screen.findByText("Suggestion preview error");
    expect(mountPreview.called).to.equal(false);
    expect(screen.queryByText("private lease detail")).not.to.exist;
    expect(onDecision.calledOnceWithExactly({ status: "error" })).to.equal(
      true,
    );
  });

  it("maps a rejected preview mount to one bounded error", async function () {
    const onDecision = sinon.stub();
    render(
      React.createElement(AiReviewerSuggestionPreview, {
        session,
        suggestion,
        getContext: sinon.stub(),
        mountPreview: sinon.stub().rejects(new Error("private preview detail")),
        onDecision,
      }),
    );

    await screen.findByText("Suggestion preview error");
    expect(screen.queryByText("private preview detail")).not.to.exist;
    expect(onDecision.calledOnceWithExactly({ status: "error" })).to.equal(
      true,
    );
  });

  it("cancels an in-flight application synchronously and ignores its late result", async function () {
    const application = deferred();
    const applySuggestion = sinon.stub().returns(application.promise);
    const harness = renderPreview({
      applySuggestion,
    });
    await waitForReady();
    act(() => {
      harness.onSelectionChange(["ai-hunk-v1-a"]);
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Apply selected changes",
      }),
    );
    const signal = applySuggestion.firstCall.args[0].signal;

    fireEvent.click(
      screen.getByRole("button", {
        name: "Cancel application",
      }),
    );
    expect(signal.aborted).to.equal(true);
    await screen.findByText("Suggestion application cancelled");
    expect(
      harness.onDecision.calledOnceWithExactly({
        status: "cancelled",
      }),
    ).to.equal(true);
    expect(harness.destroy.calledOnce).to.equal(true);

    await act(async () => {
      application.resolve({
        status: "applied",
      });
      await application.promise;
    });
    expect(harness.onDecision.calledOnce).to.equal(true);
    expect(screen.queryByText("Selected changes applied")).not.to.exist;
  });

  it("aborts application work and destroys the preview through its external lease", async function () {
    const application = deferred();
    const applySuggestion = sinon.stub().returns(application.promise);
    const harness = renderPreview({
      applySuggestion,
    });
    await waitForReady();
    act(() => {
      harness.onSelectionChange(["ai-hunk-v1-a"]);
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Apply selected changes",
      }),
    );
    const signal = applySuggestion.firstCall.args[0].signal;

    act(() => {
      harness.registeredDispose(
        new DOMException("Replaced preview", "AbortError"),
      );
    });
    expect(signal.aborted).to.equal(true);
    expect(harness.destroy.calledOnce).to.equal(true);
    expect(harness.onDecision.called).to.equal(false);

    await act(async () => {
      application.resolve({
        status: "applied",
      });
      await application.promise;
    });
    expect(harness.onDecision.called).to.equal(false);
  });

  it("contains cleanup exceptions while preserving one terminal conflict", async function () {
    const destroy = sinon.stub().throws(new Error("cleanup detail"));
    let onSelectionChange;
    const mountPreview = sinon.stub().callsFake(async (options) => {
      onSelectionChange = options.onSelectionChange;
      options.onSelectionChange([]);
      return {
        hunkIds: Object.freeze(["ai-hunk-v1-a"]),
        destroy,
      };
    });
    const onDecision = sinon.stub();
    render(
      React.createElement(AiReviewerSuggestionPreview, {
        session,
        suggestion,
        getContext: sinon.stub(),
        mountPreview,
        applySuggestion: sinon.stub().resolves({
          status: "conflict",
          code: "AI_EDITOR_OFFLINE",
        }),
        onDecision,
      }),
    );
    await waitForReady();
    act(() => {
      onSelectionChange(["ai-hunk-v1-a"]);
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Apply selected changes",
      }),
    );

    await screen.findByText("Suggestion conflict");
    expect(
      onDecision.calledOnceWithExactly({
        status: "conflict",
        code: "AI_EDITOR_OFFLINE",
      }),
    ).to.equal(true);
    expect(destroy.calledOnce).to.equal(true);
  });
});

describe("AI reviewer: OT safety suggestion workspace", function () {
  let view;

  afterEach(function () {
    view?.destroy();
    view = undefined;
  });

  function createLiveEditor({
    requestAtCapture = request,
    text = "Alpha beta gamma.",
  } = {}) {
    const { currentDocument, shareDoc, documentErrors } =
      createStatefulLegacyDocument({
        documentId: requestAtCapture.scope.documentId,
        text,
        revision: requestAtCapture.scope.baseRevision,
      });
    const realtimeErrors = [];
    const documentTransactions = [];
    let aiTransactionCount = 0;
    view = new EditorView({
      state: EditorState.create({
        doc: text,
        extensions: [
          history(),
          realtime({ currentDoc: currentDocument }, (error) => {
            realtimeErrors.push(error);
          }),
          documentIdentityExtension({
            currentDoc: {
              currentDocument,
            },
          }),
          EditorView.updateListener.of((update) => {
            documentTransactions.push(
              ...update.transactions.filter(
                (transaction) => transaction.docChanged,
              ),
            );
            aiTransactionCount += update.transactions.filter(
              (transaction) =>
                transaction.annotation(Transaction.userEvent) ===
                "input.ai-reviewer.accept",
            ).length;
          }),
        ],
      }),
    });
    const liveSession = Object.freeze({
      request: requestAtCapture,
      binding: Object.freeze({
        currentDocument,
        shareDocument: currentDocument.doc,
        trackChanges: false,
        connectionEpoch: 17,
      }),
    });
    const getContext = () => ({
      view,
      projectId: requestAtCapture.projectId,
      currentDocumentId: requestAtCapture.scope.documentId,
      path: requestAtCapture.scope.path,
      currentDocument,
      sourceMode: true,
      connected: true,
      connectionEpoch: 17,
      permissions: {
        read: true,
        write: true,
        trackedWrite: true,
      },
      trackChanges: false,
      wantTrackChanges: false,
    });
    return {
      currentDocument,
      documentErrors,
      documentTransactions,
      get aiTransactionCount() {
        return aiTransactionCount;
      },
      getContext,
      liveSession,
      realtimeErrors,
      shareDoc,
    };
  }

  function waitForRealtimeCheck() {
    return new Promise((resolve) => {
      window.setTimeout(resolve, 0);
    });
  }

  it("routes a real detached checkbox through guarded realtime application and normal Undo", async function () {
    const live = createLiveEditor();
    const onDecision = sinon.stub();
    const applySuggestion = sinon.spy((options) =>
      applySelectedEditorSelectionSuggestion(options),
    );
    const rendered = render(
      React.createElement(AiReviewerSuggestionPreview, {
        session: live.liveSession,
        suggestion,
        getContext: live.getContext,
        applySuggestion,
        onDecision,
      }),
    );

    const checkbox = await screen.findByRole("checkbox", {
      name: "Select proposed change 1",
    });
    await screen.findByText("Suggestion preview ready");
    const hunkId = checkbox.dataset.aiReviewerHunkId;
    expect(hunkId).to.match(/^ai-hunk-v1-/);
    expect(view.state.doc.toString()).to.equal("Alpha beta gamma.");
    expect(live.shareDoc.getText()).to.equal("Alpha beta gamma.");
    expect(live.shareDoc.localOperations).to.deep.equal([]);

    fireEvent.click(checkbox);
    const applyButton = screen.getByRole("button", {
      name: "Apply selected changes",
    });
    expect(applyButton.disabled).to.equal(false);
    fireEvent.click(applyButton);

    await screen.findByText("Selected changes applied");
    expect(
      onDecision.calledOnceWithExactly({
        status: "applied",
      }),
    ).to.equal(true);
    expect(applySuggestion.calledOnce).to.equal(true);
    expect(applySuggestion.firstCall.args[0].session).to.equal(
      live.liveSession,
    );
    expect(applySuggestion.firstCall.args[0].suggestion).to.equal(suggestion);
    expect(applySuggestion.firstCall.args[0].selectedHunkIds).to.deep.equal([
      hunkId,
    ]);
    expect(view.state.doc.toString()).to.equal("Alpha clear gamma.");
    expect(live.shareDoc.getText()).to.equal("Alpha clear gamma.");
    expect(live.aiTransactionCount).to.equal(1);
    expect(live.documentTransactions).to.have.length(1);
    expect(live.shareDoc.localOperations).to.deep.equal([
      {
        type: "delete",
        position: 6,
        length: 4,
        fromUndo: false,
      },
      {
        type: "insert",
        position: 6,
        text: "clear",
        fromUndo: false,
      },
    ]);

    expect(undo(view)).to.equal(true);
    expect(view.state.doc.toString()).to.equal("Alpha beta gamma.");
    expect(live.shareDoc.getText()).to.equal("Alpha beta gamma.");
    expect(live.shareDoc.localOperations.slice(2)).to.deep.equal([
      {
        type: "delete",
        position: 6,
        length: 5,
        fromUndo: true,
      },
      {
        type: "insert",
        position: 6,
        text: "beta",
        fromUndo: true,
      },
    ]);
    await waitForRealtimeCheck();
    expect(live.realtimeErrors).to.deep.equal([]);
    expect(live.shareDoc.errors).to.deep.equal([]);
    expect(live.documentErrors).to.deep.equal([]);
    rendered.unmount();
  });

  it("routes a completed shorten suggestion through one selected hunk and normal Undo", async function () {
    const live = createLiveEditor({
      requestAtCapture: shortenRequest,
      text: shortenText,
    });
    const onDecision = sinon.stub();
    const applySuggestion = sinon.spy((options) =>
      applySelectedEditorSelectionSuggestion(options),
    );
    const rendered = render(
      React.createElement(AiReviewerSuggestionPreview, {
        session: live.liveSession,
        suggestion: shortenSuggestion,
        getContext: live.getContext,
        applySuggestion,
        onDecision,
      }),
    );

    const checkboxes = await screen.findAllByRole("checkbox", {
      name: /Select proposed change/,
    });
    await screen.findByText("Suggestion preview ready");
    expect(checkboxes).to.have.length(2);
    expect(shortenSuggestion.replacement.length).to.be.lessThan(
      shortenSuggestion.original.length,
    );
    expect(live.liveSession.request).to.equal(shortenRequest);
    expect(live.liveSession.request.action).to.equal("shorten");
    expect(live.liveSession.request.skill).to.equal("line-edit");
    expect(view.state.doc.toString()).to.equal(shortenText);
    expect(live.shareDoc.getText()).to.equal(shortenText);
    expect(live.shareDoc.localOperations).to.deep.equal([]);
    expect(live.documentTransactions).to.deep.equal([]);

    fireEvent.click(checkboxes[0]);
    expect(checkboxes[0].checked).to.equal(true);
    expect(checkboxes[1].checked).to.equal(false);
    expect(view.state.doc.toString()).to.equal(shortenText);
    expect(live.shareDoc.getText()).to.equal(shortenText);
    expect(live.shareDoc.localOperations).to.deep.equal([]);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Apply selected changes",
      }),
    );

    await screen.findByText("Selected changes applied");
    const selectedHunkId = checkboxes[0].dataset.aiReviewerHunkId;
    const expectedText = shortenText.replace("very ", "");
    expect(
      onDecision.calledOnceWithExactly({
        status: "applied",
      }),
    ).to.equal(true);
    expect(applySuggestion.calledOnce).to.equal(true);
    expect(applySuggestion.firstCall.args[0].session).to.equal(
      live.liveSession,
    );
    expect(applySuggestion.firstCall.args[0].suggestion).to.equal(
      shortenSuggestion,
    );
    expect(applySuggestion.firstCall.args[0].selectedHunkIds).to.deep.equal([
      selectedHunkId,
    ]);
    expect(view.state.doc.toString()).to.equal(expectedText);
    expect(live.shareDoc.getText()).to.equal(expectedText);
    expect(live.aiTransactionCount).to.equal(1);
    expect(live.documentTransactions).to.have.length(1);
    expect(live.shareDoc.localOperations).to.deep.equal([
      {
        type: "delete",
        position: shortenText.indexOf("very "),
        length: "very ".length,
        fromUndo: false,
      },
    ]);

    expect(undo(view)).to.equal(true);
    expect(view.state.doc.toString()).to.equal(shortenText);
    expect(live.shareDoc.getText()).to.equal(shortenText);
    expect(live.documentTransactions).to.have.length(2);
    expect(live.shareDoc.localOperations.slice(1)).to.deep.equal([
      {
        type: "insert",
        position: shortenText.indexOf("very "),
        text: "very ",
        fromUndo: true,
      },
    ]);
    await waitForRealtimeCheck();
    expect(live.realtimeErrors).to.deep.equal([]);
    expect(live.shareDoc.errors).to.deep.equal([]);
    expect(live.documentErrors).to.deep.equal([]);
    rendered.unmount();
  });

  it("keeps a remote edit and reports an exact conflict when acceptance becomes stale", async function () {
    const live = createLiveEditor();
    const onDecision = sinon.stub();
    const rendered = render(
      React.createElement(AiReviewerSuggestionPreview, {
        session: live.liveSession,
        suggestion,
        getContext: live.getContext,
        onDecision,
      }),
    );

    const checkbox = await screen.findByRole("checkbox", {
      name: "Select proposed change 1",
    });
    await screen.findByText("Suggestion preview ready");
    fireEvent.click(checkbox);
    live.shareDoc.remoteInsert(0, "Remote ");
    expect(view.state.doc.toString()).to.equal("Remote Alpha beta gamma.");
    expect(live.shareDoc.getText()).to.equal("Remote Alpha beta gamma.");
    expect(live.documentTransactions).to.have.length(1);
    expect(
      live.documentTransactions[0].annotation(Transaction.remote),
    ).to.equal(true);
    expect(live.shareDoc.localOperations).to.deep.equal([]);
    expect(undo(view)).to.equal(false);

    fireEvent.click(
      screen.getByRole("button", {
        name: "Apply selected changes",
      }),
    );
    await screen.findByText("Suggestion conflict");
    expect(
      onDecision.calledOnceWithExactly({
        status: "conflict",
        code: "AI_SUGGESTION_HASH_STALE",
      }),
    ).to.equal(true);
    expect(view.state.doc.toString()).to.equal("Remote Alpha beta gamma.");
    expect(live.shareDoc.getText()).to.equal("Remote Alpha beta gamma.");
    expect(live.aiTransactionCount).to.equal(0);
    expect(live.documentTransactions).to.have.length(1);
    expect(live.shareDoc.localOperations).to.deep.equal([]);
    await waitForRealtimeCheck();
    expect(live.realtimeErrors).to.deep.equal([]);
    expect(live.shareDoc.errors).to.deep.equal([]);
    expect(live.documentErrors).to.deep.equal([]);
    rendered.unmount();
  });
});
