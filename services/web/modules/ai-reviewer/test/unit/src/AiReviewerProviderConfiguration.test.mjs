import { EventEmitter } from "node:events";
import fs from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { AgentGatewayError } from "../../../app/src/AgentGateway.mjs";
import {
  parseAiReviewerConnection,
  parseAiReviewerConnectionUpdate,
  parseAiReviewerProviderConfig,
  publicAiReviewerProviderConnection,
} from "../../../app/src/AiReviewerProviderConfig.mjs";
import { createAiReviewerProviderConfigStore } from "../../../app/src/AiReviewerProviderConfigStore.mjs";
import { createAiReviewerProviderCredentialManager } from "../../../app/src/AiReviewerProviderCredentialManager.mjs";
import { createAiReviewerProviderController } from "../../../app/src/AiReviewerProviderController.mjs";
import { createConfiguredAiReviewerController } from "../../../app/src/ConfiguredAiReviewerController.mjs";
import {
  createAiReviewerProviderService,
  createOllamaProviderService,
} from "../../../app/src/OllamaProviderService.mjs";
import { createRequestScopeReader } from "../../../app/src/RequestScopeReader.mjs";
import {
  AgentEventSchema,
  AgentRequestSchema,
  DiscussionEventSchema,
  WorkspaceRunSchema,
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
const geminiModel = "gemini-2.5-pro";
const claudeModel = "claude-sonnet-4-20250514";
const englishMessages = JSON.parse(
  fs.readFileSync(new URL("../../../../../locales/en.json", import.meta.url)),
);
const extractedMessages = JSON.parse(
  fs.readFileSync(
    new URL(
      "../../../../../frontend/extracted-translations.json",
      import.meta.url,
    ),
  ),
);

// A run configuration is a connection plus the model the request selected and
// the context length that pair resolved to. Only this shape reaches transports.
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
const geminiConfiguration = Object.freeze({
  provider: "gemini",
  model: geminiModel,
  contextLength,
  credential,
  credentialUpdatedAt,
});
const claudeConfiguration = Object.freeze({
  provider: "claude",
  model: claudeModel,
  contextLength,
  credential,
  credentialUpdatedAt,
});

// A connection is only a destination. The context length override is the
// escape hatch a run applies to whichever model it selected.
const connectionWrite = Object.freeze({
  provider: "openai-compatible",
  baseUrl,
  contextLengthOverride: contextLength,
});
const otherConnectionWrite = Object.freeze({
  provider: "openai-compatible",
  baseUrl: otherBaseUrl,
  contextLengthOverride: otherContextLength,
});
const credentialConnectionWrite = Object.freeze({
  provider: "openai-compatible",
  baseUrl: remoteBaseUrl,
  contextLengthOverride: contextLength,
  credential,
});
const geminiConnectionWrite = Object.freeze({
  provider: "gemini",
  credential,
});
const claudeConnectionWrite = Object.freeze({
  provider: "claude",
  credential,
});
const storedConnectionId = "connection-provider-0001";
const otherConnection = Object.freeze({
  id: storedConnectionId,
  provider: "openai-compatible",
  baseUrl: otherBaseUrl,
  label: "localhost:11434",
  contextLengthOverride: otherContextLength,
});
const credentialConnection = Object.freeze({
  id: storedConnectionId,
  provider: "openai-compatible",
  baseUrl: remoteBaseUrl,
  label: "api.example.com",
  contextLengthOverride: contextLength,
  credential,
  credentialUpdatedAt,
});
const geminiConnection = Object.freeze({
  id: storedConnectionId,
  provider: "gemini",
  label: "Google Gemini",
  contextLengthOverride: contextLength,
  credential,
  credentialUpdatedAt,
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

function storedConnection(records, id = userId) {
  return records.get(id).connections[0];
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

/**
 * The stubs a run needs before it reaches a transport: which models the
 * connection offers, and what context length the selected one resolves to.
 */
function runModelStubs(models = [{ id: otherModel, displayName: otherModel }]) {
  return {
    listModels: vi.fn(async () => models),
    resolveContextLength: vi.fn(async () => ({
      contextLength: otherContextLength,
      contextLengthSource: "override",
    })),
  };
}

/**
 * Give a real provider service a fixed model listing, so a run resolves its
 * model without any provider being reachable.
 */
function withModelListing(
  providerService,
  models = [{ id: otherModel, displayName: otherModel }],
) {
  return { ...providerService, listModels: vi.fn(async () => models) };
}

async function projectCoverageStream({
  text,
  configuredContextLength = contextLength,
  performReads = async () => {},
}) {
  const transport = {
    createAgentGateway: vi.fn(({ readProjectFile }) => ({
      async *stream(agentRequest, { signal }) {
        await performReads(readProjectFile, agentRequest, signal);
        yield* streamEvents();
      },
    })),
  };
  const providerService = withModelListing(
    createOllamaProviderService({
      transportFactory: () => transport,
    }),
  );
  const requestScopeReader = createRequestScopeReader({
    loadProjectDocuments: vi.fn(async () => ({
      "/main.tex": {
        _id: "document-provider-main",
        version: 1,
        lines: [text],
      },
    })),
  });
  const controller = createConfiguredAiReviewerController({
    configStore: {
      get: vi.fn(async () => ({
        ...otherConnection,
        contextLengthOverride: configuredContextLength,
      })),
    },
    providerService,
    requestScopeReader,
    now: () => createdAt,
    eventId: () => "event-provider-error",
  });
  const response = new FakeResponse();
  await controller.stream(httpRequest({ body: projectRequest() }), response);
  return parseNdjson(response);
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
  storedConnections = [{ ...otherConnection, baseUrl }],
  timeoutSignalFactory,
  modelTimeoutSignalFactory,
  failureRecorder = vi.fn(),
} = {}) {
  const store = {
    get: vi.fn(async () => storedConnections[0] ?? null),
    getAll: vi.fn(async () => storedConnections),
  };
  const providerService = {
    listModels: vi.fn(async () => [
      { id: model, displayName: "Configured model" },
    ]),
    testConnection: vi.fn(async () => ({
      ok: true,
      provider: "openai-compatible",
      modelCount: 1,
      classification: "local",
    })),
  };
  return {
    store,
    providerService,
    failureRecorder,
    controller: createAiReviewerProviderController({
      configStore: store,
      providerService,
      timeoutSignalFactory,
      modelTimeoutSignalFactory,
      failureRecorder,
    }),
  };
}

describe("AI reviewer provider configuration", function () {
  it("stores a Gemini model without its listing prefix", function () {
    // Discovery reports the bare id, so keeping `models/` here would make a
    // saved configuration fail the per-run model check against that list.
    expect(
      parseAiReviewerProviderConfig({
        provider: "gemini",
        model: "models/gemini-3.5-flash",
        contextLength: 8_192,
      }).model,
    ).toBe("gemini-3.5-flash");
  });

  it("keeps the AI reviewer locale and extracted message key sets aligned", function () {
    const aiReviewerKeys = (messages) =>
      Object.keys(messages)
        .filter((key) => key.startsWith("ai_reviewer_"))
        .sort();

    expect(aiReviewerKeys(extractedMessages)).toEqual(
      aiReviewerKeys(englishMessages),
    );
    for (const removedKey of [
      "ai_reviewer_provider_credential_required",
      "ai_reviewer_provider_context_length",
      "ai_reviewer_provider_ollama",
    ]) {
      expect(englishMessages).not.toHaveProperty(removedKey);
      expect(extractedMessages).not.toHaveProperty(removedKey);
    }
  });

  it("keeps provider option values free of their field name and user-recognisable", function () {
    const providerFieldName = englishMessages.ai_reviewer_provider;
    const providerValues = [
      englishMessages.ai_reviewer_provider_openai_compatible,
      englishMessages.ai_reviewer_provider_gemini,
      englishMessages.ai_reviewer_provider_claude,
    ];
    const fieldNames = [
      providerFieldName,
      englishMessages.ai_reviewer_provider_base_url,
      englishMessages.ai_reviewer_provider_model,
      englishMessages.ai_reviewer_provider_context_length_override,
      englishMessages.ai_reviewer_provider_credential,
    ];

    expect(new Set(providerValues).size).toBe(providerValues.length);
    for (const value of providerValues) {
      expect(value.toLowerCase()).not.toContain(
        providerFieldName.toLowerCase(),
      );
    }
    for (const [key, value] of Object.entries(englishMessages)) {
      if (!key.startsWith("ai_reviewer_")) continue;
      for (const fieldName of fieldNames) {
        expect(value.toLowerCase(), key).not.toContain(
          `${fieldName.toLowerCase()}:`,
        );
      }
    }
    expect(englishMessages.ai_reviewer_provider_openai_compatible).toBe(
      "OpenAI-compatible (Ollama, LM Studio, vLLM)",
    );
    expect(englishMessages.ai_reviewer_provider_gemini).toBe("Google Gemini");
    expect(englishMessages.ai_reviewer_provider_claude).toBe(
      "Anthropic Claude",
    );
    expect(englishMessages.ai_reviewer_provider_credential).toBe("API key");
    expect(englishMessages.ai_reviewer_provider_local).toBe("Local endpoint");
    expect(englishMessages.ai_reviewer_provider_remote).toBe("Remote endpoint");
    expect(englishMessages.ai_reviewer_integration_description).toBe(
      "Configure an AI provider, then review this LaTeX project and discuss the results.",
    );
  });

  it("accepts a strict run configuration and rejects anything outside it", function () {
    const parsed = parseAiReviewerProviderConfig(configuration);
    expect(parsed).toEqual(configuration);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(
      parseAiReviewerProviderConfig({
        ...configuration,
        provider: "ollama",
      }),
    ).toEqual(configuration);

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
      // A connection field is not part of what a run sends to a transport.
      { ...configuration, contextLengthOverride: contextLength },
      { ...configuration, label: "Lab GPU box" },
    ]) {
      expect(() => parseAiReviewerProviderConfig(invalid)).toThrow();
    }
  });

  it("accepts a connection that names no model", function () {
    expect(parseAiReviewerConnectionUpdate(connectionWrite)).toEqual({
      provider: "openai-compatible",
      baseUrl,
      label: null,
      contextLengthOverride: contextLength,
    });
    expect(parseAiReviewerConnectionUpdate(geminiConnectionWrite)).toEqual({
      provider: "gemini",
      label: null,
      credential,
    });
    expect(
      parseAiReviewerConnectionUpdate({
        provider: "openai-compatible",
        baseUrl,
        contextLengthOverride: null,
        label: "Lab GPU box",
      }),
    ).toEqual({
      provider: "openai-compatible",
      baseUrl,
      label: "Lab GPU box",
      contextLengthOverride: null,
    });

    for (const invalidOverride of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() =>
        parseAiReviewerConnectionUpdate({
          provider: "openai-compatible",
          baseUrl,
          contextLengthOverride: invalidOverride,
        }),
      ).toThrow();
    }
    for (const invalid of [
      // A model, a resolved context length and credential metadata are all
      // server-owned or per-run, so none of them may be written here.
      { provider: "openai-compatible", baseUrl, model },
      { provider: "openai-compatible", baseUrl, contextLength },
      { provider: "openai-compatible", baseUrl, credentialUpdatedAt },
      { provider: "openai-compatible", baseUrl, label: "x".repeat(101) },
    ]) {
      expect(() => parseAiReviewerConnectionUpdate(invalid)).toThrow();
    }
  });

  it.each([
    { provider: "gemini", label: "Google Gemini" },
    { provider: "claude", label: "Anthropic Claude" },
  ])(
    "round-trips the strict $provider connection without a base URL",
    function ({ provider, label }) {
      const stored = { provider, credential, credentialUpdatedAt };
      expect(parseAiReviewerConnection(stored)).toEqual({
        provider,
        label,
        credential,
        credentialUpdatedAt,
      });
      const response = publicAiReviewerProviderConnection({
        id: storedConnectionId,
        credentialSet: true,
        ...stored,
      });
      expect(response).toEqual({
        id: storedConnectionId,
        label,
        classification: "remote",
        config: {
          provider,
          contextLengthOverride: null,
          credentialSet: true,
          credentialUpdatedAt,
        },
      });
      expect(Object.keys(response.config)).toEqual([
        "provider",
        "contextLengthOverride",
        "credentialSet",
        "credentialUpdatedAt",
      ]);
      expect(JSON.stringify(response)).not.toContain(credential);
      expect(JSON.stringify(response)).not.toContain("baseUrl");
    },
  );

  it.each([geminiConnectionWrite, claudeConnectionWrite])(
    "rejects a base URL for $provider",
    function (connectionWithCredential) {
      const invalid = {
        ...connectionWithCredential,
        baseUrl: "https://arbitrary.example.test/v1",
      };
      expect(() => parseAiReviewerConnection(invalid)).toThrow();
      expect(() => parseAiReviewerConnectionUpdate(invalid)).toThrow();
    },
  );

  it("reads and writes each user's connections only through its _id", async function () {
    const { modelDependency, records } = inMemoryModel();
    records.set(userId, connectionWrite);
    records.set(otherUserId, otherConnectionWrite);
    const store = createAiReviewerProviderConfigStore({
      model: modelDependency,
    });

    expect(await store.get(userId)).toMatchObject({ baseUrl });
    expect(await store.get(otherUserId)).toMatchObject({
      baseUrl: otherBaseUrl,
    });
    expect(await store.create(userId, connectionWrite)).toMatchObject({
      baseUrl,
    });
    expect(await store.create(otherUserId, otherConnectionWrite)).toMatchObject(
      { baseUrl: otherBaseUrl },
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

  it("stores a connection without resolving any context length", async function () {
    const { modelDependency, records } = inMemoryModel();
    const store = createAiReviewerProviderConfigStore({
      model: modelDependency,
    });

    const saved = await store.create(userId, {
      provider: "openai-compatible",
      baseUrl,
      contextLengthOverride: null,
    });

    expect(saved).toEqual({
      id: expect.any(String),
      credentialSet: false,
      provider: "openai-compatible",
      baseUrl,
      label: "127.0.0.1:11434",
    });
    // Nothing was asked of the provider: a connection is written from what the
    // user typed, and the effective context length belongs to each run.
    expect(storedConnection(records)).not.toHaveProperty("contextLength");
    expect(storedConnection(records)).not.toHaveProperty(
      "contextLengthOverride",
    );
    expect(records.get(userId).revision).toBe(1);
  });

  it("keeps a legacy record that never stored a context length", async function () {
    const legacyRecord = { _id: userId, provider: "ollama", baseUrl, model };
    const modelDependency = {
      findOne: vi.fn().mockReturnValue(fakeQuery(legacyRecord)),
    };
    const store = createAiReviewerProviderConfigStore({
      model: modelDependency,
    });

    expect(await store.get(userId)).toEqual({
      id: userId,
      provider: "openai-compatible",
      baseUrl,
      label: "127.0.0.1:11434",
    });
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

    expect(await store.get(userId)).toEqual({
      id: userId,
      provider: "openai-compatible",
      baseUrl,
      label: "127.0.0.1:11434",
    });
    expect(
      publicAiReviewerProviderConnection(
        await store.list(userId).then((c) => c[0]),
      ),
    ).toEqual({
      id: userId,
      label: "127.0.0.1:11434",
      classification: "local",
      config: {
        provider: "openai-compatible",
        baseUrl,
        contextLengthOverride: null,
        credentialSet: false,
        credentialUpdatedAt: null,
      },
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

    const created = await store.create(userId, credentialConnectionWrite);
    expect(await store.get(userId)).toEqual({
      id: created.id,
      provider: "openai-compatible",
      baseUrl: remoteBaseUrl,
      label: "api.example.com",
      contextLengthOverride: contextLength,
      credential,
      credentialUpdatedAt,
    });
    expect(encryptor.encryptJson).toHaveBeenCalledExactlyOnceWith({
      provider: "openai-compatible",
      baseUrl: remoteBaseUrl,
      credential,
    });
    expect(storedConnection(records)).toMatchObject({
      provider: "openai-compatible",
      baseUrl: remoteBaseUrl,
      contextLengthOverride: contextLength,
      credentialEncrypted: "ciphertext-1",
      credentialUpdatedAt: new Date(credentialUpdatedAt),
    });
    expect(JSON.stringify(records.get(userId))).not.toContain(credential);
    expect(publicAiReviewerProviderConnection(created)).toEqual({
      id: created.id,
      label: "api.example.com",
      classification: "remote",
      config: {
        provider: "openai-compatible",
        baseUrl: remoteBaseUrl,
        contextLengthOverride: contextLength,
        credentialSet: true,
        credentialUpdatedAt,
      },
    });
  });

  it.each([geminiConnectionWrite, claudeConnectionWrite])(
    "round-trips a $provider credential bound only to that provider",
    async function (nativeWrite) {
      const { manager, encryptor } = credentialManagerFixture();
      const { modelDependency, records } = inMemoryModel();
      const store = createAiReviewerProviderConfigStore({
        model: modelDependency,
        credentialManager: manager,
        now: () => credentialUpdatedAt,
      });

      const created = await store.create(userId, nativeWrite);
      expect(await store.get(userId)).toMatchObject({
        provider: nativeWrite.provider,
        credential,
        credentialUpdatedAt,
      });
      expect(encryptor.encryptJson).toHaveBeenCalledExactlyOnceWith({
        provider: nativeWrite.provider,
        credential,
      });
      expect(storedConnection(records)).toMatchObject({
        provider: nativeWrite.provider,
        credentialEncrypted: "ciphertext-1",
        credentialUpdatedAt: new Date(credentialUpdatedAt),
      });
      expect(storedConnection(records)).not.toHaveProperty("baseUrl");

      // Editing anything else about the connection keeps the credential.
      await store.update(userId, created.id, {
        provider: nativeWrite.provider,
        contextLengthOverride: otherContextLength,
      });
      expect(await store.get(userId)).toMatchObject({
        contextLengthOverride: otherContextLength,
        credential,
      });
      expect(storedConnection(records).credentialEncrypted).toBe(
        "ciphertext-1",
      );
    },
  );

  it("requires an effective credential for Gemini and Claude but not OpenAI-compatible", async function () {
    const { manager } = credentialManagerFixture();
    const { modelDependency, records } = inMemoryModel();
    const store = createAiReviewerProviderConfigStore({
      model: modelDependency,
      credentialManager: manager,
    });

    expect(await store.create(userId, connectionWrite)).toMatchObject({
      provider: "openai-compatible",
      baseUrl,
    });
    for (const nativeWrite of [
      { provider: "gemini" },
      { provider: "claude" },
    ]) {
      const error = await captureError(store.create(otherUserId, nativeWrite));
      expect(error).toBeInstanceOf(TypeError);
      expect(error.message).toBe("The AI provider credential is required.");
    }
    expect(records.has(otherUserId)).toBe(false);
  });

  it("refuses to replay a native credential after its provider binding changes", async function () {
    const { manager } = credentialManagerFixture();
    const { modelDependency, records } = inMemoryModel();
    const store = createAiReviewerProviderConfigStore({
      model: modelDependency,
      credentialManager: manager,
      now: () => credentialUpdatedAt,
    });
    await store.create(userId, geminiConnectionWrite);
    records.set(userId, {
      ...records.get(userId),
      connections: [{ ...storedConnection(records), provider: "claude" }],
    });

    const error = await captureError(store.get(userId));
    expect(error).toBeInstanceOf(TypeError);
    expect(error.message).toBe("The AI provider credential could not be read.");
    expect(String(error)).not.toContain(credential);
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
    const created = await store.create(userId, credentialConnectionWrite);
    const encrypted = storedConnection(records).credentialEncrypted;

    const sameDestination = {
      provider: "openai-compatible",
      baseUrl: remoteBaseUrl,
      label: "Hosted reviewer",
    };
    await store.update(userId, created.id, sameDestination);
    expect(await store.get(userId)).toEqual({
      id: created.id,
      ...sameDestination,
      credential,
      credentialUpdatedAt,
    });
    expect(storedConnection(records).credentialEncrypted).toBe(encrypted);
    expect(storedConnection(records).credentialUpdatedAt).toEqual(
      new Date(credentialUpdatedAt),
    );

    const changedDestination = {
      ...sameDestination,
      baseUrl: "https://other.example.com/v1",
    };
    await store.update(userId, created.id, changedDestination);
    expect(await store.get(userId)).toEqual({
      id: created.id,
      ...changedDestination,
      credentialUpdatedAt: later,
    });
    expect(storedConnection(records)).not.toHaveProperty("credentialEncrypted");
    expect(JSON.stringify(records.get(userId))).not.toContain(credential);
  });

  it("retries a stale credential-preserving write without breaking the destination binding", async function () {
    const replacementCredential = "PRIVATE_REPLACEMENT_CREDENTIAL";
    const replacementBaseUrl = "https://replacement.example.com/v1";
    const staleLabel = "Stale writer";
    const { manager } = credentialManagerFixture();
    const { hooks, modelDependency, records } = inMemoryModel();
    const store = createAiReviewerProviderConfigStore({
      model: modelDependency,
      credentialManager: manager,
      now: () => credentialUpdatedAt,
    });
    const created = await store.create(userId, credentialConnectionWrite);

    const staleWriterEntered = deferred();
    const releaseStaleWriter = deferred();
    let staleWriterBlocked = false;
    hooks.beforeFindOneAndUpdate = async ({ update }) => {
      if (
        !staleWriterBlocked &&
        update.$set.connections[0].label === staleLabel
      ) {
        staleWriterBlocked = true;
        staleWriterEntered.resolve();
        await releaseStaleWriter.promise;
      }
    };

    const staleWrite = {
      provider: "openai-compatible",
      baseUrl: remoteBaseUrl,
      label: staleLabel,
    };
    const staleSave = store.update(userId, created.id, staleWrite);
    await staleWriterEntered.promise;

    const replacement = {
      provider: "openai-compatible",
      baseUrl: replacementBaseUrl,
      label: "Replacement",
      credential: replacementCredential,
    };
    await store.update(userId, created.id, replacement);
    expect(await store.get(userId)).toEqual({
      id: created.id,
      provider: replacement.provider,
      baseUrl: replacementBaseUrl,
      label: "Replacement",
      credential: replacementCredential,
      credentialUpdatedAt,
    });

    releaseStaleWriter.resolve();
    await staleSave;
    // The retry re-reads the replacement destination, so the stale write moves
    // the connection back and drops a credential bound somewhere else.
    expect(await store.get(userId)).toEqual({
      id: created.id,
      ...staleWrite,
      credentialUpdatedAt,
    });
    expect(records.get(userId).revision).toBe(3);
    expect(storedConnection(records)).not.toHaveProperty("credentialEncrypted");

    const staleWrites = modelDependency.findOneAndUpdate.mock.calls.filter(
      ([, update]) => update.$set.connections[0].label === staleLabel,
    );
    expect(staleWrites).toHaveLength(2);
    expect(staleWrites[0][0]).toEqual({ _id: userId, revision: 1 });
    expect(staleWrites[0][1].$set.connections[0]).toMatchObject({
      credentialEncrypted: "ciphertext-1",
    });
    expect(staleWrites[1][0]).toEqual({ _id: userId, revision: 2 });
    expect(staleWrites[1][1].$set.connections[0]).not.toHaveProperty(
      "credentialEncrypted",
    );
  });

  it("retries a duplicate-key race when two writers observe no existing record", async function () {
    const firstWriterEntered = deferred();
    const releaseFirstWriter = deferred();
    const { hooks, modelDependency, records } = inMemoryModel();
    const store = createAiReviewerProviderConfigStore({
      model: modelDependency,
    });
    let firstWriterBlocked = false;
    hooks.beforeFindOneAndUpdate = async ({ update }) => {
      if (
        !firstWriterBlocked &&
        update.$set.connections[0].baseUrl === baseUrl
      ) {
        firstWriterBlocked = true;
        firstWriterEntered.resolve();
        await releaseFirstWriter.promise;
      }
    };

    const firstSave = store.create(userId, connectionWrite);
    await firstWriterEntered.promise;
    expect(await store.create(userId, otherConnectionWrite)).toMatchObject({
      baseUrl: otherBaseUrl,
    });
    releaseFirstWriter.resolve();

    expect(await firstSave).toMatchObject({ baseUrl });
    expect(
      (await store.list(userId)).map((connection) => connection.baseUrl),
    ).toEqual([otherBaseUrl, baseUrl]);
    expect(records.get(userId).revision).toBe(2);
    const firstWrites = modelDependency.findOneAndUpdate.mock.calls.filter(
      ([, update]) =>
        update.$set.connections.some(
          (connection) => connection.baseUrl === baseUrl,
        ),
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
    const created = await store.create(userId, credentialConnectionWrite);

    await store.update(userId, created.id, {
      provider: credentialConnectionWrite.provider,
      baseUrl: credentialConnectionWrite.baseUrl,
      credential: null,
    });
    const cleared = await store.get(userId);
    expect(cleared).toEqual({
      id: created.id,
      provider: credentialConnectionWrite.provider,
      baseUrl: credentialConnectionWrite.baseUrl,
      label: "api.example.com",
      credentialUpdatedAt: clearedAt,
    });
    expect(storedConnection(records)).not.toHaveProperty("credentialEncrypted");
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
    await store.create(userId, credentialConnectionWrite);
    records.set(userId, {
      ...records.get(userId),
      connections: [
        {
          ...storedConnection(records),
          baseUrl: "https://other.example.com/v1",
        },
      ],
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

  it("checks a connection by listing what it can run", async function () {
    const modelFetchImpl = vi.fn(async (input) => {
      if (String(input).endsWith("/api/tags")) {
        return new Response("", { status: 404 });
      }
      return new Response(
        JSON.stringify({ data: [{ id: model }, { id: otherModel }] }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const service = createAiReviewerProviderService({ modelFetchImpl });

    // A connection carries no model, so reachability and the credential are
    // the only things a check can honestly report.
    expect(
      await service.testConnection(
        { provider: "openai-compatible", baseUrl },
        { signal: new AbortController().signal },
      ),
    ).toEqual({
      ok: true,
      provider: "openai-compatible",
      modelCount: 2,
      classification: "local",
    });

    const unreachable = createAiReviewerProviderService({
      modelFetchImpl: vi.fn(async () => new Response("", { status: 401 })),
    });
    expect(
      await captureError(
        unreachable.testConnection({ provider: "gemini", credential }),
      ),
    ).toMatchObject({
      code: "AI_PROVIDER_AUTHENTICATION_ERROR",
      category: "authentication",
    });
  });

  it("resolves a context length from the connection and the selected model", async function () {
    const signal = new AbortController().signal;
    const contextLengthDetector = vi.fn(async () => 32_768);
    const service = createAiReviewerProviderService({
      contextLengthDetector,
      contextLengthDetectionSignalFactory: () => signal,
    });

    expect(
      await service.resolveContextLength(
        {
          provider: "openai-compatible",
          baseUrl: remoteBaseUrl,
          credential,
        },
        remoteModel,
      ),
    ).toEqual({
      contextLength: 32_768,
      contextLengthSource: "detected",
    });
    expect(contextLengthDetector).toHaveBeenCalledExactlyOnceWith({
      baseUrl: remoteBaseUrl,
      model: remoteModel,
      credential,
      signal,
    });

    // The connection's escape hatch wins over anything the endpoint says.
    expect(
      await service.resolveContextLength(
        {
          provider: "openai-compatible",
          baseUrl: remoteBaseUrl,
          credential,
          contextLengthOverride: contextLength,
        },
        remoteModel,
      ),
    ).toEqual({
      contextLength,
      contextLengthSource: "override",
    });
    expect(contextLengthDetector).toHaveBeenCalledOnce();
  });

  it("passes the credential only into discussion and review transport construction", async function () {
    const transport = {
      createDiscussionGateway: vi.fn(() => ({ kind: "discussion" })),
      createAgentGateway: vi.fn(() => ({ kind: "review" })),
    };
    const transportFactory = vi.fn(() => transport);
    const service = createOllamaProviderService({ transportFactory });

    expect(service.createDiscussionGateway(credentialConfiguration)).toEqual({
      kind: "discussion",
    });
    expect(
      service.createAgentGateway(credentialConfiguration, {
        readProjectFile: vi.fn(),
      }),
    ).toEqual({ kind: "review" });
    expect(transportFactory).toHaveBeenCalledTimes(2);
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

  it.each([
    {
      configuration: geminiConfiguration,
      factoryName: "geminiTransportFactory",
    },
    {
      configuration: claudeConfiguration,
      factoryName: "claudeTransportFactory",
    },
  ])(
    "dispatches $configuration.provider through its native provider transport without a base URL",
    async function ({ configuration: nativeConfiguration, factoryName }) {
      const transport = {
        createDiscussionGateway: vi.fn(() => ({ kind: "discussion" })),
        createAgentGateway: vi.fn(() => ({ kind: "review" })),
      };
      const nativeFactory = vi.fn(() => transport);
      const service = createAiReviewerProviderService({
        [factoryName]: nativeFactory,
        openAiCompatibleTransportFactory: vi.fn(() => {
          throw new Error("The OpenAI-compatible transport is not expected.");
        }),
      });

      expect(service.createDiscussionGateway(nativeConfiguration)).toEqual({
        kind: "discussion",
      });
      expect(
        service.createAgentGateway(nativeConfiguration, {
          readProjectFile: vi.fn(),
        }),
      ).toEqual({ kind: "review" });
      expect(nativeFactory).toHaveBeenCalledTimes(2);
      for (const [options] of nativeFactory.mock.calls) {
        expect(options).toEqual({
          credential,
          modelTag: nativeConfiguration.model,
        });
        expect(options).not.toHaveProperty("baseUrl");
      }
    },
  );

  it.each([
    { provider: "gemini", model: geminiModel, contextLength },
    { provider: "claude", model: claudeModel, contextLength },
  ])(
    "rejects a missing $provider credential before constructing its transport",
    function (nativeConfiguration) {
      const geminiTransportFactory = vi.fn();
      const claudeTransportFactory = vi.fn();
      const service = createAiReviewerProviderService({
        geminiTransportFactory,
        claudeTransportFactory,
      });

      expect(() =>
        service.createDiscussionGateway(nativeConfiguration),
      ).toThrow(AgentGatewayError);
      expect(geminiTransportFactory).not.toHaveBeenCalled();
      expect(claudeTransportFactory).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      config: {
        provider: "openai-compatible",
        baseUrl: remoteBaseUrl,
        credential,
      },
      expectedUrl: `${remoteBaseUrl}/models`,
      expectedHeader: ["authorization", `Bearer ${credential}`],
      payload: {
        data: [{ id: remoteModel }, { id: "text-embedding-3-small" }],
      },
      expected: [{ id: remoteModel, displayName: remoteModel }],
    },
    {
      config: { provider: "gemini", credential },
      expectedUrl: "https://generativelanguage.googleapis.com/v1beta/models",
      expectedHeader: ["x-goog-api-key", credential],
      payload: {
        models: [
          {
            name: `models/${geminiModel}`,
            displayName: "Gemini 2.5 Pro",
            supportedGenerationMethods: ["generateContent"],
          },
          {
            name: "models/text-embedding-004",
            supportedGenerationMethods: ["embedContent"],
          },
        ],
      },
      expected: [{ id: geminiModel, displayName: "Gemini 2.5 Pro" }],
    },
    {
      config: { provider: "claude", credential },
      expectedUrl: "https://api.anthropic.com/v1/models",
      expectedHeader: ["x-api-key", credential],
      payload: {
        data: [
          {
            type: "model",
            id: claudeModel,
            display_name: "Claude Sonnet 4",
          },
          { type: "model", id: "claude-embedding-v1" },
        ],
      },
      expected: [{ id: claudeModel, displayName: "Claude Sonnet 4" }],
    },
  ])(
    "discovers, filters, and caches $config.provider models through guarded fetch",
    async function ({
      config,
      expectedUrl,
      expectedHeader,
      payload,
      expected,
    }) {
      let capabilityProbes = 0;
      const modelFetchImpl = vi.fn(async (input, init) => {
        // A non-Ollama endpoint answers 404 here, which must leave the
        // pattern-based filter in charge rather than failing the listing.
        if (String(input).endsWith("/api/tags")) {
          capabilityProbes += 1;
          return new Response("", { status: 404 });
        }
        expect(String(input)).toBe(expectedUrl);
        expect(init.method).toBe("GET");
        expect(init.redirect).toBe("error");
        expect(new Headers(init.headers).get(expectedHeader[0])).toBe(
          expectedHeader[1],
        );
        return new Response(JSON.stringify(payload), {
          headers: { "content-type": "application/json" },
        });
      });
      const service = createAiReviewerProviderService({
        modelFetchImpl,
        modelNow: () => 1_000,
      });

      expect(await service.listModels(config, { cacheKey: userId })).toEqual(
        expected,
      );
      expect(await service.listModels(config, { cacheKey: userId })).toEqual(
        expected,
      );
      expect(capabilityProbes).toBe(
        config.provider === "openai-compatible" ? 1 : 0,
      );
      expect(JSON.stringify(await service.listModels(config))).not.toContain(
        credential,
      );
    },
  );

  it("keeps only tool-capable models when the endpoint declares capabilities", async function () {
    const modelFetchImpl = vi.fn(async (input) => {
      if (String(input).endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({
            models: [
              { name: "qwen3.5:4b", capabilities: ["completion", "tools"] },
              { name: "bge-m3:latest", capabilities: ["embedding"] },
              { name: "plain:latest", capabilities: ["completion"] },
            ],
          }),
          { headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          data: [
            { id: "qwen3.5:4b" },
            { id: "bge-m3:latest" },
            { id: "plain:latest" },
          ],
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const service = createAiReviewerProviderService({
      modelFetchImpl,
      modelNow: () => 1_000,
    });

    // `bge-m3` carries no "embed" token, so only the declared capabilities can
    // rule it out; `plain` completes text but cannot run the review tool.
    expect(
      await service.listModels({
        provider: "openai-compatible",
        baseUrl: "http://127.0.0.1:11434/v1",
      }),
    ).toEqual([{ id: "qwen3.5:4b", displayName: "qwen3.5:4b" }]);
  });

  it("falls back to the name filter when the endpoint declares nothing", async function () {
    const modelFetchImpl = vi.fn(async (input) => {
      if (String(input).endsWith("/api/tags")) {
        return new Response("", { status: 404 });
      }
      return new Response(
        JSON.stringify({
          data: [{ id: "gpt-4o-mini" }, { id: "text-embedding-3-small" }],
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const service = createAiReviewerProviderService({
      modelFetchImpl,
      modelNow: () => 1_000,
    });

    expect(
      await service.listModels({
        provider: "openai-compatible",
        baseUrl: "https://api.example.com/v1",
      }),
    ).toEqual([{ id: "gpt-4o-mini", displayName: "gpt-4o-mini" }]);
  });

  it("rejects unsupported and oversized model-list responses without returning provider bodies", async function () {
    const unsupportedBody = "RAW_UNSUPPORTED_PROVIDER_BODY";
    const unsupported = createAiReviewerProviderService({
      modelFetchImpl: vi.fn(async () => {
        return new Response(unsupportedBody, { status: 404 });
      }),
    });
    const unsupportedError = await captureError(
      unsupported.listModels({ provider: "openai-compatible", baseUrl }),
    );
    expect(unsupportedError).toMatchObject({
      code: "AI_PROVIDER_MODEL_DISCOVERY_UNSUPPORTED",
      category: "configuration",
      retryable: false,
    });
    expect(JSON.stringify(unsupportedError)).not.toContain(unsupportedBody);

    const oversized = createAiReviewerProviderService({
      modelFetchImpl: vi.fn(async () => {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(1_048_577));
            },
          }),
        );
      }),
    });
    const oversizedError = await captureError(
      oversized.listModels({ provider: "openai-compatible", baseUrl }),
    );
    expect(oversizedError).toMatchObject({
      code: "AI_PROVIDER_SCHEMA_INVALID",
      category: "schema",
      retryable: false,
    });
  });

  it("serves every connection's models through one bounded response", async function () {
    const available = providerControllerFixture();
    const response = new FakeResponse();

    await available.controller.listModels(httpRequest(), response);

    expect(available.store.getAll).toHaveBeenCalledExactlyOnceWith(userId);
    expect(
      available.providerService.listModels,
    ).toHaveBeenCalledExactlyOnceWith(
      { ...otherConnection, baseUrl },
      {
        signal: expect.any(AbortSignal),
        cacheKey: `${userId}\u0000${storedConnectionId}`,
      },
    );
    expect(response.body).toEqual({
      models: [
        {
          id: model,
          displayName: "Configured model",
          connectionId: storedConnectionId,
          connectionLabel: "localhost:11434",
        },
      ],
      failures: [],
    });

    const missing = providerControllerFixture({ storedConnections: [] });
    const missingResponse = new FakeResponse();
    await missing.controller.listModels(httpRequest(), missingResponse);
    expect(missingResponse.statusCode).toBe(409);
    expect(missingResponse.body.error).toMatchObject({
      code: "AI_PROVIDER_NOT_CONFIGURED",
      category: "configuration",
    });
    expect(missing.providerService.listModels).not.toHaveBeenCalled();
  });

  it("redacts model-discovery authentication failures from responses and failure logs", async function () {
    const rawBody = "RAW_PROVIDER_AUTHENTICATION_RESPONSE";
    const modelFetchImpl = vi.fn(async () => {
      return new Response(rawBody, { status: 401 });
    });
    const providerService = createAiReviewerProviderService({ modelFetchImpl });
    const configStore = {
      getAll: vi.fn(async () => [geminiConnection]),
    };
    const failureRecorder = vi.fn();
    const controller = createAiReviewerProviderController({
      configStore,
      providerService,
      failureRecorder,
      elapsedNow: vi.fn().mockReturnValueOnce(100).mockReturnValue(106),
    });
    const response = new FakeResponse();

    await controller.listModels(httpRequest(), response);

    // The reachable connections still answer, so an unusable one is reported
    // beside them as a classification rather than as a failed request.
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      models: [],
      failures: [
        {
          connectionId: storedConnectionId,
          connectionLabel: "Google Gemini",
          code: "AI_PROVIDER_AUTHENTICATION_ERROR",
          category: "authentication",
        },
      ],
    });
    expect(failureRecorder).toHaveBeenCalledExactlyOnceWith({
      requestId: null,
      provider: "gemini",
      model: null,
      scopeKind: "none",
      failureCategory: "authentication",
      failureCode: "AI_PROVIDER_AUTHENTICATION_ERROR",
      providerStatusCode: 401,
      providerErrorType: null,
      elapsedMs: 6,
    });
    for (const output of [
      JSON.stringify(response.body),
      JSON.stringify(failureRecorder.mock.calls),
    ]) {
      expect(output).not.toContain(rawBody);
      expect(output).not.toContain(credential);
    }
  });

  it("cuts off slow model discovery at the route timeout", async function () {
    const timeoutController = new AbortController();
    const modelFetchImpl = vi.fn(async () => {
      return new Response(
        new ReadableStream({
          cancel() {
            return new Promise(() => {});
          },
        }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    });
    const providerService = createAiReviewerProviderService({ modelFetchImpl });
    const controller = createAiReviewerProviderController({
      configStore: {
        getAll: vi.fn(async () => [{ ...otherConnection, baseUrl }]),
      },
      providerService,
      modelTimeoutSignalFactory: () => timeoutController.signal,
    });
    const response = new FakeResponse();
    const request = controller.listModels(httpRequest(), response);
    await vi.waitFor(() => expect(modelFetchImpl).toHaveBeenCalledOnce());
    timeoutController.abort(new DOMException("late provider", "TimeoutError"));
    await request;

    expect(response.statusCode).toBe(504);
    expect(response.body.error).toMatchObject({
      code: "AI_REQUEST_TIMEOUT",
      category: "timeout",
    });
  });

  it("classifies a credential-storage failure as a server persistence problem and records it", async function () {
    const storageSentinel =
      "EACCES_PRIVATE_CREDENTIAL_/var/lib/overleaf/data/.token-cipher.json";
    const failingCredentialManager = createAiReviewerProviderCredentialManager({
      encryptor: {
        encryptJson: vi.fn(async () => {
          throw new Error(storageSentinel);
        }),
        decryptToJson: vi.fn(),
      },
    });
    const { modelDependency } = inMemoryModel();
    const configStore = createAiReviewerProviderConfigStore({
      model: modelDependency,
      credentialManager: failingCredentialManager,
    });
    const failureRecorder = vi.fn();
    const controller = createAiReviewerProviderController({
      configStore,
      providerService: {},
      elapsedNow: vi.fn().mockReturnValueOnce(200).mockReturnValue(211.6),
      failureRecorder,
    });
    const response = new FakeResponse();

    await controller.createConnection(
      httpRequest({ body: geminiConnectionWrite }),
      response,
    );

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({
      error: {
        code: "AI_PROVIDER_CONFIGURATION_PERSISTENCE_FAILED",
        category: "configuration",
        message:
          "AI Reviewer could not save the provider configuration on this server. Ask the server administrator to check AI Reviewer storage and permissions, then try again.",
        retryable: false,
      },
    });
    expect(Object.keys(response.body.error).sort()).toEqual([
      "category",
      "code",
      "message",
      "retryable",
    ]);
    expect(failureRecorder).toHaveBeenCalledExactlyOnceWith({
      requestId: null,
      provider: "gemini",
      model: null,
      scopeKind: "none",
      failureCategory: "configuration",
      failureCode: "AI_PROVIDER_CONFIGURATION_PERSISTENCE_FAILED",
      providerStatusCode: null,
      providerErrorType: null,
      elapsedMs: 12,
    });
    expect(modelDependency.findOne).not.toHaveBeenCalled();
    expect(JSON.stringify(response.body)).not.toContain(storageSentinel);
    expect(JSON.stringify(response.body)).not.toContain(credential);
    expect(JSON.stringify(failureRecorder.mock.calls)).not.toContain(
      storageSentinel,
    );
    expect(JSON.stringify(failureRecorder.mock.calls)).not.toContain(
      credential,
    );
  });

  it("rejects a connection write that carries an unknown field", async function () {
    const { controller, store } = providerControllerFixture();
    const response = new FakeResponse();

    await controller.createConnection(
      httpRequest({ body: { ...connectionWrite, apiKey: "PRIVATE_SECRET" } }),
      response,
    );

    expect(response.statusCode).toBe(400);
    expect(JSON.stringify(response.body)).not.toContain("PRIVATE_SECRET");
    expect(store.getAll).not.toHaveBeenCalled();
  });

  it("checks the selected connection and returns bounded configuration errors", async function () {
    const { controller, providerService, store } = providerControllerFixture();
    const response = new FakeResponse();
    await controller.testConnection(httpRequest(), response);
    expect(store.get).toHaveBeenCalledExactlyOnceWith(userId, null);
    expect(providerService.testConnection).toHaveBeenCalledExactlyOnceWith(
      { ...otherConnection, baseUrl },
      { signal: expect.any(AbortSignal) },
    );
    expect(response.body).toEqual({
      ok: true,
      provider: "openai-compatible",
      modelCount: 1,
      classification: "local",
    });

    const missing = providerControllerFixture({ storedConnections: [] });
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
    const providerService = withModelListing(
      createOllamaProviderService({ transportFactory }),
    );
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

    await providerController.createConnection(
      httpRequest({ body: otherConnectionWrite }),
      new FakeResponse(),
    );
    expect(records.get(userId).revision).toBe(1);
    expect(storedConnection(records)).toMatchObject(otherConnectionWrite);

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
    const providerService = withModelListing(
      createOllamaProviderService({ transportFactory }),
      [{ id: remoteModel, displayName: remoteModel }],
    );
    const requestScopeReader = {
      read: vi.fn(async () => {
        throw new Error("Discussion must not create a review scope reader.");
      }),
    };
    const controller = createConfiguredAiReviewerController({
      configStore: { get: vi.fn(async () => credentialConnection) },
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
    const providerService = withModelListing(
      createOllamaProviderService({
        transportFactory: () => transport,
      }),
    );
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
      configStore: { get: vi.fn(async () => otherConnection) },
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

  it("errors when a project review read no manuscript content", async function () {
    const events = await projectCoverageStream({ text: "Synthetic" });

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "text.delta",
      "error",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      error: {
        code: "AI_PROJECT_CONTENT_NOT_AVAILABLE",
        category: "configuration",
        retryable: false,
      },
    });
  });

  it("reports relationship truncation after preserving supported findings", async function () {
    const text = Array.from(
      { length: 101 },
      (_, index) => String.raw`\input{file-${index}}`,
    ).join("\n");
    const events = await projectCoverageStream({
      text,
      configuredContextLength: 32_768,
      async performReads(readProjectFile, request, signal) {
        await readProjectFile(
          { path: "main.tex", range: { from: 0, to: 1 } },
          { request, signal },
        );
      },
    });

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "text.delta",
      "completed",
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      contextTruncated: true,
    });
  });

  it("reports a model-input budget read failure without leaking numbers", async function () {
    let readFailure;
    const events = await projectCoverageStream({
      text: "x".repeat(5_000),
      configuredContextLength: 4_096,
      async performReads(readProjectFile, request, signal) {
        await readProjectFile(
          { path: "main.tex", range: { from: 0, to: 1 } },
          { request, signal },
        );
        readFailure = await captureError(
          readProjectFile(
            { path: "main.tex", range: { from: 0, to: 5_000 } },
            { request, signal },
          ),
        );
      },
    });

    expect(readFailure).toBeInstanceOf(AgentGatewayError);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      contextTruncated: true,
    });
    expect(
      englishMessages.ai_reviewer_error_guidance_project_content,
    ).not.toMatch(/\d/u);
  });

  it("streams project events before the completion coverage check", async function () {
    const waitingForCompletion = deferred();
    const releaseCompletion = deferred();
    const readProjectFile = vi.fn();
    readProjectFile.reviewCoverage = () => ({
      successfulReadCount: 1,
      modelInputBudgetFailureCount: 0,
      relationshipsTruncated: false,
    });
    const providerService = {
      ...runModelStubs(),
      createAgentGateway: vi.fn(() => ({
        async *stream() {
          yield streamEvents()[0];
          waitingForCompletion.resolve();
          await releaseCompletion.promise;
          yield streamEvents()[1];
          yield streamEvents()[2];
        },
      })),
    };
    const controller = createConfiguredAiReviewerController({
      configStore: { get: vi.fn(async () => otherConnection) },
      providerService,
      requestScopeReader: {
        read: vi.fn(async () => ({
          kind: "project",
          readProjectFile,
        })),
      },
      now: () => createdAt,
      eventId: () => "event-provider-error",
    });
    const response = new FakeResponse();
    const stream = controller.stream(
      httpRequest({ body: projectRequest() }),
      response,
    );

    await waitingForCompletion.promise;
    expect(parseNdjson(response).map((event) => event.type)).toEqual([
      "started",
    ]);
    releaseCompletion.resolve();
    await stream;
    expect(parseNdjson(response).map((event) => event.type)).toEqual([
      "started",
      "text.delta",
      "completed",
    ]);
  });

  it("records the native provider discriminator in the shape-only failure record", async function () {
    const failureRecorder = vi.fn();
    const providerService = {
      ...runModelStubs([{ id: geminiModel, displayName: geminiModel }]),
      createAgentGateway: vi.fn(() => {
        throw new AgentGatewayError("PRIVATE_NATIVE_PROVIDER_FAILURE", {
          code: "AI_PROVIDER_FAILED",
          category: "provider",
          retryable: true,
        });
      }),
    };
    const controller = createConfiguredAiReviewerController({
      configStore: { get: vi.fn(async () => geminiConnection) },
      providerService,
      requestScopeReader: {
        read: vi.fn(async () => ({
          readProjectFile: vi.fn(),
          projectContext: undefined,
          searchZotero: undefined,
          validateEvidence: undefined,
        })),
      },
      now: () => createdAt,
      eventId: () => "event-native-provider-error",
      elapsedNow: vi.fn().mockReturnValueOnce(100).mockReturnValue(108.4),
      failureRecorder,
    });
    const response = new FakeResponse();

    await controller.stream(
      httpRequest({ body: selectionRequest() }),
      response,
    );

    expect(failureRecorder).toHaveBeenCalledExactlyOnceWith({
      requestId: selectionRequest().requestId,
      provider: "gemini",
      model: geminiModel,
      scopeKind: "selection",
      failureCategory: "provider",
      failureCode: "AI_PROVIDER_FAILED",
      providerStatusCode: null,
      providerErrorType: null,
      elapsedMs: 8,
    });
    expect(Object.keys(failureRecorder.mock.calls[0][0])).toEqual([
      "requestId",
      "provider",
      "model",
      "scopeKind",
      "failureCategory",
      "failureCode",
      "providerStatusCode",
      "providerErrorType",
      "elapsedMs",
    ]);
    expect(response.chunks.join("")).not.toContain(
      "PRIVATE_NATIVE_PROVIDER_FAILURE",
    );
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
      configStore: { get: vi.fn(async () => otherConnection) },
      providerService: {
        ...runModelStubs(),
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
      model: otherModel,
      scopeKind: "project",
      failureCategory: "configuration",
      failureCode: "AI_PROJECT_CONTENT_NOT_AVAILABLE",
      providerStatusCode: null,
      providerErrorType: null,
      elapsedMs: 19,
    });
    expect(JSON.stringify(failureRecorder.mock.calls)).not.toContain(
      privateTitle,
    );
  });

  it("selects, validates, and re-budgets an explicit run model", async function () {
    const selectedModel = "reviewer/selected-v2";
    const selectedContextLength = 16_384;
    const requestScopeReader = {
      read: vi.fn(async () => ({
        kind: "selection",
        readProjectFile: vi.fn(),
      })),
    };
    const providerService = {
      listModels: vi.fn(async () => [
        { id: otherModel, displayName: otherModel },
        { id: selectedModel, displayName: selectedModel },
      ]),
      resolveContextLength: vi.fn(async () => ({
        contextLength: selectedContextLength,
        contextLengthSource: "default",
      })),
      createAgentGateway: vi.fn(() => ({
        async *stream() {
          yield* streamEvents();
        },
      })),
    };
    const controller = createConfiguredAiReviewerController({
      configStore: { get: vi.fn(async () => otherConnection) },
      providerService,
      requestScopeReader,
      now: () => createdAt,
      eventId: () => "event-model-selection",
    });
    const response = new FakeResponse();
    await controller.stream(
      httpRequest({
        body: { ...selectionRequest(), model: selectedModel },
      }),
      response,
    );

    expect(providerService.listModels).toHaveBeenCalledWith(
      otherConnection,
      expect.objectContaining({
        cacheKey: `${userId}\u0000${storedConnectionId}`,
      }),
    );
    expect(providerService.resolveContextLength).toHaveBeenCalledWith(
      otherConnection,
      selectedModel,
    );
    expect(requestScopeReader.read).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ contextLength: selectedContextLength }),
    );
    expect(providerService.createAgentGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai-compatible",
        model: selectedModel,
        contextLength: selectedContextLength,
      }),
      expect.anything(),
    );
  });

  it("rejects an unlisted run model without exposing private provider data", async function () {
    const privateResponse = "PRIVATE_MODEL_LIST_RESPONSE";
    const providerService = {
      listModels: vi.fn(async () => [
        { id: otherModel, displayName: privateResponse },
      ]),
      resolveContextLength: vi.fn(),
      createAgentGateway: vi.fn(),
    };
    const requestScopeReader = { read: vi.fn() };
    const controller = createConfiguredAiReviewerController({
      configStore: { get: vi.fn(async () => credentialConnection) },
      providerService,
      requestScopeReader,
      now: () => createdAt,
      eventId: () => "event-invalid-model",
    });
    const response = new FakeResponse();
    await controller.stream(
      httpRequest({
        body: { ...selectionRequest(), model: "other-provider/model" },
      }),
      response,
    );

    expect(parseNdjson(response)[0].error).toEqual({
      code: "AI_PROVIDER_NOT_CONFIGURED",
      category: "configuration",
      message:
        "AI Reviewer is not configured correctly. Check the provider and model in AI Reviewer settings, then try again.",
      retryable: false,
    });
    expect(response.chunks.join("")).not.toContain(credential);
    expect(response.chunks.join("")).not.toContain(privateResponse);
    expect(providerService.resolveContextLength).not.toHaveBeenCalled();
    expect(providerService.createAgentGateway).not.toHaveBeenCalled();
    expect(requestScopeReader.read).not.toHaveBeenCalled();
  });

  it("keeps provider credentials outside requests and accepts legacy runs", function () {
    expect(
      AgentRequestSchema.safeParse({
        ...selectionRequest(),
        provider: "claude",
      }).success,
    ).toBe(false);
    expect(
      AgentRequestSchema.safeParse({
        ...selectionRequest(),
        credential,
      }).success,
    ).toBe(false);
    expect(
      WorkspaceRunSchema.safeParse({
        generation: 1,
        createdOrder: 1,
        request: selectionRequest(),
        text: "",
        findings: [],
        suggestions: [],
      }).success,
    ).toBe(true);
  });
});
