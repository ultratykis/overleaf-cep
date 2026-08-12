const { history, undo } = require("@codemirror/commands");
const { EditorState, Transaction } = require("@codemirror/state");
const { EditorView } = require("@codemirror/view");
const { expect } = require("chai");

require("../../../../test/frontend/cut-log-noise");

const {
  realtime,
} = require("../../../../frontend/js/features/source-editor/extensions/realtime");
const {
  extension: documentIdentityExtension,
} = require("../../frontend/js/extensions/document-identity");
const {
  applySelectedEditorSelectionSuggestion,
} = require("../../frontend/js/services/editor-suggestion-host-application");
const {
  DetachedSuggestionDiffError,
  getSuggestionHunkIds,
} = require("../../frontend/js/services/detached-suggestion-diff");
const {
  createStatefulLegacyDocument,
} = require("./helpers/stateful-share-doc");

const request = Object.freeze({
  requestId: "request-apply-0001",
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
    range: Object.freeze({ from: 6, to: 10 }),
    text: "beta",
  }),
});

const suggestion = Object.freeze({
  id: "suggestion-apply-0001",
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
  status: "unresolved",
});

const multiHunkText =
  "start\nalpha very old omega\nkeep-1\nkeep-2\nkeep-3\nkeep-4\nkeep-5\nalpha extremely old omega\nend\n";
const multiHunkReplacement =
  "start\nalpha old omega\nkeep-1\nkeep-2\nkeep-3\nkeep-4\nkeep-5\nalpha old omega\nend\n";
const multiHunkRequest = Object.freeze({
  requestId: "request-apply-all-0001",
  projectId: "project-0001",
  action: "shorten",
  instruction: "Shorten two separated synthetic phrases.",
  skill: "line-edit",
  scope: Object.freeze({
    kind: "selection",
    documentId: "document-0001",
    path: "chapters/main.tex",
    baseRevision: 11,
    baseTextHash:
      "0b6b0b887aaf43e83757b08efc83c1e3ff2d70f00504901b461b41e0d5794a21",
    range: Object.freeze({ from: 0, to: multiHunkText.length }),
    text: multiHunkText,
  }),
});
const multiHunkSuggestion = Object.freeze({
  id: "suggestion-apply-all-0001",
  requestId: multiHunkRequest.requestId,
  projectId: multiHunkRequest.projectId,
  documentId: multiHunkRequest.scope.documentId,
  path: multiHunkRequest.scope.path,
  baseRevision: multiHunkRequest.scope.baseRevision,
  baseTextHash: multiHunkRequest.scope.baseTextHash,
  range: multiHunkRequest.scope.range,
  original: multiHunkText,
  replacement: multiHunkReplacement,
  rationale: "Remove redundant modifiers.",
  evidence: Object.freeze([
    Object.freeze({
      path: multiHunkRequest.scope.path,
      range: multiHunkRequest.scope.range,
      revision: multiHunkRequest.scope.baseRevision,
      textHash: multiHunkRequest.scope.baseTextHash,
    }),
  ]),
  provider: "fake",
  model: "deterministic-v1",
  skill: "line-edit",
  createdAt: "2026-07-24T00:00:00.000Z",
  status: "unresolved",
});

describe("AI reviewer: card suggestion application workspace", function () {
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
            currentDoc: { currentDocument },
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
    const session = Object.freeze({
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
      permissions: { read: true, write: true, trackedWrite: true },
      trackChanges: false,
      wantTrackChanges: false,
    });
    return {
      documentErrors,
      documentTransactions,
      get aiTransactionCount() {
        return aiTransactionCount;
      },
      getContext,
      realtimeErrors,
      session,
      shareDoc,
    };
  }

  function waitForRealtimeCheck() {
    return new Promise((resolve) => window.setTimeout(resolve, 0));
  }

  async function applyAll(live, artifact) {
    const selectedHunkIds = await getSuggestionHunkIds({
      request: live.session.request,
      suggestion: artifact,
    });
    const result = await applySelectedEditorSelectionSuggestion({
      session: live.session,
      suggestion: artifact,
      selectedHunkIds,
      getContext: live.getContext,
      signal: new AbortController().signal,
    });
    return { result, selectedHunkIds };
  }

  it("applies every planned hunk in one guarded transaction and normal Undo", async function () {
    const live = createLiveEditor({
      requestAtCapture: multiHunkRequest,
      text: multiHunkText,
    });

    const { result, selectedHunkIds } = await applyAll(
      live,
      multiHunkSuggestion,
    );

    expect(selectedHunkIds).to.have.length(2);
    expect(Object.isFrozen(selectedHunkIds)).to.equal(true);
    expect(result).to.deep.equal({ status: "applied" });
    expect(view.state.doc.toString()).to.equal(multiHunkReplacement);
    expect(live.shareDoc.getText()).to.equal(multiHunkReplacement);
    expect(live.aiTransactionCount).to.equal(1);
    expect(live.documentTransactions).to.have.length(1);

    expect(undo(view)).to.equal(true);
    expect(view.state.doc.toString()).to.equal(multiHunkText);
    expect(live.shareDoc.getText()).to.equal(multiHunkText);
    await waitForRealtimeCheck();
    expect(live.realtimeErrors).to.deep.equal([]);
    expect(live.shareDoc.errors).to.deep.equal([]);
    expect(live.documentErrors).to.deep.equal([]);
  });

  it("keeps a remote edit and fails closed when the all-hunk plan is stale", async function () {
    const live = createLiveEditor();
    const selectedHunkIds = await getSuggestionHunkIds({
      request,
      suggestion,
    });
    live.shareDoc.remoteInsert(0, "Remote ");

    const result = await applySelectedEditorSelectionSuggestion({
      session: live.session,
      suggestion,
      selectedHunkIds,
      getContext: live.getContext,
      signal: new AbortController().signal,
    });

    expect(result).to.deep.equal({
      status: "conflict",
      code: "AI_SUGGESTION_HASH_STALE",
    });
    expect(view.state.doc.toString()).to.equal("Remote Alpha beta gamma.");
    expect(live.shareDoc.getText()).to.equal("Remote Alpha beta gamma.");
    expect(live.aiTransactionCount).to.equal(0);
    expect(live.shareDoc.localOperations).to.deep.equal([]);
  });

  it("rejects a foreign hunk ID before hashing or dispatch", async function () {
    const live = createLiveEditor();
    let error;
    try {
      await applySelectedEditorSelectionSuggestion({
        session: live.session,
        suggestion,
        selectedHunkIds: ["ai-hunk-v1-foreign"],
        getContext: live.getContext,
        signal: new AbortController().signal,
      });
    } catch (caught) {
      error = caught;
    }

    expect(error)
      .to.be.instanceOf(DetachedSuggestionDiffError)
      .and.have.property("code", "AI_DIFF_HUNK_UNKNOWN");
    expect(view.state.doc.toString()).to.equal("Alpha beta gamma.");
    expect(live.aiTransactionCount).to.equal(0);
    expect(live.shareDoc.localOperations).to.deep.equal([]);
  });
});
