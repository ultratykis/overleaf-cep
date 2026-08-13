import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect } from "chai";
import React from "react";

import { AiReviewerPanelView } from "../../frontend/js/components/ai-reviewer-panel";
import { completionRequestContext } from "../../frontend/js/extensions/inline-completion";
import {
  INLINE_COMPLETION_STORAGE_KEY,
  inlineCompletionGate,
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
): AiReviewerWorkspacePersistence {
  let workspace: AiReviewerWorkspace = {
    runs: [],
    discussions: [],
    selectedModel,
  };
  return {
    load: async () => ({ revision: 0, workspace }),
    save: async (_projectId, nextWorkspace) => {
      workspace = nextWorkspace;
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
) {
  return render(
    <AiReviewerPanelView
      projectId={projectId}
      workspacePersistence={workspacePersistence(selectedModel)}
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

describe("AI reviewer: inline completion", function () {
  beforeEach(function () {
    localStorage.removeItem(INLINE_COMPLETION_STORAGE_KEY);
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

  it("renders the toggle and its unavailable, paused, and active status states", async function () {
    localStorage.setItem(INLINE_COMPLETION_STORAGE_KEY, "true");

    const unavailable = renderPanel([remoteConnection], {
      connectionId: remoteConnection.id,
      model: "remote-connection-model",
    });
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    const unavailableToggle = await screen.findByRole("checkbox", {
      name: "Inline completion",
    });
    await waitFor(() =>
      expect(unavailableToggle).to.have.property("disabled", true),
    );
    expect(screen.getByText("requires a local connection")).to.exist;
    unavailable.unmount();

    const paused = renderPanel([remoteConnection, localConnection], {
      connectionId: remoteConnection.id,
      model: "remote-connection-model",
    });
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    await screen.findByRole("checkbox", { name: "Inline completion" });
    expect(await screen.findByText("paused: selected model is remote")).to
      .exist;
    paused.unmount();

    const active = renderPanel([remoteConnection, localConnection], {
      connectionId: localConnection.id,
      model: "local-connection-model",
    });
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
