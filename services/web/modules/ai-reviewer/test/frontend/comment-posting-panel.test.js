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
  commentPostingErrorMessage,
} = require("../../frontend/js/components/ai-reviewer-panel");
const {
  postAiReviewerArtifactComment,
} = require("../../frontend/js/services/editor-artifact-comment-posting");

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
  postingError,
  mountSuggestionPreview,
  applySelectionSuggestion,
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
  const postEditorComment =
    postingError == null
      ? sinon.stub().resolves({ commentId: "comment-posted" })
      : sinon.stub().rejects(postingError);

  render(
    React.createElement(AiReviewerPanelView, {
      projectId,
      createRequestId: () => requestId,
      captureSelectionSession,
      selectionPreview: {
        filename: "main.tex",
        fromLine: 1,
        toLine: 1,
        wordCount: 3,
      },
      streamRequest,
      getSelectionContext: selectionContext,
      navigateEvidence,
      postEditorComment,
      mountSuggestionPreview,
      applySelectionSuggestion,
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

  it("releases a suggestion comment draft when the suggestion is applied", async function () {
    const mountSuggestionPreview = sinon.stub().callsFake(async (options) => {
      options.onSelectionChange(["hunk-comment-posting"]);
      return {
        hunkIds: Object.freeze(["hunk-comment-posting"]),
        destroy: sinon.stub(),
      };
    });
    const applySelectionSuggestion = sinon.stub().resolves({
      status: "applied",
    });
    await renderCompletedPanel({
      mountSuggestionPreview,
      applySelectionSuggestion,
    });
    const suggestions = screen.getByRole("region", {
      name: "Review suggestions",
    });

    fireEvent.click(
      within(suggestions).getByRole("button", {
        name: "Post suggestion as comment",
      }),
    );
    expect(within(suggestions).getByRole("textbox", { name: "Comment body" }))
      .to.exist;
    fireEvent.click(
      within(suggestions).getByRole("button", {
        name: "Apply",
      }),
    );

    await waitFor(
      () =>
        expect(
          within(suggestions).queryByRole("textbox", { name: "Comment body" }),
        ).not.to.exist,
    );
    const findings = screen.getByRole("region", {
      name: "Review findings",
    });
    const postFinding = within(findings).getByRole("button", {
      name: "Post finding as comment",
    });
    expect(postFinding.disabled).to.equal(false);
    fireEvent.click(postFinding);
    expect(within(findings).getByRole("textbox", { name: "Comment body" })).to
      .exist;
  });

  it("keeps an edited suggestion comment draft when applying conflicts", async function () {
    const mountSuggestionPreview = sinon.stub().callsFake(async (options) => {
      options.onSelectionChange(["hunk-comment-conflict"]);
      return {
        hunkIds: Object.freeze(["hunk-comment-conflict"]),
        destroy: sinon.stub(),
      };
    });
    const applySelectionSuggestion = sinon.stub().resolves({
      status: "conflict",
      code: "AI_EDITOR_DIVERGED",
    });
    await renderCompletedPanel({
      mountSuggestionPreview,
      applySelectionSuggestion,
    });
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
    fireEvent.change(body, {
      target: { value: "Keep this carefully edited draft." },
    });
    fireEvent.click(
      within(suggestions).getByRole("button", {
        name: "Apply",
      }),
    );

    await within(suggestions).findByText("Status: Conflict");
    expect(
      within(suggestions).getByRole("textbox", { name: "Comment body" }).value,
    ).to.equal("Keep this carefully edited draft.");
  });

  it("does not offer a posting action for a citation finding", async function () {
    const { postEditorComment } = await renderCompletedPanel();
    // Both kinds of finding share the one pinned list, so the card is what
    // bounds the assertion.
    const citationFinding = screen
      .getByText("Synthetic citation issue")
      .closest(".ai-reviewer-artifact");

    expect(
      within(citationFinding).queryByRole("button", {
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
    expect(
      within(
        screen
          .getByText("Ambiguous synthetic phrase")
          .closest(".ai-reviewer-artifact"),
      ).getByText("Status: Unresolved"),
    ).to.exist;
    expect(postEditorComment.called).to.equal(false);
  });

  it("warns against retrying when the posting response is unconfirmed", async function () {
    const { postEditorComment } = await renderCompletedPanel({
      postingError: Object.assign(new TypeError("response unavailable"), {
        code: "AI_REVIEWER_COMMENT_POST_UNCERTAIN",
      }),
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
      "We couldn't confirm whether the comment was posted. Reload the page to check before trying again, because retrying now may post a duplicate.",
    );
    expect(postEditorComment.calledOnce).to.equal(true);
  });

  it("keeps concurrent uncertain and failed result wording isolated", async function () {
    const uncertain = deferred();
    const failed = deferred();
    const postingOptions = {
      request: request(),
      artifact: ordinaryFinding(),
      content: "Synthetic comment.",
      getContext: selectionContext,
      navigateEvidence: sinon.stub().resolves({ status: "navigated" }),
      signal: new AbortController().signal,
    };
    const uncertainPosting = postAiReviewerArtifactComment({
      ...postingOptions,
      postComment: () => uncertain.promise,
    });
    const failedPosting = postAiReviewerArtifactComment({
      ...postingOptions,
      postComment: () => failed.promise,
    });
    await Promise.resolve();
    await Promise.resolve();
    failed.reject(
      Object.assign(new Error("rejected"), {
        code: "AI_REVIEWER_COMMENT_POST_FAILED",
      }),
    );
    uncertain.reject(
      Object.assign(new Error("response unavailable"), {
        code: "AI_REVIEWER_COMMENT_POST_UNCERTAIN",
      }),
    );
    const [uncertainResult, failedResult] = await Promise.all([
      uncertainPosting,
      failedPosting,
    ]);
    const t = (key, defaultValue) =>
      defaultValue ??
      {
        ai_reviewer_comment_post_failed: "The comment could not be posted.",
      }[key] ??
      key;

    expect(uncertainResult).to.deep.equal({
      status: "error",
      code: "AI_REVIEWER_COMMENT_POST_UNCERTAIN",
    });
    expect(failedResult).to.deep.equal({
      status: "error",
      code: "AI_REVIEWER_COMMENT_POST_FAILED",
    });
    expect(commentPostingErrorMessage(uncertainResult, t)).to.equal(
      "We couldn't confirm whether the comment was posted. Reload the page to check before trying again, because retrying now may post a duplicate.",
    );
    expect(commentPostingErrorMessage(failedResult, t)).to.equal(
      "The comment could not be posted.",
    );
  });
});
