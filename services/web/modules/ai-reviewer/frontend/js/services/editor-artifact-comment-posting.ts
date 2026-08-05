import {
  AgentRequestSchema,
  FindingSchema,
  SuggestionSchema,
} from "../../../shared/contracts.mjs";
import type {
  AgentRequest,
  Finding,
  UnresolvedSuggestion,
} from "../../../shared/contract-types";
import {
  navigateToEditorEvidence,
  type EditorEvidenceNavigationTarget,
  type OpenEditorEvidenceDocument,
  type ResolveEditorEvidenceDocument,
} from "./editor-evidence-navigation";
import type { EditorSelectionSessionContext } from "./editor-selection-session";

type OrdinaryFinding = Extract<Finding, { artifactKind: "finding" }>;
type NavigateEvidence = typeof navigateToEditorEvidence;

export type PostableAiReviewerArtifact = OrdinaryFinding | UnresolvedSuggestion;

export type PostEditorComment = (input: {
  projectId: string;
  documentId: string;
  from: number;
  to: number;
  text: string;
  content: string;
}) => Promise<{ commentId: string }>;

export type ArtifactCommentPostingResult =
  | {
      status: "posted";
      commentId: string;
    }
  | {
      status: "conflict";
      code:
        | "AI_COMMENT_ARTIFACT_NOT_POSTABLE"
        | "AI_COMMENT_DOCUMENT_UNAVAILABLE"
        | "AI_COMMENT_RANGE_STALE";
    }
  | {
      status: "cancelled";
    }
  | {
      status: "error";
      code:
        | "AI_COMMENT_POST_FAILED"
        | "AI_REVIEWER_COMMENT_POST_FAILED"
        | "AI_REVIEWER_COMMENT_POST_UNCERTAIN";
    };

export type ArtifactCommentPostingOptions = {
  request: AgentRequest;
  artifact: PostableAiReviewerArtifact;
  content: string;
  getContext: () => EditorSelectionSessionContext;
  resolveDocument?: ResolveEditorEvidenceDocument;
  openDocument?: OpenEditorEvidenceDocument;
  signal: AbortSignal;
  navigateEvidence?: NavigateEvidence;
  postComment: PostEditorComment;
};

function isAbortError(error: unknown, signal: AbortSignal) {
  return (
    signal.aborted ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

function expectedFindingText(
  request: AgentRequest,
  range: Readonly<{ from: number; to: number }>,
) {
  if (request.scope.kind === "project") {
    return null;
  }
  const offset =
    request.scope.kind === "selection" ? request.scope.range.from : 0;
  const from = range.from - offset;
  const to = range.to - offset;
  if (from < 0 || to < from || to > request.scope.text.length) {
    return null;
  }
  return request.scope.text.slice(from, to);
}

function targetForArtifact(
  requestInput: unknown,
  artifactInput: unknown,
): {
  request: AgentRequest;
  artifact: PostableAiReviewerArtifact;
  target: EditorEvidenceNavigationTarget;
  expectedText: string | null;
  documentId: string | null;
} | null {
  const parsedRequest = AgentRequestSchema.safeParse(requestInput);
  if (!parsedRequest.success) {
    return null;
  }
  const request = parsedRequest.data;

  const parsedFinding = FindingSchema.safeParse(artifactInput);
  if (parsedFinding.success) {
    const finding = parsedFinding.data;
    if (
      finding.artifactKind !== "finding" ||
      finding.requestId !== request.requestId ||
      finding.projectId !== request.projectId
    ) {
      return null;
    }
    const reference = finding.evidence.find(
      (candidate) => candidate.range != null,
    );
    if (reference?.range == null) {
      return null;
    }
    const scope =
      request.scope.kind !== "project" && request.scope.path === reference.path
        ? request.scope
        : null;
    const revision = reference.revision ?? scope?.baseRevision;
    const textHash = reference.textHash ?? scope?.baseTextHash;
    const expectedText =
      scope == null ? null : expectedFindingText(request, reference.range);
    if (expectedText == null && revision == null && textHash == null) {
      return null;
    }
    return {
      request,
      artifact: finding,
      target: Object.freeze({
        kind: "project",
        requestId: request.requestId,
        findingId: finding.id,
        projectId: request.projectId,
        path: reference.path,
        range: Object.freeze({ ...reference.range }),
        ...(revision == null ? {} : { revision }),
        ...(textHash == null ? {} : { textHash }),
      }),
      expectedText,
      documentId: scope?.documentId ?? null,
    };
  }

  const parsedSuggestion = SuggestionSchema.safeParse(artifactInput);
  if (!parsedSuggestion.success) {
    return null;
  }
  const suggestion = parsedSuggestion.data;
  if (
    suggestion.status !== "unresolved" ||
    suggestion.requestId !== request.requestId ||
    suggestion.projectId !== request.projectId
  ) {
    return null;
  }
  return {
    request,
    artifact: suggestion,
    target: Object.freeze({
      kind: "project",
      requestId: request.requestId,
      findingId: suggestion.id,
      projectId: request.projectId,
      path: suggestion.path,
      range: Object.freeze({ ...suggestion.range }),
      revision: suggestion.baseRevision,
      textHash: suggestion.baseTextHash,
    }),
    expectedText: suggestion.original,
    documentId: suggestion.documentId,
  };
}

function liveAnchor(
  prepared: NonNullable<ReturnType<typeof targetForArtifact>>,
  getContext: () => EditorSelectionSessionContext,
) {
  let context: EditorSelectionSessionContext;
  try {
    context = getContext();
  } catch {
    return null;
  }
  const view = context.view;
  const currentDocument = context.currentDocument;
  const range = prepared.target.range;
  if (
    view == null ||
    currentDocument == null ||
    context.projectId !== prepared.request.projectId ||
    context.path !== prepared.target.path ||
    context.currentDocumentId == null ||
    currentDocument.doc_id !== context.currentDocumentId ||
    (prepared.documentId != null &&
      context.currentDocumentId !== prepared.documentId) ||
    range.to > view.state.doc.length
  ) {
    return null;
  }
  let text: string;
  try {
    text = view.state.sliceDoc(range.from, range.to);
  } catch {
    return null;
  }
  if (prepared.expectedText != null && text !== prepared.expectedText) {
    return null;
  }
  return {
    projectId: prepared.request.projectId,
    documentId: context.currentDocumentId,
    from: range.from,
    to: range.to,
    text,
  };
}

function postingFailure(error: unknown): ArtifactCommentPostingResult {
  const code =
    typeof error === "object" &&
    error != null &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : null;
  if (code === "AI_REVIEWER_COMMENT_RANGE_STALE") {
    return {
      status: "conflict",
      code: "AI_COMMENT_RANGE_STALE",
    };
  }
  if (code === "AI_REVIEWER_COMMENT_HOST_UNAVAILABLE") {
    return {
      status: "conflict",
      code: "AI_COMMENT_DOCUMENT_UNAVAILABLE",
    };
  }
  if (
    code === "AI_REVIEWER_COMMENT_POST_FAILED" ||
    code === "AI_REVIEWER_COMMENT_POST_UNCERTAIN"
  ) {
    return {
      status: "error",
      code,
    };
  }
  return {
    status: "error",
    code: "AI_COMMENT_POST_FAILED",
  };
}

export async function postAiReviewerArtifactComment({
  request,
  artifact,
  content,
  getContext,
  resolveDocument,
  openDocument,
  signal,
  navigateEvidence = navigateToEditorEvidence,
  postComment,
}: ArtifactCommentPostingOptions): Promise<ArtifactCommentPostingResult> {
  const prepared = targetForArtifact(request, artifact);
  if (prepared == null || content.trim() === "") {
    return {
      status: "conflict",
      code: "AI_COMMENT_ARTIFACT_NOT_POSTABLE",
    };
  }
  if (signal.aborted) {
    return {
      status: "cancelled",
    };
  }

  let navigationResult;
  try {
    navigationResult = await navigateEvidence({
      target: prepared.target,
      getContext,
      signal,
      resolveDocument,
      openDocument,
    });
  } catch (error) {
    return isAbortError(error, signal)
      ? { status: "cancelled" }
      : { status: "error", code: "AI_COMMENT_POST_FAILED" };
  }
  if (signal.aborted || navigationResult.status === "cancelled") {
    return {
      status: "cancelled",
    };
  }
  if (navigationResult.status !== "navigated") {
    return {
      status: "conflict",
      code:
        navigationResult.status === "opened" ||
        (navigationResult.status === "conflict" &&
          (navigationResult.code === "AI_EVIDENCE_STATE_STALE" ||
            navigationResult.code === "AI_EVIDENCE_RANGE_INVALID"))
          ? "AI_COMMENT_RANGE_STALE"
          : "AI_COMMENT_DOCUMENT_UNAVAILABLE",
    };
  }

  const anchor = liveAnchor(prepared, getContext);
  if (anchor == null) {
    return {
      status: "conflict",
      code: "AI_COMMENT_RANGE_STALE",
    };
  }

  try {
    return {
      status: "posted",
      ...(await postComment({
        ...anchor,
        content,
      })),
    };
  } catch (error) {
    return isAbortError(error, signal)
      ? { status: "cancelled" }
      : postingFailure(error);
  }
}
