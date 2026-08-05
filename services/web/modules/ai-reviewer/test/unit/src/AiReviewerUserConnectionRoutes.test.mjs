import { describe, expect, it, vi } from "vitest";

import { createAiReviewerProviderConfigStore } from "../../../app/src/AiReviewerProviderConfigStore.mjs";
import { createAiReviewerProviderController } from "../../../app/src/AiReviewerProviderController.mjs";
import { createAiReviewerRouter } from "../../../app/src/AiReviewerRouter.mjs";

const ownerUserId = "user-session-owner-0001";
const otherUserId = "user-session-owner-0002";
const connectionId = "connection-session-owner-0001";
const secret = "PRIVATE_SESSION_SCOPED_PROVIDER_SECRET";
const connectionWrite = Object.freeze({
  provider: "openai-compatible",
  baseUrl: "https://provider.example/v1",
  label: "Session owner provider",
  contextLengthOverride: null,
  credential: secret,
});

function clone(value) {
  return value == null ? value : structuredClone(value);
}

function query(work) {
  const result = { exec: vi.fn(async () => clone(await work())) };
  result.lean = vi.fn(() => result);
  return result;
}

function matchesRevision(record, filter) {
  if (record == null) return false;
  if (Object.hasOwn(filter, "revision")) {
    return record.revision === filter.revision;
  }
  return filter.$or.some(({ revision }) =>
    typeof revision === "object"
      ? revision.$exists === false && !Object.hasOwn(record, "revision")
      : record.revision === revision,
  );
}

function inMemoryModel() {
  const records = new Map();
  const model = {
    findOne: vi.fn(({ _id }) => query(() => records.get(_id) ?? null)),
    findOneAndUpdate: vi.fn((filter, update, options = {}) =>
      query(() => {
        const current = records.get(filter._id);
        if (!matchesRevision(current, filter)) {
          if (!options.upsert) return null;
          if (current != null) {
            const error = new Error("duplicate provider configuration key");
            error.code = 11000;
            throw error;
          }
        }
        const next = { ...current, ...clone(update.$set) };
        for (const [key, increment] of Object.entries(update.$inc ?? {})) {
          next[key] = (current?.[key] ?? 0) + increment;
        }
        records.set(filter._id, next);
        return { _id: filter._id, ...next };
      }),
    ),
    deleteOne: vi.fn(({ _id }) =>
      query(() => ({ deletedCount: records.delete(_id) ? 1 : 0 })),
    ),
  };
  return { model, records };
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

  sendStatus(statusCode) {
    this.statusCode = statusCode;
    return this;
  }
}

function request({ sessionUserId, body, routedConnectionId } = {}) {
  return {
    body,
    // Neither an attacker-provided user parameter nor a stale request.user may
    // select the owner. requireLogin replaces request.user from the session.
    params: {
      user_id: ownerUserId,
      connection_id: routedConnectionId,
    },
    user: { _id: { toString: () => ownerUserId } },
    ...(sessionUserId == null
      ? { session: {} }
      : {
          session: {
            user: { _id: { toString: () => sessionUserId } },
          },
        }),
  };
}

function routeFixture() {
  const { model, records } = inMemoryModel();
  const credentialManager = {
    encrypt: vi.fn(async (value) => `encrypted:${JSON.stringify(value)}`),
    decrypt: vi.fn(async (value) =>
      JSON.parse(String(value).slice("encrypted:".length)),
    ),
  };
  const configStore = createAiReviewerProviderConfigStore({
    model,
    credentialManager,
    newConnectionId: () => connectionId,
    now: () => "2026-08-02T00:00:00.000Z",
  });
  const controller = createAiReviewerProviderController({
    configStore,
    providerService: {},
    workspaceStore: {
      countProjectsSelectingConnections: vi.fn(async () => ({})),
    },
  });
  const requireLogin = vi.fn(() => (rawRequest, response, next) => {
    const sessionUser = rawRequest.session?.user;
    if (sessionUser?._id == null) return response.sendStatus(401);
    rawRequest.user = sessionUser;
    return next();
  });
  const pass = vi.fn((_request, _response, next) => next());
  const unused = vi.fn();
  const routes = new Map();
  const webRouter = {};
  for (const method of ["get", "post", "put", "delete"]) {
    webRouter[method] = (path, ...handlers) => {
      routes.set(`${method.toUpperCase()} ${path}`, handlers);
    };
  }
  createAiReviewerRouter({
    authenticationController: { requireLogin },
    authorizationMiddleware: {
      blockRestrictedUserFromProject: unused,
      ensureUserCanReadProject: unused,
    },
    rateLimit: pass,
    listModels: unused,
    testConnection: unused,
    listConnections: controller.listConnections,
    createConnection: controller.createConnection,
    updateConnection: controller.updateConnection,
    deleteConnection: controller.deleteConnection,
    listSkills: unused,
    uploadSkill: unused,
    previewSkillGitImport: unused,
    confirmSkillGitImport: unused,
    deleteSkill: unused,
    stream: unused,
    getWorkspace: unused,
    saveWorkspace: unused,
    getCommentProvenance: unused,
    markCommentProvenance: unused,
    deleteCommentProvenance: unused,
    deleteDiscussion: unused,
    deleteWorkspace: unused,
  }).apply(webRouter);

  async function invoke(method, path, rawRequest) {
    const handlers = routes.get(`${method} ${path}`);
    const response = new FakeResponse();
    async function dispatch(index) {
      if (index >= handlers.length) return;
      await handlers[index](rawRequest, response, () => dispatch(index + 1));
    }
    await dispatch(0);
    return response;
  }

  return {
    configStore,
    records,
    requireLogin,
    list: (rawRequest) =>
      invoke("GET", "/user/ai-reviewer/connections", rawRequest),
    create: (rawRequest) =>
      invoke("POST", "/user/ai-reviewer/connections", rawRequest),
    update: (rawRequest) =>
      invoke("PUT", "/user/ai-reviewer/connections/:connection_id", rawRequest),
    remove: (rawRequest) =>
      invoke(
        "DELETE",
        "/user/ai-reviewer/connections/:connection_id",
        rawRequest,
      ),
  };
}

describe("AI reviewer user-scoped connection routes", function () {
  it.each([
    ["GET", "list"],
    ["POST", "create"],
    ["PUT", "update"],
    ["DELETE", "remove"],
  ])("requires a session for %s", async function (_method, operation) {
    const routes = routeFixture();
    const response = await routes[operation](
      request({
        body: { ...connectionWrite, expectedRevision: 1 },
        routedConnectionId: connectionId,
      }),
    );

    expect(response.statusCode).toBe(401);
    expect(routes.records.size).toBe(0);
  });

  it("operates only on the session user's own connections", async function () {
    const routes = routeFixture();
    const created = await routes.create(
      request({ sessionUserId: ownerUserId, body: connectionWrite }),
    );
    expect(created.statusCode).toBe(200);
    expect(created.body).toMatchObject({ id: connectionId, revision: 1 });

    const otherListing = await routes.list(
      request({ sessionUserId: otherUserId }),
    );
    expect(otherListing.body).toEqual({ connections: [] });

    const otherUpdate = await routes.update(
      request({
        sessionUserId: otherUserId,
        routedConnectionId: connectionId,
        body: {
          ...connectionWrite,
          label: "Attacker replacement",
          expectedRevision: 1,
        },
      }),
    );
    expect(otherUpdate.statusCode).toBe(404);

    const otherDelete = await routes.remove(
      request({
        sessionUserId: otherUserId,
        routedConnectionId: connectionId,
        body: { expectedRevision: 1 },
      }),
    );
    expect(otherDelete.statusCode).toBe(404);

    expect(await routes.configStore.list(ownerUserId)).toHaveLength(1);
    expect(await routes.configStore.list(otherUserId)).toEqual([]);
  });

  it("never returns a stored credential in a connection listing", async function () {
    const routes = routeFixture();
    await routes.create(
      request({ sessionUserId: ownerUserId, body: connectionWrite }),
    );
    expect(
      routes.records.get(ownerUserId).connections[0].credentialEncrypted,
    ).toContain(secret);

    const listing = await routes.list(request({ sessionUserId: ownerUserId }));
    expect(listing.statusCode).toBe(200);
    expect(listing.body.connections[0].config.credentialSet).toBe(true);
    expect(JSON.stringify(listing.body)).not.toContain(secret);
    expect(JSON.stringify(listing.body)).not.toContain("credentialEncrypted");
    expect(listing.body.connections[0].config).not.toHaveProperty("credential");
  });
});
