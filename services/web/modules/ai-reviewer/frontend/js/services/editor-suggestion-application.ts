import { isolateHistory } from "@codemirror/commands";
import { type ChangeSet, EditorState, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isVisual } from "@/features/source-editor/extensions/visual/visual";

import { AgentRequestSchema } from "../../../shared/contracts.mjs";
import type { AgentRequest } from "../../../shared/contract-types";
import { aiReviewerDocumentIdentity } from "../extensions/document-identity";
import {
  compileSelectedSuggestionHunks,
  DetachedSuggestionDiffError,
} from "./detached-suggestion-diff";
import {
  prepareSingleDocumentSuggestion,
  preflightSingleDocumentSuggestion,
  type SingleDocumentSuggestionConflictCode,
} from "./single-document-suggestions";

type EditorDocument = {
  doc_id: string;
  doc?: object;
  cm6?: {
    view: EditorView;
  };
};

export type EditorSuggestionBinding = {
  currentDocument: EditorDocument;
  shareDocument: object;
  trackChanges: boolean;
};

export type EditorSuggestionContext = {
  projectId: string;
  documentId: string;
  path: string;
  revision: number;
  currentDocument: EditorDocument;
  shareDocument: object;
  realtimeText: string;
  sourceMode: boolean;
  connected: boolean;
  joined: boolean;
  documentConnectionState: string;
  hasBufferedOps: boolean;
  canWrite: boolean;
  trackChanges: boolean;
  wantTrackChanges: boolean;
  realtimeTrackChanges: boolean;
};

export type EditorSuggestionApplicationConflictCode =
  | SingleDocumentSuggestionConflictCode
  | "AI_EDITOR_CHANGED_DURING_PREFLIGHT"
  | "AI_EDITOR_DIVERGED"
  | "AI_EDITOR_DOCUMENT_UNBOUND"
  | "AI_EDITOR_PERMISSION_DENIED"
  | "AI_EDITOR_READ_ONLY"
  | "AI_EDITOR_SECURE_CONTEXT_REQUIRED"
  | "AI_EDITOR_SOURCE_MODE_REQUIRED"
  | "AI_EDITOR_SYNC_PENDING"
  | "AI_EDITOR_TRACK_CHANGES_PENDING";

export type EditorSuggestionApplicationResult =
  | {
      status: "applied";
    }
  | {
      status: "conflict";
      code: EditorSuggestionApplicationConflictCode;
    }
  | {
      status: "cancelled";
    };

export type SelectedEditorSuggestionApplicationResult =
  | EditorSuggestionApplicationResult
  | {
      status: "empty";
    };

type ApplySingleDocumentSuggestionOptions = {
  view: EditorView;
  request: AgentRequest | unknown;
  suggestion: unknown;
  binding: EditorSuggestionBinding;
  getContext: () => EditorSuggestionContextRead;
  signal?: AbortSignal;
  hashText?: (text: string) => Promise<string>;
};

type ApplySelectedSingleDocumentSuggestionOptions =
  ApplySingleDocumentSuggestionOptions & {
    selectedHunkIds: unknown;
    compileSelectedSuggestionHunks?: typeof compileSelectedSuggestionHunks;
  };

export type EditorSuggestionContextResult =
  | {
      status: "ready";
      context: EditorSuggestionContext;
    }
  | {
      status: "conflict";
      code: EditorSuggestionApplicationConflictCode;
    };

export type EditorSuggestionContextRead =
  | EditorSuggestionContext
  | EditorSuggestionContextResult;

const conflictCodes = new Set<EditorSuggestionApplicationConflictCode>([
  "AI_EDITOR_OFFLINE",
  "AI_SUGGESTION_PROJECT_CHANGED",
  "AI_SUGGESTION_DOCUMENT_CHANGED",
  "AI_SUGGESTION_REVISION_STALE",
  "AI_SUGGESTION_HASH_STALE",
  "AI_SUGGESTION_ORIGINAL_STALE",
  "AI_EDITOR_CHANGED_DURING_PREFLIGHT",
  "AI_EDITOR_DIVERGED",
  "AI_EDITOR_DOCUMENT_UNBOUND",
  "AI_EDITOR_PERMISSION_DENIED",
  "AI_EDITOR_READ_ONLY",
  "AI_EDITOR_SECURE_CONTEXT_REQUIRED",
  "AI_EDITOR_SOURCE_MODE_REQUIRED",
  "AI_EDITOR_SYNC_PENDING",
  "AI_EDITOR_TRACK_CHANGES_PENDING",
]);

function conflict(
  code: EditorSuggestionApplicationConflictCode,
): EditorSuggestionApplicationResult {
  return {
    status: "conflict",
    code,
  };
}

function cancelled(): EditorSuggestionApplicationResult {
  return {
    status: "cancelled",
  };
}

function syncPending(): EditorSuggestionContextResult {
  return {
    status: "conflict",
    code: "AI_EDITOR_SYNC_PENDING",
  };
}

function snapshotContext(value: unknown): EditorSuggestionContext | null {
  if (value == null || typeof value !== "object") {
    return null;
  }
  const context = value as EditorSuggestionContext;
  const snapshot: EditorSuggestionContext = {
    projectId: context.projectId,
    documentId: context.documentId,
    path: context.path,
    revision: context.revision,
    currentDocument: context.currentDocument,
    shareDocument: context.shareDocument,
    realtimeText: context.realtimeText,
    sourceMode: context.sourceMode,
    connected: context.connected,
    joined: context.joined,
    documentConnectionState: context.documentConnectionState,
    hasBufferedOps: context.hasBufferedOps,
    canWrite: context.canWrite,
    trackChanges: context.trackChanges,
    wantTrackChanges: context.wantTrackChanges,
    realtimeTrackChanges: context.realtimeTrackChanges,
  };
  if (
    typeof snapshot.projectId !== "string" ||
    typeof snapshot.documentId !== "string" ||
    typeof snapshot.path !== "string" ||
    !Number.isSafeInteger(snapshot.revision) ||
    snapshot.revision < 0 ||
    snapshot.currentDocument == null ||
    typeof snapshot.currentDocument !== "object" ||
    snapshot.shareDocument == null ||
    typeof snapshot.shareDocument !== "object" ||
    typeof snapshot.realtimeText !== "string" ||
    typeof snapshot.sourceMode !== "boolean" ||
    typeof snapshot.connected !== "boolean" ||
    typeof snapshot.joined !== "boolean" ||
    typeof snapshot.documentConnectionState !== "string" ||
    typeof snapshot.hasBufferedOps !== "boolean" ||
    typeof snapshot.canWrite !== "boolean" ||
    typeof snapshot.trackChanges !== "boolean" ||
    typeof snapshot.wantTrackChanges !== "boolean" ||
    typeof snapshot.realtimeTrackChanges !== "boolean"
  ) {
    return null;
  }
  return snapshot;
}

function readContext(
  getContext: () => EditorSuggestionContextRead,
): EditorSuggestionContextResult {
  try {
    const value = getContext();
    if (value == null || typeof value !== "object") {
      return syncPending();
    }
    if ("status" in value) {
      const status = value.status;
      if (status === "conflict") {
        const code = value.code;
        return typeof code === "string" &&
          conflictCodes.has(code as EditorSuggestionApplicationConflictCode)
          ? {
              status: "conflict",
              code: code as EditorSuggestionApplicationConflictCode,
            }
          : syncPending();
      }
      if (status !== "ready") {
        return syncPending();
      }
      const context = snapshotContext(value.context);
      return context == null
        ? syncPending()
        : {
            status: "ready",
            context,
          };
    }
    const context = snapshotContext(value);
    return context == null
      ? syncPending()
      : {
          status: "ready",
          context,
        };
  } catch {
    return syncPending();
  }
}

type AwaitableResult<T> =
  | {
      status: "ready";
      value: T;
    }
  | {
      status: "cancelled";
    };

async function awaitUnlessAborted<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<AwaitableResult<T>> {
  if (signal == null) {
    return {
      status: "ready",
      value: await operation,
    };
  }

  const settled = operation.then(
    (value) => ({
      status: "ready" as const,
      value,
    }),
    (error: unknown) => ({
      status: "error" as const,
      error,
    }),
  );
  if (signal.aborted) {
    return {
      status: "cancelled",
    };
  }

  let removeAbortListener = () => {};
  const aborted = new Promise<{ status: "cancelled" }>((resolve) => {
    const onAbort = () => {
      resolve({
        status: "cancelled",
      });
    };
    signal.addEventListener("abort", onAbort, {
      once: true,
    });
    removeAbortListener = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) {
      onAbort();
    }
  });
  const result = await Promise.race([settled, aborted]);
  removeAbortListener();
  if (result.status === "error") {
    throw result.error;
  }
  return result;
}

function guardCurrentEditor(
  view: EditorView,
  binding: EditorSuggestionBinding,
  context: EditorSuggestionContext,
): EditorSuggestionApplicationResult | null {
  const identity = view.state.facet(aiReviewerDocumentIdentity);
  if (
    identity == null ||
    identity.currentDocument !== context.currentDocument ||
    identity.currentDocument !== binding.currentDocument ||
    identity.documentId !== context.documentId ||
    context.currentDocument.doc_id !== context.documentId ||
    context.currentDocument.cm6?.view !== view ||
    context.currentDocument.doc !== context.shareDocument ||
    context.shareDocument !== binding.shareDocument
  ) {
    return conflict("AI_EDITOR_DOCUMENT_UNBOUND");
  }
  if (!context.sourceMode || isVisual(view)) {
    return conflict("AI_EDITOR_SOURCE_MODE_REQUIRED");
  }
  if (!context.connected) {
    return conflict("AI_EDITOR_OFFLINE");
  }
  if (
    !context.joined ||
    context.documentConnectionState !== "ok" ||
    context.hasBufferedOps
  ) {
    return conflict("AI_EDITOR_SYNC_PENDING");
  }
  if (!context.canWrite) {
    return conflict("AI_EDITOR_PERMISSION_DENIED");
  }
  if (
    view.state.facet(EditorState.readOnly) ||
    !view.state.facet(EditorView.editable)
  ) {
    return conflict("AI_EDITOR_READ_ONLY");
  }
  if (
    context.trackChanges !== context.wantTrackChanges ||
    context.trackChanges !== context.realtimeTrackChanges ||
    context.trackChanges !== binding.trackChanges
  ) {
    return conflict("AI_EDITOR_TRACK_CHANGES_PENDING");
  }
  if (view.state.doc.toString() !== context.realtimeText) {
    return conflict("AI_EDITOR_DIVERGED");
  }
  return null;
}

export async function sha256Text(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function applyPreparedSingleDocumentSuggestion({
  view,
  request,
  suggestion,
  binding,
  getContext,
  signal,
  hashText,
  changes,
}: ApplySingleDocumentSuggestionOptions & {
  hashText: (text: string) => Promise<string>;
  changes?: ChangeSet;
}): Promise<EditorSuggestionApplicationResult> {
  if (signal?.aborted) {
    return cancelled();
  }
  const beforeHashRead = readContext(getContext);
  if (beforeHashRead.status === "conflict") {
    return beforeHashRead;
  }
  if (signal?.aborted) {
    return cancelled();
  }
  let beforeHashConflict: EditorSuggestionApplicationResult | null;
  try {
    beforeHashConflict = guardCurrentEditor(
      view,
      binding,
      beforeHashRead.context,
    );
  } catch {
    return conflict("AI_EDITOR_SYNC_PENDING");
  }
  if (beforeHashConflict != null) {
    return beforeHashConflict;
  }

  const hashInput = view.state.doc.toString();
  let hashOperation: Promise<string>;
  try {
    hashOperation = Promise.resolve(hashText(hashInput));
  } catch {
    return conflict("AI_EDITOR_SYNC_PENDING");
  }
  const hashResult = await awaitUnlessAborted(hashOperation, signal);
  if (hashResult.status === "cancelled") {
    return cancelled();
  }
  const currentHash = hashResult.value;

  if (signal?.aborted) {
    return cancelled();
  }
  const finalRead = readContext(getContext);
  if (finalRead.status === "conflict") {
    return finalRead;
  }
  const finalText = view.state.doc.toString();
  if (finalText !== hashInput) {
    return conflict("AI_EDITOR_CHANGED_DURING_PREFLIGHT");
  }
  let finalConflict: EditorSuggestionApplicationResult | null;
  try {
    finalConflict = guardCurrentEditor(view, binding, finalRead.context);
  } catch {
    return conflict("AI_EDITOR_SYNC_PENDING");
  }
  if (finalConflict != null) {
    return finalConflict;
  }

  const preflight = preflightSingleDocumentSuggestion({
    request,
    suggestion,
    snapshot: {
      projectId: finalRead.context.projectId,
      documentId: finalRead.context.documentId,
      path: finalRead.context.path,
      revision: finalRead.context.revision,
      textHash: currentHash,
      text: finalText,
      connected: finalRead.context.connected,
    },
  });
  if (preflight.status === "conflict") {
    return preflight;
  }
  if (changes != null && changes.length !== finalText.length) {
    return conflict("AI_EDITOR_CHANGED_DURING_PREFLIGHT");
  }
  if (signal?.aborted) {
    return cancelled();
  }

  view.dispatch({
    changes: changes ?? preflight.change,
    annotations: [
      Transaction.userEvent.of(preflight.userEvent),
      isolateHistory.of("full"),
    ],
  });
  return {
    status: "applied",
  };
}

export async function applySingleDocumentSuggestion({
  hashText: injectedHashText,
  ...options
}: ApplySingleDocumentSuggestionOptions): Promise<EditorSuggestionApplicationResult> {
  if (injectedHashText == null && globalThis.crypto?.subtle == null) {
    return conflict("AI_EDITOR_SECURE_CONTEXT_REQUIRED");
  }
  const stableRequest = AgentRequestSchema.parse(options.request);
  const stableSuggestion = prepareSingleDocumentSuggestion({
    request: stableRequest,
    suggestion: options.suggestion,
  });
  const stableBinding = Object.freeze({
    currentDocument: options.binding.currentDocument,
    shareDocument: options.binding.shareDocument,
    trackChanges: options.binding.trackChanges,
  });
  return applyPreparedSingleDocumentSuggestion({
    ...options,
    request: stableRequest,
    suggestion: stableSuggestion,
    binding: stableBinding,
    hashText: injectedHashText ?? sha256Text,
  });
}

export async function applySelectedSingleDocumentSuggestion({
  selectedHunkIds,
  compileSelectedSuggestionHunks: injectedCompileHunks,
  hashText: injectedHashText,
  ...options
}: ApplySelectedSingleDocumentSuggestionOptions): Promise<SelectedEditorSuggestionApplicationResult> {
  const compileHunks = injectedCompileHunks ?? compileSelectedSuggestionHunks;
  if (options.signal?.aborted) {
    return cancelled();
  }
  if (
    (injectedCompileHunks == null || injectedHashText == null) &&
    globalThis.crypto?.subtle == null
  ) {
    return conflict("AI_EDITOR_SECURE_CONTEXT_REQUIRED");
  }
  const compileInput = options.view.state.doc.toString();
  const stableBinding = Object.freeze({
    currentDocument: options.binding.currentDocument,
    shareDocument: options.binding.shareDocument,
    trackChanges: options.binding.trackChanges,
  });
  const stableSuggestion = prepareSingleDocumentSuggestion({
    request: options.request,
    suggestion: options.suggestion,
  });
  const stableRequest = AgentRequestSchema.parse(options.request);
  let compiled: Awaited<ReturnType<typeof compileSelectedSuggestionHunks>>;
  try {
    const compileOperation = Promise.resolve(
      compileHunks({
        request: stableRequest,
        suggestion: stableSuggestion,
        selectedHunkIds,
        documentLength: compileInput.length,
      }),
    );
    const compileResult = await awaitUnlessAborted(
      compileOperation,
      options.signal,
    );
    if (compileResult.status === "cancelled") {
      return cancelled();
    }
    compiled = compileResult.value;
  } catch (error) {
    if (
      error instanceof DetachedSuggestionDiffError &&
      error.code === "AI_DIFF_DOCUMENT_LENGTH_INVALID"
    ) {
      return conflict("AI_SUGGESTION_ORIGINAL_STALE");
    }
    throw error;
  }
  if (options.signal?.aborted) {
    return cancelled();
  }
  if (compiled.status === "empty") {
    return {
      status: "empty",
    };
  }
  if (options.view.state.doc.toString() !== compileInput) {
    return conflict("AI_EDITOR_CHANGED_DURING_PREFLIGHT");
  }

  return applyPreparedSingleDocumentSuggestion({
    ...options,
    request: stableRequest,
    suggestion: stableSuggestion,
    binding: stableBinding,
    hashText: injectedHashText ?? sha256Text,
    changes: compiled.changes,
  });
}
