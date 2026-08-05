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
  type AiReviewerSkillGitPreview,
} from "../../frontend/js/services/ai-reviewer-skills";

const projectId = "ai-reviewer-skills-project";
const skill: AiReviewerSkill = {
  id: "skill-0001",
  name: "claim-check",
  description: "Check claims against their evidence.",
  sizeBytes: 41,
  referenceCount: 1,
};
const gitPreview: AiReviewerSkillGitPreview = {
  source: {
    service: "github",
    host: "github.com",
    repository: "imbad0202/academic-research-skills",
    requestedRevision: null,
    resolvedSha: "0123456789abcdef0123456789abcdef01234567",
  },
  manifestFound: true,
  plugins: [
    {
      name: "academic-research-skills",
      version: "3.19.0",
      license: "CC-BY-NC-4.0",
      owner: {
        name: "Cheng-I Wu",
        url: "https://github.com/Imbad0202",
      },
      homepage: "https://github.com/imbad0202/academic-research-skills",
    },
  ],
  skippedPlugins: [
    {
      name: "external-reviewer",
      reason: "external-source",
      sourceUrl: "https://git.example.com/vendor/reviewer.git",
      sourcePath: "skills/reviewer",
    },
    {
      name: "broken-local",
      reason: "no-readable-skills",
      sourcePath: "broken-local",
    },
  ],
  truncated: false,
  skills: [
    {
      path: "academic-paper/SKILL.md",
      name: "academic-paper",
      description: "Draft an academic paper.",
      bodySizeBytes: 17,
      totalSizeBytes: 17,
      referenceFiles: [],
      skippedReferences: [],
    },
    {
      path: "academic-paper-reviewer/SKILL.md",
      name: "academic-paper-reviewer",
      description: "Review an academic paper.",
      bodySizeBytes: 18,
      totalSizeBytes: 41,
      referenceFiles: [{ path: "references/rules.md", sizeBytes: 23 }],
      skippedReferences: [
        { path: "re_review_mode_protocol.md", reason: "not-readable" },
        { path: "/docs/shared.md", reason: "outside-skill-directory" },
      ],
    },
    {
      path: "academic-pipeline/SKILL.md",
      name: "academic-pipeline",
      description: "Run an academic pipeline.",
      bodySizeBytes: 19,
      totalSizeBytes: 19,
      referenceFiles: [],
      skippedReferences: [],
    },
    {
      path: "deep-research/SKILL.md",
      name: "deep-research",
      description: "Conduct deep research.",
      bodySizeBytes: 20,
      totalSizeBytes: 20,
      referenceFiles: [],
      skippedReferences: [],
    },
  ],
  contentHash: "1".repeat(64),
};

function gitProvenance(path: string) {
  return {
    kind: "git" as const,
    service: gitPreview.source.service,
    host: gitPreview.source.host,
    repository: gitPreview.source.repository,
    path,
    resolvedSha: gitPreview.source.resolvedSha,
    pluginName: "academic-research-skills",
    pluginVersion: "3.19.0",
    license: "CC-BY-NC-4.0",
    owner: gitPreview.plugins[0].owner ?? undefined,
    homepage: gitPreview.plugins[0].homepage ?? undefined,
  };
}

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
  previewSkillGitImport = sinon.stub().resolves(gitPreview),
  confirmSkillGitImport = sinon.stub().resolves({
    skills: [{ ...skill, provenance: gitProvenance("SKILL.md") }],
  }),
  deleteSkill = sinon.stub().resolves({ skills: [] }),
} = {}) {
  const listSkills = sinon.stub().resolves({ skills: initialSkills });
  const rendered = render(
    <AiIntegrationDetailsView
      scopeKey={projectId}
      onHide={sinon.stub()}
      listConnections={sinon.stub().resolves({ connections: [] })}
      createConnection={sinon.stub()}
      updateConnection={sinon.stub()}
      deleteConnection={sinon.stub()}
      testConnection={sinon.stub()}
      listSkills={listSkills}
      uploadSkill={uploadSkill}
      previewSkillGitImport={previewSkillGitImport}
      confirmSkillGitImport={confirmSkillGitImport}
      deleteSkill={deleteSkill}
    />,
  );
  return {
    ...rendered,
    listSkills,
    uploadSkill,
    previewSkillGitImport,
    confirmSkillGitImport,
    deleteSkill,
  };
}

function uploadInput() {
  return screen.getByLabelText("Add skill files") as HTMLInputElement;
}

function uploadControl() {
  return screen.getByText("Add skill files").closest("label") as HTMLElement;
}

function openSkillsTab() {
  fireEvent.click(screen.getByRole("tab", { name: "Skills" }));
}

describe("AI reviewer skills settings", function () {
  afterEach(function () {
    cleanup();
    sinon.restore();
  });

  it("opens Connections first and switches between both tabs", async function () {
    renderSkills();

    const connectionsTab = screen.getByRole("tab", { name: "Connections" });
    const skillsTab = screen.getByRole("tab", { name: "Skills" });
    const tabList = screen.getByRole("tablist");
    expect(
      tabList.matches(
        ".ol-tabs > .nav-tabs-container > ul.nav.ai-reviewer-settings-tabs.nav-tabs",
      ),
    ).to.equal(true);
    expect(connectionsTab.parentElement?.tagName).to.equal("LI");
    expect(skillsTab.parentElement?.tagName).to.equal("LI");
    expect(connectionsTab.parentElement?.parentElement).to.equal(tabList);
    expect(skillsTab.parentElement?.parentElement).to.equal(tabList);
    expect(connectionsTab.getAttribute("aria-selected")).to.equal("true");
    expect(screen.queryByRole("heading", { name: "Skills" })).to.equal(null);

    fireEvent.click(skillsTab);
    expect(await screen.findByRole("heading", { name: "Skills" })).to.exist;
    expect(skillsTab.getAttribute("aria-selected")).to.equal("true");

    fireEvent.click(connectionsTab);
    expect(await screen.findByRole("heading", { name: "Connections" })).to
      .exist;
    expect(connectionsTab.getAttribute("aria-selected")).to.equal("true");
  });

  it("explains the empty state and accepted files before upload", async function () {
    renderSkills();
    openSkillsTab();

    expect(
      await screen.findByText(
        "Skills give the AI reviewer reusable instructions for specific review tasks.",
      ),
    ).to.exist;
    expect(screen.getByText("Used only in Review and Brainstorm modes.")).to
      .exist;
    expect(
      screen.getByText(
        "No skills added yet. Upload Markdown files or preview a Git import below.",
      ),
    ).to.exist;
    expect(
      screen.getByText(
        "Select one SKILL.md file and any optional reference Markdown files. You can select several Markdown files at once.",
      ),
    ).to.exist;
    await waitFor(() => expect(uploadInput().disabled).to.equal(false));
    expect(uploadInput().multiple).to.equal(true);
    expect(uploadInput().accept).to.equal(".md,text/markdown");
  });

  it("gives the visible file control the same accessible name it shows", async function () {
    renderSkills();
    openSkillsTab();

    await waitFor(() => expect(uploadInput().disabled).to.equal(false));
    expect(uploadControl().textContent?.trim()).to.equal("Add skill files");
    expect(uploadControl().getAttribute("for")).to.equal(uploadInput().id);
  });

  it("groups four skills from one repository as one plugin and reveals their collapsed details", async function () {
    const repositorySkills = gitPreview.skills.map((previewSkill, index) => ({
      id: `repository-skill-${index}`,
      name: previewSkill.name,
      description: previewSkill.description,
      sizeBytes: previewSkill.totalSizeBytes,
      referenceCount: previewSkill.referenceFiles.length,
      provenance: gitProvenance(previewSkill.path),
    }));
    renderSkills({ initialSkills: repositorySkills });
    openSkillsTab();

    const group = (await screen.findByTestId(
      "ai-reviewer-skill-group",
    )) as HTMLDetailsElement;
    expect(screen.getAllByTestId("ai-reviewer-skill-group")).to.have.length(1);
    expect(group.open).to.equal(false);
    expect(within(group).getByText("academic-research-skills")).to.exist;
    expect(
      within(group).getByText(
        "github.com · imbad0202/academic-research-skills",
      ),
    ).to.exist;
    expect(within(group).getByText("Owner: Cheng-I Wu")).to.exist;
    expect(within(group).getByText("Version: 3.19.0")).to.exist;
    expect(within(group).getByText("License: CC-BY-NC-4.0")).to.exist;
    expect(within(group).getByText("4 skills")).to.exist;

    fireEvent.click(
      within(group).getByText("academic-research-skills").closest("summary")!,
    );
    expect(group.open).to.equal(true);
    const rows = within(group).getAllByTestId("ai-reviewer-skill-row");
    expect(rows).to.have.length(4);
    const reviewerRow = rows[1] as HTMLDetailsElement;
    expect(reviewerRow.open).to.equal(false);
    expect(reviewerRow.querySelector("summary")?.textContent?.trim()).to.equal(
      "academic-paper-reviewer",
    );

    fireEvent.click(reviewerRow.querySelector("summary")!);
    expect(reviewerRow.open).to.equal(true);
    expect(within(reviewerRow).getByText("Review an academic paper.")).to.exist;
    expect(within(reviewerRow).getByText("Stored content: 41 bytes")).to.exist;
    expect(within(reviewerRow).getByText("Included references: 1")).to.exist;
  });

  it("groups uploaded skills separately and identifies them as local files", async function () {
    renderSkills({
      initialSkills: [
        skill,
        {
          ...skill,
          id: "git-skill",
          name: "academic-paper",
          referenceCount: 0,
          provenance: gitProvenance("academic-paper/SKILL.md"),
        },
      ],
    });
    openSkillsTab();

    const groups = await screen.findAllByTestId("ai-reviewer-skill-group");
    expect(groups).to.have.length(2);
    const localGroup = groups.find((group) =>
      within(group).queryByText("Local files"),
    ) as HTMLDetailsElement;
    expect(within(localGroup).getByText("Uploaded from local files")).to.exist;
    expect(within(localGroup).getByText("1 skill")).to.exist;
    expect(within(localGroup).queryByText(/^Owner:/u)).to.equal(null);
  });

  it("adds a successful SKILL.md upload to the list", async function () {
    const uploadSkill = sinon.stub().resolves(skill);
    renderSkills({ uploadSkill });
    openSkillsTab();
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
    expect(screen.getByRole("status").textContent).to.contain(
      "2 files selected. SKILL.md, evidence.md",
    );
  });

  it("shows the real four-skill manifest and imports several selected skills only after acceptance", async function () {
    const previewSkillGitImport = sinon.stub().resolves(gitPreview);
    const importedSkills = [
      {
        ...skill,
        id: "skill-reviewer",
        name: "academic-paper-reviewer",
        provenance: gitProvenance("academic-paper-reviewer/SKILL.md"),
      },
      {
        ...skill,
        id: "skill-deep-research",
        name: "deep-research",
        provenance: gitProvenance("deep-research/SKILL.md"),
      },
    ];
    const confirmSkillGitImport = sinon
      .stub()
      .resolves({ skills: importedSkills });
    renderSkills({ previewSkillGitImport, confirmSkillGitImport });
    openSkillsTab();
    await screen.findByText("Import from Git");

    fireEvent.change(screen.getByLabelText("Repository"), {
      target: { value: "imbad0202/academic-research-skills" },
    });

    expect(previewSkillGitImport).not.to.have.been.called;
    expect(confirmSkillGitImport).not.to.have.been.called;
    fireEvent.click(screen.getByRole("button", { name: "Preview import" }));

    const previewRegion = await screen.findByRole("region", {
      name: "Skill import preview",
    });
    expect(previewSkillGitImport).to.have.been.calledOnce;
    expect(previewSkillGitImport.firstCall.args[0]).to.equal(projectId);
    expect(previewSkillGitImport.firstCall.args[1]).to.deep.equal({
      repository: "imbad0202/academic-research-skills",
      gitHostType: "auto",
      ref: "",
    });
    expect(previewSkillGitImport.firstCall.args[2].aborted).to.equal(false);
    expect(confirmSkillGitImport).not.to.have.been.called;
    expect(
      within(previewRegion).getByText("Understood host: GitHub on github.com"),
    ).to.exist;
    expect(within(previewRegion).getByText("3.19.0")).to.exist;
    expect(within(previewRegion).getByText("CC-BY-NC-4.0")).to.exist;
    expect(
      within(previewRegion).getByText(
        "Cheng-I Wu (https://github.com/Imbad0202)",
      ),
    ).to.exist;
    expect(
      within(previewRegion).getByText(
        "https://github.com/imbad0202/academic-research-skills",
      ),
    ).to.exist;
    expect(within(previewRegion).getByText("Skipped plugins and skills")).to
      .exist;
    expect(
      within(previewRegion).getByText(
        "https://git.example.com/vendor/reviewer.git",
      ),
    ).to.exist;
    expect(previewRegion.textContent).to.contain(
      "Stored in another repository. Import it separately:",
    );
    expect(previewRegion.textContent).to.contain(
      "No readable SKILL.md found under:",
    );
    expect(
      within(previewRegion).getByRole("checkbox", { name: "academic-paper" }),
    ).to.exist;
    expect(
      within(previewRegion).getByRole("checkbox", {
        name: "academic-paper-reviewer",
      }),
    ).to.exist;
    expect(
      within(previewRegion).getByRole("checkbox", {
        name: "academic-pipeline",
      }),
    ).to.exist;
    expect(
      within(previewRegion).getByRole("checkbox", { name: "deep-research" }),
    ).to.exist;
    expect(
      within(previewRegion).getAllByText("Included references"),
    ).to.have.length(4);
    expect(within(previewRegion).getByText("references/rules.md")).to.exist;
    expect(
      within(previewRegion).getAllByText("Skipped mentions"),
    ).to.have.length(4);
    expect(within(previewRegion).getByText("re_review_mode_protocol.md")).to
      .exist;
    expect(within(previewRegion).getByText("/docs/shared.md")).to.exist;
    expect(previewRegion.textContent).to.contain(
      "was not included because no readable Markdown file was found at that path under the skill directory",
    );
    expect(previewRegion.textContent).to.contain(
      "was not included because it resolves outside the skill directory",
    );
    expect(within(previewRegion).getByText(gitPreview.source.resolvedSha)).to
      .exist;

    fireEvent.click(
      within(previewRegion).getByRole("checkbox", { name: "academic-paper" }),
    );
    fireEvent.click(
      within(previewRegion).getByRole("checkbox", {
        name: "academic-pipeline",
      }),
    );

    fireEvent.click(
      within(previewRegion).getByRole("button", {
        name: "Import selected skills",
      }),
    );

    await waitFor(() => expect(confirmSkillGitImport).to.have.been.calledOnce);
    expect(confirmSkillGitImport.firstCall.args[0]).to.equal(projectId);
    expect(confirmSkillGitImport.firstCall.args[1]).to.deep.equal({
      repository: "imbad0202/academic-research-skills",
      gitHostType: "auto",
      ref: "",
      resolvedSha: gitPreview.source.resolvedSha,
      contentHash: gitPreview.contentHash,
      selectedPaths: [
        "academic-paper-reviewer/SKILL.md",
        "deep-research/SKILL.md",
      ],
    });
    expect(confirmSkillGitImport.firstCall.args[2].aborted).to.equal(false);
    const storedGroups = await screen.findAllByTestId(
      "ai-reviewer-skill-group",
    );
    expect(storedGroups).to.have.length(1);
    expect(within(storedGroups[0]).getByText("academic-research-skills")).to
      .exist;
    expect(within(storedGroups[0]).getByText("2 skills")).to.exist;
  });

  it("states when the preview omits skills at the retention limit", async function () {
    const previewSkillGitImport = sinon.stub().resolves({
      ...gitPreview,
      truncated: true,
      skills: gitPreview.skills.slice(0, 2),
    });
    renderSkills({ previewSkillGitImport });
    openSkillsTab();
    fireEvent.change(screen.getByLabelText("Repository"), {
      target: { value: "owner/repository" },
    });
    const previewButton = screen.getByRole("button", {
      name: "Preview import",
    }) as HTMLButtonElement;
    await waitFor(() => expect(previewButton.disabled).to.equal(false));
    fireEvent.click(previewButton);

    const previewRegion = await screen.findByRole("region", {
      name: "Skill import preview",
    });
    expect(
      within(previewRegion).getByText(
        "Some skills are not shown because the 32 MiB preview limit was reached.",
      ),
    ).to.exist;
    expect(within(previewRegion).getByRole("status")).to.exist;
  });

  it("shows no-manifest metadata as unknown and blocks a selection above the twenty-skill limit", async function () {
    const fallbackPreview: AiReviewerSkillGitPreview = {
      ...gitPreview,
      manifestFound: false,
      plugins: [],
      skippedPlugins: [],
      skills: gitPreview.skills.slice(0, 2),
    };
    const previewSkillGitImport = sinon.stub().resolves(fallbackPreview);
    const confirmSkillGitImport = sinon.stub();
    renderSkills({
      initialSkills: Array.from({ length: 19 }, (_, index) => ({
        ...skill,
        id: `stored-${index}`,
        name: `stored-${index}`,
      })),
      previewSkillGitImport,
      confirmSkillGitImport,
    });
    openSkillsTab();
    fireEvent.change(screen.getByLabelText("Repository"), {
      target: { value: "owner/repository" },
    });
    const previewButton = screen.getByRole("button", {
      name: "Preview import",
    }) as HTMLButtonElement;
    await waitFor(() => expect(previewButton.disabled).to.equal(false));
    fireEvent.click(previewButton);

    const previewRegion = await screen.findByRole("region", {
      name: "Skill import preview",
    });
    expect(
      within(previewRegion).getByText(
        "No skill manifest was found. Skills were discovered from SKILL.md files; plugin version and license are unknown.",
      ),
    ).to.exist;
    expect(within(previewRegion).queryByRole("alert")).not.to.exist;
    expect(
      within(previewRegion).getByRole("button", {
        name: "Import selected skills",
      }),
    ).to.have.property("disabled", true);
    fireEvent.click(
      within(previewRegion).getByRole("checkbox", { name: "academic-paper" }),
    );
    expect(
      within(previewRegion).getByRole("button", {
        name: "Import selected skills",
      }),
    ).to.have.property("disabled", false);
    expect(confirmSkillGitImport).not.to.have.been.called;
  });

  it("disables the visible file control while an upload is in flight", async function () {
    let finishUpload!: (value: AiReviewerSkill) => void;
    const uploadSkill = sinon.stub().returns(
      new Promise<AiReviewerSkill>((resolve) => {
        finishUpload = resolve;
      }),
    );
    renderSkills({ uploadSkill });
    openSkillsTab();
    await waitFor(() => expect(uploadInput().disabled).to.equal(false));

    fireEvent.change(uploadInput(), {
      target: {
        files: [
          markdownFile(
            "SKILL.md",
            "---\nname: claim-check\ndescription: Check claims.\n---\nCheck claims.",
          ),
        ],
      },
    });

    await waitFor(() => {
      expect(uploadInput().disabled).to.equal(true);
      expect(uploadControl().getAttribute("aria-disabled")).to.equal("true");
    });
    finishUpload(skill);
    await waitFor(() => expect(uploadInput().disabled).to.equal(false));
  });

  it("shows the server's specific upload rejection message", async function () {
    const message =
      "SKILL.md frontmatter must include a non-empty `description`.";
    const uploadSkill = sinon
      .stub()
      .rejects(new AiReviewerSkillClientError(message));
    renderSkills({ uploadSkill });
    openSkillsTab();
    await waitFor(() => expect(uploadInput().disabled).to.equal(false));

    fireEvent.change(uploadInput(), {
      target: {
        files: [markdownFile("SKILL.md", "---\nname: claim-check\n---\nBody")],
      },
    });

    expect(await screen.findByText(message)).to.exist;
  });

  it("confirms before deleting one skill and leaves its plugin siblings", async function () {
    const deleting = {
      ...skill,
      name: "academic-paper",
      provenance: gitProvenance("academic-paper/SKILL.md"),
    };
    const remaining = {
      ...skill,
      id: "skill-0002",
      name: "deep-research",
      provenance: gitProvenance("deep-research/SKILL.md"),
    };
    const deleteSkill = sinon.stub().resolves({ skills: [remaining] });
    renderSkills({ initialSkills: [deleting, remaining], deleteSkill });
    openSkillsTab();
    const group = (await screen.findByTestId(
      "ai-reviewer-skill-group",
    )) as HTMLDetailsElement;
    fireEvent.click(
      within(group).getByText("academic-research-skills").closest("summary")!,
    );
    const row = within(group)
      .getByText(deleting.name)
      .closest("details") as HTMLDetailsElement;
    fireEvent.click(row.querySelector("summary")!);

    fireEvent.click(
      within(row).getByRole("button", { name: `Delete ${deleting.name}` }),
    );

    expect(deleteSkill).not.to.have.been.called;
    const title = await screen.findByText("Delete this skill?");
    expect(
      screen.getByText(
        `This permanently deletes ‘${deleting.name}’ and its stored reference Markdown files.`,
      ),
    ).to.exist;
    fireEvent.click(
      within(title.closest(".modal") as HTMLElement).getByRole("button", {
        name: "Delete",
      }),
    );

    await waitFor(() =>
      expect(screen.queryByText(deleting.name)).to.equal(null),
    );
    expect(screen.getByTestId("ai-reviewer-skill-group")).to.exist;
    expect(screen.getByText(remaining.name)).to.exist;
    expect(screen.getByText("1 skill")).to.exist;
    expect(deleteSkill).to.have.been.calledOnce;
    expect(deleteSkill.firstCall.args[0]).to.equal(projectId);
    expect(deleteSkill.firstCall.args[1]).to.equal(deleting.id);
    expect(deleteSkill.firstCall.args[2].aborted).to.equal(false);
  });
});
