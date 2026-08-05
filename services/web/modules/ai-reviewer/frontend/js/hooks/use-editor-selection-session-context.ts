import { useFileTreePathContext } from "@/features/file-tree/contexts/file-tree-path";
import { useConnectionContext } from "@/features/ide-react/context/connection-context";
import { useEditorOpenDocContext } from "@/features/ide-react/context/editor-open-doc-context";
import { useEditorPropertiesContext } from "@/features/ide-react/context/editor-properties-context";
import { useEditorViewContext } from "@/features/ide-react/context/editor-view-context";
import { usePermissionsContext } from "@/features/ide-react/context/permissions-context";
import { isVisual } from "@/features/source-editor/extensions/visual/visual";
import { isVisualEditorAvailable } from "@/features/source-editor/utils/visual-editor";
import { useProjectContext } from "@/shared/context/project-context";
import type { EditorView } from "@codemirror/view";
import { useCallback, useLayoutEffect, useMemo, useRef } from "react";

import type {
  EditorSelectionDocument,
  EditorSelectionSessionContext,
} from "../services/editor-selection-session";

export function useLatestCommittedEditorSelectionSessionContext(
  context: EditorSelectionSessionContext,
) {
  const latestContext = useRef(context);

  useLayoutEffect(() => {
    latestContext.current = context;
  }, [context]);

  return useCallback(() => latestContext.current, []);
}

export function readEditorSourceMode({
  view,
  documentName,
  visualRequested,
  isVisualModeAvailable = isVisualEditorAvailable,
}: {
  view: EditorView | null;
  documentName: string | null;
  visualRequested: boolean;
  isVisualModeAvailable?: (documentName: string) => boolean;
}) {
  if (view == null) {
    return false;
  }
  const requestedVisualMode =
    visualRequested &&
    documentName != null &&
    isVisualModeAvailable(documentName);
  return !requestedVisualMode && !isVisual(view);
}

export function createEditorSelectionSessionContext({
  documentName,
  visualRequested,
  isVisualModeAvailable,
  ...context
}: Omit<EditorSelectionSessionContext, "sourceMode"> & {
  documentName: string | null;
  visualRequested: boolean;
  isVisualModeAvailable?: (documentName: string) => boolean;
}): EditorSelectionSessionContext {
  return {
    ...context,
    get sourceMode() {
      return readEditorSourceMode({
        view: context.view,
        documentName,
        visualRequested,
        isVisualModeAvailable,
      });
    },
  };
}

export function useEditorSelectionSessionContext() {
  const { view } = useEditorViewContext();
  const { currentDocumentId, currentDocument, openDocName } =
    useEditorOpenDocContext();
  const { pathInFolder } = useFileTreePathContext();
  const { showVisual, trackChanges, wantTrackChanges } =
    useEditorPropertiesContext();
  const { isConnected, connectionState } = useConnectionContext();
  const permissions = usePermissionsContext();
  const { projectId } = useProjectContext();
  const path =
    currentDocumentId == null ? null : pathInFolder(currentDocumentId);

  const context = useMemo<EditorSelectionSessionContext>(
    () =>
      createEditorSelectionSessionContext({
        view,
        projectId,
        currentDocumentId,
        path,
        currentDocument: currentDocument as EditorSelectionDocument | null,
        documentName: openDocName,
        visualRequested: showVisual,
        connected: isConnected && !connectionState.forceDisconnected,
        connectionEpoch: connectionState.lastConnectionAttempt,
        permissions: {
          read: permissions.read,
          write: permissions.write,
          trackedWrite: permissions.trackedWrite,
        },
        trackChanges,
        wantTrackChanges,
      }),
    [
      connectionState.forceDisconnected,
      connectionState.lastConnectionAttempt,
      currentDocument,
      currentDocumentId,
      isConnected,
      openDocName,
      path,
      permissions.read,
      permissions.trackedWrite,
      permissions.write,
      projectId,
      showVisual,
      trackChanges,
      view,
      wantTrackChanges,
    ],
  );

  return useLatestCommittedEditorSelectionSessionContext(context);
}
