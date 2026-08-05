import {
  Compartment,
  EditorSelection,
  EditorState,
  Transaction,
} from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { expect } from "chai";
import {
  toggleVisualEffect,
  visual,
} from "@/features/source-editor/extensions/visual/visual";

import "../../../../test/frontend/cut-log-noise";
import { captureEditorSelectionSession } from "../../frontend/js/services/editor-selection-session";
import { extension as documentIdentityExtension } from "../../frontend/js/extensions/document-identity";

const baseText = "Alpha beta gamma.";
const baseTextHash =
  "aea23d46109af9b94c5f15085d69113cc2cefa85f05748897a4df172a1ee5104";
const syntheticHash = "a".repeat(64);

class SyntheticShareDocument {
  connection = {
    state: "ok",
  };
  version = 7;

  getVersion() {
    return this.version;
  }
}

class SyntheticDocument {
  doc_id: string;
  joined = true;
  doc = new SyntheticShareDocument();
  cm6?: {
    view: EditorView;
  };
  snapshot = baseText;
  buffered = false;
  trackingChanges = false;

  constructor(docId = "document-0001") {
    this.doc_id = docId;
  }

  getSnapshot() {
    return this.snapshot;
  }

  hasBufferedOps() {
    return this.buffered;
  }

  getTrackingChanges() {
    return this.trackingChanges;
  }
}

type MutableContext = {
  view: EditorView | null;
  projectId: string;
  currentDocumentId: string | null;
  path: string | null;
  currentDocument: SyntheticDocument | null;
  sourceMode: boolean;
  connected: boolean;
  connectionEpoch: number;
  permissions: {
    read: boolean;
    write: boolean;
    trackedWrite: boolean;
  };
  trackChanges: boolean;
  wantTrackChanges: boolean;
};

function createDocument(
  overrides: Partial<SyntheticDocument> = {},
): SyntheticDocument {
  return Object.assign(new SyntheticDocument(), overrides);
}

describe("AI reviewer: single document selection session", function () {
  let currentDocument: SyntheticDocument;
  let context: MutableContext;
  let views: EditorView[];

  function createView({
    document = currentDocument,
    text = document.snapshot,
    selection = EditorSelection.single(6, 10),
    multiple = false,
    readOnly = false,
    editable = true,
    identityCompartment,
    includeIdentity = true,
    includeVisualMode = false,
  }: {
    document?: SyntheticDocument;
    text?: string;
    selection?: EditorSelection;
    multiple?: boolean;
    readOnly?: boolean;
    editable?: boolean;
    identityCompartment?: Compartment;
    includeIdentity?: boolean;
    includeVisualMode?: boolean;
  } = {}) {
    const identity = documentIdentityExtension({
      currentDoc: {
        currentDocument: document,
      },
    });
    const view = new EditorView({
      state: EditorState.create({
        doc: text,
        selection,
        extensions: [
          multiple ? EditorState.allowMultipleSelections.of(true) : [],
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(editable),
          includeIdentity
            ? identityCompartment == null
              ? identity
              : identityCompartment.of(identity)
            : [],
          includeVisualMode
            ? visual("main.tex", {
                visual: false,
                previewByPath: () => null,
              })
            : [],
        ],
      }),
    });
    views.push(view);
    document.cm6 = {
      view,
    };
    return view;
  }

  function getContext() {
    return {
      ...context,
      permissions: {
        ...context.permissions,
      },
    };
  }

  function capture(
    overrides: Partial<
      Parameters<typeof captureEditorSelectionSession>[0]
    > = {},
  ) {
    return captureEditorSelectionSession({
      requestId: "request-selection-0001",
      action: "review",
      instruction: "Review the selected synthetic phrase.",
      getContext,
      hashText: async () => syntheticHash,
      ...overrides,
    });
  }

  beforeEach(function () {
    views = [];
    currentDocument = createDocument();
    context = {
      view: null,
      projectId: "project-0001",
      currentDocumentId: "document-0001",
      path: "main.tex",
      currentDocument,
      sourceMode: true,
      connected: true,
      connectionEpoch: 17,
      permissions: {
        read: true,
        write: false,
        trackedWrite: false,
      },
      trackChanges: false,
      wantTrackChanges: false,
    };
    context.view = createView();
  });

  afterEach(function () {
    for (const view of views) {
      view.destroy();
    }
  });

  it("returns one frozen request-bound session for an exact read-only review selection", async function () {
    const hashInputs: string[] = [];
    context.view = createView({
      readOnly: true,
      editable: false,
    });

    const result = await capture({
      hashText: async (text) => {
        hashInputs.push(text);
        return syntheticHash;
      },
    });

    expect(result).to.deep.include({
      status: "ready",
    });
    if (result.status !== "ready") {
      throw new Error("Expected a ready selection session.");
    }
    expect(hashInputs).to.deep.equal([baseText]);
    expect(result.session.request).to.deep.equal({
      requestId: "request-selection-0001",
      projectId: "project-0001",
      action: "review",
      instruction: "Review the selected synthetic phrase.",
      skill: "referee-review",
      scope: {
        kind: "selection",
        documentId: "document-0001",
        path: "main.tex",
        baseRevision: 7,
        baseTextHash: syntheticHash,
        range: {
          from: 6,
          to: 10,
        },
        text: "beta",
      },
    });
    expect(result.session.binding).to.deep.equal({
      currentDocument,
      shareDocument: currentDocument.doc,
      trackChanges: false,
      connectionEpoch: 17,
    });
    expect(Object.isFrozen(result.session)).to.equal(true);
    expect(Object.isFrozen(result.session.request)).to.equal(true);
    expect(Object.isFrozen(result.session.request.scope)).to.equal(true);
    if (result.session.request.scope.kind !== "selection") {
      throw new Error("Expected a selection request.");
    }
    expect(Object.isFrozen(result.session.request.scope.range)).to.equal(true);
    expect(Object.isFrozen(result.session.binding)).to.equal(true);
    expect(Object.isFrozen(currentDocument)).to.equal(false);
  });

  it("maps normal-write rewrite and shorten to line-edit", async function () {
    context.permissions.write = true;

    const rewrite = await capture({
      action: "rewrite",
      instruction: "Rewrite the selection.",
    });
    const shorten = await capture({
      action: "shorten",
      instruction: "Shorten the selection.",
    });

    expect(rewrite).to.have.nested.property(
      "session.request.skill",
      "line-edit",
    );
    expect(rewrite).to.have.nested.property(
      "session.request.action",
      "rewrite",
    );
    expect(shorten).to.have.nested.property(
      "session.request.skill",
      "line-edit",
    );
    expect(shorten).to.have.nested.property(
      "session.request.action",
      "shorten",
    );
  });

  it("maps tracked-write rewrite and shorten to line-edit", async function () {
    context.trackChanges = true;
    context.wantTrackChanges = true;
    currentDocument.trackingChanges = true;
    context.permissions.trackedWrite = true;

    const rewrite = await capture({
      action: "rewrite",
      instruction: "Rewrite the selection.",
    });
    const shorten = await capture({
      action: "shorten",
      instruction: "Shorten the selection.",
    });

    expect(rewrite).to.have.nested.property(
      "session.request.skill",
      "line-edit",
    );
    expect(rewrite).to.have.nested.property(
      "session.request.action",
      "rewrite",
    );
    expect(shorten).to.have.nested.property(
      "session.request.skill",
      "line-edit",
    );
    expect(shorten).to.have.nested.property(
      "session.request.action",
      "shorten",
    );
    expect(rewrite).to.have.nested.property(
      "session.binding.trackChanges",
      true,
    );
  });

  it("requires the permission for the active track mode in both directions", async function () {
    context.permissions.trackedWrite = true;

    const untracked = await capture({
      action: "rewrite",
      instruction: "Rewrite without track changes.",
    });

    context.trackChanges = true;
    context.wantTrackChanges = true;
    currentDocument.trackingChanges = true;
    context.permissions.trackedWrite = false;
    context.permissions.write = true;
    const tracked = await capture({
      action: "rewrite",
      instruction: "Rewrite with track changes.",
    });

    expect(untracked).to.deep.equal({
      status: "conflict",
      code: "AI_SELECTION_PERMISSION_DENIED",
    });
    expect(tracked).to.deep.equal({
      status: "conflict",
      code: "AI_SELECTION_PERMISSION_DENIED",
    });
  });

  it("rejects mutating actions when CodeMirror is read-only", async function () {
    context.permissions.write = true;
    context.view = createView({
      readOnly: true,
      editable: false,
    });

    const rewrite = await capture({
      action: "rewrite",
      instruction: "Rewrite the selection.",
    });
    const shorten = await capture({
      action: "shorten",
      instruction: "Shorten the selection.",
    });

    expect(rewrite).to.deep.equal({
      status: "conflict",
      code: "AI_SELECTION_EDITOR_READ_ONLY",
    });
    expect(shorten).to.deep.equal({
      status: "conflict",
      code: "AI_SELECTION_EDITOR_READ_ONLY",
    });
  });

  it("uses the default SHA-256 implementation for the full document", async function () {
    const result = await capture({
      hashText: undefined,
    });

    expect(result).to.have.nested.property(
      "session.request.scope.baseTextHash",
      baseTextHash,
    );
  });

  it("rejects empty and multiple selections before hashing", async function () {
    let hashCalls = 0;
    context.view?.dispatch({
      selection: {
        anchor: 6,
      },
    });

    const empty = await capture({
      hashText: async () => {
        hashCalls += 1;
        return syntheticHash;
      },
    });

    context.view = createView({
      selection: EditorSelection.create([
        EditorSelection.range(0, 5),
        EditorSelection.range(6, 10),
      ]),
      multiple: true,
    });
    const multiple = await capture({
      hashText: async () => {
        hashCalls += 1;
        return syntheticHash;
      },
    });

    expect(empty).to.deep.equal({
      status: "conflict",
      code: "AI_SELECTION_REQUIRED",
    });
    expect(multiple).to.deep.equal({
      status: "conflict",
      code: "AI_SELECTION_MULTIPLE_UNSUPPORTED",
    });
    expect(hashCalls).to.equal(0);
  });

  const initialConflictCases: Array<{
    title: string;
    code: string;
    mutate: () => void;
    action?: "review" | "rewrite";
  }> = [
    {
      title: "rejects a missing Editor view",
      code: "AI_SELECTION_EDITOR_UNAVAILABLE",
      mutate: () => {
        context.view = null;
      },
    },
    {
      title: "rejects a missing current document",
      code: "AI_SELECTION_DOCUMENT_UNBOUND",
      mutate: () => {
        context.currentDocument = null;
      },
    },
    {
      title: "rejects an Editor without a document identity facet",
      code: "AI_SELECTION_DOCUMENT_UNBOUND",
      mutate: () => {
        context.view = createView({
          includeIdentity: false,
        });
      },
    },
    {
      title: "rejects a document detached from its realtime Editor facade",
      code: "AI_SELECTION_DOCUMENT_UNBOUND",
      mutate: () => {
        delete currentDocument.cm6;
      },
    },
    {
      title: "rejects a realtime Editor facade bound to another view",
      code: "AI_SELECTION_DOCUMENT_UNBOUND",
      mutate: () => {
        currentDocument.cm6 = {
          view: createView({
            document: createDocument(),
          }),
        };
      },
    },
    {
      title: "rejects a context document ID mismatch",
      code: "AI_SELECTION_DOCUMENT_UNBOUND",
      mutate: () => {
        context.currentDocumentId = "document-0002";
      },
    },
    {
      title: "rejects a current document not bound to the live Editor facet",
      code: "AI_SELECTION_DOCUMENT_UNBOUND",
      mutate: () => {
        context.currentDocument = createDocument();
      },
    },
    {
      title: "rejects visual mode",
      code: "AI_SELECTION_SOURCE_MODE_REQUIRED",
      mutate: () => {
        context.sourceMode = false;
      },
    },
    {
      title: "rejects a disconnected project socket",
      code: "AI_SELECTION_OFFLINE",
      mutate: () => {
        context.connected = false;
      },
    },
    {
      title: "rejects an unjoined document",
      code: "AI_SELECTION_SYNC_PENDING",
      mutate: () => {
        currentDocument.joined = false;
      },
    },
    {
      title: "rejects a non-ready document connection",
      code: "AI_SELECTION_SYNC_PENDING",
      mutate: () => {
        currentDocument.doc.connection.state = "disconnected";
      },
    },
    {
      title: "rejects buffered document operations",
      code: "AI_SELECTION_SYNC_PENDING",
      mutate: () => {
        currentDocument.buffered = true;
      },
    },
    {
      title: "rejects a pending track-mode transition",
      code: "AI_SELECTION_TRACK_CHANGES_PENDING",
      mutate: () => {
        context.wantTrackChanges = true;
      },
    },
    {
      title: "rejects a realtime and React track-mode mismatch",
      code: "AI_SELECTION_TRACK_CHANGES_PENDING",
      mutate: () => {
        context.trackChanges = true;
        context.wantTrackChanges = true;
      },
    },
    {
      title: "rejects diverged CodeMirror and realtime text",
      code: "AI_SELECTION_DIVERGED",
      mutate: () => {
        context.view?.dispatch({
          changes: {
            from: baseText.length,
            insert: "!",
          },
        });
      },
    },
    {
      title: "rejects review without read permission",
      code: "AI_SELECTION_PERMISSION_DENIED",
      mutate: () => {
        context.permissions.read = false;
      },
    },
    {
      title: "rejects rewrite without the active-mode write permission",
      code: "AI_SELECTION_PERMISSION_DENIED",
      action: "rewrite",
      mutate: () => {},
    },
  ];

  for (const conflictCase of initialConflictCases) {
    it(conflictCase.title, async function () {
      let hashCalls = 0;
      conflictCase.mutate();

      const result = await capture({
        action: conflictCase.action ?? "review",
        hashText: async () => {
          hashCalls += 1;
          return syntheticHash;
        },
      });

      expect(result).to.deep.equal({
        status: "conflict",
        code: conflictCase.code,
      });
      expect(hashCalls).to.equal(0);
    });
  }

  const invalidConnectionEpochCases: Array<{
    title: string;
    value: unknown;
  }> = [
    {
      title: "undefined",
      value: undefined,
    },
    {
      title: "a string",
      value: "17",
    },
    {
      title: "a negative number",
      value: -1,
    },
    {
      title: "NaN",
      value: Number.NaN,
    },
    {
      title: "infinity",
      value: Number.POSITIVE_INFINITY,
    },
  ];

  for (const invalidEpoch of invalidConnectionEpochCases) {
    it(`rejects ${invalidEpoch.title} as a connection epoch before hashing`, async function () {
      let hashCalls = 0;
      (
        context as unknown as {
          connectionEpoch: unknown;
        }
      ).connectionEpoch = invalidEpoch.value;

      expect(
        await capture({
          hashText: async () => {
            hashCalls += 1;
            return syntheticHash;
          },
        }),
      ).to.deep.equal({
        status: "conflict",
        code: "AI_SELECTION_SYNC_PENDING",
      });
      expect(hashCalls).to.equal(0);
    });
  }

  it("rejects a live Visual Editor even when the committed context claims source mode", async function () {
    context.view = createView({
      includeVisualMode: true,
    });
    context.view.dispatch({
      effects: toggleVisualEffect.of(true),
    });
    context.sourceMode = true;
    let hashCalls = 0;

    expect(
      await capture({
        hashText: async () => {
          hashCalls += 1;
          return syntheticHash;
        },
      }),
    ).to.deep.equal({
      status: "conflict",
      code: "AI_SELECTION_SOURCE_MODE_REQUIRED",
    });
    expect(hashCalls).to.equal(0);
  });

  it("rejects malformed static request fields before hashing", async function () {
    let hashCalls = 0;
    context.path = "../main.tex";

    const invalidPath = await capture({
      hashText: async () => {
        hashCalls += 1;
        return syntheticHash;
      },
    });
    context.path = "main.tex";
    const invalidInstruction = await capture({
      instruction: "   ",
      hashText: async () => {
        hashCalls += 1;
        return syntheticHash;
      },
    });
    const invalidAction = await capture({
      action: "complete" as never,
      hashText: async () => {
        hashCalls += 1;
        return syntheticHash;
      },
    });

    expect(invalidPath).to.deep.equal({
      status: "conflict",
      code: "AI_SELECTION_REQUEST_INVALID",
    });
    expect(invalidInstruction).to.deep.equal({
      status: "conflict",
      code: "AI_SELECTION_REQUEST_INVALID",
    });
    expect(invalidAction).to.deep.equal({
      status: "conflict",
      code: "AI_SELECTION_REQUEST_INVALID",
    });
    expect(hashCalls).to.equal(0);
  });

  it("fails closed for unavailable realtime document state", async function () {
    const cases: Array<{
      title: string;
      mutate: () => void;
    }> = [
      {
        title: "missing share document",
        mutate: () => {
          (currentDocument as unknown as { doc?: SyntheticShareDocument }).doc =
            undefined;
        },
      },
      {
        title: "invalid revision",
        mutate: () => {
          currentDocument.doc.version = -1;
        },
      },
      {
        title: "unknown buffered-operation state",
        mutate: () => {
          (
            currentDocument as unknown as {
              hasBufferedOps(): boolean | undefined;
            }
          ).hasBufferedOps = () => undefined;
        },
      },
      {
        title: "throwing realtime accessor",
        mutate: () => {
          currentDocument.getSnapshot = () => {
            throw new Error("synthetic realtime snapshot failure");
          };
        },
      },
      {
        title: "revision changing during the snapshot read",
        mutate: () => {
          let revisionReads = 0;
          currentDocument.doc.getVersion = () => {
            revisionReads += 1;
            return revisionReads === 1 ? 7 : 8;
          };
        },
      },
      {
        title: "share document replaced during the snapshot read",
        mutate: () => {
          currentDocument.getSnapshot = () => {
            currentDocument.doc = new SyntheticShareDocument();
            return currentDocument.snapshot;
          };
        },
      },
    ];

    for (const unavailable of cases) {
      unavailable.mutate();
      let hashCalls = 0;
      expect(
        await capture({
          hashText: async () => {
            hashCalls += 1;
            return syntheticHash;
          },
        }),
        unavailable.title,
      ).to.deep.equal({
        status: "conflict",
        code: "AI_SELECTION_SYNC_PENDING",
      });
      expect(hashCalls, unavailable.title).to.equal(0);

      currentDocument = createDocument();
      context.currentDocument = currentDocument;
      context.currentDocumentId = currentDocument.doc_id;
      context.view = createView({
        document: currentDocument,
      });
    }

    context.path = null;
    let hashCalls = 0;
    expect(
      await capture({
        hashText: async () => {
          hashCalls += 1;
          return syntheticHash;
        },
      }),
    ).to.deep.equal({
      status: "conflict",
      code: "AI_SELECTION_REQUEST_INVALID",
    });
    expect(hashCalls).to.equal(0);
  });

  function deferredHash(expectedText = baseText) {
    let signalStarted = () => {};
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });
    let resolveHash = (_hash: string) => {};
    const pending = new Promise<string>((resolve) => {
      resolveHash = resolve;
    });
    return {
      started,
      resolveHash,
      hashText: async (text: string) => {
        expect(text).to.equal(expectedText);
        signalStarted();
        return pending;
      },
    };
  }

  const hashRaceCases: Array<{
    title: string;
    expectedCode: string;
    action?: "review" | "rewrite";
    setup?: () => void;
    mutate: () => void;
  }> = [
    {
      title: "rejects a revision-only change during hashing",
      expectedCode: "AI_SELECTION_CHANGED_DURING_CAPTURE",
      mutate: () => {
        currentDocument.doc.version = 8;
      },
    },
    {
      title: "rejects a CodeMirror-text-only change during hashing",
      expectedCode: "AI_SELECTION_DIVERGED",
      mutate: () => {
        context.view?.dispatch({
          changes: {
            from: baseText.length,
            insert: "!",
          },
        });
      },
    },
    {
      title: "rejects a realtime-text-only change during hashing",
      expectedCode: "AI_SELECTION_DIVERGED",
      mutate: () => {
        currentDocument.snapshot = `${baseText}!`;
      },
    },
    {
      title: "rejects a current document ID change during hashing",
      expectedCode: "AI_SELECTION_DOCUMENT_UNBOUND",
      mutate: () => {
        context.currentDocumentId = "document-0002";
      },
    },
    {
      title: "rejects a project change during hashing",
      expectedCode: "AI_SELECTION_CHANGED_DURING_CAPTURE",
      mutate: () => {
        context.projectId = "project-0002";
      },
    },
    {
      title: "rejects a path change during hashing",
      expectedCode: "AI_SELECTION_CHANGED_DURING_CAPTURE",
      mutate: () => {
        context.path = "sections/main.tex";
      },
    },
    {
      title: "rejects a source-mode change during hashing",
      expectedCode: "AI_SELECTION_SOURCE_MODE_REQUIRED",
      mutate: () => {
        context.sourceMode = false;
      },
    },
    {
      title: "rejects a global disconnect during hashing",
      expectedCode: "AI_SELECTION_OFFLINE",
      mutate: () => {
        context.connected = false;
      },
    },
    {
      title: "rejects a fully reconnected connection epoch during hashing",
      expectedCode: "AI_SELECTION_CHANGED_DURING_CAPTURE",
      mutate: () => {
        context.connectionEpoch += 1;
      },
    },
    {
      title: "rejects a document leave during hashing",
      expectedCode: "AI_SELECTION_SYNC_PENDING",
      mutate: () => {
        currentDocument.joined = false;
      },
    },
    {
      title: "rejects a document disconnect during hashing",
      expectedCode: "AI_SELECTION_SYNC_PENDING",
      mutate: () => {
        currentDocument.doc.connection.state = "disconnected";
      },
    },
    {
      title: "rejects buffered operations during hashing",
      expectedCode: "AI_SELECTION_SYNC_PENDING",
      mutate: () => {
        currentDocument.buffered = true;
      },
    },
    {
      title: "rejects read-permission loss during hashing",
      expectedCode: "AI_SELECTION_PERMISSION_DENIED",
      mutate: () => {
        context.permissions.read = false;
      },
    },
    {
      title: "rejects active write-permission loss during hashing",
      expectedCode: "AI_SELECTION_PERMISSION_DENIED",
      action: "rewrite",
      setup: () => {
        context.permissions.write = true;
      },
      mutate: () => {
        context.permissions.write = false;
      },
    },
    {
      title: "rejects a completed track-mode change during hashing",
      expectedCode: "AI_SELECTION_CHANGED_DURING_CAPTURE",
      mutate: () => {
        context.trackChanges = true;
        context.wantTrackChanges = true;
        currentDocument.trackingChanges = true;
      },
    },
    {
      title: "rejects a realtime document disappearance during hashing",
      expectedCode: "AI_SELECTION_SYNC_PENDING",
      mutate: () => {
        (currentDocument as unknown as { doc?: SyntheticShareDocument }).doc =
          undefined;
      },
    },
    {
      title: "rejects a same-document replacement Editor during hashing",
      expectedCode: "AI_SELECTION_CHANGED_DURING_CAPTURE",
      mutate: () => {
        context.view = createView({
          document: currentDocument,
        });
      },
    },
  ];

  for (const raceCase of hashRaceCases) {
    it(raceCase.title, async function () {
      raceCase.setup?.();
      const hash = deferredHash();
      const operation = capture({
        action: raceCase.action ?? "review",
        instruction:
          raceCase.action === "rewrite"
            ? "Rewrite the selection."
            : "Review the selection.",
        hashText: hash.hashText,
      });
      await hash.started;
      raceCase.mutate();
      hash.resolveHash(syntheticHash);

      expect(await operation).to.deep.equal({
        status: "conflict",
        code: raceCase.expectedCode,
      });
    });
  }

  it("rejects an exact same-ID document switch in the same Editor during hashing", async function () {
    const identity = new Compartment();
    context.view = createView({
      identityCompartment: identity,
    });
    const hash = deferredHash();
    const operation = capture({
      hashText: hash.hashText,
    });
    await hash.started;
    const replacementDocument = createDocument();
    context.currentDocument = replacementDocument;
    replacementDocument.cm6 = {
      view: context.view,
    };
    context.view.dispatch({
      effects: identity.reconfigure(
        documentIdentityExtension({
          currentDoc: {
            currentDocument: replacementDocument,
          },
        }),
      ),
    });
    hash.resolveHash(syntheticHash);

    expect(await operation).to.deep.equal({
      status: "conflict",
      code: "AI_SELECTION_CHANGED_DURING_CAPTURE",
    });
  });

  it("copies a shared mutable context and permissions object before hashing", async function () {
    const hash = deferredHash();
    const operation = capture({
      getContext: () => context,
      hashText: hash.hashText,
    });
    await hash.started;
    context.path = "sections/main.tex";
    context.permissions.write = true;
    hash.resolveHash(syntheticHash);

    expect(await operation).to.deep.equal({
      status: "conflict",
      code: "AI_SELECTION_CHANGED_DURING_CAPTURE",
    });
  });

  it("retains invocation-time request fields while hashing", async function () {
    const hash = deferredHash();
    const mutableOptions: Parameters<typeof captureEditorSelectionSession>[0] =
      {
        requestId: "request-selection-invocation",
        action: "review",
        instruction: "Review the invocation-time selection.",
        getContext,
        hashText: hash.hashText,
      };
    const operation = captureEditorSelectionSession(mutableOptions);
    await hash.started;
    mutableOptions.requestId = "request-selection-mutated";
    mutableOptions.action = "rewrite";
    mutableOptions.instruction = "Mutated instruction.";
    mutableOptions.getContext = () => ({
      ...getContext(),
      projectId: "project-mutated",
    });
    hash.resolveHash(syntheticHash);

    const result = await operation;
    expect(result).to.have.nested.property(
      "session.request.requestId",
      "request-selection-invocation",
    );
    expect(result).to.have.nested.property("session.request.action", "review");
    expect(result).to.have.nested.property(
      "session.request.instruction",
      "Review the invocation-time selection.",
    );
  });

  it("binds selection coordinates and direction across hashing", async function () {
    const duplicateText = "same x same";
    currentDocument.snapshot = duplicateText;
    context.view = createView({
      text: duplicateText,
      selection: EditorSelection.single(0, 4),
      multiple: true,
    });
    const offsetHash = deferredHash(duplicateText);
    const offsetOperation = capture({
      hashText: offsetHash.hashText,
    });
    await offsetHash.started;
    context.view.dispatch({
      selection: {
        anchor: 7,
        head: 11,
      },
    });
    offsetHash.resolveHash(syntheticHash);
    expect(await offsetOperation).to.deep.equal({
      status: "conflict",
      code: "AI_SELECTION_CHANGED_DURING_CAPTURE",
    });

    currentDocument.snapshot = baseText;
    context.view = createView();
    const directionHash = deferredHash();
    const directionOperation = capture({
      hashText: directionHash.hashText,
    });
    await directionHash.started;
    context.view.dispatch({
      selection: {
        anchor: 10,
        head: 6,
      },
    });
    directionHash.resolveHash(syntheticHash);
    expect(await directionOperation).to.deep.equal({
      status: "conflict",
      code: "AI_SELECTION_CHANGED_DURING_CAPTURE",
    });
  });

  it("rechecks empty and multiple selections after hashing", async function () {
    const emptyHash = deferredHash();
    const emptyOperation = capture({
      hashText: emptyHash.hashText,
    });
    await emptyHash.started;
    context.view?.dispatch({
      selection: {
        anchor: 6,
      },
    });
    emptyHash.resolveHash(syntheticHash);
    expect(await emptyOperation).to.deep.equal({
      status: "conflict",
      code: "AI_SELECTION_REQUIRED",
    });

    context.view = createView({
      multiple: true,
    });
    const multipleHash = deferredHash();
    const multipleOperation = capture({
      hashText: multipleHash.hashText,
    });
    await multipleHash.started;
    context.view.dispatch({
      selection: EditorSelection.create([
        EditorSelection.range(0, 5),
        EditorSelection.range(6, 10),
      ]),
    });
    multipleHash.resolveHash(syntheticHash);
    expect(await multipleOperation).to.deep.equal({
      status: "conflict",
      code: "AI_SELECTION_MULTIPLE_UNSUPPORTED",
    });
  });

  it("allows an unrelated non-document transaction during hashing", async function () {
    const hash = deferredHash();
    const operation = capture({
      hashText: hash.hashText,
    });
    await hash.started;
    context.view?.dispatch({
      annotations: Transaction.userEvent.of("ai-reviewer.synthetic-noop"),
    });
    hash.resolveHash(syntheticHash);

    expect(await operation).to.have.property("status", "ready");
  });

  it("rejects an invalid hash result without returning a session", async function () {
    const result = await capture({
      hashText: async () => "not-a-sha256",
    });

    expect(result).to.deep.equal({
      status: "conflict",
      code: "AI_SELECTION_REQUEST_INVALID",
    });
  });

  it("classifies a failed hash without returning a session", async function () {
    const result = await capture({
      hashText: async () => {
        throw new Error("synthetic hash failure");
      },
    });

    expect(result).to.deep.equal({
      status: "conflict",
      code: "AI_SELECTION_HASH_FAILED",
    });
  });
});
