import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { AgentGatewayError } from "../../../app/src/AgentGateway.mjs";
import {
  parseAiReviewerProviderConfig,
  publicAiReviewerProviderConfig,
} from "../../../app/src/AiReviewerProviderConfig.mjs";
import { createAiReviewerProviderConfigStore } from "../../../app/src/AiReviewerProviderConfigStore.mjs";
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
const model = "overleaf-ai-reviewer-compat-8k:latest";
const otherModel = "overleaf-ai-reviewer-other:latest";
const contextLength = 8_192;
const otherContextLength = 4_096;
const createdAt = "2026-07-25T00:00:00.000Z";

const configuration = Object.freeze({
  provider: "ollama",
  baseUrl,
  model,
  contextLength,
});
const otherConfiguration = Object.freeze({
  provider: "ollama",
  baseUrl: otherBaseUrl,
  model: otherModel,
  contextLength: otherContextLength,
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
      provider: "ollama",
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
      provider: "ollama",
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
  const query = {
    exec: vi.fn(async () => value),
  };
  query.lean = vi.fn(() => query);
  return query;
}

function inMemoryModel() {
  const records = new Map();
  const modelDependency = {
    findOne: vi.fn(({ _id }) =>
      fakeQuery(records.has(_id) ? { _id, ...records.get(_id) } : null),
    ),
    findOneAndUpdate: vi.fn(({ _id }, update) => {
      records.set(_id, Object.freeze({ ...update.$set }));
      return fakeQuery({ _id, ...records.get(_id) });
    }),
  };
  return { modelDependency, records };
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
      provider: "ollama",
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
  it("accepts only a strict local Ollama configuration and returns a bounded public DTO", function () {
    const parsed = parseAiReviewerProviderConfig(configuration);
    expect(parsed).toEqual(configuration);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(publicAiReviewerProviderConfig(parsed)).toEqual({
      configured: true,
      config: configuration,
      classification: "local",
    });

    for (const invalid of [
      null,
      {},
      { provider: "openai", baseUrl, model },
      { provider: "ollama", baseUrl, model },
      { ...configuration, baseUrl: "http://192.168.1.2:11434/v1" },
      { ...configuration, model: "implicit-latest" },
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
  });

  it("gets and saves each user's configuration only through its _id", async function () {
    const firstRecord = { _id: userId, ...configuration, updatedAt: createdAt };
    const secondRecord = { _id: otherUserId, ...otherConfiguration };
    const modelDependency = {
      findOne: vi
        .fn()
        .mockReturnValueOnce(fakeQuery(firstRecord))
        .mockReturnValueOnce(fakeQuery(secondRecord)),
      findOneAndUpdate: vi
        .fn()
        .mockReturnValueOnce(fakeQuery(firstRecord))
        .mockReturnValueOnce(fakeQuery(secondRecord)),
    };
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
    ).toEqual([{ _id: userId }, { _id: otherUserId }]);
    expect(
      modelDependency.findOneAndUpdate.mock.calls.map(([filter]) => filter),
    ).toEqual([{ _id: userId }, { _id: otherUserId }]);
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
      provider: "ollama",
      model,
      classification: "local",
    });
    expect(transportFactory).toHaveBeenCalledExactlyOnceWith({
      baseUrl,
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
      config: configuration,
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
      config: configuration,
      classification: "local",
    });

    const invalidResponse = new FakeResponse();
    await controller.saveConfiguration(
      httpRequest({ body: { ...configuration, apiKey: "PRIVATE_SECRET" } }),
      invalidResponse,
    );
    expect(invalidResponse.statusCode).toBe(400);
    expect(JSON.stringify(invalidResponse.body)).not.toContain(
      "PRIVATE_SECRET",
    );
    expect(store.save).toHaveBeenCalledOnce();
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
      provider: "ollama",
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
    expect(records.get(userId)).toEqual(otherConfiguration);

    const response = new FakeResponse();
    await configuredController.stream(
      httpRequest({ body: selectionRequest() }),
      response,
    );
    expect(transportFactory).toHaveBeenCalledExactlyOnceWith({
      baseUrl: otherBaseUrl,
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
      configStore: { get: vi.fn(async () => otherConfiguration) },
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
      baseUrl: otherBaseUrl,
      modelTag: otherModel,
    });
    expect(transport.createDiscussionGateway).toHaveBeenCalledExactlyOnceWith({
      contextLength: otherContextLength,
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
          message: "The project content could not be read for review.",
          retryable: false,
        },
      },
    ]);
    expect(response.chunks.join("")).not.toContain(privateTitle);
  });
});
