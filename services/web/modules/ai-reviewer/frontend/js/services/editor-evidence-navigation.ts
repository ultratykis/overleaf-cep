import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

import {
  AgentRequestSchema,
  FindingSchema,
} from "../../../shared/contracts.mjs";
import type { Finding } from "../../../shared/contract-types";
import { aiReviewerDocumentIdentity } from "../extensions/document-identity";
import type {
  EditorSelectionDocument,
  EditorSelectionSession,
  EditorSelectionSessionContext,
  EditorSelectionShareDocument,
} from "./editor-selection-session";

export type EditorEvidenceNavigationTarget = Readonly<{
  requestId: string;
  findingId: string;
  projectId: string;
  documentId: string;
  path: string;
  baseRevision: number;
  baseTextHash: string;
  selectionRange: Readonly<{
    from: number;
    to: number;
  }>;
  range: Readonly<{
    from: number;
    to: number;
  }>;
  currentDocument: EditorSelectionDocument;
  shareDocument: EditorSelectionShareDocument;
}>;

export type EditorEvidenceNavigationConflictCode =
  | "AI_EVIDENCE_DOCUMENT_MISMATCH"
  | "AI_EVIDENCE_EDITOR_UNAVAILABLE"
  | "AI_EVIDENCE_PATH_MISMATCH"
  | "AI_EVIDENCE_PERMISSION_DENIED"
  | "AI_EVIDENCE_PROJECT_MISMATCH"
  | "AI_EVIDENCE_RANGE_INVALID"
  | "AI_EVIDENCE_REFERENCE_INVALID"
  | "AI_EVIDENCE_STATE_STALE";

export type EditorEvidenceNavigationResult =
  | {
      status: "navigated";
    }
  | {
      status: "conflict";
      code: EditorEvidenceNavigationConflictCode;
    }
  | {
      status: "cancelled";
    }
  | {
      status: "error";
      code: "AI_EVIDENCE_HASH_FAILED" | "AI_EVIDENCE_NAVIGATION_FAILED";
    };

export type NavigateToEditorEvidenceOptions = {
  target: EditorEvidenceNavigationTarget;
  getContext: () => EditorSelectionSessionContext;
  signal: AbortSignal;
  hashText?: (text: string) => Promise<string>;
};

type LiveEvidenceContext = {
  view: EditorView;
  currentDocument: EditorSelectionDocument;
  shareDocument: EditorSelectionShareDocument;
  projectId: string;
  currentDocumentId: string;
  path: string;
  sourceMode: boolean;
  revision: number;
  text: string;
};

type LiveEvidenceContextResult =
  | {
      status: "ready";
      snapshot: LiveEvidenceContext;
    }
  | {
      status: "conflict";
      code: EditorEvidenceNavigationConflictCode;
    };

type HashOutcome =
  | {
      status: "ready";
      value: string;
    }
  | {
      status: "cancelled";
    }
  | {
      status: "error";
    };

const sha256Pattern = /^[a-f0-9]{64}$/;

function conflict(
  code: EditorEvidenceNavigationConflictCode,
): EditorEvidenceNavigationResult {
  return {
    status: "conflict",
    code,
  };
}

function validRange(
  range: unknown,
): range is Readonly<{ from: number; to: number }> {
  return (
    typeof range === "object" &&
    range != null &&
    "from" in range &&
    "to" in range &&
    typeof range.from === "number" &&
    typeof range.to === "number" &&
    Number.isSafeInteger(range.from) &&
    Number.isSafeInteger(range.to) &&
    range.from >= 0 &&
    range.to >= range.from
  );
}

function positionIsAtomic(view: EditorView, position: number): boolean {
  for (const provideRanges of view.state.facet(EditorView.atomicRanges)) {
    let isAtomic = false;
    provideRanges(view).between(position, position, (from, to) => {
      if (from <= position && to > position) {
        isAtomic = true;
      }
    });
    if (isAtomic) {
      return true;
    }
  }
  return false;
}

function evidenceRangeHasAtomicEndpoint(
  view: EditorView,
  range: Readonly<{ from: number; to: number }>,
): boolean {
  return (
    positionIsAtomic(view, range.from) ||
    (range.to !== range.from && positionIsAtomic(view, range.to))
  );
}

function visualPreambleEnd(view: EditorView): number | null {
  const tree = ensureSyntaxTree(view.state, view.state.doc.length, 100);
  if (tree == null || tree.length !== view.state.doc.length) {
    return null;
  }

  let end = 0;
  let seenDocumentEnvironment = false;
  tree.iterate({
    enter(nodeRef) {
      const node = nodeRef.node;
      if (node.type.is("Maketitle")) {
        let environment = node.parent;
        while (environment != null && !environment.type.is("$Environment")) {
          environment = environment.parent;
        }
        if (environment?.type.is("DocumentEnvironment")) {
          end = node.from;
        }
      } else if (node.type.is("DocumentEnvironment")) {
        if (!seenDocumentEnvironment) {
          end = node.getChild("Content")?.from ?? node.from;
          seenDocumentEnvironment = true;
        }
      } else if (node.type.is("Title") || node.type.is("Author")) {
        if (node.getChild("TextArgument") != null) {
          end = node.to;
        }
      } else if (node.type.is("Affil") || node.type.is("Affiliation")) {
        if (node.getChild("TextArgument") != null) {
          end = node.to;
        }
      }
    },
  });
  return end;
}

function evidenceRangeStartsInVisualPreamble({
  view,
  sourceMode,
  range,
}: {
  view: EditorView;
  sourceMode: boolean;
  range: Readonly<{ from: number; to: number }>;
}): boolean {
  if (sourceMode) {
    return false;
  }
  const preambleEnd = visualPreambleEnd(view);
  return preambleEnd == null || range.from < preambleEnd;
}

function validTarget(
  target: unknown,
): target is EditorEvidenceNavigationTarget {
  return (
    typeof target === "object" &&
    target != null &&
    "requestId" in target &&
    typeof target.requestId === "string" &&
    target.requestId.length > 0 &&
    "findingId" in target &&
    typeof target.findingId === "string" &&
    target.findingId.length > 0 &&
    "projectId" in target &&
    typeof target.projectId === "string" &&
    target.projectId.length > 0 &&
    "documentId" in target &&
    typeof target.documentId === "string" &&
    target.documentId.length > 0 &&
    "path" in target &&
    typeof target.path === "string" &&
    target.path.length > 0 &&
    "baseRevision" in target &&
    typeof target.baseRevision === "number" &&
    Number.isSafeInteger(target.baseRevision) &&
    target.baseRevision >= 0 &&
    "baseTextHash" in target &&
    typeof target.baseTextHash === "string" &&
    sha256Pattern.test(target.baseTextHash) &&
    "selectionRange" in target &&
    validRange(target.selectionRange) &&
    "range" in target &&
    validRange(target.range) &&
    target.range.from >= target.selectionRange.from &&
    target.range.to <= target.selectionRange.to &&
    "currentDocument" in target &&
    target.currentDocument != null &&
    "shareDocument" in target &&
    target.shareDocument != null
  );
}

function snapshotTarget(
  target: unknown,
): EditorEvidenceNavigationTarget | null {
  try {
    if (!validTarget(target)) {
      return null;
    }
    const snapshot = Object.freeze({
      requestId: target.requestId,
      findingId: target.findingId,
      projectId: target.projectId,
      documentId: target.documentId,
      path: target.path,
      baseRevision: target.baseRevision,
      baseTextHash: target.baseTextHash,
      selectionRange: Object.freeze({
        from: target.selectionRange.from,
        to: target.selectionRange.to,
      }),
      range: Object.freeze({
        from: target.range.from,
        to: target.range.to,
      }),
      currentDocument: target.currentDocument,
      shareDocument: target.shareDocument,
    });
    return validTarget(snapshot) ? snapshot : null;
  } catch {
    return null;
  }
}

export function createEditorEvidenceNavigationTarget({
  session,
  finding,
  evidenceIndex,
}: {
  session: EditorSelectionSession;
  finding: Finding;
  evidenceIndex: number;
}): EditorEvidenceNavigationTarget | null {
  try {
    const parsedRequest = AgentRequestSchema.safeParse(session.request);
    const parsedFinding = FindingSchema.safeParse(finding);
    if (!parsedRequest.success || !parsedFinding.success) {
      return null;
    }

    const request = parsedRequest.data;
    if (
      request.scope.kind === "project" ||
      !Number.isSafeInteger(evidenceIndex) ||
      evidenceIndex < 0
    ) {
      return null;
    }

    const scope = request.scope;
    const scopeFrom = scope.kind === "selection" ? scope.range.from : 0;
    const scopeTo =
      scope.kind === "selection" ? scope.range.to : scope.text.length;
    const acceptedFinding = parsedFinding.data;
    const reference = acceptedFinding.evidence[evidenceIndex];
    const currentDocument = session.binding?.currentDocument;
    const shareDocument = session.binding?.shareDocument;
    if (
      reference == null ||
      reference.range == null ||
      acceptedFinding.requestId !== request.requestId ||
      acceptedFinding.projectId !== request.projectId ||
      reference.path !== scope.path ||
      reference.range.from < scopeFrom ||
      reference.range.to > scopeTo ||
      (reference.revision != null &&
        reference.revision !== scope.baseRevision) ||
      (reference.textHash != null &&
        reference.textHash !== scope.baseTextHash) ||
      currentDocument == null ||
      shareDocument == null ||
      currentDocument.doc_id !== scope.documentId
    ) {
      return null;
    }

    const selectionRange = Object.freeze({
      from: scopeFrom,
      to: scopeTo,
    });
    const range = Object.freeze({
      from: reference.range.from,
      to: reference.range.to,
    });
    return Object.freeze({
      requestId: request.requestId,
      findingId: acceptedFinding.id,
      projectId: request.projectId,
      documentId: scope.documentId,
      path: scope.path,
      baseRevision: scope.baseRevision,
      baseTextHash: scope.baseTextHash,
      selectionRange,
      range,
      currentDocument,
      shareDocument,
    });
  } catch {
    return null;
  }
}

function captureLiveEvidenceContextUnsafe(
  target: EditorEvidenceNavigationTarget,
  getContext: () => EditorSelectionSessionContext,
): LiveEvidenceContextResult {
  const context = getContext();
  const view = context.view;
  if (view == null) {
    return {
      status: "conflict",
      code: "AI_EVIDENCE_EDITOR_UNAVAILABLE",
    };
  }
  if (context.projectId !== target.projectId) {
    return {
      status: "conflict",
      code: "AI_EVIDENCE_PROJECT_MISMATCH",
    };
  }
  const currentDocument = context.currentDocument;
  if (
    context.currentDocumentId !== target.documentId ||
    currentDocument == null ||
    currentDocument !== target.currentDocument ||
    currentDocument.doc_id !== target.documentId
  ) {
    return {
      status: "conflict",
      code: "AI_EVIDENCE_DOCUMENT_MISMATCH",
    };
  }
  if (context.path !== target.path) {
    return {
      status: "conflict",
      code: "AI_EVIDENCE_PATH_MISMATCH",
    };
  }
  const sourceMode = context.sourceMode;
  if (typeof sourceMode !== "boolean") {
    return {
      status: "conflict",
      code: "AI_EVIDENCE_STATE_STALE",
    };
  }

  const identity = view.state.facet(aiReviewerDocumentIdentity);
  if (
    identity == null ||
    identity.documentId !== target.documentId ||
    identity.currentDocument !== target.currentDocument ||
    currentDocument.cm6?.view !== view
  ) {
    return {
      status: "conflict",
      code: "AI_EVIDENCE_DOCUMENT_MISMATCH",
    };
  }
  if (context.permissions?.read !== true) {
    return {
      status: "conflict",
      code: "AI_EVIDENCE_PERMISSION_DENIED",
    };
  }
  if (!context.connected || !currentDocument.joined) {
    return {
      status: "conflict",
      code: "AI_EVIDENCE_STATE_STALE",
    };
  }

  const shareDocument = currentDocument.doc;
  if (
    shareDocument == null ||
    shareDocument !== target.shareDocument ||
    shareDocument.connection?.state !== "ok"
  ) {
    return {
      status: "conflict",
      code:
        shareDocument !== target.shareDocument
          ? "AI_EVIDENCE_DOCUMENT_MISMATCH"
          : "AI_EVIDENCE_STATE_STALE",
    };
  }

  const revisionBefore = shareDocument.getVersion();
  const text = currentDocument.getSnapshot();
  const hasBufferedOps = currentDocument.hasBufferedOps();
  const revisionAfter = shareDocument.getVersion();
  if (
    !Number.isSafeInteger(revisionBefore) ||
    revisionBefore < 0 ||
    revisionAfter !== revisionBefore ||
    revisionBefore !== target.baseRevision ||
    typeof text !== "string" ||
    hasBufferedOps !== false ||
    currentDocument.doc !== shareDocument
  ) {
    return {
      status: "conflict",
      code: "AI_EVIDENCE_STATE_STALE",
    };
  }

  const editorText = view.state.doc.toString();
  if (editorText !== text) {
    return {
      status: "conflict",
      code: "AI_EVIDENCE_STATE_STALE",
    };
  }
  if (
    target.selectionRange.to > editorText.length ||
    target.range.to > editorText.length
  ) {
    return {
      status: "conflict",
      code: "AI_EVIDENCE_RANGE_INVALID",
    };
  }
  if (evidenceRangeHasAtomicEndpoint(view, target.range)) {
    return {
      status: "conflict",
      code: "AI_EVIDENCE_RANGE_INVALID",
    };
  }
  if (
    evidenceRangeStartsInVisualPreamble({
      view,
      sourceMode,
      range: target.range,
    })
  ) {
    return {
      status: "conflict",
      code: "AI_EVIDENCE_RANGE_INVALID",
    };
  }

  return {
    status: "ready",
    snapshot: {
      view,
      currentDocument,
      shareDocument,
      projectId: context.projectId,
      currentDocumentId: context.currentDocumentId,
      path: context.path,
      sourceMode,
      revision: revisionBefore,
      text: editorText,
    },
  };
}

function captureLiveEvidenceContext(
  target: EditorEvidenceNavigationTarget,
  getContext: () => EditorSelectionSessionContext,
): LiveEvidenceContextResult {
  try {
    return captureLiveEvidenceContextUnsafe(target, getContext);
  } catch {
    return {
      status: "conflict",
      code: "AI_EVIDENCE_STATE_STALE",
    };
  }
}

function equalLiveEvidenceContext(
  before: LiveEvidenceContext,
  after: LiveEvidenceContext,
): boolean {
  return (
    before.view === after.view &&
    before.currentDocument === after.currentDocument &&
    before.shareDocument === after.shareDocument &&
    before.projectId === after.projectId &&
    before.currentDocumentId === after.currentDocumentId &&
    before.path === after.path &&
    before.sourceMode === after.sourceMode &&
    before.revision === after.revision &&
    before.text === after.text
  );
}

async function sha256Text(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hashWithCancellation({
  text,
  hashText,
  signal,
}: {
  text: string;
  hashText: (text: string) => Promise<string>;
  signal: AbortSignal;
}): Promise<HashOutcome> {
  if (signal.aborted) {
    return {
      status: "cancelled",
    };
  }

  let removeAbortListener = () => {};
  const aborted = new Promise<HashOutcome>((resolve) => {
    const onAbort = () => {
      resolve({
        status: "cancelled",
      });
    };
    signal.addEventListener("abort", onAbort, {
      once: true,
    });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
  });
  const hashed = Promise.resolve()
    .then(() => hashText(text))
    .then(
      (value): HashOutcome => ({
        status: "ready",
        value,
      }),
      (): HashOutcome => ({
        status: "error",
      }),
    );

  try {
    return await Promise.race([hashed, aborted]);
  } finally {
    removeAbortListener();
  }
}

export async function navigateToEditorEvidence({
  target,
  getContext,
  signal,
  hashText = sha256Text,
}: NavigateToEditorEvidenceOptions): Promise<EditorEvidenceNavigationResult> {
  if (signal.aborted) {
    return {
      status: "cancelled",
    };
  }
  const targetSnapshot = snapshotTarget(target);
  if (targetSnapshot == null) {
    return conflict("AI_EVIDENCE_REFERENCE_INVALID");
  }

  const before = captureLiveEvidenceContext(targetSnapshot, getContext);
  if (before.status === "conflict") {
    return before;
  }

  const hash = await hashWithCancellation({
    text: before.snapshot.text,
    hashText,
    signal,
  });
  if (hash.status === "cancelled" || signal.aborted) {
    return {
      status: "cancelled",
    };
  }
  if (hash.status === "error") {
    return {
      status: "error",
      code: "AI_EVIDENCE_HASH_FAILED",
    };
  }
  if (hash.value !== targetSnapshot.baseTextHash) {
    return conflict("AI_EVIDENCE_STATE_STALE");
  }

  const after = captureLiveEvidenceContext(targetSnapshot, getContext);
  if (after.status === "conflict") {
    return after;
  }
  if (!equalLiveEvidenceContext(before.snapshot, after.snapshot)) {
    return conflict("AI_EVIDENCE_STATE_STALE");
  }
  if (signal.aborted) {
    return {
      status: "cancelled",
    };
  }

  const selection = EditorSelection.range(
    targetSnapshot.range.from,
    targetSnapshot.range.to,
  );
  try {
    after.snapshot.view.dispatch({
      selection,
      effects: EditorView.scrollIntoView(selection, {
        y: "center",
      }),
      annotations: Transaction.userEvent.of("select.ai-reviewer.evidence"),
    });
    const appliedSelection = after.snapshot.view.state.selection;
    if (
      appliedSelection.ranges.length === 1 &&
      appliedSelection.main.anchor === targetSnapshot.range.from &&
      appliedSelection.main.head === targetSnapshot.range.to
    ) {
      return {
        status: "navigated",
      };
    }
  } catch {
    return {
      status: "error",
      code: "AI_EVIDENCE_NAVIGATION_FAILED",
    };
  }

  return {
    status: "error",
    code: "AI_EVIDENCE_NAVIGATION_FAILED",
  };
}
