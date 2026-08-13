import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { AgentGatewayError } from "../../../app/src/AgentGateway.mjs";
import { publicAiReviewerProviderConnection } from "../../../app/src/AiReviewerProviderConfig.mjs";
import {
  AI_REVIEWER_CONNECTION_LIMIT,
  AiReviewerConnectionAmbiguousError,
  AiReviewerConnectionConflictError,
  AiReviewerConnectionLimitError,
  AiReviewerConnectionNotFoundError,
  AiReviewerPlaintextCredentialError,
  AiReviewerProviderConfigInputError,
  createAiReviewerProviderConfigStore,
} from "../../../app/src/AiReviewerProviderConfigStore.mjs";
import { createAiReviewerProviderCredentialManager } from "../../../app/src/AiReviewerProviderCredentialManager.mjs";
import { createAiReviewerProviderController } from "../../../app/src/AiReviewerProviderController.mjs";
import { createConfiguredAiReviewerController } from "../../../app/src/ConfiguredAiReviewerController.mjs";
import { assertOpenAiCompatibleCredentialTransport } from "../../../app/src/OllamaEndpointPolicy.mjs";
import { AgentEventSchema } from "../../../shared/contracts.mjs";

const userId = "user-connections-0001";
const otherUserId = "user-connections-0002";
const projectId = "project-connections-0001";
const createdAt = "2026-07-30T00:00:00.000Z";
const credentialUpdatedAt = "2026-07-30T00:01:00.000Z";
const contextLength = 8_192;
const localBaseUrl = "http://127.0.0.1:11434/v1";
const localModel = "overleaf-ai-reviewer-compat-8k:latest";
const sharedModel = "reviewer/shared-v1";
const geminiModel = "gemini-2.5-pro";
const claudeModel = "claude-sonnet-4-20250514";
const geminiCredential = "PRIVATE_GEMINI_CREDENTIAL";
const claudeCredential = "PRIVATE_CLAUDE_CREDENTIAL";
const plaintextCredential = "PRIVATE_PLAINTEXT_CREDENTIAL";
const openAiCompatibleApiVersion = "2025-01-01-preview";

// A connection is a destination: provider, endpoint, credential. No model.
const localConnection = Object.freeze({
  provider: "openai-compatible",
  baseUrl: localBaseUrl,
});
const geminiConnection = Object.freeze({
  provider: "gemini",
  credential: geminiCredential,
});
const claudeConnection = Object.freeze({
  provider: "claude",
  credential: claudeCredential,
});
const azureConnection = Object.freeze({
  provider: "azure",
  baseUrl: "https://reviewer.openai.azure.com/openai",
  requestStyle: "deployment",
  apiVersion: "2025-01-01-preview",
  deployments: ["reviewer-deployment"],
  credential: "PRIVATE_AZURE_CREDENTIAL",
});
const plaintextAzureConnection = Object.freeze({
  ...azureConnection,
  baseUrl: "http://host.docker.internal:11434/openai",
});

function fakeQuery(value) {
  const query = { exec: vi.fn(async () => value) };
  query.lean = vi.fn(() => query);
  return query;
}

function matchesRevision(record, filter) {
  if (record == null) {
    return false;
  }
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
  const modelDependency = {
    findOne: vi.fn(({ _id }) =>
      fakeQuery(records.has(_id) ? { _id, ...records.get(_id) } : null),
    ),
    findOneAndUpdate: vi.fn((filter, update, options = {}) => {
      const query = {
        exec: async () => {
          const { _id } = filter;
          const current = records.get(_id);
          if (!matchesRevision(current, filter) && !options.upsert) {
            return null;
          }
          const next = { ...current, ...update.$set };
          for (const [key, increment] of Object.entries(update.$inc ?? {})) {
            next[key] = (current?.[key] ?? 0) + increment;
          }
          for (const key of Object.keys(update.$unset ?? {})) {
            delete next[key];
          }
          records.set(_id, next);
          return { _id, ...next };
        },
      };
      query.lean = () => query;
      return query;
    }),
    deleteOne: vi.fn(({ _id }) => ({
      exec: async () => {
        records.delete(_id);
      },
    })),
  };
  return { modelDependency, records };
}

function credentialManagerFixture() {
  const envelopes = new Map();
  let sequence = 0;
  const encryptor = {
    encryptJson: vi.fn(async (value) => {
      sequence += 1;
      const encrypted = `ciphertext-${sequence}`;
      envelopes.set(encrypted, structuredClone(value));
      return encrypted;
    }),
    decryptToJson: vi.fn(async (encrypted) => {
      if (!envelopes.has(encrypted)) {
        throw new Error("Unknown ciphertext.");
      }
      return structuredClone(envelopes.get(encrypted));
    }),
  };
  return {
    envelopes,
    manager: createAiReviewerProviderCredentialManager({ encryptor }),
  };
}

function storeFixture() {
  const { modelDependency, records } = inMemoryModel();
  const { envelopes, manager } = credentialManagerFixture();
  let sequence = 0;
  const store = createAiReviewerProviderConfigStore({
    model: modelDependency,
    credentialManager: manager,
    now: () => credentialUpdatedAt,
    newConnectionId: () => `connection-${(sequence += 1)}`,
  });
  return { envelopes, manager, modelDependency, records, store };
}

function httpRequest({
  body,
  query,
  params,
  authenticatedUserId = userId,
} = {}) {
  const request = new EventEmitter();
  request.body = body;
  request.query = query;
  request.params = { project_id: projectId, ...params };
  request.user = { _id: { toString: () => authenticatedUserId } };
  return request;
}

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.body = undefined;
    this.headers = new Map();
    this.chunks = [];
    this.writableEnded = false;
  }

  status(statusCode) {
    this.statusCode = statusCode;
    return this;
  }

  json(body) {
    this.body = body;
    return this;
  }

  setHeader(name, value) {
    this.headers.set(name.toLowerCase(), value);
  }

  flushHeaders() {}

  write(chunk) {
    this.chunks.push(String(chunk));
    return true;
  }

  end() {
    this.writableEnded = true;
  }
}

function parseNdjson(response) {
  return response.chunks
    .join("")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => AgentEventSchema.parse(JSON.parse(line)));
}

function selectionRequest(overrides = {}) {
  return {
    requestId: "request-connections-0001",
    projectId,
    action: "review",
    instruction: "Review this synthetic selection.",
    skill: "referee-review",
    scope: {
      kind: "selection",
      documentId: "document-connections-0001",
      path: "main.tex",
      baseRevision: 9,
      baseTextHash: "a".repeat(64),
      range: { from: 5, to: 14 },
      text: "Synthetic",
    },
    ...overrides,
  };
}

function streamEvents() {
  return [
    {
      type: "started",
      eventId: "event-connections",
      requestId: "request-connections-0001",
      sequence: 0,
      createdAt,
      provider: "gemini",
      model: geminiModel,
      skill: "referee-review",
    },
    {
      type: "completed",
      eventId: "event-connections",
      requestId: "request-connections-0001",
      sequence: 1,
      createdAt,
      finishReason: "stop",
    },
  ];
}

/**
 * Each connection discovers its own models, so which models exist depends on
 * the connection a run resolved to.
 */
function connectionModels(connection) {
  switch (connection.provider) {
    case "gemini":
      return [
        { id: geminiModel, displayName: "Gemini 2.5 Pro" },
        { id: sharedModel, displayName: sharedModel },
      ];
    case "claude":
      return [{ id: claudeModel, displayName: "Claude Sonnet 4" }];
    default:
      return [
        { id: localModel, displayName: localModel },
        { id: sharedModel, displayName: sharedModel },
      ];
  }
}

function streamFixture({ store, listModels, modeInstructionStore }) {
  const providerService = {
    listModels:
      listModels ?? vi.fn(async (connection) => connectionModels(connection)),
    resolveContextLength: vi.fn(async () => ({
      contextLength,
      contextLengthSource: "detected",
    })),
    createAgentGateway: vi.fn(() => ({
      async *stream() {
        yield* streamEvents();
      },
    })),
  };
  const requestScopeReader = {
    read: vi.fn(async () => ({
      kind: "selection",
      readProjectFile: vi.fn(),
    })),
  };
  return {
    providerService,
    requestScopeReader,
    controller: createConfiguredAiReviewerController({
      configStore: store,
      providerService,
      modeInstructionStore,
      requestScopeReader,
      now: () => createdAt,
      eventId: () => "event-connections",
    }),
  };
}

async function captureError(work) {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject.");
}

describe("AI reviewer provider connections", function () {
  it("saves a connection without asking for a model name", async function () {
    const { records, store } = storeFixture();

    const local = await store.create(userId, localConnection);

    expect(local).toMatchObject({
      provider: "openai-compatible",
      baseUrl: localBaseUrl,
      label: "127.0.0.1:11434",
      credentialSet: false,
    });
    expect(records.get(userId).connections[0]).not.toHaveProperty("model");
    expect(records.get(userId).connections[0]).not.toHaveProperty(
      "contextLength",
    );
    expect(await store.get(userId, local.id)).toEqual({
      id: local.id,
      provider: "openai-compatible",
      baseUrl: localBaseUrl,
      label: "127.0.0.1:11434",
    });
  });

  it("refuses to save a credential for HTTP before encrypting it and allows HTTPS localhost", async function () {
    const { envelopes, store } = storeFixture();
    const blocked = await captureError(
      store.create(userId, {
        ...localConnection,
        credential: plaintextCredential,
      }),
    );

    expect(blocked).toBeInstanceOf(AiReviewerPlaintextCredentialError);
    expect(blocked.message).toBe(
      "API keys cannot be saved for HTTP endpoints. Use HTTPS or recreate the connection without a key.",
    );
    expect(envelopes.size).toBe(0);
    expect(await store.list(userId)).toEqual([]);

    const blockedAzure = await captureError(
      store.create(userId, plaintextAzureConnection),
    );
    expect(blockedAzure).toBeInstanceOf(AiReviewerPlaintextCredentialError);
    expect(envelopes.size).toBe(0);
    expect(await store.list(userId)).toEqual([]);

    const controller = createAiReviewerProviderController({
      configStore: store,
      providerService: {},
    });
    const response = new FakeResponse();
    await controller.createConnection(
      httpRequest({
        body: { ...localConnection, credential: plaintextCredential },
      }),
      response,
    );
    expect(response.statusCode).toBe(400);
    expect(response.body.error).toEqual({
      code: "AI_PROVIDER_PLAINTEXT_CREDENTIAL_BLOCKED",
      category: "configuration",
      message:
        "API keys cannot be saved or sent to HTTP endpoints. Use HTTPS or recreate the connection without a key.",
      retryable: false,
    });
    expect(envelopes.size).toBe(0);

    const encryptedLocal = await store.create(userId, {
      provider: "openai-compatible",
      baseUrl: "https://localhost:8443/v1",
      credential: plaintextCredential,
    });
    expect(encryptedLocal).toMatchObject({
      baseUrl: "https://localhost:8443/v1",
      credentialSet: true,
    });
    expect((await store.get(userId, encryptedLocal.id)).credential).toBe(
      plaintextCredential,
    );
  });

  it("keeps an existing HTTP credential but refuses to preserve or send it", async function () {
    const { manager, records, store } = storeFixture();
    const credentialEncrypted = await manager.encrypt({
      provider: "openai-compatible",
      baseUrl: localBaseUrl,
      credential: plaintextCredential,
    });
    records.set(userId, {
      revision: 1,
      connections: [
        {
          _id: "connection-existing-plaintext",
          revision: 7,
          ...localConnection,
          credentialEncrypted,
          credentialUpdatedAt,
        },
      ],
    });

    expect(await store.list(userId)).toEqual([
      expect.objectContaining({
        id: "connection-existing-plaintext",
        credentialSet: true,
      }),
    ]);
    const loaded = await store.get(userId, "connection-existing-plaintext");
    expect(loaded.credential).toBe(plaintextCredential);
    expect(() =>
      assertOpenAiCompatibleCredentialTransport(
        loaded.baseUrl,
        typeof loaded.credential === "string",
      ),
    ).toThrowError("The API key was not sent because the endpoint uses HTTP");

    const preserved = await captureError(
      store.update(
        userId,
        "connection-existing-plaintext",
        { ...localConnection, label: "Still plaintext" },
        7,
      ),
    );
    expect(preserved).toBeInstanceOf(AiReviewerPlaintextCredentialError);
    expect(records.get(userId).connections[0].credentialEncrypted).toBe(
      credentialEncrypted,
    );
  });

  it("stores manual fallback models on the connection that owns them", async function () {
    const { records, store } = storeFixture();
    const manualModels = ["reviewer/manual-v1", "reviewer/manual-v2"];

    const local = await store.create(userId, {
      ...localConnection,
      models: manualModels,
    });

    expect(records.get(userId).connections[0].models).toEqual(manualModels);
    expect(await store.get(userId, local.id)).toMatchObject({
      id: local.id,
      models: manualModels,
    });
    expect((await store.list(userId))[0].models).toEqual(manualModels);

    const controller = createAiReviewerProviderController({
      configStore: store,
      providerService: {},
    });
    const response = new FakeResponse();
    await controller.listConnections(httpRequest(), response);
    expect(response.body.connections[0].config.models).toEqual(manualModels);

    expect(
      await captureError(
        store.create(userId, {
          ...localConnection,
          models: [manualModels[0], manualModels[0]],
        }),
      ),
    ).toMatchObject({
      message: "AI provider fallback models must be unique.",
    });
  });

  it("names an unnamed connection after its endpoint or its vendor", async function () {
    const { store } = storeFixture();
    await store.create(userId, localConnection);
    await store.create(userId, geminiConnection);
    await store.create(userId, claudeConnection);
    const named = await store.create(userId, {
      ...localConnection,
      label: "  Lab GPU box  ",
    });

    expect((await store.list(userId)).map(({ label }) => label)).toEqual([
      "127.0.0.1:11434",
      "Google Gemini",
      "Anthropic Claude",
      "Lab GPU box",
    ]);
    // A name the user did not type is not stored, so it keeps following the
    // endpoint when the endpoint is edited.
    await store.update(
      userId,
      named.id,
      {
        ...localConnection,
        baseUrl: "https://api.example.com/v1",
        label: "",
      },
      named.revision,
    );
    expect((await store.list(userId)).at(-1).label).toBe("api.example.com");
  });

  it("keeps three provider connections side by side and edits each on its own", async function () {
    const { records, store } = storeFixture();

    const local = await store.create(userId, localConnection);
    const gemini = await store.create(userId, geminiConnection);
    const claude = await store.create(userId, claudeConnection);

    expect(new Set([local.id, gemini.id, claude.id]).size).toBe(3);
    expect((await store.list(userId)).map((entry) => entry.provider)).toEqual([
      "openai-compatible",
      "gemini",
      "claude",
    ]);
    expect(await store.get(userId, gemini.id)).toEqual({
      id: gemini.id,
      provider: "gemini",
      label: "Google Gemini",
      credential: geminiCredential,
      credentialUpdatedAt,
    });

    const updatedGemini = await store.update(
      userId,
      gemini.id,
      {
        ...geminiConnection,
        contextLengthOverride: 32_768,
      },
      gemini.revision,
    );
    expect(updatedGemini.id).toBe(gemini.id);
    expect((await store.get(userId, gemini.id)).contextLengthOverride).toBe(
      32_768,
    );
    expect(await store.get(userId, claude.id)).toMatchObject({
      provider: "claude",
      credential: claudeCredential,
    });

    const remaining = await store.remove(userId, claude.id, claude.revision);
    expect(remaining.map((entry) => entry.id)).toEqual([local.id, gemini.id]);
    expect(await captureError(store.get(userId, claude.id))).toBeInstanceOf(
      AiReviewerConnectionNotFoundError,
    );
    expect(records.get(userId).connections).toHaveLength(2);
  });

  it("round-trips reasoning model compatibility and defaults old connections to off", async function () {
    const { records, store } = storeFixture();

    const compatible = await store.create(userId, {
      ...localConnection,
      reasoningModelCompatibility: true,
    });

    expect(compatible.reasoningModelCompatibility).toBe(true);
    expect(
      (await store.get(userId, compatible.id)).reasoningModelCompatibility,
    ).toBe(true);
    expect(
      publicAiReviewerProviderConnection(compatible).config
        .reasoningModelCompatibility,
    ).toBe(true);
    expect(records.get(userId).connections[0]).toMatchObject({
      reasoningModelCompatibility: true,
    });

    const existing = await store.create(otherUserId, localConnection);
    expect(existing).not.toHaveProperty("reasoningModelCompatibility");
    expect(await store.get(otherUserId, existing.id)).not.toHaveProperty(
      "reasoningModelCompatibility",
    );
  });

  it("persists and reports optional image support", async function () {
    const { records, store } = storeFixture();

    const supported = await store.create(userId, {
      ...geminiConnection,
      supportsImages: true,
    });

    expect(supported.supportsImages).toBe(true);
    expect((await store.get(userId, supported.id)).supportsImages).toBe(true);
    expect(
      publicAiReviewerProviderConnection(supported).config.supportsImages,
    ).toBe(true);
    expect(records.get(userId).connections[0]).toMatchObject({
      supportsImages: true,
    });

    const existing = await store.create(otherUserId, geminiConnection);
    expect(existing).not.toHaveProperty("supportsImages");
    expect(await store.get(otherUserId, existing.id)).not.toHaveProperty(
      "supportsImages",
    );
  });

  it("round-trips an OpenAI-compatible API version through connection details", async function () {
    const { records, store } = storeFixture();

    const created = await store.create(userId, {
      ...localConnection,
      apiVersion: openAiCompatibleApiVersion,
    });

    expect(created.apiVersion).toBe(openAiCompatibleApiVersion);
    expect((await store.get(userId, created.id)).apiVersion).toBe(
      openAiCompatibleApiVersion,
    );
    expect(publicAiReviewerProviderConnection(created).config.apiVersion).toBe(
      openAiCompatibleApiVersion,
    );
    expect(records.get(userId).connections[0].apiVersion).toBe(
      openAiCompatibleApiVersion,
    );
  });

  it("resets the circuit only when a normalized request destination changes", async function () {
    const remoteConnection = {
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      credential: geminiCredential,
    };
    const { store } = storeFixture();
    let current = await store.create(userId, remoteConnection);
    const reset = vi.fn(async () => {});
    const controller = createAiReviewerProviderController({
      configStore: store,
      providerService: {},
      circuitBreakerStore: { reset },
    });
    const save = async (body) => {
      const response = new FakeResponse();
      await controller.updateConnection(
        httpRequest({
          body: { ...body, expectedRevision: current.revision },
          params: { connection_id: current.id },
        }),
        response,
      );
      expect(response.statusCode).toBe(200);
      current = { ...current, revision: response.body.revision };
    };

    await save({
      provider: "ollama",
      baseUrl: "https://api.example.com/v1",
      label: "Renamed connection",
    });
    await save({
      ...remoteConnection,
      label: "Renamed connection",
    });
    await save({
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      label: "Renamed connection",
      reasoningModelCompatibility: true,
    });
    await save({
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      label: "Renamed connection",
      reasoningModelCompatibility: true,
      contextLengthOverride: 32_768,
    });
    await save({
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      apiVersion: "",
      label: "Renamed connection",
    });

    expect(reset).not.toHaveBeenCalled();

    await save({
      provider: "openai-compatible",
      baseUrl: "https://other.example.com/v1",
    });
    expect(reset).toHaveBeenCalledExactlyOnceWith(current.id);
  });

  it.each([
    {
      name: "credential first set",
      initial: {
        provider: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
      },
      update: {
        provider: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        credential: geminiCredential,
      },
    },
    {
      name: "credential removal",
      initial: {
        provider: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        credential: geminiCredential,
      },
      update: {
        provider: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        credential: null,
      },
    },
    {
      name: "credential",
      initial: {
        provider: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        credential: geminiCredential,
      },
      update: {
        provider: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        credential: claudeCredential,
      },
    },
    {
      name: "API version",
      initial: {
        provider: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
      },
      update: {
        provider: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        apiVersion: openAiCompatibleApiVersion,
      },
    },
    {
      name: "API version removal",
      initial: {
        provider: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        apiVersion: openAiCompatibleApiVersion,
      },
      update: {
        provider: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        apiVersion: "",
      },
    },
    {
      name: "API version value",
      initial: {
        provider: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        apiVersion: openAiCompatibleApiVersion,
      },
      update: {
        provider: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
        apiVersion: "2025-04-01-preview",
      },
    },
    {
      name: "Azure request style",
      initial: azureConnection,
      update: {
        provider: "azure",
        baseUrl: azureConnection.baseUrl,
        requestStyle: "v1",
        deployments: azureConnection.deployments,
        credential: azureConnection.credential,
      },
    },
  ])(
    "resets the circuit after a $name change",
    async function ({ initial, update }) {
      const { store } = storeFixture();
      const created = await store.create(userId, initial);
      const reset = vi.fn(async () => {});
      const controller = createAiReviewerProviderController({
        configStore: store,
        providerService: {},
        circuitBreakerStore: { reset },
      });
      const response = new FakeResponse();

      await controller.updateConnection(
        httpRequest({
          body: { ...update, expectedRevision: created.revision },
          params: { connection_id: created.id },
        }),
        response,
      );

      expect(response.statusCode).toBe(200);
      expect(reset).toHaveBeenCalledExactlyOnceWith(created.id);
    },
  );

  it("rejects changing a saved connection's provider without touching its destination", async function () {
    const { records, store } = storeFixture();
    const azure = await store.create(userId, azureConnection);
    const before = structuredClone(records.get(userId));

    const error = await captureError(
      store.update(
        userId,
        azure.id,
        {
          provider: "gemini",
          credential: geminiCredential,
        },
        azure.revision,
      ),
    );

    expect(error).toBeInstanceOf(AiReviewerProviderConfigInputError);
    expect(error.message).toBe(
      "The provider of an existing AI provider connection cannot be changed.",
    );
    expect(records.get(userId)).toEqual(before);
    expect(await store.get(userId, azure.id)).toMatchObject(azureConnection);

    const reset = vi.fn(async () => {});
    const controller = createAiReviewerProviderController({
      configStore: store,
      providerService: {},
      circuitBreakerStore: { reset },
    });
    const response = new FakeResponse();
    await controller.updateConnection(
      httpRequest({
        body: {
          provider: "gemini",
          credential: geminiCredential,
          expectedRevision: azure.revision,
        },
        params: { connection_id: azure.id },
      }),
      response,
    );
    expect(response.statusCode).toBe(400);
    expect(response.body.error.code).toBe("AI_PROVIDER_CONFIGURATION_INVALID");
    expect(reset).not.toHaveBeenCalled();
    expect(records.get(userId)).toEqual(before);
  });

  it("carries an existing configuration forward without its model or context length", async function () {
    const { records, store } = storeFixture();
    records.set(userId, {
      provider: "ollama",
      baseUrl: localBaseUrl,
      model: localModel,
      contextLength,
      contextLengthSource: "override",
    });

    const migrated = await store.list(userId);
    expect(migrated).toHaveLength(1);
    // The document id is reused so the identifier is already stable for a
    // reader that arrives before the first write.
    expect(migrated[0]).toEqual({
      id: userId,
      revision: 0,
      credentialSet: false,
      provider: "openai-compatible",
      baseUrl: localBaseUrl,
      label: "127.0.0.1:11434",
    });
    expect(await store.get(userId)).toEqual({
      id: userId,
      provider: "openai-compatible",
      baseUrl: localBaseUrl,
      label: "127.0.0.1:11434",
    });

    const added = await store.create(userId, geminiConnection);
    expect(records.get(userId).connections.map(({ _id }) => _id)).toEqual([
      userId,
      added.id,
    ]);
    for (const legacyField of [
      "provider",
      "baseUrl",
      "model",
      "contextLength",
      "contextLengthSource",
    ]) {
      expect(records.get(userId)).not.toHaveProperty(legacyField);
    }
  });

  it("carries an existing credential forward with its destination binding", async function () {
    const { records, store } = storeFixture();
    const seeded = await store.create(otherUserId, {
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      credential: geminiCredential,
    });
    const encrypted = records
      .get(otherUserId)
      .connections.find(({ _id }) => _id === seeded.id).credentialEncrypted;
    records.set(userId, {
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      model: "hosted/reviewer-v1",
      contextLength,
      credentialEncrypted: encrypted,
      credentialUpdatedAt: new Date(credentialUpdatedAt),
    });

    expect(await store.get(userId)).toEqual({
      id: userId,
      provider: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      label: "api.example.com",
      credential: geminiCredential,
      credentialUpdatedAt,
    });
  });

  it("keeps valid public connections when one stored connection cannot be converted", async function () {
    const { records, store } = storeFixture();
    const valid = await store.create(userId, geminiConnection);
    records.get(userId).connections.unshift({
      _id: "connection-unreadable",
      provider: "openai-compatible",
      baseUrl: "not-a-url",
    });

    expect(await store.list(userId)).toEqual([
      expect.objectContaining({ id: valid.id, label: "Google Gemini" }),
    ]);
  });

  it("refuses to read one connection's credential through another connection", async function () {
    const { records, store } = storeFixture();
    const gemini = await store.create(userId, geminiConnection);
    const claude = await store.create(userId, claudeConnection);
    const geminiEnvelope = records
      .get(userId)
      .connections.find(({ _id }) => _id === gemini.id).credentialEncrypted;

    records.set(userId, {
      ...records.get(userId),
      connections: records
        .get(userId)
        .connections.map((connection) =>
          connection._id === claude.id
            ? { ...connection, credentialEncrypted: geminiEnvelope }
            : connection,
        ),
    });

    const error = await captureError(store.get(userId, claude.id));
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toBe("The AI provider credential could not be read.");
    expect(String(error)).not.toContain(geminiCredential);
    expect(await store.get(userId, gemini.id)).toMatchObject({
      credential: geminiCredential,
    });
  });

  it("never puts a credential in a connection listing", async function () {
    const { store } = storeFixture();
    await store.create(userId, geminiConnection);
    await store.create(userId, claudeConnection);
    const controller = createAiReviewerProviderController({
      configStore: store,
      providerService: {},
    });
    const response = new FakeResponse();

    await controller.listConnections(httpRequest(), response);

    expect(response.body.connections).toHaveLength(2);
    expect(response.body.connections[0]).toEqual({
      id: expect.any(String),
      revision: 1,
      label: "Google Gemini",
      classification: "remote",
      config: {
        provider: "gemini",
        contextLengthOverride: null,
        credentialSet: true,
        credentialUpdatedAt,
      },
    });
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toContain(geminiCredential);
    expect(serialized).not.toContain(claudeCredential);
    expect(serialized).not.toContain("credentialEncrypted");
  });

  it("keeps readable private connections when one credential cannot be decrypted", async function () {
    const { records, store } = storeFixture();
    const gemini = await store.create(userId, geminiConnection);
    const claude = await store.create(userId, claudeConnection);
    records
      .get(userId)
      .connections.find(({ _id }) => _id === gemini.id).credentialEncrypted =
      "unreadable-ciphertext";

    expect(await store.getAll(userId)).toEqual([
      expect.objectContaining({
        id: gemini.id,
        provider: "gemini",
        credentialLoadFailed: true,
      }),
      expect.objectContaining({
        id: claude.id,
        provider: "claude",
        credential: claudeCredential,
      }),
    ]);
  });

  it("lists how many of the user's projects select each connection", async function () {
    const { store } = storeFixture();
    const gemini = await store.create(userId, geminiConnection);
    const workspaceStore = {
      countProjectsSelectingConnections: vi.fn(async () => ({
        [gemini.id]: 3,
      })),
    };
    const controller = createAiReviewerProviderController({
      configStore: store,
      providerService: {},
      workspaceStore,
    });
    const response = new FakeResponse();

    await controller.listConnections(httpRequest(), response);

    expect(
      workspaceStore.countProjectsSelectingConnections,
    ).toHaveBeenCalledWith(userId, [gemini.id]);
    expect(response.body.connections[0].projectUseCount).toBe(3);
  });

  it("rejects a connection past the per-user limit", async function () {
    const { store } = storeFixture();
    for (let index = 0; index < AI_REVIEWER_CONNECTION_LIMIT; index += 1) {
      await store.create(userId, {
        ...localConnection,
        label: `Endpoint ${index}`,
      });
    }

    expect(
      await captureError(store.create(userId, localConnection)),
    ).toBeInstanceOf(AiReviewerConnectionLimitError);
    expect(await store.list(userId)).toHaveLength(AI_REVIEWER_CONNECTION_LIMIT);

    const controller = createAiReviewerProviderController({
      configStore: store,
      providerService: {},
    });
    const response = new FakeResponse();
    await controller.createConnection(
      httpRequest({ body: localConnection }),
      response,
    );
    expect(response.statusCode).toBe(409);
    expect(response.body.error.code).toBe(
      "AI_PROVIDER_CONNECTION_LIMIT_REACHED",
    );
  });

  it("removes the encrypted credential together with its connection", async function () {
    const { records, store } = storeFixture();
    const gemini = await store.create(userId, geminiConnection);
    await store.create(userId, claudeConnection);
    const geminiEnvelope = records
      .get(userId)
      .connections.find(({ _id }) => _id === gemini.id).credentialEncrypted;

    await store.remove(userId, gemini.id, gemini.revision);

    expect(JSON.stringify(records.get(userId))).not.toContain(geminiEnvelope);
    expect(JSON.stringify(records.get(userId))).not.toContain(geminiCredential);
  });

  it("refuses to delete a connection that changed after the confirmation view loaded", async function () {
    const { store } = storeFixture();
    const created = await store.create(userId, localConnection);
    const updated = await store.update(
      userId,
      created.id,
      { ...localConnection, label: "Updated elsewhere" },
      created.revision,
    );

    const error = await captureError(
      store.remove(userId, created.id, created.revision),
    );
    expect(error).toBeInstanceOf(AiReviewerConnectionConflictError);
    expect(await store.list(userId)).toEqual([updated]);

    const controller = createAiReviewerProviderController({
      configStore: store,
      providerService: {},
    });
    const response = new FakeResponse();
    await controller.deleteConnection(
      httpRequest({
        body: { expectedRevision: created.revision },
        params: { connection_id: created.id },
      }),
      response,
    );
    expect(response.statusCode).toBe(409);
    expect(response.body.error).toEqual({
      code: "AI_PROVIDER_CONNECTION_CONFLICT",
      category: "configuration",
      message:
        "The AI provider connection changed elsewhere. Your change was not applied. Reload the settings and try again.",
      retryable: false,
    });
    expect(await store.list(userId)).toEqual([updated]);
  });

  it("reports an existing HTTP credential as set while its transport use is blocked", function () {
    const connection = publicAiReviewerProviderConnection({
      id: "connection-1",
      revision: 7,
      credentialSet: true,
      ...localConnection,
      contextLengthOverride: 16_384,
      credentialUpdatedAt,
    });

    expect(connection).toEqual({
      id: "connection-1",
      revision: 7,
      label: "127.0.0.1:11434",
      classification: "local",
      config: {
        provider: "openai-compatible",
        baseUrl: localBaseUrl,
        contextLengthOverride: 16_384,
        credentialSet: true,
        credentialUpdatedAt,
      },
    });
    expect(() =>
      assertOpenAiCompatibleCredentialTransport(
        connection.config.baseUrl,
        connection.config.credentialSet,
      ),
    ).toThrowError("The API key was not sent because the endpoint uses HTTP");
  });

  it("keeps the removed default connection out of the module", async function () {
    const sources = [
      "../../../app/models/AiReviewerProviderConfig.mjs",
      "../../../app/src/AiReviewerProviderConfig.mjs",
      "../../../app/src/AiReviewerProviderConfigStore.mjs",
      "../../../app/src/AiReviewerProviderController.mjs",
      "../../../app/src/AiReviewerRouter.mjs",
      "../../../app/src/ConfiguredAiReviewerController.mjs",
      "../../../app/src/ConfiguredAiReviewerRouter.mjs",
      "../../../shared/contracts.mjs",
    ];

    for (const source of sources) {
      const text = await readFile(new URL(source, import.meta.url), "utf8");
      for (const removed of [
        "defaultConnectionId",
        "isDefault",
        "setDefault(",
        "setDefaultConnection",
        "/default",
      ]) {
        expect(text, source).not.toContain(removed);
      }
    }
  });
});

describe("AI reviewer unified model list", function () {
  function modelListFixture({
    listModels,
    circuitBreakerStore,
    externalHarnessEnabled,
  } = {}) {
    const { records, store } = storeFixture();
    const providerService = {
      listModels:
        listModels ?? vi.fn(async (connection) => connectionModels(connection)),
      contextLengthForModelList: vi.fn(() => ({
        contextLength,
        contextLengthSource: "detected",
      })),
      resolveContextLength: vi.fn(async () => ({
        contextLength,
        contextLengthSource: "detected",
      })),
    };
    return {
      records,
      store,
      providerService,
      controller: createAiReviewerProviderController({
        configStore: store,
        providerService,
        circuitBreakerStore,
        externalHarnessEnabled,
      }),
    };
  }

  it("returns every connection's models with the connection each came from", async function () {
    const { controller, providerService, store } = modelListFixture();
    const gemini = await store.create(userId, geminiConnection);
    const local = await store.create(userId, {
      ...localConnection,
      label: "Lab GPU box",
    });
    const response = new FakeResponse();

    await controller.listModels(httpRequest(), response);

    expect(response.body).toEqual({
      models: [
        {
          id: geminiModel,
          displayName: "Gemini 2.5 Pro",
          connectionId: gemini.id,
          connectionLabel: "Google Gemini",
          contextLength,
          contextLengthSource: "detected",
        },
        {
          id: sharedModel,
          displayName: sharedModel,
          connectionId: gemini.id,
          connectionLabel: "Google Gemini",
          contextLength,
          contextLengthSource: "detected",
        },
        {
          id: localModel,
          displayName: localModel,
          connectionId: local.id,
          connectionLabel: "Lab GPU box",
          contextLength,
          contextLengthSource: "detected",
        },
        {
          // The same model id reachable through two connections stays two
          // entries, told apart by the connection label beside them.
          id: sharedModel,
          displayName: sharedModel,
          connectionId: local.id,
          connectionLabel: "Lab GPU box",
          contextLength,
          contextLengthSource: "detected",
        },
      ],
      failures: [],
    });
    expect(JSON.stringify(response.body)).not.toContain(geminiCredential);
    expect(providerService.listModels).toHaveBeenCalledTimes(2);
  });

  it("lists only configured models without provider access for the external harness", async function () {
    const circuitBreakerStore = { assertRequestAllowed: vi.fn() };
    const { controller, providerService, store } = modelListFixture({
      circuitBreakerStore,
      externalHarnessEnabled: true,
    });
    const local = await store.create(userId, {
      ...localConnection,
      models: [localModel, sharedModel],
      contextLengthOverride: contextLength,
    });
    const response = new FakeResponse();

    await controller.listModels(httpRequest(), response);

    expect(response.body).toEqual({
      models: [localModel, sharedModel].map((id) => ({
        id,
        displayName: id,
        connectionId: local.id,
        connectionLabel: "127.0.0.1:11434",
        contextLength,
        contextLengthSource: "override",
      })),
      failures: [],
    });
    expect(circuitBreakerStore.assertRequestAllowed).not.toHaveBeenCalled();
    expect(providerService.listModels).not.toHaveBeenCalled();
    expect(providerService.contextLengthForModelList).not.toHaveBeenCalled();
    expect(providerService.resolveContextLength).not.toHaveBeenCalled();
  });

  it("discovers only external connections without fallback models", async function () {
    const { controller, providerService, store } = modelListFixture({
      externalHarnessEnabled: true,
    });
    const configured = await store.create(userId, {
      ...localConnection,
      models: [localModel],
      contextLengthOverride: contextLength,
    });
    const discovered = await store.create(userId, {
      ...localConnection,
      baseUrl: "https://api.example.com/v1",
      models: [],
    });
    await store.create(userId, geminiConnection);
    await store.create(userId, {
      ...localConnection,
      baseUrl: "https://versioned.example.com/v1",
      apiVersion: openAiCompatibleApiVersion,
      models: ["versioned-model"],
    });
    const response = new FakeResponse();

    await controller.listModels(httpRequest(), response);

    expect(response.body.models).toEqual([
      {
        id: localModel,
        displayName: localModel,
        connectionId: configured.id,
        connectionLabel: "127.0.0.1:11434",
        contextLength,
        contextLengthSource: "override",
      },
      ...[localModel, sharedModel].map((id) => ({
        id,
        displayName: id,
        connectionId: discovered.id,
        connectionLabel: "api.example.com",
        contextLength,
        contextLengthSource: "detected",
      })),
    ]);
    expect(response.body.failures).toEqual([]);
    expect(providerService.listModels).toHaveBeenCalledOnce();
    expect(providerService.listModels.mock.calls[0][0].id).toBe(discovered.id);
  });

  it("keeps a reachable connection's models when another connection fails", async function () {
    const rawProviderBody = "RAW_PROVIDER_FAILURE_BODY";
    const { controller, store } = modelListFixture({
      listModels: vi.fn(async (connection) => {
        if (connection.provider === "gemini") {
          throw new AgentGatewayError(rawProviderBody, {
            code: rawProviderBody,
            category: "authentication",
            retryable: false,
          });
        }
        return connectionModels(connection);
      }),
    });
    const gemini = await store.create(userId, geminiConnection);
    const local = await store.create(userId, localConnection);
    const response = new FakeResponse();

    await controller.listModels(httpRequest(), response);

    expect(response.statusCode).toBe(200);
    expect(
      response.body.models.map(({ connectionId }) => connectionId),
    ).toEqual([local.id, local.id]);
    expect(response.body.failures).toEqual([
      {
        connectionId: gemini.id,
        connectionLabel: "Google Gemini",
        code: "AI_PROVIDER_AUTHENTICATION_ERROR",
        category: "authentication",
      },
    ]);
    expect(JSON.stringify(response.body)).not.toContain(rawProviderBody);
  });

  it("uses connection-owned model names only when discovery is unsupported", async function () {
    const manualModel = "reviewer/manual-v1";
    const { controller, providerService, store } = modelListFixture({
      listModels: vi.fn(async () => {
        throw new AgentGatewayError("Unsupported model listing.", {
          code: "AI_PROVIDER_MODEL_DISCOVERY_UNSUPPORTED",
          category: "configuration",
          retryable: false,
        });
      }),
    });
    const local = await store.create(userId, {
      ...localConnection,
      models: [manualModel],
    });
    const response = new FakeResponse();

    await controller.listModels(httpRequest(), response);

    expect(response.body).toEqual({
      models: [
        {
          id: manualModel,
          displayName: manualModel,
          connectionId: local.id,
          connectionLabel: "127.0.0.1:11434",
          contextLength,
          contextLengthSource: "detected",
        },
      ],
      failures: [],
    });
    expect(providerService.listModels).toHaveBeenCalledOnce();
  });

  it("reports one unreadable credential without hiding other model lists", async function () {
    const { controller, records, store } = modelListFixture();
    const gemini = await store.create(userId, geminiConnection);
    const local = await store.create(userId, localConnection);
    records
      .get(userId)
      .connections.find(({ _id }) => _id === gemini.id).credentialEncrypted =
      "unreadable-ciphertext";
    const response = new FakeResponse();

    await controller.listModels(httpRequest(), response);

    expect(
      response.body.models.map(({ connectionId }) => connectionId),
    ).toEqual([local.id, local.id]);
    expect(response.body.failures).toEqual([
      {
        connectionId: gemini.id,
        connectionLabel: "Google Gemini",
        code: "AI_PROVIDER_CONFIGURATION_PERSISTENCE_FAILED",
        category: "configuration",
      },
    ]);
  });

  it("reports an unconfigured provider when the user has no connection", async function () {
    const { controller, providerService } = modelListFixture();
    const response = new FakeResponse();

    await controller.listModels(httpRequest(), response);

    expect(response.statusCode).toBe(409);
    expect(response.body.error.code).toBe("AI_PROVIDER_NOT_CONFIGURED");
    expect(providerService.listModels).not.toHaveBeenCalled();
  });

  it("checks one connection by asking it what it can run", async function () {
    const { store } = storeFixture();
    const gemini = await store.create(userId, geminiConnection);
    await store.create(userId, localConnection);
    const providerService = {
      listModels: vi.fn(async (connection) => connectionModels(connection)),
      testConnection: vi.fn(async () => ({
        ok: true,
        provider: "gemini",
        modelCount: 2,
        classification: "remote",
      })),
    };
    const controller = createAiReviewerProviderController({
      configStore: store,
      providerService,
    });

    const response = new FakeResponse();
    await controller.testConnection(
      httpRequest({ body: { connectionId: gemini.id } }),
      response,
    );
    expect(response.body).toEqual({
      ok: true,
      provider: "gemini",
      modelCount: 2,
      classification: "remote",
    });
    expect(providerService.testConnection).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: gemini.id, provider: "gemini" }),
      {
        signal: expect.any(AbortSignal),
        cacheKey: `${userId}\u0000${gemini.id}`,
      },
    );

    // Naming no connection cannot mean "any of them".
    const ambiguous = new FakeResponse();
    await controller.testConnection(httpRequest(), ambiguous);
    expect(ambiguous.statusCode).toBe(400);
    expect(ambiguous.body.error.code).toBe(
      "AI_PROVIDER_CONNECTION_NOT_SELECTED",
    );
  });
});

describe("AI reviewer run destination", function () {
  it("asks for a model instead of choosing the sole connection", async function () {
    const { store } = storeFixture();
    await store.create(userId, claudeConnection);
    const { controller, providerService } = streamFixture({ store });

    const response = new FakeResponse();
    await controller.stream(
      httpRequest({ body: selectionRequest() }),
      response,
    );

    expect(parseNdjson(response)[0]).toMatchObject({
      type: "error",
      error: {
        code: "AI_PROVIDER_MODEL_NOT_SELECTED",
        category: "configuration",
      },
    });
    expect(providerService.createAgentGateway).not.toHaveBeenCalled();
  });

  it("asks for a model instead of choosing between connections", async function () {
    const { store } = storeFixture();
    await store.create(userId, geminiConnection);
    await store.create(userId, claudeConnection);
    const { controller, providerService } = streamFixture({ store });

    const response = new FakeResponse();
    await controller.stream(
      httpRequest({ body: selectionRequest() }),
      response,
    );

    expect(parseNdjson(response)[0]).toMatchObject({
      type: "error",
      error: {
        code: "AI_PROVIDER_MODEL_NOT_SELECTED",
        category: "configuration",
        message: "Select an AI model for this review, then run it again.",
        retryable: false,
      },
    });
    expect(providerService.createAgentGateway).not.toHaveBeenCalled();
    // The store refuses to answer the same question, rather than leaving the
    // choice to whichever caller asked first.
    expect(await captureError(store.get(userId))).toBeInstanceOf(
      AiReviewerConnectionAmbiguousError,
    );
  });

  it("asks for a model when the sole connection offers more than one", async function () {
    const { store } = storeFixture();
    const gemini = await store.create(userId, geminiConnection);
    const { controller, providerService } = streamFixture({ store });

    const response = new FakeResponse();
    await controller.stream(
      httpRequest({
        body: selectionRequest({ connectionId: gemini.id }),
      }),
      response,
    );

    expect(parseNdjson(response)[0]).toMatchObject({
      type: "error",
      error: { code: "AI_PROVIDER_MODEL_NOT_SELECTED" },
    });
    expect(providerService.createAgentGateway).not.toHaveBeenCalled();
  });

  it("reports a deleted selected connection without falling back", async function () {
    const { store } = storeFixture();
    const deleted = await store.create(userId, geminiConnection);
    await store.create(userId, claudeConnection);
    await store.remove(userId, deleted.id, deleted.revision);
    const { controller, providerService } = streamFixture({ store });

    const response = new FakeResponse();
    await controller.stream(
      httpRequest({
        body: selectionRequest({
          connectionId: deleted.id,
          model: geminiModel,
        }),
      }),
      response,
    );

    expect(parseNdjson(response)[0]).toMatchObject({
      type: "error",
      error: {
        code: "AI_PROVIDER_CONNECTION_NOT_FOUND",
        category: "configuration",
        message:
          "The selected AI provider connection could not be found. Choose a model again.",
      },
    });
    expect(providerService.createAgentGateway).not.toHaveBeenCalled();
  });

  it("refuses another user's connection identifier", async function () {
    const { store } = storeFixture();
    const mine = await store.create(userId, geminiConnection);
    const theirs = await store.create(otherUserId, claudeConnection);
    const { controller, providerService } = streamFixture({ store });

    const response = new FakeResponse();
    await controller.stream(
      httpRequest({
        body: selectionRequest({
          connectionId: theirs.id,
          model: claudeModel,
        }),
      }),
      response,
    );

    expect(parseNdjson(response)[0]).toMatchObject({
      type: "error",
      error: {
        code: "AI_PROVIDER_CONNECTION_NOT_FOUND",
        category: "configuration",
      },
    });
    expect(providerService.createAgentGateway).not.toHaveBeenCalled();
    expect(response.chunks.join("")).not.toContain(claudeCredential);

    const mineResponse = new FakeResponse();
    await controller.stream(
      httpRequest({
        body: selectionRequest({ connectionId: mine.id, model: geminiModel }),
      }),
      mineResponse,
    );
    expect(parseNdjson(mineResponse)).toEqual(streamEvents());
  });

  it("loads each user's project perspective without mixing collaborators", async function () {
    const { store } = storeFixture();
    const mine = await store.create(userId, geminiConnection);
    const theirs = await store.create(otherUserId, geminiConnection);
    const modeInstructionStore = {
      load: vi.fn(async (scopedUserId) => ({
        revision: 1,
        instructions: {
          brainstorm:
            scopedUserId === userId
              ? "MY_PRIVATE_PROJECT_PERSPECTIVE"
              : "OTHER_PRIVATE_PROJECT_PERSPECTIVE",
        },
      })),
    };
    const { controller, providerService } = streamFixture({
      store,
      modeInstructionStore,
    });

    await controller.stream(
      httpRequest({
        authenticatedUserId: userId,
        body: selectionRequest({ connectionId: mine.id, model: geminiModel }),
      }),
      new FakeResponse(),
    );
    await controller.stream(
      httpRequest({
        authenticatedUserId: otherUserId,
        body: selectionRequest({
          connectionId: theirs.id,
          model: geminiModel,
        }),
      }),
      new FakeResponse(),
    );

    expect(modeInstructionStore.load.mock.calls).toEqual([
      [userId, projectId],
      [otherUserId, projectId],
    ]);
    expect(
      providerService.createAgentGateway.mock.calls[0][1].modeInstructions,
    ).toEqual({ brainstorm: "MY_PRIVATE_PROJECT_PERSPECTIVE" });
    expect(
      providerService.createAgentGateway.mock.calls[1][1].modeInstructions,
    ).toEqual({ brainstorm: "OTHER_PRIVATE_PROJECT_PERSPECTIVE" });
    expect(
      JSON.stringify(providerService.createAgentGateway.mock.calls[0]),
    ).not.toContain("OTHER_PRIVATE_PROJECT_PERSPECTIVE");
  });

  it("refuses a model the selected connection does not list", async function () {
    const { store } = storeFixture();
    const gemini = await store.create(userId, geminiConnection);
    const claude = await store.create(userId, claudeConnection);
    const { controller, providerService } = streamFixture({ store });

    const response = new FakeResponse();
    await controller.stream(
      httpRequest({
        body: selectionRequest({ connectionId: claude.id, model: geminiModel }),
      }),
      response,
    );

    // The model exists for the Gemini connection, but not for the selected one.
    expect(parseNdjson(response)[0]).toMatchObject({
      type: "error",
      error: { code: "AI_PROVIDER_NOT_CONFIGURED", category: "configuration" },
    });
    expect(providerService.createAgentGateway).not.toHaveBeenCalled();

    const accepted = new FakeResponse();
    await controller.stream(
      httpRequest({
        body: selectionRequest({ connectionId: gemini.id, model: geminiModel }),
      }),
      accepted,
    );
    expect(parseNdjson(accepted)).toEqual(streamEvents());
  });

  it("resolves the context length from the connection and the selected model", async function () {
    const { store } = storeFixture();
    const gemini = await store.create(userId, {
      ...geminiConnection,
      contextLengthOverride: 12_345,
    });
    const { controller, providerService, requestScopeReader } = streamFixture({
      store,
    });
    providerService.resolveContextLength.mockResolvedValue({
      contextLength: 12_345,
      contextLengthSource: "override",
    });

    const response = new FakeResponse();
    await controller.stream(
      httpRequest({
        body: selectionRequest({ connectionId: gemini.id, model: sharedModel }),
      }),
      response,
    );

    expect(
      providerService.resolveContextLength,
    ).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        id: gemini.id,
        provider: "gemini",
        contextLengthOverride: 12_345,
      }),
      sharedModel,
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        cacheKey: `${userId}\u0000${gemini.id}`,
      }),
    );
    expect(requestScopeReader.read).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ contextLength: 12_345 }),
    );
    expect(providerService.createAgentGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        model: sharedModel,
        contextLength: 12_345,
        contextLengthSource: "override",
      }),
      expect.anything(),
    );
  });

  it("passes an OpenAI-compatible API version from the selected connection into the run", async function () {
    const { store } = storeFixture();
    const connection = await store.create(userId, {
      ...localConnection,
      apiVersion: openAiCompatibleApiVersion,
    });
    const { controller, providerService } = streamFixture({ store });

    const response = new FakeResponse();
    await controller.stream(
      httpRequest({
        body: selectionRequest({
          connectionId: connection.id,
          model: localModel,
        }),
      }),
      response,
    );

    expect(providerService.createAgentGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai-compatible",
        baseUrl: localBaseUrl,
        apiVersion: openAiCompatibleApiVersion,
        model: localModel,
      }),
      expect.anything(),
    );
  });
});

describe("AI reviewer connection deletion lifecycle", function () {
  beforeEach(function () {
    vi.resetModules();
  });

  it("removes every connection and credential when the user is deleted", async function () {
    const { records, store } = storeFixture();
    await store.create(userId, geminiConnection);
    await store.create(userId, claudeConnection);
    await store.create(otherUserId, localConnection);
    vi.doMock("../../../app/src/AiReviewerWorkspaceStore.mjs", () => ({
      createAiReviewerWorkspaceStore: vi.fn(() => ({ deleteUser: vi.fn() })),
    }));
    vi.doMock("../../../app/src/AiReviewerSkillStore.mjs", () => ({
      createAiReviewerSkillStore: vi.fn(() => ({ deleteUser: vi.fn() })),
    }));
    vi.doMock("../../../app/src/AiReviewerModeInstructionStore.mjs", () => ({
      createAiReviewerModeInstructionStore: vi.fn(() => ({
        deleteUser: vi.fn(),
      })),
    }));
    vi.doMock("../../../app/src/AiReviewerProviderConfigStore.mjs", () => ({
      createAiReviewerProviderConfigStore: vi.fn(() => store),
    }));

    // Cleanup is registered outside the feature flag, so it reaches the store
    // through the module hooks rather than through a request path.
    const { default: hooks } =
      await import("../../../app/src/AiReviewerCleanupHooks.mjs");
    await hooks.promises.deleteUser(userId);

    expect(records.has(userId)).toBe(false);
    expect(JSON.stringify([...records.values()])).not.toContain(
      geminiCredential,
    );
    expect(await store.list(userId)).toEqual([]);
    expect(await store.list(otherUserId)).toHaveLength(1);
  });

  it("rewrites a legacy connection that still carries a model", async function () {
    // The in-memory model used elsewhere in this file does not enforce
    // `strict: "throw"`, so a stored `model` survived every unit test and only
    // failed against the real schema, on the first write after the upgrade.
    const { AiReviewerProviderConfigSchema } =
      await import("../../../app/models/AiReviewerProviderConfig.mjs");
    const legacy = {
      _id: "6a6578790109d23a0cf7ca00",
      connections: [
        {
          _id: "6a6578790109d23a0cf7ca00",
          provider: "gemini",
          model: "gemini-3.5-flash-lite",
          contextLength: 1_048_576,
          contextLengthSource: "derived",
        },
      ],
    };

    const { records, store } = storeFixture();
    records.set(legacy._id, legacy);

    await store.create(legacy._id, {
      provider: "openai-compatible",
      baseUrl: "http://127.0.0.1:11434/v1",
    });

    for (const connection of records.get(legacy._id).connections) {
      expect(Object.hasOwn(connection, "model")).toBe(false);
      expect(Object.hasOwn(connection, "contextLength")).toBe(false);
      // The real schema rejects any path it no longer declares, which is what
      // the running server hit. Cast with a schema-shaped id so the check is
      // about the removed fields, not the fixture's synthetic identifier.
      expect(() =>
        AiReviewerProviderConfigSchema.path("connections").cast([
          { ...connection, _id: "6a6578790109d23a0cf7ca11" },
        ]),
      ).not.toThrow();
    }
  });
});
