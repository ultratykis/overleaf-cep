import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isVisual } from "@/features/source-editor/extensions/visual/visual";

import { aiReviewerDocumentIdentity } from "../extensions/document-identity";
import {
  applySelectedSingleDocumentSuggestion,
  type EditorSuggestionApplicationConflictCode,
  type EditorSuggestionContext,
  type EditorSuggestionContextResult,
  type SelectedEditorSuggestionApplicationResult,
} from "./editor-suggestion-application";
import type {
  EditorSelectionSession,
  EditorSelectionSessionContext,
} from "./editor-selection-session";
import {
  compileSelectedSuggestionHunks,
  type CompiledSuggestionHunks,
} from "./detached-suggestion-diff";

export type EditorSuggestionLiveContextResult =
  | {
      status: "ready";
      view: EditorView;
      context: EditorSuggestionContext;
    }
  | {
      status: "conflict";
      code: EditorSuggestionApplicationConflictCode;
    };

type CompileSelectedSuggestionHunks = (
  options: Parameters<typeof compileSelectedSuggestionHunks>[0],
) => Promise<CompiledSuggestionHunks>;

type ApplySelectedEditorSelectionSuggestionOptions = {
  session: EditorSelectionSession;
  suggestion: unknown;
  selectedHunkIds: unknown;
  getContext: () => EditorSelectionSessionContext;
  signal: AbortSignal;
  compileSelectedSuggestionHunks?: CompileSelectedSuggestionHunks;
  hashText?: (text: string) => Promise<string>;
};

function conflict(
  code: EditorSuggestionApplicationConflictCode,
): EditorSuggestionLiveContextResult {
  return {
    status: "conflict",
    code,
  };
}

function contextConflict(
  code: EditorSuggestionApplicationConflictCode,
): Extract<EditorSuggestionContextResult, { status: "conflict" }> {
  return {
    status: "conflict",
    code,
  };
}

function readCommittedContext(
  getContext: () => EditorSelectionSessionContext,
): EditorSuggestionLiveContextResult {
  let context: EditorSelectionSessionContext;
  try {
    context = getContext();
  } catch {
    return conflict("AI_EDITOR_SYNC_PENDING");
  }
  return readEditorSuggestionLiveContext(context);
}

function readEditorSuggestionLiveContextUnsafe(
  hostContext: EditorSelectionSessionContext | null | undefined,
): EditorSuggestionLiveContextResult {
  if (hostContext == null) {
    return conflict("AI_EDITOR_DOCUMENT_UNBOUND");
  }
  const view = hostContext.view;
  const documentId = hostContext.currentDocumentId;
  const path = hostContext.path;
  const currentDocument = hostContext.currentDocument;

  if (
    view == null ||
    documentId == null ||
    path == null ||
    currentDocument == null ||
    currentDocument.doc_id !== documentId
  ) {
    return conflict("AI_EDITOR_DOCUMENT_UNBOUND");
  }

  const identity = view.state.facet(aiReviewerDocumentIdentity);
  if (
    identity == null ||
    identity.documentId !== documentId ||
    identity.currentDocument !== currentDocument ||
    currentDocument.cm6?.view !== view
  ) {
    return conflict("AI_EDITOR_DOCUMENT_UNBOUND");
  }
  if (!hostContext.sourceMode || isVisual(view)) {
    return conflict("AI_EDITOR_SOURCE_MODE_REQUIRED");
  }
  if (!hostContext.connected) {
    return conflict("AI_EDITOR_OFFLINE");
  }

  const shareDocument = currentDocument.doc;
  if (
    !currentDocument.joined ||
    shareDocument == null ||
    shareDocument.connection?.state !== "ok"
  ) {
    return conflict("AI_EDITOR_SYNC_PENDING");
  }

  let revisionBefore: number;
  let revisionAfter: number;
  let realtimeText: string | undefined;
  let hasBufferedOps: boolean | undefined;
  let realtimeTrackChanges: boolean;
  try {
    revisionBefore = shareDocument.getVersion();
    realtimeText = currentDocument.getSnapshot();
    hasBufferedOps = currentDocument.hasBufferedOps();
    realtimeTrackChanges = currentDocument.getTrackingChanges();
    revisionAfter = shareDocument.getVersion();
  } catch {
    return conflict("AI_EDITOR_SYNC_PENDING");
  }
  if (
    !Number.isSafeInteger(revisionBefore) ||
    revisionBefore < 0 ||
    revisionAfter !== revisionBefore ||
    typeof realtimeText !== "string" ||
    hasBufferedOps !== false ||
    typeof realtimeTrackChanges !== "boolean" ||
    currentDocument.doc !== shareDocument
  ) {
    return conflict("AI_EDITOR_SYNC_PENDING");
  }

  const trackChanges = hostContext.trackChanges;
  const wantTrackChanges = hostContext.wantTrackChanges;
  if (
    typeof trackChanges !== "boolean" ||
    typeof wantTrackChanges !== "boolean" ||
    trackChanges !== wantTrackChanges ||
    trackChanges !== realtimeTrackChanges
  ) {
    return conflict("AI_EDITOR_TRACK_CHANGES_PENDING");
  }

  const canWrite =
    hostContext.permissions?.read === true &&
    (trackChanges
      ? hostContext.permissions.trackedWrite === true
      : hostContext.permissions.write === true);
  if (!canWrite) {
    return conflict("AI_EDITOR_PERMISSION_DENIED");
  }
  if (
    view.state.facet(EditorState.readOnly) ||
    !view.state.facet(EditorView.editable)
  ) {
    return conflict("AI_EDITOR_READ_ONLY");
  }
  if (view.state.doc.toString() !== realtimeText) {
    return conflict("AI_EDITOR_DIVERGED");
  }

  return {
    status: "ready",
    view,
    context: {
      projectId: hostContext.projectId,
      documentId,
      path,
      revision: revisionBefore,
      currentDocument,
      shareDocument,
      realtimeText,
      sourceMode: hostContext.sourceMode,
      connected: hostContext.connected,
      joined: currentDocument.joined,
      documentConnectionState: shareDocument.connection.state,
      hasBufferedOps,
      canWrite,
      trackChanges,
      wantTrackChanges,
      realtimeTrackChanges,
    },
  };
}

export function readEditorSuggestionLiveContext(
  hostContext: EditorSelectionSessionContext | null | undefined,
): EditorSuggestionLiveContextResult {
  try {
    return readEditorSuggestionLiveContextUnsafe(hostContext);
  } catch {
    return conflict("AI_EDITOR_SYNC_PENDING");
  }
}

export async function applySelectedEditorSelectionSuggestion({
  session,
  suggestion,
  selectedHunkIds,
  getContext,
  signal,
  compileSelectedSuggestionHunks: compileHunks,
  hashText,
}: ApplySelectedEditorSelectionSuggestionOptions): Promise<SelectedEditorSuggestionApplicationResult> {
  if (signal.aborted) {
    return {
      status: "cancelled",
    };
  }

  const initial = readCommittedContext(getContext);
  if (initial.status === "conflict") {
    return initial;
  }
  if (
    initial.context.currentDocument !== session.binding.currentDocument ||
    initial.context.shareDocument !== session.binding.shareDocument
  ) {
    return contextConflict("AI_EDITOR_DOCUMENT_UNBOUND");
  }
  if (initial.context.trackChanges !== session.binding.trackChanges) {
    return contextConflict("AI_EDITOR_TRACK_CHANGES_PENDING");
  }

  const initialView = initial.view;
  return applySelectedSingleDocumentSuggestion({
    view: initialView,
    request: session.request,
    suggestion,
    selectedHunkIds,
    binding: session.binding,
    getContext: () => {
      const current = readCommittedContext(getContext);
      if (current.status === "conflict") {
        return current;
      }
      if (current.view !== initialView) {
        return contextConflict("AI_EDITOR_DOCUMENT_UNBOUND");
      }
      return {
        status: "ready",
        context: current.context,
      };
    },
    signal,
    compileSelectedSuggestionHunks: compileHunks,
    hashText,
  });
}
