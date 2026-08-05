import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { isVisual } from "@/features/source-editor/extensions/visual/visual";

import { AgentRequestSchema } from "../../../shared/contracts.mjs";
import type { AgentRequest } from "../../../shared/contract-types";
import { aiReviewerDocumentIdentity } from "../extensions/document-identity";

export type EditorSelectionSessionAction = "review" | "rewrite" | "shorten";
export type EditorSelectionSessionTarget = "selection" | "document";

export type EditorSelectionShareDocument = {
  connection: {
    state: string;
  };
  getVersion(): number;
};

export type EditorSelectionDocument = {
  doc_id: string;
  joined: boolean;
  doc?: EditorSelectionShareDocument;
  cm6?: {
    view: EditorView;
  };
  getSnapshot(): string | undefined;
  hasBufferedOps(): boolean | undefined;
  getTrackingChanges(): boolean;
};

export type EditorSelectionSessionPermissions = {
  read: boolean;
  write: boolean;
  trackedWrite: boolean;
};

export type EditorSelectionSessionContext = {
  view: EditorView | null;
  projectId: string;
  currentDocumentId: string | null;
  path: string | null;
  currentDocument: EditorSelectionDocument | null;
  sourceMode: boolean;
  connected: boolean;
  connectionEpoch: number;
  permissions: EditorSelectionSessionPermissions;
  trackChanges: boolean;
  wantTrackChanges: boolean;
};

export type EditorSelectionSessionConflictCode =
  | "AI_SELECTION_CHANGED_DURING_CAPTURE"
  | "AI_SELECTION_DIVERGED"
  | "AI_SELECTION_DOCUMENT_UNBOUND"
  | "AI_SELECTION_EDITOR_READ_ONLY"
  | "AI_SELECTION_EDITOR_UNAVAILABLE"
  | "AI_SELECTION_HASH_FAILED"
  | "AI_SELECTION_MULTIPLE_UNSUPPORTED"
  | "AI_SELECTION_OFFLINE"
  | "AI_SELECTION_PERMISSION_DENIED"
  | "AI_SELECTION_REQUEST_INVALID"
  | "AI_SELECTION_REQUIRED"
  | "AI_SELECTION_SOURCE_MODE_REQUIRED"
  | "AI_SELECTION_SYNC_PENDING"
  | "AI_SELECTION_TRACK_CHANGES_PENDING";

export type EditorSelectionSessionBinding = Readonly<{
  currentDocument: EditorSelectionDocument;
  shareDocument: EditorSelectionShareDocument;
  trackChanges: boolean;
  connectionEpoch: number;
}>;

export type EditorSelectionSession = Readonly<{
  request: AgentRequest;
  binding: EditorSelectionSessionBinding;
}>;

type EditorSelectionSessionConflict = {
  status: "conflict";
  code: EditorSelectionSessionConflictCode;
};

export type EditorSelectionSessionResult =
  | {
      status: "ready";
      session: EditorSelectionSession;
    }
  | EditorSelectionSessionConflict;

export type CaptureEditorSelectionSessionOptions = {
  requestId: string;
  action: EditorSelectionSessionAction;
  instruction: string;
  target?: EditorSelectionSessionTarget;
  getContext: () => EditorSelectionSessionContext;
  hashText?: (text: string) => Promise<string>;
};

type CapturedSelection = {
  target: EditorSelectionSessionTarget;
  view: EditorView;
  currentDocument: EditorSelectionDocument;
  shareDocument: EditorSelectionShareDocument;
  projectId: string;
  currentDocumentId: string;
  path: string;
  sourceMode: boolean;
  connected: boolean;
  connectionEpoch: number;
  permissionRead: boolean;
  permissionWrite: boolean;
  permissionTrackedWrite: boolean;
  trackChanges: boolean;
  wantTrackChanges: boolean;
  realtimeTrackChanges: boolean;
  revision: number;
  text: string;
  anchor: number;
  head: number;
  from: number;
  to: number;
  selectionText: string;
};

type CaptureResult =
  | {
      status: "ready";
      snapshot: CapturedSelection;
    }
  | EditorSelectionSessionConflict;

const actions = new Set<EditorSelectionSessionAction>([
  "review",
  "rewrite",
  "shorten",
]);
const targets = new Set<EditorSelectionSessionTarget>([
  "selection",
  "document",
]);

const skills: Record<EditorSelectionSessionAction, string> = {
  review: "referee-review",
  rewrite: "line-edit",
  shorten: "line-edit",
};

const validationHash = "0".repeat(64);

function conflict(
  code: EditorSelectionSessionConflictCode,
): EditorSelectionSessionConflict {
  return {
    status: "conflict",
    code,
  };
}

function captureContextUnsafe(
  getContext: () => EditorSelectionSessionContext,
  action: EditorSelectionSessionAction,
  target: EditorSelectionSessionTarget,
): CaptureResult {
  const context = getContext();
  const view = context.view;
  const projectId = context.projectId;
  const currentDocumentId = context.currentDocumentId;
  const path = context.path;
  const currentDocument = context.currentDocument;
  const sourceMode = context.sourceMode;
  const connected = context.connected;
  const connectionEpoch = context.connectionEpoch;
  const permissionRead = context.permissions?.read === true;
  const permissionWrite = context.permissions?.write === true;
  const permissionTrackedWrite = context.permissions?.trackedWrite === true;
  const trackChanges = context.trackChanges;
  const wantTrackChanges = context.wantTrackChanges;

  if (view == null) {
    return conflict("AI_SELECTION_EDITOR_UNAVAILABLE");
  }
  if (
    currentDocument == null ||
    currentDocumentId == null ||
    currentDocument.doc_id !== currentDocumentId
  ) {
    return conflict("AI_SELECTION_DOCUMENT_UNBOUND");
  }

  const identity = view.state.facet(aiReviewerDocumentIdentity);
  if (
    identity == null ||
    identity.documentId !== currentDocumentId ||
    identity.currentDocument !== currentDocument ||
    currentDocument.cm6?.view !== view
  ) {
    return conflict("AI_SELECTION_DOCUMENT_UNBOUND");
  }
  if (!sourceMode || isVisual(view)) {
    return conflict("AI_SELECTION_SOURCE_MODE_REQUIRED");
  }
  if (!connected) {
    return conflict("AI_SELECTION_OFFLINE");
  }
  if (!Number.isFinite(connectionEpoch) || connectionEpoch < 0) {
    return conflict("AI_SELECTION_SYNC_PENDING");
  }

  const shareDocument = currentDocument.doc;
  if (
    !currentDocument.joined ||
    shareDocument == null ||
    shareDocument.connection?.state !== "ok"
  ) {
    return conflict("AI_SELECTION_SYNC_PENDING");
  }

  let revisionBefore: number;
  let revisionAfter: number;
  let text: string | undefined;
  let hasBufferedOps: boolean | undefined;
  let realtimeTrackChanges: boolean;
  try {
    revisionBefore = shareDocument.getVersion();
    text = currentDocument.getSnapshot();
    hasBufferedOps = currentDocument.hasBufferedOps();
    realtimeTrackChanges = currentDocument.getTrackingChanges();
    revisionAfter = shareDocument.getVersion();
  } catch {
    return conflict("AI_SELECTION_SYNC_PENDING");
  }
  if (
    !Number.isSafeInteger(revisionBefore) ||
    revisionBefore < 0 ||
    revisionAfter !== revisionBefore ||
    typeof text !== "string" ||
    hasBufferedOps !== false ||
    typeof realtimeTrackChanges !== "boolean" ||
    currentDocument.doc !== shareDocument
  ) {
    return conflict("AI_SELECTION_SYNC_PENDING");
  }
  if (
    typeof trackChanges !== "boolean" ||
    typeof wantTrackChanges !== "boolean" ||
    trackChanges !== wantTrackChanges ||
    trackChanges !== realtimeTrackChanges
  ) {
    return conflict("AI_SELECTION_TRACK_CHANGES_PENDING");
  }
  if (!permissionRead) {
    return conflict("AI_SELECTION_PERMISSION_DENIED");
  }
  if (
    action !== "review" &&
    (trackChanges ? !permissionTrackedWrite : !permissionWrite)
  ) {
    return conflict("AI_SELECTION_PERMISSION_DENIED");
  }
  if (
    action !== "review" &&
    (view.state.facet(EditorState.readOnly) ||
      !view.state.facet(EditorView.editable))
  ) {
    return conflict("AI_SELECTION_EDITOR_READ_ONLY");
  }

  const editorText = view.state.doc.toString();
  if (editorText !== text) {
    return conflict("AI_SELECTION_DIVERGED");
  }
  if (target === "document") {
    return {
      status: "ready",
      snapshot: {
        target,
        view,
        currentDocument,
        shareDocument,
        projectId,
        currentDocumentId,
        path: path ?? "",
        sourceMode,
        connected,
        connectionEpoch,
        permissionRead,
        permissionWrite,
        permissionTrackedWrite,
        trackChanges,
        wantTrackChanges,
        realtimeTrackChanges,
        revision: revisionBefore,
        text: editorText,
        anchor: 0,
        head: editorText.length,
        from: 0,
        to: editorText.length,
        selectionText: editorText,
      },
    };
  }
  const ranges = view.state.selection.ranges;
  if (ranges.length !== 1) {
    return conflict("AI_SELECTION_MULTIPLE_UNSUPPORTED");
  }
  const selection = ranges[0];
  if (selection.empty) {
    return conflict("AI_SELECTION_REQUIRED");
  }

  return {
    status: "ready",
    snapshot: {
      target,
      view,
      currentDocument,
      shareDocument,
      projectId,
      currentDocumentId,
      path: path ?? "",
      sourceMode,
      connected,
      connectionEpoch,
      permissionRead,
      permissionWrite,
      permissionTrackedWrite,
      trackChanges,
      wantTrackChanges,
      realtimeTrackChanges,
      revision: revisionBefore,
      text: editorText,
      anchor: selection.anchor,
      head: selection.head,
      from: selection.from,
      to: selection.to,
      selectionText: view.state.sliceDoc(selection.from, selection.to),
    },
  };
}

function captureContext(
  getContext: () => EditorSelectionSessionContext,
  action: EditorSelectionSessionAction,
  target: EditorSelectionSessionTarget,
): CaptureResult {
  try {
    return captureContextUnsafe(getContext, action, target);
  } catch {
    return conflict("AI_SELECTION_SYNC_PENDING");
  }
}

function equalCapture(
  before: CapturedSelection,
  after: CapturedSelection,
): boolean {
  return (
    before.target === after.target &&
    before.view === after.view &&
    before.currentDocument === after.currentDocument &&
    before.shareDocument === after.shareDocument &&
    before.projectId === after.projectId &&
    before.currentDocumentId === after.currentDocumentId &&
    before.path === after.path &&
    before.sourceMode === after.sourceMode &&
    before.connected === after.connected &&
    before.connectionEpoch === after.connectionEpoch &&
    before.permissionRead === after.permissionRead &&
    before.permissionWrite === after.permissionWrite &&
    before.permissionTrackedWrite === after.permissionTrackedWrite &&
    before.trackChanges === after.trackChanges &&
    before.wantTrackChanges === after.wantTrackChanges &&
    before.realtimeTrackChanges === after.realtimeTrackChanges &&
    before.revision === after.revision &&
    before.text === after.text &&
    before.anchor === after.anchor &&
    before.head === after.head &&
    before.from === after.from &&
    before.to === after.to &&
    before.selectionText === after.selectionText
  );
}

function createRequest(
  requestId: string,
  action: EditorSelectionSessionAction,
  instruction: string,
  target: EditorSelectionSessionTarget,
  snapshot: CapturedSelection,
  baseTextHash: string,
): AgentRequest | null {
  const parsed = AgentRequestSchema.safeParse({
    requestId,
    projectId: snapshot.projectId,
    action,
    instruction,
    skill: skills[action],
    scope:
      target === "selection"
        ? {
            kind: "selection",
            documentId: snapshot.currentDocumentId,
            path: snapshot.path,
            baseRevision: snapshot.revision,
            baseTextHash,
            range: {
              from: snapshot.from,
              to: snapshot.to,
            },
            text: snapshot.selectionText,
          }
        : {
            kind: "document",
            documentId: snapshot.currentDocumentId,
            path: snapshot.path,
            baseRevision: snapshot.revision,
            baseTextHash,
            text: snapshot.text,
          },
  });
  const scope = parsed.success ? parsed.data.scope : null;
  if (!parsed.success || scope == null || scope.kind !== target) {
    return null;
  }
  if (scope.kind === "selection") {
    Object.freeze(scope.range);
  }
  Object.freeze(scope);
  Object.freeze(parsed.data);
  return parsed.data;
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

export async function captureEditorSelectionSession(
  options: CaptureEditorSelectionSessionOptions,
): Promise<EditorSelectionSessionResult> {
  const requestId = options.requestId;
  const action = options.action;
  const instruction = options.instruction;
  const target = options.target ?? "selection";
  const getContext = options.getContext;
  const hashText = options.hashText ?? sha256Text;

  if (
    !actions.has(action) ||
    !targets.has(target) ||
    typeof instruction !== "string" ||
    instruction.trim().length === 0
  ) {
    return conflict("AI_SELECTION_REQUEST_INVALID");
  }

  const before = captureContext(getContext, action, target);
  if (before.status === "conflict") {
    return before;
  }
  if (
    createRequest(
      requestId,
      action,
      instruction,
      target,
      before.snapshot,
      validationHash,
    ) == null
  ) {
    return conflict("AI_SELECTION_REQUEST_INVALID");
  }

  let baseTextHash: string;
  try {
    baseTextHash = await hashText(before.snapshot.text);
  } catch {
    return conflict("AI_SELECTION_HASH_FAILED");
  }

  const after = captureContext(getContext, action, target);
  if (after.status === "conflict") {
    return after;
  }
  if (!equalCapture(before.snapshot, after.snapshot)) {
    return conflict("AI_SELECTION_CHANGED_DURING_CAPTURE");
  }

  const request = createRequest(
    requestId,
    action,
    instruction,
    target,
    before.snapshot,
    baseTextHash,
  );
  if (request == null) {
    return conflict("AI_SELECTION_REQUEST_INVALID");
  }

  const binding = Object.freeze({
    currentDocument: before.snapshot.currentDocument,
    shareDocument: before.snapshot.shareDocument,
    trackChanges: before.snapshot.trackChanges,
    connectionEpoch: before.snapshot.connectionEpoch,
  });
  const session = Object.freeze({
    request,
    binding,
  });
  return {
    status: "ready",
    session,
  };
}
