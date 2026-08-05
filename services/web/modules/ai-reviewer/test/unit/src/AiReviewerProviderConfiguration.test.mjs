import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { AgentGatewayError } from "../../../app/src/AgentGateway.mjs";
import {
  parseAiReviewerProviderConfig,
  parseAiReviewerProviderConfigUpdate,
  publicAiReviewerProviderConfig,
} from "../../../app/src/AiReviewerProviderConfig.mjs";
import { createAiReviewerProviderConfigStore } from "../../../app/src/AiReviewerProviderConfigStore.mjs";
import { createAiReviewerProviderCredentialManager } from "../../../app/src/AiReviewerProviderCredentialManager.mjs";
import { createAiReviewerProviderController } from "../../../app/src/AiReviewerProviderController.mjs";
import { createConfiguredAiReviewerController } from "../../../app/src/ConfiguredAiReviewerController.mjs";
import { createOllamaProviderService } from "../../../app/src/OllamaProviderService.mjs";
import { createRequestScopeReader } from "../../../app/src/RequestScopeReader.mjs";
import {
  AgentEventSchema,
  DiscussionEventSchema,
} from "../../../shared/contracts.mjs";

const userId = "user-provider-0001";
const otherUserId = "user-provider-0002";
const projectId = "project-provider-0001";
const baseUrl = "http://127.0.0.1:11434/v1";
const otherBaseUrl = "http://localhost:11434/v1";
const remoteBaseUrl = "https://api.example.com/openai/v1";
const model = "overleaf-ai-reviewer-compat-8k:latest";
const otherModel = "overleaf-ai-reviewer-other:latest";
const remoteModel = "hosted/reviewer-v1";
const contextLength = 8_192;
const otherContextLength = 4_096;
const createdAt = "2026-07-25T00:00:00.000Z";
const credentialUpdatedAt = "2026-07-25T00:01:00.000Z";
const credential = "PRIVATE_PROVIDER_CREDENTIAL";

const configuration = Object.freeze({
  provider: "openai-compatible",
  baseUrl,
  model,
  contextLength,
});
const otherConfiguration = Object.freeze({
  provider: "openai-compatible",
  baseUrl: otherBaseUrl,
  model: otherModel,
  contextLength: otherContextLength,
});
const credentialConfiguration = Object.freeze({
  provider: "openai-compatible",
  baseUrl: remoteBaseUrl,
  model: remoteModel,
  contextLength,
  credential,
  credentialUpdatedAt,
});
const credentialUpdate = Object.freeze({
  provider: credentialConfiguration.provider,
  baseUrl: credentialConfiguration.baseUrl,
  model: credentialConfiguration.model,
  contextLength: credentialConfiguration.contextLength,
  credential,
});
const publicConfiguration = Object.freeze({
  ...configuration,
  credentialSet: false,
  credentialUpdatedAt: null,
});
const publicCredentialConfiguration = Object.freeze({
  provider: credentialConfiguration.provider,
  baseUrl: credentialConfiguration.baseUrl,
  model: credentialConfiguration.model,
  contextLength: credentialConfiguration.contextLength,
  credentialSet: true,
  credentialUpdatedAt,
});
const compatibilityResult = Object.freeze({
  type: "completed",
  text: "COMPAT_OK",
  toolCalls: Object.freeze([]),
  finishReason: "stop",
  usage: Object.freeze({ inputTokens: 12, outputTokens: 3 }),
});

function selectionRequest() {
  return {
    requestId: "request-provider-0001",
    projectId,
    action: "review",
    instruction: "Review this synthetic selection.",
    skill: "referee-review",
    scope: {
      kind: "selection",
      documentId: "document-provider-0001",
      path: "main.tex",
      baseRevision: 9,
      baseTextHash: "a".repeat(64),
      range: { from: 5, to: 14 },
      text: "Synthetic",
    },
  };
}

function projectRequest() {
  return {
    requestId: "request-provider-0001",
    projectId,
    action: "review",
    instruction: "Review this synthetic project.",
    skill: "referee-review",
    scope: { kind: "project" },
  };
}

function streamEvents() {
  return [
    {
      type: "started",
      eventId: "event-provider-started",
      requestId: "request-provider-0001",
      sequence: 0,
      createdAt,
      provider: "openai-compatible",
      model: otherModel,
      skill: "referee-review",
    },
    {
      type: "text.delta",
      eventId: "event-provider-delta",
      requestId: "request-provider-0001",
      sequence: 1,
      createdAt,
      delta: "Configured synthetic review.",
    },
    {
      type: "completed",
      eventId: "event-provider-completed",
      requestId: "request-provider-0001",
      sequence: 2,
      createdAt,
      finishReason: "stop",
    },
  ];
}

function discussionRequest() {
  return {
    requestId: "discussion-turn-provider-0001",
    discussionId: "discussion-provider-0001",
    projectId,
    subject: {
      kind: "scope",
      sourceRequest: selectionRequest(),
    },
    turns: [{ role: "user", text: "Explain this selection." }],
  };
}

function discussionEvents() {
  return [
    {
      type: "started",
      eventId: "discussion-event-provider-started",
      requestId: "discussion-turn-provider-0001",
      sequence: 0,
      createdAt,
      provider: "openai-compatible",
      model: otherModel,
    },
    {
      type: "text.delta",
      eventId: "discussion-event-provider-delta",
      requestId: "discussion-turn-provider-0001",
      sequence: 1,
      createdAt,
      delta: "Configured synthetic discussion.",
    },
    {
      type: "completed",
      eventId: "discussion-event-provider-completed",
      requestId: "discussion-turn-provider-0001",
      sequence: 2,
      createdAt,
      finishReason: "stop",
    },
  ];
}

function httpRequest({
  body,
  authenticatedUserId = userId,
  routedProjectId = projectId,
} = {}) {
  const request = new EventEmitter();
  request.body = body;
  request.params = { project_id: routedProjectId };
  request.user = {
    _id: {
      toString: () => authenticatedUserId,
    },
  };
  return request;
}

class FakeResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 200;
    this.body = undefined;
    this.headers = new Map();
    this.chunks = [];
    this.destroyed = false;
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

function fakeQuery(value) {
  return fakeExecutingQuery(async () => value);
}

function fakeExecutingQuery(work) {
  const query = {
    exec: vi.fn(work),
  };
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
  const hooks = {
    beforeFindOneAndUpdate: undefined,
  };
  const modelDependency = {
    findOne: vi.fn(({ _id }) =>
      fakeQuery(records.has(_id) ? { _id, ...records.get(_id) } : null),
    ),
    findOneAndUpdate: vi.fn((filter, update, options = {}) =>
      fakeExecutingQuery(async () => {
        await hooks.beforeFindOneAndUpdate?.({ filter, update, options });
        const { _id } = filter;
        const current = records.get(_id);
        if (!matchesRevision(current, filter)) {
          if (!options.upsert) {
            return null;
          }
          if (current != null) {
            const error = new Error("duplicate provider configuration key");
            error.code = 11000;
            throw error;
          }
        }
        const next = { ...current, ...update.$set };
        for (const [key, increment] of Object.entries(update.$inc ?? {})) {
          next[key] = (current?.[key] ?? 0) + increment;
        }
        for (const key of Object.keys(update.$unset ?? {})) {
          delete next[key];
        }
        records.set(_id, Object.freeze(next));
        return { _id, ...records.get(_id) };
      }),
    ),
  };
  return { hooks, modelDependency, records };
}

function credentialManagerFixture() {
  const encryptedValues = new Map();
  let sequence = 0;
  const encryptor = {
    encryptJson: vi.fn(async (value) => {
      sequence += 1;
      const encrypted = `ciphertext-${sequence}`;
      encryptedValues.set(encrypted, structuredClone(value));
      return encrypted;
    }),
    decryptToJson: vi.fn(async (encrypted) => {
      if (!encryptedValues.has(encrypted)) {
        throw new Error("Unknown ciphertext.");
      }
      return structuredClone(encryptedValues.get(encrypted));
    }),
  };
  return {
    encryptedValues,
    encryptor,
    manager: createAiReviewerProviderCredentialManager({ encryptor }),
  };
}

function parseNdjson(response) {
  return response.chunks
    .join("")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => AgentEventSchema.parse(JSON.parse(line)));
}

function parseDiscussionNdjson(response) {
  return response.chunks
    .join("")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => DiscussionEventSchema.parse(JSON.parse(line)));
}

async function captureError(work) {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject.");
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function providerControllerFixture({
  storedConfiguration = configuration,
  timeoutSignalFactory,
} = {}) {
  const store = {
    get: vi.fn(async () => storedConfiguration),
    save: vi.fn(async (_id, value) => value),
  };
  const providerService = {
    testConnection: vi.fn(async () => ({
      ok: true,
      provider: "openai-compatible",
      model,
      classification: "local",
    })),
  };
  return {
    store,
    providerService,
    controller: createAiReviewerProviderController({
      configStore: store,
      providerService,
      timeoutSignalFactory,
    }),
  };
}

describe("AI reviewer provider configuration", function () {
  it("accepts strict OpenAI-compatible configuration and returns an explicit bounded public DTO", function () {
    const parsed = parseAiReviewerProviderConfig(configuration);
    expect(parsed).toEqual(configuration);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(publicAiReviewerProviderConfig(parsed)).toEqual({
      configured: true,
      config: publicConfiguration,
      classification: "local",
    });
    expect(
      parseAiReviewerProviderConfig({
        ...configuration,
        provider: "ollama",
      }),
    ).toEqual(configuration);
    expect(publicAiReviewerProviderConfig(credentialConfiguration)).toEqual({
      configured: true,
      config: publicCredentialConfiguration,
      classification: "remote",
    });
    expect(
      JSON.stringify(publicAiReviewerProviderConfig(credentialConfiguration)),
    ).not.toContain(credential);

    for (const invalid of [
      null,
      {},
      { provider: "openai", baseUrl, model },
      { provider: "ollama", baseUrl, model },
      { ...configuration, baseUrl: "http://192.168.1.2:11434/v1" },
      { ...configuration, model: "model with spaces" },
      { ...configuration, contextLength: 0 },
      { ...configuration, contextLength: -1 },
      { ...configuration, contextLength: 1.5 },
      { ...configuration, contextLength: Number.MAX_SAFE_INTEGER + 1 },
      { ...configuration, enabled: true },
      { ...configuration, apiKey: "PRIVATE_SECRET" },
      { ...configuration, arbitraryUnknownField: true },
    ]) {
      expect(() => parseAiReviewerProviderConfig(invalid)).toThrow();
    }
    expect(() =>
      parseAiReviewerProviderConfigUpdate({
        ...configuration,
        credentialUpdatedAt,
      }),
    ).toThrow();
  });

  it("gets and saves each user's configuration only through its _id", async function () {
    const { modelDependency, records } = inMemoryModel();
    records.set(userId, configuration);
    records.set(otherUserId, otherConfiguration);
    const store = createAiReviewerProviderConfigStore({
      model: modelDependency,
    });

    expect(await store.get(userId)).toEqual(configuration);
    expect(await store.get(otherUserId)).toEqual(otherConfiguration);
    expect(await store.save(userId, configuration)).toEqual(configuration);
    expect(await store.save(otherUserId, otherConfiguration)).toEqual(
      otherConfiguration,
    );
    expect(
      modelDependency.findOne.mock.calls.map(([filter]) => filter),
    ).toEqual([
      { _id: userId },
      { _id: otherUserId },
      { _id: userId },
      { _id: otherUserId },
    ]);
    expect(
      modelDependency.findOneAndUpdate.mock.calls.map(([filter]) => filter._id),
    ).toEqual([userId, otherUserId]);
    expect(
      modelDependency.findOneAndUpdate.mock.calls.every(
        ([filter]) =>
          filter.$or[0].revision === 0 &&
          filter.$or[1].revision.$exists === false,
      ),
    ).toBe(true);
  });

  it("treats a legacy configuration without context length as unconfigured", async function () {
    const legacyRecord = { _id: userId, provider: "ollama", baseUrl, model };
    const replacementRecord = { _id: userId, ...configuration };
    const modelDependency = {
      findOne: vi.fn().mockReturnValue(fakeQuery(legacyRecord)),
      findOneAndUpdate: vi.fn().mockReturnValue(fakeQuery(replacementRecord)),
    };
    const store = createAiReviewerProviderConfigStore({
      model: modelDependency,
    });

    expect(await store.get(userId)).toBeNull();
    expect(await store.save(userId, configuration)).toEqual(configuration);
  });

  it("loads an existing credentialless Ollama record as the canonical local provider", async function () {
    const modelDependency = {
      findOne: vi.fn(() =>
        fakeQuery({
          _id: userId,
          ...configuration,
          provider: "ollama",
        }),
      ),
    };
    const store = createAiReviewerProviderConfigStore({
      model: modelDependency,
    });

    expect(await store.get(userId)).toEqual(configuration);
    expect(publicAiReviewerProviderConfig(await store.get(userId))).toEqual({
      configured: true,
      config: publicConfiguration,
      classification: "local",
    });
  });

  it("round-trips a destination-bound credential through the shared encrypted server seam", async function () {
    const { manager, encryptor } = credentialManagerFixture();
    const { modelDependency, records } = inMemoryModel();
    const store = createAiReviewerProviderConfigStore({
      model: modelDependency,
      credentialManager: manager,
      now: () => credentialUpdatedAt,
    });

    expect(await store.save(userId, credentialUpdate)).toEqual(
      credentialConfiguration,
    );
    expect(await store.get(userId)).toEqual(credentialConfiguration);
    expect(encryptor.encryptJson).toHaveBeenCalledExactlyOnceWith({
      provider: "openai-compatible",
      baseUrl: remoteBaseUrl,
      credential,
    });
    expect(records.get(userId)).toMatchObject({
      provider: "openai-compatible",
      baseUrl: remoteBaseUrl,
      model: remoteModel,
      contextLength,
      credentialEncrypted: "ciphertext-1",
      credentialUpdatedAt: new Date(credentialUpdatedAt),
    });
    expect(JSON.stringify(records.get(userId))).not.toContain(credential);
    expect(publicAiReviewerProviderConfig(await store.get(userId))).toEqual({
      configured: true,
      config: publicCredentialConfiguration,
      classification: "remote",
    });
  });

  it("preserves an omitted credential only for the same canonical destination", async function () {
    const later = "2026-07-25T00:02:00.000Z";
    const { manager } = credentialManagerFixture();
    const { modelDependency, records } = inMemoryModel();
    const times = [credentialUpdatedAt, later];
    const store = createAiReviewerProviderConfigStore({
      model: modelDependency,
      credentialManager: manager,
      now: () => times.shift(),
    });
    await store.save(userId, credentialUpdate);
    const encrypted = records.get(userId).credentialEncrypted;

    const sameDestination = {
      provider: "openai-compatible",
      baseUrl: remoteBaseUrl,
      model: "hosted/reviewer-v2",
      contextLength: otherContextLength,
    };
    expect(await store.save(userId, sameDestination)).toEqual({
      ...sameDestination,
      credential,
      credentialUpdatedAt,
    });
    expect(records.get(userId).credentialEncrypted).toBe(encrypted);
    expect(records.get(userId).credentialUpdatedAt).toEqual(
      new Date(credentialUpdatedAt),
    );

    const changedDestination = {
      ...sameDestination,
      baseUrl: "https://other.example.com/v1",
    };
    expect(await store.save(userId, changedDestination)).toEqual({
      ...changedDestination,
      credentialUpdatedAt: later,
    });
    expect(records.get(userId)).not.toHaveProperty("credentialEncrypted");
    expect(JSON.stringify(records.get(userId))).not.toContain(credential);
  });

  it("retries a stale credential-preserving save without breaking the destination binding", async function () {
    const replacementCredential = "PRIVATE_REPLACEMENT_CREDENTIAL";
    const replacementBaseUrl = "https://replacement.example.com/v1";
    const staleModel = "hosted/stale-writer-v1";
    const { manager } = credentialManagerFixture();
    const { hooks, modelDependency, records } = inMemoryModel();
    const store = createAiReviewerProviderConfigStore({
      model: modelDependency,
      credentialManager: manager,
      now: () => credentialUpdatedAt,
    });
    await store.save(userId, credentialUpdate);

    const staleWriterEntered = deferred();
    const releaseStaleWriter = deferred();
    let staleWriterBlocked = false;
    hooks.beforeFindOneAndUpdate = async ({ update }) => {
      if (
        !staleWriterBlocked &&
        update.$set.baseUrl === remoteBaseUrl &&
        update.$set.model === staleModel
      ) {
        staleWriterBlocked = true;
        staleWriterEntered.resolve();
        await releaseStaleWriter.promise;
      }
    };

    const staleConfiguration = {
      provider: "openai-compatible",
      baseUrl: remoteBaseUrl,
      model: staleModel,
      contextLength,
    };
    const staleSave = store.save(userId, staleConfiguration);
    await staleWriterEntered.promise;

    const replacement = {
      provider: "openai-compatible",
      baseUrl: replacementBaseUrl,
      model: remoteModel,
      contextLength,
      credential: replacementCredential,
    };
    expect(await store.save(userId, replacement)).toEqual({
      ...replacement,
      credentialUpdatedAt,
    });
    expect(await store.get(userId)).toEqual({
      ...replacement,
      credentialUpdatedAt,
    });

    releaseStaleWriter.resolve();
    const finalConfiguration = {
      ...staleConfiguration,
      credentialUpdatedAt,
    };
    expect(await staleSave).toEqual(finalConfiguration);
    expect(await store.get(userId)).toEqual(finalConfiguration);
    expect(records.get(userId)).toMatchObject({
      ...staleConfiguration,
      revision: 3,
      credentialUpdatedAt: new Date(credentialUpdatedAt),
    });
    expect(records.get(userId)).not.toHaveProperty("credentialEncrypted");

    const staleWrites = modelDependency.findOneAndUpdate.mock.calls.filter(
      ([, update]) => update.$set.model === staleModel,
    );
    expect(staleWrites).toHaveLength(2);
    expect(staleWrites[0][0]).toEqual({ _id: userId, revision: 1 });
    expect(staleWrites[0][1]).not.toHaveProperty("$unset");
    expect(staleWrites[1][0]).toEqual({ _id: userId, revision: 2 });
    expect(staleWrites[1][1].$unset).toEqual({ credentialEncrypted: "" });
  });

  it("retries a duplicate-key race when two saves observe no existing record", async function () {
    const firstWriterEntered = deferred();
    const releaseFirstWriter = deferred();
    const { hooks, modelDependency, records } = inMemoryModel();
    const store = createAiReviewerProviderConfigStore({
      model: modelDependency,
    });
    let firstWriterBlocked = false;
    hooks.beforeFindOneAndUpdate = async ({ update }) => {
      if (!firstWriterBlocked && update.$set.model === model) {
        firstWriterBlocked = true;
        firstWriterEntered.resolve();
        await releaseFirstWriter.promise;
      }
    };

    const firstSave = store.save(userId, configuration);
    await firstWriterEntered.promise;
    expect(await store.save(userId, otherConfiguration)).toEqual(
      otherConfiguration,
    );
    releaseFirstWriter.resolve();

    expect(await firstSave).toEqual(configuration);
    expect(await store.get(userId)).toEqual(configuration);
    expect(records.get(userId)).toMatchObject({
      ...configuration,
      revision: 2,
    });
    const firstWrites = modelDependency.findOneAndUpdate.mock.calls.filter(
      ([, update]) => update.$set.model === model,
    );
    expect(firstWrites).toHaveLength(2);
    expect(firstWrites[0][0].$or).toEqual([
      { revision: 0 },
      { revision: { $exists: false } },
    ]);
    expect(firstWrites[0][2].upsert).toBe(true);
    expect(firstWrites[1][0]).toEqual({ _id: userId, revision: 1 });
    expect(firstWrites[1][2].upsert).toBe(false);
  });

  it("clears an explicitly removed credential without returning its value", async function () {
    const clearedAt = "2026-07-25T00:03:00.000Z";
    const { manager } = credentialManagerFixture();
    const { modelDependency, records } = inMemoryModel();
    const times = [credentialUpdatedAt, clearedAt];
    const store = createAiReviewerProviderConfigStore({
      model: modelDependency,
      credentialManager: manager,
      now: () => times.shift(),
    });
    await store.save(userId, credentialUpdate);

    const cleared = await store.save(userId, {
      provider: credentialUpdate.provider,
      baseUrl: credentialUpdate.baseUrl,
      model: credentialUpdate.model,
      contextLength: credentialUpdate.contextLength,
      credential: null,
    });
    expect(cleared).toEqual({
      provider: credentialUpdate.provider,
      baseUrl: credentialUpdate.baseUrl,
      model: credentialUpdate.model,
      contextLength: credentialUpdate.contextLength,
      credentialUpdatedAt: clearedAt,
    });
    expect(records.get(userId)).not.toHaveProperty("credentialEncrypted");
    expect(JSON.stringify(cleared)).not.toContain(credential);
  });

  it("refuses a credential whose encrypted destination binding no longer matches", async function () {
    const { manager } = credentialManagerFixture();
    const { modelDependency, records } = inMemoryModel();
    const store = createAiReviewerProviderConfigStore({
      model: modelDependency,
      credentialManager: manager,
      now: () => credentialUpdatedAt,
    });
    await store.save(userId, credentialUpdate);
    records.set(userId, {
      ...records.get(userId),
      baseUrl: "https://other.example.com/v1",
    });

    const error = await captureError(store.get(userId));
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toBe("The AI provider credential could not be read.");
    expect(String(error)).not.toContain(credential);
  });

  it("bounds credential encryption and decryption failures without logging or echoing the value", async function () {
    const secret = "PRIVATE_CIPHER_FAILURE_SECRET";
    const consoleSpies = ["debug", "error", "info", "log", "warn"].map(
      (method) => vi.spyOn(console, method).mockImplementation(() => {}),
    );
    try {
      const encrypt = createAiReviewerProviderCredentialManager({
        encryptor: {
          encryptJson: vi.fn(async () => {
            throw new Error(secret);
          }),
          decryptToJson: vi.fn(),
        },
      });
      const decrypt = createAiReviewerProviderCredentialManager({
        encryptor: {
          encryptJson: vi.fn(),
          decryptToJson: vi.fn(async () => {
            throw new Error(secret);
          }),
        },
      });

      for (const work of [
        () =>
          encrypt.encrypt({
            provider: "openai-compatible",
            baseUrl: remoteBaseUrl,
            credential: secret,
          }),
        () =>
          decrypt.decrypt("ciphertext", {
            provider: "openai-compatible",
            baseUrl: remoteBaseUrl,
          }),
      ]) {
        const error = await captureError(work());
        expect(error.message).toBe(
          "The AI provider credential could not be read.",
        );
        expect(String(error)).not.toContain(secret);
        expect(error.stack).not.toContain(secret);
        expect(error).not.toHaveProperty("cause");
      }
      for (const spy of consoleSpies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of consoleSpies) {
        spy.mockRestore();
      }
    }
  });

  it("runs the exact COMPAT_OK check once, without accepting or retrying a near match", async function () {
    const generateChat = vi.fn(async () => compatibilityResult);
    const transportFactory = vi.fn(() => ({ generateChat }));
    const service = createOllamaProviderService({ transportFactory });

    expect(
      await service.testConnection(configuration, {
        signal: new AbortController().signal,
      }),
    ).toEqual({
      ok: true,
      provider: "openai-compatible",
      model,
      classification: "local",
    });
    expect(transportFactory).toHaveBeenCalledExactlyOnceWith({
      baseUrl,
      credential: undefined,
      modelTag: model,
    });
    expect(generateChat).toHaveBeenCalledExactlyOnceWith(
      {
        prompt: "Return exactly COMPAT_OK and nothing else.",
      },
      { signal: expect.any(AbortSignal) },
    );

    const nearMatch = vi
      .fn()
      .mockResolvedValueOnce({ ...compatibilityResult, text: "COMPAT_OK\n" })
      .mockResolvedValueOnce(compatibilityResult);
    const incompatibleService = createOllamaProviderService({
      transportFactory: () => ({ generateChat: nearMatch }),
    });
    expect(
      await captureError(
        incompatibleService.testConnection(configuration, {
          signal: new AbortController().signal,
        }),
      ),
    ).toBeInstanceOf(AgentGatewayError);
    expect(nearMatch).toHaveBeenCalledOnce();
  });

  it("passes the credential only into connection, discussion, and review transport construction", async function () {
    const transport = {
      generateChat: vi.fn(async () => compatibilityResult),
      createDiscussionGateway: vi.fn(() => ({ kind: "discussion" })),
      createAgentGateway: vi.fn(() => ({ kind: "review" })),
    };
    const transportFactory = vi.fn(() => transport);
    const service = createOllamaProviderService({ transportFactory });

    expect(await service.testConnection(credentialConfiguration)).toEqual({
      ok: true,
      provider: "openai-compatible",
      model: remoteModel,
      classification: "remote",
    });
    expect(service.createDiscussionGateway(credentialConfiguration)).toEqual({
      kind: "discussion",
    });
    expect(
      service.createAgentGateway(credentialConfiguration, {
        readProjectFile: vi.fn(),
      }),
    ).toEqual({ kind: "review" });
    expect(transportFactory).toHaveBeenCalledTimes(3);
    for (const [options] of transportFactory.mock.calls) {
      expect(options).toEqual({
        baseUrl: remoteBaseUrl,
        credential,
        modelTag: remoteModel,
      });
      expect(Object.keys(options)).toEqual([
        "baseUrl",
        "credential",
        "modelTag",
      ]);
    }
  });

  it("serves bounded GET and strict PUT configuration responses", async function () {
    const { controller, store } = providerControllerFixture({
      storedConfiguration: null,
    });
    store.get.mockResolvedValueOnce(null).mockResolvedValueOnce(configuration);

    const emptyResponse = new FakeResponse();
    await controller.getConfiguration(httpRequest(), emptyResponse);
    expect(emptyResponse.body).toEqual({
      configured: false,
      config: null,
      classification: null,
    });

    const configuredResponse = new FakeResponse();
    await controller.getConfiguration(httpRequest(), configuredResponse);
    expect(configuredResponse.body).toEqual({
      configured: true,
      config: publicConfiguration,
      classification: "local",
    });
    expect(JSON.stringify(configuredResponse.body)).not.toContain(userId);

    const saveResponse = new FakeResponse();
    await controller.saveConfiguration(
      httpRequest({ body: configuration }),
      saveResponse,
    );
    expect(store.save).toHaveBeenCalledExactlyOnceWith(userId, configuration);
    expect(saveResponse.body).toEqual({
      configured: true,
      config: publicConfiguration,
      classification: "local",
    });

    store.save.mockResolvedValueOnce(credentialConfiguration);
    const credentialResponse = new FakeResponse();
    await controller.saveConfiguration(
      httpRequest({ body: credentialUpdate }),
      credentialResponse,
    );
    expect(credentialResponse.body).toEqual({
      configured: true,
      config: publicCredentialConfiguration,
      classification: "remote",
    });
    expect(Object.keys(credentialResponse.body.config)).toEqual([
      "provider",
      "baseUrl",
      "model",
      "contextLength",
      "credentialSet",
      "credentialUpdatedAt",
    ]);
    expect(JSON.stringify(credentialResponse.body)).not.toContain(credential);

    const invalidResponse = new FakeResponse();
    await controller.saveConfiguration(
      httpRequest({ body: { ...configuration, apiKey: "PRIVATE_SECRET" } }),
      invalidResponse,
    );
    expect(invalidResponse.statusCode).toBe(400);
    expect(JSON.stringify(invalidResponse.body)).not.toContain(
      "PRIVATE_SECRET",
    );
    expect(store.save).toHaveBeenCalledTimes(2);
  });

  it("tests the saved provider and returns bounded configuration errors", async function () {
    const { controller, providerService, store } = providerControllerFixture();
    const response = new FakeResponse();
    await controller.testConnection(httpRequest(), response);
    expect(store.get).toHaveBeenCalledExactlyOnceWith(userId);
    expect(providerService.testConnection).toHaveBeenCalledExactlyOnceWith(
      configuration,
      { signal: expect.any(AbortSignal) },
    );
    expect(response.body).toEqual({
      ok: true,
      provider: "openai-compatible",
      model,
      classification: "local",
    });

    const missing = providerControllerFixture({
      storedConfiguration: null,
    });
    const missingResponse = new FakeResponse();
    await missing.controller.testConnection(httpRequest(), missingResponse);
    expect(missingResponse.statusCode).toBe(409);
    expect(missingResponse.body).toEqual({
      error: {
        code: "AI_PROVIDER_NOT_CONFIGURED",
        category: "configuration",
        message: "No AI provider is configured.",
        retryable: false,
      },
    });
    expect(missing.providerService.testConnection).not.toHaveBeenCalled();
  });

  it("redacts provider failures from the public connection-test response", async function () {
    const secret = "PRIVATE_PROVIDER_SECRET";
    const failed = providerControllerFixture();
    failed.providerService.testConnection.mockRejectedValue(
      new AgentGatewayError(secret, {
        code: secret,
        category: "provider",
        retryable: false,
      }),
    );
    const failedResponse = new FakeResponse();
    await failed.controller.testConnection(httpRequest(), failedResponse);
    expect(failedResponse.statusCode).toBe(502);
    expect(failedResponse.body).toEqual({
      error: {
        code: "AI_PROVIDER_ERROR",
        category: "provider",
        message: "The AI provider request failed.",
        retryable: true,
      },
    });
    expect(JSON.stringify(failedResponse.body)).not.toContain(secret);
  });

  it.each([
    {
      category: "authentication",
      code: "AI_PROVIDER_AUTHENTICATION_ERROR",
      message: "The AI provider rejected its credentials.",
      retryable: false,
    },
    {
      category: "network",
      code: "AI_PROVIDER_NETWORK_FAILED",
      message: "The AI provider could not be reached.",
      retryable: true,
    },
    {
      category: "rate-limit",
      code: "AI_PROVIDER_RATE_LIMITED",
      message: "The AI provider rate limit was reached.",
      retryable: true,
    },
    {
      category: "schema",
      code: "AI_PROVIDER_SCHEMA_INVALID",
      message: "The AI provider returned invalid data.",
      retryable: false,
    },
  ])(
    "reports a bounded $category connection failure category",
    async function ({ category, code, message, retryable }) {
      const secret = `PRIVATE_${category}_PROVIDER_TEXT`;
      const failed = providerControllerFixture();
      failed.providerService.testConnection.mockRejectedValue(
        new AgentGatewayError(secret, {
          code: secret,
          category,
          retryable: !retryable,
        }),
      );
      const response = new FakeResponse();

      await failed.controller.testConnection(httpRequest(), response);

      expect(response.statusCode).toBe(502);
      expect(response.body).toEqual({
        error: { code, category, message, retryable },
      });
      expect(JSON.stringify(response.body)).not.toContain(secret);
    },
  );

  it("uses the just-saved configuration for the next bounded selection stream", async function () {
    const { modelDependency, records } = inMemoryModel();
    const configStore = createAiReviewerProviderConfigStore({
      model: modelDependency,
    });
    const reads = [];
    const transport = {
      createAgentGateway: vi.fn(({ readProjectFile }) => ({
        async *stream(agentRequest, { signal }) {
          reads.push(
            await readProjectFile(
              { path: "main.tex", range: { from: 5, to: 14 } },
              { request: agentRequest, signal },
            ),
          );
          yield* streamEvents();
        },
      })),
    };
    const transportFactory = vi.fn(() => transport);
    const providerService = createOllamaProviderService({ transportFactory });
    const requestScopeReader = createRequestScopeReader();
    const boundedContext = await requestScopeReader.read(
      httpRequest({ body: selectionRequest() }),
      { contextLength },
    );
    expect(JSON.stringify(boundedContext)).not.toContain("Synthetic");
    expect(
      await captureError(
        boundedContext.readProjectFile(
          { path: "main.tex", range: { from: 5, to: 15 } },
          {
            request: selectionRequest(),
            signal: new AbortController().signal,
          },
        ),
      ),
    ).toBeInstanceOf(AgentGatewayError);
    const providerController = createAiReviewerProviderController({
      configStore,
      providerService,
    });
    const configuredController = createConfiguredAiReviewerController({
      configStore,
      providerService,
      requestScopeReader,
      now: () => createdAt,
      eventId: () => "event-provider-error",
    });

    await providerController.saveConfiguration(
      httpRequest({ body: otherConfiguration }),
      new FakeResponse(),
    );
    expect(records.get(userId)).toEqual({
      ...otherConfiguration,
      revision: 1,
    });

    const response = new FakeResponse();
    await configuredController.stream(
      httpRequest({ body: selectionRequest() }),
      response,
    );
    expect(transportFactory).toHaveBeenCalledExactlyOnceWith({
      baseUrl: otherBaseUrl,
      credential: undefined,
      modelTag: otherModel,
    });
    expect(transport.createAgentGateway).toHaveBeenCalledWith(
      expect.objectContaining({ contextLength: otherContextLength }),
    );
    expect(reads).toEqual([
      {
        path: "main.tex",
        range: { from: 5, to: 14 },
        text: "Synthetic",
      },
    ]);
    expect(parseNdjson(response)).toEqual(streamEvents());
  });

  it("uses the same saved transport configuration for a discussion without reading project scope", async function () {
    const gateway = {
      stream: vi.fn(),
      async *streamDiscussion() {
        yield* discussionEvents();
      },
    };
    const transport = {
      createDiscussionGateway: vi.fn(() => gateway),
    };
    const transportFactory = vi.fn(() => transport);
    const providerService = createOllamaProviderService({ transportFactory });
    const requestScopeReader = {
      read: vi.fn(async () => {
        throw new Error("Discussion must not create a review scope reader.");
      }),
    };
    const controller = createConfiguredAiReviewerController({
      configStore: { get: vi.fn(async () => credentialConfiguration) },
      providerService,
      requestScopeReader,
      now: () => createdAt,
      eventId: () => "discussion-provider-error",
    });
    const response = new FakeResponse();

    await controller.discussionStream(
      httpRequest({ body: discussionRequest() }),
      response,
    );

    expect(transportFactory).toHaveBeenCalledExactlyOnceWith({
      baseUrl: remoteBaseUrl,
      credential,
      modelTag: remoteModel,
    });
    expect(transport.createDiscussionGateway).toHaveBeenCalledExactlyOnceWith({
      contextLength,
    });
    expect(requestScopeReader.read).not.toHaveBeenCalled();
    expect(gateway.stream).not.toHaveBeenCalled();
    expect(parseDiscussionNdjson(response)).toEqual(discussionEvents());
  });

  it("passes a metadata-only project snapshot to the configured provider", async function () {
    const mainText = String.raw`Text \input{section}
Cite \cite{missing}`;
    const reads = [];
    const searches = [];
    let capturedContext;
    const transport = {
      createAgentGateway: vi.fn(
        ({
          readProjectFile,
          projectContext,
          searchZotero,
          validateEvidence,
        }) => ({
          async *stream(agentRequest, { signal }) {
            capturedContext = projectContext;
            const mainFile = projectContext.files.find(
              (file) => file.path === "main.tex",
            );
            await validateEvidence(
              [
                {
                  path: "main.tex",
                  range: { from: 0, to: 4 },
                  revision: mainFile.revision,
                  textHash: mainFile.textHash,
                },
              ],
              { request: agentRequest, signal },
            );
            reads.push(
              await readProjectFile(
                { path: "main.tex", range: { from: 0, to: 4 } },
                { request: agentRequest, signal },
              ),
            );
            searches.push(
              await searchZotero(
                { query: "Synthetic 2026" },
                { request: agentRequest, signal },
              ),
            );
            yield* streamEvents();
          },
        }),
      ),
    };
    const providerService = createOllamaProviderService({
      transportFactory: () => transport,
    });
    const loadProjectDocuments = vi.fn(async () => ({
      "/main.tex": {
        _id: "document-provider-main",
        version: 4,
        lines: [mainText],
      },
      "/section.tex": {
        _id: "document-provider-section",
        version: 2,
        lines: [String.raw`\section{Synthetic}`],
      },
    }));
    const searchZoteroItems = vi.fn(async () => [
      {
        itemKey: "ITEM1",
        itemType: "journalArticle",
        title: "Synthetic result",
        creators: [],
        year: "2026",
        doi: null,
        verificationDepth: "metadata-only",
      },
    ]);
    const requestScopeReader = createRequestScopeReader({
      loadProjectDocuments,
      isZoteroLinked: vi.fn(async () => true),
      searchZoteroItems,
    });
    const controller = createConfiguredAiReviewerController({
      configStore: { get: vi.fn(async () => otherConfiguration) },
      providerService,
      requestScopeReader,
      now: () => createdAt,
      eventId: () => "event-provider-error",
    });

    const response = new FakeResponse();
    await controller.stream(httpRequest({ body: projectRequest() }), response);

    expect(loadProjectDocuments).toHaveBeenCalledExactlyOnceWith(projectId, {
      signal: expect.any(AbortSignal),
    });
    expect(searchZoteroItems).toHaveBeenCalledExactlyOnceWith(
      userId,
      { query: "Synthetic 2026" },
      { signal: expect.any(AbortSignal) },
    );
    expect(JSON.stringify(capturedContext)).not.toContain(mainText);
    expect(capturedContext).toMatchObject({
      summary: { fileCount: 2, relationshipCount: 3 },
      files: [
        { path: "main.tex", textLength: mainText.length },
        {
          path: "section.tex",
          textLength: String.raw`\section{Synthetic}`.length,
        },
      ],
    });
    expect(reads).toEqual([
      {
        path: "main.tex",
        range: { from: 0, to: 4 },
        revision: 4,
        textHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
        text: "Text",
      },
    ]);
    expect(searches).toEqual([
      [
        {
          itemKey: "ITEM1",
          itemType: "journalArticle",
          title: "Synthetic result",
          creators: [],
          year: "2026",
          doi: null,
          verificationDepth: "metadata-only",
        },
      ],
    ]);
    expect(parseNdjson(response)).toEqual(streamEvents());
  });

  it("returns a truthful bounded error when project context is too large", async function () {
    const privateTitle = "PRIVATE_PROJECT_TITLE_".repeat(9);
    const failureRecorder = vi.fn();
    const requestScopeReader = createRequestScopeReader({
      loadProjectDocuments: async () =>
        Object.fromEntries(
          Array.from({ length: 200 }, (_, index) => [
            `/${privateTitle}${index}.tex`,
            {
              _id: `document-provider-oversized-${index}`,
              version: 1,
              lines: [""],
            },
          ]),
        ),
    });
    const controller = createConfiguredAiReviewerController({
      configStore: { get: vi.fn(async () => otherConfiguration) },
      providerService: {
        createAgentGateway: vi.fn(() => {
          throw new Error("The provider must not be reached.");
        }),
      },
      requestScopeReader,
      now: () => createdAt,
      eventId: () => "event-project-content-error",
      elapsedNow: vi.fn().mockReturnValueOnce(300).mockReturnValue(318.9),
      failureRecorder,
    });

    const response = new FakeResponse();
    await controller.stream(httpRequest({ body: projectRequest() }), response);

    expect(parseNdjson(response)).toEqual([
      {
        type: "error",
        eventId: "event-project-content-error",
        requestId: projectRequest().requestId,
        sequence: 0,
        createdAt,
        error: {
          code: "AI_PROJECT_CONTENT_NOT_AVAILABLE",
          category: "configuration",
          message:
            "AI Reviewer could not read the project content. Try narrowing the review scope or check that the project files are available.",
          retryable: false,
        },
      },
    ]);
    expect(response.chunks.join("")).not.toContain(privateTitle);
    expect(failureRecorder).toHaveBeenCalledExactlyOnceWith({
      requestId: projectRequest().requestId,
      provider: otherConfiguration.provider,
      model: otherConfiguration.model,
      scopeKind: "project",
      failureCategory: "configuration",
      failureCode: "AI_PROJECT_CONTENT_NOT_AVAILABLE",
      elapsedMs: 19,
    });
    expect(JSON.stringify(failureRecorder.mock.calls)).not.toContain(
      privateTitle,
    );
  });
});
