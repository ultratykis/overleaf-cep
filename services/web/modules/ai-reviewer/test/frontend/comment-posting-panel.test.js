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
const sinon = require("sinon");

const {
  AiReviewerPanelView,
} = require("../../frontend/js/components/ai-reviewer-panel");

const createdAt = "2026-07-26T00:00:00.000Z";
const projectId = "project-comment-posting";
const documentId = "document-comment-posting";
const path = "chapters/main.tex";
const baseText = "Alpha beta gamma.";
const baseTextHash =
  "aea23d46109af9b94c5f15085d69113cc2cefa85f05748897a4df172a1ee5104";
const requestId = "request-comment-posting";
const findingMessage = "The selected phrase needs a more precise term.";
const suggestionRationale = "Use a more precise synthetic term.";

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
    requestId,
    projectId,
    action: "review",
    instruction: "Review the selected phrase.",
    skill: "referee-review",
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

function session(sourceRequest) {
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
    request: sourceRequest,
    binding: Object.freeze({
      currentDocument,
      shareDocument: currentDocument.doc,
      trackChanges: false,
    }),
  });
}

function eventBase(sequence, type) {
  return {
    type,
    eventId: `event-${sequence}`,
    requestId,
    sequence,
    createdAt,
  };
}

function ordinaryFinding() {
  return {
    id: "finding-comment-posting",
    requestId,
    projectId,
    artifactKind: "finding",
    severity: "warning",
    category: "clarity",
    title: "Ambiguous synthetic phrase",
    message: findingMessage,
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
    suggestionIds: ["suggestion-comment-posting"],
  };
}

function citationFinding() {
  return {
    ...ordinaryFinding(),
    id: "citation-finding-comment-posting",
    artifactKind: "citation-finding",
    title: "Synthetic citation issue",
    proposedText: "Add the missing synthetic bibliography entry.",
    suggestionIds: [],
  };
}

function suggestion() {
  return {
    id: "suggestion-comment-posting",
    requestId,
    projectId,
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
    rationale: suggestionRationale,
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
    skill: "referee-review",
    createdAt,
    status: "unresolved",
  };
}

function reviewEvents() {
  return [
    {
      ...eventBase(0, "started"),
      type: "started",
      provider: "fake",
      model: "deterministic-v1",
      skill: "referee-review",
    },
    {
      ...eventBase(1, "finding"),
      type: "finding",
      finding: ordinaryFinding(),
    },
    {
      ...eventBase(2, "finding"),
      type: "finding",
      finding: citationFinding(),
    },
    {
      ...eventBase(3, "suggestion"),
      type: "suggestion",
      suggestion: suggestion(),
    },
    {
      ...eventBase(4, "completed"),
      type: "completed",
      finishReason: "stop",
    },
  ];
}

function selectionContext() {
  return {
    projectId,
    currentDocumentId: documentId,
    path,
    currentDocument: {
      doc_id: documentId,
    },
    view: {
      state: {
        doc: {
          length: baseText.length,
        },
        sliceDoc: (from, to) => baseText.slice(from, to),
      },
    },
  };
}

async function renderCompletedPanel({
  navigationResult = {
    status: "navigated",
  },
} = {}) {
  const sourceRequest = request();
  const capture = deferred();
  const stream = deferred();
  let streamCall;
  const captureSelectionSession = sinon.stub().returns(capture.promise);
  const streamRequest = sinon.stub().callsFake((call) => {
    streamCall = call;
    return stream.promise;
  });
  const navigateEvidence = sinon.stub().resolves(navigationResult);
  const postEditorComment = sinon.stub().resolves({
    commentId: "comment-posted",
  });

  render(
    React.createElement(AiReviewerPanelView, {
      projectId,
      createRequestId: () => requestId,
      captureSelectionSession,
      streamRequest,
      getSelectionContext: selectionContext,
      navigateEvidence,
      postEditorComment,
    }),
  );

  fireEvent.click(
    screen.getByRole("button", {
      name: "Review selection",
    }),
  );
  await screen.findByText("Capturing review target");
  await act(async () => {
    capture.resolve({
      status: "ready",
      session: session(sourceRequest),
    });
    await capture.promise;
  });
  await waitFor(() => expect(streamRequest.calledOnce).to.equal(true));
  act(() => {
    for (const event of reviewEvents()) {
      streamCall.onEvent(event);
    }
  });
  await act(async () => {
    stream.resolve();
    await stream.promise;
  });
  await screen.findByText("Completed");

  return {
    navigateEvidence,
    postEditorComment,
  };
}

describe("AI reviewer comment-posting panel", function () {
  it("posts an unedited finding body and displays its Posted state", async function () {
    const { postEditorComment } = await renderCompletedPanel();
    const findings = screen.getByRole("region", {
      name: "Review findings",
    });

    fireEvent.click(
      within(findings).getByRole("button", {
        name: "Post finding as comment",
      }),
    );
    const body = within(findings).getByRole("textbox", {
      name: "Comment body",
    });
    expect(body.value).to.equal(findingMessage);
    expect(body.disabled).to.equal(false);

    fireEvent.click(
      within(findings).getByRole("button", {
        name: "Post comment",
      }),
    );

    await waitFor(() => expect(postEditorComment.calledOnce).to.equal(true));
    expect(
      postEditorComment.calledOnceWithExactly({
        projectId,
        documentId,
        from: 6,
        to: 10,
        text: "beta",
        content: findingMessage,
      }),
    ).to.equal(true);
    expect(within(findings).getByText("Status: Posted")).to.exist;
  });

  it("posts an edited suggestion body and displays its Posted state", async function () {
    const { postEditorComment } = await renderCompletedPanel();
    const suggestions = screen.getByRole("region", {
      name: "Review suggestions",
    });

    fireEvent.click(
      within(suggestions).getByRole("button", {
        name: "Post suggestion as comment",
      }),
    );
    const body = within(suggestions).getByRole("textbox", {
      name: "Comment body",
    });
    expect(body.value).to.equal(
      `${suggestionRationale}\n\nSuggested replacement:\nclear`,
    );
    fireEvent.change(body, {
      target: {
        value: "Edited suggestion comment.",
      },
    });
    expect(body.value).to.equal("Edited suggestion comment.");

    fireEvent.click(
      within(suggestions).getByRole("button", {
        name: "Post comment",
      }),
    );

    await waitFor(() => expect(postEditorComment.calledOnce).to.equal(true));
    expect(
      postEditorComment.calledOnceWithExactly({
        projectId,
        documentId,
        from: 6,
        to: 10,
        text: "beta",
        content: "Edited suggestion comment.",
      }),
    ).to.equal(true);
    expect(within(suggestions).getByText("Status: Posted")).to.exist;
  });

  it("does not offer a posting action for a citation finding", async function () {
    const { postEditorComment } = await renderCompletedPanel();
    const citationFindings = screen.getByRole("region", {
      name: "Review citation findings",
    });

    expect(
      within(citationFindings).queryByRole("button", {
        name: /Post .* as comment/u,
      }),
    ).not.to.exist;
    expect(postEditorComment.called).to.equal(false);
  });

  it("keeps a finding unresolved and explains a stale manuscript range", async function () {
    const { postEditorComment } = await renderCompletedPanel({
      navigationResult: {
        status: "opened",
      },
    });
    const findings = screen.getByRole("region", {
      name: "Review findings",
    });

    fireEvent.click(
      within(findings).getByRole("button", {
        name: "Post finding as comment",
      }),
    );
    fireEvent.click(
      within(findings).getByRole("button", {
        name: "Post comment",
      }),
    );

    expect((await within(findings).findByRole("alert")).textContent).to.equal(
      "Comment was not posted because the manuscript changed and the artifact range no longer matches.",
    );
    expect(within(findings).getByText("Status: Unresolved")).to.exist;
    expect(postEditorComment.called).to.equal(false);
  });
});
