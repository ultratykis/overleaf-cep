import Settings from "@overleaf/settings";
import { expect } from "chai";

import UserHelper from "../../../../../test/acceptance/src/helpers/User.mjs";

const User = UserHelper.promises;

describe("AI reviewer: feature off server-ce acceptance", function () {
  before(function () {
    if (Settings.aiReviewer.enabled === true) {
      this.skip();
    }
  });

  it("keeps authenticated project access and compilation on the normal path", async function () {
    expect(Settings.aiReviewer.enabled).to.equal(false);
    expect(Settings.moduleImportSequence).not.to.include("ai-reviewer");

    const user = new User();
    await user.login();
    const projectId = await user.createProject(
      "AI reviewer feature-off synthetic project",
    );

    await user.openProject(projectId);
    const joined = await user.joinProject(projectId);
    expect(joined.privilegeLevel).to.equal("owner");
    expect(joined.project._id.toString()).to.equal(projectId.toString());

    const project = await user.getProject(projectId);
    const write = await user.doRequest("POST", {
      url: `/project/${projectId}/doc`,
      json: {
        name: "feature-off.tex",
        parent_folder_id: project.rootFolder[0]._id,
      },
    });
    expect(write.response.statusCode).to.equal(200);

    const { response, body } = await user.doRequest("POST", {
      url: `/project/${projectId}/compile`,
      json: {},
    });

    expect(response.statusCode).to.equal(200);
    expect(body.status).to.equal("success");
    expect(body.outputFiles).to.be.an("array").that.is.not.empty;
    expect(body.outputFiles.map((file) => file.path)).to.include("output.pdf");
  });
});
