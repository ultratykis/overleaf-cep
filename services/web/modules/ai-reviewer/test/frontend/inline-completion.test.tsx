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
import React from "react";
import sinon from "sinon";

import { AiReviewerPanelView } from "../../frontend/js/components/ai-reviewer-panel";
import {
  completionRequestContext,
  extension as inlineCompletionExtension,
} from "../../frontend/js/extensions/inline-completion";
import {
  INLINE_COMPLETION_STORAGE_KEY,
  getInlineCompletionState,
  inlineCompletionGate,
  publishInlineCompletionAvailability,
  publishInlineCompletionPause,
  setInlineCompletionEnabled,
} from "../../frontend/js/services/inline-completion-state";
import type { AiProviderConnection } from "../../frontend/js/services/ai-provider-configuration";
import type { AiReviewerWorkspacePersistence } from "../../frontend/js/services/ai-reviewer-workspace-persistence";
import type {
  AiReviewerWorkspace,
  WorkspaceModelSelection,
} from "../../shared/contract-types";

const projectId = "inline-completion-project";

const remoteConnection: AiProviderConnection = {
  id: "remote-connection",
  revision: 1,
  label: "Remote",
  classification: "remote",
  config: {
    provider: "openai-compatible",
    baseUrl: "https://example.com/v1",
    contextLengthOverride: null,
    credentialSet: false,
    credentialUpdatedAt: null,
  },
};

const localConnection: AiProviderConnection = {
  id: "local-connection",
  revision: 1,
  label: "Local",
  classification: "local",
  config: {
    provider: "openai-compatible",
    baseUrl: "http://127.0.0.1:11434/v1",
    contextLengthOverride: null,
    credentialSet: false,
    credentialUpdatedAt: null,
  },
};

function workspacePersistence(
  selectedModel: WorkspaceModelSelection,
  settings: Pick<
    AiReviewerWorkspace,
    "inlineCompletionEnabled" | "completionModel"
  > = {},
  onSave?: (workspace: AiReviewerWorkspace) => void,
): AiReviewerWorkspacePersistence {
  let workspace: AiReviewerWorkspace = {
    runs: [],
    discussions: [],
    selectedModel,
    ...settings,
  };
  return {
    load: async () => ({ revision: 0, workspace }),
    save: async (_projectId, nextWorkspace) => {
      workspace = nextWorkspace;
      onSave?.(workspace);
      return { revision: 1, workspace };
    },
    deleteDiscussion: async () => ({ revision: 1, workspace }),
    deleteAll: async () => ({
      revision: 1,
      workspace: { runs: [], discussions: [] },
    }),
  };
}

function renderPanel(
  connections: AiProviderConnection[],
  selectedModel: WorkspaceModelSelection,
  settings?: Pick<
    AiReviewerWorkspace,
    "inlineCompletionEnabled" | "completionModel"
  >,
  onSave?: (workspace: AiReviewerWorkspace) => void,
) {
  return render(
    <AiReviewerPanelView
      projectId={projectId}
      workspacePersistence={workspacePersistence(
        selectedModel,
        settings,
        onSave,
      )}
      loadProviderConnections={async () => ({ connections })}
      loadProviderModels={async () => ({
        models: connections.map((connection) => ({
          id: `${connection.id}-model`,
          displayName: connection.label,
          connectionId: connection.id,
          connectionLabel: connection.label,
          contextLength: 8_192,
          contextLengthSource: "detected" as const,
        })),
        failures: [],
      })}
    />,
  );
}

async function flushPromises() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
}

describe("AI reviewer: inline completion", function () {
  beforeEach(function () {
    localStorage.removeItem(INLINE_COMPLETION_STORAGE_KEY);
    setInlineCompletionEnabled(false);
    publishInlineCompletionPause(null);
  });

  it("slices bounded cursor context and fixes maxLength at 60", function () {
    const text = Array.from(
      { length: 15 },
      (_, index) => `line ${index + 1}`,
    ).join("\n");
    const cursor = text.indexOf("line 13") + "line".length;

    expect(completionRequestContext(text, cursor)).to.deep.equal({
      leftContext: [
        "line 3",
        "line 4",
        "line 5",
        "line 6",
        "line 7",
        "line 8",
        "line 9",
        "line 10",
        "line 11",
        "line 12",
        "line",
      ].join("\n"),
      rightContext: " 13\nline 14\nline 15",
      maxLength: 60,
    });
  });

  it("clamps single-line paragraphs to the endpoint's character bounds", function () {
    const text = `${"a".repeat(6_000)}\n${"b".repeat(3_000)}`;
    const cursor = 6_000;

    const context = completionRequestContext(text, cursor);
    expect(context.leftContext).to.equal("a".repeat(4_000));
    expect(context.rightContext).to.equal(`\n${"b".repeat(999)}`);
  });

  it("sends the published model and clears its repeated-failure pause after 60 seconds", async function () {
    const clock = sinon.useFakeTimers();
    const fetchStub = sinon.stub(globalThis, "fetch").resolves({
      ok: false,
      json: async () => ({ success: false }),
    } as Response);
    setInlineCompletionEnabled(true);
    publishInlineCompletionAvailability({
      hasLocalConnection: true,
      selectedConnectionClassification: "local",
      selectedConnectionId: localConnection.id,
      selectedModel: "dedicated-completion-model",
    });
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "Draft",
        extensions: [inlineCompletionExtension({})],
      }),
    });

    try {
      for (const character of [" ", "a", "b"]) {
        const from = view.state.doc.length;
        view.dispatch({
          changes: { from, insert: character },
          selection: { anchor: from + 1 },
        });
        clock.tick(1_000);
        await flushPromises();
      }

      expect(fetchStub).to.have.been.calledThrice;
      expect(
        JSON.parse(fetchStub.firstCall.args[1]?.body as string),
      ).to.include({
        connectionId: localConnection.id,
        model: "dedicated-completion-model",
      });
      expect(getInlineCompletionState().pausedUntil).to.equal(
        Date.now() + 60_000,
      );

      clock.tick(60_000);

      expect(getInlineCompletionState().pausedUntil).to.equal(null);
    } finally {
      view.destroy();
      parent.remove();
      fetchStub.restore();
      clock.restore();
    }
  });

  it("gates requests when off, without local connections, or on a remote selection", function () {
    expect(
      inlineCompletionGate({
        enabled: false,
        hasLocalConnection: true,
        selectedConnectionClassification: "local",
      }),
    ).to.equal("off");
    expect(
      inlineCompletionGate({
        enabled: true,
        hasLocalConnection: false,
        selectedConnectionClassification: null,
      }),
    ).to.equal("no-local");
    expect(
      inlineCompletionGate({
        enabled: true,
        hasLocalConnection: true,
        selectedConnectionClassification: "remote",
      }),
    ).to.equal("remote");
    expect(
      inlineCompletionGate({
        enabled: true,
        hasLocalConnection: true,
        selectedConnectionClassification: "local",
      }),
    ).to.equal("active");
  });

  it("persists the opt-in in workspace state instead of localStorage", async function () {
    localStorage.setItem(INLINE_COMPLETION_STORAGE_KEY, "false");
    const saved: AiReviewerWorkspace[] = [];
    renderPanel(
      [localConnection],
      {
        connectionId: localConnection.id,
        model: "local-connection-model",
      },
      { inlineCompletionEnabled: true },
      (workspace) => saved.push(workspace),
    );

    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    const toggle = await screen.findByRole("checkbox", {
      name: "Inline completion",
    });
    expect(toggle).to.have.property("checked", true);

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(saved.at(-1)?.inlineCompletionEnabled).to.equal(false);
    });
    expect(localStorage.getItem(INLINE_COMPLETION_STORAGE_KEY)).to.equal(null);
  });

  it("adopts the legacy true value once when the persisted value is absent", async function () {
    localStorage.setItem(INLINE_COMPLETION_STORAGE_KEY, "true");
    const saved: AiReviewerWorkspace[] = [];
    renderPanel(
      [localConnection],
      {
        connectionId: localConnection.id,
        model: "local-connection-model",
      },
      undefined,
      (workspace) => saved.push(workspace),
    );

    await waitFor(() => {
      expect(saved.at(-1)?.inlineCompletionEnabled).to.equal(true);
    });
    expect(localStorage.getItem(INLINE_COMPLETION_STORAGE_KEY)).to.equal(null);
  });

  it("does not let legacy localStorage override an explicit persisted false", async function () {
    localStorage.setItem(INLINE_COMPLETION_STORAGE_KEY, "true");
    renderPanel(
      [localConnection],
      {
        connectionId: localConnection.id,
        model: "local-connection-model",
      },
      { inlineCompletionEnabled: false },
    );

    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    const toggle = await screen.findByRole("checkbox", {
      name: "Inline completion",
    });
    expect(toggle).to.have.property("checked", false);
    expect(getInlineCompletionState().enabled).to.equal(false);
    expect(localStorage.getItem(INLINE_COMPLETION_STORAGE_KEY)).to.equal(null);
  });

  it("publishes a dedicated completion model and falls back to the review model", async function () {
    const dedicated = renderPanel(
      [remoteConnection, localConnection],
      {
        connectionId: remoteConnection.id,
        model: "remote-connection-model",
      },
      {
        inlineCompletionEnabled: true,
        completionModel: {
          connectionId: localConnection.id,
          model: "local-connection-model",
        },
      },
    );

    await waitFor(() => {
      expect(getInlineCompletionState()).to.include({
        selectedConnectionId: localConnection.id,
        selectedModel: "local-connection-model",
      });
    });
    dedicated.unmount();

    renderPanel(
      [remoteConnection, localConnection],
      {
        connectionId: remoteConnection.id,
        model: "remote-connection-model",
      },
      { inlineCompletionEnabled: true },
    );

    await waitFor(() => {
      expect(getInlineCompletionState()).to.include({
        selectedConnectionId: remoteConnection.id,
        selectedModel: "remote-connection-model",
      });
    });
  });

  it("reuses the model menu to save a dedicated completion model", async function () {
    const saved: AiReviewerWorkspace[] = [];
    renderPanel(
      [remoteConnection, localConnection],
      {
        connectionId: remoteConnection.id,
        model: "remote-connection-model",
      },
      { inlineCompletionEnabled: true },
      (workspace) => saved.push(workspace),
    );
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Completion model — Use review model",
      }),
    );
    await screen.findByLabelText("Filter models", {
      selector: "#ai-reviewer-completion-model-search",
    });
    const completionMenu = document.querySelector<HTMLElement>(
      ".ai-reviewer-panel-model-menu",
    );
    expect(completionMenu).not.to.equal(null);
    fireEvent.click(
      within(completionMenu!).getByRole("menuitem", {
        name: /^Local \(Local\)/u,
      }),
    );

    await waitFor(() => {
      expect(saved.at(-1)?.completionModel).to.deep.equal({
        connectionId: localConnection.id,
        model: "local-connection-model",
      });
    });
  });

  it("shows and clears the repeated-failure damping state from the extension channel", async function () {
    renderPanel(
      [localConnection],
      {
        connectionId: localConnection.id,
        model: "local-connection-model",
      },
      { inlineCompletionEnabled: true },
    );
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    await screen.findByRole("checkbox", { name: "Inline completion" });

    act(() => publishInlineCompletionPause(Date.now() + 60_000));
    expect(
      await screen.findByText(
        "Paused after repeated failures; resumes shortly",
      ),
    ).to.exist;

    act(() => publishInlineCompletionPause(null));
    await waitFor(() => {
      expect(
        screen.queryByText("Paused after repeated failures; resumes shortly"),
      ).not.to.exist;
    });
  });

  it("renders the toggle and its unavailable, paused, and active status states", async function () {
    const unavailable = renderPanel(
      [remoteConnection],
      {
        connectionId: remoteConnection.id,
        model: "remote-connection-model",
      },
      { inlineCompletionEnabled: true },
    );
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    const unavailableToggle = await screen.findByRole("checkbox", {
      name: "Inline completion",
    });
    await waitFor(() =>
      expect(unavailableToggle).to.have.property("disabled", true),
    );
    expect(screen.getByText("requires a local connection")).to.exist;
    unavailable.unmount();

    const paused = renderPanel(
      [remoteConnection, localConnection],
      {
        connectionId: localConnection.id,
        model: "local-connection-model",
      },
      {
        inlineCompletionEnabled: true,
        completionModel: {
          connectionId: remoteConnection.id,
          model: "remote-connection-model",
        },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    await screen.findByRole("checkbox", { name: "Inline completion" });
    expect(await screen.findByText("paused: selected model is remote")).to
      .exist;
    paused.unmount();

    const active = renderPanel(
      [remoteConnection, localConnection],
      {
        connectionId: localConnection.id,
        model: "local-connection-model",
      },
      { inlineCompletionEnabled: true },
    );
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    await screen.findByRole("checkbox", { name: "Inline completion" });
    await waitFor(() => {
      expect(screen.queryByText("requires a local connection")).not.to.exist;
      expect(screen.queryByText("paused: selected model is remote")).not.to
        .exist;
    });
    active.unmount();
  });
});
