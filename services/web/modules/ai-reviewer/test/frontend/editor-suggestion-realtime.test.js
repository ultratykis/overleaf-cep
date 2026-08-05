const { history, undo } = require("@codemirror/commands");
const { EditorState, Transaction } = require("@codemirror/state");
const { EditorView } = require("@codemirror/view");
const { expect } = require("chai");
const { TextOperation } = require("overleaf-editor-core");
const sinon = require("sinon");

require("../../../../test/frontend/cut-log-noise");

const {
  historyOT,
} = require("../../../../frontend/js/features/source-editor/extensions/history-ot");
const {
  realtime,
} = require("../../../../frontend/js/features/source-editor/extensions/realtime");
const {
  extension: documentIdentityExtension,
} = require("../../frontend/js/extensions/document-identity");
const {
  applySelectedSingleDocumentSuggestion,
  applySingleDocumentSuggestion,
} = require("../../frontend/js/services/editor-suggestion-application");
const {
  applySelectedEditorSelectionSuggestion,
} = require("../../frontend/js/services/editor-suggestion-host-application");
const {
  mountDetachedSuggestionDiff,
} = require("../../frontend/js/services/detached-suggestion-diff");
const {
  createStatefulHistoryDocument,
  createStatefulLegacyDocument,
} = require("./helpers/stateful-share-doc");

const baseText = "Alpha beta gamma.";
const baseTextHash =
  "aea23d46109af9b94c5f15085d69113cc2cefa85f05748897a4df172a1ee5104";
const multiHunkText =
  "start\nalpha old omega\nkeep-1\nkeep-2\nkeep-3\nkeep-4\nkeep-5\nalpha old omega\nend\n";
const multiHunkReplacement =
  "start\nalpha new omega\nkeep-1\nkeep-2\nkeep-3\nkeep-4\nkeep-5\nalpha new omega\nend\n";
const multiHunkTextHash =
  "2721accff51c75e12bd5d25ee69139908f6e4eec6c1a251399a9bfa0ca8e7a3f";

function request() {
  return {
    requestId: "request-realtime-0001",
    projectId: "project-0001",
    action: "rewrite",
    instruction: "Rewrite the selected phrase.",
    skill: "line-edit",
    scope: {
      kind: "selection",
      documentId: "document-0001",
      path: "main.tex",
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

function suggestion() {
  return {
    id: "suggestion-realtime-0001",
    requestId: "request-realtime-0001",
    projectId: "project-0001",
    documentId: "document-0001",
    path: "main.tex",
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
        path: "main.tex",
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
    skill: "line-edit",
    createdAt: "2026-07-24T00:00:00.000Z",
    status: "proposed",
  };
}

function multiHunkRequest() {
  return {
    requestId: "request-realtime-multi-hunk-0001",
    projectId: "project-0001",
    action: "rewrite",
    instruction: "Rewrite two separated synthetic phrases.",
    skill: "line-edit",
    scope: {
      kind: "selection",
      documentId: "document-0001",
      path: "main.tex",
      baseRevision: 11,
      baseTextHash: multiHunkTextHash,
      range: {
        from: 0,
        to: multiHunkText.length,
      },
      text: multiHunkText,
    },
  };
}

function multiHunkSuggestion() {
  return {
    id: "suggestion-realtime-multi-hunk-0001",
    requestId: "request-realtime-multi-hunk-0001",
    projectId: "project-0001",
    documentId: "document-0001",
    path: "main.tex",
    baseRevision: 11,
    baseTextHash: multiHunkTextHash,
    range: {
      from: 0,
      to: multiHunkText.length,
    },
    original: multiHunkText,
    replacement: multiHunkReplacement,
    rationale: "Exercise selected separated hunks.",
    evidence: [
      {
        path: "main.tex",
        range: {
          from: 0,
          to: multiHunkText.length,
        },
        revision: 11,
        textHash: multiHunkTextHash,
      },
    ],
    provider: "fake",
    model: "deterministic-v1",
    skill: "line-edit",
    createdAt: "2026-07-24T00:00:00.000Z",
    status: "proposed",
  };
}

function editorContext({
  currentDocument,
  realtimeText,
  trackChanges,
  revision = 7,
}) {
  return {
    projectId: "project-0001",
    documentId: "document-0001",
    path: "main.tex",
    revision,
    currentDocument,
    shareDocument: currentDocument.doc,
    realtimeText,
    sourceMode: true,
    connected: true,
    joined: true,
    documentConnectionState: "ok",
    hasBufferedOps: false,
    canWrite: true,
    trackChanges,
    wantTrackChanges: trackChanges,
    realtimeTrackChanges: trackChanges,
  };
}

async function selectedHunkIds() {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const mounted = await mountDetachedSuggestionDiff({
    parent,
    request: multiHunkRequest(),
    suggestion: multiHunkSuggestion(),
  });
  const hunkIds = [...mounted.hunkIds];
  mounted.destroy();
  parent.remove();
  expect(hunkIds).to.have.length(2);
  return hunkIds;
}

function waitForRealtimeCheck() {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}

describe("AI reviewer: OT safety production realtime", function () {
  let view;

  afterEach(function () {
    sinon.restore();
    view?.destroy();
  });

  it("routes an accepted legacy edit and Undo through the realtime adapter", async function () {
    const { currentDocument, shareDoc, documentErrors, isAttachedToCM6 } =
      createStatefulLegacyDocument({
        documentId: "document-0001",
        text: baseText,
      });
    const errors = [];
    const documentTransactions = [];
    let aiTransactionCount = 0;

    view = new EditorView({
      state: EditorState.create({
        doc: baseText,
        extensions: [
          history(),
          realtime({ currentDoc: currentDocument }, (error) => {
            errors.push(error);
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
    expect(isAttachedToCM6()).to.equal(true);
    expect(shareDoc.listenerCount("insert")).to.equal(1);
    expect(shareDoc.listenerCount("delete")).to.equal(1);

    const result = await applySingleDocumentSuggestion({
      view,
      request: request(),
      suggestion: suggestion(),
      binding: {
        currentDocument,
        shareDocument: currentDocument.doc,
        trackChanges: false,
      },
      getContext: () =>
        editorContext({
          currentDocument,
          realtimeText: shareDoc.getText(),
          trackChanges: false,
        }),
    });

    expect(result).to.deep.equal({
      status: "applied",
    });
    expect(view.state.doc.toString()).to.equal("Alpha clear gamma.");
    expect(shareDoc.getText()).to.equal("Alpha clear gamma.");
    expect(aiTransactionCount).to.equal(1);
    expect(documentTransactions).to.have.length(1);
    expect(documentTransactions[0].annotation(Transaction.remote)).to.not.equal(
      true,
    );
    expect(shareDoc.localOperations).to.deep.equal([
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
    expect(view.state.doc.toString()).to.equal(baseText);
    expect(shareDoc.getText()).to.equal(baseText);
    expect(documentTransactions).to.have.length(2);
    expect(documentTransactions[1].annotation(Transaction.userEvent)).to.equal(
      "undo",
    );
    expect(documentTransactions[1].annotation(Transaction.remote)).to.not.equal(
      true,
    );
    expect(shareDoc.localOperations.slice(2)).to.deep.equal([
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
    expect(errors).to.deep.equal([]);
    expect(shareDoc.errors).to.deep.equal([]);
    expect(documentErrors).to.deep.equal([]);

    view.destroy();
    view = undefined;
    expect(isAttachedToCM6()).to.equal(false);
    expect(shareDoc.listenerCount("insert")).to.equal(0);
    expect(shareDoc.listenerCount("delete")).to.equal(0);
    expect(shareDoc.detach_cm6).to.equal(undefined);
  });

  it("routes one selected separated hunk and Undo through the realtime adapter", async function () {
    const { currentDocument, shareDoc, documentErrors } =
      createStatefulLegacyDocument({
        documentId: "document-0001",
        text: multiHunkText,
        revision: 11,
      });
    const errors = [];
    const documentTransactions = [];
    let aiTransactionCount = 0;

    view = new EditorView({
      state: EditorState.create({
        doc: multiHunkText,
        extensions: [
          history(),
          realtime({ currentDoc: currentDocument }, (error) => {
            errors.push(error);
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
    const hunkIds = await selectedHunkIds();

    const requestAtCapture = multiHunkRequest();
    const result = await applySelectedEditorSelectionSuggestion({
      session: {
        request: requestAtCapture,
        binding: {
          currentDocument,
          shareDocument: currentDocument.doc,
          trackChanges: false,
        },
      },
      suggestion: multiHunkSuggestion(),
      selectedHunkIds: [hunkIds[0]],
      getContext: () => ({
        view,
        projectId: "project-0001",
        currentDocumentId: "document-0001",
        path: "main.tex",
        currentDocument,
        sourceMode: true,
        connected: true,
        permissions: {
          read: true,
          write: true,
          trackedWrite: true,
        },
        trackChanges: false,
        wantTrackChanges: false,
      }),
      signal: new AbortController().signal,
    });

    const expectedText = multiHunkText.replace("old", "new");
    const firstOld = multiHunkText.indexOf("old");
    expect(result).to.deep.equal({
      status: "applied",
    });
    expect(view.state.doc.toString()).to.equal(expectedText);
    expect(shareDoc.getText()).to.equal(expectedText);
    expect(aiTransactionCount).to.equal(1);
    expect(documentTransactions).to.have.length(1);
    expect(shareDoc.localOperations).to.deep.equal([
      {
        type: "delete",
        position: firstOld,
        length: 3,
        fromUndo: false,
      },
      {
        type: "insert",
        position: firstOld,
        text: "new",
        fromUndo: false,
      },
    ]);

    expect(undo(view)).to.equal(true);
    expect(view.state.doc.toString()).to.equal(multiHunkText);
    expect(shareDoc.getText()).to.equal(multiHunkText);
    expect(documentTransactions).to.have.length(2);

    await waitForRealtimeCheck();
    expect(errors).to.deep.equal([]);
    expect(shareDoc.errors).to.deep.equal([]);
    expect(documentErrors).to.deep.equal([]);
  });

  it("rejects a selected suggestion when a remote edit lands during compilation", async function () {
    const { currentDocument, shareDoc, documentErrors } =
      createStatefulLegacyDocument({
        documentId: "document-0001",
        text: multiHunkText,
      });
    const errors = [];
    const documentTransactions = [];
    let aiTransactionCount = 0;

    view = new EditorView({
      state: EditorState.create({
        doc: multiHunkText,
        extensions: [
          history(),
          realtime({ currentDoc: currentDocument }, (error) => {
            errors.push(error);
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
    const hunkIds = await selectedHunkIds();
    const originalDigest = globalThis.crypto.subtle.digest.bind(
      globalThis.crypto.subtle,
    );
    let resolveCompile = () => {};
    const compilePending = new Promise((resolve) => {
      resolveCompile = resolve;
    });
    let signalCompileStarted = () => {};
    const compileStarted = new Promise((resolve) => {
      signalCompileStarted = resolve;
    });
    let digestCalls = 0;
    sinon
      .stub(globalThis.crypto.subtle, "digest")
      .callsFake(async (algorithm, data) => {
        digestCalls += 1;
        if (digestCalls === 1) {
          signalCompileStarted();
          await compilePending;
        }
        return originalDigest(algorithm, data);
      });
    let hashCalls = 0;

    const application = applySelectedSingleDocumentSuggestion({
      view,
      request: multiHunkRequest(),
      suggestion: multiHunkSuggestion(),
      selectedHunkIds: hunkIds,
      binding: {
        currentDocument,
        shareDocument: currentDocument.doc,
        trackChanges: false,
      },
      getContext: () =>
        editorContext({
          currentDocument,
          realtimeText: shareDoc.getText(),
          trackChanges: false,
          revision: 11,
        }),
      hashText: async () => {
        hashCalls += 1;
        return multiHunkTextHash;
      },
    });
    await compileStarted;
    shareDoc.remoteInsert(0, "Remote ");
    resolveCompile();

    expect(await application).to.deep.equal({
      status: "conflict",
      code: "AI_EDITOR_CHANGED_DURING_PREFLIGHT",
    });
    expect(view.state.doc.toString()).to.equal(`Remote ${multiHunkText}`);
    expect(shareDoc.getText()).to.equal(`Remote ${multiHunkText}`);
    expect(hashCalls).to.equal(0);
    expect(aiTransactionCount).to.equal(0);
    expect(documentTransactions).to.have.length(1);
    expect(documentTransactions[0].annotation(Transaction.remote)).to.equal(
      true,
    );
    expect(shareDoc.localOperations).to.deep.equal([]);
    expect(undo(view)).to.equal(false);

    await waitForRealtimeCheck();
    expect(errors).to.deep.equal([]);
    expect(shareDoc.errors).to.deep.equal([]);
    expect(documentErrors).to.deep.equal([]);
  });

  it("keeps a remote legacy edit out of Undo and rejects the stale suggestion", async function () {
    const { currentDocument, shareDoc, documentErrors } =
      createStatefulLegacyDocument({
        documentId: "document-0001",
        text: baseText,
      });
    const errors = [];
    const documentTransactions = [];
    const remoteListenerSnapshots = [];
    let aiTransactionCount = 0;
    shareDoc.on("insert", () => {
      remoteListenerSnapshots.push(shareDoc.getText());
    });

    view = new EditorView({
      state: EditorState.create({
        doc: baseText,
        extensions: [
          history(),
          realtime({ currentDoc: currentDocument }, (error) => {
            errors.push(error);
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

    shareDoc.remoteInsert(0, "Remote ");

    expect(view.state.doc.toString()).to.equal(`Remote ${baseText}`);
    expect(shareDoc.getText()).to.equal(`Remote ${baseText}`);
    expect(remoteListenerSnapshots).to.deep.equal([`Remote ${baseText}`]);
    expect(documentTransactions).to.have.length(1);
    expect(documentTransactions[0].annotation(Transaction.remote)).to.equal(
      true,
    );
    expect(shareDoc.localOperations).to.deep.equal([]);
    expect(undo(view)).to.equal(false);

    const result = await applySingleDocumentSuggestion({
      view,
      request: request(),
      suggestion: suggestion(),
      binding: {
        currentDocument,
        shareDocument: currentDocument.doc,
        trackChanges: false,
      },
      getContext: () =>
        editorContext({
          currentDocument,
          realtimeText: shareDoc.getText(),
          trackChanges: false,
        }),
    });

    expect(result).to.deep.equal({
      status: "conflict",
      code: "AI_SUGGESTION_HASH_STALE",
    });
    expect(view.state.doc.toString()).to.equal(`Remote ${baseText}`);
    expect(shareDoc.getText()).to.equal(`Remote ${baseText}`);
    expect(aiTransactionCount).to.equal(0);
    expect(documentTransactions).to.have.length(1);
    expect(shareDoc.localOperations).to.deep.equal([]);

    await waitForRealtimeCheck();
    expect(errors).to.deep.equal([]);
    expect(shareDoc.errors).to.deep.equal([]);
    expect(documentErrors).to.deep.equal([]);
  });

  it("routes track-changes acceptance and Undo through history OT", async function () {
    const { currentDocument, shareDoc, documentErrors, isAttachedToCM6 } =
      createStatefulHistoryDocument({
        documentId: "document-0001",
        text: baseText,
      });
    const errors = [];
    const documentTransactions = [];
    let aiTransactionCount = 0;

    view = new EditorView({
      state: EditorState.create({
        doc: baseText,
        extensions: [
          history(),
          realtime({ currentDoc: currentDocument }, (error) => {
            errors.push(error);
          }),
          historyOT(currentDocument),
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
    expect(isAttachedToCM6()).to.equal(true);
    expect(shareDoc.listenerCount("remoteop")).to.equal(1);
    currentDocument.setTrackChangesUserId("user-0001");
    const beforeAcceptanceSnapshot = shareDoc.snapshot;

    const result = await applySingleDocumentSuggestion({
      view,
      request: request(),
      suggestion: suggestion(),
      binding: {
        currentDocument,
        shareDocument: currentDocument.doc,
        trackChanges: true,
      },
      getContext: () =>
        editorContext({
          currentDocument,
          realtimeText: shareDoc.getText(),
          trackChanges: true,
        }),
    });

    expect(result).to.deep.equal({
      status: "applied",
    });
    expect(view.state.doc.toString()).to.equal("Alpha clear gamma.");
    expect(shareDoc.getText()).to.equal("Alpha clear gamma.");
    expect(shareDoc.snapshot).to.not.equal(beforeAcceptanceSnapshot);
    const acceptedSnapshot = shareDoc.snapshot;
    expect(aiTransactionCount).to.equal(1);
    expect(documentTransactions).to.have.length(1);
    expect(documentTransactions[0].annotation(Transaction.remote)).to.not.equal(
      true,
    );
    expect(shareDoc.submittedOperations).to.have.length(1);
    expect(shareDoc.submittedOperations[0]).to.have.length(1);
    expect(
      shareDoc.submittedOperations[0][0].ops
        .map((operation) => operation.tracking)
        .filter((tracking) => tracking != null)
        .map((tracking) => ({
          type: tracking?.type,
          userId: tracking?.userId,
        })),
    ).to.deep.equal([
      {
        type: "insert",
        userId: "user-0001",
      },
      {
        type: "delete",
        userId: "user-0001",
      },
    ]);

    expect(undo(view)).to.equal(true);
    expect(view.state.doc.toString()).to.equal(baseText);
    expect(shareDoc.getText()).to.equal(baseText);
    expect(shareDoc.snapshot).to.not.equal(acceptedSnapshot);
    expect(documentTransactions).to.have.length(2);
    expect(documentTransactions[1].annotation(Transaction.userEvent)).to.equal(
      "undo",
    );
    expect(shareDoc.submittedOperations).to.have.length(2);

    await waitForRealtimeCheck();
    expect(errors).to.deep.equal([]);
    expect(shareDoc.errors).to.deep.equal([]);
    expect(documentErrors).to.deep.equal([]);

    view.destroy();
    view = undefined;
    expect(isAttachedToCM6()).to.equal(false);
    expect(shareDoc.listenerCount("remoteop")).to.equal(0);
    expect(shareDoc.detach_cm6).to.equal(undefined);
  });

  it("routes reversed selected hunks as one tracked history-OT transaction", async function () {
    const { currentDocument, shareDoc, documentErrors } =
      createStatefulHistoryDocument({
        documentId: "document-0001",
        text: multiHunkText,
      });
    const errors = [];
    const documentTransactions = [];
    let aiTransactionCount = 0;

    view = new EditorView({
      state: EditorState.create({
        doc: multiHunkText,
        extensions: [
          history(),
          realtime({ currentDoc: currentDocument }, (error) => {
            errors.push(error);
          }),
          historyOT(currentDocument),
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
    currentDocument.setTrackChangesUserId("user-0001");
    const hunkIds = await selectedHunkIds();

    const result = await applySelectedSingleDocumentSuggestion({
      view,
      request: multiHunkRequest(),
      suggestion: multiHunkSuggestion(),
      selectedHunkIds: hunkIds.reverse(),
      binding: {
        currentDocument,
        shareDocument: currentDocument.doc,
        trackChanges: true,
      },
      getContext: () =>
        editorContext({
          currentDocument,
          realtimeText: shareDoc.getText(),
          trackChanges: true,
          revision: 11,
        }),
    });

    expect(result).to.deep.equal({
      status: "applied",
    });
    expect(view.state.doc.toString()).to.equal(multiHunkReplacement);
    expect(shareDoc.getText()).to.equal(multiHunkReplacement);
    expect(aiTransactionCount).to.equal(1);
    expect(documentTransactions).to.have.length(1);
    expect(shareDoc.submittedOperations).to.have.length(1);
    expect(shareDoc.submittedOperations[0]).to.have.length(1);
    const trackedOperations = shareDoc.submittedOperations[0][0].ops
      .map((operation) => operation.tracking)
      .filter((tracking) => tracking != null);
    expect(trackedOperations).to.have.length(4);
    expect(
      trackedOperations.map((tracking) => tracking.type).sort(),
    ).to.deep.equal(["delete", "delete", "insert", "insert"]);
    expect(
      trackedOperations.every((tracking) => tracking.userId === "user-0001"),
    ).to.equal(true);

    expect(undo(view)).to.equal(true);
    expect(view.state.doc.toString()).to.equal(multiHunkText);
    expect(shareDoc.getText()).to.equal(multiHunkText);
    expect(documentTransactions).to.have.length(2);
    expect(shareDoc.submittedOperations).to.have.length(2);

    await waitForRealtimeCheck();
    expect(errors).to.deep.equal([]);
    expect(shareDoc.errors).to.deep.equal([]);
    expect(documentErrors).to.deep.equal([]);
  });

  it("routes non-tracking acceptance and Undo through history OT", async function () {
    const { currentDocument, shareDoc, documentErrors } =
      createStatefulHistoryDocument({
        documentId: "document-0001",
        text: baseText,
      });
    const errors = [];
    const documentTransactions = [];

    view = new EditorView({
      state: EditorState.create({
        doc: baseText,
        extensions: [
          history(),
          realtime({ currentDoc: currentDocument }, (error) => {
            errors.push(error);
          }),
          historyOT(currentDocument),
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
          }),
        ],
      }),
    });
    currentDocument.setTrackChangesUserId(null);

    const result = await applySingleDocumentSuggestion({
      view,
      request: request(),
      suggestion: suggestion(),
      binding: {
        currentDocument,
        shareDocument: currentDocument.doc,
        trackChanges: false,
      },
      getContext: () =>
        editorContext({
          currentDocument,
          realtimeText: shareDoc.getText(),
          trackChanges: false,
        }),
    });

    expect(result).to.deep.equal({
      status: "applied",
    });
    expect(view.state.doc.toString()).to.equal("Alpha clear gamma.");
    expect(shareDoc.getText()).to.equal("Alpha clear gamma.");
    expect(documentTransactions).to.have.length(1);
    expect(documentTransactions[0].annotation(Transaction.remote)).to.not.equal(
      true,
    );
    expect(shareDoc.submittedOperations).to.have.length(1);
    expect(
      shareDoc.submittedOperations[0][0].ops
        .map((operation) => operation.tracking)
        .filter((tracking) => tracking != null),
    ).to.deep.equal([]);

    expect(undo(view)).to.equal(true);
    expect(view.state.doc.toString()).to.equal(baseText);
    expect(shareDoc.getText()).to.equal(baseText);
    expect(documentTransactions).to.have.length(2);
    expect(documentTransactions[1].annotation(Transaction.userEvent)).to.equal(
      "undo",
    );
    expect(shareDoc.submittedOperations).to.have.length(2);

    await waitForRealtimeCheck();
    expect(errors).to.deep.equal([]);
    expect(shareDoc.errors).to.deep.equal([]);
    expect(documentErrors).to.deep.equal([]);
  });

  it("keeps a remote history-OT edit out of Undo and rejects the stale suggestion", async function () {
    const { currentDocument, shareDoc, documentErrors } =
      createStatefulHistoryDocument({
        documentId: "document-0001",
        text: baseText,
      });
    const errors = [];
    const documentTransactions = [];
    const remoteListenerSnapshots = [];
    let aiTransactionCount = 0;
    shareDoc.on("remoteop", () => {
      remoteListenerSnapshots.push(shareDoc.getText());
    });

    view = new EditorView({
      state: EditorState.create({
        doc: baseText,
        extensions: [
          history(),
          realtime({ currentDoc: currentDocument }, (error) => {
            errors.push(error);
          }),
          historyOT(currentDocument),
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

    const remoteOperation = new TextOperation()
      .retain(6)
      .remove(4)
      .insert("REMOTE")
      .retain(7);
    const beforeRemoteSnapshot = shareDoc.snapshot;
    shareDoc.applyRemote([remoteOperation]);

    expect(view.state.doc.toString()).to.equal("Alpha REMOTE gamma.");
    expect(shareDoc.getText()).to.equal("Alpha REMOTE gamma.");
    expect(remoteListenerSnapshots).to.deep.equal(["Alpha REMOTE gamma."]);
    expect(shareDoc.snapshot).to.not.equal(beforeRemoteSnapshot);
    expect(documentTransactions).to.have.length(1);
    expect(documentTransactions[0].annotation(Transaction.remote)).to.equal(
      true,
    );
    expect(shareDoc.submittedOperations).to.deep.equal([]);
    expect(undo(view)).to.equal(false);

    const result = await applySingleDocumentSuggestion({
      view,
      request: request(),
      suggestion: suggestion(),
      binding: {
        currentDocument,
        shareDocument: currentDocument.doc,
        trackChanges: false,
      },
      getContext: () =>
        editorContext({
          currentDocument,
          realtimeText: shareDoc.getText(),
          trackChanges: false,
        }),
    });

    expect(result).to.deep.equal({
      status: "conflict",
      code: "AI_SUGGESTION_HASH_STALE",
    });
    expect(view.state.doc.toString()).to.equal("Alpha REMOTE gamma.");
    expect(shareDoc.getText()).to.equal("Alpha REMOTE gamma.");
    expect(documentTransactions).to.have.length(1);
    expect(shareDoc.submittedOperations).to.deep.equal([]);
    expect(aiTransactionCount).to.equal(0);

    await waitForRealtimeCheck();
    expect(errors).to.deep.equal([]);
    expect(shareDoc.errors).to.deep.equal([]);
    expect(documentErrors).to.deep.equal([]);
  });

  it("forwards a production consistency mismatch to raw and document error sinks", async function () {
    const { currentDocument, shareDoc, documentErrors } =
      createStatefulLegacyDocument({
        documentId: "document-0001",
        text: baseText,
      });
    const errors = [];

    view = new EditorView({
      state: EditorState.create({
        doc: baseText,
        extensions: [
          realtime({ currentDoc: currentDocument }, (error) => {
            errors.push(error);
          }),
        ],
      }),
    });
    shareDoc.snapshot = "Deliberately divergent test snapshot.";

    await waitForRealtimeCheck();

    expect(errors).to.deep.equal([]);
    expect(shareDoc.errors).to.deep.equal([
      "Text does not match in CodeMirror 6",
    ]);
    expect(documentErrors).to.deep.equal([
      "Text does not match in CodeMirror 6",
    ]);
  });
});
