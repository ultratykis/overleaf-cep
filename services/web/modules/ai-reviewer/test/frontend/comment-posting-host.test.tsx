import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { cleanup, render, screen } from "@testing-library/react";
import { expect } from "chai";
import fetchMock from "fetch-mock";
import React from "react";
import sinon from "sinon";

import { ProjectProvider } from "@/shared/context/project-context";
import { postCommentMessageAfterRangeValidation } from "@/features/review-panel/context/threads-context";
import AiAssistedCommentLabel from "../../frontend/js/components/ai-assisted-comment-label";
import {
  loadAiReviewerCommentProvenance,
  recordAiReviewerCommentProvenance,
  releaseAiReviewerCommentProvenance,
  reserveAiReviewerCommentProvenance,
  resetAiReviewerCommentProvenanceForTests,
  snapshotAiReviewerCommentProvenance,
} from "../../frontend/js/services/ai-reviewer-comment-provenance";
import {
  AiReviewerCommentPostingError,
  createAiReviewerCommentPoster,
  postAiReviewerComment,
  registerAiReviewerCommentPoster,
  resetAiReviewerCommentPosterForTests,
  type PostAiReviewerCommentInput,
} from "../../frontend/js/services/ai-reviewer-comment-posting";
import type {
  EditorSelectionDocument,
  EditorSelectionSessionContext,
} from "../../frontend/js/services/editor-selection-session";

const projectId = "a".repeat(24);
const otherProjectId = "b".repeat(24);
const documentId = "c".repeat(24);
const commentId = "d".repeat(24);
const csrfToken = "synthetic-comment-csrf";

let hadProjectId: boolean;
let previousProjectId: string | undefined;
let hadCsrfToken: boolean;
let previousCsrfToken: string | undefined;

const input: PostAiReviewerCommentInput = {
  projectId,
  documentId,
  from: 6,
  to: 12,
  text: "target",
  content: "Editable AI-assisted comment.",
};

function liveContext(text = "alpha target omega") {
  const view = {
    state: EditorState.create({ doc: text }),
  } as unknown as EditorView;
  const currentDocument = {
    doc_id: documentId,
    joined: true,
    doc: {
      connection: { state: "ok" },
      getVersion: () => 1,
    },
    cm6: { view },
    getSnapshot: () => text,
    hasBufferedOps: () => false,
    getTrackingChanges: () => false,
  } satisfies EditorSelectionDocument;
  const context: EditorSelectionSessionContext = {
    view,
    projectId,
    currentDocumentId: documentId,
    path: "main.tex",
    currentDocument,
    sourceMode: true,
    connected: true,
    connectionEpoch: 1,
    permissions: {
      read: true,
      write: true,
      trackedWrite: true,
    },
    trackChanges: false,
    wantTrackChanges: false,
  };
  return context;
}

async function rejectedError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
}

describe("AI reviewer: ordinary comment host bridge", function () {
  beforeEach(function () {
    hadProjectId = window.metaAttributesCache.has("ol-project_id");
    previousProjectId = window.metaAttributesCache.get("ol-project_id");
    hadCsrfToken = window.metaAttributesCache.has("ol-csrfToken");
    previousCsrfToken = window.metaAttributesCache.get("ol-csrfToken");
    window.metaAttributesCache.set("ol-project_id", projectId);
    window.metaAttributesCache.set("ol-csrfToken", csrfToken);
  });

  afterEach(function () {
    cleanup();
    fetchMock.removeRoutes().clearHistory();
    resetAiReviewerCommentPosterForTests();
    resetAiReviewerCommentProvenanceForTests();
    sinon.restore();
    if (hadProjectId) {
      window.metaAttributesCache.set("ol-project_id", previousProjectId);
    } else {
      window.metaAttributesCache.delete("ol-project_id");
    }
    if (hadCsrfToken) {
      window.metaAttributesCache.set("ol-csrfToken", previousCsrfToken);
    } else {
      window.metaAttributesCache.delete("ol-csrfToken");
    }
  });

  it("reserves provenance, rechecks the exact anchor, and posts with the same identifier", async function () {
    const context = liveContext();
    const reserveProvenance = sinon
      .stub()
      .resolves({ commentId, created: true });
    const releaseProvenance = sinon.stub().resolves();
    const addComment = sinon.stub().resolves(commentId);
    const recordProvenance = sinon.stub();
    const post = createAiReviewerCommentPoster({
      projectId,
      getContext: () => context,
      generateCommentId: () => commentId,
      reserveProvenance,
      releaseProvenance,
      addComment,
      recordProvenance,
    });

    expect(await post(input)).to.deep.equal({ commentId });
    expect(reserveProvenance).to.have.been.calledOnceWithExactly(
      projectId,
      commentId,
    );
    expect(addComment).to.have.been.calledOnce;
    expect(addComment.firstCall.args.slice(0, 4)).to.deep.equal([
      input.from,
      input.text,
      input.content,
      commentId,
    ]);
    expect(addComment.firstCall.args[4]()).to.equal(true);
    expect(recordProvenance).to.have.been.calledOnceWithExactly(
      projectId,
      commentId,
    );
    expect(releaseProvenance).not.to.have.been.called;
  });

  it("refuses a changed range after reservation and rolls back only a new reservation", async function () {
    for (const created of [true, false]) {
      let context = liveContext();
      const reserveProvenance = sinon.stub().callsFake(async () => {
        context = liveContext("alpha changed omega");
        return { commentId, created };
      });
      const releaseProvenance = sinon.stub().resolves();
      const addComment = sinon.stub().resolves(commentId);
      const post = createAiReviewerCommentPoster({
        projectId,
        getContext: () => context,
        generateCommentId: () => commentId,
        reserveProvenance,
        releaseProvenance,
        addComment,
        recordProvenance: sinon.stub(),
      });

      const error = await rejectedError(post(input));
      expect(error).to.be.instanceOf(AiReviewerCommentPostingError);
      expect((error as AiReviewerCommentPostingError).code).to.equal(
        "AI_REVIEWER_COMMENT_RANGE_STALE",
      );
      expect(addComment).not.to.have.been.called;
      expect(releaseProvenance.callCount).to.equal(created ? 1 : 0);
    }
  });

  it("exposes one stable posting function and a bounded unavailable error", async function () {
    const unavailable = await rejectedError(postAiReviewerComment(input));
    expect(unavailable).to.be.instanceOf(AiReviewerCommentPostingError);
    expect((unavailable as AiReviewerCommentPostingError).code).to.equal(
      "AI_REVIEWER_COMMENT_HOST_UNAVAILABLE",
    );

    const post = sinon.stub().resolves({ commentId });
    const unregister = registerAiReviewerCommentPoster(post);
    expect(await postAiReviewerComment(input)).to.deep.equal({ commentId });
    expect(post).to.have.been.calledOnceWithExactly(input);

    unregister();
    const unregistered = await rejectedError(postAiReviewerComment(input));
    expect((unregistered as AiReviewerCommentPostingError).code).to.equal(
      "AI_REVIEWER_COMMENT_HOST_UNAVAILABLE",
    );
  });

  it("maps a host range rejection before message creation and rolls back provenance", async function () {
    let context = liveContext();
    const releaseProvenance = sinon.stub().resolves();
    const addComment = sinon
      .stub()
      .callsFake(async (_from, _text, _content, _commentId, validateRange) => {
        context = liveContext("alpha changed omega");
        if (!validateRange()) {
          throw Object.assign(new Error("stale"), {
            code: "AI_REVIEWER_COMMENT_RANGE_STALE",
          });
        }
        return commentId;
      });
    const post = createAiReviewerCommentPoster({
      projectId,
      getContext: () => context,
      generateCommentId: () => commentId,
      reserveProvenance: sinon.stub().resolves({ commentId, created: true }),
      releaseProvenance,
      addComment,
      recordProvenance: sinon.stub(),
    });

    const error = await rejectedError(post(input));
    expect(error).to.be.instanceOf(AiReviewerCommentPostingError);
    expect((error as AiReviewerCommentPostingError).code).to.equal(
      "AI_REVIEWER_COMMENT_RANGE_STALE",
    );
    expect(releaseProvenance).to.have.been.calledOnceWithExactly(
      projectId,
      commentId,
    );
  });

  it("uses bodyless project-scoped provenance requests and keeps identifiers only", async function () {
    fetchMock.get(`/project/${projectId}/ai-reviewer/comment-provenance`, {
      commentIds: [commentId],
    });
    fetchMock.put(
      `/project/${projectId}/ai-reviewer/comment-provenance/${commentId}`,
      { commentId, created: true },
    );
    fetchMock.delete(
      `/project/${projectId}/ai-reviewer/comment-provenance/${commentId}`,
      { status: 204 },
    );

    expect(await loadAiReviewerCommentProvenance(projectId)).to.deep.equal([
      commentId,
    ]);
    expect(
      await reserveAiReviewerCommentProvenance(projectId, commentId),
    ).to.deep.equal({ commentId, created: true });
    await releaseAiReviewerCommentProvenance(projectId, commentId);

    const collectionCalls = fetchMock.callHistory.calls(
      `/project/${projectId}/ai-reviewer/comment-provenance`,
    );
    const reserveCalls = fetchMock.callHistory.calls(
      `/project/${projectId}/ai-reviewer/comment-provenance/${commentId}`,
      { method: "PUT" },
    );
    const releaseCalls = fetchMock.callHistory.calls(
      `/project/${projectId}/ai-reviewer/comment-provenance/${commentId}`,
      { method: "DELETE" },
    );
    expect(collectionCalls).to.have.length(1);
    expect(reserveCalls).to.have.length(1);
    expect(releaseCalls).to.have.length(1);
    expect(reserveCalls[0].options.body).to.equal(undefined);
    expect(releaseCalls[0].options.body).to.equal(undefined);

    recordAiReviewerCommentProvenance(projectId, commentId);
    expect(snapshotAiReviewerCommentProvenance(projectId)).to.deep.equal([
      commentId,
    ]);
    expect(snapshotAiReviewerCommentProvenance(otherProjectId)).to.deep.equal(
      [],
    );
  });

  it("keeps the label when the comment body is edited", function () {
    recordAiReviewerCommentProvenance(projectId, commentId);
    const { rerender } = render(
      <ProjectProvider>
        <AiAssistedCommentLabel commentId={commentId}>
          <span>Original body</span>
        </AiAssistedCommentLabel>
      </ProjectProvider>,
    );

    expect(screen.getByText("AI-assisted")).to.exist;
    expect(screen.getByText("Original body")).to.exist;

    rerender(
      <ProjectProvider>
        <AiAssistedCommentLabel commentId={commentId}>
          <span>Edited body</span>
        </AiAssistedCommentLabel>
      </ProjectProvider>,
    );
    expect(screen.getByText("AI-assisted")).to.exist;
    expect(screen.getByText("Edited body")).to.exist;
    expect(screen.queryByText("Original body")).not.to.exist;
  });

  it("leaves no message behind when the host range validation is stale", async function () {
    const messages: string[] = [];
    const postMessage = sinon.stub().callsFake(async () => {
      messages.push(input.content);
    });

    const error = await rejectedError(
      postCommentMessageAfterRangeValidation(
        postMessage,
        commentId,
        () => false,
      ),
    );

    expect((error as Error & { code?: string }).code).to.equal(
      "AI_REVIEWER_COMMENT_RANGE_STALE",
    );
    expect(postMessage).not.to.have.been.called;
    expect(messages).to.deep.equal([]);
    expect(fetchMock.callHistory.calls()).to.have.length(0);
  });
});
