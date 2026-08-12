const { createHash } = require("node:crypto");

const { EditorState } = require("@codemirror/state");
const { EditorView } = require("@codemirror/view");
const { expect } = require("chai");
const sinon = require("sinon");

require("../../../../test/frontend/cut-log-noise");

const {
  postAiReviewerArtifactComment,
} = require("../../frontend/js/services/editor-artifact-comment-posting");
const {
  navigateToEditorEvidence,
} = require("../../frontend/js/services/editor-evidence-navigation");
const {
  extension: documentIdentityExtension,
} = require("../../frontend/js/extensions/document-identity");

const projectId = "project-0001";
const documentId = "document-0001";
const path = "main.tex";
const baseText = "Alpha beta gamma.";
const baseTextHash = createHash("sha256").update(baseText).digest("hex");
const range = {
  from: 6,
  to: 10,
};

function request() {
  return {
    requestId: "request-0001",
    projectId,
    action: "review",
    instruction: "Review the synthetic document.",
    skill: "referee-review",
    scope: {
      kind: "document",
      documentId,
      path,
      baseRevision: 7,
      baseTextHash,
      text: baseText,
    },
  };
}

function finding(overrides = {}) {
  return {
    artifactKind: "finding",
    id: "finding-0001",
    requestId: "request-0001",
    projectId,
    severity: "warning",
    category: "clarity",
    title: "Synthetic finding",
    message: "The synthetic phrase needs attention.",
    evidence: [
      {
        path,
        range: {
          ...range,
        },
        revision: 7,
        textHash: baseTextHash,
      },
    ],
    suggestionIds: [],
    ...overrides,
  };
}

function suggestion(overrides = {}) {
  return {
    id: "suggestion-0001",
    requestId: "request-0001",
    projectId,
    documentId,
    path,
    baseRevision: 7,
    baseTextHash,
    range: {
      ...range,
    },
    original: "beta",
    replacement: "clear",
    rationale: "Use a more precise synthetic term.",
    evidence: [
      {
        path,
        range: {
          ...range,
        },
        revision: 7,
        textHash: baseTextHash,
      },
    ],
    provider: "fake",
    model: "deterministic-v1",
    skill: "line-edit",
    createdAt: "2026-07-26T00:00:00.000Z",
    status: "unresolved",
    ...overrides,
  };
}

function citationFinding() {
  return {
    ...finding(),
    artifactKind: "citation-finding",
    id: "citation-finding-0001",
    proposedText: "A synthetic citation.",
  };
}

function editorContext(text = baseText) {
  return {
    view: {
      state: {
        doc: {
          length: text.length,
        },
        sliceDoc(from, to) {
          return text.slice(from, to);
        },
      },
    },
    projectId,
    currentDocumentId: documentId,
    path,
    currentDocument: {
      doc_id: documentId,
    },
  };
}

function postingFixture({ text = baseText } = {}) {
  const context = editorContext(text);
  return {
    getContext: sinon.stub().returns(context),
    navigateEvidence: sinon.stub().resolves({
      status: "navigated",
    }),
    postComment: sinon.stub().resolves({
      commentId: "thread-0001",
    }),
    signal: new AbortController().signal,
  };
}

function livePostingFixture({ text = baseText, revision = 8 } = {}) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const shareDocument = {
    connection: {
      state: "ok",
    },
    getVersion: sinon.stub().returns(revision),
  };
  const currentDocument = {
    doc_id: documentId,
    joined: true,
    doc: shareDocument,
    getSnapshot: sinon.stub().returns(text),
    hasBufferedOps: sinon.stub().returns(false),
  };
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        documentIdentityExtension({
          currentDoc: {
            currentDocument,
          },
        }),
      ],
    }),
  });
  currentDocument.cm6 = { view };
  const context = {
    view,
    projectId,
    currentDocumentId: documentId,
    path,
    currentDocument,
    permissions: {
      read: true,
    },
    sourceMode: true,
    connected: true,
  };
  return {
    getContext: sinon.stub().returns(context),
    resolveDocument: sinon.stub().returns({ documentId, path }),
    openDocument: sinon.stub().resolves(),
    navigateEvidence: (options) =>
      navigateToEditorEvidence({
        ...options,
        hashText: async (value) =>
          createHash("sha256").update(value).digest("hex"),
      }),
    postComment: sinon.stub().resolves({
      commentId: "thread-0001",
    }),
    signal: new AbortController().signal,
    dispose() {
      view.destroy();
      parent.remove();
    },
  };
}

describe("AI reviewer: artifact comment posting", function () {
  it("posts an ordinary finding through the injected comment path", async function () {
    const fixture = postingFixture();

    const result = await postAiReviewerArtifactComment({
      request: request(),
      artifact: finding(),
      content: "The synthetic phrase needs attention.",
      ...fixture,
    });

    expect(result).to.deep.equal({
      status: "posted",
      commentId: "thread-0001",
    });
    expect(fixture.postComment).to.have.been.calledOnceWithExactly({
      projectId,
      documentId,
      from: range.from,
      to: range.to,
      text: "beta",
      content: "The synthetic phrase needs attention.",
    });
  });

  it("posts a suggestion with the user-edited body unchanged", async function () {
    const fixture = postingFixture();
    const editedBody =
      "Please replace this phrase; I adjusted the AI draft before posting.";

    const result = await postAiReviewerArtifactComment({
      request: request(),
      artifact: suggestion(),
      content: editedBody,
      ...fixture,
    });

    expect(result).to.deep.equal({
      status: "posted",
      commentId: "thread-0001",
    });
    expect(fixture.postComment).to.have.been.calledOnceWithExactly({
      projectId,
      documentId,
      from: range.from,
      to: range.to,
      text: "beta",
      content: editedBody,
    });
  });

  it("posts after the revision advances when the captured content still matches", async function () {
    const fixture = livePostingFixture();

    try {
      const result = await postAiReviewerArtifactComment({
        request: request(),
        artifact: suggestion(),
        content: "Please replace this phrase.",
        ...fixture,
      });

      expect(result).to.deep.equal({
        status: "posted",
        commentId: "thread-0001",
      });
      expect(fixture.postComment).to.have.been.calledOnceWithExactly({
        projectId,
        documentId,
        from: range.from,
        to: range.to,
        text: "beta",
        content: "Please replace this phrase.",
      });
    } finally {
      fixture.dispose();
    }
  });

  it("rejects posting after the revision advances when the captured content differs", async function () {
    const fixture = livePostingFixture({
      text: "Alpha zeta gamma.",
    });

    try {
      const result = await postAiReviewerArtifactComment({
        request: request(),
        artifact: suggestion(),
        content: "Please replace this phrase.",
        ...fixture,
      });

      expect(result).to.deep.equal({
        status: "conflict",
        code: "AI_COMMENT_RANGE_STALE",
      });
      expect(fixture.postComment).not.to.have.been.called;
    } finally {
      fixture.dispose();
    }
  });

  it("rejects a citation finding before invoking the comment path", async function () {
    const fixture = postingFixture();

    const result = await postAiReviewerArtifactComment({
      request: request(),
      artifact: citationFinding(),
      content: "A synthetic citation.",
      ...fixture,
    });

    expect(result).to.deep.equal({
      status: "conflict",
      code: "AI_COMMENT_ARTIFACT_NOT_POSTABLE",
    });
    expect(fixture.navigateEvidence).not.to.have.been.called;
    expect(fixture.postComment).not.to.have.been.called;
  });

  it("refuses a stale range before invoking the comment path", async function () {
    const fixture = postingFixture({
      text: "Alpha zeta gamma.",
    });

    const result = await postAiReviewerArtifactComment({
      request: request(),
      artifact: suggestion(),
      content: "Please replace this phrase.",
      ...fixture,
    });

    expect(result).to.deep.equal({
      status: "conflict",
      code: "AI_COMMENT_RANGE_STALE",
    });
    expect(fixture.navigateEvidence).to.have.been.calledOnce;
    expect(fixture.postComment).not.to.have.been.called;
  });

  it("preserves an unconfirmed posting code in the call result", async function () {
    const fixture = postingFixture();
    fixture.postComment.rejects(
      Object.assign(new TypeError("response unavailable"), {
        code: "AI_REVIEWER_COMMENT_POST_UNCERTAIN",
      }),
    );

    const result = await postAiReviewerArtifactComment({
      request: request(),
      artifact: suggestion(),
      content: "Please replace this phrase.",
      ...fixture,
    });

    expect(result).to.deep.equal({
      status: "error",
      code: "AI_REVIEWER_COMMENT_POST_UNCERTAIN",
    });
  });
});
