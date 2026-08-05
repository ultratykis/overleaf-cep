import { EventEmitter } from "node:events";

import { type EditOperation, StringFileData } from "overleaf-editor-core";

type LegacyInsertComponent = {
  p: number;
  i: string;
  u?: boolean;
};

type LegacyDeleteComponent = {
  p: number;
  d: string;
  u?: boolean;
};

type LegacyComponent = LegacyInsertComponent | LegacyDeleteComponent;

export type LegacyLocalOperation =
  | {
      type: "insert";
      position: number;
      text: string;
      fromUndo: boolean;
    }
  | {
      type: "delete";
      position: number;
      length: number;
      fromUndo: boolean;
    };

type StatefulRawShareDoc = StatefulLegacyShareDoc | StatefulHistoryShareDoc;

type EditorFacadePort = {
  view: object;
  attachShareJs(shareDoc: StatefulRawShareDoc): void;
  setTrackChangesUserId(userId: string | null): void;
};

type StatefulOuterDoc = EventEmitter & {
  _doc: StatefulRawShareDoc;
  connection: {
    state: string;
  };
  track_changes: boolean;
  getSnapshot(): string;
  getVersion(): number;
  getType(): StatefulRawShareDoc["otType"];
  hasBufferedOps(): boolean;
  getInflightOp(): null;
  getPendingOp(): null;
};

export type StatefulDocumentContainer = {
  doc_id: string;
  doc: StatefulOuterDoc;
  cm6?: EditorFacadePort;
  joined: boolean;
  ranges: {
    getTrackedDeletesLength(): number;
  };
  historyOTShareDoc?: StatefulHistoryShareDoc;
  getSnapshot(): string;
  hasBufferedOps(): boolean;
  getTrackingChanges(): boolean;
  getType(): StatefulRawShareDoc["otType"];
  attachToCM6(editor: EditorFacadePort): void;
  detachFromCM6(): void;
  setTrackChangesUserId(userId: string | null): void;
};

type StatefulDocumentFixture<TShareDoc extends StatefulRawShareDoc> = {
  currentDocument: StatefulDocumentContainer;
  shareDoc: TShareDoc;
  documentErrors: unknown[];
  isAttachedToCM6(): boolean;
};

function applyLegacyComponent(
  snapshot: string,
  component: LegacyComponent,
): {
  snapshot: string;
  deletedText?: string;
} {
  if (component.p < 0 || component.p > snapshot.length) {
    throw new Error("Legacy operation position is outside the document.");
  }
  if ("i" in component) {
    return {
      snapshot:
        snapshot.slice(0, component.p) +
        component.i +
        snapshot.slice(component.p),
    };
  }

  const deletedText = snapshot.slice(
    component.p,
    component.p + component.d.length,
  );
  if (deletedText !== component.d) {
    throw new Error("Legacy delete does not match the current document.");
  }
  return {
    snapshot:
      snapshot.slice(0, component.p) +
      snapshot.slice(component.p + component.d.length),
    deletedText,
  };
}

function applyHistoryOperations(
  snapshot: StringFileData,
  operations: EditOperation[],
) {
  const nextSnapshot = StringFileData.fromRaw(snapshot.toRaw());
  for (const operation of operations) {
    nextSnapshot.edit(operation);
  }
  return nextSnapshot;
}

export class StatefulLegacyShareDoc extends EventEmitter {
  readonly otType = "sharejs-text-ot" as const;
  readonly localOperations: LegacyLocalOperation[] = [];
  readonly errors: unknown[] = [];
  snapshot: string;
  detach_cm6?: () => void;

  constructor(text: string) {
    super();
    this.snapshot = text;
    this.on("error", (error) => {
      this.errors.push(error);
    });
  }

  getText() {
    return this.snapshot;
  }

  insert(position: number, text: string, fromUndo: boolean) {
    this.submitOp([
      {
        p: position,
        i: text,
        u: fromUndo,
      },
    ]);
  }

  del(position: number, length: number, fromUndo: boolean) {
    this.submitOp([
      {
        p: position,
        d: this.snapshot.slice(position, position + length),
        u: fromUndo,
      },
    ]);
  }

  submitOp(components: LegacyComponent[]) {
    for (const component of components) {
      const applied = applyLegacyComponent(this.snapshot, component);
      this.snapshot = applied.snapshot;
      if ("i" in component) {
        this.localOperations.push({
          type: "insert",
          position: component.p,
          text: component.i,
          fromUndo: component.u === true,
        });
      } else {
        this.localOperations.push({
          type: "delete",
          position: component.p,
          length: component.d.length,
          fromUndo: component.u === true,
        });
      }
    }
  }

  applyRemote(components: LegacyComponent[]) {
    const events: Array<
      | {
          type: "insert";
          position: number;
          text: string;
        }
      | {
          type: "delete";
          position: number;
          text: string;
        }
    > = [];

    for (const component of components) {
      const applied = applyLegacyComponent(this.snapshot, component);
      this.snapshot = applied.snapshot;
      if ("i" in component) {
        events.push({
          type: "insert",
          position: component.p,
          text: component.i,
        });
      } else {
        events.push({
          type: "delete",
          position: component.p,
          text: applied.deletedText ?? "",
        });
      }
    }

    for (const event of events) {
      this.emit(event.type, event.position, event.text);
    }
  }

  remoteInsert(position: number, text: string) {
    this.applyRemote([
      {
        p: position,
        i: text,
      },
    ]);
  }
}

export class StatefulHistoryShareDoc extends EventEmitter {
  readonly otType = "history-ot" as const;
  readonly submittedOperations: EditOperation[][] = [];
  readonly errors: unknown[] = [];
  snapshot: StringFileData;
  detach_cm6?: () => void;

  constructor(text: string) {
    super();
    this.snapshot = new StringFileData(text);
    this.on("error", (error) => {
      this.errors.push(error);
    });
  }

  getText() {
    return this.snapshot.getContent({
      filterTrackedDeletes: true,
    });
  }

  submitOp(operations: EditOperation[]) {
    this.submittedOperations.push([...operations]);
    this.snapshot = applyHistoryOperations(this.snapshot, operations);
  }

  applyRemote(operations: EditOperation[]) {
    this.snapshot = applyHistoryOperations(this.snapshot, operations);
    this.emit("remoteop", operations);
  }
}

function createCurrentDocument<TShareDoc extends StatefulRawShareDoc>({
  documentId,
  revision,
  shareDoc,
}: {
  documentId: string;
  revision: number;
  shareDoc: TShareDoc;
}): {
  currentDocument: StatefulDocumentContainer;
  documentErrors: unknown[];
  isAttachedToCM6(): boolean;
} {
  let attachedEditor: EditorFacadePort | null = null;
  const documentErrors: unknown[] = [];
  const outerDoc = new EventEmitter() as StatefulOuterDoc;

  outerDoc._doc = shareDoc;
  outerDoc.connection = {
    state: "ok",
  };
  outerDoc.track_changes = false;
  outerDoc.getSnapshot = () => shareDoc.getText();
  outerDoc.getVersion = () => revision;
  outerDoc.getType = () => shareDoc.otType;
  outerDoc.hasBufferedOps = () => false;
  outerDoc.getInflightOp = () => null;
  outerDoc.getPendingOp = () => null;
  outerDoc.on("error", (error) => {
    documentErrors.push(error);
  });
  shareDoc.on("error", (error) => {
    outerDoc.emit("error", error);
  });

  const currentDocument: StatefulDocumentContainer = {
    doc_id: documentId,
    doc: outerDoc,
    joined: true,
    ranges: {
      getTrackedDeletesLength: () => 0,
    },
    historyOTShareDoc: shareDoc.otType === "history-ot" ? shareDoc : undefined,
    getSnapshot: () => shareDoc.getText(),
    hasBufferedOps: () => outerDoc.hasBufferedOps(),
    getTrackingChanges: () => outerDoc.track_changes,
    getType: () => shareDoc.otType,
    attachToCM6(editor: EditorFacadePort) {
      attachedEditor = editor;
      this.cm6 = editor;
      editor.attachShareJs(shareDoc);
    },
    detachFromCM6() {
      shareDoc.detach_cm6?.();
      attachedEditor = null;
      delete this.cm6;
    },
    setTrackChangesUserId(userId: string | null) {
      if (attachedEditor == null) {
        throw new Error("The stateful document is not attached to CodeMirror.");
      }
      attachedEditor.setTrackChangesUserId(userId);
    },
  };

  return {
    currentDocument,
    documentErrors,
    isAttachedToCM6: () => attachedEditor != null,
  };
}

export function createStatefulLegacyDocument({
  documentId,
  text,
  revision = 7,
}: {
  documentId: string;
  text: string;
  revision?: number;
}): StatefulDocumentFixture<StatefulLegacyShareDoc> {
  const shareDoc = new StatefulLegacyShareDoc(text);
  return {
    ...createCurrentDocument({
      documentId,
      revision,
      shareDoc,
    }),
    shareDoc,
  };
}

export function createStatefulHistoryDocument({
  documentId,
  text,
  revision = 7,
}: {
  documentId: string;
  text: string;
  revision?: number;
}): StatefulDocumentFixture<StatefulHistoryShareDoc> {
  const shareDoc = new StatefulHistoryShareDoc(text);
  return {
    ...createCurrentDocument({
      documentId,
      revision,
      shareDoc,
    }),
    shareDoc,
  };
}
