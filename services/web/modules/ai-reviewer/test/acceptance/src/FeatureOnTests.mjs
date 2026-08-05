import Settings from "@overleaf/settings";
import { expect } from "chai";
import sinon from "sinon";

import UserHelper from "../../../../../test/acceptance/src/helpers/User.mjs";
import { ScriptedFakeAgentGateway } from "../../../app/src/AgentGateway.mjs";
import { setAiReviewerGatewayFactoryForTests } from "../../../app/src/ConfiguredAiReviewerController.mjs";
import { AgentEventSchema } from "../../../shared/contracts.mjs";
import { createPrivacySinkProbe } from "./helpers/PrivacySinkProbe.mjs";

const User = UserHelper.promises;
const instructionSentinel =
  "AI_REVIEWER_SYNTHETIC_PRIVATE_INSTRUCTION_SENTINEL";
const createdAt = "2026-07-24T00:00:00.000Z";

describe("AI reviewer: enabled server-ce acceptance", function () {
  before(function () {
    if (Settings.aiReviewer.enabled !== true) {
      this.skip();
    }
  });

  it("streams a fake provider only through the authorized middleware path", async function () {
    expect(Settings.moduleImportSequence).to.include("ai-reviewer");

    const owner = new User();
    const nonMember = new User();
    const restrictedMember = new User();
    const unauthenticated = new User();
    await Promise.all([
      owner.login(),
      nonMember.login(),
      restrictedMember.login(),
      unauthenticated.getCsrfToken(),
    ]);

    const projectId = await owner.createProject(
      "AI reviewer enabled synthetic project",
    );
    await owner.makeTokenBased(projectId);
    const project = await owner.getProject(projectId);
    const readOnlyToken = project.tokens.readOnly;

    const tokenPage = await restrictedMember.doRequest("GET", {
      url: `/read/${readOnlyToken}`,
    });
    expect(tokenPage.response.statusCode).to.equal(200);
    const tokenGrant = await restrictedMember.doRequest("POST", {
      url: `/read/${readOnlyToken}/grant`,
      json: { token: readOnlyToken },
    });
    expect(tokenGrant.response.statusCode).to.equal(200);

    const requestId = "ai-reviewer-enabled-acceptance";
    const payload = {
      requestId,
      projectId: projectId.toString(),
      action: "review",
      instruction: instructionSentinel,
      skill: null,
      scope: { kind: "project" },
    };

    const postStream = ({
      user,
      requestPayload = payload,
      csrfToken = user.csrfToken,
      accept = "application/x-ndjson",
    }) =>
      user.doRequest("POST", {
        url: `/project/${projectId}/ai-reviewer/stream`,
        headers: {
          accept,
          "content-type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify(requestPayload),
      });

    const sandbox = sinon.createSandbox();
    const privacyProbe = createPrivacySinkProbe(sandbox);
    const fakeGateway = new ScriptedFakeAgentGateway({
      events: [
        {
          type: "started",
          eventId: "ai-reviewer-enabled-started",
          requestId,
          sequence: 0,
          createdAt,
          provider: "fake",
          model: "deterministic-v1",
          skill: null,
        },
        {
          type: "text.delta",
          eventId: "ai-reviewer-enabled-delta",
          requestId,
          sequence: 1,
          createdAt,
          delta: "Synthetic reviewer response.",
        },
        {
          type: "completed",
          eventId: "ai-reviewer-enabled-completed",
          requestId,
          sequence: 2,
          createdAt,
          finishReason: "stop",
        },
      ],
    });
    let gatewayFactoryCalls = 0;
    const restoreGatewayFactory = setAiReviewerGatewayFactoryForTests(() => {
      gatewayFactoryCalls += 1;
      return fakeGateway;
    });

    try {
      const unauthenticatedResult = await postStream({
        user: unauthenticated,
        accept: "application/json",
      });
      expect(unauthenticatedResult.response.statusCode).to.equal(401);

      const invalidCsrfResult = await postStream({
        user: owner,
        csrfToken: "invalid-csrf-token",
      });
      expect(invalidCsrfResult.response.statusCode).to.equal(403);

      const restrictedResult = await postStream({ user: restrictedMember });
      expect(restrictedResult.response.statusCode).to.equal(403);

      const nonMemberResult = await postStream({ user: nonMember });
      expect(nonMemberResult.response.statusCode).to.equal(403);
      expect(gatewayFactoryCalls).to.equal(0);
      expect(fakeGateway.calls).to.have.lengthOf(0);

      const ownerResult = await postStream({ user: owner });
      expect(ownerResult.response.statusCode).to.equal(200);
      expect(ownerResult.response.headers["content-type"]).to.match(
        /^application\/x-ndjson(?:;|$)/,
      );

      const lines = ownerResult.body.trimEnd().split("\n");
      expect(lines).to.have.lengthOf(3);

      const events = lines.map((line) =>
        AgentEventSchema.parse(JSON.parse(line)),
      );
      expect(events.map((event) => event.type)).to.deep.equal([
        "started",
        "text.delta",
        "completed",
      ]);
      expect(events.map((event) => event.sequence)).to.deep.equal([0, 1, 2]);
      expect(gatewayFactoryCalls).to.equal(1);
      expect(fakeGateway.calls).to.deep.equal([payload]);
      expect(ownerResult.body).not.to.include(instructionSentinel);

      restoreGatewayFactory();
      const unconfiguredPayload = {
        ...payload,
        requestId: "ai-reviewer-enabled-unconfigured",
      };
      const unconfiguredResult = await postStream({
        user: owner,
        requestPayload: unconfiguredPayload,
      });
      expect(unconfiguredResult.response.statusCode).to.equal(200);
      const unconfiguredLines = unconfiguredResult.body.trimEnd().split("\n");
      expect(unconfiguredLines).to.have.lengthOf(1);
      const unconfiguredEvent = AgentEventSchema.parse(
        JSON.parse(unconfiguredLines[0]),
      );
      expect(unconfiguredEvent).to.deep.equal({
        type: "error",
        eventId: unconfiguredEvent.eventId,
        requestId: unconfiguredPayload.requestId,
        sequence: 0,
        createdAt: unconfiguredEvent.createdAt,
        error: {
          code: "AI_PROVIDER_NOT_CONFIGURED",
          category: "configuration",
          message: "No AI provider is configured.",
          retryable: false,
        },
      });
      expect(gatewayFactoryCalls).to.equal(1);
      expect(unconfiguredResult.body).not.to.include(instructionSentinel);

      expect(await privacyProbe.findSentinel(instructionSentinel)).to.equal(
        null,
      );
    } finally {
      restoreGatewayFactory();
      sandbox.restore();
    }
  });
});
