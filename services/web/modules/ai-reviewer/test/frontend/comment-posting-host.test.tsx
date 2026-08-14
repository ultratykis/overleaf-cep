import { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { cleanup, render, screen } from "@testing-library/react";
import { expect } from "chai";
import fetchMock from "fetch-mock";
import React from "react";
import sinon from "sinon";

import { ProjectProvider } from "@/shared/context/project-context";
import { aiReviewerCommentProvenanceId } from "@/features/review-panel/components/review-panel-comment-content";
import { postCommentMessageAfterRangeValidation } from "@/features/review-panel/context/threads-context";
import { FetchError } from "@/infrastructure/fetch-json";
import AiAssistedCommentLabel from "../../frontend/js/components/ai-assisted-comment-label";
import {
  loadAiReviewerCommentProvenance,
  lookupAiReviewerCommentProvenance,
  confirmAiReviewerReplyProvenance,
  recordAiReviewerCommentProvenance,
  releaseAiReviewerCommentProvenance,
  reserveAiReviewerCommentProvenance,
  reserveAiReviewerReplyProvenance,
  resetAiReviewerCommentProvenanceForTests,
  snapshotAiReviewerCommentProvenance,
} from "../../frontend/js/services/ai-reviewer-comment-provenance";
import {
  AiReviewerCommentPostingError,
  createAiReviewerCommentPoster,
  createAiReviewerReplyPoster,
  postAiReviewerComment,
  postAiReviewerReply,
  registerAiReviewerCommentPoster,
  registerAiReviewerReplyPoster,
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
const threadId = "e".repeat(24);
const replyMessageId = "f".repeat(24);
const runId = "run-comment-posting";
const artifactId = "artifact-comment-posting";
const csrfToken = "synthetic-comment-csrf";

let hadProjectId: boolean;
let previousProjectId: string | undefined;
let hadCsrfToken: boolean;
let previousCsrfToken: string | undefined;

const input: PostAiReviewerCommentInput = {
  projectId,
  runId,
  artifactId,
  documentId,
  from: 6,
  to: 12,
  text: "target",
  content: "Editable AI-assisted comment.",
};

const replyInput = {
  projectId,
  runId: "discussion-comment-reply",
  artifactId: "reply:1",
  threadId,
  content: "Editable AI-assisted reply.",
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
      .resolves({ commentId, created: true, confirmed: false });
    const releaseProvenance = sinon.stub().resolves();
    const addComment = sinon.stub().resolves(commentId);
    const recordProvenance = sinon.stub();
    const post = createAiReviewerCommentPoster({
      projectId,
      getContext: () => context,
      generateCommentId: () => commentId,
      lookupProvenance: sinon.stub().resolves(null),
      reserveProvenance,
      releaseProvenance,
      addComment,
      recordProvenance,
    });

    expect(await post(input)).to.deep.equal({ commentId });
    expect(reserveProvenance).to.have.been.calledOnceWithExactly(
      projectId,
      commentId,
      runId,
      artifactId,
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

  // An unconfirmed claim may already have a comment behind it. Releasing it
  // would let the next attempt mint a second identifier and post the duplicate
  // the claim exists to prevent (#141).
  it("keeps an earlier attempt's claim when a retry finds the range stale", async function () {
    const staleContext = liveContext("nothing here matches the reviewed text");
    const releaseProvenance = sinon.stub().resolves();
    const addComment = sinon.stub().resolves(commentId);
    const post = createAiReviewerCommentPoster({
      projectId,
      getContext: () => staleContext,
      generateCommentId: () => commentId,
      lookupProvenance: sinon.stub().resolves({ commentId, confirmed: false }),
      reserveProvenance: sinon
        .stub()
        .resolves({ commentId, created: false, confirmed: false }),
      releaseProvenance,
      addComment,
      recordProvenance: sinon.stub(),
    });

    const error = await rejectedError(post(input));

    expect(error).to.be.instanceOf(AiReviewerCommentPostingError);
    expect((error as AiReviewerCommentPostingError).code).to.equal(
      "AI_REVIEWER_COMMENT_RANGE_STALE",
    );
    expect(releaseProvenance).not.to.have.been.called;
    expect(addComment).not.to.have.been.called;
  });

  it("posts one keyed artifact once and returns its confirmed comment on retry", async function () {
    let context = liveContext();
    const lookupProvenance = sinon
      .stub()
      .onFirstCall()
      .resolves(null)
      .onSecondCall()
      .resolves({ commentId, confirmed: true });
    const generateCommentId = sinon.stub().returns(commentId);
    const addComment = sinon.stub().resolves(commentId);
    const recordProvenance = sinon.stub();
    const post = createAiReviewerCommentPoster({
      projectId,
      getContext: () => context,
      generateCommentId,
      lookupProvenance,
      reserveProvenance: sinon
        .stub()
        .resolves({ commentId, created: true, confirmed: false }),
      releaseProvenance: sinon.stub().resolves(),
      addComment,
      recordProvenance,
    });

    expect(await post(input)).to.deep.equal({ commentId });
    context = liveContext("alpha changed omega");
    expect(await post(input)).to.deep.equal({ commentId });
    expect(addComment).to.have.been.calledOnce;
    expect(generateCommentId).to.have.been.calledOnce;
    expect(recordProvenance).to.have.been.calledTwice;
  });

  it("keeps an uncertain claim and retries with the same comment identifier", async function () {
    const context = liveContext();
    const lookupProvenance = sinon
      .stub()
      .onFirstCall()
      .resolves(null)
      .onSecondCall()
      .resolves({ commentId, confirmed: false });
    const generateCommentId = sinon.stub().returns(commentId);
    const addComment = sinon
      .stub()
      .onFirstCall()
      .rejects(new TypeError("response lost"))
      .onSecondCall()
      .resolves(commentId);
    const releaseProvenance = sinon.stub().resolves();
    const post = createAiReviewerCommentPoster({
      projectId,
      getContext: () => context,
      generateCommentId,
      lookupProvenance,
      reserveProvenance: sinon
        .stub()
        .resolves({ commentId, created: true, confirmed: false }),
      releaseProvenance,
      addComment,
      recordProvenance: sinon.stub(),
    });

    const error = await rejectedError(post(input));
    expect((error as AiReviewerCommentPostingError).code).to.equal(
      "AI_REVIEWER_COMMENT_POST_UNCERTAIN",
    );
    expect(await post(input)).to.deep.equal({ commentId });
    expect(generateCommentId).to.have.been.calledOnce;
    expect(addComment.firstCall.args[3]).to.equal(commentId);
    expect(addComment.secondCall.args[3]).to.equal(commentId);
    expect(releaseProvenance).not.to.have.been.called;
  });

  it("releases a rejected claim so a later attempt can reserve a new identifier", async function () {
    const nextCommentId = "e".repeat(24);
    const context = liveContext();
    const generatedIds = [commentId, nextCommentId];
    const addComment = sinon
      .stub()
      .onFirstCall()
      .rejects(
        new FetchError(
          "rejected",
          "/synthetic-comment",
          {},
          new Response(null, { status: 400 }),
        ),
      )
      .onSecondCall()
      .resolves(nextCommentId);
    const releaseProvenance = sinon.stub().resolves();
    const post = createAiReviewerCommentPoster({
      projectId,
      getContext: () => context,
      generateCommentId: () => generatedIds.shift()!,
      lookupProvenance: sinon.stub().resolves(null),
      reserveProvenance: async (_projectId, reservedCommentId) => ({
        commentId: reservedCommentId,
        created: true,
        confirmed: false,
      }),
      releaseProvenance,
      addComment,
      recordProvenance: sinon.stub(),
    });

    const error = await rejectedError(post(input));
    expect((error as AiReviewerCommentPostingError).code).to.equal(
      "AI_REVIEWER_COMMENT_POST_FAILED",
    );
    expect(await post(input)).to.deep.equal({ commentId: nextCommentId });
    expect(releaseProvenance).to.have.been.calledOnceWithExactly(
      projectId,
      commentId,
    );
  });

  it("posts different artifacts in one run independently", async function () {
    const otherCommentId = "e".repeat(24);
    const generatedIds = [commentId, otherCommentId];
    const context = liveContext();
    const addComment = sinon
      .stub()
      .callsFake(async (_from, _text, _content, reservedCommentId) =>
        String(reservedCommentId),
      );
    const post = createAiReviewerCommentPoster({
      projectId,
      getContext: () => context,
      generateCommentId: () => generatedIds.shift()!,
      lookupProvenance: sinon.stub().resolves(null),
      reserveProvenance: async (_projectId, reservedCommentId) => ({
        commentId: reservedCommentId,
        created: true,
        confirmed: false,
      }),
      releaseProvenance: sinon.stub().resolves(),
      addComment,
      recordProvenance: sinon.stub(),
    });

    expect(await post(input)).to.deep.equal({ commentId });
    expect(
      await post({ ...input, artifactId: "another-artifact" }),
    ).to.deep.equal({ commentId: otherCommentId });
    expect(addComment).to.have.been.calledTwice;
  });

  it("posts one keyed reply to the intended existing thread exactly once", async function () {
    const lookupProvenance = sinon
      .stub()
      .onFirstCall()
      .resolves(null)
      .onSecondCall()
      .resolves({
        commentId,
        confirmed: true,
        threadId,
        messageId: replyMessageId,
      });
    const addReply = sinon.stub().resolves(replyMessageId);
    const recordProvenance = sinon.stub();
    const post = createAiReviewerReplyPoster({
      projectId,
      generateCommentId: () => commentId,
      lookupProvenance,
      reserveProvenance: sinon.stub().resolves({
        commentId,
        created: true,
        confirmed: false,
        threadId,
        messageId: null,
      }),
      confirmProvenance: sinon.stub().resolves({
        commentId,
        confirmed: true,
        threadId,
        messageId: replyMessageId,
      }),
      releaseProvenance: sinon.stub().resolves(),
      addReply,
      recordProvenance,
    });

    expect(await post(replyInput)).to.deep.equal({ commentId: replyMessageId });
    expect(await post(replyInput)).to.deep.equal({ commentId: replyMessageId });
    expect(addReply).to.have.been.calledOnceWithExactly(
      threadId,
      replyInput.content,
    );
    expect(recordProvenance).to.have.been.calledTwice;
    expect(recordProvenance.firstCall.args).to.deep.equal([
      projectId,
      replyMessageId,
    ]);
    expect(recordProvenance.secondCall.args).to.deep.equal([
      projectId,
      replyMessageId,
    ]);
  });

  it("keeps an ambiguous reply claim and does not post again on retry", async function () {
    const addReply = sinon
      .stub()
      .rejects(new TypeError("response unavailable"));
    const releaseProvenance = sinon.stub().resolves();
    const lookupProvenance = sinon
      .stub()
      .onFirstCall()
      .resolves(null)
      .onSecondCall()
      .resolves({
        commentId,
        confirmed: false,
        threadId,
        messageId: null,
      });
    const post = createAiReviewerReplyPoster({
      projectId,
      generateCommentId: () => commentId,
      lookupProvenance,
      reserveProvenance: sinon.stub().resolves({
        commentId,
        created: true,
        confirmed: false,
        threadId,
        messageId: null,
      }),
      confirmProvenance: sinon.stub(),
      releaseProvenance,
      addReply,
      recordProvenance: sinon.stub(),
    });

    const first = await rejectedError(post(replyInput));
    const retry = await rejectedError(post(replyInput));
    expect((first as AiReviewerCommentPostingError).code).to.equal(
      "AI_REVIEWER_COMMENT_POST_UNCERTAIN",
    );
    expect((retry as AiReviewerCommentPostingError).code).to.equal(
      "AI_REVIEWER_COMMENT_POST_UNCERTAIN",
    );
    expect(addReply).to.have.been.calledOnce;
    expect(releaseProvenance).not.to.have.been.called;
  });

  it("releases a reply claim only after a definite host rejection", async function () {
    for (const [error, expectedRollbacks] of [
      [
        new FetchError(
          "rejected",
          "/synthetic-reply",
          {},
          new Response(null, { status: 400 }),
        ),
        1,
      ],
      [new TypeError("response unavailable"), 0],
    ] as const) {
      const releaseProvenance = sinon.stub().resolves();
      const post = createAiReviewerReplyPoster({
        projectId,
        generateCommentId: () => commentId,
        lookupProvenance: sinon.stub().resolves(null),
        reserveProvenance: sinon.stub().resolves({
          commentId,
          created: true,
          confirmed: false,
          threadId,
          messageId: null,
        }),
        confirmProvenance: sinon.stub(),
        releaseProvenance,
        addReply: sinon.stub().rejects(error),
        recordProvenance: sinon.stub(),
      });

      await rejectedError(post(replyInput));
      expect(releaseProvenance.callCount).to.equal(expectedRollbacks);
    }
  });

  it("refuses a changed range after reservation and releases the keyed claim", async function () {
    for (const created of [true, false]) {
      let context = liveContext();
      const reserveProvenance = sinon.stub().callsFake(async () => {
        context = liveContext("alpha changed omega");
        return { commentId, created, confirmed: false };
      });
      const releaseProvenance = sinon.stub().resolves();
      const addComment = sinon.stub().resolves(commentId);
      const post = createAiReviewerCommentPoster({
        projectId,
        getContext: () => context,
        generateCommentId: () => commentId,
        lookupProvenance: sinon.stub().resolves(null),
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
      // Releasing is only safe for a claim this attempt created. A claim that
      // already existed may have a comment behind it from an attempt that
      // ended unconfirmed, so it is kept rather than freed for a second post.
      if (created) {
        expect(releaseProvenance).to.have.been.calledOnceWithExactly(
          projectId,
          commentId,
        );
      } else {
        expect(releaseProvenance).not.to.have.been.called;
      }
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

    const replyUnavailable = await rejectedError(
      postAiReviewerReply(replyInput),
    );
    expect((replyUnavailable as AiReviewerCommentPostingError).code).to.equal(
      "AI_REVIEWER_COMMENT_HOST_UNAVAILABLE",
    );
    const postReply = sinon.stub().resolves({ commentId: replyMessageId });
    const unregisterReply = registerAiReviewerReplyPoster(postReply);
    expect(await postAiReviewerReply(replyInput)).to.deep.equal({
      commentId: replyMessageId,
    });
    unregisterReply();
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
      lookupProvenance: sinon.stub().resolves(null),
      reserveProvenance: sinon
        .stub()
        .resolves({ commentId, created: true, confirmed: false }),
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

  it("rolls back a clear HTTP rejection but retains an unconfirmed reservation", async function () {
    for (const [error, expectedCode, expectedRollbacks] of [
      [
        new FetchError(
          "rejected",
          "/synthetic-comment",
          {},
          new Response(null, { status: 400 }),
        ),
        "AI_REVIEWER_COMMENT_POST_FAILED",
        1,
      ],
      [
        new TypeError("network response unavailable"),
        "AI_REVIEWER_COMMENT_POST_UNCERTAIN",
        0,
      ],
    ] as const) {
      const releaseProvenance = sinon.stub().resolves();
      const context = liveContext();
      const post = createAiReviewerCommentPoster({
        projectId,
        getContext: () => context,
        generateCommentId: () => commentId,
        lookupProvenance: sinon.stub().resolves(null),
        reserveProvenance: sinon
          .stub()
          .resolves({ commentId, created: true, confirmed: false }),
        releaseProvenance,
        addComment: sinon.stub().rejects(error),
        recordProvenance: sinon.stub(),
      });

      const postingError = await rejectedError(post(input));
      expect((postingError as AiReviewerCommentPostingError).code).to.equal(
        expectedCode,
      );
      expect(releaseProvenance.callCount).to.equal(expectedRollbacks);
    }
  });

  it("keeps concurrent uncertain and failed posting results isolated", async function () {
    const failedCommentId = "e".repeat(24);
    const context = liveContext();
    const rejections = new Map<string, (error: unknown) => void>();
    const releaseProvenance = sinon.stub().resolves();
    const generatedCommentIds = [commentId, failedCommentId];
    const post = createAiReviewerCommentPoster({
      projectId,
      getContext: () => context,
      generateCommentId: () => generatedCommentIds.shift()!,
      lookupProvenance: sinon.stub().resolves(null),
      reserveProvenance: async (_projectId, reservedCommentId) => ({
        commentId: reservedCommentId,
        created: true,
        confirmed: false,
      }),
      releaseProvenance,
      addComment: async (_from, _text, _content, reservedCommentId) =>
        await new Promise<string>((_resolve, reject) => {
          rejections.set(reservedCommentId, reject);
        }),
      recordProvenance: sinon.stub(),
    });

    const uncertainPosting = rejectedError(post(input));
    const failedPosting = rejectedError(
      post({ ...input, content: "Second synthetic comment." }),
    );
    await Promise.resolve();
    await Promise.resolve();
    rejections.get(failedCommentId)!(
      new FetchError(
        "rejected",
        "/synthetic-comment",
        {},
        new Response(null, { status: 400 }),
      ),
    );
    rejections.get(commentId)!(new TypeError("network response unavailable"));

    const [uncertainError, failedError] = await Promise.all([
      uncertainPosting,
      failedPosting,
    ]);
    expect((uncertainError as AiReviewerCommentPostingError).code).to.equal(
      "AI_REVIEWER_COMMENT_POST_UNCERTAIN",
    );
    expect((failedError as AiReviewerCommentPostingError).code).to.equal(
      "AI_REVIEWER_COMMENT_POST_FAILED",
    );
    expect(releaseProvenance).to.have.been.calledOnceWithExactly(
      projectId,
      failedCommentId,
    );
  });

  it("preserves the posting error when rollback itself fails", async function () {
    let context = liveContext();
    const post = createAiReviewerCommentPoster({
      projectId,
      getContext: () => context,
      generateCommentId: () => commentId,
      lookupProvenance: sinon.stub().resolves(null),
      reserveProvenance: sinon.stub().callsFake(async () => {
        context = liveContext("alpha changed omega");
        return { commentId, created: true, confirmed: false };
      }),
      releaseProvenance: sinon.stub().rejects(new Error("rollback failed")),
      addComment: sinon.stub(),
      recordProvenance: sinon.stub(),
    });

    const error = await rejectedError(post(input));
    expect((error as AiReviewerCommentPostingError).code).to.equal(
      "AI_REVIEWER_COMMENT_RANGE_STALE",
    );
  });

  it("uses bodyless project-scoped provenance requests and keeps identifiers only", async function () {
    const keyedPath = `/project/${projectId}/ai-reviewer/comment-provenance?runId=${runId}&artifactId=${artifactId}`;
    const keyedCommentPath = `/project/${projectId}/ai-reviewer/comment-provenance/${commentId}?runId=${runId}&artifactId=${artifactId}`;
    const replyReservePath = `/project/${projectId}/ai-reviewer/comment-provenance/${commentId}?runId=${replyInput.runId}&artifactId=reply%3A1&threadId=${threadId}`;
    const replyConfirmPath = `${replyReservePath}&messageId=${replyMessageId}`;
    fetchMock.get(`/project/${projectId}/ai-reviewer/comment-provenance`, {
      commentIds: [commentId],
    });
    fetchMock.get(keyedPath, {
      reservation: { commentId, confirmed: false },
    });
    fetchMock.put(keyedCommentPath, {
      commentId,
      created: true,
      confirmed: false,
    });
    fetchMock.put(replyReservePath, {
      commentId,
      created: true,
      confirmed: false,
      threadId,
      messageId: null,
    });
    fetchMock.put(replyConfirmPath, {
      commentId,
      confirmed: true,
      threadId,
      messageId: replyMessageId,
    });
    fetchMock.delete(
      `/project/${projectId}/ai-reviewer/comment-provenance/${commentId}`,
      { status: 204 },
    );

    expect(await loadAiReviewerCommentProvenance(projectId)).to.deep.equal([
      commentId,
    ]);
    expect(
      await lookupAiReviewerCommentProvenance(projectId, runId, artifactId),
    ).to.deep.equal({ commentId, confirmed: false });
    expect(
      await reserveAiReviewerCommentProvenance(
        projectId,
        commentId,
        runId,
        artifactId,
      ),
    ).to.deep.equal({ commentId, created: true, confirmed: false });
    expect(
      await reserveAiReviewerReplyProvenance(
        projectId,
        commentId,
        replyInput.runId,
        replyInput.artifactId,
        threadId,
      ),
    ).to.deep.equal({
      commentId,
      created: true,
      confirmed: false,
      threadId,
      messageId: null,
    });
    expect(
      await confirmAiReviewerReplyProvenance(
        projectId,
        commentId,
        replyInput.runId,
        replyInput.artifactId,
        threadId,
        replyMessageId,
      ),
    ).to.deep.equal({
      commentId,
      confirmed: true,
      threadId,
      messageId: replyMessageId,
    });
    await releaseAiReviewerCommentProvenance(projectId, commentId);

    const collectionCalls = fetchMock.callHistory.calls(
      `/project/${projectId}/ai-reviewer/comment-provenance`,
    );
    const reserveCalls = fetchMock.callHistory.calls(keyedCommentPath, {
      method: "PUT",
    });
    const releaseCalls = fetchMock.callHistory.calls(
      `/project/${projectId}/ai-reviewer/comment-provenance/${commentId}`,
      { method: "DELETE" },
    );
    expect(collectionCalls).to.have.length(1);
    expect(fetchMock.callHistory.calls(keyedPath)).to.have.length(1);
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

  it("labels only the AI-assisted reply in a human-started thread", function () {
    expect(
      aiReviewerCommentProvenanceId(
        threadId as never,
        replyMessageId as never,
        false,
      ),
    ).to.equal(threadId);
    expect(
      aiReviewerCommentProvenanceId(
        threadId as never,
        replyMessageId as never,
        true,
      ),
    ).to.equal(replyMessageId);
    recordAiReviewerCommentProvenance(projectId, replyMessageId);
    render(
      <ProjectProvider>
        <AiAssistedCommentLabel commentId={threadId}>
          <span>Human first message</span>
        </AiAssistedCommentLabel>
        <AiAssistedCommentLabel commentId={replyMessageId}>
          <span>AI-assisted reply</span>
        </AiAssistedCommentLabel>
        <AiAssistedCommentLabel commentId={commentId}>
          <span>Other human reply</span>
        </AiAssistedCommentLabel>
      </ProjectProvider>,
    );

    expect(screen.getAllByText("AI-assisted")).to.have.length(1);
    expect(
      screen.getByText("AI-assisted reply").closest(".review-panel-comment"),
    ).not.to.equal(null);
    expect(
      screen.getByText("Human first message").closest(".review-panel-comment"),
    ).to.equal(null);
    expect(
      screen.getByText("Other human reply").closest(".review-panel-comment"),
    ).to.equal(null);
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
