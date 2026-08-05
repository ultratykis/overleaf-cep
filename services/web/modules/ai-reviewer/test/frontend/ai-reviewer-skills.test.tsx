import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect } from "chai";
import React from "react";
import sinon from "sinon";

import { AiIntegrationDetailsView } from "../../frontend/js/components/ai-integration-details";
import {
  AiReviewerSkillClientError,
  type AiReviewerSkill,
} from "../../frontend/js/services/ai-reviewer-skills";

const projectId = "ai-reviewer-skills-project";
const skill: AiReviewerSkill = {
  id: "skill-0001",
  name: "claim-check",
  description: "Check claims against their evidence.",
};

function markdownFile(name: string, content: string) {
  const file = new File([content], name, { type: "text/markdown" });
  Object.defineProperty(file, "text", {
    configurable: true,
    value: async () => content,
  });
  return file;
}

function renderSkills({
  initialSkills = [] as AiReviewerSkill[],
  uploadSkill = sinon.stub().resolves(skill),
  deleteSkill = sinon.stub().resolves({ skills: [] }),
} = {}) {
  const listSkills = sinon.stub().resolves({ skills: initialSkills });
  const rendered = render(
    <AiIntegrationDetailsView
      projectId={projectId}
      onHide={sinon.stub()}
      listConnections={sinon.stub().resolves({ connections: [] })}
      createConnection={sinon.stub()}
      updateConnection={sinon.stub()}
      deleteConnection={sinon.stub()}
      testConnection={sinon.stub()}
      listSkills={listSkills}
      uploadSkill={uploadSkill}
      deleteSkill={deleteSkill}
    />,
  );
  return { ...rendered, listSkills, uploadSkill, deleteSkill };
}

function uploadInput() {
  return screen.getByLabelText(
    "Upload SKILL.md and optional reference Markdown files",
  ) as HTMLInputElement;
}

describe("AI reviewer skills settings", function () {
  afterEach(function () {
    cleanup();
    sinon.restore();
  });

  it("renders stored skill names and descriptions", async function () {
    renderSkills({ initialSkills: [skill] });

    const row = await screen.findByTestId("ai-reviewer-skill-row");
    expect(within(row).getByText(skill.name)).to.exist;
    expect(within(row).getByText(skill.description)).to.exist;
  });

  it("adds a successful SKILL.md upload to the list", async function () {
    const uploadSkill = sinon.stub().resolves(skill);
    renderSkills({ uploadSkill });
    await waitFor(() => expect(uploadInput().disabled).to.equal(false));
    const main = markdownFile(
      "SKILL.md",
      "---\nname: claim-check\ndescription: Check claims against their evidence.\n---\nCheck every claim.",
    );
    const reference = markdownFile("evidence.md", "Prefer primary sources.");

    fireEvent.change(uploadInput(), {
      target: { files: [main, reference] },
    });

    expect(await screen.findByText(skill.name)).to.exist;
    expect(uploadSkill).to.have.been.calledOnce;
    expect(uploadSkill.firstCall.args[0]).to.equal(projectId);
    expect(uploadSkill.firstCall.args[1]).to.deep.equal({
      skillMarkdown:
        "---\nname: claim-check\ndescription: Check claims against their evidence.\n---\nCheck every claim.",
      referenceFiles: { "evidence.md": "Prefer primary sources." },
    });
    expect(uploadSkill.firstCall.args[2].aborted).to.equal(false);
  });

  it("shows the server's specific upload rejection message", async function () {
    const message =
      "SKILL.md frontmatter must include a non-empty `description`.";
    const uploadSkill = sinon
      .stub()
      .rejects(new AiReviewerSkillClientError(message));
    renderSkills({ uploadSkill });
    await waitFor(() => expect(uploadInput().disabled).to.equal(false));

    fireEvent.change(uploadInput(), {
      target: {
        files: [markdownFile("SKILL.md", "---\nname: claim-check\n---\nBody")],
      },
    });

    expect(await screen.findByText(message)).to.exist;
  });

  it("removes a skill after deletion succeeds", async function () {
    const deleteSkill = sinon.stub().resolves({ skills: [] });
    renderSkills({ initialSkills: [skill], deleteSkill });
    const row = await screen.findByTestId("ai-reviewer-skill-row");

    fireEvent.click(
      within(row).getByRole("button", { name: `Delete ${skill.name}` }),
    );

    await waitFor(() =>
      expect(screen.queryByTestId("ai-reviewer-skill-row")).to.equal(null),
    );
    expect(deleteSkill).to.have.been.calledOnce;
    expect(deleteSkill.firstCall.args[0]).to.equal(projectId);
    expect(deleteSkill.firstCall.args[1]).to.equal(skill.id);
    expect(deleteSkill.firstCall.args[2].aborted).to.equal(false);
  });
});
