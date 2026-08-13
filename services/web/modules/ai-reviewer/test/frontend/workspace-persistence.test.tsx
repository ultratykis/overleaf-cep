import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { expect } from "chai";
import fetchMock from "fetch-mock";
import React from "react";
import sinon from "sinon";

import { AiReviewerPanelView } from "../../frontend/js/components/ai-reviewer-panel";
import { aiReviewerDocumentIdentity } from "../../frontend/js/extensions/document-identity";
import {
  AiReviewerWorkspacePersistenceError,
  deleteAiReviewerDiscussion,
  type AiReviewerWorkspacePersistence,
  workspaceChangedMessage,
  workspaceLimitMessage,
} from "../../frontend/js/services/ai-reviewer-workspace-persistence";
import { streamAgentEvents } from "../../frontend/js/services/agent-stream";
import type { EditorSelectionSessionContext } from "../../frontend/js/services/editor-selection-session";
import {
  AI_REVIEWER_WORKSPACE_DISCUSSION_LIMIT,
  AI_REVIEWER_WORKSPACE_TURN_LIMIT,
  AiReviewerWorkspaceSchema,
} from "../../shared/contracts.mjs";
import type {
  AgentRequest,
  AiReviewerWorkspace,
  AiReviewerWorkspaceSnapshot,
  AgentEvent,
  DiscussionTurn,
  Finding,
  UnresolvedSuggestion,
  WorkspaceDiscussion,
} from "../../shared/contract-types";
import {
  isSelectionToolbarBusy,
  runSelectionAction,
} from "./helpers/selection-toolbar";

type ConversationStreamCall = Parameters<typeof streamAgentEvents>[0];

const createdAt = "2026-07-25T00:00:00.000Z";
const baseTextHash =
  "aea23d46109af9b94c5f15085d69113cc2cefa85f05748897a4df172a1ee5104";

function cloneWorkspace(workspace: AiReviewerWorkspace): AiReviewerWorkspace {
  return structuredClone(workspace);
}

const hostChatInputLabel = "Ask about your manuscript\u2026";

function sendHostChatMessage(text: string) {
  fireEvent.keyDown(screen.getByRole("textbox", { name: hostChatInputLabel }), {
    key: "Enter",
    target: { value: text },
  });
}

function emptyWorkspace(): AiReviewerWorkspace {
  return {
    runs: [],
    discussions: [],
  };
}

function clearResolvedArtifacts(
  workspace: AiReviewerWorkspace,
): AiReviewerWorkspace {
  const discussions = workspace.discussions.map((discussion) => ({
    ...discussion,
    suggestions: discussion.suggestions.filter(
      (suggestion) => suggestion.artifact.status === "unresolved",
    ),
  }));
  const boundRequestIds = new Set(
    discussions.flatMap((discussion) =>
      discussion.subject == null
        ? []
        : [discussion.subject.sourceRequest.requestId],
    ),
  );
  return {
    runs: workspace.runs
      .map((run) => ({
        ...run,
        findings: run.findings.filter(
          (finding) => finding.status === "unresolved",
        ),
        suggestions: run.suggestions.filter(
          (suggestion) => suggestion.artifact.status === "unresolved",
        ),
      }))
      .filter(
        (run) =>
          run.text.trim().length > 0 ||
          run.findings.length > 0 ||
          run.suggestions.length > 0 ||
          boundRequestIds.has(run.request.requestId),
      ),
    discussions,
  };
}

function dropUnboundEmptyRuns(
  workspace: AiReviewerWorkspace,
  orphanedRequestIds: Set<string>,
): AiReviewerWorkspace {
  const boundRequestIds = new Set(
    workspace.discussions.flatMap((discussion) =>
      discussion.subject == null
        ? []
        : [discussion.subject.sourceRequest.requestId],
    ),
  );
  return {
    runs: workspace.runs.filter(
      (run) =>
        !orphanedRequestIds.has(run.request.requestId) ||
        run.text.trim().length > 0 ||
        run.findings.length > 0 ||
        run.suggestions.length > 0 ||
        boundRequestIds.has(run.request.requestId),
    ),
    discussions: workspace.discussions,
  };
}

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((resolvePromise) => {
      resolve = resolvePromise;
    }),
    resolve,
  };
}

class MemoryWorkspacePersistence implements AiReviewerWorkspacePersistence {
  readonly stores = new Map<string, AiReviewerWorkspace>();
  readonly revisions = new Map<string, number>();
  readonly loadGates = new Map<string, Promise<void>>();
  readonly saveGates = new Map<string, Promise<void>>();
  readonly discussionDeleteGates = new Map<string, Promise<void>>();

  constructor(initial: Record<string, AiReviewerWorkspace>) {
    for (const [projectId, workspace] of Object.entries(initial)) {
      this.stores.set(projectId, cloneWorkspace(workspace));
      this.revisions.set(projectId, 1);
    }
  }

  async load(
    projectId: string,
    _signal: AbortSignal,
  ): Promise<AiReviewerWorkspaceSnapshot> {
    await this.loadGates.get(projectId);
    const current = this.stores.get(projectId) ?? emptyWorkspace();
    const cleaned = clearResolvedArtifacts(current);
    if (JSON.stringify(cleaned) !== JSON.stringify(current)) {
      this.revisions.set(projectId, (this.revisions.get(projectId) ?? 0) + 1);
    }
    this.stores.set(projectId, cloneWorkspace(cleaned));
    return {
      revision: this.revisions.get(projectId) ?? 0,
      workspace: cloneWorkspace(cleaned),
    };
  }

  async save(
    projectId: string,
    workspace: AiReviewerWorkspace,
    revision: number,
    _signal: AbortSignal,
  ): Promise<AiReviewerWorkspaceSnapshot> {
    await this.saveGates.get(projectId);
    if (revision !== (this.revisions.get(projectId) ?? 0)) {
      throw new Error("stale workspace revision");
    }
    const saved = AiReviewerWorkspaceSchema.parse(workspace);
    this.stores.set(projectId, cloneWorkspace(saved));
    const nextRevision = revision + 1;
    this.revisions.set(projectId, nextRevision);
    return {
      revision: nextRevision,
      workspace: cloneWorkspace(saved),
    };
  }

  async deleteDiscussion(
    projectId: string,
    discussionId: string,
    revision: number,
    _signal: AbortSignal,
  ): Promise<AiReviewerWorkspaceSnapshot> {
    await this.discussionDeleteGates.get(`${projectId}:${discussionId}`);
    if (revision !== (this.revisions.get(projectId) ?? 0)) {
      throw new AiReviewerWorkspacePersistenceError(
        workspaceChangedMessage,
        "AI_REVIEWER_WORKSPACE_CHANGED",
      );
    }
    const workspace = this.stores.get(projectId) ?? emptyWorkspace();
    const orphanedRequestIds = new Set(
      workspace.discussions.flatMap((discussion) =>
        discussion.id !== discussionId || discussion.subject == null
          ? []
          : [discussion.subject.sourceRequest.requestId],
      ),
    );
    const next = dropUnboundEmptyRuns(
      {
        runs: workspace.runs,
        discussions: workspace.discussions.filter(
          (discussion) => discussion.id !== discussionId,
        ),
      },
      orphanedRequestIds,
    );
    this.stores.set(projectId, cloneWorkspace(next));
    const nextRevision = (this.revisions.get(projectId) ?? 0) + 1;
    this.revisions.set(projectId, nextRevision);
    return {
      revision: nextRevision,
      workspace: cloneWorkspace(next),
    };
  }

  async deleteAll(
    projectId: string,
    _signal: AbortSignal,
  ): Promise<AiReviewerWorkspaceSnapshot> {
    const revision = (this.revisions.get(projectId) ?? 0) + 1;
    this.stores.set(projectId, emptyWorkspace());
    this.revisions.set(projectId, revision);
    return {
      revision,
      workspace: emptyWorkspace(),
    };
  }

  read(projectId: string): AiReviewerWorkspace {
    return cloneWorkspace(this.stores.get(projectId) ?? emptyWorkspace());
  }
}

function sourceRequest(projectId = "persistence-project"): AgentRequest {
  return {
    requestId: `${projectId}-request`,
    projectId,
    action: "review",
    instruction: "Review the selected phrase.",
    skill: "referee-review",
    scope: {
      kind: "selection",
      documentId: `${projectId}-document`,
      path: "chapters/persistence.tex",
      baseRevision: 7,
      baseTextHash,
      range: {
        from: 6,
        to: 10,
      },
      text: "beta",
    },
  };
}

function captureDocumentSession(projectId: string) {
  return sinon
    .stub()
    .callsFake(
      async ({
        requestId,
        action,
        instruction,
      }: {
        requestId: string;
        action: AgentRequest["action"];
        instruction: string;
      }) => {
        const source = sourceRequest(projectId);
        if (source.scope == null || source.scope.kind === "project") {
          throw new Error("The fixture requires a document scope.");
        }
        const request: AgentRequest = {
          ...source,
          requestId,
          action,
          instruction,
          scope: {
            kind: "document",
            documentId: source.scope.documentId,
            path: source.scope.path,
            baseRevision: source.scope.baseRevision,
            baseTextHash: source.scope.baseTextHash,
            text: source.scope.text,
          },
        };
        return {
          status: "ready" as const,
          session: Object.freeze({
            request: Object.freeze(request),
            binding: Object.freeze({
              currentDocument: {},
              shareDocument: {},
              trackChanges: false,
              connectionEpoch: 1,
            }),
          }),
        };
      },
    );
}

function sourceFinding(
  request: AgentRequest,
  id = "persistence-finding",
  title = "Persisted unresolved finding",
): Finding {
  if (request.scope.kind === "project") {
    throw new Error("The persistence fixture requires a document scope.");
  }
  return {
    id,
    requestId: request.requestId,
    projectId: request.projectId,
    artifactKind: "finding",
    severity: "warning",
    category: "clarity",
    title,
    message: "This unresolved finding must survive a reload.",
    evidence: [
      {
        path: request.scope.path,
        range: request.scope.range,
        revision: request.scope.baseRevision,
        textHash: request.scope.baseTextHash,
      },
    ],
    suggestionIds: [],
  };
}

function sourceSuggestion(
  request: AgentRequest,
  id = "persistence-suggestion",
): UnresolvedSuggestion {
  if (request.scope.kind === "project") {
    throw new Error("The persistence fixture requires a document scope.");
  }
  return {
    id,
    requestId: request.requestId,
    projectId: request.projectId,
    documentId: request.scope.documentId,
    path: request.scope.path,
    baseRevision: request.scope.baseRevision,
    baseTextHash: request.scope.baseTextHash,
    range:
      request.scope.kind === "selection"
        ? request.scope.range
        : { from: 0, to: request.scope.text.length },
    original: request.scope.text,
    replacement: "gamma",
    rationale: "Use the persisted replacement.",
    evidence: [
      {
        path: request.scope.path,
        range:
          request.scope.kind === "selection"
            ? request.scope.range
            : { from: 0, to: request.scope.text.length },
        revision: request.scope.baseRevision,
        textHash: request.scope.baseTextHash,
      },
    ],
    provider: "fake",
    model: "deterministic-v1",
    skill: request.skill ?? "line-edit",
    createdAt,
    status: "unresolved",
  };
}

function discussion(
  request: AgentRequest,
  finding: Finding,
  {
    id = "persistence-discussion",
    createdOrder = 2,
    turns = [],
  }: {
    id?: string;
    createdOrder?: number;
    turns?: DiscussionTurn[];
  } = {},
): WorkspaceDiscussion {
  return {
    id,
    createdOrder,
    subjectKey: `1:finding:${finding.id}`,
    subject: {
      kind: "finding",
      sourceRequest: request,
      artifact: finding,
    },
    sourceGeneration: 1,
    turns,
    suggestions: [],
    updatedAt: createdAt,
  };
}

function workspaceWithFinding({
  projectId = "persistence-project",
  includeDiscussion = false,
}: {
  projectId?: string;
  includeDiscussion?: boolean;
} = {}): AiReviewerWorkspace {
  const request = sourceRequest(projectId);
  const finding = sourceFinding(request);
  return AiReviewerWorkspaceSchema.parse({
    runs: [
      {
        generation: 1,
        createdOrder: 1,
        request,
        text: "Stored review text",
        findings: [
          {
            artifact: finding,
            status: "unresolved",
          },
        ],
        suggestions: [],
      },
    ],
    discussions: includeDiscussion
      ? [
          discussion(request, finding, {
            turns: [
              {
                role: "user",
                text: "Keep this question.",
              },
              {
                role: "assistant",
                text: "Keep this answer.",
              },
            ],
          }),
        ]
      : [],
  });
}

function workspaceWithSuggestions({
  projectId,
  action = "review",
  suggestionCount = 1,
  includeDiscussion = false,
}: {
  projectId: string;
  action?: AgentRequest["action"];
  suggestionCount?: number;
  includeDiscussion?: boolean;
}): AiReviewerWorkspace {
  const request = {
    ...sourceRequest(projectId),
    action,
  };
  const suggestions = Array.from({ length: suggestionCount }, (_, index) => ({
    artifact: sourceSuggestion(request, `${projectId}-suggestion-${index + 1}`),
  }));
  return AiReviewerWorkspaceSchema.parse({
    runs: [
      {
        generation: 1,
        createdOrder: 1,
        request,
        text: "Stored transform text",
        findings: [],
        suggestions,
      },
    ],
    discussions: includeDiscussion
      ? [
          {
            id: `${projectId}-discussion`,
            createdOrder: 2,
            subjectKey: "1:scope",
            subject: {
              kind: "scope",
              sourceRequest: request,
            },
            sourceGeneration: 1,
            turns: [],
            suggestions: [],
            updatedAt: createdAt,
          },
        ]
      : [],
  });
}

function selectionContextForRequest(
  request: AgentRequest,
): EditorSelectionSessionContext {
  if (request.scope.kind === "project") {
    throw new Error("The selection context fixture requires a document scope.");
  }
  const shareDocument = {
    connection: { state: "ok" },
    getVersion: () => request.scope.baseRevision,
  };
  const currentDocument = {
    doc_id: request.scope.documentId,
    joined: true,
    doc: shareDocument,
    getSnapshot: () => "Alpha beta gamma.",
    hasBufferedOps: () => false,
    getTrackingChanges: () => false,
    cm6: undefined as { view: EditorView } | undefined,
  };
  const view = new EditorView({
    state: EditorState.create({
      doc: "Alpha beta gamma.",
      extensions: [
        aiReviewerDocumentIdentity.of({
          documentId: request.scope.documentId,
          currentDocument,
        }),
      ],
    }),
  });
  currentDocument.cm6 = { view };
  return {
    view,
    projectId: request.projectId,
    currentDocumentId: request.scope.documentId,
    path: request.scope.path,
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
}

function panel(
  projectId: string,
  workspacePersistence: AiReviewerWorkspacePersistence,
  extra: Partial<React.ComponentProps<typeof AiReviewerPanelView>> = {},
) {
  return (
    <AiReviewerPanelView
      projectId={projectId}
      workspacePersistence={workspacePersistence}
      {...extra}
    />
  );
}

function getDeleteAllMenuItem() {
  const visibleItem = screen.queryByRole("menuitem", {
    name: "Delete all saved review work",
  });
  if (visibleItem != null) {
    return visibleItem;
  }
  const panelOverflowToggle = document.querySelector<HTMLButtonElement>(
    ".ai-reviewer-panel-header .ai-reviewer-panel-overflow-toggle",
  );
  if (panelOverflowToggle == null) {
    throw new Error("The panel overflow toggle must render.");
  }
  fireEvent.click(panelOverflowToggle);
  return screen.getByRole("menuitem", {
    name: "Delete all saved review work",
  });
}

function requestDeleteAll() {
  fireEvent.click(getDeleteAllMenuItem());
}

function confirmDeleteAll() {
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
}

function confirmDeleteDiscussion() {
  expect(screen.getByText("Delete this discussion?")).to.exist;
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
}

describe("AI reviewer: persisted review workspace", function () {
  afterEach(function () {
    fetchMock.removeRoutes().clearHistory();
  });

  it("sends the loaded revision with a discussion deletion", async function () {
    const projectId = "revisioned-discussion-delete-project";
    const route = fetchMock.delete(
      `/project/${projectId}/ai-reviewer/workspace/discussions/revisioned-discussion`,
      {
        revision: 8,
        workspace: emptyWorkspace(),
      },
    );

    await deleteAiReviewerDiscussion(
      projectId,
      "revisioned-discussion",
      7,
      new AbortController().signal,
    );

    const [request] = route.callHistory.calls();
    expect(request.options.method?.toUpperCase()).to.equal("DELETE");
    expect(JSON.parse(String(request.options.body))).to.deep.equal({
      revision: 7,
    });
  });

  it("hydrates and preserves a generated run subject", async function () {
    const projectId = "subject-persistence-project";
    const initial = workspaceWithFinding({ projectId });
    initial.runs[0].subject = "Persisted claim support";
    const persistence = new MemoryWorkspacePersistence({
      [projectId]: initial,
    });
    const save = sinon.spy(persistence, "save");

    render(panel(projectId, persistence));
    expect(
      await screen.findByRole("heading", { name: "Persisted claim support" }),
    ).to.exist;
    fireEvent.click(
      screen.getByRole("button", {
        name: "Discard finding",
      }),
    );

    await waitFor(() => expect(save.called).to.equal(true));
    expect(persistence.read(projectId).runs[0]?.subject).to.equal(
      "Persisted claim support",
    );
  });

  it("auto-deletes a transform run only after all suggestions are applied", async function () {
    const projectId = "transform-auto-delete-project";
    const initial = workspaceWithSuggestions({
      projectId,
      action: "rewrite",
      suggestionCount: 2,
    });
    const persistence = new MemoryWorkspacePersistence({
      [projectId]: initial,
    });
    const request = initial.runs[0].request;

    render(
      panel(projectId, persistence, {
        getSelectionContext: () => selectionContextForRequest(request),
        getSuggestionHunkIds: sinon.stub().resolves(["ai-hunk-v1-transform"]),
        applySelectionSuggestion: sinon.stub().resolves({ status: "applied" }),
      }),
    );

    const applyButtons = await screen.findAllByRole("button", {
      name: "Apply",
    });
    fireEvent.click(applyButtons[0]);
    await waitFor(() => {
      expect(screen.getByLabelText("Review run 1")).to.exist;
      expect(persistence.read(projectId).runs).to.have.length(1);
      expect(
        persistence.read(projectId).runs[0]?.suggestions[0].artifact.status,
      ).to.equal("applied");
    });

    const remainingApply = screen
      .getAllByRole("button", { name: "Apply" })
      .find((button) => !button.hasAttribute("disabled"));
    if (remainingApply == null) {
      throw new Error(
        "The second transform suggestion must remain applicable.",
      );
    }
    fireEvent.click(remainingApply);
    await waitFor(() => {
      expect(screen.queryByLabelText("Review run 1")).not.to.exist;
      expect(persistence.read(projectId).runs).to.deep.equal([]);
    });
  });

  it("keeps a terminal transform run that has an attached discussion", async function () {
    const projectId = "transform-discussion-project";
    const initial = workspaceWithSuggestions({
      projectId,
      action: "shorten",
      includeDiscussion: true,
    });
    const persistence = new MemoryWorkspacePersistence({
      [projectId]: initial,
    });
    const request = initial.runs[0].request;

    render(
      panel(projectId, persistence, {
        getSelectionContext: () => selectionContextForRequest(request),
        getSuggestionHunkIds: sinon.stub().resolves(["ai-hunk-v1-transform"]),
        applySelectionSuggestion: sinon.stub().resolves({ status: "applied" }),
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Apply" }));
    await waitFor(() => {
      expect(
        persistence.read(projectId).runs[0]?.suggestions[0].artifact.status,
      ).to.equal("applied");
    });
    expect(screen.getByLabelText("Review run 1")).to.exist;
    expect(persistence.read(projectId).runs).to.have.length(1);
    expect(persistence.read(projectId).discussions).to.have.length(1);
  });

  it("renders an error run without persisting it", async function () {
    const projectId = "error-run-project";
    const persistence = new MemoryWorkspacePersistence({});
    const save = sinon.spy(persistence, "save");
    const request = sourceRequest(projectId);
    const streamRequest = sinon
      .stub()
      .callsFake(async (call: ConversationStreamCall) => {
        call.onEvent({
          type: "error",
          eventId: "error-run-terminal",
          requestId: call.request.requestId,
          sequence: 0,
          createdAt,
          error: {
            category: "provider",
            code: "AI_PROVIDER_ERROR",
            message: "The provider failed.",
          },
        });
      });

    render(
      panel(projectId, persistence, {
        createRequestId: () => request.requestId,
        captureSelectionSession: async ({
          requestId,
          action,
          instruction,
        }) => ({
          status: "ready",
          session: Object.freeze({
            request: Object.freeze({
              ...request,
              requestId,
              action,
              instruction,
            }),
            binding: Object.freeze({
              currentDocument: {},
              shareDocument: {},
              trackChanges: false,
              connectionEpoch: 1,
            }),
          }),
        }),
        streamRequest,
      }),
    );

    await waitFor(() => expect(isSelectionToolbarBusy()).to.equal(false));
    runSelectionAction("review");
    expect(await screen.findByText("Error")).to.exist;
    expect(screen.getByLabelText("Review run 1")).to.exist;
    await act(async () => {
      await Promise.resolve();
    });
    expect(save.called).to.equal(false);
    expect(persistence.read(projectId).runs).to.deep.equal([]);
  });

  it("deletes runs immediately without discussions and confirms cascading deletion with discussions", async function () {
    const immediateProjectId = "manual-run-delete-project";
    const immediatePersistence = new MemoryWorkspacePersistence({
      [immediateProjectId]: workspaceWithFinding({
        projectId: immediateProjectId,
      }),
    });
    const immediate = render(panel(immediateProjectId, immediatePersistence));

    fireEvent.click(await screen.findByRole("button", { name: "Delete run" }));
    expect(screen.queryByText("Delete this run?")).not.to.exist;
    await waitFor(() => {
      expect(screen.queryByLabelText("Review run 1")).not.to.exist;
      expect(immediatePersistence.read(immediateProjectId).runs).to.deep.equal(
        [],
      );
    });
    immediate.unmount();

    const confirmedProjectId = "manual-run-discussion-delete-project";
    const confirmedPersistence = new MemoryWorkspacePersistence({
      [confirmedProjectId]: workspaceWithFinding({
        projectId: confirmedProjectId,
        includeDiscussion: true,
      }),
    });
    render(panel(confirmedProjectId, confirmedPersistence));

    fireEvent.click(await screen.findByRole("button", { name: "Delete run" }));
    expect(await screen.findByText("Delete this run?")).to.exist;
    expect(screen.getByLabelText("Review run 1")).to.exist;
    expect(
      confirmedPersistence.read(confirmedProjectId).discussions,
    ).to.have.length(1);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(screen.queryByLabelText("Review run 1")).not.to.exist;
      expect(confirmedPersistence.read(confirmedProjectId)).to.deep.equal(
        emptyWorkspace(),
      );
    });
  });

  it("hydrates unresolved artifacts and discussions on later mounts", async function () {
    const projectId = "persistence-project";
    const persistence = new MemoryWorkspacePersistence({
      [projectId]: workspaceWithFinding({
        projectId,
        includeDiscussion: true,
      }),
    });
    const load = sinon.spy(persistence, "load");
    const save = sinon.spy(persistence, "save");

    const first = render(panel(projectId, persistence));
    await screen.findByText("Persisted unresolved finding");
    expect(
      screen.getByRole("article", {
        name: "Discussion summary",
      }),
    ).to.exist;
    first.unmount();

    render(panel(projectId, persistence));
    await screen.findByText("Persisted unresolved finding");
    const summary = screen.getByRole("article", {
      name: "Discussion summary",
    });
    fireEvent.click(
      within(summary).getByRole("button", {
        name: "Finding: Persisted unresolved finding",
      }),
    );
    expect(await screen.findByText("Keep this question.")).to.exist;
    expect(screen.getByText("Keep this answer.")).to.exist;
    expect(load.callCount).to.equal(2);
    expect(save.called).to.equal(false);
  });

  it("opens a discussion in place of the timeline and returns it intact", async function () {
    const projectId = "discussion-navigation-project";
    const persistence = new MemoryWorkspacePersistence({
      [projectId]: workspaceWithFinding({
        projectId,
        includeDiscussion: true,
      }),
    });

    render(panel(projectId, persistence));
    await screen.findByText("Persisted unresolved finding");
    const summary = screen.getByRole("article", {
      name: "Discussion summary",
    });
    fireEvent.click(
      within(summary).getByRole("button", {
        name: "Finding: Persisted unresolved finding",
      }),
    );

    expect(screen.getByRole("article", { name: "AI reviewer discussion" })).to
      .exist;
    expect(document.querySelector(".ai-reviewer-panel-timeline")).to.equal(
      null,
    );
    expect(screen.queryByLabelText("Review run 1")).not.to.exist;
    expect(screen.queryByRole("article", { name: "Discussion summary" })).not.to
      .exist;
    const back = screen.getByRole("button", { name: "Back to review list" });
    expect(back.closest(".ai-reviewer-panel-header")).not.to.equal(null);

    fireEvent.click(back);

    expect(document.querySelector(".ai-reviewer-panel-timeline")).not.to.equal(
      null,
    );
    expect(screen.getByLabelText("Review run 1")).to.exist;
    expect(screen.getByRole("article", { name: "Discussion summary" })).to
      .exist;
    expect(screen.queryByRole("button", { name: "Back to review list" })).not.to
      .exist;
    expect(persistence.read(projectId).discussions).to.have.length(1);
  });

  it("restores the review-list scroll position after a card discussion", async function () {
    const projectId = "discussion-scroll-position-project";
    const persistence = new MemoryWorkspacePersistence({
      [projectId]: workspaceWithFinding({ projectId }),
    });

    render(panel(projectId, persistence));
    await screen.findByText("Persisted unresolved finding");
    const panelBody = screen.getByTestId("ai-reviewer-conversation");
    panelBody.scrollTop = 417;

    fireEvent.click(screen.getByRole("button", { name: "Discuss finding" }));
    expect(screen.getByRole("article", { name: "AI reviewer discussion" })).to
      .exist;
    panelBody.scrollTop = 0;

    fireEvent.click(
      screen.getByRole("button", { name: "Back to review list" }),
    );

    await waitFor(() => expect(panelBody.scrollTop).to.equal(417));
  });

  it("does not show a back control when no discussion is open", async function () {
    const projectId = "discussion-navigation-list-project";
    const persistence = new MemoryWorkspacePersistence({
      [projectId]: workspaceWithFinding({
        projectId,
        includeDiscussion: true,
      }),
    });

    render(panel(projectId, persistence));
    await screen.findByText("Persisted unresolved finding");

    expect(screen.queryByRole("button", { name: "Back to review list" })).not.to
      .exist;
  });

  it("persists, reloads, and deletes an open discussion", async function () {
    const projectId = "open-discussion-persistence-project";
    const persistence = new MemoryWorkspacePersistence({
      [projectId]: workspaceWithFinding({ projectId }),
    });
    const save = sinon.spy(persistence, "save");
    const deleteDiscussion = sinon.spy(persistence, "deleteDiscussion");
    let requestNumber = 0;
    const streamRequest = sinon
      .stub()
      .callsFake(async (call: ConversationStreamCall) => {
        const { requestId } = call.request;
        const events: AgentEvent[] = [
          {
            type: "started",
            eventId: `${requestId}-started`,
            requestId,
            sequence: 0,
            createdAt,
            provider: "fake",
            model: "deterministic-v1",
            skill: call.request.skill,
          },
          {
            type: "text.delta",
            eventId: `${requestId}-text`,
            requestId,
            sequence: 1,
            createdAt,
            delta: "This answer must survive a reload.",
          },
          {
            type: "completed",
            eventId: `${requestId}-completed`,
            requestId,
            sequence: 2,
            createdAt,
            finishReason: "stop",
          },
        ];
        for (const event of events) {
          call.onEvent(event);
        }
      });
    const openPanel = () =>
      panel(projectId, persistence, {
        createDiscussionId: () => "persisted-open-discussion",
        createDiscussionRequestId: () =>
          `persisted-open-request-${++requestNumber}`,
        captureSelectionSession: captureDocumentSession(projectId),
        now: () => createdAt,
        streamRequest,
      });

    const first = render(openPanel());
    await screen.findByText("Persisted unresolved finding");
    // The composer stands on its own, so a question with no subject needs no
    // separate step to open a thread for it.
    sendHostChatMessage("Keep this open question.");

    expect(
      await screen.findByRole("article", {
        name: "AI reviewer discussion",
      }),
    ).to.exist;
    expect(screen.getByTestId("discussion-subject").textContent).to.equal(
      "No subject",
    );
    expect(screen.getByText("Keep this open question.")).to.exist;
    expect(screen.getByText("This answer must survive a reload.")).to.exist;
    await waitFor(() => {
      expect(save.called).to.equal(true);
      expect(persistence.read(projectId).discussions).to.deep.equal([
        {
          id: "persisted-open-discussion",
          createdOrder: 2,
          subjectKey: null,
          subject: null,
          sourceGeneration: null,
          turns: [
            {
              role: "user",
              text: "Keep this open question.",
            },
            {
              role: "assistant",
              text: "This answer must survive a reload.",
            },
          ],
          suggestions: [],
          updatedAt: createdAt,
        },
      ]);
    });
    first.unmount();

    render(openPanel());
    const summary = await screen.findByRole("article", {
      name: "Discussion summary",
    });
    const summaryDelete = within(summary).getByRole("button", {
      name: "Delete discussion",
    });
    expect(
      summaryDelete.querySelector(".material-symbols")?.textContent,
    ).to.equal("delete");
    expect(
      summaryDelete.closest(".ai-reviewer-discussion-title-row"),
    ).not.to.equal(null);
    fireEvent.click(
      within(summary).getByRole("button", {
        name: "No subject",
      }),
    );
    expect(await screen.findByText("Keep this open question.")).to.exist;
    expect(screen.getByText("This answer must survive a reload.")).to.exist;
    const activeDelete = screen.getByRole("button", {
      name: "Delete discussion",
    });
    expect(
      activeDelete.querySelector(".material-symbols")?.textContent,
    ).to.equal("delete");
    expect(
      activeDelete.closest(".ai-reviewer-discussion-title-row"),
    ).not.to.equal(null);
    fireEvent.click(activeDelete);
    confirmDeleteDiscussion();

    await waitFor(() => {
      expect(deleteDiscussion.calledOnce).to.equal(true);
      expect(persistence.read(projectId).discussions).to.deep.equal([]);
      expect(
        screen.queryByRole("article", {
          name: "Discussion summary",
        }),
      ).not.to.exist;
    });
  });

  it("keeps the review list usable when deleting a discussion from it", async function () {
    const projectId = "discussion-draft-deletion-project";
    const persistence = new MemoryWorkspacePersistence({
      [projectId]: workspaceWithFinding({
        projectId,
        includeDiscussion: true,
      }),
    });
    const deleteDiscussion = sinon.spy(persistence, "deleteDiscussion");

    render(panel(projectId, persistence));
    await screen.findByText("Persisted unresolved finding");
    const summary = screen.getByRole("article", {
      name: "Discussion summary",
    });
    fireEvent.click(
      within(summary).getByRole("button", {
        name: "Delete discussion",
      }),
    );
    confirmDeleteDiscussion();

    await waitFor(() => {
      expect(deleteDiscussion.calledOnce).to.equal(true);
      expect(persistence.read(projectId).discussions).to.have.length(0);
    });
    expect(screen.getByText("Persisted unresolved finding")).to.exist;
    expect(screen.queryByRole("article", { name: "Discussion summary" })).not.to
      .exist;
  });

  it("keeps a cancelled run with visible findings after discussion deletion", async function () {
    const projectId = "cancelled-run-discussion-deletion-project";
    const persistence = new MemoryWorkspacePersistence({
      [projectId]: workspaceWithFinding({
        projectId,
        includeDiscussion: true,
      }),
    });
    const deleteDiscussion = sinon.spy(persistence, "deleteDiscussion");
    const cancelledFindingTitle = "Cancelled run finding remains visible";
    const streamRequest = sinon
      .stub()
      .callsFake((call: ConversationStreamCall) => {
        call.onEvent({
          type: "started",
          eventId: `${call.request.requestId}-started`,
          requestId: call.request.requestId,
          sequence: 0,
          createdAt,
          provider: "fake",
          model: "deterministic-v1",
          skill: call.request.skill,
        });
        call.onEvent({
          type: "finding",
          eventId: `${call.request.requestId}-finding`,
          requestId: call.request.requestId,
          sequence: 1,
          createdAt,
          finding: sourceFinding(
            call.request,
            "cancelled-run-finding",
            cancelledFindingTitle,
          ),
        });
        return new Promise<void>((_resolve, reject) => {
          call.signal.addEventListener(
            "abort",
            () => reject(call.signal.reason),
            {
              once: true,
            },
          );
        });
      });

    render(
      panel(projectId, persistence, {
        createRequestId: () => "cancelled-run-request",
        captureSelectionSession: async ({ action, instruction }) => {
          const source = sourceRequest(projectId);
          if (source.scope == null || source.scope.kind === "project") {
            throw new Error(
              "The cancelled run fixture requires document scope.",
            );
          }
          const scope = source.scope;
          const request: AgentRequest = {
            ...source,
            requestId: "cancelled-run-request",
            action,
            instruction,
          };
          const shareDocument = {
            connection: { state: "ok" },
            getVersion: () => scope.baseRevision,
          };
          const currentDocument = {
            doc_id: scope.documentId,
            joined: true,
            doc: shareDocument,
            getSnapshot: () => scope.text,
            hasBufferedOps: () => false,
            getTrackingChanges: () => false,
          };
          return {
            status: "ready",
            session: Object.freeze({
              request: Object.freeze(request),
              binding: Object.freeze({
                currentDocument,
                shareDocument,
                trackChanges: false,
                connectionEpoch: 1,
              }),
            }),
          };
        },
        streamRequest,
      }),
    );

    await screen.findByText("Persisted unresolved finding");
    runSelectionAction("review");
    await screen.findByText(cancelledFindingTitle);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await screen.findByText("Cancelled");

    const summary = screen.getByRole("article", {
      name: "Discussion summary",
    });
    fireEvent.click(
      within(summary).getByRole("button", { name: "Delete discussion" }),
    );
    confirmDeleteDiscussion();

    await waitFor(() => expect(deleteDiscussion.calledOnce).to.equal(true));
    expect(screen.getByRole("article", { name: "Review run 2" })).to.exist;
    expect(screen.getByText(cancelledFindingTitle)).to.exist;
    expect(screen.getByText("Cancelled")).to.exist;
    expect(persistence.read(projectId).runs).to.have.length(1);
  });

  it("confirms one discussion deletion and preserves the other saved work after reload", async function () {
    const projectId = "isolated-discussion-deletion-project";
    const stored = workspaceWithFinding({
      projectId,
      includeDiscussion: true,
    });
    stored.discussions.push({
      id: "surviving-discussion",
      createdOrder: 3,
      subjectKey: null,
      subject: null,
      sourceGeneration: null,
      turns: [
        {
          role: "user",
          text: "Keep this other discussion.",
        },
        {
          role: "assistant",
          text: "This other discussion remains saved.",
        },
      ],
      suggestions: [],
      updatedAt: createdAt,
    });
    const persistence = new MemoryWorkspacePersistence({});
    const save = sinon.spy(persistence, "save");
    await persistence.save(
      projectId,
      AiReviewerWorkspaceSchema.parse(stored),
      0,
      new AbortController().signal,
    );
    const deleteDiscussion = sinon.spy(persistence, "deleteDiscussion");
    const openPanel = () => panel(projectId, persistence);

    const first = render(openPanel());
    await screen.findByText("Persisted unresolved finding");
    const summaries = screen.getAllByRole("article", {
      name: "Discussion summary",
    });
    expect(summaries).to.have.length(2);
    fireEvent.click(
      within(summaries[0]).getByRole("button", {
        name: "Finding: Persisted unresolved finding",
      }),
    );
    const activeDiscussion = screen.getByRole("article", {
      name: "AI reviewer discussion",
    });
    fireEvent.click(
      within(activeDiscussion).getByRole("button", {
        name: "Delete discussion",
      }),
    );

    expect(deleteDiscussion.called).to.equal(false);
    expect(await screen.findByText("Delete this discussion?")).to.exist;
    confirmDeleteDiscussion();

    await waitFor(() => {
      expect(deleteDiscussion.calledOnce).to.equal(true);
      expect(
        persistence.read(projectId).discussions.map(({ id }) => id),
      ).to.deep.equal(["surviving-discussion"]);
      expect(persistence.read(projectId).runs).to.have.length(1);
      expect(persistence.read(projectId).runs[0].findings).to.have.length(1);
      expect(screen.getByText("Persisted unresolved finding")).to.exist;
      expect(screen.getByRole("article", { name: "Discussion summary" })).to
        .exist;
    });
    first.unmount();

    render(openPanel());
    await screen.findByText("Persisted unresolved finding");
    const survivingSummary = screen.getByRole("article", {
      name: "Discussion summary",
    });
    expect(within(survivingSummary).getByRole("button", { name: "No subject" }))
      .to.exist;
    expect(screen.getByLabelText("Review run 1")).to.exist;
    expect(save.calledOnce).to.equal(true);
    expect(deleteDiscussion.calledOnce).to.equal(true);
  });

  it("returns to the review list when the active discussion is deleted", async function () {
    const projectId = "active-discussion-draft-deletion-project";
    const persistence = new MemoryWorkspacePersistence({
      [projectId]: workspaceWithFinding({
        projectId,
        includeDiscussion: true,
      }),
    });
    const pendingDelete = deferred();
    persistence.discussionDeleteGates.set(
      `${projectId}:persistence-discussion`,
      pendingDelete.promise,
    );

    render(panel(projectId, persistence));
    await screen.findByText("Persisted unresolved finding");
    const summary = screen.getByRole("article", {
      name: "Discussion summary",
    });
    fireEvent.click(
      within(summary).getByRole("button", {
        name: "Finding: Persisted unresolved finding",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Delete discussion",
      }),
    );
    confirmDeleteDiscussion();

    await act(async () => {
      pendingDelete.resolve();
      await pendingDelete.promise;
    });
    await waitFor(() => {
      expect(persistence.read(projectId).discussions).to.have.length(0);
      expect(screen.queryByRole("article", { name: "Discussion summary" })).not
        .to.exist;
    });
    expect(screen.getByText("Persisted unresolved finding")).to.exist;
  });

  it("keeps review text on the next load after clearing its resolved artifact", async function () {
    const projectId = "resolved-project";
    const persistence = new MemoryWorkspacePersistence({
      [projectId]: workspaceWithFinding({ projectId }),
    });
    const load = sinon.spy(persistence, "load");
    const save = sinon.spy(persistence, "save");

    const first = render(panel(projectId, persistence));
    await screen.findByText("Persisted unresolved finding");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Discard finding",
      }),
    );
    expect(await screen.findByText("Status: Discarded")).to.exist;
    expect(screen.getByLabelText("Review run 1")).to.exist;
    await waitFor(() => {
      expect(save.called).to.equal(true);
      expect(persistence.read(projectId).runs[0]?.findings[0]?.status).to.equal(
        "discarded",
      );
    });
    first.unmount();

    render(panel(projectId, persistence));
    await waitFor(() => {
      expect(load.callCount).to.equal(2);
      expect(
        screen
          .getByRole("button", {
            name: "Selected mode — Freeform",
          })
          .hasAttribute("disabled"),
      ).to.equal(false);
    });
    expect(screen.getByLabelText("Review run 1")).to.exist;
    expect(persistence.read(projectId).runs).to.deep.equal([
      {
        ...workspaceWithFinding({ projectId }).runs[0],
        findings: [],
      },
    ]);
    expect(persistence.read(projectId).runs[0].text).to.equal(
      "Stored review text",
    );
  });

  it("deletes one discussion and then all saved review work", async function () {
    const projectId = "deletion-project";
    const persistence = new MemoryWorkspacePersistence({
      [projectId]: workspaceWithFinding({
        projectId,
        includeDiscussion: true,
      }),
    });
    const deleteDiscussion = sinon.spy(persistence, "deleteDiscussion");
    const deleteAll = sinon.spy(persistence, "deleteAll");
    const save = sinon.spy(persistence, "save");
    const pendingDelete = deferred();
    persistence.discussionDeleteGates.set(
      `${projectId}:persistence-discussion`,
      pendingDelete.promise,
    );

    render(panel(projectId, persistence));
    await screen.findByText("Persisted unresolved finding");
    const summary = screen.getByRole("article", {
      name: "Discussion summary",
    });
    fireEvent.click(
      within(summary).getByRole("button", {
        name: "Delete discussion",
      }),
    );
    confirmDeleteDiscussion();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Discard finding",
      }),
    );
    expect(await screen.findByText("Status: Discarded")).to.exist;
    await act(async () => {
      pendingDelete.resolve();
      await pendingDelete.promise;
    });
    await waitFor(() => {
      expect(deleteDiscussion.calledOnce).to.equal(true);
      expect(save.calledOnce).to.equal(true);
      expect(save.firstCall.args[1].runs[0]?.findings[0]?.status).to.equal(
        "discarded",
      );
      expect(
        screen.queryByRole("article", {
          name: "Discussion summary",
        }),
      ).not.to.exist;
    });
    expect(screen.getByLabelText("Review run 1")).to.exist;
    expect(persistence.read(projectId).discussions).to.have.length(0);

    requestDeleteAll();
    expect(deleteAll.called).to.equal(false);
    confirmDeleteAll();
    await waitFor(() => {
      expect(deleteAll.calledOnce).to.equal(true);
      expect(screen.queryByLabelText("Review run 1")).not.to.exist;
    });
    expect(persistence.read(projectId)).to.deep.equal(emptyWorkspace());
  });

  it("removes the suggestion card when deleting all saved review work", async function () {
    const projectId = "preview-deletion-project";
    const request = sourceRequest(projectId);
    const suggestion = sourceSuggestion(request);
    const shareDocument = {
      connection: {
        state: "ok",
      },
      getVersion: () => 7,
    };
    const currentDocument = {
      doc_id: `${projectId}-document`,
      joined: true,
      doc: shareDocument,
      getSnapshot: () => "Alpha beta gamma.",
      hasBufferedOps: () => false,
      getTrackingChanges: () => false,
    };
    const session = {
      request,
      binding: {
        currentDocument,
        shareDocument,
        trackChanges: false,
        connectionEpoch: 1,
      },
    };
    const persistence = new MemoryWorkspacePersistence({});
    const deleteAll = sinon.spy(persistence, "deleteAll");
    const streamRequest: NonNullable<
      React.ComponentProps<typeof AiReviewerPanelView>["streamRequest"]
    > = async ({ onEvent }) => {
      onEvent({
        type: "started",
        eventId: "preview-delete-started",
        requestId: request.requestId,
        sequence: 0,
        createdAt,
        provider: "fake",
        model: "deterministic-v1",
        skill: request.skill,
      });
      onEvent({
        type: "suggestion",
        eventId: "preview-delete-suggestion",
        requestId: request.requestId,
        sequence: 1,
        createdAt,
        suggestion,
      });
      onEvent({
        type: "completed",
        eventId: "preview-delete-completed",
        requestId: request.requestId,
        sequence: 2,
        createdAt,
        finishReason: "stop",
      });
    };

    render(
      panel(projectId, persistence, {
        createRequestId: () => request.requestId,
        captureSelectionSession: async () => ({
          status: "ready",
          session,
        }),
        getSelectionContext: sinon.stub(),
        streamRequest,
      }),
    );
    await waitFor(() => expect(isSelectionToolbarBusy()).to.equal(false));
    runSelectionAction("review");
    await screen.findByText("Completed");
    expect(screen.getByRole("button", { name: "Apply" })).to.exist;

    const deleteButton = getDeleteAllMenuItem();
    expect(deleteButton.hasAttribute("disabled")).to.equal(false);
    fireEvent.click(deleteButton);
    expect(deleteAll.called).to.equal(false);
    confirmDeleteAll();

    await waitFor(() => {
      expect(deleteAll.calledOnce).to.equal(true);
    });
    expect(persistence.read(projectId)).to.deep.equal(emptyWorkspace());
    expect(screen.queryByRole("button", { name: "Apply" })).not.to.exist;
  });

  it("cancels an in-flight suggestion Apply when deleting all saved review work", async function () {
    const projectId = "apply-cancel-project";
    const request = sourceRequest(projectId);
    const suggestion = sourceSuggestion(request);
    const shareDocument = {
      connection: {
        state: "ok",
      },
      getVersion: () => 7,
    };
    const currentDocument = {
      doc_id: `${projectId}-document`,
      joined: true,
      doc: shareDocument,
      getSnapshot: () => "Alpha beta gamma.",
      hasBufferedOps: () => false,
      getTrackingChanges: () => false,
    };
    const session = {
      request,
      binding: {
        currentDocument,
        shareDocument,
        trackChanges: false,
        connectionEpoch: 1,
      },
    };
    const persistence = new MemoryWorkspacePersistence({});
    const deleteAll = sinon.spy(persistence, "deleteAll");
    // The plan compilation stays pending until after the deletion so the
    // Apply is genuinely in flight when the workspace goes away.
    let releaseHunkIds: (ids: readonly string[]) => void = () => {};
    const hunkIdsGate = new Promise<readonly string[]>((resolve) => {
      releaseHunkIds = resolve;
    });
    const getSuggestionHunkIds = sinon.stub().returns(hunkIdsGate);
    const applySelectionSuggestion = sinon.stub().resolves({
      status: "applied",
    });
    const streamRequest: NonNullable<
      React.ComponentProps<typeof AiReviewerPanelView>["streamRequest"]
    > = async ({ onEvent }) => {
      onEvent({
        type: "started",
        eventId: "apply-cancel-started",
        requestId: request.requestId,
        sequence: 0,
        createdAt,
        provider: "fake",
        model: "deterministic-v1",
        skill: request.skill,
      });
      onEvent({
        type: "suggestion",
        eventId: "apply-cancel-suggestion",
        requestId: request.requestId,
        sequence: 1,
        createdAt,
        suggestion,
      });
      onEvent({
        type: "completed",
        eventId: "apply-cancel-completed",
        requestId: request.requestId,
        sequence: 2,
        createdAt,
        finishReason: "stop",
      });
    };

    render(
      panel(projectId, persistence, {
        createRequestId: () => request.requestId,
        captureSelectionSession: async () => ({
          status: "ready",
          session,
        }),
        getSelectionContext: sinon.stub(),
        getSuggestionHunkIds,
        applySelectionSuggestion,
        streamRequest,
      }),
    );
    await waitFor(() => expect(isSelectionToolbarBusy()).to.equal(false));
    runSelectionAction("review");
    await screen.findByText("Completed");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => {
      expect(getSuggestionHunkIds.calledOnce).to.equal(true);
    });

    fireEvent.click(getDeleteAllMenuItem());
    confirmDeleteAll();
    await waitFor(() => {
      expect(deleteAll.calledOnce).to.equal(true);
    });

    releaseHunkIds(Object.freeze(["ai-hunk-v1-apply-cancel"]));
    await hunkIdsGate;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(applySelectionSuggestion.called).to.equal(false);
    expect(persistence.read(projectId)).to.deep.equal(emptyWorkspace());
    expect(screen.queryByRole("button", { name: "Apply" })).not.to.exist;
    expect(screen.queryByText("The suggestion could not be applied.")).not.to
      .exist;
  });

  it("blocks mutations after a stale save instead of hydrating away unsaved work", async function () {
    const projectId = "stale-save-project";
    const persistence = new MemoryWorkspacePersistence({
      [projectId]: workspaceWithFinding({
        projectId,
        includeDiscussion: true,
      }),
    });
    const save = sinon
      .stub(persistence, "save")
      .rejects(
        new AiReviewerWorkspacePersistenceError(
          workspaceChangedMessage,
          "AI_REVIEWER_WORKSPACE_CHANGED",
        ),
      );
    const deleteDiscussion = sinon.spy(persistence, "deleteDiscussion");

    render(panel(projectId, persistence));
    const discard = await screen.findByRole("button", {
      name: "Discard finding",
    });
    fireEvent.click(discard);

    expect(await screen.findByText(workspaceChangedMessage)).to.exist;
    expect(save.calledOnce).to.equal(true);
    const deleteDiscussionButton = screen.getByRole("button", {
      name: "Delete discussion",
    });
    expect(deleteDiscussionButton.hasAttribute("disabled")).to.equal(true);
    expect(getDeleteAllMenuItem().getAttribute("aria-disabled")).to.equal(
      "true",
    );
    expect(
      screen
        .getByRole("button", {
          name: "Selected mode — Freeform",
        })
        .hasAttribute("disabled"),
    ).to.equal(true);

    fireEvent.click(deleteDiscussionButton);
    expect(deleteDiscussion.called).to.equal(false);
    expect(persistence.read(projectId).discussions).to.have.length(1);
  });

  for (const deletionName of [
    "Delete discussion",
    "Delete all saved review work",
  ]) {
    it(`does not run a queued ${deletionName.toLowerCase()} after a stale save`, async function () {
      const projectId = `queued-${deletionName.replaceAll(" ", "-").toLowerCase()}-project`;
      const persistence = new MemoryWorkspacePersistence({
        [projectId]: workspaceWithFinding({
          projectId,
          includeDiscussion: true,
        }),
      });
      const pendingSave = deferred();
      const save = sinon.stub(persistence, "save").callsFake(async () => {
        await pendingSave.promise;
        throw new AiReviewerWorkspacePersistenceError(
          workspaceChangedMessage,
          "AI_REVIEWER_WORKSPACE_CHANGED",
        );
      });
      const deleteDiscussion = sinon.spy(persistence, "deleteDiscussion");
      const deleteAll = sinon.spy(persistence, "deleteAll");

      render(panel(projectId, persistence));
      fireEvent.click(
        await screen.findByRole("button", {
          name: "Discard finding",
        }),
      );
      await waitFor(() => {
        expect(save.calledOnce).to.equal(true);
      });
      if (deletionName === "Delete all saved review work") {
        requestDeleteAll();
        confirmDeleteAll();
      } else {
        fireEvent.click(
          screen.getByRole("button", {
            name: deletionName,
          }),
        );
        confirmDeleteDiscussion();
      }

      await act(async () => {
        pendingSave.resolve();
        await pendingSave.promise;
      });
      expect(await screen.findByText(workspaceChangedMessage)).to.exist;
      await act(async () => {
        await Promise.resolve();
      });

      expect(deleteDiscussion.called).to.equal(false);
      expect(deleteAll.called).to.equal(false);
      expect(persistence.read(projectId).discussions).to.have.length(1);
    });
  }

  it("retains a concurrent server decision instead of overwriting it during discussion deletion", async function () {
    const projectId = "concurrent-decision-project";
    const stored = workspaceWithFinding({
      projectId,
      includeDiscussion: true,
    });
    stored.runs[0].suggestions = [
      {
        artifact: sourceSuggestion(stored.runs[0].request),
      },
    ];
    const persistence = new MemoryWorkspacePersistence({
      [projectId]: AiReviewerWorkspaceSchema.parse(stored),
    });
    const pendingDelete = deferred();
    persistence.discussionDeleteGates.set(
      `${projectId}:persistence-discussion`,
      pendingDelete.promise,
    );
    const save = sinon.spy(persistence, "save");

    render(panel(projectId, persistence));
    const summary = await screen.findByRole("article", {
      name: "Discussion summary",
    });
    fireEvent.click(
      within(summary).getByRole("button", {
        name: "Delete discussion",
      }),
    );
    confirmDeleteDiscussion();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Discard suggestion",
      }),
    );
    expect(await screen.findByText("Status: Discarded")).to.exist;

    const concurrentWorkspace = persistence.read(projectId);
    concurrentWorkspace.runs[0].suggestions[0].artifact.status = "applied";
    persistence.stores.set(projectId, concurrentWorkspace);
    persistence.revisions.set(
      projectId,
      (persistence.revisions.get(projectId) ?? 0) + 1,
    );
    await act(async () => {
      pendingDelete.resolve();
      await pendingDelete.promise;
    });

    expect(await screen.findByText(workspaceChangedMessage)).to.exist;
    expect(await screen.findByText("Status: Discarded")).to.exist;
    expect(save.called).to.equal(false);
    expect(
      persistence.read(projectId).runs[0].suggestions[0].artifact.status,
    ).to.equal("applied");
    expect(persistence.read(projectId).discussions).to.have.length(1);
  });

  it("freezes on a locally decided suggestion removed by the server during discussion deletion", async function () {
    const projectId = "removed-concurrent-decision-project";
    const stored = workspaceWithFinding({
      projectId,
      includeDiscussion: true,
    });
    stored.runs[0].suggestions = [
      {
        artifact: sourceSuggestion(stored.runs[0].request),
      },
    ];
    const persistence = new MemoryWorkspacePersistence({
      [projectId]: AiReviewerWorkspaceSchema.parse(stored),
    });
    const pendingDelete = deferred();
    persistence.discussionDeleteGates.set(
      `${projectId}:persistence-discussion`,
      pendingDelete.promise,
    );
    const save = sinon.spy(persistence, "save");

    render(panel(projectId, persistence));
    const summary = await screen.findByRole("article", {
      name: "Discussion summary",
    });
    fireEvent.click(
      within(summary).getByRole("button", {
        name: "Delete discussion",
      }),
    );
    confirmDeleteDiscussion();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Discard suggestion",
      }),
    );
    expect(await screen.findByText("Status: Discarded")).to.exist;

    const concurrentWorkspace = persistence.read(projectId);
    concurrentWorkspace.runs[0].suggestions = [];
    persistence.stores.set(projectId, concurrentWorkspace);
    persistence.revisions.set(
      projectId,
      (persistence.revisions.get(projectId) ?? 0) + 1,
    );
    const exactServerWorkspace = concurrentWorkspace;
    await act(async () => {
      pendingDelete.resolve();
      await pendingDelete.promise;
    });

    expect(await screen.findByText(workspaceChangedMessage)).to.exist;
    expect(save.called).to.equal(false);
    expect(persistence.read(projectId)).to.deep.equal(exactServerWorkspace);
    expect(screen.getByText("Status: Discarded")).to.exist;
    expect(
      screen.getByRole("article", {
        name: "Discussion summary",
      }),
    ).to.exist;
  });

  it("rebinds a hydrated finding to the currently open document before navigation", async function () {
    const projectId = "rebind-project";
    const request = sourceRequest(projectId);
    if (request.scope.kind === "project") {
      throw new Error("The rebind fixture requires a document scope.");
    }
    const shareDocument = {
      connection: {
        state: "ok",
      },
      getVersion: () => request.scope.baseRevision,
    };
    const currentDocument = {
      doc_id: request.scope.documentId,
      joined: true,
      doc: shareDocument,
      getSnapshot: () => request.scope.text,
      hasBufferedOps: () => false,
      getTrackingChanges: () => false,
    };
    const getSelectionContext = (): EditorSelectionSessionContext => ({
      view: null,
      projectId,
      currentDocumentId: request.scope.documentId,
      path: request.scope.path,
      currentDocument,
      sourceMode: true,
      connected: true,
      connectionEpoch: 17,
      permissions: {
        read: true,
        write: true,
        trackedWrite: true,
      },
      trackChanges: false,
      wantTrackChanges: false,
    });
    const persistence = new MemoryWorkspacePersistence({
      [projectId]: workspaceWithFinding({ projectId }),
    });
    const navigateEvidence = sinon.stub().resolves({
      status: "navigated",
    });

    render(
      panel(projectId, persistence, {
        getSelectionContext,
        navigateEvidence,
      }),
    );
    const navigateButton = await screen.findByRole("button", {
      name: "Go to text",
    });
    fireEvent.click(navigateButton);
    await waitFor(() => {
      expect(navigateEvidence.calledOnce).to.equal(true);
    });
    expect(navigateEvidence.firstCall.args[0].target.currentDocument).to.equal(
      currentDocument,
    );
    expect(navigateEvidence.firstCall.args[0].target.shareDocument).to.equal(
      shareDocument,
    );
    expect(navigateEvidence.firstCall.args[0].getContext).to.equal(
      getSelectionContext,
    );
  });

  it("prompts for deletion at the discussion bound without dropping data", async function () {
    const projectId = "bounded-project";
    const request = sourceRequest(projectId);
    const discussions = Array.from(
      { length: AI_REVIEWER_WORKSPACE_DISCUSSION_LIMIT },
      (_, index) => {
        const finding = sourceFinding(
          request,
          `bound-finding-${index + 1}`,
          `Bound finding ${index + 1}`,
        );
        return discussion(request, finding, {
          id: `bound-discussion-${index + 1}`,
          createdOrder: index + 2,
        });
      },
    );
    const stored = AiReviewerWorkspaceSchema.parse({
      runs: [
        {
          generation: 1,
          createdOrder: 1,
          request,
          text: "",
          findings: [
            {
              artifact: sourceFinding(
                request,
                "bound-review-finding",
                "Bound review finding",
              ),
              status: "unresolved",
            },
          ],
          suggestions: [],
        },
      ],
      discussions,
    });
    const persistence = new MemoryWorkspacePersistence({
      [projectId]: stored,
    });
    const pendingSave = deferred();
    persistence.saveGates.set(projectId, pendingSave.promise);
    const save = sinon.spy(persistence, "save");
    const createDiscussionId = sinon.stub().returns("overflow-discussion");

    render(
      panel(projectId, persistence, {
        createDiscussionId,
      }),
    );
    await waitFor(() => {
      expect(
        screen.getAllByRole("article", {
          name: "Discussion summary",
        }),
      ).to.have.length(AI_REVIEWER_WORKSPACE_DISCUSSION_LIMIT);
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Discard finding",
      }),
    );
    await waitFor(() => {
      expect(save.calledOnce).to.equal(true);
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Discuss this run",
      }),
    );
    expect(await screen.findByText(workspaceLimitMessage)).to.exist;
    expect(createDiscussionId.called).to.equal(false);
    expect(
      screen.getAllByRole("article", {
        name: "Discussion summary",
      }),
    ).to.have.length(AI_REVIEWER_WORKSPACE_DISCUSSION_LIMIT);
    await act(async () => {
      pendingSave.resolve();
      await pendingSave.promise;
    });
    await waitFor(() => {
      expect(screen.getByText(workspaceLimitMessage)).to.exist;
    });
  });

  it("prompts for deletion at the turn bound without dropping input or starting a stream", async function () {
    const projectId = "turn-bounded-project";
    const request = sourceRequest(projectId);
    const finding = sourceFinding(request, "turn-bound-finding");
    const turns: DiscussionTurn[] = Array.from(
      { length: AI_REVIEWER_WORKSPACE_TURN_LIMIT - 1 },
      (_, index) => ({
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        text: `Stored turn ${index + 1}`,
      }),
    );
    const stored = AiReviewerWorkspaceSchema.parse({
      runs: [
        {
          generation: 1,
          createdOrder: 1,
          request,
          text: "",
          findings: [
            {
              artifact: finding,
              status: "unresolved",
            },
          ],
          suggestions: [],
        },
      ],
      discussions: [
        discussion(request, finding, {
          id: "turn-bound-discussion",
          createdOrder: 2,
          turns,
        }),
      ],
    });
    const persistence = new MemoryWorkspacePersistence({
      [projectId]: stored,
    });
    const streamRequest = sinon.stub();

    render(
      panel(projectId, persistence, {
        streamRequest,
      }),
    );
    const firstSummary = await screen.findByRole("article", {
      name: "Discussion summary",
    });
    fireEvent.click(
      within(firstSummary).getByRole("button", {
        name: "Finding: Persisted unresolved finding",
      }),
    );
    sendHostChatMessage("This turn must not be silently dropped.");

    expect(streamRequest.called).to.equal(false);
    expect(
      screen
        .getByLabelText("Discussion turns")
        .querySelectorAll(".chat-message"),
    ).to.have.length(AI_REVIEWER_WORKSPACE_TURN_LIMIT - 1);
    expect(screen.getByText(workspaceLimitMessage)).to.exist;
  });

  it("does not save the previous workspace into a newly selected project", async function () {
    const firstProjectId = "switch-project-a";
    const secondProjectId = "switch-project-b";
    const persistence = new MemoryWorkspacePersistence({
      [firstProjectId]: workspaceWithFinding({
        projectId: firstProjectId,
      }),
      [secondProjectId]: workspaceWithFinding({
        projectId: secondProjectId,
      }),
    });
    const secondLoad = deferred();
    const load = sinon.spy(persistence, "load");
    const save = sinon.spy(persistence, "save");
    const rendered = render(panel(firstProjectId, persistence));
    await screen.findByText("Persisted unresolved finding");
    save.resetHistory();
    persistence.loadGates.set(secondProjectId, secondLoad.promise);

    rendered.rerender(panel(secondProjectId, persistence));
    await waitFor(() => {
      expect(load.callCount).to.equal(2);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      save.getCalls().some((call) => call.args[0] === secondProjectId),
    ).to.equal(false);
    expect(
      persistence.read(secondProjectId).runs[0]?.request.projectId,
    ).to.equal(secondProjectId);

    await act(async () => {
      secondLoad.resolve();
      await secondLoad.promise;
    });
    await waitFor(() => {
      expect(
        screen
          .getByRole("button", {
            name: "Selected mode — Freeform",
          })
          .hasAttribute("disabled"),
      ).to.equal(false);
    });
    expect(
      save.getCalls().some((call) => call.args[0] === secondProjectId),
    ).to.equal(false);
  });
});
