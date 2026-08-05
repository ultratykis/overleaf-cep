import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect } from "chai";
import fetchMock from "fetch-mock";
import React from "react";
import sinon from "sinon";

import { AiReviewerAccountSettings } from "../../frontend/js/components/ai-reviewer-account-settings";
import { AiReviewerAccountSettingsDetails } from "../../frontend/js/components/ai-integration-details";
import type { AiProviderConnection } from "../../frontend/js/services/ai-provider-configuration";

const csrfToken = "account-settings-csrf";
const connection: AiProviderConnection = {
  id: "connection-account-settings-0001",
  revision: 1,
  label: "Account provider",
  classification: "remote",
  projectUseCount: 2,
  config: {
    provider: "gemini",
    contextLengthOverride: null,
    credentialSet: true,
    credentialUpdatedAt: "2026-08-02T00:00:00.000Z",
  },
};
const skill = {
  id: "skill-account-settings-0001",
  name: "claim-check",
  description: "Check claims against their evidence.",
  sizeBytes: 41,
  referenceCount: 1,
};
const gitPreview = {
  source: {
    service: "gitlab" as const,
    host: "git.company.example",
    repository: "group/repository",
    requestedRevision: "main",
    resolvedSha: "0123456789abcdef0123456789abcdef01234567",
  },
  manifestFound: false,
  plugins: [],
  skippedPlugins: [],
  truncated: false,
  skills: [
    {
      path: "SKILL.md",
      name: skill.name,
      description: skill.description,
      bodySizeBytes: 18,
      totalSizeBytes: 41,
      referenceFiles: [],
      skippedReferences: [],
    },
  ],
  contentHash: "1".repeat(64),
};
const gitProvenance = {
  kind: "git" as const,
  service: "gitlab" as const,
  host: gitPreview.source.host,
  repository: gitPreview.source.repository,
  path: "SKILL.md",
  resolvedSha: gitPreview.source.resolvedSha,
};

describe("AI reviewer account settings", function () {
  beforeEach(function () {
    window.metaAttributesCache.set("ol-csrfToken", csrfToken);
  });

  afterEach(function () {
    cleanup();
    fetchMock.removeRoutes().clearHistory();
    sinon.restore();
    window.metaAttributesCache.delete("ol-csrfToken");
  });

  it("surfaces the shared scope and opens the reused settings screen", async function () {
    const loadDetails = sinon.stub().resolves({
      default: ({ onHide }: { onHide: () => void }) => (
        <button type="button" onClick={onHide}>
          Close reused details
        </button>
      ),
    });

    render(<AiReviewerAccountSettings enabled loadDetails={loadDetails} />);

    expect(
      screen.getByText(
        "Connections and skills are shared across all of your projects.",
      ),
    ).to.exist;
    fireEvent.click(
      screen.getByRole("button", { name: "Manage connections and skills" }),
    );
    expect(await screen.findByText("Close reused details")).to.exist;
    expect(loadDetails).to.have.been.calledOnce;
  });

  it("loads connections and skills from user routes without enabling a project-scoped connection test", async function () {
    fetchMock.get("/user/ai-reviewer/connections", {
      connections: [connection],
    });
    fetchMock.get("/user/ai-reviewer/skills", {
      skills: [skill],
    });

    render(<AiReviewerAccountSettingsDetails onHide={sinon.stub()} />);

    expect(await screen.findByText(connection.label)).to.exist;
    const disabledReason =
      "Connection tests are only available within a project.";
    expect(screen.getByText(disabledReason)).to.exist;
    expect(
      screen.getByRole("button", {
        name: `Test ${connection.label}. ${disabledReason}`,
      }),
    ).to.have.property("disabled", true);
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    expect(await screen.findByText(skill.name)).to.exist;
    await waitFor(() => {
      expect(fetchMock.callHistory.calls()).to.have.length(2);
    });
    expect(
      fetchMock.callHistory.calls().map(({ url }) => new URL(url).pathname),
    ).to.have.members([
      "/user/ai-reviewer/connections",
      "/user/ai-reviewer/skills",
    ]);
  });

  it("previews and confirms a git import through the account settings routes", async function () {
    fetchMock.get("/user/ai-reviewer/connections", { connections: [] });
    fetchMock.get("/user/ai-reviewer/skills", { skills: [] });
    fetchMock.post("/user/ai-reviewer/skills/import/preview", gitPreview);
    fetchMock.post("/user/ai-reviewer/skills/import", {
      skills: [{ ...skill, provenance: gitProvenance }],
    });
    render(<AiReviewerAccountSettingsDetails onHide={sinon.stub()} />);
    fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
    await screen.findByText("Import from Git");

    fireEvent.change(screen.getByLabelText("Repository"), {
      target: { value: "https://git.company.example/group/repository" },
    });
    fireEvent.change(screen.getByLabelText("Git host type"), {
      target: { value: "gitlab" },
    });
    fireEvent.change(screen.getByLabelText("Revision (optional)"), {
      target: { value: "main" },
    });
    expect(
      fetchMock.callHistory.calls("/user/ai-reviewer/skills/import/preview"),
    ).to.have.length(0);

    fireEvent.click(screen.getByRole("button", { name: "Preview import" }));
    await screen.findByRole("region", { name: "Skill import preview" });
    expect(
      fetchMock.callHistory.calls("/user/ai-reviewer/skills/import/preview"),
    ).to.have.length(1);
    expect(
      fetchMock.callHistory.calls("/user/ai-reviewer/skills/import"),
    ).to.have.length(0);

    fireEvent.click(
      screen.getByRole("button", { name: "Import selected skills" }),
    );
    await waitFor(() => {
      expect(
        fetchMock.callHistory.calls("/user/ai-reviewer/skills/import"),
      ).to.have.length(1);
    });
  });
});
