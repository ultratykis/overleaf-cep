import { history, undo } from "@codemirror/commands";
import { Compartment, EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  toggleVisualEffect,
  visual,
} from "@/features/source-editor/extensions/visual/visual";
import { expect } from "chai";
import i18next from "i18next";
import sinon from "sinon";

import "../../../../test/frontend/cut-log-noise";

import {
  aiReviewerDocumentIdentity,
  extension as documentIdentityExtension,
} from "../../frontend/js/extensions/document-identity";
import {
  applySelectedSingleDocumentSuggestion,
  applySingleDocumentSuggestion,
  sha256Text,
} from "../../frontend/js/services/editor-suggestion-application";
import {
  DetachedSuggestionDiffError,
  mountDetachedSuggestionDiff,
} from "../../frontend/js/services/detached-suggestion-diff";

const createdAt = "2026-07-24T00:00:00.000Z";
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
    requestId: "request-0001",
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
    id: "suggestion-0001",
    requestId: "request-0001",
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
    createdAt,
    status: "unresolved",
  };
}

function multiHunkRequest() {
  return {
    requestId: "request-multi-hunk-0001",
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
    id: "suggestion-multi-hunk-0001",
    requestId: "request-multi-hunk-0001",
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
    createdAt,
    status: "unresolved",
  };
}

async function captureError(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject.");
}

type SyntheticDocument = {
  doc_id: string;
  doc: object;
  cm6?: {
    view: EditorView;
  };
};

type MutableContext = {
  projectId: string;
  documentId: string;
  path: string;
  revision: number;
  currentDocument: SyntheticDocument;
  shareDocument: object;
  realtimeText: string;
  sourceMode: boolean;
  connected: boolean;
  joined: boolean;
  documentConnectionState: string;
  hasBufferedOps: boolean;
  canWrite: boolean;
  trackChanges: boolean;
  wantTrackChanges: boolean;
  realtimeTrackChanges: boolean;
};

describe("AI reviewer: single document Editor application", function () {
  let parent: HTMLDivElement;
  let view: EditorView;
  let documentA: SyntheticDocument;
  let context: MutableContext;
  let aiTransactions: Transaction[];
  let documentTransactions: Transaction[];

  beforeEach(function () {
    parent = document.createElement("div");
    document.body.appendChild(parent);
    documentA = {
      doc_id: "document-0001",
      doc: {},
    };
    context = {
      projectId: "project-0001",
      documentId: "document-0001",
      path: "main.tex",
      revision: 7,
      currentDocument: documentA,
      shareDocument: documentA.doc,
      realtimeText: baseText,
      sourceMode: true,
      connected: true,
      joined: true,
      documentConnectionState: "ok",
      hasBufferedOps: false,
      canWrite: true,
      trackChanges: false,
      wantTrackChanges: false,
      realtimeTrackChanges: false,
    };
    aiTransactions = [];
    documentTransactions = [];

    view = new EditorView({
      parent,
      state: EditorState.create({
        doc: baseText,
        extensions: [
          history(),
          EditorState.readOnly.of(false),
          EditorView.editable.of(true),
          documentIdentityExtension({
            currentDoc: {
              currentDocument: documentA,
            },
          }),
          EditorView.updateListener.of((update) => {
            for (const transaction of update.transactions) {
              if (
                transaction.annotation(Transaction.userEvent) ===
                "input.ai-reviewer.accept"
              ) {
                aiTransactions.push(transaction);
              }
            }
            if (update.docChanged) {
              documentTransactions.push(...update.transactions);
              context.realtimeText = update.state.doc.toString();
            }
          }),
        ],
      }),
    });
    documentA.cm6 = {
      view,
    };
  });

  afterEach(function () {
    view.destroy();
    parent.remove();
  });

  it("applies one normal transaction and participates in normal Undo", async function () {
    const result = await applySingleDocumentSuggestion({
      view,
      request: request(),
      suggestion: suggestion(),
      binding: {
        currentDocument: documentA,
        shareDocument: documentA.doc,
        trackChanges: false,
      },
      getContext: () => ({ ...context }),
      hashText: async () => baseTextHash,
    });

    expect(result).to.deep.equal({
      status: "applied",
    });
    expect(view.state.doc.toString()).to.equal("Alpha clear gamma.");
    expect(context.realtimeText).to.equal("Alpha clear gamma.");
    expect(aiTransactions).to.have.length(1);
    expect(documentTransactions).to.have.length(1);
    expect(aiTransactions[0].annotation(Transaction.userEvent)).to.equal(
      "input.ai-reviewer.accept",
    );

    view.dispatch({
      changes: {
        from: 11,
        insert: "!",
      },
      userEvent: "input",
    });
    expect(view.state.doc.toString()).to.equal("Alpha clear! gamma.");

    expect(undo(view)).to.equal(true);
    expect(view.state.doc.toString()).to.equal("Alpha clear gamma.");
    expect(context.realtimeText).to.equal("Alpha clear gamma.");

    expect(undo(view)).to.equal(true);
    expect(view.state.doc.toString()).to.equal(baseText);
    expect(context.realtimeText).to.equal(baseText);
  });

  it("binds the CodeMirror state to the exact document object", function () {
    expect(view.state.facet(aiReviewerDocumentIdentity)).to.deep.equal({
      documentId: "document-0001",
      currentDocument: documentA,
    });
  });

  it("hashes the exact UTF-8 document text with SHA-256", async function () {
    expect(await sha256Text(baseText)).to.equal(baseTextHash);
  });
});

describe("AI reviewer: OT safety Editor application", function () {
  let parent: HTMLDivElement;
  let view: EditorView;
  let documentA: SyntheticDocument;
  let documentB: SyntheticDocument;
  let context: MutableContext;
  let aiTransactionCount: number;
  let editability: Compartment;
  let identityBinding: Compartment;

  beforeEach(function () {
    parent = document.createElement("div");
    document.body.appendChild(parent);
    documentA = {
      doc_id: "document-0001",
      doc: {},
    };
    documentB = {
      doc_id: "document-0001",
      doc: {},
    };
    context = {
      projectId: "project-0001",
      documentId: "document-0001",
      path: "main.tex",
      revision: 7,
      currentDocument: documentA,
      shareDocument: documentA.doc,
      realtimeText: baseText,
      sourceMode: true,
      connected: true,
      joined: true,
      documentConnectionState: "ok",
      hasBufferedOps: false,
      canWrite: true,
      trackChanges: false,
      wantTrackChanges: false,
      realtimeTrackChanges: false,
    };
    aiTransactionCount = 0;
    editability = new Compartment();
    identityBinding = new Compartment();

    view = new EditorView({
      parent,
      state: EditorState.create({
        doc: baseText,
        extensions: [
          history(),
          editability.of([
            EditorState.readOnly.of(false),
            EditorView.editable.of(true),
          ]),
          identityBinding.of(
            documentIdentityExtension({
              currentDoc: {
                currentDocument: documentA,
              },
            }),
          ),
          visual("main.tex", {
            visual: false,
            previewByPath: () => null,
          }),
          EditorView.updateListener.of((update) => {
            for (const transaction of update.transactions) {
              if (
                transaction.annotation(Transaction.userEvent) ===
                "input.ai-reviewer.accept"
              ) {
                aiTransactionCount += 1;
              }
            }
            if (update.docChanged) {
              context.realtimeText = update.state.doc.toString();
            }
          }),
        ],
      }),
    });
    documentA.cm6 = {
      view,
    };
  });

  afterEach(function () {
    view.destroy();
    parent.remove();
  });

  function switchToDocumentB() {
    context.currentDocument = documentB;
    context.shareDocument = documentB.doc;
    documentB.cm6 = {
      view,
    };
    view.dispatch({
      effects: identityBinding.reconfigure(
        documentIdentityExtension({
          currentDoc: {
            currentDocument: documentB,
          },
        }),
      ),
    });
  }

  it("rejects a same-text, same-revision document-object switch", async function () {
    switchToDocumentB();

    const result = await applySingleDocumentSuggestion({
      view,
      request: request(),
      suggestion: suggestion(),
      binding: {
        currentDocument: documentA,
        shareDocument: documentA.doc,
        trackChanges: false,
      },
      getContext: () => ({ ...context }),
      hashText: async () => baseTextHash,
    });

    expect(result).to.deep.equal({
      status: "conflict",
      code: "AI_EDITOR_DOCUMENT_UNBOUND",
    });
    expect(view.state.doc.toString()).to.equal(baseText);
    expect(aiTransactionCount).to.equal(0);
  });

  it("rejects an edit that lands while the current text hash is pending", async function () {
    let resolveHash = (_hash: string) => {};
    const hashPending = new Promise<string>((resolve) => {
      resolveHash = resolve;
    });

    const application = applySingleDocumentSuggestion({
      view,
      request: request(),
      suggestion: suggestion(),
      binding: {
        currentDocument: documentA,
        shareDocument: documentA.doc,
        trackChanges: false,
      },
      getContext: () => ({ ...context }),
      hashText: async () => hashPending,
    });

    view.dispatch({
      changes: {
        from: baseText.length,
        insert: " Local edit.",
      },
      userEvent: "input",
    });
    resolveHash(baseTextHash);

    expect(await application).to.deep.equal({
      status: "conflict",
      code: "AI_EDITOR_CHANGED_DURING_PREFLIGHT",
    });
    expect(view.state.doc.toString()).to.equal("Alpha beta gamma. Local edit.");
    expect(context.realtimeText).to.equal("Alpha beta gamma. Local edit.");
    expect(aiTransactionCount).to.equal(0);
  });

  it("retains the direct application's capture-time binding while hashing", async function () {
    let resolveHash = (_hash: string) => {};
    let signalHashStarted = () => {};
    const hashPending = new Promise<string>((resolve) => {
      resolveHash = resolve;
    });
    const hashStarted = new Promise<void>((resolve) => {
      signalHashStarted = resolve;
    });
    const mutableBinding = {
      currentDocument: documentA,
      shareDocument: documentA.doc,
      trackChanges: false,
    };

    const application = applySingleDocumentSuggestion({
      view,
      request: request(),
      suggestion: suggestion(),
      binding: mutableBinding,
      getContext: () => ({ ...context }),
      hashText: async () => {
        signalHashStarted();
        return hashPending;
      },
    });
    await hashStarted;
    switchToDocumentB();
    mutableBinding.currentDocument = documentB;
    mutableBinding.shareDocument = documentB.doc;
    resolveHash(baseTextHash);

    expect(await application).to.deep.equal({
      status: "conflict",
      code: "AI_EDITOR_DOCUMENT_UNBOUND",
    });
    expect(view.state.doc.toString()).to.equal(baseText);
    expect(aiTransactionCount).to.equal(0);
  });

  const mutableDirectInputCases: Array<
    [
      string,
      (
        mutableRequest: ReturnType<typeof request>,
        mutableSuggestion: ReturnType<typeof suggestion>,
      ) => void,
    ]
  > = [
    [
      "request",
      (mutableRequest) => {
        mutableRequest.scope.path = "other.tex";
      },
    ],
    [
      "suggestion",
      (_mutableRequest, mutableSuggestion) => {
        mutableSuggestion.replacement = "later";
      },
    ],
  ];

  for (const [name, mutate] of mutableDirectInputCases) {
    it(`retains the direct application's capture-time ${name} while hashing`, async function () {
      let resolveHash = (_hash: string) => {};
      let signalHashStarted = () => {};
      const hashPending = new Promise<string>((resolve) => {
        resolveHash = resolve;
      });
      const hashStarted = new Promise<void>((resolve) => {
        signalHashStarted = resolve;
      });
      const mutableRequest = request();
      const mutableSuggestion = suggestion();

      const application = applySingleDocumentSuggestion({
        view,
        request: mutableRequest,
        suggestion: mutableSuggestion,
        binding: {
          currentDocument: documentA,
          shareDocument: documentA.doc,
          trackChanges: false,
        },
        getContext: () => ({ ...context }),
        hashText: async () => {
          signalHashStarted();
          return hashPending;
        },
      });
      await hashStarted;
      mutate(mutableRequest, mutableSuggestion);
      resolveHash(baseTextHash);

      expect(await application).to.deep.equal({
        status: "applied",
      });
      expect(view.state.doc.toString()).to.equal("Alpha clear gamma.");
      expect(aiTransactionCount).to.equal(1);
    });
  }

  const hostileContextCases: Array<[string, () => MutableContext]> = [
    [
      "context membership trap",
      () =>
        new Proxy(
          { ...context },
          {
            has() {
              throw new Error("synthetic has trap");
            },
          },
        ),
    ],
    [
      "context status getter",
      () => {
        const value = { ...context };
        Object.defineProperty(value, "status", {
          get() {
            throw new Error("synthetic status getter");
          },
        });
        return value;
      },
    ],
    [
      "context field getter",
      () => {
        const value = { ...context };
        Object.defineProperty(value, "projectId", {
          get() {
            throw new Error("synthetic project getter");
          },
        });
        return value;
      },
    ],
  ];

  for (const [name, getHostileContext] of hostileContextCases) {
    it(`fails closed on a throwing ${name}`, async function () {
      let hashCalls = 0;

      const result = await applySingleDocumentSuggestion({
        view,
        request: request(),
        suggestion: suggestion(),
        binding: {
          currentDocument: documentA,
          shareDocument: documentA.doc,
          trackChanges: false,
        },
        getContext: getHostileContext,
        hashText: async () => {
          hashCalls += 1;
          return baseTextHash;
        },
      });

      expect(result).to.deep.equal({
        status: "conflict",
        code: "AI_EDITOR_SYNC_PENDING",
      });
      expect(hashCalls).to.equal(0);
      expect(view.state.doc.toString()).to.equal(baseText);
      expect(aiTransactionCount).to.equal(0);
    });
  }

  it("snapshots a conflict result before returning it to the caller", async function () {
    let statusReads = 0;
    let hashCalls = 0;
    const hostileConflict = {
      get status() {
        statusReads += 1;
        if (statusReads === 1) {
          return "conflict";
        }
        throw new Error("synthetic second status read");
      },
      code: "AI_EDITOR_OFFLINE",
    } as unknown as MutableContext;

    const result = await applySingleDocumentSuggestion({
      view,
      request: request(),
      suggestion: suggestion(),
      binding: {
        currentDocument: documentA,
        shareDocument: documentA.doc,
        trackChanges: false,
      },
      getContext: () => hostileConflict,
      hashText: async () => {
        hashCalls += 1;
        return baseTextHash;
      },
    });

    expect(result).to.deep.equal({
      status: "conflict",
      code: "AI_EDITOR_OFFLINE",
    });
    expect(statusReads).to.equal(1);
    expect(hashCalls).to.equal(0);
    expect(view.state.doc.toString()).to.equal(baseText);
    expect(aiTransactionCount).to.equal(0);
  });

  it("rejects a live Visual Editor state even when context claims source mode", async function () {
    view.dispatch({
      effects: toggleVisualEffect.of(true),
    });
    let hashCalls = 0;

    const result = await applySingleDocumentSuggestion({
      view,
      request: request(),
      suggestion: suggestion(),
      binding: {
        currentDocument: documentA,
        shareDocument: documentA.doc,
        trackChanges: false,
      },
      getContext: () => ({ ...context }),
      hashText: async () => {
        hashCalls += 1;
        return baseTextHash;
      },
    });

    expect(result).to.deep.equal({
      status: "conflict",
      code: "AI_EDITOR_SOURCE_MODE_REQUIRED",
    });
    expect(hashCalls).to.equal(0);
    expect(view.state.doc.toString()).to.equal(baseText);
    expect(aiTransactionCount).to.equal(0);
  });

  const asynchronousConflictCases: Array<[string, () => void, string]> = [
    [
      "same-content document-object switch",
      () => {
        switchToDocumentB();
      },
      "AI_EDITOR_DOCUMENT_UNBOUND",
    ],
    [
      "buffered operation",
      () => {
        context.hasBufferedOps = true;
      },
      "AI_EDITOR_SYNC_PENDING",
    ],
    [
      "permission loss",
      () => {
        context.canWrite = false;
      },
      "AI_EDITOR_PERMISSION_DENIED",
    ],
    [
      "completed track-changes mode switch",
      () => {
        context.trackChanges = true;
        context.wantTrackChanges = true;
        context.realtimeTrackChanges = true;
      },
      "AI_EDITOR_TRACK_CHANGES_PENDING",
    ],
    [
      "read-only reconfiguration",
      () => {
        view.dispatch({
          effects: editability.reconfigure([
            EditorState.readOnly.of(true),
            EditorView.editable.of(false),
          ]),
        });
      },
      "AI_EDITOR_READ_ONLY",
    ],
  ];

  for (const [
    name,
    changeWhileHashing,
    expectedCode,
  ] of asynchronousConflictCases) {
    it(`rechecks a ${name} after the asynchronous hash`, async function () {
      let resolveHash = (_hash: string) => {};
      const hashPending = new Promise<string>((resolve) => {
        resolveHash = resolve;
      });

      const application = applySingleDocumentSuggestion({
        view,
        request: request(),
        suggestion: suggestion(),
        binding: {
          currentDocument: documentA,
          shareDocument: documentA.doc,
          trackChanges: false,
        },
        getContext: () => ({ ...context }),
        hashText: async () => hashPending,
      });

      changeWhileHashing();
      resolveHash(baseTextHash);

      expect(await application).to.deep.equal({
        status: "conflict",
        code: expectedCode,
      });
      expect(view.state.doc.toString()).to.equal(baseText);
      expect(aiTransactionCount).to.equal(0);
    });
  }

  const synchronousConflictCases: Array<
    [string, (current: MutableContext) => void, string]
  > = [
    [
      "detached realtime Editor facade",
      (current) => {
        delete current.currentDocument.cm6;
      },
      "AI_EDITOR_DOCUMENT_UNBOUND",
    ],
    [
      "offline connection",
      (current) => {
        current.connected = false;
      },
      "AI_EDITOR_OFFLINE",
    ],
    [
      "unjoined document",
      (current) => {
        current.joined = false;
      },
      "AI_EDITOR_SYNC_PENDING",
    ],
    [
      "pending document connection",
      (current) => {
        current.documentConnectionState = "connecting";
      },
      "AI_EDITOR_SYNC_PENDING",
    ],
    [
      "buffered operation",
      (current) => {
        current.hasBufferedOps = true;
      },
      "AI_EDITOR_SYNC_PENDING",
    ],
    [
      "permission loss",
      (current) => {
        current.canWrite = false;
      },
      "AI_EDITOR_PERMISSION_DENIED",
    ],
    [
      "track-changes transition",
      (current) => {
        current.wantTrackChanges = true;
      },
      "AI_EDITOR_TRACK_CHANGES_PENDING",
    ],
    [
      "realtime divergence",
      (current) => {
        current.realtimeText = "Diverged realtime text.";
      },
      "AI_EDITOR_DIVERGED",
    ],
  ];

  for (const [name, changeContext, expectedCode] of synchronousConflictCases) {
    it(`rejects a ${name} before hashing or dispatch`, async function () {
      let hashCalls = 0;
      changeContext(context);

      const result = await applySingleDocumentSuggestion({
        view,
        request: request(),
        suggestion: suggestion(),
        binding: {
          currentDocument: documentA,
          shareDocument: documentA.doc,
          trackChanges: false,
        },
        getContext: () => ({ ...context }),
        hashText: async () => {
          hashCalls += 1;
          return baseTextHash;
        },
      });

      expect(result).to.deep.equal({
        status: "conflict",
        code: expectedCode,
      });
      expect(hashCalls).to.equal(0);
      expect(view.state.doc.toString()).to.equal(baseText);
      expect(aiTransactionCount).to.equal(0);
    });
  }

  it("rejects a read-only CodeMirror state before hashing or dispatch", async function () {
    view.dispatch({
      effects: editability.reconfigure([
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
      ]),
    });
    let hashCalls = 0;

    const result = await applySingleDocumentSuggestion({
      view,
      request: request(),
      suggestion: suggestion(),
      binding: {
        currentDocument: documentA,
        shareDocument: documentA.doc,
        trackChanges: false,
      },
      getContext: () => ({ ...context }),
      hashText: async () => {
        hashCalls += 1;
        return baseTextHash;
      },
    });

    expect(result).to.deep.equal({
      status: "conflict",
      code: "AI_EDITOR_READ_ONLY",
    });
    expect(hashCalls).to.equal(0);
    expect(view.state.doc.toString()).to.equal(baseText);
    expect(aiTransactionCount).to.equal(0);
  });
});

describe("AI reviewer: single document selected-hunk application", function () {
  let parent: HTMLDivElement;
  let previewParent: HTMLDivElement;
  let view: EditorView;
  let currentDocument: SyntheticDocument;
  let context: MutableContext;
  let aiTransactions: Transaction[];
  let documentTransactions: Transaction[];
  let identityBinding: Compartment;
  let mountedPreview:
    | Awaited<ReturnType<typeof mountDetachedSuggestionDiff>>
    | undefined;

  beforeEach(function () {
    parent = document.createElement("div");
    previewParent = document.createElement("div");
    document.body.append(parent, previewParent);
    currentDocument = {
      doc_id: "document-0001",
      doc: {},
    };
    context = {
      projectId: "project-0001",
      documentId: "document-0001",
      path: "main.tex",
      revision: 11,
      currentDocument,
      shareDocument: currentDocument.doc,
      realtimeText: multiHunkText,
      sourceMode: true,
      connected: true,
      joined: true,
      documentConnectionState: "ok",
      hasBufferedOps: false,
      canWrite: true,
      trackChanges: false,
      wantTrackChanges: false,
      realtimeTrackChanges: false,
    };
    aiTransactions = [];
    documentTransactions = [];
    identityBinding = new Compartment();

    view = new EditorView({
      parent,
      state: EditorState.create({
        doc: multiHunkText,
        extensions: [
          history(),
          EditorState.readOnly.of(false),
          EditorView.editable.of(true),
          identityBinding.of(
            documentIdentityExtension({
              currentDoc: {
                currentDocument,
              },
            }),
          ),
          EditorView.updateListener.of((update) => {
            for (const transaction of update.transactions) {
              if (
                transaction.annotation(Transaction.userEvent) ===
                "input.ai-reviewer.accept"
              ) {
                aiTransactions.push(transaction);
              }
            }
            if (update.docChanged) {
              documentTransactions.push(...update.transactions);
              context.realtimeText = update.state.doc.toString();
            }
          }),
        ],
      }),
    });
    currentDocument.cm6 = {
      view,
    };
  });

  afterEach(function () {
    sinon.restore();
    mountedPreview?.destroy();
    view.destroy();
    previewParent.remove();
    parent.remove();
  });

  async function hunkIds() {
    mountedPreview = await mountDetachedSuggestionDiff({
      parent: previewParent,
      request: multiHunkRequest(),
      suggestion: multiHunkSuggestion(),
      t: i18next.t,
    });
    expect(mountedPreview.hunkIds).to.have.length(2);
    return mountedPreview.hunkIds;
  }

  function applicationOptions(selectedHunkIds: unknown) {
    return {
      view,
      request: multiHunkRequest(),
      suggestion: multiHunkSuggestion(),
      selectedHunkIds,
      binding: {
        currentDocument,
        shareDocument: currentDocument.doc,
        trackChanges: false,
      },
      getContext: () => ({ ...context }),
    };
  }

  it("applies one selected separated hunk in one normal transaction and Undo", async function () {
    const selectedHunkIds = await hunkIds();

    const result = await applySelectedSingleDocumentSuggestion(
      applicationOptions([selectedHunkIds[0]]),
    );

    expect(result).to.deep.equal({
      status: "applied",
    });
    expect(view.state.doc.toString()).to.equal(
      multiHunkText.replace("old", "new"),
    );
    expect(context.realtimeText).to.equal(view.state.doc.toString());
    expect(aiTransactions).to.have.length(1);
    expect(documentTransactions).to.have.length(1);
    expect(undo(view)).to.equal(true);
    expect(view.state.doc.toString()).to.equal(multiHunkText);
    expect(context.realtimeText).to.equal(multiHunkText);
  });

  it("returns an explicit non-mutating result for an empty selection", async function () {
    let hashCalls = 0;

    const result = await applySelectedSingleDocumentSuggestion({
      ...applicationOptions([]),
      hashText: async () => {
        hashCalls += 1;
        return multiHunkTextHash;
      },
    });

    expect(result).to.deep.equal({
      status: "empty",
    });
    expect(hashCalls).to.equal(0);
    expect(view.state.doc.toString()).to.equal(multiHunkText);
    expect(aiTransactions).to.deep.equal([]);
    expect(documentTransactions).to.deep.equal([]);
  });

  it("rejects an unknown selected hunk before hashing or dispatch", async function () {
    let hashCalls = 0;

    const error = await captureError(() =>
      applySelectedSingleDocumentSuggestion({
        ...applicationOptions(["ai-hunk-v1-unknown"]),
        hashText: async () => {
          hashCalls += 1;
          return multiHunkTextHash;
        },
      }),
    );

    expect(error)
      .to.be.instanceOf(DetachedSuggestionDiffError)
      .and.have.property("code", "AI_DIFF_HUNK_UNKNOWN");
    expect(hashCalls).to.equal(0);
    expect(view.state.doc.toString()).to.equal(multiHunkText);
    expect(aiTransactions).to.deep.equal([]);
    expect(documentTransactions).to.deep.equal([]);
  });

  it("maps a live document shorter than the suggestion range to a stale conflict", async function () {
    const selectedHunkIds = await hunkIds();
    view.dispatch({
      changes: {
        from: multiHunkText.length - 4,
        to: multiHunkText.length,
      },
      userEvent: "input",
    });
    const transactionCountBeforeApplication = documentTransactions.length;

    const result = await applySelectedSingleDocumentSuggestion(
      applicationOptions(selectedHunkIds),
    );

    expect(result).to.deep.equal({
      status: "conflict",
      code: "AI_SUGGESTION_ORIGINAL_STALE",
    });
    expect(aiTransactions).to.deep.equal([]);
    expect(documentTransactions).to.have.length(
      transactionCountBeforeApplication,
    );
  });

  it("rejects a local edit that lands during asynchronous hunk compilation", async function () {
    const selectedHunkIds = await hunkIds();
    const originalDigest = globalThis.crypto.subtle.digest.bind(
      globalThis.crypto.subtle,
    );
    let resolveCompile = () => {};
    const compilePending = new Promise<void>((resolve) => {
      resolveCompile = resolve;
    });
    let signalCompileStarted = () => {};
    const compileStarted = new Promise<void>((resolve) => {
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
      ...applicationOptions(selectedHunkIds),
      hashText: async () => {
        hashCalls += 1;
        return multiHunkTextHash;
      },
    });
    await compileStarted;
    view.dispatch({
      changes: {
        from: multiHunkText.length,
        insert: " Local edit.",
      },
      userEvent: "input",
    });
    resolveCompile();

    expect(await application).to.deep.equal({
      status: "conflict",
      code: "AI_EDITOR_CHANGED_DURING_PREFLIGHT",
    });
    expect(view.state.doc.toString()).to.equal(`${multiHunkText} Local edit.`);
    expect(hashCalls).to.equal(0);
    expect(aiTransactions).to.deep.equal([]);
    expect(documentTransactions).to.have.length(1);
  });

  it("rechecks the document binding after asynchronous hunk compilation", async function () {
    const selectedHunkIds = await hunkIds();
    const originalDigest = globalThis.crypto.subtle.digest.bind(
      globalThis.crypto.subtle,
    );
    let resolveCompile = () => {};
    const compilePending = new Promise<void>((resolve) => {
      resolveCompile = resolve;
    });
    let signalCompileStarted = () => {};
    const compileStarted = new Promise<void>((resolve) => {
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
      ...applicationOptions(selectedHunkIds),
      hashText: async () => {
        hashCalls += 1;
        return multiHunkTextHash;
      },
    });
    await compileStarted;
    const replacementDocument = {
      doc_id: "document-0001",
      doc: {},
      cm6: {
        view,
      },
    };
    context.currentDocument = replacementDocument;
    context.shareDocument = replacementDocument.doc;
    view.dispatch({
      effects: identityBinding.reconfigure(
        documentIdentityExtension({
          currentDoc: {
            currentDocument: replacementDocument,
          },
        }),
      ),
    });
    resolveCompile();

    expect(await application).to.deep.equal({
      status: "conflict",
      code: "AI_EDITOR_DOCUMENT_UNBOUND",
    });
    expect(hashCalls).to.equal(0);
    expect(view.state.doc.toString()).to.equal(multiHunkText);
    expect(aiTransactions).to.deep.equal([]);
    expect(documentTransactions).to.deep.equal([]);
  });

  it("retains the exact acceptance binding while hunk compilation is pending", async function () {
    const selectedHunkIds = await hunkIds();
    const mutableBinding = {
      currentDocument,
      shareDocument: currentDocument.doc,
      trackChanges: false,
    };
    const originalDigest = globalThis.crypto.subtle.digest.bind(
      globalThis.crypto.subtle,
    );
    let resolveCompile = () => {};
    const compilePending = new Promise<void>((resolve) => {
      resolveCompile = resolve;
    });
    let signalCompileStarted = () => {};
    const compileStarted = new Promise<void>((resolve) => {
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

    const application = applySelectedSingleDocumentSuggestion({
      ...applicationOptions(selectedHunkIds),
      binding: mutableBinding,
    });
    await compileStarted;
    const replacementDocument = {
      doc_id: "document-0001",
      doc: {},
      cm6: {
        view,
      },
    };
    context.currentDocument = replacementDocument;
    context.shareDocument = replacementDocument.doc;
    mutableBinding.currentDocument = replacementDocument;
    mutableBinding.shareDocument = replacementDocument.doc;
    view.dispatch({
      effects: identityBinding.reconfigure(
        documentIdentityExtension({
          currentDoc: {
            currentDocument: replacementDocument,
          },
        }),
      ),
    });
    resolveCompile();

    expect(await application).to.deep.equal({
      status: "conflict",
      code: "AI_EDITOR_DOCUMENT_UNBOUND",
    });
    expect(view.state.doc.toString()).to.equal(multiHunkText);
    expect(aiTransactions).to.deep.equal([]);
    expect(documentTransactions).to.deep.equal([]);
  });

  it("retains the acceptance track mode while hunk compilation is pending", async function () {
    const selectedHunkIds = await hunkIds();
    const mutableBinding = {
      currentDocument,
      shareDocument: currentDocument.doc,
      trackChanges: false,
    };
    const originalDigest = globalThis.crypto.subtle.digest.bind(
      globalThis.crypto.subtle,
    );
    let resolveCompile = () => {};
    const compilePending = new Promise<void>((resolve) => {
      resolveCompile = resolve;
    });
    let signalCompileStarted = () => {};
    const compileStarted = new Promise<void>((resolve) => {
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
      ...applicationOptions(selectedHunkIds),
      binding: mutableBinding,
      hashText: async () => {
        hashCalls += 1;
        return multiHunkTextHash;
      },
    });
    await compileStarted;
    mutableBinding.trackChanges = true;
    context.trackChanges = true;
    context.wantTrackChanges = true;
    context.realtimeTrackChanges = true;
    resolveCompile();

    expect(await application).to.deep.equal({
      status: "conflict",
      code: "AI_EDITOR_TRACK_CHANGES_PENDING",
    });
    expect(hashCalls).to.equal(0);
    expect(view.state.doc.toString()).to.equal(multiHunkText);
    expect(aiTransactions).to.deep.equal([]);
    expect(documentTransactions).to.deep.equal([]);
  });

  it("binds final preflight to the request and suggestion snapshot from invocation", async function () {
    const selectedHunkIds = await hunkIds();
    const mutableRequest = multiHunkRequest();
    const mutableSuggestion = multiHunkSuggestion();
    const originalDigest = globalThis.crypto.subtle.digest.bind(
      globalThis.crypto.subtle,
    );
    let resolveCompile = () => {};
    const compilePending = new Promise<void>((resolve) => {
      resolveCompile = resolve;
    });
    let signalCompileStarted = () => {};
    const compileStarted = new Promise<void>((resolve) => {
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

    const application = applySelectedSingleDocumentSuggestion({
      ...applicationOptions(selectedHunkIds),
      request: mutableRequest,
      suggestion: mutableSuggestion,
    });
    await compileStarted;
    mutableRequest.scope.baseRevision = 12;
    mutableSuggestion.baseRevision = 12;
    mutableSuggestion.evidence[0].revision = 12;
    context.revision = 12;
    resolveCompile();

    expect(await application).to.deep.equal({
      status: "conflict",
      code: "AI_SUGGESTION_REVISION_STALE",
    });
    expect(view.state.doc.toString()).to.equal(multiHunkText);
    expect(aiTransactions).to.deep.equal([]);
    expect(documentTransactions).to.deep.equal([]);
  });

  it("dispatches synchronously after final preflight before queued Editor work", async function () {
    const selectedHunkIds = await hunkIds();
    let contextReads = 0;

    const result = await applySelectedSingleDocumentSuggestion({
      ...applicationOptions([selectedHunkIds[0]]),
      getContext: () => {
        contextReads += 1;
        const snapshot = {
          ...context,
        };
        if (contextReads === 2) {
          queueMicrotask(() => {
            view.dispatch({
              changes: {
                from: view.state.doc.length,
                insert: " Local after preflight.",
              },
              userEvent: "input",
            });
          });
        }
        return snapshot;
      },
      hashText: async () => multiHunkTextHash,
    });
    await Promise.resolve();

    expect(result).to.deep.equal({
      status: "applied",
    });
    expect(contextReads).to.equal(2);
    expect(view.state.doc.toString()).to.equal(
      `${multiHunkText.replace("old", "new")} Local after preflight.`,
    );
    expect(aiTransactions).to.have.length(1);
    expect(documentTransactions).to.have.length(2);
    expect(documentTransactions[0].annotation(Transaction.userEvent)).to.equal(
      "input.ai-reviewer.accept",
    );
    expect(documentTransactions[1].annotation(Transaction.userEvent)).to.equal(
      "input",
    );
  });

  it("rejects a local edit that lands after compilation while hashing", async function () {
    const selectedHunkIds = await hunkIds();
    let resolveHash = (_hash: string) => {};
    const hashPending = new Promise<string>((resolve) => {
      resolveHash = resolve;
    });
    let signalHashStarted = () => {};
    const hashStarted = new Promise<void>((resolve) => {
      signalHashStarted = resolve;
    });

    const application = applySelectedSingleDocumentSuggestion({
      ...applicationOptions(selectedHunkIds),
      hashText: async (text) => {
        expect(text).to.equal(multiHunkText);
        signalHashStarted();
        return hashPending;
      },
    });
    await hashStarted;
    view.dispatch({
      changes: {
        from: multiHunkText.length,
        insert: " Local edit.",
      },
      userEvent: "input",
    });
    resolveHash(multiHunkTextHash);

    expect(await application).to.deep.equal({
      status: "conflict",
      code: "AI_EDITOR_CHANGED_DURING_PREFLIGHT",
    });
    expect(view.state.doc.toString()).to.equal(`${multiHunkText} Local edit.`);
    expect(aiTransactions).to.deep.equal([]);
    expect(documentTransactions).to.have.length(1);
  });
});
