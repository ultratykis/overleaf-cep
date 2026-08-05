import { describe, expect, it, vi } from "vitest";

import { createAiReviewerRouter } from "../../../app/src/AiReviewerRouter.mjs";
import { createAiReviewerSkillController } from "../../../app/src/AiReviewerSkillController.mjs";
import {
  AI_REVIEWER_SKILL_COUNT_LIMIT,
  AI_REVIEWER_SKILL_MAX_BYTES,
  createAiReviewerSkillStore,
} from "../../../app/src/AiReviewerSkillStore.mjs";

const projectId = "project-skill-routes";
const userId = "user-skill-routes-0001";
const otherUserId = "user-skill-routes-0002";

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function fakeQuery(work) {
  const query = { exec: vi.fn(async () => clone(work())) };
  query.lean = vi.fn(() => query);
  return query;
}

function inMemoryModel() {
  const records = new Map();
  return {
    findOne: vi.fn(({ _id }) => fakeQuery(() => records.get(_id))),
    findOneAndUpdate: vi.fn((filter, update, options) =>
      fakeQuery(() => {
        const current = records.get(filter._id);
        if (
          (!records.has(filter._id) && !options.upsert) ||
          (current != null && current.revision !== filter.revision) ||
          (current == null && filter.revision !== 0)
        ) {
          return null;
        }
        const record = {
          _id: filter._id,
          revision: (current?.revision ?? 0) + update.$inc.revision,
          skills: clone(update.$set.skills),
        };
        records.set(filter._id, record);
        return record;
      }),
    ),
    deleteOne: vi.fn(({ _id }) =>
      fakeQuery(() => ({ deletedCount: records.delete(_id) ? 1 : 0 })),
    ),
  };
}

function skillMarkdown(name = "claim-check", body = "Check every claim.") {
  return `---\nname: ${name}\ndescription: Check claims against their evidence.\n---\n${body}`;
}

function request({ authenticatedUserId = userId, body, skillId } = {}) {
  return {
    body,
    params: { project_id: projectId, skill_id: skillId },
    user: { _id: { toString: () => authenticatedUserId } },
  };
}

class FakeResponse {
  statusCode = 200;
  body = undefined;

  status(statusCode) {
    this.statusCode = statusCode;
    return this;
  }

  json(body) {
    this.body = body;
    return this;
  }
}

function routeFixture() {
  let sequence = 0;
  const store = createAiReviewerSkillStore({
    model: inMemoryModel(),
    newSkillId: () => `skill-route-${++sequence}`,
  });
  const controller = createAiReviewerSkillController({ skillStore: store });
  const routes = new Map();
  const webRouter = {};
  for (const method of ["get", "post", "put", "delete"]) {
    webRouter[method] = (path, ...handlers) => {
      routes.set(`${method.toUpperCase()} ${path}`, handlers);
    };
  }
  const unused = vi.fn();
  createAiReviewerRouter({
    authenticationController: { requireLogin: () => unused },
    authorizationMiddleware: {
      blockRestrictedUserFromProject: unused,
      ensureUserCanReadProject: unused,
    },
    rateLimit: unused,
    listModels: unused,
    testConnection: unused,
    listConnections: unused,
    createConnection: unused,
    updateConnection: unused,
    deleteConnection: unused,
    stream: unused,
    getWorkspace: unused,
    saveWorkspace: unused,
    getCommentProvenance: unused,
    markCommentProvenance: unused,
    deleteCommentProvenance: unused,
    deleteDiscussion: unused,
    deleteWorkspace: unused,
    listSkills: controller.listSkills,
    uploadSkill: controller.uploadSkill,
    deleteSkill: controller.deleteSkill,
  }).apply(webRouter);

  async function invoke(method, path, rawRequest) {
    const handlers = routes.get(`${method} ${path}`);
    const response = new FakeResponse();
    await handlers.at(-1)(rawRequest, response);
    return response;
  }

  return {
    list: (rawRequest) =>
      invoke("GET", "/project/:project_id/ai-reviewer/skills", rawRequest),
    upload: (rawRequest) =>
      invoke("POST", "/project/:project_id/ai-reviewer/skills", rawRequest),
    remove: (rawRequest) =>
      invoke(
        "DELETE",
        "/project/:project_id/ai-reviewer/skills/:skill_id",
        rawRequest,
      ),
  };
}

function expectSpecific4xx(response, message) {
  expect(response.statusCode).toBeGreaterThanOrEqual(400);
  expect(response.statusCode).toBeLessThan(500);
  expect(response.body.error.message).toBe(message);
}

describe("AI reviewer skill routes", function () {
  it("lists, uploads, and deletes only the authenticated user's skills", async function () {
    const routes = routeFixture();
    const uploaded = await routes.upload(
      request({
        body: {
          skillMarkdown: skillMarkdown(),
          referenceFiles: { "evidence.md": "Prefer primary sources." },
        },
      }),
    );

    expect(uploaded.statusCode).toBe(200);
    expect(uploaded.body).toEqual({
      id: "skill-route-1",
      name: "claim-check",
      description: "Check claims against their evidence.",
    });
    expect(uploaded.body).not.toHaveProperty("body");
    expect(uploaded.body).not.toHaveProperty("referenceFiles");
    expect((await routes.list(request())).body.skills).toEqual([uploaded.body]);
    expect(
      (await routes.list(request({ authenticatedUserId: otherUserId }))).body
        .skills,
    ).toEqual([]);

    const otherDelete = await routes.remove(
      request({
        authenticatedUserId: otherUserId,
        skillId: uploaded.body.id,
      }),
    );
    expectSpecific4xx(otherDelete, "The AI reviewer skill does not exist.");
    expect((await routes.list(request())).body.skills).toEqual([uploaded.body]);

    const deleted = await routes.remove(request({ skillId: uploaded.body.id }));
    expect(deleted.statusCode).toBe(200);
    expect(deleted.body).toEqual({ skills: [] });
  });

  it.each([
    [
      "missing name",
      "---\ndescription: A description.\n---\nBody",
      "SKILL.md frontmatter must include a non-empty `name`.",
    ],
    [
      "missing description",
      "---\nname: claim-check\n---\nBody",
      "SKILL.md frontmatter must include a non-empty `description`.",
    ],
    [
      "unparsable frontmatter",
      "---\nname: [claim-check\ndescription: A description.\n---\nBody",
      "SKILL.md frontmatter is not valid YAML: only simple scalar values are supported.",
    ],
  ])(
    "surfaces %s as a specific 4xx response",
    async function (_name, markdown, message) {
      const response = await routeFixture().upload(
        request({ body: { skillMarkdown: markdown, referenceFiles: {} } }),
      );
      expectSpecific4xx(response, message);
    },
  );

  it("surfaces the byte cap as a specific 4xx response", async function () {
    const response = await routeFixture().upload(
      request({
        body: {
          skillMarkdown: skillMarkdown(
            "too-large",
            "x".repeat(AI_REVIEWER_SKILL_MAX_BYTES + 1),
          ),
          referenceFiles: {},
        },
      }),
    );
    expectSpecific4xx(
      response,
      `An AI reviewer skill may not exceed ${AI_REVIEWER_SKILL_MAX_BYTES} bytes.`,
    );
  });

  it("surfaces the count cap as a specific 4xx response", async function () {
    const routes = routeFixture();
    for (let index = 0; index < AI_REVIEWER_SKILL_COUNT_LIMIT; index += 1) {
      const response = await routes.upload(
        request({
          body: {
            skillMarkdown: skillMarkdown(`skill-${index}`),
            referenceFiles: {},
          },
        }),
      );
      expect(response.statusCode).toBe(200);
    }

    const rejected = await routes.upload(
      request({
        body: {
          skillMarkdown: skillMarkdown("one-too-many"),
          referenceFiles: {},
        },
      }),
    );
    expectSpecific4xx(
      rejected,
      `A user may not keep more than ${AI_REVIEWER_SKILL_COUNT_LIMIT} AI reviewer skills.`,
    );
  });

  it("surfaces a duplicate name as a specific 4xx response", async function () {
    const routes = routeFixture();
    await routes.upload(
      request({
        body: { skillMarkdown: skillMarkdown(), referenceFiles: {} },
      }),
    );
    const rejected = await routes.upload(
      request({
        body: { skillMarkdown: skillMarkdown(), referenceFiles: {} },
      }),
    );
    expectSpecific4xx(
      rejected,
      'An AI reviewer skill named "claim-check" already exists.',
    );
  });
});
