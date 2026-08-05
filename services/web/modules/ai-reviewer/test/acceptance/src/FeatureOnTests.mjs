import { createHash } from "node:crypto";

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

  it("saves and uses the configured local Ollama provider", async function () {
    if (process.env.OVERLEAF_AI_REVIEWER_REAL_OLLAMA !== "true") {
      this.skip();
    }
    this.timeout(180_000);

    const baseUrl = process.env.OVERLEAF_AI_REVIEWER_OLLAMA_BASE_URL;
    const model = process.env.OVERLEAF_AI_REVIEWER_OLLAMA_MODEL;
    expect(baseUrl).to.equal("http://127.0.0.1:11434/v1");
    expect(model).to.be.a("string").and.not.empty;

    const owner = new User();
    await owner.login();
    const projectId = await owner.createProject(
      "AI reviewer Ollama smoke project",
    );
    const route = `/project/${projectId}/ai-reviewer`;
    const configuration = { provider: "ollama", baseUrl, model };
    const csrfHeaders = { "x-csrf-token": owner.csrfToken };

    const saved = await owner.doRequest("PUT", {
      url: `${route}/config`,
      headers: csrfHeaders,
      json: configuration,
    });
    expect(saved.response.statusCode).to.equal(200);
    expect(saved.body).to.deep.equal({
      configured: true,
      config: configuration,
      classification: "local",
    });

    const connection = await owner.doRequest("POST", {
      url: `${route}/connection-test`,
      headers: csrfHeaders,
    });
    expect(connection.response.statusCode).to.equal(200);
    expect(JSON.parse(connection.body)).to.deep.equal({
      ok: true,
      provider: "ollama",
      model,
      classification: "local",
    });

    const text =
      "\\section{Introduction}\nThis is a synthetic manuscript sentence.";
    const requestId = "ai-reviewer-ollama-smoke";
    const review = await owner.doRequest("POST", {
      url: `${route}/stream`,
      headers: {
        ...csrfHeaders,
        accept: "application/x-ndjson",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requestId,
        projectId: projectId.toString(),
        action: "review",
        instruction:
          "Return one short narrative review. Use empty findings and suggestions arrays.",
        skill: null,
        scope: {
          kind: "document",
          documentId: "main-document",
          path: "main.tex",
          baseRevision: 1,
          baseTextHash: createHash("sha256").update(text).digest("hex"),
          text,
        },
      }),
    });
    expect(review.response.statusCode).to.equal(200);

    const events = review.body
      .trimEnd()
      .split("\n")
      .map((line) => AgentEventSchema.parse(JSON.parse(line)));
    expect(events[0]).to.include({
      type: "started",
      requestId,
      provider: "ollama",
      model,
    });
    expect(
      events.some(
        (event) => event.type === "text.delta" && event.delta.length > 0,
      ),
    ).to.equal(true);
    expect(
      events.filter(
        (event) => event.type === "completed" || event.type === "error",
      ),
    ).to.have.lengthOf(1);
    expect(events.at(-1)?.type).to.equal("completed");

    const projectRequestId = "ai-reviewer-project-ollama-smoke";
    const projectReview = await owner.doRequest("POST", {
      url: `${route}/stream`,
      headers: {
        ...csrfHeaders,
        accept: "application/x-ndjson",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requestId: projectRequestId,
        projectId: projectId.toString(),
        action: "review",
        instruction:
          "Return one short narrative based on the project manifest. Use empty findings and suggestions arrays.",
        skill: null,
        scope: { kind: "project" },
      }),
    });
    expect(projectReview.response.statusCode).to.equal(200);

    const projectEvents = projectReview.body
      .trimEnd()
      .split("\n")
      .map((line) => AgentEventSchema.parse(JSON.parse(line)));
    expect(projectEvents[0]).to.include({
      type: "started",
      requestId: projectRequestId,
      provider: "ollama",
      model,
    });
    expect(
      projectEvents.some(
        (event) => event.type === "text.delta" && event.delta.length > 0,
      ),
    ).to.equal(true);
    expect(projectEvents.at(-1)?.type).to.equal("completed");
  });
});
