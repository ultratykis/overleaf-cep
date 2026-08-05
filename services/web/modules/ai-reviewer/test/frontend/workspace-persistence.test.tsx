import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect } from "chai";
import React from "react";
import sinon from "sinon";

import { AiReviewerPanelView } from "../../frontend/js/components/ai-reviewer-panel";
import {
  AiReviewerWorkspacePersistenceError,
  type AiReviewerWorkspacePersistence,
  workspaceChangedMessage,
  workspaceLimitMessage,
} from "../../frontend/js/services/ai-reviewer-workspace-persistence";
import { streamDiscussionEvents } from "../../frontend/js/services/agent-stream";
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
  DiscussionEvent,
  DiscussionTurn,
  Finding,
  UnresolvedSuggestion,
  WorkspaceDiscussion,
} from "../../shared/contract-types";

type DiscussionStreamCall = Parameters<typeof streamDiscussionEvents>[0];

const createdAt = "2026-07-25T00:00:00.000Z";
const baseTextHash =
  "aea23d46109af9b94c5f15085d69113cc2cefa85f05748897a4df172a1ee5104";

function cloneWorkspace(workspace: AiReviewerWorkspace): AiReviewerWorkspace {
  return structuredClone(workspace);
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
          run.findings.length > 0 ||
          run.suggestions.length > 0 ||
          boundRequestIds.has(run.request.requestId),
      ),
    discussions,
  };
}

function dropUnboundEmptyRuns(
  workspace: AiReviewerWorkspace,
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
    _signal: AbortSignal,
  ): Promise<AiReviewerWorkspaceSnapshot> {
    await this.discussionDeleteGates.get(`${projectId}:${discussionId}`);
    const workspace = this.stores.get(projectId) ?? emptyWorkspace();
    const next = dropUnboundEmptyRuns({
      runs: workspace.runs,
      discussions: workspace.discussions.filter(
        (discussion) => discussion.id !== discussionId,
      ),
    });
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
  fireEvent.click(screen.getByRole("button", { name: "More options" }));
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

describe("AI reviewer: persisted review workspace", function () {
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

  it("persists, reloads, and deletes an open discussion", async function () {
    const projectId = "open-discussion-persistence-project";
    const persistence = new MemoryWorkspacePersistence({});
    const save = sinon.spy(persistence, "save");
    const deleteDiscussion = sinon.spy(persistence, "deleteDiscussion");
    let requestNumber = 0;
    const streamDiscussionRequest = sinon
      .stub()
      .callsFake(async (call: DiscussionStreamCall) => {
        const { requestId } = call.request;
        const events: DiscussionEvent[] = [
          {
            type: "started",
            eventId: `${requestId}-started`,
            requestId,
            sequence: 0,
            createdAt,
            provider: "fake",
            model: "deterministic-v1",
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
        now: () => createdAt,
        streamDiscussionRequest,
      });

    const first = render(openPanel());
    const input = screen.getByLabelText(
      "Discussion message",
    ) as HTMLTextAreaElement;
    await waitFor(() => {
      expect(input.disabled).to.equal(false);
    });
    fireEvent.change(input, {
      target: {
        value: "Keep this open question.",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    expect(
      await screen.findByRole("region", {
        name: "AI reviewer discussion",
      }),
    ).to.exist;
    expect(screen.getByTestId("discussion-subject").textContent).to.equal(
      "No subject",
    );
    expect(screen.getByText("Keep this open question.")).to.exist;
    expect(screen.getByText("This answer must survive a reload.")).to.exist;
    await waitFor(() => {
      expect(save.calledOnce).to.equal(true);
      expect(persistence.read(projectId)).to.deep.equal({
        runs: [],
        discussions: [
          {
            id: "persisted-open-discussion",
            createdOrder: 1,
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
        ],
      });
    });
    first.unmount();

    render(openPanel());
    const summary = await screen.findByRole("article", {
      name: "Discussion summary",
    });
    fireEvent.click(
      within(summary).getByRole("button", {
        name: "No subject",
      }),
    );
    expect(await screen.findByText("Keep this open question.")).to.exist;
    expect(screen.getByText("This answer must survive a reload.")).to.exist;
    fireEvent.click(
      screen.getByRole("button", {
        name: "Delete discussion",
      }),
    );

    await waitFor(() => {
      expect(deleteDiscussion.calledOnce).to.equal(true);
      expect(persistence.read(projectId)).to.deep.equal(emptyWorkspace());
      expect(
        screen.queryByRole("article", {
          name: "Discussion summary",
        }),
      ).not.to.exist;
    });
  });

  it("preserves an open-discussion draft when deleting another discussion", async function () {
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
    const input = screen.getByLabelText(
      "Discussion message",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, {
      target: {
        value: "Keep this unsent open-discussion draft.",
      },
    });
    const summary = screen.getByRole("article", {
      name: "Discussion summary",
    });
    fireEvent.click(
      within(summary).getByRole("button", {
        name: "Delete discussion",
      }),
    );

    await waitFor(() => {
      expect(deleteDiscussion.calledOnce).to.equal(true);
      expect(persistence.read(projectId).discussions).to.have.length(0);
    });
    expect(input.value).to.equal("Keep this unsent open-discussion draft.");
  });

  it("clears an active discussion draft after navigating back during deletion", async function () {
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
    const input = screen.getByLabelText(
      "Discussion message",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, {
      target: {
        value: "Delete this subject-bound draft.",
      },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Delete discussion",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Back to review list",
      }),
    );

    await act(async () => {
      pendingDelete.resolve();
      await pendingDelete.promise;
    });
    await waitFor(() => {
      expect(persistence.read(projectId).discussions).to.have.length(0);
      expect(
        (screen.getByLabelText("Discussion message") as HTMLTextAreaElement)
          .value,
      ).to.equal("");
    });
  });

  it("keeps a resolved artifact collapsed until the next load, then removes its empty run", async function () {
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
            name: "Run review",
          })
          .hasAttribute("disabled"),
      ).to.equal(false);
    });
    expect(screen.queryByLabelText("Review run 1")).not.to.exist;
    expect(persistence.read(projectId)).to.deep.equal(emptyWorkspace());
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

  it("disposes a ready suggestion preview before deleting all saved review work", async function () {
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
    const destroy = sinon.stub();
    const mountSuggestionPreview = sinon.stub().callsFake(async (options) => {
      options.onSelectionChange([]);
      return {
        hunkIds: Object.freeze(["ai-hunk-v1-persistence-delete"]),
        destroy,
      };
    });
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
        mountSuggestionPreview,
        streamRequest,
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Review selection",
      }),
    );
    await screen.findByText("Completed");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Preview diff 1",
      }),
    );
    await screen.findByText("Suggestion preview ready");

    const deleteButton = getDeleteAllMenuItem();
    expect(deleteButton.hasAttribute("disabled")).to.equal(false);
    fireEvent.click(deleteButton);
    expect(deleteAll.called).to.equal(false);
    confirmDeleteAll();

    await waitFor(() => {
      expect(deleteAll.calledOnce).to.equal(true);
      expect(destroy.calledOnce).to.equal(true);
    });
    expect(persistence.read(projectId)).to.deep.equal(emptyWorkspace());
    expect(screen.queryByText("Suggestion preview ready")).not.to.exist;
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
          name: "Run review",
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
      const save = sinon.stub(persistence, "save").callsFake(async function () {
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
    expect(await screen.findByText("Status: Applied")).to.exist;
    expect(save.called).to.equal(false);
    expect(
      persistence.read(projectId).runs[0].suggestions[0].artifact.status,
    ).to.equal("applied");
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
    const exactServerWorkspace = {
      runs: concurrentWorkspace.runs,
      discussions: [],
    };
    await act(async () => {
      pendingDelete.resolve();
      await pendingDelete.promise;
    });

    expect(await screen.findByText(workspaceChangedMessage)).to.exist;
    expect(save.called).to.equal(false);
    expect(persistence.read(projectId)).to.deep.equal(exactServerWorkspace);
    expect(screen.queryByText("Status: Discarded")).not.to.exist;
    expect(
      screen.queryByRole("article", {
        name: "Discussion summary",
      }),
    ).not.to.exist;
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
        name: "Discuss review scope",
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
    const streamDiscussionRequest = sinon.stub();

    render(
      panel(projectId, persistence, {
        streamDiscussionRequest,
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
    const input = screen.getByLabelText(
      "Discussion message",
    ) as HTMLTextAreaElement;
    fireEvent.change(input, {
      target: {
        value: "This turn must not be silently dropped.",
      },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "Send message",
      }),
    );
    expect(streamDiscussionRequest.called).to.equal(false);
    expect(input.value).to.equal("This turn must not be silently dropped.");
    expect(screen.getAllByLabelText(/Your message|AI response/)).to.have.length(
      AI_REVIEWER_WORKSPACE_TURN_LIMIT - 1,
    );
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
            name: "Run review",
          })
          .hasAttribute("disabled"),
      ).to.equal(false);
    });
    expect(
      save.getCalls().some((call) => call.args[0] === secondProjectId),
    ).to.equal(false);
  });
});
