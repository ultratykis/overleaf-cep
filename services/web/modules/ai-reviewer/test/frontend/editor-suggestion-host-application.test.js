/* eslint-disable react/prop-types */
const { undo, history } = require("@codemirror/commands");
const {
  ChangeSet,
  Compartment,
  EditorState,
  Transaction,
} = require("@codemirror/state");
const { EditorView } = require("@codemirror/view");
const React = require("react");
const { render } = require("@testing-library/react");
const { expect } = require("chai");
const sinon = require("sinon");

require("../../../../test/frontend/cut-log-noise");

const {
  toggleVisualEffect,
  visual,
} = require("@/features/source-editor/extensions/visual/visual");

const {
  applySelectedEditorSelectionSuggestion,
  readEditorSuggestionLiveContext,
} = require("../../frontend/js/services/editor-suggestion-host-application");
const {
  createEditorSelectionSessionContext,
  readEditorSourceMode,
  useEditorSelectionSessionContext,
} = require("../../frontend/js/hooks/use-editor-selection-session-context");
const {
  extension: documentIdentityExtension,
} = require("../../frontend/js/extensions/document-identity");
const fileTreePathContext = require("@/features/file-tree/contexts/file-tree-path");
const connectionContext = require("@/features/ide-react/context/connection-context");
const editorOpenDocContext = require("@/features/ide-react/context/editor-open-doc-context");
const editorPropertiesContext = require("@/features/ide-react/context/editor-properties-context");
const editorViewContext = require("@/features/ide-react/context/editor-view-context");
const permissionsContext = require("@/features/ide-react/context/permissions-context");
const projectContext = require("@/shared/context/project-context");

const baseText = "Alpha beta gamma.";
const replacementText = "Alpha clear gamma.";
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

function request() {
  return Object.freeze({
    requestId: "request-host-0001",
    projectId: "project-0001",
    action: "rewrite",
    instruction: "Rewrite the selected synthetic phrase.",
    skill: "line-edit",
    scope: Object.freeze({
      kind: "selection",
      documentId: "document-0001",
      path: "chapters/main.tex",
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

function suggestion() {
  return Object.freeze({
    id: "suggestion-host-0001",
    requestId: "request-host-0001",
    projectId: "project-0001",
    documentId: "document-0001",
    path: "chapters/main.tex",
    baseRevision: 7,
    baseTextHash,
    range: Object.freeze({
      from: 6,
      to: 10,
    }),
    original: "beta",
    replacement: "clear",
    rationale: "Use a more precise synthetic term.",
    evidence: Object.freeze([
      Object.freeze({
        path: "chapters/main.tex",
        range: Object.freeze({
          from: 6,
          to: 10,
        }),
        revision: 7,
        textHash: baseTextHash,
      }),
    ]),
    provider: "fake",
    model: "deterministic-v1",
    skill: "line-edit",
    createdAt: "2026-07-24T00:00:00.000Z",
    status: "proposed",
  });
}

function createFixture({
  text = baseText,
  trackChanges = false,
  includeVisualMode = false,
  permissions = {
    read: true,
    write: true,
    trackedWrite: true,
  },
} = {}) {
  const shareDocument = {
    connection: {
      state: "ok",
    },
    version: 7,
    getVersion() {
      return this.version;
    },
  };
  const currentDocument = {
    doc_id: "document-0001",
    joined: true,
    doc: shareDocument,
    snapshot: text,
    buffered: false,
    realtimeTrackChanges: trackChanges,
    getSnapshot() {
      return this.snapshot;
    },
    hasBufferedOps() {
      return this.buffered;
    },
    getTrackingChanges() {
      return this.realtimeTrackChanges;
    },
  };
  const identity = new Compartment();
  let aiTransactionCount = 0;
  const view = new EditorView({
    state: EditorState.create({
      doc: text,
      extensions: [
        history(),
        EditorState.readOnly.of(false),
        EditorView.editable.of(true),
        identity.of(
          documentIdentityExtension({
            currentDoc: {
              currentDocument,
            },
          }),
        ),
        includeVisualMode
          ? visual("chapters/main.tex", {
              visual: false,
              previewByPath: () => null,
            })
          : [],
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
            currentDocument.snapshot = update.state.doc.toString();
          }
        }),
      ],
    }),
  });
  currentDocument.cm6 = {
    view,
  };
  const hostContext = {
    view,
    projectId: "project-0001",
    currentDocumentId: "document-0001",
    path: "chapters/main.tex",
    currentDocument,
    sourceMode: true,
    connected: true,
    permissions: {
      ...permissions,
    },
    trackChanges,
    wantTrackChanges: trackChanges,
  };
  const session = Object.freeze({
    request: request(),
    binding: Object.freeze({
      currentDocument,
      shareDocument,
      trackChanges,
    }),
  });
  return {
    aiTransactionCount: () => aiTransactionCount,
    currentDocument,
    hostContext,
    identity,
    session,
    shareDocument,
    view,
  };
}

function compileReplacement({
  request: receivedRequest,
  suggestion: receivedSuggestion,
  selectedHunkIds,
  documentLength,
}) {
  expect(receivedRequest).to.deep.equal(request());
  expect(receivedSuggestion).to.deep.equal(suggestion());
  expect(selectedHunkIds).to.deep.equal(["hunk-host-0001"]);
  expect(documentLength).to.equal(baseText.length);
  return Promise.resolve({
    status: "ready",
    changes: ChangeSet.of(
      {
        from: 6,
        to: 10,
        insert: "clear",
      },
      baseText.length,
    ),
    selectedHunkIds: Object.freeze(["hunk-host-0001"]),
  });
}

function applicationOptions(fixture, overrides = {}) {
  return {
    session: fixture.session,
    suggestion: suggestion(),
    selectedHunkIds: Object.freeze(["hunk-host-0001"]),
    getContext: () => fixture.hostContext,
    signal: new AbortController().signal,
    compileSelectedSuggestionHunks: compileReplacement,
    hashText: async () => baseTextHash,
    ...overrides,
  };
}

describe("AI reviewer: OT safety production host application", function () {
  const views = [];

  afterEach(function () {
    sinon.restore();
    while (views.length > 0) {
      views.pop().destroy();
    }
  });

  function fixture(options) {
    const value = createFixture(options);
    views.push(value.view);
    return value;
  }

  it("reads one coherent live host context without inventing nullable values", function () {
    const current = fixture();

    const result = readEditorSuggestionLiveContext(current.hostContext);

    expect(result.status).to.equal("ready");
    if (result.status !== "ready") {
      throw new Error("Expected a ready host context.");
    }
    expect(result.view).to.equal(current.view);
    expect(result.context).to.deep.include({
      projectId: "project-0001",
      documentId: "document-0001",
      path: "chapters/main.tex",
      revision: 7,
      currentDocument: current.currentDocument,
      shareDocument: current.shareDocument,
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
    });
  });

  const initialConflictCases = [
    {
      name: "missing EditorView",
      code: "AI_EDITOR_DOCUMENT_UNBOUND",
      change: (current) => {
        current.hostContext.view = null;
      },
    },
    {
      name: "missing document ID",
      code: "AI_EDITOR_DOCUMENT_UNBOUND",
      change: (current) => {
        current.hostContext.currentDocumentId = null;
      },
    },
    {
      name: "missing project-relative path",
      code: "AI_EDITOR_DOCUMENT_UNBOUND",
      change: (current) => {
        current.hostContext.path = null;
      },
    },
    {
      name: "closed document",
      code: "AI_EDITOR_DOCUMENT_UNBOUND",
      change: (current) => {
        current.hostContext.currentDocument = null;
      },
    },
    {
      name: "detached realtime facade",
      code: "AI_EDITOR_DOCUMENT_UNBOUND",
      change: (current) => {
        delete current.currentDocument.cm6;
      },
    },
    {
      name: "realtime facade attached to another view",
      code: "AI_EDITOR_DOCUMENT_UNBOUND",
      change: (current) => {
        current.currentDocument.cm6 = {
          view: {},
        };
      },
    },
    {
      name: "Visual Editor mode",
      code: "AI_EDITOR_SOURCE_MODE_REQUIRED",
      change: (current) => {
        current.hostContext.sourceMode = false;
      },
    },
    {
      name: "offline project",
      code: "AI_EDITOR_OFFLINE",
      change: (current) => {
        current.hostContext.connected = false;
      },
    },
    {
      name: "missing ShareDoc",
      code: "AI_EDITOR_SYNC_PENDING",
      change: (current) => {
        current.currentDocument.doc = undefined;
      },
    },
    {
      name: "throwing revision accessor",
      code: "AI_EDITOR_SYNC_PENDING",
      change: (current) => {
        current.shareDocument.getVersion = () => {
          throw new Error("synthetic revision failure");
        };
      },
    },
    {
      name: "invalid revision",
      code: "AI_EDITOR_SYNC_PENDING",
      change: (current) => {
        current.shareDocument.version = -1;
      },
    },
    {
      name: "missing snapshot",
      code: "AI_EDITOR_SYNC_PENDING",
      change: (current) => {
        current.currentDocument.snapshot = undefined;
      },
    },
    {
      name: "missing buffered-operation state",
      code: "AI_EDITOR_SYNC_PENDING",
      change: (current) => {
        current.currentDocument.hasBufferedOps = () => undefined;
      },
    },
    {
      name: "missing realtime track mode",
      code: "AI_EDITOR_SYNC_PENDING",
      change: (current) => {
        current.currentDocument.getTrackingChanges = () => undefined;
      },
    },
  ];

  for (const { name, code, change } of initialConflictCases) {
    it(`fails closed for a ${name} before compile, hash, or dispatch`, async function () {
      const current = fixture();
      let compileCalls = 0;
      let hashCalls = 0;
      change(current);

      const result = await applySelectedEditorSelectionSuggestion(
        applicationOptions(current, {
          compileSelectedSuggestionHunks: async () => {
            compileCalls += 1;
            return compileReplacement({
              request: request(),
              suggestion: suggestion(),
              selectedHunkIds: ["hunk-host-0001"],
              documentLength: baseText.length,
            });
          },
          hashText: async () => {
            hashCalls += 1;
            return baseTextHash;
          },
        }),
      );

      expect(result).to.deep.equal({
        status: "conflict",
        code,
      });
      expect(compileCalls).to.equal(0);
      expect(hashCalls).to.equal(0);
      expect(current.aiTransactionCount()).to.equal(0);
      expect(current.view.state.doc.toString()).to.equal(baseText);
    });
  }

  it("rejects a destroyed EditorView after realtime detaches it", async function () {
    const current = fixture();
    views.splice(views.indexOf(current.view), 1);
    current.view.destroy();
    delete current.currentDocument.cm6;
    let compileCalls = 0;

    const result = await applySelectedEditorSelectionSuggestion(
      applicationOptions(current, {
        compileSelectedSuggestionHunks: async () => {
          compileCalls += 1;
          return compileReplacement({
            request: request(),
            suggestion: suggestion(),
            selectedHunkIds: ["hunk-host-0001"],
            documentLength: baseText.length,
          });
        },
      }),
    );

    expect(result).to.deep.equal({
      status: "conflict",
      code: "AI_EDITOR_DOCUMENT_UNBOUND",
    });
    expect(compileCalls).to.equal(0);
    expect(current.aiTransactionCount()).to.equal(0);
  });

  it("normalizes an absent live context to a typed conflict", async function () {
    const current = fixture();
    expect(readEditorSuggestionLiveContext(null)).to.deep.equal({
      status: "conflict",
      code: "AI_EDITOR_DOCUMENT_UNBOUND",
    });
    let compileCalls = 0;

    const result = await applySelectedEditorSelectionSuggestion(
      applicationOptions(current, {
        getContext: () => null,
        compileSelectedSuggestionHunks: async () => {
          compileCalls += 1;
          return compileReplacement({
            request: request(),
            suggestion: suggestion(),
            selectedHunkIds: ["hunk-host-0001"],
            documentLength: baseText.length,
          });
        },
      }),
    );

    expect(result).to.deep.equal({
      status: "conflict",
      code: "AI_EDITOR_DOCUMENT_UNBOUND",
    });
    expect(compileCalls).to.equal(0);
    expect(current.aiTransactionCount()).to.equal(0);
  });

  const throwingContextCases = [
    {
      name: "context provider",
      getContext: () => {
        throw new Error("synthetic context failure");
      },
    },
    {
      name: "context property accessor",
      getContext: () =>
        new Proxy(
          {},
          {
            get() {
              throw new Error("synthetic context accessor failure");
            },
          },
        ),
    },
  ];

  for (const testCase of throwingContextCases) {
    it(`normalizes a throwing ${testCase.name} to a typed conflict`, async function () {
      const current = fixture();
      let compileCalls = 0;
      const result = await applySelectedEditorSelectionSuggestion(
        applicationOptions(current, {
          getContext: testCase.getContext,
          compileSelectedSuggestionHunks: async () => {
            compileCalls += 1;
            return compileReplacement({
              request: request(),
              suggestion: suggestion(),
              selectedHunkIds: ["hunk-host-0001"],
              documentLength: baseText.length,
            });
          },
        }),
      );

      expect(result).to.deep.equal({
        status: "conflict",
        code: "AI_EDITOR_SYNC_PENDING",
      });
      expect(compileCalls).to.equal(0);
      expect(current.aiTransactionCount()).to.equal(0);
    });
  }

  const asynchronousMissingContextCases = [
    {
      name: "after compilation",
      missingRead: 2,
      value: null,
      expectedHashCalls: 0,
    },
    {
      name: "after hashing",
      missingRead: 3,
      value: undefined,
      expectedHashCalls: 1,
    },
  ];

  for (const testCase of asynchronousMissingContextCases) {
    it(`rejects a missing live context ${testCase.name}`, async function () {
      const current = fixture();
      let contextReads = 0;
      let hashCalls = 0;
      const result = await applySelectedEditorSelectionSuggestion(
        applicationOptions(current, {
          getContext: () => {
            contextReads += 1;
            return contextReads === testCase.missingRead
              ? testCase.value
              : current.hostContext;
          },
          hashText: async () => {
            hashCalls += 1;
            return baseTextHash;
          },
        }),
      );

      expect(result).to.deep.equal({
        status: "conflict",
        code: "AI_EDITOR_DOCUMENT_UNBOUND",
      });
      expect(contextReads).to.equal(testCase.missingRead);
      expect(hashCalls).to.equal(testCase.expectedHashCalls);
      expect(current.aiTransactionCount()).to.equal(0);
    });
  }

  it("rejects a torn revision read before compile", async function () {
    const current = fixture();
    let revision = 7;
    current.shareDocument.getVersion = () => revision++;
    let compileCalls = 0;

    const result = await applySelectedEditorSelectionSuggestion(
      applicationOptions(current, {
        compileSelectedSuggestionHunks: async () => {
          compileCalls += 1;
          return compileReplacement({
            request: request(),
            suggestion: suggestion(),
            selectedHunkIds: ["hunk-host-0001"],
            documentLength: baseText.length,
          });
        },
      }),
    );

    expect(result).to.deep.equal({
      status: "conflict",
      code: "AI_EDITOR_SYNC_PENDING",
    });
    expect(compileCalls).to.equal(0);
    expect(current.aiTransactionCount()).to.equal(0);
  });

  it("binds the capture-time ShareDoc even when document ID, revision, and text match", async function () {
    const current = fixture();
    current.currentDocument.doc = {
      connection: {
        state: "ok",
      },
      getVersion: () => 7,
    };
    let compileCalls = 0;

    const result = await applySelectedEditorSelectionSuggestion(
      applicationOptions(current, {
        compileSelectedSuggestionHunks: async () => {
          compileCalls += 1;
          return compileReplacement({
            request: request(),
            suggestion: suggestion(),
            selectedHunkIds: ["hunk-host-0001"],
            documentLength: baseText.length,
          });
        },
      }),
    );

    expect(result).to.deep.equal({
      status: "conflict",
      code: "AI_EDITOR_DOCUMENT_UNBOUND",
    });
    expect(compileCalls).to.equal(0);
    expect(current.aiTransactionCount()).to.equal(0);
  });

  it("requires both the desired and live CodeMirror mode to be source", function () {
    const current = fixture({
      includeVisualMode: true,
    });
    const isVisualModeAvailable = (documentName) =>
      documentName.endsWith(".tex");
    expect(
      readEditorSourceMode({
        view: current.view,
        documentName: "notes.txt",
        visualRequested: true,
        isVisualModeAvailable,
      }),
    ).to.equal(true);
    expect(
      readEditorSourceMode({
        view: current.view,
        documentName: "chapters/main.tex",
        visualRequested: true,
        isVisualModeAvailable,
      }),
    ).to.equal(false);
    expect(
      readEditorSourceMode({
        view: current.view,
        documentName: "chapters/main.tex",
        visualRequested: false,
        isVisualModeAvailable,
      }),
    ).to.equal(true);
    expect(
      readEditorSuggestionLiveContext(current.hostContext).status,
    ).to.equal("ready");

    current.view.dispatch({
      effects: toggleVisualEffect.of(true),
    });
    expect(
      readEditorSourceMode({
        view: current.view,
        documentName: "chapters/main.tex",
        visualRequested: false,
        isVisualModeAvailable,
      }),
    ).to.equal(false);
    expect(readEditorSuggestionLiveContext(current.hostContext)).to.deep.equal({
      status: "conflict",
      code: "AI_EDITOR_SOURCE_MODE_REQUIRED",
    });

    current.view.dispatch({
      effects: toggleVisualEffect.of(false),
    });
    expect(
      readEditorSuggestionLiveContext(current.hostContext).status,
    ).to.equal("ready");
    current.hostContext.sourceMode = false;
    expect(readEditorSuggestionLiveContext(current.hostContext)).to.deep.equal({
      status: "conflict",
      code: "AI_EDITOR_SOURCE_MODE_REQUIRED",
    });
  });

  it("wires desired Visual mode through the production selection context builder", function () {
    const current = fixture({
      includeVisualMode: true,
    });
    const originalSettings =
      window.metaAttributesCache.get("ol-ExposedSettings");
    window.metaAttributesCache.set("ol-ExposedSettings", {
      validRootDocExtensions: ["tex"],
    });
    const contextOptions = {
      view: current.view,
      projectId: "project-0001",
      currentDocumentId: "document-0001",
      path: "chapters/main.tex",
      currentDocument: current.currentDocument,
      connected: true,
      permissions: {
        read: true,
        write: true,
        trackedWrite: true,
      },
      trackChanges: false,
      wantTrackChanges: false,
      visualRequested: true,
    };

    try {
      const texContext = createEditorSelectionSessionContext({
        ...contextOptions,
        documentName: "chapters/main.tex",
      });
      const unsupportedContext = createEditorSelectionSessionContext({
        ...contextOptions,
        documentName: "notes.txt",
      });

      expect(texContext.sourceMode).to.equal(false);
      expect(unsupportedContext.sourceMode).to.equal(true);
    } finally {
      window.metaAttributesCache.set("ol-ExposedSettings", originalSettings);
    }
  });

  it("wires desired Visual mode through the production selection hook", function () {
    const current = fixture({
      includeVisualMode: true,
    });
    const originalSettings =
      window.metaAttributesCache.get("ol-ExposedSettings");
    window.metaAttributesCache.set("ol-ExposedSettings", {
      validRootDocExtensions: ["tex"],
    });
    sinon.stub(editorViewContext, "useEditorViewContext").returns({
      view: current.view,
    });
    const openDocument = sinon
      .stub(editorOpenDocContext, "useEditorOpenDocContext")
      .returns({
        currentDocumentId: "document-0001",
        currentDocument: current.currentDocument,
        openDocName: "chapters/main.tex",
      });
    sinon.stub(fileTreePathContext, "useFileTreePathContext").returns({
      pathInFolder: () => "chapters/main.tex",
    });
    sinon.stub(editorPropertiesContext, "useEditorPropertiesContext").returns({
      showVisual: true,
      trackChanges: false,
      wantTrackChanges: false,
    });
    sinon.stub(connectionContext, "useConnectionContext").returns({
      isConnected: true,
      connectionState: {
        forceDisconnected: false,
      },
    });
    sinon.stub(permissionsContext, "usePermissionsContext").returns({
      read: true,
      write: true,
      trackedWrite: true,
    });
    sinon.stub(projectContext, "useProjectContext").returns({
      projectId: "project-0001",
    });
    let getContext;
    function SelectionContextProbe() {
      getContext = useEditorSelectionSessionContext();
      return null;
    }

    const rendered = render(React.createElement(SelectionContextProbe));
    try {
      expect(getContext().sourceMode).to.equal(false);

      openDocument.returns({
        currentDocumentId: "document-0001",
        currentDocument: current.currentDocument,
        openDocName: "notes.txt",
      });
      rendered.rerender(React.createElement(SelectionContextProbe));

      expect(getContext().sourceMode).to.equal(true);
    } finally {
      rendered.unmount();
      window.metaAttributesCache.set("ol-ExposedSettings", originalSettings);
    }
  });

  const permissionCases = [
    {
      name: "write permission does not substitute for read permission",
      trackChanges: false,
      permissions: {
        read: false,
        write: true,
        trackedWrite: true,
      },
      expected: {
        status: "conflict",
        code: "AI_EDITOR_PERMISSION_DENIED",
      },
    },
    {
      name: "normal mode does not borrow tracked-write permission",
      trackChanges: false,
      permissions: {
        read: true,
        write: false,
        trackedWrite: true,
      },
      expected: {
        status: "conflict",
        code: "AI_EDITOR_PERMISSION_DENIED",
      },
    },
    {
      name: "track mode uses tracked-write permission",
      trackChanges: true,
      permissions: {
        read: true,
        write: false,
        trackedWrite: true,
      },
      expected: {
        status: "applied",
      },
    },
    {
      name: "track mode does not borrow normal-write permission",
      trackChanges: true,
      permissions: {
        read: true,
        write: true,
        trackedWrite: false,
      },
      expected: {
        status: "conflict",
        code: "AI_EDITOR_PERMISSION_DENIED",
      },
    },
  ];

  for (const testCase of permissionCases) {
    it(testCase.name, async function () {
      const current = fixture(testCase);

      const result = await applySelectedEditorSelectionSuggestion(
        applicationOptions(current),
      );

      expect(result).to.deep.equal(testCase.expected);
      expect(current.aiTransactionCount()).to.equal(
        testCase.expected.status === "applied" ? 1 : 0,
      );
    });
  }

  it("fixes one live EditorView across asynchronous compilation", async function () {
    const current = fixture();
    const compilation = deferred();
    let replacementAiTransactionCount = 0;
    const replacementView = new EditorView({
      state: EditorState.create({
        doc: baseText,
        extensions: [
          EditorState.readOnly.of(false),
          EditorView.editable.of(true),
          documentIdentityExtension({
            currentDoc: {
              currentDocument: current.currentDocument,
            },
          }),
          EditorView.updateListener.of((update) => {
            replacementAiTransactionCount += update.transactions.filter(
              (transaction) =>
                transaction.annotation(Transaction.userEvent) ===
                "input.ai-reviewer.accept",
            ).length;
          }),
        ],
      }),
    });
    views.push(replacementView);
    const application = applySelectedEditorSelectionSuggestion(
      applicationOptions(current, {
        compileSelectedSuggestionHunks: () => compilation.promise,
      }),
    );
    await Promise.resolve();
    current.currentDocument.cm6 = {
      view: replacementView,
    };
    current.hostContext.view = replacementView;
    compilation.resolve(
      await compileReplacement({
        request: request(),
        suggestion: suggestion(),
        selectedHunkIds: ["hunk-host-0001"],
        documentLength: baseText.length,
      }),
    );

    expect(await application).to.deep.equal({
      status: "conflict",
      code: "AI_EDITOR_DOCUMENT_UNBOUND",
    });
    expect(current.aiTransactionCount()).to.equal(0);
    expect(replacementAiTransactionCount).to.equal(0);
  });

  it("rejects a capture-time ShareDoc replacement during compilation", async function () {
    const current = fixture();
    const compilation = deferred();
    let hashCalls = 0;
    const application = applySelectedEditorSelectionSuggestion(
      applicationOptions(current, {
        compileSelectedSuggestionHunks: () => compilation.promise,
        hashText: async () => {
          hashCalls += 1;
          return baseTextHash;
        },
      }),
    );
    await Promise.resolve();
    current.currentDocument.doc = {
      connection: {
        state: "ok",
      },
      getVersion: () => 7,
    };
    compilation.resolve(
      await compileReplacement({
        request: request(),
        suggestion: suggestion(),
        selectedHunkIds: ["hunk-host-0001"],
        documentLength: baseText.length,
      }),
    );

    expect(await application).to.deep.equal({
      status: "conflict",
      code: "AI_EDITOR_DOCUMENT_UNBOUND",
    });
    expect(hashCalls).to.equal(0);
    expect(current.aiTransactionCount()).to.equal(0);
    expect(current.view.state.doc.toString()).to.equal(baseText);
  });

  it("rejects a capture-time ShareDoc replacement during hashing", async function () {
    const current = fixture();
    const hashing = deferred();
    let signalHashStarted;
    const hashStarted = new Promise((resolve) => {
      signalHashStarted = resolve;
    });
    const application = applySelectedEditorSelectionSuggestion(
      applicationOptions(current, {
        hashText: () => {
          signalHashStarted();
          return hashing.promise;
        },
      }),
    );
    await hashStarted;
    current.currentDocument.doc = {
      connection: {
        state: "ok",
      },
      getVersion: () => 7,
    };
    hashing.resolve(baseTextHash);

    expect(await application).to.deep.equal({
      status: "conflict",
      code: "AI_EDITOR_DOCUMENT_UNBOUND",
    });
    expect(current.aiTransactionCount()).to.equal(0);
    expect(current.view.state.doc.toString()).to.equal(baseText);
  });

  it("does not start context, compilation, or hashing for a pre-aborted application", async function () {
    const current = fixture();
    const controller = new AbortController();
    controller.abort(new DOMException("Synthetic cancellation.", "AbortError"));
    let contextReads = 0;
    let compileCalls = 0;
    let hashCalls = 0;

    const result = await applySelectedEditorSelectionSuggestion(
      applicationOptions(current, {
        signal: controller.signal,
        getContext: () => {
          contextReads += 1;
          return current.hostContext;
        },
        compileSelectedSuggestionHunks: async () => {
          compileCalls += 1;
          return compileReplacement({
            request: request(),
            suggestion: suggestion(),
            selectedHunkIds: ["hunk-host-0001"],
            documentLength: baseText.length,
          });
        },
        hashText: async () => {
          hashCalls += 1;
          return baseTextHash;
        },
      }),
    );

    expect(result).to.deep.equal({
      status: "cancelled",
    });
    expect(contextReads).to.equal(0);
    expect(compileCalls).to.equal(0);
    expect(hashCalls).to.equal(0);
    expect(current.aiTransactionCount()).to.equal(0);
  });

  it("returns promptly when compilation is aborted and ignores a late rejection", async function () {
    const current = fixture();
    const compilation = deferred();
    const controller = new AbortController();
    const application = applySelectedEditorSelectionSuggestion(
      applicationOptions(current, {
        signal: controller.signal,
        compileSelectedSuggestionHunks: () => compilation.promise,
      }),
    );
    await Promise.resolve();
    controller.abort(new DOMException("Synthetic cancellation.", "AbortError"));

    expect(await application).to.deep.equal({
      status: "cancelled",
    });
    compilation.reject(new Error("Synthetic late compile rejection."));
    await Promise.resolve();
    expect(current.aiTransactionCount()).to.equal(0);
    expect(current.view.state.doc.toString()).to.equal(baseText);
  });

  it("returns promptly when document hashing is aborted and ignores a late rejection", async function () {
    const current = fixture();
    const hashing = deferred();
    const controller = new AbortController();
    const application = applySelectedEditorSelectionSuggestion(
      applicationOptions(current, {
        signal: controller.signal,
        hashText: () => hashing.promise,
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    controller.abort(new DOMException("Synthetic cancellation.", "AbortError"));

    expect(await application).to.deep.equal({
      status: "cancelled",
    });
    hashing.reject(new Error("Synthetic late hash rejection."));
    await Promise.resolve();
    await Promise.resolve();
    expect(current.aiTransactionCount()).to.equal(0);
    expect(current.view.state.doc.toString()).to.equal(baseText);
  });

  it("removes every abort listener after successful asynchronous work", async function () {
    const current = fixture();
    const controller = new AbortController();
    const addEventListener = sinon.spy(controller.signal, "addEventListener");
    const removeEventListener = sinon.spy(
      controller.signal,
      "removeEventListener",
    );

    expect(
      await applySelectedEditorSelectionSuggestion(
        applicationOptions(current, {
          signal: controller.signal,
        }),
      ),
    ).to.deep.equal({
      status: "applied",
    });

    expect(
      addEventListener.getCalls().filter((call) => call.args[0] === "abort"),
    ).to.have.length(2);
    expect(
      removeEventListener.getCalls().filter((call) => call.args[0] === "abort"),
    ).to.have.length(2);
  });

  it("checks cancellation after the final live context read without adding an await before dispatch", async function () {
    const current = fixture();
    const controller = new AbortController();
    let contextReads = 0;

    const result = await applySelectedEditorSelectionSuggestion(
      applicationOptions(current, {
        signal: controller.signal,
        getContext: () => {
          contextReads += 1;
          if (contextReads === 3) {
            controller.abort(
              new DOMException("Synthetic cancellation.", "AbortError"),
            );
          }
          return current.hostContext;
        },
      }),
    );

    expect(result).to.deep.equal({
      status: "cancelled",
    });
    expect(contextReads).to.equal(3);
    expect(current.aiTransactionCount()).to.equal(0);
    expect(current.view.state.doc.toString()).to.equal(baseText);
  });

  it("applies one selected change through the normal transaction and Undo path", async function () {
    const current = fixture();

    const result = await applySelectedEditorSelectionSuggestion(
      applicationOptions(current),
    );

    expect(result).to.deep.equal({
      status: "applied",
    });
    expect(current.view.state.doc.toString()).to.equal(replacementText);
    expect(current.currentDocument.snapshot).to.equal(replacementText);
    expect(current.aiTransactionCount()).to.equal(1);
    expect(undo(current.view)).to.equal(true);
    expect(current.view.state.doc.toString()).to.equal(baseText);
    expect(current.currentDocument.snapshot).to.equal(baseText);
  });
});
