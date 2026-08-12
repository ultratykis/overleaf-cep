const { createHash } = require("node:crypto");

const codeMirrorLanguage = require("@codemirror/language");
const { LanguageSupport } = codeMirrorLanguage;
const { Compartment, EditorState, Transaction } = require("@codemirror/state");
const { Decoration, EditorView } = require("@codemirror/view");
const { expect } = require("chai");
const sinon = require("sinon");

require("../../../../test/frontend/cut-log-noise");

const {
  createEditorEvidenceNavigationTarget,
  createProjectEditorEvidenceNavigationTarget,
  navigateToEditorEvidence,
} = require("../../frontend/js/services/editor-evidence-navigation");
const {
  extension: documentIdentityExtension,
} = require("../../frontend/js/extensions/document-identity");
const {
  isVisual,
  visual,
} = require("@/features/source-editor/extensions/visual/visual");
const {
  LaTeXLanguage,
} = require("@/features/source-editor/languages/latex/latex-language");

const projectId = "project-0001";
const documentId = "document-0001";
const path = "chapters/main.tex";
const baseRevision = 7;
const baseText = "前😀Alpha beta gamma.";
const baseTextHash = createHash("sha256").update(baseText).digest("hex");
const selectionRange = {
  from: 1,
  to: 13,
};
const evidenceRange = {
  from: 1,
  to: 3,
};
const projectDocumentId = "document-project-evidence";
const projectPath = "chapters/other.tex";
const projectRevision = 12;
const projectText = "Other evidence text.";
const projectTextHash = createHash("sha256").update(projectText).digest("hex");
const projectEvidenceRange = {
  from: 6,
  to: 14,
};
const liveViews = [];

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

function request(overrides = {}) {
  return {
    requestId: "request-evidence-0001",
    projectId,
    action: "review",
    instruction: "Review the selected synthetic text.",
    skill: "referee-review",
    scope: {
      kind: "selection",
      documentId,
      path,
      baseRevision,
      baseTextHash,
      range: {
        ...selectionRange,
      },
      text: baseText.slice(selectionRange.from, selectionRange.to),
    },
    ...overrides,
  };
}

function finding(
  receivedRequest,
  referenceOverrides = {},
  findingOverrides = {},
) {
  return {
    id: "finding-evidence-0001",
    requestId: receivedRequest.requestId,
    projectId: receivedRequest.projectId,
    artifactKind: "finding",
    severity: "warning",
    category: "clarity",
    title: "Inspect the synthetic symbol",
    message: "The selected symbol needs an exact source reference.",
    evidence: [
      {
        path: receivedRequest.scope.path,
        range: {
          ...evidenceRange,
        },
        revision: receivedRequest.scope.baseRevision,
        textHash: receivedRequest.scope.baseTextHash,
        ...referenceOverrides,
      },
    ],
    suggestionIds: [],
    ...findingOverrides,
  };
}

function createFixture({
  visualMode = false,
  latexLanguage = false,
  readOnly = false,
  documentText = baseText,
  requestTarget = "selection",
  selectedRange = selectionRange,
  referencedRange = evidenceRange,
  permissions = {
    read: true,
    write: true,
    trackedWrite: true,
  },
} = {}) {
  const documentTextHash = createHash("sha256")
    .update(documentText)
    .digest("hex");
  const navigationTransactions = [];
  const documentTransactions = [];
  const transactions = [];
  const submitOp = sinon.spy();
  const shareDocument = {
    connection: {
      state: "ok",
    },
    version: baseRevision,
    getVersion() {
      return this.version;
    },
    submitOp,
  };
  const currentDocument = {
    doc_id: documentId,
    joined: true,
    doc: shareDocument,
    snapshot: documentText,
    buffered: false,
    realtimeTrackChanges: false,
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
  const atomicRanges = new Compartment();
  const view = new EditorView({
    state: EditorState.create({
      doc: documentText,
      extensions: [
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        identity.of(
          documentIdentityExtension({
            currentDoc: {
              currentDocument,
            },
          }),
        ),
        atomicRanges.of([]),
        latexLanguage ? new LanguageSupport(LaTeXLanguage) : [],
        visualMode
          ? visual(path, {
              visual: true,
              previewByPath: () => null,
            })
          : [],
        EditorView.updateListener.of((update) => {
          for (const transaction of update.transactions) {
            transactions.push(transaction);
            if (
              transaction.annotation(Transaction.userEvent) ===
              "select.ai-reviewer.evidence"
            ) {
              navigationTransactions.push(transaction);
            }
            if (transaction.docChanged) {
              documentTransactions.push(transaction);
            }
          }
          if (update.docChanged) {
            currentDocument.snapshot = update.state.doc.toString();
          }
        }),
      ],
    }),
  });
  liveViews.push(view);
  currentDocument.cm6 = {
    view,
  };
  const context = {
    view,
    projectId,
    currentDocumentId: documentId,
    path,
    currentDocument,
    sourceMode: !visualMode,
    connected: true,
    permissions: {
      ...permissions,
    },
    trackChanges: false,
    wantTrackChanges: false,
  };
  const receivedRequest = request({
    scope:
      requestTarget === "document"
        ? {
            kind: "document",
            documentId,
            path,
            baseRevision,
            baseTextHash: documentTextHash,
            text: documentText,
          }
        : {
            kind: "selection",
            documentId,
            path,
            baseRevision,
            baseTextHash: documentTextHash,
            range: {
              ...selectedRange,
            },
            text: documentText.slice(selectedRange.from, selectedRange.to),
          },
  });
  const session = {
    request: receivedRequest,
    binding: {
      currentDocument,
      shareDocument,
      trackChanges: false,
    },
  };
  const receivedFinding = finding(receivedRequest, {
    range: {
      ...referencedRange,
    },
  });
  const target = createEditorEvidenceNavigationTarget({
    session,
    finding: receivedFinding,
    evidenceIndex: 0,
  });
  expect(target).not.to.equal(null);

  return {
    atomicRanges,
    baseTextHash: documentTextHash,
    context,
    currentDocument,
    documentTransactions,
    finding: receivedFinding,
    identity,
    navigationTransactions,
    request: receivedRequest,
    session,
    shareDocument,
    submitOp,
    target,
    transactions,
    view,
  };
}

function createReplacementView(fixture) {
  const replacementIdentity = new Compartment();
  const replacementView = new EditorView({
    state: EditorState.create({
      doc: fixture.currentDocument.snapshot,
      extensions: [
        replacementIdentity.of(
          documentIdentityExtension({
            currentDoc: {
              currentDocument: fixture.currentDocument,
            },
          }),
        ),
      ],
    }),
  });
  liveViews.push(replacementView);
  fixture.currentDocument.cm6 = {
    view: replacementView,
  };
  fixture.context.view = replacementView;
  return replacementView;
}

function projectRequest() {
  return {
    requestId: "request-project-evidence-0001",
    projectId,
    action: "review",
    instruction: "Review the synthetic project.",
    skill: "referee-review",
    scope: {
      kind: "project",
    },
  };
}

function projectFinding(receivedRequest, referenceOverrides = {}) {
  return {
    id: "finding-project-evidence-0001",
    requestId: receivedRequest.requestId,
    projectId: receivedRequest.projectId,
    artifactKind: "finding",
    severity: "warning",
    category: "structure",
    title: "Inspect the other project document",
    message: "The project evidence points to another document.",
    evidence: [
      {
        path: projectPath,
        range: {
          ...projectEvidenceRange,
        },
        revision: projectRevision,
        textHash: projectTextHash,
        ...referenceOverrides,
      },
    ],
    suggestionIds: [],
  };
}

function createLiveDocumentFixture({
  liveDocumentId,
  livePath,
  documentText,
  revision,
  permissions = {
    read: true,
    write: true,
    trackedWrite: true,
  },
}) {
  const navigationTransactions = [];
  const documentTransactions = [];
  const submitOp = sinon.spy();
  const shareDocument = {
    connection: {
      state: "ok",
    },
    version: revision,
    getVersion() {
      return this.version;
    },
    submitOp,
  };
  const currentDocument = {
    doc_id: liveDocumentId,
    joined: true,
    doc: shareDocument,
    snapshot: documentText,
    buffered: false,
    realtimeTrackChanges: false,
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
  const view = new EditorView({
    state: EditorState.create({
      doc: documentText,
      extensions: [
        documentIdentityExtension({
          currentDoc: {
            currentDocument,
          },
        }),
        EditorView.updateListener.of((update) => {
          for (const transaction of update.transactions) {
            if (
              transaction.annotation(Transaction.userEvent) ===
              "select.ai-reviewer.evidence"
            ) {
              navigationTransactions.push(transaction);
            }
            if (transaction.docChanged) {
              documentTransactions.push(transaction);
            }
          }
        }),
      ],
    }),
  });
  liveViews.push(view);
  currentDocument.cm6 = {
    view,
  };
  return {
    context: {
      view,
      projectId,
      currentDocumentId: liveDocumentId,
      path: livePath,
      currentDocument,
      sourceMode: true,
      connected: true,
      permissions: {
        ...permissions,
      },
      trackChanges: false,
      wantTrackChanges: false,
    },
    currentDocument,
    documentTransactions,
    navigationTransactions,
    shareDocument,
    submitOp,
    view,
  };
}

function createProjectFixture({
  currentProjectId = projectId,
  permissions = {
    read: true,
    write: true,
    trackedWrite: true,
  },
  openedText = projectText,
  openedRevision = projectRevision,
  referenceOverrides = {},
  resolution = {
    documentId: projectDocumentId,
    path: projectPath,
  },
  afterOpen,
  activateOnOpen = true,
} = {}) {
  const initial = createFixture({
    permissions,
  });
  initial.context.projectId = currentProjectId;
  const opened = createLiveDocumentFixture({
    liveDocumentId: projectDocumentId,
    livePath: projectPath,
    documentText: openedText,
    revision: openedRevision,
    permissions,
  });
  let activeContext = initial.context;
  const activateOpenedContext = () => {
    activeContext = opened.context;
    afterOpen?.(opened);
  };
  const getContext = sinon.spy(() => activeContext);
  const receivedRequest = projectRequest();
  const receivedFinding = projectFinding(receivedRequest, referenceOverrides);
  const target = createProjectEditorEvidenceNavigationTarget({
    request: receivedRequest,
    finding: receivedFinding,
    evidenceIndex: 0,
  });
  expect(target).not.to.equal(null);

  const resolveDocument = sinon.stub().returns(resolution);
  const openDocument = sinon.stub().callsFake(async () => {
    if (activateOnOpen) {
      activateOpenedContext();
    }
    return {
      _id: projectDocumentId,
    };
  });
  const hashText = sinon
    .stub()
    .resolves(createHash("sha256").update(openedText).digest("hex"));

  return {
    activateOpenedContext,
    finding: receivedFinding,
    getContext,
    hashText,
    initial,
    openDocument,
    opened,
    options: {
      target,
      getContext,
      signal: new AbortController().signal,
      hashText,
      resolveDocument,
      openDocument,
    },
    request: receivedRequest,
    resolveDocument,
    target,
  };
}

function navigationOptions(fixture, overrides = {}) {
  return {
    target: fixture.target,
    getContext: () => fixture.context,
    signal: new AbortController().signal,
    hashText: sinon.stub().resolves(fixture.baseTextHash),
    ...overrides,
  };
}

afterEach(function () {
  sinon.restore();
  while (liveViews.length > 0) {
    liveViews.pop().destroy();
  }
});

describe("AI reviewer: single document evidence navigation", function () {
  it("selects the exact UTF-16 source range without changing document or realtime state", async function () {
    const fixture = createFixture();
    const resolveDocument = sinon.spy();
    const openDocument = sinon.spy();
    const beforeText = fixture.view.state.doc.toString();
    const beforeSnapshot = fixture.currentDocument.getSnapshot();

    const result = await navigateToEditorEvidence(
      navigationOptions(fixture, {
        resolveDocument,
        openDocument,
      }),
    );

    expect(result).to.deep.equal({
      status: "navigated",
    });
    expect(fixture.view.state.selection.ranges).to.have.length(1);
    expect(fixture.view.state.selection.main.from).to.equal(evidenceRange.from);
    expect(fixture.view.state.selection.main.to).to.equal(evidenceRange.to);
    expect(
      fixture.view.state.sliceDoc(...Object.values(evidenceRange)),
    ).to.equal("😀");
    expect(evidenceRange.to - evidenceRange.from).to.equal(2);
    expect(fixture.navigationTransactions).to.have.length(1);
    expect(fixture.navigationTransactions[0].docChanged).to.equal(false);
    expect(fixture.documentTransactions).to.have.length(0);
    expect(fixture.view.state.doc.toString()).to.equal(beforeText);
    expect(fixture.currentDocument.getSnapshot()).to.equal(beforeSnapshot);
    expect(fixture.submitOp.called).to.equal(false);
    expect(resolveDocument.called).to.equal(false);
    expect(openDocument.called).to.equal(false);
  });

  it("uses source offsets in an actual Visual editor without requiring write or editable state", async function () {
    const documentText =
      "\\begin{document}\n前😀Alpha beta gamma.\n\\end{document}";
    const emojiOffset = documentText.indexOf("😀");
    const fixture = createFixture({
      visualMode: true,
      latexLanguage: true,
      readOnly: true,
      documentText,
      selectedRange: {
        from: 0,
        to: documentText.length,
      },
      referencedRange: {
        from: emojiOffset,
        to: emojiOffset + "😀".length,
      },
      permissions: {
        read: true,
        write: false,
        trackedWrite: false,
      },
    });

    expect(isVisual(fixture.view)).to.equal(true);
    expect(fixture.view.state.facet(EditorState.readOnly)).to.equal(true);
    expect(fixture.view.state.facet(EditorView.editable)).to.equal(false);

    const result = await navigateToEditorEvidence(navigationOptions(fixture));

    expect(result).to.deep.equal({
      status: "navigated",
    });
    expect(fixture.view.state.selection.main.from).to.equal(emojiOffset);
    expect(fixture.view.state.selection.main.to).to.equal(
      emojiOffset + "😀".length,
    );
    expect(
      fixture.view.state.sliceDoc(emojiOffset, emojiOffset + "😀".length),
    ).to.equal("😀");
    expect(fixture.navigationTransactions).to.have.length(1);
    expect(fixture.navigationTransactions[0].docChanged).to.equal(false);
    expect(fixture.documentTransactions).to.have.length(0);
    expect(fixture.submitOp.called).to.equal(false);
  });

  it("rejects an atomic evidence endpoint in an actual LaTeX Visual editor", async function () {
    const documentText = "\\begin{itemize}\n\\item Alpha\n\\end{itemize}";
    const itemOffset = documentText.indexOf("\\item");
    const fixture = createFixture({
      visualMode: true,
      latexLanguage: true,
      readOnly: true,
      documentText,
      selectedRange: {
        from: 0,
        to: documentText.length,
      },
      referencedRange: {
        from: itemOffset,
        to: itemOffset,
      },
      permissions: {
        read: true,
        write: false,
        trackedWrite: false,
      },
    });
    const hashText = sinon.stub().resolves(fixture.baseTextHash);
    let itemOffsetIsAtomic = false;
    for (const provideRanges of fixture.view.state.facet(
      EditorView.atomicRanges,
    )) {
      provideRanges(fixture.view).between(
        itemOffset,
        itemOffset,
        (from, to) => {
          if (from <= itemOffset && to > itemOffset) {
            itemOffsetIsAtomic = true;
          }
        },
      );
    }
    expect(itemOffsetIsAtomic).to.equal(true);

    const result = await navigateToEditorEvidence(
      navigationOptions(fixture, {
        hashText,
      }),
    );
    await new Promise((resolve) => window.setTimeout(resolve, 10));

    expect(result).to.deep.equal({
      status: "conflict",
      code: "AI_EVIDENCE_RANGE_INVALID",
    });
    expect(hashText.called).to.equal(false);
    expect(fixture.navigationTransactions).to.have.length(0);
    expect(fixture.documentTransactions).to.have.length(0);
    expect(fixture.submitOp.called).to.equal(false);
  });

  it("rejects a preamble endpoint before an actual LaTeX Visual editor makes it atomic", async function () {
    const documentText =
      "\\documentclass{article}\n\n\\begin{document}\nAlpha\n\\end{document}";
    const preambleOffset = documentText.indexOf("\n\n") + 1;
    const fixture = createFixture({
      visualMode: true,
      latexLanguage: true,
      readOnly: true,
      documentText,
      selectedRange: {
        from: 0,
        to: documentText.length,
      },
      referencedRange: {
        from: preambleOffset,
        to: preambleOffset,
      },
      permissions: {
        read: true,
        write: false,
        trackedWrite: false,
      },
    });
    const hashText = sinon.stub().resolves(fixture.baseTextHash);
    let preambleOffsetIsAtomic = false;
    for (const provideRanges of fixture.view.state.facet(
      EditorView.atomicRanges,
    )) {
      provideRanges(fixture.view).between(
        preambleOffset,
        preambleOffset,
        (from, to) => {
          if (from <= preambleOffset && to > preambleOffset) {
            preambleOffsetIsAtomic = true;
          }
        },
      );
    }
    expect(preambleOffsetIsAtomic).to.equal(false);

    const result = await navigateToEditorEvidence(
      navigationOptions(fixture, {
        hashText,
      }),
    );
    await new Promise((resolve) => window.setTimeout(resolve, 20));

    expect(result).to.deep.equal({
      status: "conflict",
      code: "AI_EVIDENCE_RANGE_INVALID",
    });
    expect(hashText.called).to.equal(false);
    expect(fixture.navigationTransactions).to.have.length(0);
    expect(fixture.documentTransactions).to.have.length(0);
    expect(fixture.submitOp.called).to.equal(false);
  });

  it("selects the same preamble endpoint in source mode", async function () {
    const documentText =
      "\\documentclass{article}\n\n\\begin{document}\nAlpha\n\\end{document}";
    const preambleOffset = documentText.indexOf("\n\n") + 1;
    const fixture = createFixture({
      latexLanguage: true,
      readOnly: true,
      documentText,
      selectedRange: {
        from: 0,
        to: documentText.length,
      },
      referencedRange: {
        from: preambleOffset,
        to: preambleOffset,
      },
      permissions: {
        read: true,
        write: false,
        trackedWrite: false,
      },
    });

    const result = await navigateToEditorEvidence(navigationOptions(fixture));
    await new Promise((resolve) => window.setTimeout(resolve, 20));

    expect(result).to.deep.equal({
      status: "navigated",
    });
    expect(fixture.view.state.selection.main.from).to.equal(preambleOffset);
    expect(fixture.view.state.selection.main.to).to.equal(preambleOffset);
    expect(fixture.navigationTransactions).to.have.length(1);
    expect(fixture.navigationTransactions[0].docChanged).to.equal(false);
    expect(fixture.documentTransactions).to.have.length(0);
    expect(fixture.submitOp.called).to.equal(false);
  });

  it("rejects an incomplete Visual parser before hashing", async function () {
    const documentText = "\\begin{document}\nAlpha\n\\end{document}";
    const alphaOffset = documentText.indexOf("Alpha");
    const fixture = createFixture({
      visualMode: true,
      latexLanguage: true,
      readOnly: true,
      documentText,
      selectedRange: {
        from: 0,
        to: documentText.length,
      },
      referencedRange: {
        from: alphaOffset,
        to: alphaOffset + "Alpha".length,
      },
      permissions: {
        read: true,
        write: false,
        trackedWrite: false,
      },
    });
    const hashText = sinon.stub().resolves(fixture.baseTextHash);
    const ensureSyntaxTree = sinon
      .stub(codeMirrorLanguage, "ensureSyntaxTree")
      .returns(null);

    const result = await navigateToEditorEvidence(
      navigationOptions(fixture, {
        hashText,
      }),
    );

    expect(result).to.deep.equal({
      status: "conflict",
      code: "AI_EVIDENCE_RANGE_INVALID",
    });
    expect(ensureSyntaxTree.calledOnce).to.equal(true);
    expect(hashText.called).to.equal(false);
    expect(fixture.navigationTransactions).to.have.length(0);
    expect(fixture.documentTransactions).to.have.length(0);
    expect(fixture.submitOp.called).to.equal(false);
  });

  it("selects the same empty evidence range in source mode", async function () {
    const documentText = "\\begin{itemize}\n\\item Alpha\n\\end{itemize}";
    const itemOffset = documentText.indexOf("\\item");
    const fixture = createFixture({
      latexLanguage: true,
      readOnly: true,
      documentText,
      selectedRange: {
        from: 0,
        to: documentText.length,
      },
      referencedRange: {
        from: itemOffset,
        to: itemOffset,
      },
      permissions: {
        read: true,
        write: false,
        trackedWrite: false,
      },
    });

    const result = await navigateToEditorEvidence(navigationOptions(fixture));
    await new Promise((resolve) => window.setTimeout(resolve, 10));

    expect(result).to.deep.equal({
      status: "navigated",
    });
    expect(fixture.view.state.selection.ranges).to.have.length(1);
    expect(fixture.view.state.selection.main.from).to.equal(itemOffset);
    expect(fixture.view.state.selection.main.to).to.equal(itemOffset);
    expect(fixture.navigationTransactions).to.have.length(1);
    expect(fixture.navigationTransactions[0].docChanged).to.equal(false);
    expect(fixture.documentTransactions).to.have.length(0);
    expect(fixture.submitOp.called).to.equal(false);
  });

  it("retains a visible non-atomic range after the Visual editor timer turn", async function () {
    const documentText = "\\begin{itemize}\n\\item Alpha\n\\end{itemize}";
    const alphaOffset = documentText.indexOf("Alpha");
    const fixture = createFixture({
      visualMode: true,
      latexLanguage: true,
      readOnly: true,
      documentText,
      selectedRange: {
        from: 0,
        to: documentText.length,
      },
      referencedRange: {
        from: alphaOffset,
        to: alphaOffset + "Alpha".length,
      },
      permissions: {
        read: true,
        write: false,
        trackedWrite: false,
      },
    });

    const result = await navigateToEditorEvidence(navigationOptions(fixture));
    await new Promise((resolve) => window.setTimeout(resolve, 10));

    expect(result).to.deep.equal({
      status: "navigated",
    });
    expect(fixture.view.state.selection.ranges).to.have.length(1);
    expect(fixture.view.state.selection.main.from).to.equal(alphaOffset);
    expect(fixture.view.state.selection.main.to).to.equal(
      alphaOffset + "Alpha".length,
    );
    expect(fixture.navigationTransactions).to.have.length(1);
    expect(fixture.navigationTransactions[0].docChanged).to.equal(false);
    expect(fixture.documentTransactions).to.have.length(0);
    expect(fixture.submitOp.called).to.equal(false);
  });

  it("uses the production Web Crypto hash path by default", async function () {
    const fixture = createFixture();

    const result = await navigateToEditorEvidence(
      navigationOptions(fixture, {
        hashText: undefined,
      }),
    );

    expect(result).to.deep.equal({
      status: "navigated",
    });
    expect(fixture.view.state.selection.main.from).to.equal(evidenceRange.from);
    expect(fixture.view.state.selection.main.to).to.equal(evidenceRange.to);
    expect(fixture.navigationTransactions).to.have.length(1);
    expect(fixture.documentTransactions).to.have.length(0);
  });

  it("rejects a production Web Crypto hash mismatch", async function () {
    const fixture = createFixture();
    const target = {
      ...fixture.target,
      baseTextHash: "b".repeat(64),
    };

    const result = await navigateToEditorEvidence(
      navigationOptions(fixture, {
        target,
        hashText: undefined,
      }),
    );

    expect(result).to.deep.equal({
      status: "conflict",
      code: "AI_EVIDENCE_STATE_STALE",
    });
    expect(fixture.navigationTransactions).to.have.length(0);
    expect(fixture.documentTransactions).to.have.length(0);
  });

  it("creates one frozen target from the completed selection request and finding", function () {
    const fixture = createFixture();

    expect(Object.isFrozen(fixture.target)).to.equal(true);
    expect(Object.isFrozen(fixture.target.range)).to.equal(true);
    expect(Object.isFrozen(fixture.target.selectionRange)).to.equal(true);
    expect(fixture.target).to.include({
      requestId: fixture.request.requestId,
      projectId,
      documentId,
      path,
      baseRevision,
      baseTextHash,
    });
    expect(fixture.target.range).to.deep.equal(evidenceRange);
    expect(fixture.target.selectionRange).to.deep.equal(selectionRange);
    expect(fixture.target.currentDocument).to.equal(fixture.currentDocument);
    expect(fixture.target.shareDocument).to.equal(fixture.shareDocument);
  });

  it("creates and navigates a same-file target across the completed document request", async function () {
    const documentEvidenceRange = {
      from: 14,
      to: 19,
    };
    const fixture = createFixture({
      requestTarget: "document",
      referencedRange: documentEvidenceRange,
    });

    expect(fixture.request.scope).to.deep.equal({
      kind: "document",
      documentId,
      path,
      baseRevision,
      baseTextHash,
      text: baseText,
    });
    expect(fixture.target.selectionRange).to.deep.equal({
      from: 0,
      to: baseText.length,
    });
    expect(fixture.target.range).to.deep.equal(documentEvidenceRange);

    const result = await navigateToEditorEvidence(navigationOptions(fixture));

    expect(result).to.deep.equal({
      status: "navigated",
    });
    expect(fixture.view.state.selection.main.from).to.equal(
      documentEvidenceRange.from,
    );
    expect(fixture.view.state.selection.main.to).to.equal(
      documentEvidenceRange.to,
    );
    expect(
      fixture.view.state.sliceDoc(...Object.values(documentEvidenceRange)),
    ).to.equal("gamma");
    expect(fixture.navigationTransactions).to.have.length(1);
    expect(fixture.documentTransactions).to.have.length(0);
  });

  const invalidTargetCases = [
    {
      name: "a project-scope request",
      mutate({ session }) {
        session.request = request({
          scope: {
            kind: "project",
          },
        });
      },
    },
    {
      name: "another finding request",
      mutate({ receivedFinding }) {
        receivedFinding.requestId = "request-evidence-other";
      },
    },
    {
      name: "another finding project",
      mutate({ receivedFinding }) {
        receivedFinding.projectId = "project-other";
      },
    },
    {
      name: "another evidence path",
      mutate({ receivedFinding }) {
        receivedFinding.evidence[0].path = "chapters/other.tex";
      },
    },
    {
      name: "a missing evidence range",
      mutate({ receivedFinding }) {
        delete receivedFinding.evidence[0].range;
      },
    },
    {
      name: "an evidence range outside the selected request",
      mutate({ receivedFinding }) {
        receivedFinding.evidence[0].range = {
          from: 0,
          to: 3,
        };
      },
    },
    {
      name: "another evidence revision",
      mutate({ receivedFinding }) {
        receivedFinding.evidence[0].revision = baseRevision + 1;
      },
    },
    {
      name: "another evidence hash",
      mutate({ receivedFinding }) {
        receivedFinding.evidence[0].textHash = "b".repeat(64);
      },
    },
    {
      name: "a missing evidence index",
      evidenceIndex: 1,
      mutate() {},
    },
  ];

  for (const invalidCase of invalidTargetCases) {
    it(`does not create an actionable target for ${invalidCase.name}`, function () {
      const fixture = createFixture();
      const session = {
        request: structuredClone(fixture.request),
        binding: fixture.session.binding,
      };
      const receivedFinding = structuredClone(fixture.finding);
      invalidCase.mutate({
        session,
        receivedFinding,
      });

      expect(
        createEditorEvidenceNavigationTarget({
          session,
          finding: receivedFinding,
          evidenceIndex: invalidCase.evidenceIndex ?? 0,
        }),
      ).to.equal(null);
    });
  }

  const preHashConflicts = [
    {
      name: "an unavailable Editor view",
      code: "AI_EVIDENCE_EDITOR_UNAVAILABLE",
      mutate(fixture) {
        fixture.context.view = null;
      },
    },
    {
      name: "another live project",
      code: "AI_EVIDENCE_PROJECT_MISMATCH",
      mutate(fixture) {
        fixture.context.projectId = "project-other";
      },
    },
    {
      name: "another live document ID",
      code: "AI_EVIDENCE_DOCUMENT_MISMATCH",
      mutate(fixture) {
        fixture.context.currentDocumentId = "document-other";
      },
    },
    {
      name: "another live path",
      code: "AI_EVIDENCE_PATH_MISMATCH",
      mutate(fixture) {
        fixture.context.path = "chapters/renamed.tex";
      },
    },
    {
      name: "a missing live document",
      code: "AI_EVIDENCE_DOCUMENT_MISMATCH",
      mutate(fixture) {
        fixture.context.currentDocument = null;
      },
    },
    {
      name: "another capture-time document object",
      code: "AI_EVIDENCE_DOCUMENT_MISMATCH",
      mutate(fixture) {
        fixture.context.currentDocument = {
          ...fixture.currentDocument,
        };
      },
    },
    {
      name: "another document-identity facet",
      code: "AI_EVIDENCE_DOCUMENT_MISMATCH",
      mutate(fixture) {
        fixture.view.dispatch({
          effects: fixture.identity.reconfigure(
            documentIdentityExtension({
              currentDoc: {
                currentDocument: {
                  ...fixture.currentDocument,
                  doc_id: "document-other",
                },
              },
            }),
          ),
        });
      },
    },
    {
      name: "a detached current document view",
      code: "AI_EVIDENCE_DOCUMENT_MISMATCH",
      mutate(fixture) {
        fixture.currentDocument.cm6 = undefined;
      },
    },
    {
      name: "another ShareDoc",
      code: "AI_EVIDENCE_DOCUMENT_MISMATCH",
      mutate(fixture) {
        fixture.currentDocument.doc = {
          ...fixture.shareDocument,
        };
      },
    },
    {
      name: "a disconnected context",
      code: "AI_EVIDENCE_STATE_STALE",
      mutate(fixture) {
        fixture.context.connected = false;
      },
    },
    {
      name: "an unjoined document",
      code: "AI_EVIDENCE_STATE_STALE",
      mutate(fixture) {
        fixture.currentDocument.joined = false;
      },
    },
    {
      name: "a disconnected ShareDoc",
      code: "AI_EVIDENCE_STATE_STALE",
      mutate(fixture) {
        fixture.shareDocument.connection.state = "disconnected";
      },
    },
    {
      name: "buffered operations",
      code: "AI_EVIDENCE_STATE_STALE",
      mutate(fixture) {
        fixture.currentDocument.buffered = true;
      },
    },
    {
      name: "revoked read permission",
      code: "AI_EVIDENCE_PERMISSION_DENIED",
      mutate(fixture) {
        fixture.context.permissions.read = false;
      },
    },
    {
      name: "a realtime and Editor text divergence",
      code: "AI_EVIDENCE_STATE_STALE",
      mutate(fixture) {
        fixture.currentDocument.snapshot = `${baseText} diverged`;
      },
    },
    {
      name: "a live document shorter than the evidence range",
      code: "AI_EVIDENCE_RANGE_INVALID",
      mutate(fixture) {
        fixture.view.dispatch({
          changes: {
            from: 1,
            to: fixture.view.state.doc.length,
            insert: "",
          },
        });
      },
    },
  ];

  for (const conflictCase of preHashConflicts) {
    it(`fails before hashing for ${conflictCase.name}`, async function () {
      const fixture = createFixture();
      const hashText = sinon.stub().resolves(baseTextHash);
      conflictCase.mutate(fixture);

      const result = await navigateToEditorEvidence(
        navigationOptions(fixture, {
          hashText,
        }),
      );

      expect(result).to.deep.equal({
        status: "conflict",
        code: conflictCase.code,
      });
      expect(hashText.called).to.equal(false);
      expect(fixture.navigationTransactions).to.have.length(0);
      expect(fixture.submitOp.called).to.equal(false);
    });
  }

  it("navigates after the revision advances when the captured content still matches", async function () {
    const fixture = createFixture();
    const hashText = sinon.stub().resolves(baseTextHash);
    fixture.shareDocument.version += 1;

    const result = await navigateToEditorEvidence(
      navigationOptions(fixture, {
        hashText,
      }),
    );

    expect(result).to.deep.equal({
      status: "navigated",
    });
    expect(hashText.calledOnceWithExactly(baseText)).to.equal(true);
    expect(fixture.navigationTransactions).to.have.length(1);
    expect(fixture.submitOp.called).to.equal(false);
  });

  it("returns a typed stale conflict when a live accessor throws", async function () {
    const fixture = createFixture();
    const hashText = sinon.stub().resolves(baseTextHash);
    fixture.shareDocument.getVersion = () => {
      throw new Error("synthetic revision failure");
    };

    const result = await navigateToEditorEvidence(
      navigationOptions(fixture, {
        hashText,
      }),
    );

    expect(result).to.deep.equal({
      status: "conflict",
      code: "AI_EVIDENCE_STATE_STALE",
    });
    expect(hashText.called).to.equal(false);
    expect(fixture.navigationTransactions).to.have.length(0);
  });

  it("returns cancelled before reading context when the navigation is already aborted", async function () {
    const fixture = createFixture();
    const controller = new AbortController();
    const getContext = sinon.spy(() => fixture.context);
    const hashText = sinon.stub().resolves(baseTextHash);
    controller.abort(new DOMException("Superseded.", "AbortError"));

    const result = await navigateToEditorEvidence(
      navigationOptions(fixture, {
        getContext,
        hashText,
        signal: controller.signal,
      }),
    );

    expect(result).to.deep.equal({
      status: "cancelled",
    });
    expect(getContext.called).to.equal(false);
    expect(hashText.called).to.equal(false);
    expect(fixture.navigationTransactions).to.have.length(0);
  });

  it("rejects a malformed exported target without reading context", async function () {
    const fixture = createFixture();
    const getContext = sinon.spy(() => fixture.context);
    const hashText = sinon.stub().resolves(baseTextHash);

    const result = await navigateToEditorEvidence(
      navigationOptions(fixture, {
        target: {
          ...fixture.target,
          range: undefined,
        },
        getContext,
        hashText,
      }),
    );

    expect(result).to.deep.equal({
      status: "conflict",
      code: "AI_EVIDENCE_REFERENCE_INVALID",
    });
    expect(getContext.called).to.equal(false);
    expect(hashText.called).to.equal(false);
    expect(fixture.navigationTransactions).to.have.length(0);
  });

  it("rejects a forged exported range outside its selection scope", async function () {
    const fixture = createFixture();
    const getContext = sinon.spy(() => fixture.context);
    const hashText = sinon.stub().resolves(baseTextHash);

    const result = await navigateToEditorEvidence(
      navigationOptions(fixture, {
        target: {
          ...fixture.target,
          range: {
            from: 15,
            to: 19,
          },
        },
        getContext,
        hashText,
      }),
    );

    expect(result).to.deep.equal({
      status: "conflict",
      code: "AI_EVIDENCE_REFERENCE_INVALID",
    });
    expect(getContext.called).to.equal(false);
    expect(hashText.called).to.equal(false);
    expect(fixture.navigationTransactions).to.have.length(0);
  });
});

describe("AI reviewer: cross-file project evidence navigation", function () {
  it("selects verified project evidence after only its revision advances", async function () {
    const fixture = createProjectFixture({
      openedRevision: projectRevision + 1,
    });

    const result = await navigateToEditorEvidence(fixture.options);

    expect(result).to.deep.equal({
      status: "navigated",
    });
    expect(fixture.hashText.calledOnceWithExactly(projectText)).to.equal(true);
    expect(fixture.opened.navigationTransactions).to.have.length(1);
    expect(fixture.opened.submitOp.called).to.equal(false);
  });

  it("opens an exact current-project document and selects its verified range without editing", async function () {
    const fixture = createProjectFixture();
    const initialText = fixture.initial.view.state.doc.toString();
    const openedText = fixture.opened.view.state.doc.toString();

    const result = await navigateToEditorEvidence(fixture.options);

    expect(result).to.deep.equal({
      status: "navigated",
    });
    expect(fixture.target).to.deep.include({
      kind: "project",
      requestId: fixture.request.requestId,
      findingId: fixture.finding.id,
      projectId,
      path: projectPath,
      revision: projectRevision,
      textHash: projectTextHash,
    });
    expect(fixture.resolveDocument.calledOnceWithExactly(projectPath)).to.equal(
      true,
    );
    expect(
      fixture.openDocument.calledOnceWithExactly(projectDocumentId),
    ).to.equal(true);
    sinon.assert.callOrder(
      fixture.resolveDocument,
      fixture.openDocument,
      fixture.hashText,
    );
    expect(fixture.opened.view.state.selection.ranges).to.have.length(1);
    expect(fixture.opened.view.state.selection.main.from).to.equal(
      projectEvidenceRange.from,
    );
    expect(fixture.opened.view.state.selection.main.to).to.equal(
      projectEvidenceRange.to,
    );
    expect(
      fixture.opened.view.state.sliceDoc(
        projectEvidenceRange.from,
        projectEvidenceRange.to,
      ),
    ).to.equal("evidence");
    expect(fixture.opened.navigationTransactions).to.have.length(1);
    expect(fixture.opened.navigationTransactions[0].docChanged).to.equal(false);
    expect(fixture.opened.documentTransactions).to.have.length(0);
    expect(fixture.initial.documentTransactions).to.have.length(0);
    expect(fixture.initial.view.state.doc.toString()).to.equal(initialText);
    expect(fixture.opened.view.state.doc.toString()).to.equal(openedText);
    expect(fixture.initial.submitOp.called).to.equal(false);
    expect(fixture.opened.submitOp.called).to.equal(false);
  });

  it("waits for the resolved document after an unrelated editor-ready signal", async function () {
    const fixture = createProjectFixture({
      activateOnOpen: false,
    });
    let settled = false;
    const navigation = navigateToEditorEvidence(fixture.options).finally(() => {
      settled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(fixture.openDocument.calledOnce).to.equal(true);

    window.dispatchEvent(new Event("editor:scroll-position-restored"));
    await new Promise((resolve) => setTimeout(resolve));
    expect(settled).to.equal(false);

    fixture.activateOpenedContext();
    window.dispatchEvent(new Event("editor:scroll-position-restored"));

    expect(await navigation).to.deep.equal({
      status: "navigated",
    });
    expect(fixture.opened.navigationTransactions).to.have.length(1);
  });

  it("keeps the target file open without selecting when its captured state no longer matches", async function () {
    const fixture = createProjectFixture({
      openedText: "Other changed! text.",
      openedRevision: projectRevision + 1,
    });
    const initialSelection = fixture.opened.view.state.selection.toJSON();

    const result = await navigateToEditorEvidence(fixture.options);

    expect(result).to.deep.equal({
      status: "opened",
    });
    expect(
      fixture.openDocument.calledOnceWithExactly(projectDocumentId),
    ).to.equal(true);
    expect(fixture.getContext()).to.equal(fixture.opened.context);
    expect(fixture.opened.view.state.selection.toJSON()).to.deep.equal(
      initialSelection,
    );
    expect(fixture.opened.navigationTransactions).to.have.length(0);
    expect(fixture.opened.documentTransactions).to.have.length(0);
    expect(fixture.opened.submitOp.called).to.equal(false);
    expect(
      fixture.hashText.calledOnceWithExactly("Other changed! text."),
    ).to.equal(true);
  });

  it("opens range-only project evidence without selecting an unverified range", async function () {
    const fixture = createProjectFixture({
      referenceOverrides: {
        revision: undefined,
        textHash: undefined,
      },
    });

    const result = await navigateToEditorEvidence(fixture.options);

    expect(result).to.deep.equal({
      status: "opened",
    });
    expect(fixture.target).not.to.have.property("revision");
    expect(fixture.target).not.to.have.property("textHash");
    expect(
      fixture.openDocument.calledOnceWithExactly(projectDocumentId),
    ).to.equal(true);
    expect(fixture.hashText.called).to.equal(false);
    expect(fixture.opened.navigationTransactions).to.have.length(0);
  });

  const preOpenRefusals = [
    {
      name: "another live project",
      code: "AI_EVIDENCE_PROJECT_MISMATCH",
      options: {
        currentProjectId: "project-other",
      },
    },
    {
      name: "a user without project read permission",
      code: "AI_EVIDENCE_PERMISSION_DENIED",
      options: {
        permissions: {
          read: false,
          write: false,
          trackedWrite: false,
        },
      },
    },
  ];

  for (const refusal of preOpenRefusals) {
    it(`refuses ${refusal.name} before resolving or opening a document`, async function () {
      const fixture = createProjectFixture(refusal.options);

      const result = await navigateToEditorEvidence(fixture.options);

      expect(result).to.deep.equal({
        status: "conflict",
        code: refusal.code,
      });
      expect(fixture.resolveDocument.called).to.equal(false);
      expect(fixture.openDocument.called).to.equal(false);
      expect(fixture.opened.navigationTransactions).to.have.length(0);
    });
  }

  const postOpenRefusals = [
    {
      name: "a project switch while the document opens",
      code: "AI_EVIDENCE_PROJECT_MISMATCH",
      mutate(opened) {
        opened.context.projectId = "project-other";
      },
    },
    {
      name: "read permission revoked while the document opens",
      code: "AI_EVIDENCE_PERMISSION_DENIED",
      mutate(opened) {
        opened.context.permissions.read = false;
      },
    },
  ];

  for (const refusal of postOpenRefusals) {
    it(`refuses ${refusal.name} without selecting`, async function () {
      const fixture = createProjectFixture({
        afterOpen: refusal.mutate,
      });

      const result = await navigateToEditorEvidence(fixture.options);

      expect(result).to.deep.equal({
        status: "conflict",
        code: refusal.code,
      });
      expect(fixture.resolveDocument.calledOnce).to.equal(true);
      expect(fixture.openDocument.calledOnce).to.equal(true);
      expect(fixture.hashText.called).to.equal(false);
      expect(fixture.opened.navigationTransactions).to.have.length(0);
    });
  }

  it("refuses a path that does not resolve to an exact document in the current project", async function () {
    const fixture = createProjectFixture({
      resolution: null,
    });

    const result = await navigateToEditorEvidence(fixture.options);

    expect(result).to.deep.equal({
      status: "conflict",
      code: "AI_EVIDENCE_PATH_MISMATCH",
    });
    expect(fixture.resolveDocument.calledOnceWithExactly(projectPath)).to.equal(
      true,
    );
    expect(fixture.openDocument.called).to.equal(false);
    expect(fixture.opened.navigationTransactions).to.have.length(0);
  });

  it("rejects a forged outside-project path before reading live context", async function () {
    const fixture = createProjectFixture();
    const getContext = sinon.spy(fixture.getContext);

    const result = await navigateToEditorEvidence({
      ...fixture.options,
      target: {
        ...fixture.target,
        path: "../outside.tex",
      },
      getContext,
    });

    expect(result).to.deep.equal({
      status: "conflict",
      code: "AI_EVIDENCE_REFERENCE_INVALID",
    });
    expect(getContext.called).to.equal(false);
    expect(fixture.resolveDocument.called).to.equal(false);
    expect(fixture.openDocument.called).to.equal(false);
  });
});

describe("AI reviewer: OT safety evidence navigation", function () {
  const targetMutationCases = [
    {
      name: "project ID",
      mutate(target) {
        target.projectId = "project-other";
      },
    },
    {
      name: "document ID",
      mutate(target) {
        target.documentId = "document-other";
      },
    },
    {
      name: "path",
      mutate(target) {
        target.path = "chapters/other.tex";
      },
    },
    {
      name: "revision",
      mutate(target) {
        target.baseRevision += 1;
      },
    },
    {
      name: "text hash",
      mutate(target) {
        target.baseTextHash = "b".repeat(64);
      },
    },
    {
      name: "selection range",
      mutate(target) {
        target.selectionRange = {
          from: 0,
          to: 999,
        };
      },
    },
    {
      name: "evidence range",
      mutate(target) {
        target.range = {
          from: 15,
          to: 19,
        };
      },
    },
    {
      name: "document object",
      mutate(target) {
        target.currentDocument = {
          ...target.currentDocument,
        };
      },
    },
    {
      name: "ShareDoc object",
      mutate(target) {
        target.shareDocument = {
          ...target.shareDocument,
        };
      },
    },
  ];

  for (const mutationCase of targetMutationCases) {
    it(`retains the invocation-time ${mutationCase.name} while hashing`, async function () {
      const fixture = createFixture();
      const hash = deferred();
      const target = {
        ...fixture.target,
        selectionRange: {
          ...fixture.target.selectionRange,
        },
        range: {
          ...fixture.target.range,
        },
      };
      const navigation = navigateToEditorEvidence(
        navigationOptions(fixture, {
          target,
          hashText: sinon.stub().returns(hash.promise),
        }),
      );
      await Promise.resolve();

      mutationCase.mutate(target);
      hash.resolve(baseTextHash);

      expect(await navigation).to.deep.equal({
        status: "navigated",
      });
      expect(fixture.view.state.selection.main.from).to.equal(
        evidenceRange.from,
      );
      expect(fixture.view.state.selection.main.to).to.equal(evidenceRange.to);
      expect(fixture.navigationTransactions).to.have.length(1);
      expect(fixture.documentTransactions).to.have.length(0);
      expect(fixture.submitOp.called).to.equal(false);
    });
  }

  const postHashConflicts = [
    {
      name: "a local edit",
      code: "AI_EVIDENCE_STATE_STALE",
      mutate(fixture) {
        fixture.view.dispatch({
          changes: {
            from: 3,
            to: 8,
            insert: "Local",
          },
          annotations: Transaction.userEvent.of("input.synthetic.local"),
        });
      },
    },
    {
      name: "a remote edit",
      code: "AI_EVIDENCE_STATE_STALE",
      mutate(fixture) {
        fixture.view.dispatch({
          changes: {
            from: 3,
            to: 8,
            insert: "Remote",
          },
          annotations: Transaction.remote.of(true),
        });
      },
    },
    {
      name: "a document switch",
      code: "AI_EVIDENCE_DOCUMENT_MISMATCH",
      mutate(fixture) {
        const replacementDocument = {
          ...fixture.currentDocument,
          cm6: {
            view: fixture.view,
          },
        };
        fixture.context.currentDocument = replacementDocument;
        fixture.view.dispatch({
          effects: fixture.identity.reconfigure(
            documentIdentityExtension({
              currentDoc: {
                currentDocument: replacementDocument,
              },
            }),
          ),
        });
      },
    },
    {
      name: "a document rename",
      code: "AI_EVIDENCE_PATH_MISMATCH",
      mutate(fixture) {
        fixture.context.path = "chapters/renamed.tex";
      },
    },
    {
      name: "a document delete",
      code: "AI_EVIDENCE_DOCUMENT_MISMATCH",
      mutate(fixture) {
        fixture.context.currentDocumentId = null;
        fixture.context.path = null;
        fixture.context.currentDocument = null;
      },
    },
    {
      name: "an Editor view replacement",
      code: "AI_EVIDENCE_STATE_STALE",
      mutate(fixture) {
        createReplacementView(fixture);
      },
    },
    {
      name: "a ShareDoc replacement",
      code: "AI_EVIDENCE_DOCUMENT_MISMATCH",
      mutate(fixture) {
        fixture.currentDocument.doc = {
          ...fixture.shareDocument,
        };
      },
    },
    {
      name: "a revision change",
      code: "AI_EVIDENCE_STATE_STALE",
      mutate(fixture) {
        fixture.shareDocument.version += 1;
      },
    },
    {
      name: "a permission change",
      code: "AI_EVIDENCE_PERMISSION_DENIED",
      mutate(fixture) {
        fixture.context.permissions.read = false;
      },
    },
  ];

  for (const conflictCase of postHashConflicts) {
    it(`rejects ${conflictCase.name} while hashing without an AI transaction`, async function () {
      const fixture = createFixture();
      const hash = deferred();
      const hashText = sinon.stub().returns(hash.promise);

      const navigation = navigateToEditorEvidence(
        navigationOptions(fixture, {
          hashText,
        }),
      );
      await Promise.resolve();
      expect(hashText.calledOnceWithExactly(baseText)).to.equal(true);

      conflictCase.mutate(fixture);
      hash.resolve(baseTextHash);
      const result = await navigation;

      expect(result).to.deep.equal({
        status: "conflict",
        code: conflictCase.code,
      });
      expect(fixture.navigationTransactions).to.have.length(0);
      expect(fixture.submitOp.called).to.equal(false);
    });
  }

  it("rejects a Visual-to-source mode transition while hashing", async function () {
    const documentText = "\\begin{document}\nAlpha\n\\end{document}";
    const alphaOffset = documentText.indexOf("Alpha");
    const fixture = createFixture({
      visualMode: true,
      latexLanguage: true,
      documentText,
      selectedRange: {
        from: 0,
        to: documentText.length,
      },
      referencedRange: {
        from: alphaOffset,
        to: alphaOffset + "Alpha".length,
      },
    });
    const hash = deferred();
    const hashText = sinon.stub().returns(hash.promise);
    const navigation = navigateToEditorEvidence(
      navigationOptions(fixture, {
        hashText,
      }),
    );
    await Promise.resolve();
    expect(hashText.calledOnceWithExactly(documentText)).to.equal(true);

    fixture.context.sourceMode = true;
    hash.resolve(fixture.baseTextHash);

    expect(await navigation).to.deep.equal({
      status: "conflict",
      code: "AI_EVIDENCE_STATE_STALE",
    });
    expect(fixture.navigationTransactions).to.have.length(0);
    expect(fixture.documentTransactions).to.have.length(0);
    expect(fixture.submitOp.called).to.equal(false);
  });

  it("rejects an evidence endpoint that becomes atomic while hashing", async function () {
    const fixture = createFixture();
    const hash = deferred();
    const navigation = navigateToEditorEvidence(
      navigationOptions(fixture, {
        hashText: sinon.stub().returns(hash.promise),
      }),
    );
    await Promise.resolve();

    fixture.view.dispatch({
      effects: fixture.atomicRanges.reconfigure(
        EditorView.atomicRanges.of(() =>
          Decoration.set([
            Decoration.mark({}).range(evidenceRange.from, evidenceRange.to),
          ]),
        ),
      ),
    });
    hash.resolve(baseTextHash);

    expect(await navigation).to.deep.equal({
      status: "conflict",
      code: "AI_EVIDENCE_RANGE_INVALID",
    });
    expect(fixture.navigationTransactions).to.have.length(0);
    expect(fixture.documentTransactions).to.have.length(0);
    expect(fixture.submitOp.called).to.equal(false);
  });

  it("rejects a text hash mismatch without selecting evidence", async function () {
    const fixture = createFixture();

    const result = await navigateToEditorEvidence(
      navigationOptions(fixture, {
        hashText: sinon.stub().resolves("b".repeat(64)),
      }),
    );

    expect(result).to.deep.equal({
      status: "conflict",
      code: "AI_EVIDENCE_STATE_STALE",
    });
    expect(fixture.navigationTransactions).to.have.length(0);
    expect(fixture.documentTransactions).to.have.length(0);
  });

  it("classifies a hash failure without exposing its raw error", async function () {
    const fixture = createFixture();

    const result = await navigateToEditorEvidence(
      navigationOptions(fixture, {
        hashText: sinon
          .stub()
          .rejects(new Error("AI_EVIDENCE_PRIVATE_HASH_FAILURE")),
      }),
    );

    expect(result).to.deep.equal({
      status: "error",
      code: "AI_EVIDENCE_HASH_FAILED",
    });
    expect(JSON.stringify(result)).not.to.contain(
      "AI_EVIDENCE_PRIVATE_HASH_FAILURE",
    );
    expect(fixture.navigationTransactions).to.have.length(0);
  });

  it("cancels promptly while a non-cooperative hash remains pending", async function () {
    const fixture = createFixture();
    const hash = deferred();
    const controller = new AbortController();

    const navigation = navigateToEditorEvidence(
      navigationOptions(fixture, {
        signal: controller.signal,
        hashText: sinon.stub().returns(hash.promise),
      }),
    );
    await Promise.resolve();
    controller.abort(new DOMException("Superseded.", "AbortError"));

    expect(await navigation).to.deep.equal({
      status: "cancelled",
    });
    expect(fixture.navigationTransactions).to.have.length(0);
    hash.resolve(baseTextHash);
    await Promise.resolve();
    expect(fixture.navigationTransactions).to.have.length(0);
  });

  it("allows a harmless selection change while hashing and then selects the evidence", async function () {
    const fixture = createFixture();
    const hash = deferred();
    const navigation = navigateToEditorEvidence(
      navigationOptions(fixture, {
        hashText: sinon.stub().returns(hash.promise),
      }),
    );
    await Promise.resolve();

    fixture.view.dispatch({
      selection: {
        anchor: 9,
        head: 13,
      },
      annotations: Transaction.userEvent.of("select.synthetic"),
    });
    hash.resolve(baseTextHash);

    expect(await navigation).to.deep.equal({
      status: "navigated",
    });
    expect(fixture.view.state.selection.main.from).to.equal(evidenceRange.from);
    expect(fixture.view.state.selection.main.to).to.equal(evidenceRange.to);
    expect(fixture.navigationTransactions).to.have.length(1);
    expect(fixture.documentTransactions).to.have.length(0);
  });

  it("dispatches synchronously after the final context read", async function () {
    const fixture = createFixture();
    let contextReads = 0;
    const getContext = () => {
      contextReads += 1;
      if (contextReads === 2) {
        queueMicrotask(() => {
          fixture.view.dispatch({
            changes: {
              from: fixture.view.state.doc.length,
              insert: " later",
            },
            annotations: Transaction.userEvent.of("input.synthetic.later"),
          });
        });
      }
      return fixture.context;
    };

    const result = await navigateToEditorEvidence(
      navigationOptions(fixture, {
        getContext,
      }),
    );

    expect(result).to.deep.equal({
      status: "navigated",
    });
    expect(contextReads).to.equal(2);
    expect(fixture.transactions).to.have.length(2);
    expect(fixture.transactions[0].annotation(Transaction.userEvent)).to.equal(
      "select.ai-reviewer.evidence",
    );
    expect(fixture.transactions[0].docChanged).to.equal(false);
    expect(fixture.transactions[1].annotation(Transaction.userEvent)).to.equal(
      "input.synthetic.later",
    );
    expect(fixture.transactions[1].docChanged).to.equal(true);
  });

  it("cancels when the final context read aborts navigation", async function () {
    const fixture = createFixture();
    const controller = new AbortController();
    let contextReads = 0;
    const getContext = () => {
      contextReads += 1;
      if (contextReads === 2) {
        controller.abort(new DOMException("Superseded.", "AbortError"));
      }
      return fixture.context;
    };

    const result = await navigateToEditorEvidence(
      navigationOptions(fixture, {
        getContext,
        signal: controller.signal,
      }),
    );

    expect(result).to.deep.equal({
      status: "cancelled",
    });
    expect(contextReads).to.equal(2);
    expect(fixture.navigationTransactions).to.have.length(0);
    expect(fixture.documentTransactions).to.have.length(0);
    expect(fixture.submitOp.called).to.equal(false);
  });

  it("reports failure without retry when dispatch does not retain exactly one requested range", async function () {
    const fixture = createFixture();
    const originalDispatch = fixture.view.dispatch.bind(fixture.view);
    sinon.stub(fixture.view, "dispatch").callsFake((...specs) => {
      originalDispatch(...specs);
      originalDispatch({
        selection: {
          anchor: 9,
          head: 13,
        },
        annotations: Transaction.userEvent.of(
          "select.synthetic.after-navigation",
        ),
      });
    });

    const result = await navigateToEditorEvidence(navigationOptions(fixture));

    expect(result).to.deep.equal({
      status: "error",
      code: "AI_EVIDENCE_NAVIGATION_FAILED",
    });
    expect(fixture.navigationTransactions).to.have.length(1);
    expect(fixture.documentTransactions).to.have.length(0);
    expect(fixture.submitOp.called).to.equal(false);
  });

  it("classifies a synchronous dispatch failure and performs no document mutation", async function () {
    const fixture = createFixture();
    sinon
      .stub(fixture.view, "dispatch")
      .throws(new Error("AI_EVIDENCE_PRIVATE_DISPATCH_FAILURE"));

    const result = await navigateToEditorEvidence(navigationOptions(fixture));

    expect(result).to.deep.equal({
      status: "error",
      code: "AI_EVIDENCE_NAVIGATION_FAILED",
    });
    expect(JSON.stringify(result)).not.to.contain(
      "AI_EVIDENCE_PRIVATE_DISPATCH_FAILURE",
    );
    expect(fixture.navigationTransactions).to.have.length(0);
    expect(fixture.documentTransactions).to.have.length(0);
    expect(fixture.submitOp.called).to.equal(false);
  });
});
