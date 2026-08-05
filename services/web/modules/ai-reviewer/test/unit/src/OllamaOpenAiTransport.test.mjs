import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { APICallError } from "ai";
import { Agent } from "undici";
import { describe, expect, it, vi } from "vitest";

import {
  AiSdkAgentGateway,
  classifySdkError,
} from "../../../app/src/AiSdkAgentGateway.mjs";
import { AgentGatewayError } from "../../../app/src/AgentGateway.mjs";
import { OllamaOpenAiTransport } from "../../../app/src/OllamaOpenAiTransport.mjs";

const appSourceDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../app/src",
);
const baseUrl = "http://127.0.0.1:11434/v1";
const modelTag = "overleaf-ai-reviewer-compat-8k:latest";
const streamPrompt =
  "Return exactly 80 copies of OK separated by one ASCII space and nothing else.";
const streamRequest = Object.freeze({
  prompt: streamPrompt,
  maxOutputTokens: 96,
});
const structuredSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status", "id", "count"],
  properties: {
    status: {
      const: "ok",
    },
    id: {
      const: "SYNTH-001",
    },
    count: {
      const: 3,
    },
  },
};
const forcedTool = {
  type: "function",
  function: {
    name: "lookup_synthetic_record",
    description: "Return one fixed synthetic record.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: {
        id: {
          const: "SYNTH-001",
        },
      },
    },
  },
};

function listProductionSourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listProductionSourceFiles(absolutePath);
    }
    return /\.(?:cjs|js|mjs|ts|tsx)$/u.test(entry.name) ? [absolutePath] : [];
  });
}

function concreteModel() {
  return {
    specificationVersion: "v3",
    doGenerate: vi.fn(),
    doStream: vi.fn(),
  };
}

function transportFixture(overrides = {}) {
  const model = concreteModel();
  const chatModel = vi.fn(() => model);
  const provider = { chatModel };
  const createProvider = vi.fn(() => provider);
  const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
  const transport = new OllamaOpenAiTransport({
    baseUrl,
    modelTag,
    createProvider,
    fetchImpl,
    ...overrides,
  });
  return {
    chatModel,
    createProvider,
    fetchImpl,
    model,
    provider,
    transport,
  };
}

function plainGenerateResult(overrides = {}) {
  return {
    content: [{ type: "text", text: "COMPAT_OK" }],
    finishReason: {
      unified: "stop",
      raw: "stop",
    },
    usage: {
      inputTokens: {
        total: 12,
      },
      outputTokens: {
        total: 3,
      },
    },
    warnings: [],
    ...overrides,
  };
}

function plainStructuredResult(overrides = {}) {
  return plainGenerateResult({
    content: [
      {
        type: "text",
        text: JSON.stringify({
          status: "ok",
          id: "SYNTH-001",
          count: 3,
        }),
      },
    ],
    ...overrides,
  });
}

function plainToolProposalResult(overrides = {}) {
  return plainGenerateResult({
    content: [
      {
        type: "tool-call",
        toolCallId: "synthetic-call-001",
        toolName: "lookup_synthetic_record",
        input: JSON.stringify({
          id: "SYNTH-001",
        }),
      },
    ],
    finishReason: {
      unified: "tool-calls",
      raw: "tool_calls",
    },
    ...overrides,
  });
}

function plainStreamParts(overrides = {}) {
  const parts = [
    {
      type: "stream-start",
      warnings: [],
    },
    {
      type: "response-metadata",
      id: "synthetic-response",
      modelId: modelTag,
    },
    {
      type: "text-start",
      id: "0",
    },
    {
      type: "text-delta",
      id: "0",
      delta: "",
    },
    {
      type: "text-delta",
      id: "0",
      delta: "OK ",
    },
    {
      type: "text-delta",
      id: "0",
      delta: "OK",
    },
    {
      type: "text-end",
      id: "0",
    },
    {
      type: "finish",
      finishReason: {
        unified: "stop",
        raw: "stop",
      },
      usage: {
        inputTokens: {
          total: 528,
        },
        outputTokens: {
          total: 80,
        },
      },
    },
  ];
  return Object.hasOwn(overrides, "parts") ? overrides.parts : parts;
}

function providerStreamResult(parts = plainStreamParts(), options = {}) {
  const cancel = options.cancel ?? vi.fn();
  const stream = new ReadableStream({
    start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
      }
      if (options.close !== false) {
        options.beforeClose?.();
        controller.close();
      }
    },
    cancel,
  });
  return {
    result: {
      stream,
    },
    cancel,
    stream,
  };
}

function readerStreamFixture(read, overrides = {}) {
  const cancel = overrides.cancel ?? vi.fn();
  const releaseLock = overrides.releaseLock ?? vi.fn();
  const reader = {
    read: vi.fn(read),
    cancel,
    releaseLock,
  };
  const getReader = vi.fn(() => reader);
  return {
    result: {
      stream: {
        getReader,
      },
    },
    cancel,
    getReader,
    reader,
    releaseLock,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {
    promise,
    reject,
    resolve,
  };
}

async function collectStream(iterable, onEvent = () => {}) {
  const events = [];
  for await (const event of iterable) {
    events.push(event);
    await onEvent(event);
  }
  return events;
}

function captureStream(transport, input = streamRequest, options) {
  return collectStream(transport.streamChat(input, options));
}

async function captureError(work) {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject.");
}

function providerAgentGatewayError(marker) {
  return new AgentGatewayError(`AI_REVIEWER_${marker}_PRIVATE`, {
    code: `AI_REVIEWER_${marker}_PRIVATE_CODE`,
    category: "authentication",
    retryable: false,
  });
}

function providerConstructionThrower(boundary, thrownValue) {
  if (boundary === "factory invocation") {
    return function createProvider() {
      throw thrownValue;
    };
  }
  if (boundary === "chatModel getter") {
    return function createProvider() {
      const provider = {};
      Object.defineProperty(provider, "chatModel", {
        get() {
          throw thrownValue;
        },
      });
      return provider;
    };
  }
  if (boundary === "chatModel invocation") {
    return function createProvider() {
      return {
        chatModel() {
          throw thrownValue;
        },
      };
    };
  }
  return function createProvider() {
    const model = {};
    Object.defineProperty(model, "specificationVersion", {
      get() {
        throw thrownValue;
      },
    });
    return {
      chatModel() {
        return model;
      },
    };
  };
}

async function flushProviderPromiseObservation() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function createDirectInvocation(fixture, name) {
  if (name === "chat") {
    return (options) =>
      fixture.transport.generateChat(
        {
          prompt: "Return exactly COMPAT_OK and nothing else.",
          maxOutputTokens: 32,
        },
        options,
      );
  }
  if (name === "structured") {
    return (options) =>
      fixture.transport.generateStructuredChat(
        {
          prompt: "Return one synthetic JSON object.",
          maxOutputTokens: 32,
          schema: structuredSchema,
        },
        options,
      );
  }
  if (name === "tool proposal") {
    return (options) =>
      fixture.transport.proposeForcedToolCall(
        {
          prompt: "Call the synthetic lookup tool.",
          maxOutputTokens: 32,
          tool: forcedTool,
        },
        options,
      );
  }
  fixture.model.doGenerate.mockResolvedValueOnce(plainToolProposalResult());
  const proposal = await fixture.transport.proposeForcedToolCall({
    prompt: "Call the synthetic lookup tool.",
    maxOutputTokens: 64,
    tool: forcedTool,
  });
  return (options) =>
    fixture.transport.continueToolCall(
      {
        proposal,
        toolResult: {
          id: "SYNTH-001",
          value: "synthetic",
        },
        maxOutputTokens: 32,
      },
      options,
    );
}

describe("AI reviewer: Ollama OpenAI transport", function () {
  it("constructs only an explicit Chat Completions model", function () {
    const fixture = transportFixture();

    expect(fixture.createProvider).toHaveBeenCalledOnce();
    expect(fixture.createProvider).toHaveBeenCalledWith({
      baseURL: baseUrl,
      fetch: expect.any(Function),
      includeUsage: true,
      name: "openai-compatible",
      supportsStructuredOutputs: true,
    });
    expect(fixture.chatModel).toHaveBeenCalledExactlyOnceWith(modelTag);
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
  });

  it("blocks an HTTP Chat Completions credential before provider construction", function () {
    const createProvider = vi.fn();
    const fetchImpl = vi.fn();

    expect(
      () =>
        new OllamaOpenAiTransport({
          baseUrl,
          credential: "PRIVATE_CHAT_COMPLETIONS_CREDENTIAL",
          modelTag,
          createProvider,
          fetchImpl,
        }),
    ).toThrow("The API key was not sent because the endpoint uses HTTP");
    expect(createProvider).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("passes an HTTPS localhost credential only to the provider SDK", function () {
    const encryptedLocalBaseUrl = "https://localhost:8443/v1";
    const credential = "PRIVATE_HTTPS_LOCALHOST_CREDENTIAL";
    const model = concreteModel();
    const createProvider = vi.fn(() => ({
      chatModel: vi.fn(() => model),
    }));
    const fetchImpl = vi.fn();

    new OllamaOpenAiTransport({
      baseUrl: encryptedLocalBaseUrl,
      credential,
      modelTag,
      createProvider,
      fetchImpl,
    });

    expect(createProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: credential,
        baseURL: encryptedLocalBaseUrl,
      }),
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("constructs the real function provider without making a request", function () {
    const fetchImpl = vi.fn();
    const transport = new OllamaOpenAiTransport({
      baseUrl,
      modelTag,
      fetchImpl,
    });
    const gateway = transport.createAgentGateway({
      contextLength: 8_192,
      readProjectFile: vi.fn(),
    });

    expect(gateway).toBeInstanceOf(AiSdkAgentGateway);
    expect(gateway).toMatchObject({
      provider: "openai-compatible",
      modelId: modelTag,
    });
    expect(gateway.model).toMatchObject({
      specificationVersion: "v3",
    });
    expect(typeof gateway.model.doGenerate).toBe("function");
    expect(typeof gateway.model.doStream).toBe("function");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("keeps the Ollama grammar projection and strict finding declaration", async function () {
    let requestBody;
    const fetchImpl = vi.fn(async (input, init) => {
      expect(String(input)).toBe(`${baseUrl}/chat/completions`);
      expect(init).toMatchObject({
        method: "POST",
        redirect: "error",
        dispatcher: expect.any(Agent),
      });
      const headers = new Headers(init.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("user-agent")).toContain(
        "ai-sdk/openai-compatible/2.0.42",
      );
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ error: { message: "synthetic" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    });
    const transport = new OllamaOpenAiTransport({
      baseUrl,
      modelTag,
      fetchImpl,
    });
    const gateway = transport.createAgentGateway({
      contextLength: 8_192,
      readProjectFile: vi.fn(),
    });

    await captureError(
      collectStream(
        gateway.stream({
          requestId: "request-ollama-schema-0001",
          projectId: "project-ollama-schema-0001",
          action: "review",
          instruction: "Review the synthetic project.",
          skill: null,
          scope: { kind: "project" },
        }),
      ),
    );

    const findingDeclaration = requestBody.tools.find(
      (declaration) => declaration.function.name === "report_finding",
    ).function;
    expect(findingDeclaration.strict).toBe(true);
    expect(findingDeclaration.parameters).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        category: { type: "string" },
        evidence: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: { type: "string" },
            },
          },
        },
      },
    });
    expect(JSON.stringify(findingDeclaration.parameters)).not.toMatch(
      /"(?:maxItems|maxLength|maximum|minItems|minLength|minimum|pattern)":/u,
    );
  });

  it("creates the production gateway without exposing an SDK model getter", function () {
    const fixture = transportFixture();
    const readProjectFile = vi.fn();
    const skills = [
      {
        name: "Evidence audit",
        description: "Check whether claims are supported.",
        body: "PRIVATE_SKILL_BODY",
        referenceFiles: {},
      },
    ];
    const gateway = fixture.transport.createAgentGateway({
      contextLength: 8_192,
      skills,
      readProjectFile,
      now: () => "2026-07-25T00:00:00.000Z",
      createId: () => "synthetic-id",
    });

    expect(gateway).toBeInstanceOf(AiSdkAgentGateway);
    expect(gateway).toMatchObject({
      provider: "openai-compatible",
      modelId: modelTag,
      providerOptions: {
        openaiCompatible: {
          reasoningEffort: "none",
        },
      },
      skills: [
        expect.objectContaining({
          name: "Evidence audit",
          description: "Check whether claims are supported.",
          body: "PRIVATE_SKILL_BODY",
        }),
      ],
      readProjectFile,
    });
    expect("languageModel" in fixture.transport).toBe(false);
    expect("model" in fixture.transport).toBe(false);
    expect(Reflect.ownKeys(fixture.transport)).toEqual([]);
  });

  it("generates one fixed non-stream request without a generation cap", async function () {
    const fixture = transportFixture();
    const controller = new AbortController();
    fixture.model.doGenerate.mockResolvedValue({
      content: [{ type: "text", text: "COMPAT_OK" }],
      finishReason: {
        unified: "stop",
        raw: "stop",
      },
      usage: {
        inputTokens: {
          total: 12,
          noCache: 12,
          cacheRead: 0,
          cacheWrite: 0,
        },
        outputTokens: {
          total: 3,
          text: 3,
          reasoning: 0,
        },
        raw: {
          prompt_tokens: 12,
          completion_tokens: 3,
        },
      },
      warnings: [],
      request: {
        body: "AI_REVIEWER_REQUEST_BODY_SECRET",
      },
      response: {
        headers: {
          "x-ai-reviewer-secret": "response-header-secret",
        },
        body: "AI_REVIEWER_RESPONSE_BODY_SECRET",
      },
      providerMetadata: {
        openaiCompatible: {
          raw: "AI_REVIEWER_PROVIDER_METADATA_SECRET",
        },
      },
    });

    const result = await fixture.transport.generateChat(
      {
        prompt: "Return exactly COMPAT_OK and nothing else.",
      },
      {
        signal: controller.signal,
      },
    );

    expect(fixture.model.doGenerate).toHaveBeenCalledExactlyOnceWith({
      prompt: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Return exactly COMPAT_OK and nothing else.",
            },
          ],
        },
      ],
      temperature: 0,
      topP: 1,
      seed: 424242,
      responseFormat: {
        type: "text",
      },
      providerOptions: {
        openaiCompatible: {
          parallel_tool_calls: false,
          reasoningEffort: "none",
          strictJsonSchema: true,
        },
      },
      abortSignal: controller.signal,
    });
    expect(fixture.model.doStream).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: "completed",
      text: "COMPAT_OK",
      toolCalls: [],
      finishReason: "stop",
      usage: {
        inputTokens: 12,
        outputTokens: 3,
      },
    });
    expect(Reflect.ownKeys(result).sort()).toEqual([
      "finishReason",
      "text",
      "toolCalls",
      "type",
      "usage",
    ]);
    expect(JSON.stringify(result)).not.toContain("AI_REVIEWER_");
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.toolCalls)).toBe(true);
    expect(Object.isFrozen(result.usage)).toBe(true);
  });

  it("generates one strict structured request and deep-freezes the validated JSON result", async function () {
    const fixture = transportFixture();
    fixture.model.doGenerate.mockResolvedValue(plainStructuredResult());

    const result = await fixture.transport.generateStructuredChat({
      prompt: "Return one synthetic record.",
      maxOutputTokens: 48,
      schema: structuredSchema,
    });

    expect(fixture.model.doGenerate).toHaveBeenCalledExactlyOnceWith({
      prompt: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Return one synthetic record.",
            },
          ],
        },
      ],
      maxOutputTokens: 48,
      temperature: 0,
      topP: 1,
      seed: 424242,
      responseFormat: {
        type: "json",
        schema: structuredSchema,
      },
      providerOptions: {
        openaiCompatible: {
          parallel_tool_calls: false,
          reasoningEffort: "none",
          strictJsonSchema: true,
        },
      },
      abortSignal: undefined,
    });
    expect(fixture.model.doStream).not.toHaveBeenCalled();
    expect(result).toEqual({
      type: "structured.completed",
      value: {
        status: "ok",
        id: "SYNTH-001",
        count: 3,
      },
      finishReason: "stop",
      usage: {
        inputTokens: 12,
        outputTokens: 3,
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.usage)).toBe(true);
  });

  it("deep-freezes every nested structured result value", async function () {
    const fixture = transportFixture();
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["record"],
      properties: {
        record: {
          type: "object",
          additionalProperties: false,
          required: ["items"],
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["value"],
                properties: {
                  value: {
                    type: "string",
                  },
                },
              },
            },
          },
        },
      },
    };
    fixture.model.doGenerate.mockResolvedValue(
      plainStructuredResult({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              record: {
                items: [{ value: "synthetic" }],
              },
            }),
          },
        ],
      }),
    );

    const result = await fixture.transport.generateStructuredChat({
      prompt: "Return one nested synthetic record.",
      maxOutputTokens: 48,
      schema,
    });

    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.record)).toBe(true);
    expect(Object.isFrozen(result.value.record.items)).toBe(true);
    expect(Object.isFrozen(result.value.record.items[0])).toBe(true);
  });

  it("accepts a structured response carrying bounded provider warnings", async function () {
    const fixture = transportFixture();
    const secret = "AI_REVIEWER_WARNING_SECRET";
    fixture.model.doGenerate.mockResolvedValue(
      plainStructuredResult({
        warnings: [{ type: "other", message: secret }],
      }),
    );

    const result = await fixture.transport.generateStructuredChat({
      prompt: "Return one synthetic record.",
      maxOutputTokens: 48,
      schema: structuredSchema,
    });

    expect(result).toMatchObject({
      type: "structured.completed",
      value: { status: "ok", id: "SYNTH-001", count: 3 },
    });
    expect(String(result)).not.toContain(secret);
  });

  it.each([
    {
      name: "malformed JSON",
      result: plainStructuredResult({
        content: [{ type: "text", text: '{"status":' }],
      }),
    },
    {
      name: "additional property",
      result: plainStructuredResult({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "ok",
              id: "SYNTH-001",
              count: 3,
              extra: true,
            }),
          },
        ],
      }),
    },
    {
      name: "missing property",
      result: plainStructuredResult({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "ok",
              id: "SYNTH-001",
            }),
          },
        ],
      }),
    },
    {
      name: "wrong const",
      result: plainStructuredResult({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              status: "wrong",
              id: "SYNTH-001",
              count: 3,
            }),
          },
        ],
      }),
    },
    {
      name: "non-object root",
      result: plainStructuredResult({
        content: [{ type: "text", text: "[]" }],
      }),
    },
    {
      name: "multiple text parts",
      result: plainStructuredResult({
        content: [
          { type: "text", text: '{"status":"ok",' },
          { type: "text", text: '"id":"SYNTH-001","count":3}' },
        ],
      }),
    },
    {
      name: "length finish",
      result: plainStructuredResult({
        finishReason: {
          unified: "length",
          raw: "length",
        },
      }),
    },
  ])("rejects structured result with $name", async function ({ result }) {
    const fixture = transportFixture();
    fixture.model.doGenerate.mockResolvedValue(result);

    const error = await captureError(
      fixture.transport.generateStructuredChat({
        prompt: "Return one synthetic record.",
        maxOutputTokens: 48,
        schema: structuredSchema,
      }),
    );

    expect(error).toMatchObject({
      code: "AI_PROVIDER_SCHEMA_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(error.message).not.toContain("AI_REVIEWER_");
    expect(fixture.model.doGenerate).toHaveBeenCalledOnce();
  });

  it("snapshots the structured schema before provider dispatch", async function () {
    const fixture = transportFixture();
    const mutableSchema = structuredClone(structuredSchema);
    let resolveProvider;
    fixture.model.doGenerate.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProvider = resolve;
        }),
    );
    const pending = fixture.transport.generateStructuredChat({
      prompt: "Return one synthetic record.",
      maxOutputTokens: 48,
      schema: mutableSchema,
    });
    await vi.waitFor(() => {
      expect(fixture.model.doGenerate).toHaveBeenCalledOnce();
    });

    mutableSchema.additionalProperties = true;
    mutableSchema.required.length = 0;
    resolveProvider(plainStructuredResult());
    const result = await pending;

    expect(result.type).toBe("structured.completed");
    expect(
      fixture.model.doGenerate.mock.calls[0][0].responseFormat.schema,
    ).toEqual(structuredSchema);
  });

  it("proposes exactly one forced read-only tool call without executing it", async function () {
    const fixture = transportFixture();
    fixture.model.doGenerate.mockResolvedValue(plainToolProposalResult());

    const proposal = await fixture.transport.proposeForcedToolCall({
      prompt: "Call the synthetic lookup once.",
      maxOutputTokens: 64,
      tool: forcedTool,
    });

    expect(fixture.model.doGenerate).toHaveBeenCalledExactlyOnceWith({
      prompt: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Call the synthetic lookup once.",
            },
          ],
        },
      ],
      maxOutputTokens: 64,
      temperature: 0,
      topP: 1,
      seed: 424242,
      responseFormat: {
        type: "text",
      },
      tools: [
        {
          type: "function",
          name: "lookup_synthetic_record",
          description: "Return one fixed synthetic record.",
          inputSchema: forcedTool.function.parameters,
        },
      ],
      toolChoice: {
        type: "tool",
        toolName: "lookup_synthetic_record",
      },
      providerOptions: {
        openaiCompatible: {
          parallel_tool_calls: false,
          reasoningEffort: "none",
          strictJsonSchema: true,
        },
      },
      abortSignal: undefined,
    });
    expect(proposal).toEqual({
      type: "tool.proposed",
      call: {
        id: "synthetic-call-001",
        name: "lookup_synthetic_record",
        input: {
          id: "SYNTH-001",
        },
      },
      finishReason: "tool-calls",
      usage: {
        inputTokens: 12,
        outputTokens: 3,
      },
    });
    expect(Object.isFrozen(proposal)).toBe(true);
    expect(Object.isFrozen(proposal.call)).toBe(true);
    expect(Object.isFrozen(proposal.call.input)).toBe(true);
    expect(Object.isFrozen(proposal.usage)).toBe(true);
    expect(fixture.model.doGenerate).toHaveBeenCalledOnce();
    expect(fixture.model.doStream).not.toHaveBeenCalled();
  });

  it("deep-freezes every nested forced-tool input value", async function () {
    const fixture = transportFixture();
    const nestedTool = {
      type: "function",
      function: {
        name: "lookup_nested_record",
        description: "Return one nested synthetic record.",
        parameters: {
          type: "object",
          additionalProperties: false,
          required: ["query"],
          properties: {
            query: {
              type: "object",
              additionalProperties: false,
              required: ["ids"],
              properties: {
                ids: {
                  type: "array",
                  items: {
                    type: "string",
                  },
                },
              },
            },
          },
        },
      },
    };
    fixture.model.doGenerate.mockResolvedValue(
      plainToolProposalResult({
        content: [
          {
            type: "tool-call",
            toolCallId: "synthetic-call-nested",
            toolName: "lookup_nested_record",
            input: JSON.stringify({
              query: {
                ids: ["SYNTH-001"],
              },
            }),
          },
        ],
      }),
    );

    const proposal = await fixture.transport.proposeForcedToolCall({
      prompt: "Call the nested synthetic lookup once.",
      maxOutputTokens: 64,
      tool: nestedTool,
    });

    expect(Object.isFrozen(proposal.call.input)).toBe(true);
    expect(Object.isFrozen(proposal.call.input.query)).toBe(true);
    expect(Object.isFrozen(proposal.call.input.query.ids)).toBe(true);
  });

  it("snapshots the forced-tool schema before provider dispatch", async function () {
    const fixture = transportFixture();
    const mutableTool = structuredClone(forcedTool);
    let resolveProvider;
    fixture.model.doGenerate.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProvider = resolve;
        }),
    );
    const pending = fixture.transport.proposeForcedToolCall({
      prompt: "Call the synthetic lookup once.",
      maxOutputTokens: 64,
      tool: mutableTool,
    });
    await vi.waitFor(() => {
      expect(fixture.model.doGenerate).toHaveBeenCalledOnce();
    });

    mutableTool.function.parameters.additionalProperties = true;
    mutableTool.function.parameters.required.length = 0;
    resolveProvider(plainToolProposalResult());
    await pending;

    expect(
      fixture.model.doGenerate.mock.calls[0][0].tools[0].inputSchema,
    ).toEqual(forcedTool.function.parameters);
  });

  it.each([
    {
      name: "no tool call",
      result: plainToolProposalResult({
        content: [],
      }),
    },
    {
      name: "multiple tool calls",
      result: plainToolProposalResult({
        content: [
          plainToolProposalResult().content[0],
          {
            ...plainToolProposalResult().content[0],
            toolCallId: "synthetic-call-002",
          },
        ],
      }),
    },
    {
      name: "mixed text",
      result: plainToolProposalResult({
        content: [
          { type: "text", text: "AI_REVIEWER_MIXED_SECRET" },
          plainToolProposalResult().content[0],
        ],
      }),
    },
    {
      name: "wrong finish reason",
      result: plainToolProposalResult({
        finishReason: {
          unified: "stop",
          raw: "stop",
        },
      }),
    },
    {
      name: "wrong tool name",
      result: plainToolProposalResult({
        content: [
          {
            ...plainToolProposalResult().content[0],
            toolName: "other_tool",
          },
        ],
      }),
    },
    {
      name: "invalid input JSON",
      result: plainToolProposalResult({
        content: [
          {
            ...plainToolProposalResult().content[0],
            input: '{"id":',
          },
        ],
      }),
    },
    {
      name: "input outside schema",
      result: plainToolProposalResult({
        content: [
          {
            ...plainToolProposalResult().content[0],
            input: JSON.stringify({
              id: "SYNTH-001",
              extra: true,
            }),
          },
        ],
      }),
    },
    {
      name: "provider-executed call",
      result: plainToolProposalResult({
        content: [
          {
            ...plainToolProposalResult().content[0],
            providerExecuted: true,
          },
        ],
      }),
    },
    {
      name: "dynamic call",
      result: plainToolProposalResult({
        content: [
          {
            ...plainToolProposalResult().content[0],
            dynamic: true,
          },
        ],
      }),
    },
    {
      name: "string provider-executed flag",
      result: plainToolProposalResult({
        content: [
          {
            ...plainToolProposalResult().content[0],
            providerExecuted: "false",
          },
        ],
      }),
    },
    {
      name: "numeric provider-executed flag",
      result: plainToolProposalResult({
        content: [
          {
            ...plainToolProposalResult().content[0],
            providerExecuted: 0,
          },
        ],
      }),
    },
    {
      name: "null provider-executed flag",
      result: plainToolProposalResult({
        content: [
          {
            ...plainToolProposalResult().content[0],
            providerExecuted: null,
          },
        ],
      }),
    },
    {
      name: "string dynamic flag",
      result: plainToolProposalResult({
        content: [
          {
            ...plainToolProposalResult().content[0],
            dynamic: "false",
          },
        ],
      }),
    },
    {
      name: "numeric dynamic flag",
      result: plainToolProposalResult({
        content: [
          {
            ...plainToolProposalResult().content[0],
            dynamic: 0,
          },
        ],
      }),
    },
    {
      name: "null dynamic flag",
      result: plainToolProposalResult({
        content: [
          {
            ...plainToolProposalResult().content[0],
            dynamic: null,
          },
        ],
      }),
    },
    {
      name: "empty call ID",
      result: plainToolProposalResult({
        content: [
          {
            ...plainToolProposalResult().content[0],
            toolCallId: "",
          },
        ],
      }),
    },
    {
      name: "overlong call ID",
      result: plainToolProposalResult({
        content: [
          {
            ...plainToolProposalResult().content[0],
            toolCallId: "x".repeat(257),
          },
        ],
      }),
    },
    {
      name: "space in call ID",
      result: plainToolProposalResult({
        content: [
          {
            ...plainToolProposalResult().content[0],
            toolCallId: "synthetic call",
          },
        ],
      }),
    },
    {
      name: "newline in call ID",
      result: plainToolProposalResult({
        content: [
          {
            ...plainToolProposalResult().content[0],
            toolCallId: "synthetic\ncall",
          },
        ],
      }),
    },
    {
      name: "DEL in call ID",
      result: plainToolProposalResult({
        content: [
          {
            ...plainToolProposalResult().content[0],
            toolCallId: `synthetic${String.fromCharCode(0x7f)}call`,
          },
        ],
      }),
    },
    {
      name: "non-string call ID",
      result: plainToolProposalResult({
        content: [
          {
            ...plainToolProposalResult().content[0],
            toolCallId: 42,
          },
        ],
      }),
    },
  ])("rejects forced tool proposal with $name", async function ({ result }) {
    const fixture = transportFixture();
    fixture.model.doGenerate.mockResolvedValue(result);

    const error = await captureError(
      fixture.transport.proposeForcedToolCall({
        prompt: "Call the synthetic lookup once.",
        maxOutputTokens: 64,
        tool: forcedTool,
      }),
    );

    expect(error).toMatchObject({
      code: "AI_PROVIDER_SCHEMA_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(error.message).not.toContain("AI_REVIEWER_");
    expect(fixture.model.doGenerate).toHaveBeenCalledOnce();
  });

  it("continues one issued proposal with a private bound snapshot and no tool list", async function () {
    const fixture = transportFixture();
    fixture.model.doGenerate
      .mockResolvedValueOnce(plainToolProposalResult())
      .mockResolvedValueOnce(
        plainGenerateResult({
          content: [{ type: "text", text: "TOOL_OK" }],
        }),
      );
    const proposal = await fixture.transport.proposeForcedToolCall({
      prompt: "Call the synthetic lookup once.",
      maxOutputTokens: 64,
      tool: forcedTool,
    });

    const result = await fixture.transport.continueToolCall({
      proposal,
      toolResult: {
        id: "SYNTH-001",
        value: "synthetic",
      },
      maxOutputTokens: 32,
    });

    expect(fixture.model.doGenerate).toHaveBeenCalledTimes(2);
    expect(fixture.model.doGenerate.mock.calls[1][0]).toEqual({
      prompt: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Call the synthetic lookup once.",
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "synthetic-call-001",
              toolName: "lookup_synthetic_record",
              input: {
                id: "SYNTH-001",
              },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "synthetic-call-001",
              toolName: "lookup_synthetic_record",
              output: {
                type: "json",
                value: {
                  id: "SYNTH-001",
                  value: "synthetic",
                },
              },
            },
          ],
        },
      ],
      maxOutputTokens: 32,
      temperature: 0,
      topP: 1,
      seed: 424242,
      responseFormat: {
        type: "text",
      },
      providerOptions: {
        openaiCompatible: {
          parallel_tool_calls: false,
          reasoningEffort: "none",
          strictJsonSchema: true,
        },
      },
      abortSignal: undefined,
    });
    expect(result).toEqual({
      type: "completed",
      text: "TOOL_OK",
      toolCalls: [],
      finishReason: "stop",
      usage: {
        inputTokens: 12,
        outputTokens: 3,
      },
    });
  });

  it("rejects forged, cross-transport, concurrent, and reused proposals before dispatch", async function () {
    const fixture = transportFixture();
    fixture.model.doGenerate
      .mockResolvedValueOnce(plainToolProposalResult())
      .mockImplementationOnce(() => new Promise(() => {}));
    const proposal = await fixture.transport.proposeForcedToolCall({
      prompt: "Call the synthetic lookup once.",
      maxOutputTokens: 64,
      tool: forcedTool,
    });
    const otherFixture = transportFixture();
    const continuation = {
      proposal,
      toolResult: {
        id: "SYNTH-001",
        value: "synthetic",
      },
      maxOutputTokens: 32,
    };

    const forgedError = await captureError(
      fixture.transport.continueToolCall({
        ...continuation,
        proposal: structuredClone(proposal),
      }),
    );
    expect(forgedError).toBeInstanceOf(TypeError);
    expect(forgedError.message).toContain("proposal");

    const crossTransportError = await captureError(
      otherFixture.transport.continueToolCall(continuation),
    );
    expect(crossTransportError).toBeInstanceOf(TypeError);
    expect(crossTransportError.message).toContain("proposal");

    const firstUse = fixture.transport.continueToolCall(continuation);
    await vi.waitFor(() => {
      expect(fixture.model.doGenerate).toHaveBeenCalledTimes(2);
    });
    const reusedError = await captureError(
      fixture.transport.continueToolCall(continuation),
    );
    expect(reusedError).toBeInstanceOf(TypeError);
    expect(reusedError.message).toContain("proposal");
    expect(fixture.model.doGenerate).toHaveBeenCalledTimes(2);
    expect(otherFixture.model.doGenerate).not.toHaveBeenCalled();

    // Prevent a permanently pending synthetic provider from keeping the test
    // process alive through an unobserved promise.
    void firstUse.catch(() => {});
  });

  it("snapshots the tool result before continuation dispatch", async function () {
    const fixture = transportFixture();
    let resolveContinuation;
    fixture.model.doGenerate
      .mockResolvedValueOnce(plainToolProposalResult())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveContinuation = resolve;
          }),
      );
    const proposal = await fixture.transport.proposeForcedToolCall({
      prompt: "Call the synthetic lookup once.",
      maxOutputTokens: 64,
      tool: forcedTool,
    });
    const toolResult = {
      id: "SYNTH-001",
      value: "synthetic",
      metadata: {
        labels: ["synthetic"],
      },
    };
    const pending = fixture.transport.continueToolCall({
      proposal,
      toolResult,
      maxOutputTokens: 32,
    });
    await vi.waitFor(() => {
      expect(fixture.model.doGenerate).toHaveBeenCalledTimes(2);
    });

    toolResult.id = "MUTATED";
    toolResult.value = "MUTATED";
    toolResult.metadata.labels[0] = "MUTATED";
    resolveContinuation(
      plainGenerateResult({
        content: [{ type: "text", text: "TOOL_OK" }],
      }),
    );
    await pending;

    expect(
      fixture.model.doGenerate.mock.calls[1][0].prompt[2].content[0].output
        .value,
    ).toEqual({
      id: "SYNTH-001",
      value: "synthetic",
      metadata: {
        labels: ["synthetic"],
      },
    });
    const toolResultSnapshot =
      fixture.model.doGenerate.mock.calls[1][0].prompt[2].content[0].output
        .value;
    expect(Object.isFrozen(toolResultSnapshot)).toBe(true);
    expect(Object.isFrozen(toolResultSnapshot.metadata)).toBe(true);
    expect(Object.isFrozen(toolResultSnapshot.metadata.labels)).toBe(true);
  });

  it.each([
    {
      name: "another tool call",
      result: plainToolProposalResult(),
    },
    {
      name: "multiple text parts",
      result: plainGenerateResult({
        content: [
          { type: "text", text: "TOOL_" },
          { type: "text", text: "OK" },
        ],
      }),
    },
    {
      name: "length finish",
      result: plainGenerateResult({
        content: [{ type: "text", text: "TOOL_OK" }],
        finishReason: {
          unified: "length",
          raw: "length",
        },
      }),
    },
  ])(
    "rejects tool continuation result with $name",
    async function ({ result }) {
      const fixture = transportFixture();
      fixture.model.doGenerate
        .mockResolvedValueOnce(plainToolProposalResult())
        .mockResolvedValueOnce(result);
      const proposal = await fixture.transport.proposeForcedToolCall({
        prompt: "Call the synthetic lookup once.",
        maxOutputTokens: 64,
        tool: forcedTool,
      });

      const error = await captureError(
        fixture.transport.continueToolCall({
          proposal,
          toolResult: {
            id: "SYNTH-001",
            value: "synthetic",
          },
          maxOutputTokens: 32,
        }),
      );

      expect(error).toMatchObject({
        code: "AI_PROVIDER_SCHEMA_INVALID",
        category: "schema",
        retryable: false,
      });
    },
  );

  it.each([
    {
      name: "structured",
      run(transport) {
        return transport.generateStructuredChat({
          prompt: "Return one synthetic record.",
          maxOutputTokens: 48,
          schema: structuredSchema,
          extra: true,
        });
      },
    },
    {
      name: "tool proposal",
      run(transport) {
        return transport.proposeForcedToolCall({
          prompt: "Call the synthetic lookup once.",
          maxOutputTokens: 64,
          tool: {
            ...forcedTool,
            execute() {},
          },
        });
      },
    },
  ])(
    "rejects unknown $name input fields before dispatch",
    async function ({ run }) {
      const fixture = transportFixture();

      const error = await captureError(run(fixture.transport));
      expect(error).toBeInstanceOf(TypeError);

      expect(fixture.model.doGenerate).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "structured top-level request",
      run(transport, hostileRecord) {
        return transport.generateStructuredChat(hostileRecord);
      },
    },
    {
      name: "nested tool function",
      run(transport, hostileRecord) {
        return transport.proposeForcedToolCall({
          prompt: "Call the synthetic lookup once.",
          maxOutputTokens: 64,
          tool: {
            type: "function",
            function: hostileRecord,
          },
        });
      },
    },
    {
      name: "tool continuation request",
      run(transport, hostileRecord) {
        return transport.continueToolCall(hostileRecord);
      },
    },
  ])(
    "bounds a hostile $name prototype trap before dispatch",
    async function ({ run }) {
      const fixture = transportFixture();
      const hostileRecord = new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error("AI_REVIEWER_INPUT_PROXY_SECRET");
          },
        },
      );

      const error = await captureError(run(fixture.transport, hostileRecord));

      expect(error).toBeInstanceOf(TypeError);
      expect(error.message).not.toContain("AI_REVIEWER_INPUT_PROXY_SECRET");
      expect(fixture.model.doGenerate).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      name: "structured",
      run(transport, signal) {
        return transport.generateStructuredChat({}, { signal });
      },
    },
    {
      name: "tool proposal",
      run(transport, signal) {
        return transport.proposeForcedToolCall({}, { signal });
      },
    },
    {
      name: "tool continuation",
      run(transport, signal) {
        return transport.continueToolCall({}, { signal });
      },
    },
  ])(
    "prioritizes an already aborted signal over malformed $name input",
    async function ({ run }) {
      const fixture = transportFixture();
      const controller = new AbortController();
      controller.abort(
        new DOMException("Synthetic input cancellation.", "AbortError"),
      );

      const error = await captureError(
        run(fixture.transport, controller.signal),
      );

      expect(error).toMatchObject({
        code: "AI_REQUEST_ABORTED",
        category: "aborted",
        retryable: false,
      });
      expect(fixture.model.doGenerate).not.toHaveBeenCalled();
    },
  );

  it("does not inspect a valid request after its signal is already aborted", async function () {
    const fixture = transportFixture();
    const controller = new AbortController();
    controller.abort(
      new DOMException("Synthetic input cancellation.", "AbortError"),
    );
    const getPrototypeOf = vi.fn(() => Object.prototype);
    const request = new Proxy(
      {
        prompt: "Return one synthetic record.",
        maxOutputTokens: 48,
        schema: structuredSchema,
      },
      {
        getPrototypeOf,
      },
    );

    const error = await captureError(
      fixture.transport.generateStructuredChat(request, {
        signal: controller.signal,
      }),
    );

    expect(error).toMatchObject({
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    expect(getPrototypeOf).not.toHaveBeenCalled();
    expect(fixture.model.doGenerate).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "top-level structured request",
      run(transport, hostileValue, signal) {
        return transport.generateStructuredChat(hostileValue, { signal });
      },
    },
    {
      name: "nested structured schema",
      run(transport, hostileValue, signal) {
        return transport.generateStructuredChat(
          {
            prompt: "Return one synthetic record.",
            maxOutputTokens: 48,
            schema: hostileValue,
          },
          { signal },
        );
      },
    },
    {
      name: "nested tool schema",
      run(transport, hostileValue, signal) {
        const tool = structuredClone(forcedTool);
        tool.function.parameters = hostileValue;
        return transport.proposeForcedToolCall(
          {
            prompt: "Call the synthetic lookup once.",
            maxOutputTokens: 64,
            tool,
          },
          { signal },
        );
      },
    },
  ])(
    "prioritizes abort raised by a $name prototype trap",
    async function ({ run }) {
      const fixture = transportFixture();
      const controller = new AbortController();
      const hostileValue = new Proxy(
        {},
        {
          getPrototypeOf() {
            controller.abort(
              new DOMException("Synthetic proxy cancellation.", "AbortError"),
            );
            throw new Error("AI_REVIEWER_ABORT_PROXY_SECRET");
          },
        },
      );

      const error = await captureError(
        run(fixture.transport, hostileValue, controller.signal),
      );

      expect(error).toMatchObject({
        code: "AI_REQUEST_ABORTED",
        category: "aborted",
        retryable: false,
      });
      expect(error.message).not.toContain("AI_REVIEWER_ABORT_PROXY_SECRET");
      expect(fixture.model.doGenerate).not.toHaveBeenCalled();
    },
  );

  it("prioritizes abort raised while snapshotting a tool result", async function () {
    const fixture = transportFixture();
    fixture.model.doGenerate.mockResolvedValueOnce(plainToolProposalResult());
    const proposal = await fixture.transport.proposeForcedToolCall({
      prompt: "Call the synthetic lookup once.",
      maxOutputTokens: 64,
      tool: forcedTool,
    });
    const controller = new AbortController();
    const hostileToolResult = new Proxy(
      {},
      {
        getPrototypeOf() {
          controller.abort(
            new DOMException("Synthetic result cancellation.", "AbortError"),
          );
          throw new Error("AI_REVIEWER_RESULT_PROXY_SECRET");
        },
      },
    );

    const error = await captureError(
      fixture.transport.continueToolCall(
        {
          proposal,
          toolResult: hostileToolResult,
          maxOutputTokens: 32,
        },
        {
          signal: controller.signal,
        },
      ),
    );

    expect(error).toMatchObject({
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    expect(error.message).not.toContain("AI_REVIEWER_RESULT_PROXY_SECRET");
    expect(fixture.model.doGenerate).toHaveBeenCalledOnce();
  });

  it("does not consume a proposal when successful preprocessing aborts", async function () {
    const fixture = transportFixture();
    fixture.model.doGenerate
      .mockResolvedValueOnce(plainToolProposalResult())
      .mockResolvedValueOnce(
        plainGenerateResult({
          content: [{ type: "text", text: "TOOL_OK" }],
        }),
      );
    const proposal = await fixture.transport.proposeForcedToolCall({
      prompt: "Call the synthetic lookup once.",
      maxOutputTokens: 64,
      tool: forcedTool,
    });
    const controller = new AbortController();
    const target = {
      id: "SYNTH-001",
      value: "synthetic",
    };
    const abortingToolResult = new Proxy(target, {
      getPrototypeOf() {
        controller.abort(
          new DOMException("Synthetic result cancellation.", "AbortError"),
        );
        return Object.getPrototypeOf(target);
      },
    });

    const error = await captureError(
      fixture.transport.continueToolCall(
        {
          proposal,
          toolResult: abortingToolResult,
          maxOutputTokens: 32,
        },
        {
          signal: controller.signal,
        },
      ),
    );

    expect(error).toMatchObject({
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    expect(fixture.model.doGenerate).toHaveBeenCalledOnce();

    const result = await fixture.transport.continueToolCall({
      proposal,
      toolResult: target,
      maxOutputTokens: 32,
    });

    expect(result).toMatchObject({
      type: "completed",
      text: "TOOL_OK",
    });
    expect(fixture.model.doGenerate).toHaveBeenCalledTimes(2);
  });

  it("rejects an already aborted request before provider dispatch", async function () {
    const fixture = transportFixture();
    const controller = new AbortController();
    const reason = new DOMException("Synthetic cancellation.", "AbortError");
    controller.abort(reason);

    const error = await captureError(
      fixture.transport.generateChat(
        {
          prompt: "Return exactly COMPAT_OK and nothing else.",
          maxOutputTokens: 32,
        },
        {
          signal: controller.signal,
        },
      ),
    );

    expect(error).toMatchObject({
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    expect(fixture.model.doGenerate).not.toHaveBeenCalled();
  });

  it("does not inspect a non-stream request after its signal is already timed out", async function () {
    const fixture = transportFixture();
    const controller = new AbortController();
    controller.abort(new DOMException("Synthetic deadline.", "TimeoutError"));
    const prompt = vi.fn(() => {
      throw new Error("AI_REVIEWER_PRE_ABORT_INPUT_PRIVATE");
    });
    const request = {};
    Object.defineProperties(request, {
      prompt: {
        enumerable: true,
        get: prompt,
      },
      maxOutputTokens: {
        enumerable: true,
        value: 32,
      },
    });

    const error = await captureError(
      fixture.transport.generateChat(request, {
        signal: controller.signal,
      }),
    );

    expect(error).toMatchObject({
      code: "AI_REQUEST_TIMEOUT",
      category: "timeout",
      retryable: true,
    });
    expect(error.message).not.toContain("AI_REVIEWER_");
    expect(prompt).not.toHaveBeenCalled();
    expect(fixture.model.doGenerate).not.toHaveBeenCalled();
  });

  it("classifies an already expired deadline before provider dispatch", async function () {
    const fixture = transportFixture();
    const controller = new AbortController();
    controller.abort(new DOMException("Synthetic deadline.", "TimeoutError"));

    const error = await captureError(
      fixture.transport.generateChat(
        {
          prompt: "Return exactly COMPAT_OK and nothing else.",
          maxOutputTokens: 32,
        },
        {
          signal: controller.signal,
        },
      ),
    );

    expect(error).toMatchObject({
      code: "AI_REQUEST_TIMEOUT",
      category: "timeout",
      retryable: true,
    });
    expect(fixture.model.doGenerate).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "abort",
      reason: new DOMException("Synthetic cancellation.", "AbortError"),
      expected: {
        code: "AI_REQUEST_ABORTED",
        category: "aborted",
        retryable: false,
      },
    },
    {
      name: "timeout",
      reason: new DOMException("Synthetic deadline.", "TimeoutError"),
      expected: {
        code: "AI_REQUEST_TIMEOUT",
        category: "timeout",
        retryable: true,
      },
    },
  ])(
    "rejects a valid result delivered after non-cooperative $name",
    async function ({ reason, expected }) {
      const fixture = transportFixture();
      const controller = new AbortController();
      let resolveProvider;
      fixture.model.doGenerate.mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveProvider = resolve;
          }),
      );
      const pending = captureError(
        fixture.transport.generateChat(
          {
            prompt: "Return exactly COMPAT_OK and nothing else.",
            maxOutputTokens: 32,
          },
          {
            signal: controller.signal,
          },
        ),
      );
      await vi.waitFor(() => {
        expect(fixture.model.doGenerate).toHaveBeenCalledOnce();
      });

      controller.abort(reason);
      resolveProvider(plainGenerateResult());
      const error = await pending;

      expect(error).toMatchObject(expected);
    },
  );

  it("does not inspect a provider result after non-cooperative abort", async function () {
    const fixture = transportFixture();
    const controller = new AbortController();
    const contentGetter = vi.fn(() => [
      {
        type: "text",
        text: "COMPAT_OK",
      },
    ]);
    const providerResult = plainGenerateResult();
    Object.defineProperty(providerResult, "content", {
      get: contentGetter,
    });
    let resolveProvider;
    fixture.model.doGenerate.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveProvider = resolve;
        }),
    );
    const pending = captureError(
      fixture.transport.generateChat(
        {
          prompt: "Return exactly COMPAT_OK and nothing else.",
          maxOutputTokens: 32,
        },
        {
          signal: controller.signal,
        },
      ),
    );
    await vi.waitFor(() => {
      expect(fixture.model.doGenerate).toHaveBeenCalledOnce();
    });

    controller.abort(new DOMException("Synthetic cancellation.", "AbortError"));
    resolveProvider(providerResult);
    const error = await pending;

    expect(error).toMatchObject({
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    expect(contentGetter).not.toHaveBeenCalled();
  });

  it("rejects an abort raised during otherwise valid normalization", async function () {
    const fixture = transportFixture();
    const controller = new AbortController();
    const providerResult = plainGenerateResult();
    let finishReads = 0;
    let usageReads = 0;
    Object.defineProperty(providerResult, "content", {
      get() {
        controller.abort(
          new DOMException("Synthetic normalization deadline.", "TimeoutError"),
        );
        return [
          {
            type: "text",
            text: "COMPAT_OK",
          },
        ];
      },
    });
    Object.defineProperties(providerResult, {
      finishReason: {
        get() {
          finishReads += 1;
          return {
            unified: "stop",
            raw: "stop",
          };
        },
      },
      usage: {
        get() {
          usageReads += 1;
          return {
            inputTokens: { total: 12 },
            outputTokens: { total: 3 },
          };
        },
      },
    });
    fixture.model.doGenerate.mockResolvedValue(providerResult);

    const error = await captureError(
      fixture.transport.generateChat(
        {
          prompt: "Return exactly COMPAT_OK and nothing else.",
          maxOutputTokens: 32,
        },
        {
          signal: controller.signal,
        },
      ),
    );

    expect(error).toMatchObject({
      code: "AI_REQUEST_TIMEOUT",
      category: "timeout",
      retryable: true,
    });
    expect(finishReads).toBe(0);
    expect(usageReads).toBe(0);
  });

  it("stops content-part normalization when its type getter aborts", async function () {
    const fixture = transportFixture();
    const controller = new AbortController();
    const reason = new DOMException(
      "AI_REVIEWER_CONTENT_PART_ABORT_PRIVATE",
      "AbortError",
    );
    let textReads = 0;
    const part = {};
    Object.defineProperties(part, {
      type: {
        get() {
          controller.abort(reason);
          return "text";
        },
      },
      text: {
        get() {
          textReads += 1;
          return "COMPAT_OK";
        },
      },
    });
    fixture.model.doGenerate.mockResolvedValue({
      ...plainGenerateResult(),
      content: [part],
    });

    const error = await captureError(
      fixture.transport.generateChat(
        {
          prompt: "Return exactly COMPAT_OK and nothing else.",
          maxOutputTokens: 32,
        },
        {
          signal: controller.signal,
        },
      ),
    );

    expect(error).toMatchObject({
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    expect(textReads).toBe(0);
    expect(String(error)).not.toContain(
      "AI_REVIEWER_CONTENT_PART_ABORT_PRIVATE",
    );
  });

  it("observes nested known slots before rejecting an invalid generate envelope", async function () {
    const fixture = transportFixture();
    const finishReason = Promise.reject(
      new Error("AI_REVIEWER_FINISH_REASON_PRIVATE"),
    );
    const inputTokens = Promise.reject(
      new Error("AI_REVIEWER_INPUT_USAGE_PRIVATE"),
    );
    fixture.model.doGenerate.mockResolvedValue({
      content: [],
      finishReason: {
        unified: finishReason,
        raw: "stop",
      },
      usage: {
        inputTokens: {
          total: inputTokens,
        },
        outputTokens: {
          total: 3,
        },
      },
      warnings: [],
    });

    const error = await captureError(
      fixture.transport.generateChat({
        prompt: "Return exactly COMPAT_OK and nothing else.",
        maxOutputTokens: 32,
      }),
    );

    expect(error).toMatchObject({
      code: "AI_PROVIDER_SCHEMA_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(String(error)).not.toContain("AI_REVIEWER_");
    await flushProviderPromiseObservation();
  });

  it("prioritizes an aborted signal over a concurrent classified provider rejection", async function () {
    const fixture = transportFixture();
    const controller = new AbortController();
    let rejectProvider;
    fixture.model.doGenerate.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          rejectProvider = reject;
        }),
    );
    const pending = captureError(
      fixture.transport.generateChat(
        {
          prompt: "Return exactly COMPAT_OK and nothing else.",
          maxOutputTokens: 32,
        },
        {
          signal: controller.signal,
        },
      ),
    );
    await vi.waitFor(() => {
      expect(fixture.model.doGenerate).toHaveBeenCalledOnce();
    });

    controller.abort(new DOMException("Synthetic cancellation.", "AbortError"));
    rejectProvider(
      new AgentGatewayError("Synthetic provider rejection.", {
        code: "AI_PROVIDER_FAILED",
        category: "provider",
        retryable: true,
      }),
    );
    const error = await pending;

    expect(error).toMatchObject({
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
  });

  it("fails closed before dispatch when global telemetry is registered", async function () {
    const fixture = transportFixture();
    const previous = Reflect.get(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS");
    Reflect.set(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS", [
      {
        name: "synthetic-unsafe-integration",
      },
    ]);
    try {
      const error = await captureError(
        fixture.transport.generateChat({
          prompt: "Return exactly COMPAT_OK and nothing else.",
          maxOutputTokens: 32,
        }),
      );

      expect(error).toMatchObject({
        code: "AI_SDK_TELEMETRY_UNSAFE",
        category: "configuration",
        retryable: false,
      });
      expect(fixture.model.doGenerate).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS");
      } else {
        Reflect.set(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS", previous);
      }
    }
  });

  it.each([
    null,
    {},
    {
      prompt: "",
      maxOutputTokens: 32,
    },
    {
      prompt: "COMPAT_OK",
      maxOutputTokens: 0,
    },
    {
      prompt: "COMPAT_OK",
      maxOutputTokens: Number.MAX_SAFE_INTEGER + 1,
    },
    {
      prompt: "COMPAT_OK",
      maxOutputTokens: 1.5,
    },
  ])(
    "rejects malformed local request %# before dispatch",
    async function (input) {
      const fixture = transportFixture();

      const error = await captureError(fixture.transport.generateChat(input));

      expect(error).toBeInstanceOf(TypeError);
      expect(fixture.model.doGenerate).not.toHaveBeenCalled();
    },
  );

  it("accepts provider warnings without exposing their content", async function () {
    const fixture = transportFixture();
    fixture.model.doGenerate.mockResolvedValue({
      content: [{ type: "text", text: "COMPAT_OK" }],
      finishReason: {
        unified: "stop",
        raw: "stop",
      },
      usage: {
        inputTokens: {
          total: 12,
        },
        outputTokens: {
          total: 3,
        },
      },
      warnings: [
        {
          type: "other",
          message: "AI_REVIEWER_PROVIDER_WARNING_SECRET",
        },
      ],
    });

    const result = await fixture.transport.generateChat({
      prompt: "Return exactly COMPAT_OK and nothing else.",
      maxOutputTokens: 32,
    });

    expect(result).toMatchObject({ type: "completed", text: "COMPAT_OK" });
    expect(String(result)).not.toContain("AI_REVIEWER_PROVIDER_WARNING_SECRET");
  });

  it.each([1, 32, 48, 64, 96, 512, 513, Number.MAX_SAFE_INTEGER])(
    "forwards supported maxOutputTokens value %i",
    async function (maxOutputTokens) {
      const fixture = transportFixture();
      fixture.model.doGenerate.mockResolvedValue(
        plainGenerateResult({
          usage: {
            inputTokens: {
              total: 12,
            },
            outputTokens: {
              total: Math.min(3, maxOutputTokens),
            },
          },
        }),
      );

      await fixture.transport.generateChat({
        prompt: "Return exactly COMPAT_OK and nothing else.",
        maxOutputTokens,
      });

      expect(fixture.model.doGenerate).toHaveBeenCalledOnce();
      expect(fixture.model.doGenerate.mock.calls[0][0]).toMatchObject({
        maxOutputTokens,
      });
    },
  );

  it.each([
    null,
    {},
    {
      content: [{ type: "tool-call", toolCallId: "call-1" }],
      finishReason: {
        unified: "tool-calls",
      },
      usage: {
        inputTokens: {
          total: 12,
        },
        outputTokens: {
          total: 3,
        },
      },
      warnings: [],
    },
    plainGenerateResult({
      finishReason: {
        unified: "other",
      },
    }),
    plainGenerateResult({
      usage: {
        inputTokens: {
          total: undefined,
        },
        outputTokens: {
          total: 3,
        },
      },
    }),
    plainGenerateResult({
      usage: {
        inputTokens: {
          total: -1,
        },
        outputTokens: {
          total: 3,
        },
      },
    }),
    plainGenerateResult({
      usage: {
        inputTokens: {
          total: 1.5,
        },
        outputTokens: {
          total: 3,
        },
      },
    }),
    plainGenerateResult({
      usage: {
        inputTokens: {
          total: Number.MAX_SAFE_INTEGER + 1,
        },
        outputTokens: {
          total: 3,
        },
      },
    }),
    plainGenerateResult({
      warnings: undefined,
    }),
  ])("rejects malformed provider result %#", async function (providerResult) {
    const fixture = transportFixture();
    fixture.model.doGenerate.mockResolvedValue(providerResult);

    const error = await captureError(
      fixture.transport.generateChat({
        prompt: "Return exactly COMPAT_OK and nothing else.",
        maxOutputTokens: 32,
      }),
    );

    expect(error).toMatchObject({
      code: "AI_PROVIDER_SCHEMA_INVALID",
      category: "schema",
      retryable: false,
    });
  });

  it.each([
    {
      name: "negative",
      content: new Proxy([], {
        get(target, property, receiver) {
          return property === "length"
            ? -1
            : Reflect.get(target, property, receiver);
        },
      }),
    },
    {
      name: "over-bound",
      content: Array.from({ length: 513 }, () => ({
        type: "text",
        text: "",
      })),
    },
  ])("rejects a $name provider content length", async function ({ content }) {
    const fixture = transportFixture();
    fixture.model.doGenerate.mockResolvedValue(
      plainGenerateResult({
        content,
      }),
    );

    const error = await captureError(
      fixture.transport.generateChat({
        prompt: "Return exactly COMPAT_OK and nothing else.",
        maxOutputTokens: 32,
      }),
    );

    expect(error).toMatchObject({
      code: "AI_PROVIDER_SCHEMA_INVALID",
      category: "schema",
      retryable: false,
    });
  });

  it("observes the bounded prefix of an over-bound provider content array", async function () {
    const fixture = transportFixture();
    const rejected = Promise.reject(
      new Error("AI_REVIEWER_OVER_BOUND_CONTENT_PRIVATE"),
    );
    const content = Array.from({ length: 513 }, () => ({
      type: "text",
      text: "",
    }));
    content[0] = rejected;
    fixture.model.doGenerate.mockResolvedValue(
      plainGenerateResult({
        content,
      }),
    );

    const error = await captureError(
      fixture.transport.generateChat({
        prompt: "Return exactly COMPAT_OK and nothing else.",
        maxOutputTokens: 32,
      }),
    );

    expect(error).toMatchObject({
      code: "AI_PROVIDER_SCHEMA_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(String(error)).not.toContain(
      "AI_REVIEWER_OVER_BOUND_CONTENT_PRIVATE",
    );
    await flushProviderPromiseObservation();
  });

  it.each([
    {
      name: "content property",
      result(rejected) {
        return plainGenerateResult({
          content: rejected,
        });
      },
    },
    {
      name: "content element",
      result(rejected) {
        return plainGenerateResult({
          content: [rejected],
        });
      },
    },
    {
      name: "content length",
      result(rejected) {
        return plainGenerateResult({
          content: new Proxy([], {
            get(target, property, receiver) {
              return property === "length"
                ? rejected
                : Reflect.get(target, property, receiver);
            },
          }),
        });
      },
    },
    {
      name: "warnings length",
      result(rejected) {
        return plainGenerateResult({
          warnings: new Proxy([], {
            get(target, property, receiver) {
              return property === "length"
                ? rejected
                : Reflect.get(target, property, receiver);
            },
          }),
        });
      },
    },
  ])(
    "observes a rejected native Promise used as generate $name data",
    async function ({ result }) {
      const fixture = transportFixture();
      const rejected = Promise.reject(
        new Error("AI_REVIEWER_GENERATE_DATA_PROMISE_PRIVATE"),
      );
      fixture.model.doGenerate.mockResolvedValue(result(rejected));

      const error = await captureError(
        fixture.transport.generateChat({
          prompt: "Return exactly COMPAT_OK and nothing else.",
          maxOutputTokens: 32,
        }),
      );

      expect(error).toMatchObject({
        code: "AI_PROVIDER_SCHEMA_INVALID",
        category: "schema",
        retryable: false,
      });
      expect(error.message).not.toContain("AI_REVIEWER_");
      await flushProviderPromiseObservation();
    },
  );

  it("classifies an unknown SDK failure without exposing its content", async function () {
    const fixture = transportFixture();
    fixture.model.doGenerate.mockRejectedValue(
      new Error("AI_REVIEWER_UNKNOWN_SDK_SECRET"),
    );

    const error = await captureError(
      fixture.transport.generateChat({
        prompt: "Return exactly COMPAT_OK and nothing else.",
        maxOutputTokens: 32,
      }),
    );

    expect(error).toMatchObject({
      code: "AI_PROVIDER_FAILED",
      category: "provider",
      retryable: true,
    });
    expect(error.message).not.toContain("AI_REVIEWER_UNKNOWN_SDK_SECRET");
  });

  it("normalizes provider-controlled SDK retryability to a boolean", async function () {
    const fixture = transportFixture();
    const providerRetryable = {
      marker: "AI_REVIEWER_RETRYABLE_PRIVATE",
    };
    const providerError = new APICallError({
      message: "AI_REVIEWER_API_CALL_PRIVATE",
      url: "https://provider.invalid/v1/chat",
      requestBodyValues: {
        marker: "AI_REVIEWER_REQUEST_PRIVATE",
      },
      statusCode: 503,
      isRetryable: false,
    });
    providerError.isRetryable = providerRetryable;
    fixture.model.doGenerate.mockRejectedValue(providerError);

    const error = await captureError(
      fixture.transport.generateChat({
        prompt: "Return exactly COMPAT_OK and nothing else.",
        maxOutputTokens: 32,
      }),
    );

    expect(error).toMatchObject({
      code: "AI_PROVIDER_REQUEST_FAILED",
      category: "provider",
      retryable: false,
    });
    expect(error.retryable).not.toBe(providerRetryable);
    expect(typeof error.retryable).toBe("boolean");
    expect(JSON.stringify(error)).not.toContain("AI_REVIEWER_");
  });

  it("observes API retryability before classifying an authentication status", async function () {
    const rejected = Promise.reject(
      new Error("AI_REVIEWER_AUTH_RETRYABILITY_PRIVATE"),
    );
    const providerError = {
      [Symbol.for("vercel.ai.error.AI_APICallError")]: true,
      statusCode: 401,
      isRetryable: rejected,
    };

    const error = classifySdkError(providerError);

    expect(error).toMatchObject({
      code: "AI_PROVIDER_AUTHENTICATION_FAILED",
      category: "authentication",
      retryable: false,
    });
    expect(String(error)).not.toContain("AI_REVIEWER_");
    await flushProviderPromiseObservation();
  });

  it("does not inspect RetryError.lastError while SDK retries are disabled", function () {
    let lastErrorReads = 0;
    const retryMarker = Symbol.for("vercel.ai.error.AI_RetryError");
    const providerError = {
      [retryMarker]: true,
      get lastError() {
        lastErrorReads += 1;
        throw new Error("AI_REVIEWER_RETRY_LAST_ERROR_PRIVATE");
      },
    };

    const classified = classifySdkError(providerError);

    expect(classified).toMatchObject({
      code: "AI_PROVIDER_FAILED",
      category: "provider",
      retryable: true,
    });
    expect(lastErrorReads).toBe(0);
  });

  it.each(["cycle", "depth"])(
    "treats an injected RetryError $0 marker as an unknown provider failure",
    function (shape) {
      const retryMarker = Symbol.for("vercel.ai.error.AI_RetryError");
      let providerError;
      if (shape === "cycle") {
        providerError = { [retryMarker]: true };
        providerError.lastError = providerError;
      } else {
        providerError = {};
        for (let depth = 0; depth < 9; depth += 1) {
          providerError = { [retryMarker]: true, lastError: providerError };
        }
      }

      expect(classifySdkError(providerError)).toMatchObject({
        code: "AI_PROVIDER_FAILED",
        category: "provider",
        retryable: true,
      });
    },
  );

  it("observes an ordinary rejected Promise consumed as an SDK marker", async function () {
    const fixture = transportFixture();
    const rejected = Promise.reject(
      new Error("AI_REVIEWER_SDK_MARKER_PRIVATE"),
    );
    const providerError = {
      [Symbol.for("vercel.ai.error.AI_LoadAPIKeyError")]: rejected,
    };
    fixture.model.doGenerate.mockRejectedValue(providerError);

    const error = await captureError(
      fixture.transport.generateChat({
        prompt: "Return exactly COMPAT_OK and nothing else.",
        maxOutputTokens: 32,
      }),
    );

    expect(error).toMatchObject({
      code: "AI_PROVIDER_FAILED",
      category: "provider",
      retryable: true,
    });
    expect(error.message).not.toContain("AI_REVIEWER_");
    await flushProviderPromiseObservation();
  });

  it("observes an ordinary rejected Promise classified directly by the shared gateway", async function () {
    const rejected = Promise.reject(
      new Error("AI_REVIEWER_DIRECT_CLASSIFIER_PRIVATE"),
    );

    const error = classifySdkError(rejected);

    expect(error).toMatchObject({
      code: "AI_PROVIDER_FAILED",
      category: "provider",
      retryable: true,
    });
    expect(error.message).not.toContain("AI_REVIEWER_");
    await flushProviderPromiseObservation();
  });

  it("stops SDK marker inspection immediately when its has trap aborts", function () {
    const controller = new AbortController();
    const reason = new DOMException(
      "AI_REVIEWER_MARKER_ABORT_PRIVATE",
      "AbortError",
    );
    let markerReads = 0;
    const providerError = new Proxy(
      {},
      {
        has() {
          controller.abort(reason);
          return true;
        },
        get() {
          markerReads += 1;
          return true;
        },
      },
    );

    const error = classifySdkError(providerError, controller.signal);

    expect(error.name).toBe("AgentGatewayAbortError");
    expect(error.code).toBe("AI_REQUEST_ABORTED");
    expect(error.category).toBe("aborted");
    expect(error.retryable).toBe(false);
    expect(markerReads).toBe(0);
    expect(String(error)).not.toContain("AI_REVIEWER_MARKER_ABORT_PRIVATE");
  });

  it.each([
    {
      name: "synchronous throw",
      fail(model, providerError) {
        model.doGenerate.mockImplementation(() => {
          throw providerError;
        });
      },
    },
    {
      name: "asynchronous rejection",
      fail(model, providerError) {
        model.doGenerate.mockRejectedValue(providerError);
      },
    },
  ])(
    "redacts a provider-owned AgentGatewayError from doGenerate $name",
    async function ({ fail }) {
      const fixture = transportFixture();
      const providerError = providerAgentGatewayError("GENERATE");
      fail(fixture.model, providerError);

      const error = await captureError(
        fixture.transport.generateChat({
          prompt: "Return exactly COMPAT_OK and nothing else.",
          maxOutputTokens: 32,
        }),
      );

      expect(error).not.toBe(providerError);
      expect(error).toMatchObject({
        code: "AI_PROVIDER_FAILED",
        category: "provider",
        retryable: true,
      });
      expect(error.message).not.toContain("AI_REVIEWER_");
      expect(error.code).not.toContain("AI_REVIEWER_");
    },
  );

  it("observes a rejected native Promise thrown by doGenerate", async function () {
    const fixture = transportFixture();
    const rejected = Promise.reject(
      new Error("AI_REVIEWER_GENERATE_THROWN_PROMISE_PRIVATE"),
    );
    fixture.model.doGenerate.mockImplementation(() => {
      throw rejected;
    });

    const error = await captureError(
      fixture.transport.generateChat({
        prompt: "Return exactly COMPAT_OK and nothing else.",
        maxOutputTokens: 32,
      }),
    );

    expect(error).toMatchObject({
      code: "AI_PROVIDER_FAILED",
      category: "provider",
      retryable: true,
    });
    expect(error.message).not.toContain("AI_REVIEWER_");
    await flushProviderPromiseObservation();
  });

  it("bounds a hostile provider rejection during error classification", async function () {
    const fixture = transportFixture();
    const providerError = new Proxy(
      {},
      {
        get() {
          throw new Error("AI_REVIEWER_CLASSIFIER_GET_PRIVATE");
        },
        getPrototypeOf() {
          throw new Error("AI_REVIEWER_CLASSIFIER_PROTOTYPE_PRIVATE");
        },
      },
    );
    fixture.model.doGenerate.mockRejectedValue(providerError);

    const error = await captureError(
      fixture.transport.generateChat({
        prompt: "Return exactly COMPAT_OK and nothing else.",
        maxOutputTokens: 32,
      }),
    );

    expect(error).toMatchObject({
      code: "AI_PROVIDER_FAILED",
      category: "provider",
      retryable: true,
    });
    expect(error.message).not.toContain("AI_REVIEWER_");
  });

  it("lets abort win when a hostile doStream error aborts during classification", async function () {
    const fixture = transportFixture();
    const controller = new AbortController();
    const reason = new DOMException(
      "Synthetic classification cancellation.",
      "AbortError",
    );
    const has = vi.fn(() => {
      controller.abort(reason);
      return false;
    });
    const providerError = new Proxy({}, { has });
    fixture.model.doStream.mockImplementation(() => {
      throw providerError;
    });

    const error = await captureError(
      captureStream(fixture.transport, streamRequest, {
        signal: controller.signal,
      }),
    );

    expect(has).toHaveBeenCalled();
    expect(error).toMatchObject({
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    expect(error.message).not.toContain("AI_REVIEWER_");
  });

  it("does not inspect raw provider request, response, or metadata fields", async function () {
    const fixture = transportFixture();
    const providerResult = plainStructuredResult();
    const rawGetters = new Map();
    for (const property of ["request", "response", "providerMetadata"]) {
      const getter = vi.fn(() => {
        throw new Error(`AI_REVIEWER_RAW_${property.toUpperCase()}_SECRET`);
      });
      rawGetters.set(property, getter);
      Object.defineProperty(providerResult, property, {
        get: getter,
      });
    }
    fixture.model.doGenerate.mockResolvedValue(providerResult);

    const result = await fixture.transport.generateStructuredChat({
      prompt: "Return one synthetic record.",
      maxOutputTokens: 48,
      schema: structuredSchema,
    });

    expect(result.type).toBe("structured.completed");
    for (const getter of rawGetters.values()) {
      expect(getter).not.toHaveBeenCalled();
    }
  });

  it("bounds a provider result getter failure without exposing its content", async function () {
    const fixture = transportFixture();
    const providerResult = {};
    Object.defineProperty(providerResult, "content", {
      get() {
        throw new Error("AI_REVIEWER_PROVIDER_GETTER_SECRET");
      },
    });
    fixture.model.doGenerate.mockResolvedValue(providerResult);

    const error = await captureError(
      fixture.transport.generateChat({
        prompt: "Return exactly COMPAT_OK and nothing else.",
        maxOutputTokens: 32,
      }),
    );

    expect(error).toBeInstanceOf(AgentGatewayError);
    expect(error).toMatchObject({
      code: "AI_PROVIDER_FAILED",
      category: "provider",
      retryable: true,
    });
    expect(error.message).not.toContain("AI_REVIEWER_PROVIDER_GETTER_SECRET");
  });

  it("redacts a provider-owned AgentGatewayError thrown by result normalization", async function () {
    const fixture = transportFixture();
    const providerError = providerAgentGatewayError("RESULT");
    const providerResult = {};
    Object.defineProperty(providerResult, "content", {
      get() {
        throw providerError;
      },
    });
    fixture.model.doGenerate.mockResolvedValue(providerResult);

    const error = await captureError(
      fixture.transport.generateChat({
        prompt: "Return exactly COMPAT_OK and nothing else.",
        maxOutputTokens: 32,
      }),
    );

    expect(error).not.toBe(providerError);
    expect(error).toMatchObject({
      code: "AI_PROVIDER_FAILED",
      category: "provider",
      retryable: true,
    });
    expect(error.message).not.toContain("AI_REVIEWER_");
    expect(error.code).not.toContain("AI_REVIEWER_");
  });

  it("observes a rejected native Promise thrown by result normalization", async function () {
    const fixture = transportFixture();
    const rejected = Promise.reject(
      new Error("AI_REVIEWER_RESULT_THROWN_PROMISE_PRIVATE"),
    );
    const providerResult = {};
    Object.defineProperty(providerResult, "content", {
      get() {
        throw rejected;
      },
    });
    fixture.model.doGenerate.mockResolvedValue(providerResult);

    const error = await captureError(
      fixture.transport.generateChat({
        prompt: "Return exactly COMPAT_OK and nothing else.",
        maxOutputTokens: 32,
      }),
    );

    expect(error).toMatchObject({
      code: "AI_PROVIDER_FAILED",
      category: "provider",
      retryable: true,
    });
    expect(error.message).not.toContain("AI_REVIEWER_");
    await flushProviderPromiseObservation();
  });

  it("streams only frozen nonempty deltas and one EOF-confirmed terminal DTO", async function () {
    const fixture = transportFixture();
    let bodyClosed = false;
    const provider = providerStreamResult(plainStreamParts(), {
      beforeClose() {
        bodyClosed = true;
      },
    });
    fixture.model.doStream.mockResolvedValue({
      ...provider.result,
      request: {
        body: "AI_REVIEWER_STREAM_REQUEST_SECRET",
      },
      response: {
        headers: {
          "x-ai-reviewer-secret": "AI_REVIEWER_STREAM_HEADER_SECRET",
        },
      },
    });

    const events = await captureStream(fixture.transport);

    expect(fixture.model.doStream).toHaveBeenCalledExactlyOnceWith({
      prompt: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: streamPrompt,
            },
          ],
        },
      ],
      maxOutputTokens: 96,
      temperature: 0,
      topP: 1,
      seed: 424242,
      responseFormat: {
        type: "text",
      },
      providerOptions: {
        openaiCompatible: {
          parallel_tool_calls: false,
          reasoningEffort: "none",
          strictJsonSchema: true,
        },
      },
      abortSignal: undefined,
    });
    expect(fixture.model.doGenerate).not.toHaveBeenCalled();
    expect(bodyClosed).toBe(true);
    expect(events).toEqual([
      {
        type: "text.delta",
        delta: "OK ",
      },
      {
        type: "text.delta",
        delta: "OK",
      },
      {
        type: "completed",
        finishReason: "stop",
        usage: {
          inputTokens: 528,
          outputTokens: 80,
        },
      },
    ]);
    expect(JSON.stringify(events)).not.toContain("AI_REVIEWER_");
    for (const event of events) {
      expect(Object.isFrozen(event)).toBe(true);
    }
    expect(Object.isFrozen(events.at(-1).usage)).toBe(true);
    expect(provider.cancel).not.toHaveBeenCalled();
  });

  it("withholds the terminal DTO until the reader confirms EOF", async function () {
    const eof = deferred();
    const results = [
      ...plainStreamParts().map((value) => ({
        done: false,
        value,
      })),
      eof.promise,
    ];
    const reader = readerStreamFixture(() => {
      const result = results.shift();
      return result instanceof Promise ? result : Promise.resolve(result);
    });
    const fixture = transportFixture();
    fixture.model.doStream.mockResolvedValue(reader.result);
    const iterator = fixture.transport.streamChat(streamRequest);

    expect(await iterator.next()).toEqual({
      done: false,
      value: {
        type: "text.delta",
        delta: "OK ",
      },
    });
    expect(await iterator.next()).toEqual({
      done: false,
      value: {
        type: "text.delta",
        delta: "OK",
      },
    });
    let terminalSettled = false;
    const terminal = iterator.next().finally(() => {
      terminalSettled = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(terminalSettled).toBe(false);
    expect(reader.releaseLock).not.toHaveBeenCalled();

    eof.resolve({
      done: true,
      value: undefined,
    });

    expect(await terminal).toEqual({
      done: false,
      value: {
        type: "completed",
        finishReason: "stop",
        usage: {
          inputTokens: 528,
          outputTokens: 80,
        },
      },
    });
    expect(await iterator.next()).toEqual({
      done: true,
      value: undefined,
    });
    expect(reader.cancel).not.toHaveBeenCalled();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });

  it("observes both known reader-step slots before rejecting an invalid done value", async function () {
    const done = Promise.reject(
      new Error("AI_REVIEWER_STREAM_STEP_DONE_PRIVATE"),
    );
    const value = Promise.reject(
      new Error("AI_REVIEWER_STREAM_STEP_VALUE_PRIVATE"),
    );
    const reader = readerStreamFixture(() =>
      Promise.resolve({
        done,
        value,
      }),
    );
    const fixture = transportFixture();
    fixture.model.doStream.mockResolvedValue(reader.result);

    const error = await captureError(captureStream(fixture.transport));

    expect(error).toMatchObject({
      code: "AI_PROVIDER_SCHEMA_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(String(error)).not.toContain("AI_REVIEWER_");
    await flushProviderPromiseObservation();
  });

  it("stops stream acquisition when the result descriptor aborts", async function () {
    const fixture = transportFixture();
    const controller = new AbortController();
    const reason = new DOMException(
      "AI_REVIEWER_STREAM_DESCRIPTOR_ABORT_PRIVATE",
      "AbortError",
    );
    let getReaderReads = 0;
    let readReads = 0;
    const reader = {};
    Object.defineProperty(reader, "read", {
      get() {
        readReads += 1;
        return vi.fn();
      },
    });
    Object.defineProperties(reader, {
      cancel: { value: vi.fn() },
      releaseLock: { value: vi.fn() },
    });
    const stream = {};
    Object.defineProperty(stream, "getReader", {
      get() {
        getReaderReads += 1;
        return () => reader;
      },
    });
    const result = new Proxy(
      { stream },
      {
        getOwnPropertyDescriptor(target, property) {
          const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
          if (property === "stream") {
            controller.abort(reason);
          }
          return descriptor;
        },
      },
    );
    fixture.model.doStream.mockResolvedValue(result);

    const error = await captureError(
      captureStream(fixture.transport, streamRequest, {
        signal: controller.signal,
      }),
    );

    expect(error).toMatchObject({
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    expect(getReaderReads).toBe(0);
    expect(readReads).toBe(0);
    expect(String(error)).not.toContain(
      "AI_REVIEWER_STREAM_DESCRIPTOR_ABORT_PRIVATE",
    );
  });

  it("cancels once when the getReader getter aborts", async function () {
    const fixture = transportFixture();
    const controller = new AbortController();
    const reason = new DOMException(
      "AI_REVIEWER_GET_READER_ABORT_PRIVATE",
      "AbortError",
    );
    const cancel = vi.fn();
    let readReads = 0;
    const reader = {};
    Object.defineProperties(reader, {
      read: {
        get() {
          readReads += 1;
          return vi.fn();
        },
      },
      cancel: { value: vi.fn() },
      releaseLock: { value: vi.fn() },
    });
    const stream = { cancel };
    Object.defineProperty(stream, "getReader", {
      get() {
        controller.abort(reason);
        return () => reader;
      },
    });
    fixture.model.doStream.mockResolvedValue({ stream });

    const error = await captureError(
      captureStream(fixture.transport, streamRequest, {
        signal: controller.signal,
      }),
    );

    expect(error).toMatchObject({
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
    expect(readReads).toBe(0);
    expect(String(error)).not.toContain("AI_REVIEWER_GET_READER_ABORT_PRIVATE");
  });

  it("uses an acquired reader cancel when a later accessor aborts", async function () {
    const fixture = transportFixture();
    const controller = new AbortController();
    const reason = new DOMException(
      "AI_REVIEWER_READER_ACCESSOR_ABORT_PRIVATE",
      "AbortError",
    );
    const readerCancel = vi.fn();
    const releaseLock = vi.fn();
    const reader = {
      read: vi.fn(),
      cancel: readerCancel,
    };
    Object.defineProperty(reader, "releaseLock", {
      get() {
        controller.abort(reason);
        return releaseLock;
      },
    });
    const streamCancel = vi.fn();
    fixture.model.doStream.mockResolvedValue({
      stream: {
        cancel: streamCancel,
        getReader: vi.fn(() => reader),
      },
    });

    const error = await captureError(
      captureStream(fixture.transport, streamRequest, {
        signal: controller.signal,
      }),
    );

    expect(error).toMatchObject({
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    expect(readerCancel).toHaveBeenCalledExactlyOnceWith(reason);
    expect(releaseLock).toHaveBeenCalledOnce();
    expect(streamCancel).not.toHaveBeenCalled();
    expect(String(error)).not.toContain(
      "AI_REVIEWER_READER_ACCESSOR_ABORT_PRIVATE",
    );
  });

  it.each([
    {
      name: "missing stream start",
      parts: plainStreamParts().slice(1),
    },
    {
      name: "repeated stream start",
      parts: [
        plainStreamParts()[0],
        plainStreamParts()[0],
        ...plainStreamParts().slice(1),
      ],
    },
    {
      name: "provider warning",
      parts: [
        {
          type: "stream-start",
          warnings: [
            {
              type: "other",
              message: "AI_REVIEWER_STREAM_WARNING_SECRET",
            },
          ],
        },
        ...plainStreamParts().slice(1),
      ],
    },
    {
      name: "late response metadata",
      parts: [
        plainStreamParts()[0],
        plainStreamParts()[2],
        plainStreamParts()[1],
        ...plainStreamParts().slice(3),
      ],
    },
    {
      name: "text delta before text start",
      parts: [
        plainStreamParts()[0],
        {
          type: "text-delta",
          id: "0",
          delta: "OK",
        },
        ...plainStreamParts().slice(2),
      ],
    },
    {
      name: "mismatched text id",
      parts: plainStreamParts().map((part) =>
        part.type === "text-delta" && part.delta === "OK "
          ? {
              ...part,
              id: "foreign",
            }
          : part,
      ),
    },
    {
      name: "duplicate text start",
      parts: [
        ...plainStreamParts().slice(0, 3),
        plainStreamParts()[2],
        ...plainStreamParts().slice(3),
      ],
    },
    {
      name: "duplicate text end",
      parts: [
        ...plainStreamParts().slice(0, 7),
        plainStreamParts()[6],
        plainStreamParts()[7],
      ],
    },
    {
      name: "finish before text end",
      parts: [
        ...plainStreamParts().slice(0, 6),
        plainStreamParts()[7],
        plainStreamParts()[6],
      ],
    },
    {
      name: "missing finish",
      parts: plainStreamParts().slice(0, -1),
    },
    {
      name: "duplicate finish",
      parts: [...plainStreamParts(), plainStreamParts().at(-1)],
    },
    {
      name: "part after finish",
      parts: [
        ...plainStreamParts(),
        {
          type: "text-delta",
          id: "0",
          delta: "late",
        },
      ],
    },
    {
      name: "empty-only text",
      parts: plainStreamParts().filter(
        (part) =>
          part.type !== "text-delta" ||
          (part.type === "text-delta" && part.delta === ""),
      ),
    },
    {
      name: "oversized text delta",
      parts: plainStreamParts().map((part) =>
        part.type === "text-delta" && part.delta === "OK "
          ? {
              ...part,
              delta: "x".repeat(100_001),
            }
          : part,
      ),
    },
    {
      name: "cumulative oversized text",
      parts: plainStreamParts().flatMap((part) => {
        if (part.type !== "text-delta") {
          return [part];
        }
        if (part.delta === "OK ") {
          return [
            {
              ...part,
              delta: "x".repeat(60_000),
            },
            {
              ...part,
              delta: "x".repeat(40_001),
            },
          ];
        }
        return part.delta === "OK" ? [] : [part];
      }),
    },
    ...[
      "raw",
      "reasoning-start",
      "tool-input-start",
      "source",
      "file",
      "unknown",
    ].map((type) => ({
      name: `${type} part`,
      parts: [
        plainStreamParts()[0],
        {
          type,
          rawValue: "AI_REVIEWER_UNTRUSTED_STREAM_PART_SECRET",
        },
        ...plainStreamParts().slice(1),
      ],
    })),
  ])("rejects malformed stream state: $name", async function ({ parts }) {
    const fixture = transportFixture();
    fixture.model.doStream.mockResolvedValue(
      providerStreamResult(parts).result,
    );

    const error = await captureError(captureStream(fixture.transport));

    expect(error).toBeInstanceOf(AgentGatewayError);
    expect(error).toMatchObject({
      code: "AI_PROVIDER_SCHEMA_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(error.message).not.toContain("AI_REVIEWER_");
    expect(fixture.model.doStream).toHaveBeenCalledOnce();
    expect(fixture.model.doGenerate).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "empty",
      id: "",
    },
    {
      name: "oversized",
      id: "x".repeat(257),
    },
    {
      name: "control-bearing",
      id: "synthetic\nid",
    },
    {
      name: "space-bearing",
      id: "synthetic id",
    },
    {
      name: "null-bearing",
      id: "synthetic\u0000id",
    },
    {
      name: "delete-bearing",
      id: "synthetic\u007fid",
    },
  ])("rejects a $name stream text ID", async function ({ id }) {
    const fixture = transportFixture();
    const parts = plainStreamParts().map((part) =>
      Object.hasOwn(part, "id")
        ? {
            ...part,
            id,
          }
        : part,
    );
    fixture.model.doStream.mockResolvedValue(
      providerStreamResult(parts).result,
    );

    const error = await captureError(captureStream(fixture.transport));

    expect(error).toMatchObject({
      code: "AI_PROVIDER_SCHEMA_INVALID",
      category: "schema",
      retryable: false,
    });
  });

  it("accepts the exact stream text and ID character boundaries", async function () {
    const fixture = transportFixture();
    const id = "x".repeat(256);
    const parts = plainStreamParts().flatMap((part) => {
      const withBoundaryId = Object.hasOwn(part, "id")
        ? {
            ...part,
            id,
          }
        : part;
      if (part.type !== "text-delta") {
        return [withBoundaryId];
      }
      if (part.delta === "OK ") {
        return [
          {
            ...withBoundaryId,
            delta: "x".repeat(50_000),
          },
          {
            ...withBoundaryId,
            delta: "x".repeat(50_000),
          },
        ];
      }
      return part.delta === "OK" ? [] : [withBoundaryId];
    });
    fixture.model.doStream.mockResolvedValue(
      providerStreamResult(parts).result,
    );

    const events = await captureStream(fixture.transport);

    expect(events.map((event) => event.type)).toEqual([
      "text.delta",
      "text.delta",
      "completed",
    ]);
    expect(events.slice(0, 2).map((event) => event.delta.length)).toEqual([
      50_000, 50_000,
    ]);
  });

  it.each([
    {
      name: "part",
      makePart() {
        const { proxy, revoke } = Proxy.revocable(
          {
            type: "stream-start",
            warnings: [],
          },
          {},
        );
        revoke();
        return proxy;
      },
    },
    {
      name: "warning array",
      makePart() {
        const { proxy, revoke } = Proxy.revocable([], {});
        revoke();
        return {
          type: "stream-start",
          warnings: proxy,
        };
      },
    },
  ])(
    "classifies a revoked provider $name as invalid schema",
    async function ({ makePart }) {
      const fixture = transportFixture();
      const reader = readerStreamFixture(() =>
        Promise.resolve({
          done: false,
          value: makePart(),
        }),
      );
      fixture.model.doStream.mockResolvedValue(reader.result);

      const error = await captureError(captureStream(fixture.transport));

      expect(error).toMatchObject({
        code: "AI_PROVIDER_SCHEMA_INVALID",
        category: "schema",
        retryable: false,
      });
      expect(reader.cancel).toHaveBeenCalledOnce();
      expect(reader.releaseLock).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      name: "unsupported finish reason",
      finish: {
        finishReason: {
          unified: "other",
          raw: "AI_REVIEWER_RAW_FINISH_SECRET",
        },
      },
    },
    {
      name: "missing usage",
      finish: {
        usage: undefined,
      },
    },
    ...[undefined, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((total) => ({
      name: `invalid input token total ${String(total)}`,
      finish: {
        usage: {
          inputTokens: {
            total,
          },
          outputTokens: {
            total: 80,
          },
        },
      },
    })),
    ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1].map((total) => ({
      name: `invalid output token total ${String(total)}`,
      finish: {
        usage: {
          inputTokens: {
            total: 528,
          },
          outputTokens: {
            total,
          },
        },
      },
    })),
  ])(
    "rejects malformed stream finish usage: $name",
    async function ({ finish }) {
      const fixture = transportFixture();
      const parts = plainStreamParts().map((part) =>
        part.type === "finish"
          ? {
              ...part,
              ...finish,
            }
          : part,
      );
      fixture.model.doStream.mockResolvedValue(
        providerStreamResult(parts).result,
      );

      const error = await captureError(captureStream(fixture.transport));

      expect(error).toMatchObject({
        code: "AI_PROVIDER_SCHEMA_INVALID",
        category: "schema",
        retryable: false,
      });
    },
  );

  it("does not inspect raw stream result or provider metadata", async function () {
    const fixture = transportFixture();
    const rawGetters = [];
    const parts = plainStreamParts().map((part) => {
      const clone = {
        ...part,
      };
      for (const property of ["providerMetadata", "rawValue"]) {
        const getter = vi.fn(() => {
          throw new Error(
            `AI_REVIEWER_STREAM_${property.toUpperCase()}_SECRET`,
          );
        });
        rawGetters.push(getter);
        Object.defineProperty(clone, property, {
          get: getter,
        });
      }
      if (part.type === "response-metadata") {
        const getter = vi.fn(() => {
          throw new Error("AI_REVIEWER_RESPONSE_METADATA_SECRET");
        });
        rawGetters.push(getter);
        Object.defineProperty(clone, "headers", {
          get: getter,
        });
      }
      if (part.type === "finish") {
        const rawUsageGetter = vi.fn(() => {
          throw new Error("AI_REVIEWER_RAW_USAGE_SECRET");
        });
        rawGetters.push(rawUsageGetter);
        Object.defineProperty(clone.usage, "raw", {
          get: rawUsageGetter,
        });
      }
      return clone;
    });
    const result = providerStreamResult(parts).result;
    for (const property of ["request", "response"]) {
      const getter = vi.fn(() => {
        throw new Error(`AI_REVIEWER_STREAM_${property.toUpperCase()}_SECRET`);
      });
      rawGetters.push(getter);
      Object.defineProperty(result, property, {
        get: getter,
      });
    }
    fixture.model.doStream.mockResolvedValue(result);

    const events = await captureStream(fixture.transport);

    expect(events.at(-1).type).toBe("completed");
    for (const getter of rawGetters) {
      expect(getter).not.toHaveBeenCalled();
    }
  });

  it("does not inspect a valid stream request after pre-abort", async function () {
    const fixture = transportFixture();
    const controller = new AbortController();
    controller.abort(new DOMException("Synthetic cancellation.", "AbortError"));
    const getPrototypeOf = vi.fn(() => Object.prototype);
    const request = new Proxy(
      {
        prompt: streamPrompt,
        maxOutputTokens: 96,
      },
      {
        getPrototypeOf,
      },
    );

    const error = await captureError(
      Promise.resolve().then(() =>
        captureStream(fixture.transport, request, {
          signal: controller.signal,
        }),
      ),
    );

    expect(error).toMatchObject({
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    expect(getPrototypeOf).not.toHaveBeenCalled();
    expect(fixture.model.doStream).not.toHaveBeenCalled();
  });

  it("stops stream-part descriptor inspection when its prototype trap aborts", async function () {
    const fixture = transportFixture();
    const controller = new AbortController();
    const reason = new DOMException(
      "AI_REVIEWER_STREAM_PROTOTYPE_ABORT_PRIVATE",
      "AbortError",
    );
    let prototypeReads = 0;
    let descriptorReads = 0;
    const part = new Proxy(
      {
        type: "stream-start",
        warnings: [],
      },
      {
        getPrototypeOf(target) {
          prototypeReads += 1;
          controller.abort(reason);
          return Reflect.getPrototypeOf(target);
        },
        getOwnPropertyDescriptor(target, property) {
          descriptorReads += 1;
          return Reflect.getOwnPropertyDescriptor(target, property);
        },
      },
    );
    fixture.model.doStream.mockResolvedValue(
      providerStreamResult([part]).result,
    );

    const error = await captureError(
      captureStream(fixture.transport, streamRequest, {
        signal: controller.signal,
      }),
    );

    expect(error).toMatchObject({
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    expect(prototypeReads).toBe(1);
    expect(descriptorReads).toBe(0);
    expect(String(error)).not.toContain(
      "AI_REVIEWER_STREAM_PROTOTYPE_ABORT_PRIVATE",
    );
  });

  it("does not dispatch when the signal aborts before the first iterator pull", async function () {
    const fixture = transportFixture();
    const controller = new AbortController();
    const iterator = fixture.transport.streamChat(streamRequest, {
      signal: controller.signal,
    });
    controller.abort(
      new DOMException("Synthetic lazy cancellation.", "AbortError"),
    );

    const error = await captureError(iterator.next());

    expect(error).toMatchObject({
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    expect(fixture.model.doStream).not.toHaveBeenCalled();
  });

  it("cancels a late stream when doStream synchronously aborts its signal", async function () {
    const fixture = transportFixture();
    const controller = new AbortController();
    const provider = deferred();
    const reason = new DOMException(
      "Synthetic synchronous cancellation.",
      "AbortError",
    );
    fixture.model.doStream.mockImplementation(() => {
      controller.abort(reason);
      return provider.promise;
    });
    const iterator = fixture.transport.streamChat(streamRequest, {
      signal: controller.signal,
    });

    const error = await captureError(iterator.next());

    expect(error).toMatchObject({
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    expect(fixture.model.doStream).toHaveBeenCalledOnce();

    const lateCancel = vi.fn();
    provider.resolve({
      stream: {
        cancel: lateCancel,
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(lateCancel).toHaveBeenCalledExactlyOnceWith(reason);
  });

  it("observes a late rejection when doStream synchronously aborts its signal", async function () {
    const fixture = transportFixture();
    const controller = new AbortController();
    const reason = new DOMException(
      "Synthetic synchronous deadline.",
      "TimeoutError",
    );
    let rejectLate;
    const then = vi.fn((_resolve, reject) => {
      rejectLate = reject;
    });
    const getThen = vi.fn(() => then);
    const providerWork = {};
    Object.defineProperty(providerWork, "then", {
      get: getThen,
    });
    fixture.model.doStream.mockImplementation(() => {
      controller.abort(reason);
      return providerWork;
    });

    const error = await captureError(
      fixture.transport
        .streamChat(streamRequest, {
          signal: controller.signal,
        })
        .next(),
    );

    expect(error).toMatchObject({
      code: "AI_REQUEST_TIMEOUT",
      category: "timeout",
      retryable: true,
    });
    expect(getThen).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(then).toHaveBeenCalledOnce();
    expect(rejectLate).toBeTypeOf("function");
    rejectLate(new Error("AI_REVIEWER_SYNCHRONOUS_LATE_REJECTION_SECRET"));
    await Promise.resolve();
    await Promise.resolve();
  });

  it("observes a rejected native Promise in a late stream slot after abort", async function () {
    const fixture = transportFixture();
    const controller = new AbortController();
    const provider = deferred();
    const reason = new DOMException(
      "Synthetic late-stream cancellation.",
      "AbortError",
    );
    fixture.model.doStream.mockImplementation(() => {
      controller.abort(reason);
      return provider.promise;
    });

    const error = await captureError(
      fixture.transport
        .streamChat(streamRequest, {
          signal: controller.signal,
        })
        .next(),
    );

    expect(error).toMatchObject({
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    provider.resolve({
      stream: Promise.reject(
        new Error("AI_REVIEWER_LATE_STREAM_PROMISE_PRIVATE"),
      ),
    });
    await flushProviderPromiseObservation();
  });

  it("cancels a settled provider stream when abort wins before continuation", async function () {
    const fixture = transportFixture();
    const controller = new AbortController();
    const provider = deferred();
    const streamCancel = vi.fn();
    const getReader = vi.fn(() => {
      throw new Error("AI_REVIEWER_POST_SETTLEMENT_GET_READER_SECRET");
    });
    fixture.model.doStream.mockReturnValue(provider.promise);
    const iterator = fixture.transport.streamChat(streamRequest, {
      signal: controller.signal,
    });
    const pending = iterator.next();
    await vi.waitFor(() => {
      expect(fixture.model.doStream).toHaveBeenCalledOnce();
    });
    const reason = new DOMException(
      "Synthetic post-settlement cancellation.",
      "AbortError",
    );

    provider.resolve({
      stream: {
        cancel: streamCancel,
        getReader,
      },
    });
    queueMicrotask(() => controller.abort(reason));
    const error = await captureError(pending);

    expect(error).toMatchObject({
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    expect(streamCancel).toHaveBeenCalledExactlyOnceWith(reason);
    expect(getReader).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "abort",
      reason: new DOMException("Synthetic cancellation.", "AbortError"),
      expected: {
        code: "AI_REQUEST_ABORTED",
        category: "aborted",
        retryable: false,
      },
    },
    {
      name: "timeout",
      reason: new DOMException("Synthetic deadline.", "TimeoutError"),
      expected: {
        code: "AI_REQUEST_TIMEOUT",
        category: "timeout",
        retryable: true,
      },
    },
  ])(
    "classifies non-cooperative $name while doStream is pending",
    async function ({ reason, expected }) {
      const fixture = transportFixture();
      const controller = new AbortController();
      const provider = deferred();
      fixture.model.doStream.mockReturnValue(provider.promise);
      const iterator = fixture.transport.streamChat(streamRequest, {
        signal: controller.signal,
      });
      const pending = iterator.next();
      await vi.waitFor(() => {
        expect(fixture.model.doStream).toHaveBeenCalledOnce();
      });

      controller.abort(reason);
      const error = await captureError(pending);

      expect(error).toMatchObject(expected);
      expect(await iterator.next()).toEqual({
        done: true,
        value: undefined,
      });

      const lateCancel = vi.fn();
      provider.resolve({
        stream: {
          cancel: lateCancel,
        },
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(lateCancel).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      name: "abort",
      reason: new DOMException("Synthetic read cancellation.", "AbortError"),
      expected: {
        code: "AI_REQUEST_ABORTED",
        category: "aborted",
        retryable: false,
      },
    },
    {
      name: "timeout",
      reason: new DOMException("Synthetic read deadline.", "TimeoutError"),
      expected: {
        code: "AI_REQUEST_TIMEOUT",
        category: "timeout",
        retryable: true,
      },
    },
  ])(
    "classifies non-cooperative $name while reader.read is pending",
    async function ({ reason, expected }) {
      const fixture = transportFixture();
      const controller = new AbortController();
      const read = deferred();
      const neverSettlingCancel = vi.fn(() => new Promise(() => {}));
      const reader = readerStreamFixture(() => read.promise, {
        cancel: neverSettlingCancel,
      });
      fixture.model.doStream.mockResolvedValue(reader.result);
      const iterator = fixture.transport.streamChat(streamRequest, {
        signal: controller.signal,
      });
      const pending = iterator.next();
      await vi.waitFor(() => {
        expect(reader.reader.read).toHaveBeenCalledOnce();
      });

      controller.abort(reason);
      const outcome = await Promise.race([
        captureError(pending),
        new Promise((resolve) => {
          setTimeout(() => resolve("did-not-settle"), 100);
        }),
      ]);

      expect(outcome).not.toBe("did-not-settle");
      expect(outcome).toMatchObject(expected);
      expect(reader.cancel).toHaveBeenCalledOnce();
      expect(reader.releaseLock).toHaveBeenCalled();

      read.resolve({
        done: false,
        value: {
          type: "text-delta",
          id: "0",
          delta: "late",
        },
      });
      await Promise.resolve();
      expect(await iterator.next()).toEqual({
        done: true,
        value: undefined,
      });
    },
  );

  it.each([
    {
      settlement: "fulfills",
      settle(read) {
        read.resolve({
          done: false,
          value: {
            type: "text-delta",
            id: "0",
            delta: "late",
          },
        });
      },
    },
    {
      settlement: "rejects",
      settle(read) {
        read.reject(new Error("AI_REVIEWER_LATE_READ_REJECTION_PRIVATE"));
      },
    },
  ])(
    "retries one failed release after a pending read $settlement",
    async function ({ settle }) {
      const fixture = transportFixture();
      const controller = new AbortController();
      const read = deferred();
      const calls = [];
      let readSettled = false;
      let released = false;
      const cancel = vi.fn(() => {
        calls.push("cancel");
        return new Promise(() => {});
      });
      const releaseLock = vi.fn(() => {
        calls.push("release");
        if (!readSettled) {
          throw new TypeError("The reader still has a pending read.");
        }
        released = true;
      });
      const reader = readerStreamFixture(() => read.promise, {
        cancel,
        releaseLock,
      });
      fixture.model.doStream.mockResolvedValue(reader.result);
      const iterator = fixture.transport.streamChat(streamRequest, {
        signal: controller.signal,
      });
      const pending = iterator.next();
      await vi.waitFor(() => {
        expect(reader.reader.read).toHaveBeenCalledOnce();
      });

      controller.abort(
        new DOMException("Synthetic read cancellation.", "AbortError"),
      );
      const error = await captureError(pending);

      expect(error).toMatchObject({
        code: "AI_REQUEST_ABORTED",
        category: "aborted",
        retryable: false,
      });
      expect(calls).toEqual(["cancel", "release"]);
      expect(releaseLock).toHaveBeenCalledOnce();
      expect(released).toBe(false);

      readSettled = true;
      settle(read);
      await vi.waitFor(() => {
        expect(releaseLock).toHaveBeenCalledTimes(2);
        expect(released).toBe(true);
      });
      expect(calls).toEqual(["cancel", "release", "release"]);
    },
  );

  it.each([
    {
      settlement: "fulfills",
      settle(cancellation) {
        cancellation.resolve();
      },
    },
    {
      settlement: "rejects",
      settle(cancellation) {
        cancellation.reject(
          new Error("AI_REVIEWER_CANCEL_RELEASE_RETRY_PRIVATE"),
        );
      },
    },
  ])(
    "retries one failed release when cancel $settlement before a non-cooperative read",
    async function ({ settle }) {
      const fixture = transportFixture();
      const controller = new AbortController();
      const reason = new DOMException(
        "AI_REVIEWER_CANCEL_RELEASE_RETRY_PRIVATE",
        "AbortError",
      );
      const cancellation = deferred();
      let released = false;
      const cancel = vi.fn(() => cancellation.promise);
      const releaseLock = vi.fn(() => {
        if (releaseLock.mock.calls.length === 1) {
          throw new TypeError("Synthetic first release failure.");
        }
        released = true;
      });
      const reader = readerStreamFixture(() => new Promise(() => {}), {
        cancel,
        releaseLock,
      });
      fixture.model.doStream.mockResolvedValue(reader.result);
      const iterator = fixture.transport.streamChat(streamRequest, {
        signal: controller.signal,
      });
      const pending = iterator.next();
      await vi.waitFor(() => {
        expect(reader.reader.read).toHaveBeenCalledOnce();
      });

      controller.abort(reason);
      const error = await captureError(pending);

      expect(error).toMatchObject({
        code: "AI_REQUEST_ABORTED",
        category: "aborted",
        retryable: false,
      });
      expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
      expect(releaseLock).toHaveBeenCalledOnce();
      expect(released).toBe(false);

      settle(cancellation);
      await vi.waitFor(() => {
        expect(releaseLock).toHaveBeenCalledTimes(2);
        expect(released).toBe(true);
      });
    },
  );

  it("releases a native reader with a pending read exactly once", async function () {
    const fixture = transportFixture();
    const controller = new AbortController();
    const reason = new DOMException(
      "AI_REVIEWER_NATIVE_PENDING_READ_PRIVATE",
      "AbortError",
    );
    const pull = vi.fn(() => new Promise(() => {}));
    const underlyingCancel = vi.fn();
    const stream = new ReadableStream({
      pull,
      cancel: underlyingCancel,
    });
    const nativeGetReader = stream.getReader.bind(stream);
    const releaseLock = vi.fn();
    Object.defineProperty(stream, "getReader", {
      value() {
        const reader = nativeGetReader();
        const nativeReleaseLock = reader.releaseLock.bind(reader);
        Object.defineProperty(reader, "releaseLock", {
          value: releaseLock.mockImplementation(() => nativeReleaseLock()),
        });
        return reader;
      },
    });
    fixture.model.doStream.mockResolvedValue({
      stream,
    });
    const iterator = fixture.transport.streamChat(streamRequest, {
      signal: controller.signal,
    });
    const pending = iterator.next();
    await vi.waitFor(() => {
      expect(pull).toHaveBeenCalledOnce();
    });

    controller.abort(reason);
    const error = await captureError(pending);

    expect(error).toMatchObject({
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    expect(releaseLock).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
    expect(underlyingCancel).toHaveBeenCalledExactlyOnceWith(reason);
  });

  it.each([
    {
      name: "throws",
      cancel() {
        throw new Error("AI_REVIEWER_CANCEL_THROW_SECRET");
      },
    },
    {
      name: "rejects",
      cancel() {
        return Promise.reject(new Error("AI_REVIEWER_CANCEL_REJECTION_SECRET"));
      },
    },
    {
      name: "never settles",
      cancel() {
        return new Promise(() => {});
      },
    },
  ])(
    "preserves abort when reader cancellation $name",
    async function ({ cancel }) {
      const fixture = transportFixture();
      const controller = new AbortController();
      const results = plainStreamParts()
        .slice(0, 5)
        .map((value) => ({
          done: false,
          value,
        }));
      const reader = readerStreamFixture(
        () => Promise.resolve(results.shift()),
        {
          cancel: vi.fn(cancel),
        },
      );
      fixture.model.doStream.mockResolvedValue(reader.result);
      const iterator = fixture.transport.streamChat(streamRequest, {
        signal: controller.signal,
      });

      expect(await iterator.next()).toMatchObject({
        done: false,
        value: {
          type: "text.delta",
          delta: "OK ",
        },
      });
      controller.abort(
        new DOMException("Synthetic cancellation.", "AbortError"),
      );
      const outcome = await Promise.race([
        captureError(iterator.next()),
        new Promise((resolve) => {
          setTimeout(() => resolve("did-not-settle"), 100);
        }),
      ]);

      expect(outcome).not.toBe("did-not-settle");
      expect(outcome).toMatchObject({
        code: "AI_REQUEST_ABORTED",
        category: "aborted",
        retryable: false,
      });
      expect(reader.cancel).toHaveBeenCalledOnce();
      expect(reader.releaseLock).toHaveBeenCalled();
      await Promise.resolve();
    },
  );

  it("cancels and releases the provider reader when its consumer returns early", async function () {
    const fixture = transportFixture();
    const results = plainStreamParts().map((value) => ({
      done: false,
      value,
    }));
    const reader = readerStreamFixture(() => Promise.resolve(results.shift()));
    fixture.model.doStream.mockResolvedValue(reader.result);
    const iterator = fixture.transport.streamChat(streamRequest);

    expect(await iterator.next()).toMatchObject({
      done: false,
      value: {
        type: "text.delta",
      },
    });
    expect(await iterator.return()).toEqual({
      done: true,
      value: undefined,
    });
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalled();
    expect(reader.cancel.mock.invocationCallOrder[0]).toBeLessThan(
      reader.releaseLock.mock.invocationCallOrder[0],
    );
  });

  it.each([
    {
      name: "synchronous throw",
      fail(model, providerError) {
        model.doStream.mockImplementation(() => {
          throw providerError;
        });
      },
    },
    {
      name: "asynchronous rejection",
      fail(model, providerError) {
        model.doStream.mockRejectedValue(providerError);
      },
    },
  ])(
    "redacts a provider-owned AgentGatewayError from doStream $name",
    async function ({ fail }) {
      const fixture = transportFixture();
      const providerError = providerAgentGatewayError("STREAM");
      fail(fixture.model, providerError);

      const error = await captureError(captureStream(fixture.transport));

      expect(error).not.toBe(providerError);
      expect(error).toMatchObject({
        code: "AI_PROVIDER_FAILED",
        category: "provider",
        retryable: true,
      });
      expect(error.message).not.toContain("AI_REVIEWER_");
      expect(error.code).not.toContain("AI_REVIEWER_");
    },
  );

  it("observes a rejected native Promise thrown by doStream", async function () {
    const fixture = transportFixture();
    const rejected = Promise.reject(
      new Error("AI_REVIEWER_STREAM_THROWN_PROMISE_PRIVATE"),
    );
    fixture.model.doStream.mockImplementation(() => {
      throw rejected;
    });

    const error = await captureError(captureStream(fixture.transport));

    expect(error).toMatchObject({
      code: "AI_PROVIDER_FAILED",
      category: "provider",
      retryable: true,
    });
    expect(error.message).not.toContain("AI_REVIEWER_");
    await flushProviderPromiseObservation();
  });

  it("classifies a reader rejection without exposing its content", async function () {
    const fixture = transportFixture();
    const reader = readerStreamFixture(() =>
      Promise.reject(new Error("AI_REVIEWER_READER_REJECTION_SECRET")),
    );
    fixture.model.doStream.mockResolvedValue(reader.result);

    const error = await captureError(captureStream(fixture.transport));

    expect(error).toMatchObject({
      code: "AI_PROVIDER_FAILED",
      category: "provider",
      retryable: true,
    });
    expect(error.message).not.toContain("AI_REVIEWER_READER_REJECTION_SECRET");
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalled();
  });

  it("observes a rejected native Promise thrown by reader.read", async function () {
    const fixture = transportFixture();
    const rejected = Promise.reject(
      new Error("AI_REVIEWER_READ_THROWN_PROMISE_PRIVATE"),
    );
    const reader = readerStreamFixture(() => {
      throw rejected;
    });
    fixture.model.doStream.mockResolvedValue(reader.result);

    const error = await captureError(captureStream(fixture.transport));

    expect(error).toMatchObject({
      code: "AI_PROVIDER_FAILED",
      category: "provider",
      retryable: true,
    });
    expect(error.message).not.toContain("AI_REVIEWER_");
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalled();
    await flushProviderPromiseObservation();
  });

  it.each([
    {
      name: "synchronous throw",
      read(error) {
        throw error;
      },
    },
    {
      name: "asynchronous rejection",
      read(error) {
        return Promise.reject(error);
      },
    },
  ])(
    "redacts an untrusted AgentGatewayError from a reader $name",
    async function ({ read }) {
      const fixture = transportFixture();
      const providerError = new AgentGatewayError(
        "AI_REVIEWER_READER_AGENT_GATEWAY_SECRET",
        {
          code: "AI_REVIEWER_READER_SECRET_CODE",
          category: "authentication",
          retryable: false,
        },
      );
      const reader = readerStreamFixture(() => read(providerError));
      fixture.model.doStream.mockResolvedValue(reader.result);

      const error = await captureError(captureStream(fixture.transport));

      expect(error).not.toBe(providerError);
      expect(error).toMatchObject({
        code: "AI_PROVIDER_FAILED",
        category: "provider",
        retryable: true,
      });
      expect(error.message).not.toContain("AI_REVIEWER_");
      expect(reader.cancel).toHaveBeenCalledOnce();
      expect(reader.releaseLock).toHaveBeenCalled();
    },
  );

  it("classifies a provider error part without exposing its content", async function () {
    const fixture = transportFixture();
    const parts = [
      plainStreamParts()[0],
      {
        type: "error",
        error: new Error("AI_REVIEWER_STREAM_ERROR_SECRET"),
      },
    ];
    fixture.model.doStream.mockResolvedValue(
      providerStreamResult(parts).result,
    );

    const error = await captureError(captureStream(fixture.transport));

    expect(error).toMatchObject({
      code: "AI_PROVIDER_FAILED",
      category: "provider",
      retryable: true,
    });
    expect(error.message).not.toContain("AI_REVIEWER_STREAM_ERROR_SECRET");
  });

  it("redacts an untrusted AgentGatewayError from a provider error part", async function () {
    const fixture = transportFixture();
    const providerError = new AgentGatewayError(
      "AI_REVIEWER_PROVIDER_AGENT_GATEWAY_SECRET",
      {
        code: "AI_REVIEWER_PROVIDER_SECRET_CODE",
        category: "authentication",
        retryable: false,
      },
    );
    const parts = [
      plainStreamParts()[0],
      {
        type: "error",
        error: providerError,
      },
    ];
    fixture.model.doStream.mockResolvedValue(
      providerStreamResult(parts).result,
    );

    const error = await captureError(captureStream(fixture.transport));

    expect(error).not.toBe(providerError);
    expect(error).toMatchObject({
      code: "AI_PROVIDER_FAILED",
      category: "provider",
      retryable: true,
    });
    expect(error.message).not.toContain("AI_REVIEWER_");
  });

  it.each([
    {
      name: "part type",
      expectedCode: "AI_PROVIDER_SCHEMA_INVALID",
      parts(rejected) {
        return [{ type: rejected }];
      },
    },
    {
      name: "text id",
      expectedCode: "AI_PROVIDER_SCHEMA_INVALID",
      parts(rejected) {
        const parts = plainStreamParts();
        parts[2] = {
          ...parts[2],
          id: rejected,
        };
        return parts.slice(0, 3);
      },
    },
    {
      name: "text delta",
      expectedCode: "AI_PROVIDER_SCHEMA_INVALID",
      parts(rejected) {
        const parts = plainStreamParts();
        parts[4] = {
          ...parts[4],
          delta: rejected,
        };
        return parts.slice(0, 5);
      },
    },
    {
      name: "finish usage",
      expectedCode: "AI_PROVIDER_SCHEMA_INVALID",
      parts(rejected) {
        const parts = plainStreamParts();
        parts[7] = {
          ...parts[7],
          usage: rejected,
        };
        return parts;
      },
    },
    {
      name: "provider error",
      expectedCode: "AI_PROVIDER_FAILED",
      parts(rejected) {
        return [
          plainStreamParts()[0],
          {
            type: "error",
            error: rejected,
          },
        ];
      },
    },
  ])(
    "observes a rejected native Promise used as provider $name data",
    async function ({ expectedCode, parts }) {
      const fixture = transportFixture();
      const rejected = Promise.reject(
        new Error("AI_REVIEWER_STREAM_DATA_PROMISE_PRIVATE"),
      );
      fixture.model.doStream.mockResolvedValue(
        providerStreamResult(parts(rejected)).result,
      );

      const error = await captureError(captureStream(fixture.transport));

      expect(error).toMatchObject({
        code: expectedCode,
      });
      expect(error.message).not.toContain("AI_REVIEWER_");
      await flushProviderPromiseObservation();
    },
  );

  it("prioritizes an abort raised by provider part introspection", async function () {
    const fixture = transportFixture();
    const controller = new AbortController();
    const hostilePart = new Proxy(
      {},
      {
        getOwnPropertyDescriptor() {
          controller.abort(
            new DOMException("Synthetic part cancellation.", "AbortError"),
          );
          throw new Error("AI_REVIEWER_STREAM_PART_PROXY_SECRET");
        },
      },
    );
    fixture.model.doStream.mockResolvedValue(
      providerStreamResult([hostilePart]).result,
    );

    const error = await captureError(
      captureStream(fixture.transport, streamRequest, {
        signal: controller.signal,
      }),
    );

    expect(error).toMatchObject({
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    expect(error.message).not.toContain("AI_REVIEWER_STREAM_PART_PROXY_SECRET");
  });

  it("bounds a stream getter failure without exposing its content", async function () {
    const fixture = transportFixture();
    const result = {};
    Object.defineProperty(result, "stream", {
      get() {
        throw new Error("AI_REVIEWER_STREAM_GETTER_SECRET");
      },
    });
    fixture.model.doStream.mockResolvedValue(result);

    const error = await captureError(captureStream(fixture.transport));

    expect(error).toMatchObject({
      code: "AI_PROVIDER_SCHEMA_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(error.message).not.toContain("AI_REVIEWER_STREAM_GETTER_SECRET");
  });

  it.each([
    {
      name: "getter throws",
      defineGetReader(stream) {
        Object.defineProperty(stream, "getReader", {
          get() {
            throw new Error("AI_REVIEWER_GET_READER_GETTER_SECRET");
          },
        });
      },
    },
    {
      name: "call throws",
      defineGetReader(stream) {
        Object.defineProperty(stream, "getReader", {
          value: vi.fn(() => {
            throw new Error("AI_REVIEWER_GET_READER_CALL_SECRET");
          }),
        });
      },
    },
    {
      name: "accessor is invalid",
      defineGetReader(stream) {
        Object.defineProperty(stream, "getReader", {
          value: null,
        });
      },
    },
    {
      name: "accessor is a rejected native promise",
      defineGetReader(stream) {
        Object.defineProperty(stream, "getReader", {
          value: Promise.reject(
            new Error("AI_REVIEWER_GET_READER_ACCESSOR_PROMISE_SECRET"),
          ),
        });
      },
    },
    {
      name: "returns null",
      defineGetReader(stream) {
        Object.defineProperty(stream, "getReader", {
          value: vi.fn(() => null),
        });
      },
    },
    {
      name: "returns a primitive",
      defineGetReader(stream) {
        Object.defineProperty(stream, "getReader", {
          value: vi.fn(() => 17),
        });
      },
    },
    {
      name: "returns a rejected native promise",
      defineGetReader(stream) {
        Object.defineProperty(stream, "getReader", {
          value() {
            return Promise.reject(
              new Error("AI_REVIEWER_GET_READER_PROMISE_SECRET"),
            );
          },
        });
      },
    },
    {
      name: "returns an unusable object",
      defineGetReader(stream) {
        Object.defineProperty(stream, "getReader", {
          value: vi.fn(() => ({})),
        });
      },
    },
  ])(
    "cancels an unlocked provider stream when its getReader $name",
    async function ({ defineGetReader }) {
      const fixture = transportFixture();
      const cancel = vi.fn();
      const stream = {
        cancel,
      };
      defineGetReader(stream);
      fixture.model.doStream.mockResolvedValue({
        stream,
      });

      const error = await captureError(captureStream(fixture.transport));

      expect(error).toMatchObject({
        code: "AI_PROVIDER_SCHEMA_INVALID",
        category: "schema",
        retryable: false,
      });
      expect(error.message).not.toContain("AI_REVIEWER_");
      expect(cancel).toHaveBeenCalledExactlyOnceWith(undefined);
    },
  );

  it.each([
    {
      name: "stream descriptor trap",
      result(rejected) {
        return new Proxy(
          {},
          {
            getOwnPropertyDescriptor() {
              throw rejected;
            },
          },
        );
      },
    },
    {
      name: "getReader getter",
      result(rejected) {
        const stream = {
          cancel: vi.fn(),
        };
        Object.defineProperty(stream, "getReader", {
          get() {
            throw rejected;
          },
        });
        return { stream };
      },
    },
    {
      name: "getReader invocation",
      result(rejected) {
        return {
          stream: {
            cancel: vi.fn(),
            getReader() {
              throw rejected;
            },
          },
        };
      },
    },
    ...["read", "cancel", "releaseLock"].map((property) => ({
      name: `reader ${property} getter`,
      result(rejected) {
        const reader = {
          read: vi.fn(),
          cancel: vi.fn(),
          releaseLock: vi.fn(),
        };
        Object.defineProperty(reader, property, {
          get() {
            throw rejected;
          },
        });
        return {
          stream: {
            cancel: vi.fn(),
            getReader: vi.fn(() => reader),
          },
        };
      },
    })),
    {
      name: "reader cancel invocation",
      result(rejected) {
        return {
          stream: {
            cancel: vi.fn(),
            getReader: vi.fn(() => ({
              read: null,
              cancel() {
                throw rejected;
              },
              releaseLock: vi.fn(),
            })),
          },
        };
      },
    },
    {
      name: "reader release invocation",
      result(rejected) {
        return {
          stream: {
            cancel: vi.fn(),
            getReader: vi.fn(() => ({
              read: null,
              cancel: vi.fn(),
              releaseLock() {
                throw rejected;
              },
            })),
          },
        };
      },
    },
    {
      name: "stream cancel getter",
      result(rejected) {
        const stream = {
          getReader() {
            throw new Error("Synthetic getReader failure.");
          },
        };
        Object.defineProperty(stream, "cancel", {
          get() {
            throw rejected;
          },
        });
        return { stream };
      },
    },
    {
      name: "stream cancel invocation",
      result(rejected) {
        return {
          stream: {
            cancel() {
              throw rejected;
            },
            getReader() {
              throw new Error("Synthetic getReader failure.");
            },
          },
        };
      },
    },
  ])(
    "observes a rejected native Promise thrown by provider $name",
    async function ({ result }) {
      const fixture = transportFixture();
      const rejected = Promise.reject(
        new Error("AI_REVIEWER_THROWN_PROVIDER_PROMISE_PRIVATE"),
      );
      fixture.model.doStream.mockResolvedValue(result(rejected));

      const error = await captureError(captureStream(fixture.transport));

      expect(error).toMatchObject({
        code: "AI_PROVIDER_SCHEMA_INVALID",
        category: "schema",
        retryable: false,
      });
      expect(error.message).not.toContain("AI_REVIEWER_");
      await flushProviderPromiseObservation();
    },
  );

  it("observes a rejected native promise used as the provider stream", async function () {
    const fixture = transportFixture();
    fixture.model.doStream.mockResolvedValue({
      stream: Promise.reject(new Error("AI_REVIEWER_STREAM_PROMISE_SECRET")),
    });

    const error = await captureError(captureStream(fixture.transport));

    expect(error).toMatchObject({
      code: "AI_PROVIDER_SCHEMA_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(error.message).not.toContain("AI_REVIEWER_");
  });

  it("observes a rejected native promise in an invalid stream cancel slot", async function () {
    const fixture = transportFixture();
    fixture.model.doStream.mockResolvedValue({
      stream: {
        cancel: Promise.reject(
          new Error("AI_REVIEWER_STREAM_CANCEL_ACCESSOR_PROMISE_SECRET"),
        ),
        getReader() {
          throw new Error("AI_REVIEWER_GET_READER_FAILURE_SECRET");
        },
      },
    });

    const error = await captureError(captureStream(fixture.transport));

    expect(error).toMatchObject({
      code: "AI_PROVIDER_SCHEMA_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(error.message).not.toContain("AI_REVIEWER_");
  });

  it.each([
    {
      name: "throws",
      getRead() {
        throw new Error("AI_REVIEWER_READER_GETTER_SECRET");
      },
    },
    {
      name: "is invalid",
      getRead() {
        return null;
      },
    },
  ])(
    "cancels and releases an acquired reader when its read accessor $name",
    async function ({ getRead }) {
      const fixture = transportFixture();
      const calls = [];
      const cancel = vi.fn(() => {
        calls.push("cancel");
      });
      const releaseLock = vi.fn(() => {
        calls.push("release");
      });
      const reader = {
        cancel,
        releaseLock,
      };
      Object.defineProperty(reader, "read", {
        get: getRead,
      });
      const getReader = vi.fn(() => reader);
      fixture.model.doStream.mockResolvedValue({
        stream: {
          getReader,
        },
      });

      const error = await captureError(captureStream(fixture.transport));

      expect(error).toMatchObject({
        code: "AI_PROVIDER_SCHEMA_INVALID",
        category: "schema",
        retryable: false,
      });
      expect(error.message).not.toContain("AI_REVIEWER_");
      expect(getReader).toHaveBeenCalledOnce();
      expect(cancel).toHaveBeenCalledOnce();
      expect(releaseLock).toHaveBeenCalledOnce();
      expect(calls).toEqual(["cancel", "release"]);
    },
  );

  it.each([
    {
      name: "throws synchronously",
      cancel(calls) {
        calls.push("reader-cancel");
        throw new Error("AI_REVIEWER_READER_CANCEL_THROW_SECRET");
      },
    },
    {
      name: "rejects asynchronously",
      cancel(calls) {
        calls.push("reader-cancel");
        return Promise.reject(
          new Error("AI_REVIEWER_READER_CANCEL_REJECTION_SECRET"),
        );
      },
    },
    {
      name: "returns a hostile thenable",
      cancel(calls) {
        calls.push("reader-cancel");
        return {
          get then() {
            throw new Error("AI_REVIEWER_READER_CANCEL_THENABLE_SECRET");
          },
        };
      },
    },
    {
      name: "throws while its native promise is normalized",
      cancel(calls) {
        calls.push("reader-cancel");
        const result = Promise.resolve();
        Object.defineProperty(result, "constructor", {
          get() {
            throw new Error("AI_REVIEWER_READER_CANCEL_CONSTRUCTOR_SECRET");
          },
        });
        return result;
      },
    },
  ])(
    "falls back to the released stream when invalid reader cancellation $name",
    async function ({ cancel }) {
      const fixture = transportFixture();
      const calls = [];
      const streamCancel = vi.fn(() => {
        calls.push("stream-cancel");
      });
      const releaseLock = vi.fn(() => {
        calls.push("release");
      });
      const reader = {
        read: null,
        cancel: vi.fn(() => cancel(calls)),
        releaseLock,
      };
      const stream = {
        cancel: streamCancel,
        getReader: vi.fn(() => reader),
      };
      fixture.model.doStream.mockResolvedValue({
        stream,
      });

      const error = await captureError(captureStream(fixture.transport));

      expect(error).toMatchObject({
        code: "AI_PROVIDER_SCHEMA_INVALID",
        category: "schema",
        retryable: false,
      });
      expect(error.message).not.toContain("AI_REVIEWER_");
      await vi.waitFor(() => {
        expect(streamCancel).toHaveBeenCalledExactlyOnceWith(undefined);
      });
      expect(reader.cancel).toHaveBeenCalledOnce();
      expect(releaseLock).toHaveBeenCalledOnce();
      expect(calls).toEqual(["reader-cancel", "release", "stream-cancel"]);
    },
  );

  it("observes a rejected native reader-cancel promise without invoking its hostile then", async function () {
    const fixture = transportFixture();
    const calls = [];
    let readerCancelCalls = 0;
    let hostileThenCalls = 0;
    const streamCancel = vi.fn(() => {
      calls.push("stream-cancel");
    });
    const releaseLock = vi.fn(() => {
      calls.push("release");
    });
    const reader = {
      read: null,
      cancel() {
        readerCancelCalls += 1;
        calls.push("reader-cancel");
        const result = Promise.reject(
          new Error("AI_REVIEWER_READER_CANCEL_NATIVE_SECRET"),
        );
        Object.defineProperty(result, "then", {
          value() {
            hostileThenCalls += 1;
            throw new Error("AI_REVIEWER_READER_CANCEL_THEN_SECRET");
          },
        });
        return result;
      },
      releaseLock,
    };
    fixture.model.doStream.mockResolvedValue({
      stream: {
        cancel: streamCancel,
        getReader: vi.fn(() => reader),
      },
    });

    const error = await captureError(captureStream(fixture.transport));

    expect(error).toMatchObject({
      code: "AI_PROVIDER_SCHEMA_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(error.message).not.toContain("AI_REVIEWER_");
    await vi.waitFor(() => {
      expect(streamCancel).toHaveBeenCalledExactlyOnceWith(undefined);
    });
    expect(readerCancelCalls).toBe(1);
    expect(hostileThenCalls).toBe(0);
    expect(releaseLock).toHaveBeenCalledOnce();
    expect(calls).toEqual(["reader-cancel", "release", "stream-cancel"]);
  });

  it.each([
    {
      name: "succeeds",
      cancel() {},
    },
    {
      name: "fulfills asynchronously",
      cancel() {
        return Promise.resolve();
      },
    },
    {
      name: "does not settle",
      cancel() {
        return new Promise(() => {});
      },
    },
  ])(
    "does not duplicate stream cancellation when invalid reader cancellation $name",
    async function ({ cancel }) {
      const fixture = transportFixture();
      const streamCancel = vi.fn();
      const releaseLock = vi.fn();
      const reader = {
        read: null,
        cancel: vi.fn(cancel),
        releaseLock,
      };
      fixture.model.doStream.mockResolvedValue({
        stream: {
          cancel: streamCancel,
          getReader: vi.fn(() => reader),
        },
      });

      const error = await captureError(captureStream(fixture.transport));

      expect(error).toMatchObject({
        code: "AI_PROVIDER_SCHEMA_INVALID",
        category: "schema",
        retryable: false,
      });
      expect(reader.cancel).toHaveBeenCalledOnce();
      expect(releaseLock).toHaveBeenCalledOnce();
      await Promise.resolve();
      expect(streamCancel).not.toHaveBeenCalled();
    },
  );

  it("does not invoke a fulfilled native reader-cancel promise's hostile then", async function () {
    const fixture = transportFixture();
    let readerCancelCalls = 0;
    let hostileThenCalls = 0;
    const streamCancel = vi.fn();
    const releaseLock = vi.fn();
    const reader = {
      read: null,
      cancel() {
        readerCancelCalls += 1;
        const result = Promise.resolve();
        Object.defineProperty(result, "then", {
          value(_onFulfilled, onRejected) {
            hostileThenCalls += 1;
            onRejected(new Error("AI_REVIEWER_FALSE_CANCEL_REJECTION_ONE"));
            onRejected(new Error("AI_REVIEWER_FALSE_CANCEL_REJECTION_TWO"));
          },
        });
        return result;
      },
      releaseLock,
    };
    fixture.model.doStream.mockResolvedValue({
      stream: {
        cancel: streamCancel,
        getReader: vi.fn(() => reader),
      },
    });

    const error = await captureError(captureStream(fixture.transport));

    expect(error).toMatchObject({
      code: "AI_PROVIDER_SCHEMA_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(readerCancelCalls).toBe(1);
    expect(hostileThenCalls).toBe(0);
    expect(releaseLock).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(streamCancel).not.toHaveBeenCalled();
  });

  it("uses one cleanup-reason snapshot when reader cancellation aborts", async function () {
    const fixture = transportFixture();
    const controller = new AbortController();
    const reason = new DOMException(
      "Synthetic cleanup cancellation.",
      "AbortError",
    );
    const calls = [];
    const streamCancel = vi.fn((cancelReason) => {
      calls.push(["stream-cancel", cancelReason]);
    });
    const releaseLock = vi.fn(() => {
      calls.push(["release"]);
    });
    const cancel = vi.fn((cancelReason) => {
      calls.push(["reader-cancel", cancelReason]);
      controller.abort(reason);
      return Promise.reject(
        new Error("AI_REVIEWER_READER_CANCEL_AFTER_ABORT_SECRET"),
      );
    });
    fixture.model.doStream.mockResolvedValue({
      stream: {
        cancel: streamCancel,
        getReader: vi.fn(() => ({
          read: null,
          cancel,
          releaseLock,
        })),
      },
    });

    const error = await captureError(
      captureStream(fixture.transport, streamRequest, {
        signal: controller.signal,
      }),
    );

    expect(error).toMatchObject({
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    await vi.waitFor(() => {
      expect(streamCancel).toHaveBeenCalledOnce();
    });
    expect(cancel).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(streamCancel).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(releaseLock).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      ["reader-cancel", undefined],
      ["release"],
      ["stream-cancel", undefined],
    ]);
  });

  it("lets a cleanup-induced timeout override a malformed stream part", async function () {
    const fixture = transportFixture();
    const controller = new AbortController();
    const reason = new DOMException(
      "Synthetic cleanup deadline.",
      "TimeoutError",
    );
    const reader = readerStreamFixture(
      () =>
        Promise.resolve({
          done: false,
          value: {
            type: "malformed",
          },
        }),
      {
        cancel: vi.fn(() => {
          controller.abort(reason);
        }),
      },
    );
    fixture.model.doStream.mockResolvedValue(reader.result);

    const error = await captureError(
      captureStream(fixture.transport, streamRequest, {
        signal: controller.signal,
      }),
    );

    expect(error).toMatchObject({
      code: "AI_REQUEST_TIMEOUT",
      category: "timeout",
      retryable: true,
    });
    expect(reader.cancel).toHaveBeenCalledOnce();
    expect(reader.releaseLock).toHaveBeenCalledOnce();
  });

  it("redacts a hostile native promise returned by reader.read", async function () {
    const fixture = transportFixture();
    let readCalls = 0;
    let hostileThenCalls = 0;
    const cancel = vi.fn();
    const releaseLock = vi.fn();
    const reader = {
      read() {
        readCalls += 1;
        const result = Promise.reject(
          new Error("AI_REVIEWER_HOSTILE_READ_PROMISE_SECRET"),
        );
        Object.defineProperty(result, "then", {
          value() {
            hostileThenCalls += 1;
            throw new Error("AI_REVIEWER_HOSTILE_READ_THEN_SECRET");
          },
        });
        return result;
      },
      cancel,
      releaseLock,
    };
    fixture.model.doStream.mockResolvedValue({
      stream: {
        getReader: vi.fn(() => reader),
      },
    });

    const error = await captureError(captureStream(fixture.transport));

    expect(error).toMatchObject({
      code: "AI_PROVIDER_FAILED",
      category: "provider",
      retryable: true,
    });
    expect(error.message).not.toContain("AI_REVIEWER_");
    expect(readCalls).toBe(1);
    expect(hostileThenCalls).toBe(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it("redacts a hostile native promise returned by doStream", async function () {
    let dispatchCalls = 0;
    let hostileThenCalls = 0;
    const model = {
      specificationVersion: "v3",
      doGenerate() {},
      doStream() {
        dispatchCalls += 1;
        const result = Promise.reject(
          new Error("AI_REVIEWER_HOSTILE_DISPATCH_PROMISE_SECRET"),
        );
        Object.defineProperty(result, "then", {
          value() {
            hostileThenCalls += 1;
            throw new Error("AI_REVIEWER_HOSTILE_DISPATCH_THEN_SECRET");
          },
        });
        return result;
      },
    };
    const transport = new OllamaOpenAiTransport({
      baseUrl,
      modelTag,
      createProvider() {
        return {
          chatModel() {
            return model;
          },
        };
      },
      fetchImpl: vi.fn(async () => new Response("{}", { status: 200 })),
    });

    const error = await captureError(captureStream(transport));

    expect(error).toMatchObject({
      code: "AI_PROVIDER_FAILED",
      category: "provider",
      retryable: true,
    });
    expect(error.message).not.toContain("AI_REVIEWER_");
    expect(dispatchCalls).toBe(1);
    expect(hostileThenCalls).toBe(0);
  });

  it("observes an invalid rejected stream without invoking its hostile own then", async function () {
    const fixture = transportFixture();
    let hostileThenCalls = 0;
    const rejected = Promise.reject(
      new Error("AI_REVIEWER_INVALID_STREAM_PROMISE_PRIVATE"),
    );
    Object.defineProperty(rejected, "then", {
      value() {
        hostileThenCalls += 1;
        throw new Error("AI_REVIEWER_INVALID_STREAM_THEN_PRIVATE");
      },
    });
    fixture.model.doStream.mockResolvedValue({
      stream: rejected,
    });

    const error = await captureError(captureStream(fixture.transport));

    expect(error).toMatchObject({
      code: "AI_PROVIDER_SCHEMA_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(error.message).not.toContain("AI_REVIEWER_");
    expect(hostileThenCalls).toBe(0);
    await flushProviderPromiseObservation();
  });

  it.each(["read", "cancel", "releaseLock"])(
    "observes a rejected native promise in an invalid reader %s accessor",
    async function (property) {
      const fixture = transportFixture();
      const rejected = Promise.reject(
        new Error(`AI_REVIEWER_INVALID_${property.toUpperCase()}_SECRET`),
      );
      const reader = {
        read: vi.fn(),
        cancel: vi.fn(),
        releaseLock: vi.fn(),
      };
      reader[property] = rejected;
      fixture.model.doStream.mockResolvedValue({
        stream: {
          cancel: vi.fn(),
          getReader: vi.fn(() => reader),
        },
      });

      const error = await captureError(captureStream(fixture.transport));

      expect(error).toMatchObject({
        code: "AI_PROVIDER_SCHEMA_INVALID",
        category: "schema",
        retryable: false,
      });
      expect(error.message).not.toContain("AI_REVIEWER_");
      await Promise.resolve();
    },
  );

  it("observes a rejected native promise returned by releaseLock", async function () {
    const fixture = transportFixture();
    let releaseCalls = 0;
    const reader = {
      read: null,
      cancel: vi.fn(),
      releaseLock() {
        releaseCalls += 1;
        return Promise.reject(
          new Error("AI_REVIEWER_RELEASE_REJECTION_SECRET"),
        );
      },
    };
    fixture.model.doStream.mockResolvedValue({
      stream: {
        getReader: vi.fn(() => reader),
      },
    });

    const error = await captureError(captureStream(fixture.transport));

    expect(error).toMatchObject({
      code: "AI_PROVIDER_SCHEMA_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(error.message).not.toContain("AI_REVIEWER_");
    expect(releaseCalls).toBe(1);
  });

  it("observes a hostile rejected promise returned by stream cancellation", async function () {
    const fixture = transportFixture();
    let streamCancelCalls = 0;
    let hostileCatchCalls = 0;
    const stream = {
      cancel() {
        streamCancelCalls += 1;
        const result = Promise.reject(
          new Error("AI_REVIEWER_STREAM_CANCEL_PROMISE_SECRET"),
        );
        Object.defineProperty(result, "catch", {
          value() {
            hostileCatchCalls += 1;
            throw new Error("AI_REVIEWER_STREAM_CANCEL_CATCH_SECRET");
          },
        });
        return result;
      },
      getReader: vi.fn(() => ({})),
    };
    fixture.model.doStream.mockResolvedValue({
      stream,
    });

    const error = await captureError(captureStream(fixture.transport));

    expect(error).toMatchObject({
      code: "AI_PROVIDER_SCHEMA_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(error.message).not.toContain("AI_REVIEWER_");
    expect(streamCancelCalls).toBe(1);
    expect(hostileCatchCalls).toBe(0);
  });

  it("fails closed before streaming when global telemetry is registered", async function () {
    const fixture = transportFixture();
    const previous = Reflect.get(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS");
    Reflect.set(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS", [
      {
        name: "synthetic-unsafe-integration",
      },
    ]);
    try {
      const error = await captureError(
        Promise.resolve().then(() => captureStream(fixture.transport)),
      );

      expect(error).toMatchObject({
        code: "AI_SDK_TELEMETRY_UNSAFE",
        category: "configuration",
        retryable: false,
      });
      expect(fixture.model.doStream).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) {
        Reflect.deleteProperty(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS");
      } else {
        Reflect.set(globalThis, "AI_SDK_TELEMETRY_INTEGRATIONS", previous);
      }
    }
  });

  it.each(["qwen3.5:4b", "hf.co/org/repo:Q4_K_M", "library/model.v1:latest"])(
    "accepts canonical explicit model tag %s",
    function (tag) {
      const fixture = transportFixture({ modelTag: tag });

      expect(fixture.chatModel).toHaveBeenCalledExactlyOnceWith(tag);
      expect(fixture.fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([
    "qwen 3.5",
    " qwen3.5:4b",
    "qwen3.5:4b ",
    "qwen3.5:",
    ":4b",
    "qwen3.5:4b\n",
    "qwen3.5:4b?remote=true",
  ])(
    "rejects noncanonical model tag %j before provider creation",
    function (tag) {
      const createProvider = vi.fn();
      const fetchImpl = vi.fn();

      expect(
        () =>
          new OllamaOpenAiTransport({
            baseUrl,
            modelTag: tag,
            createProvider,
            fetchImpl,
          }),
      ).toThrow(
        "modelId must be a canonical OpenAI-compatible model identifier",
      );
      expect(createProvider).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("rejects a disallowed endpoint before provider construction", function () {
    const createProvider = vi.fn();
    const fetchImpl = vi.fn();

    expect(
      () =>
        new OllamaOpenAiTransport({
          baseUrl: "http://192.168.0.1:11434/v1",
          modelTag,
          createProvider,
          fetchImpl,
        }),
    ).toThrow("OpenAI-compatible endpoint is not allowed");
    expect(createProvider).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects malformed provider factories and chat models", function () {
    expect(
      () =>
        new OllamaOpenAiTransport({
          baseUrl,
          modelTag,
          createProvider: /** @type {never} */ (null),
          fetchImpl: vi.fn(),
        }),
    ).toThrow("createProvider must be a function");
    expect(
      () =>
        new OllamaOpenAiTransport({
          baseUrl,
          modelTag,
          createProvider: vi.fn(() => ({})),
          fetchImpl: vi.fn(),
        }),
    ).toThrow("provider with a chatModel method");
    expect(
      () =>
        new OllamaOpenAiTransport({
          baseUrl,
          modelTag,
          createProvider: vi.fn(() => ({
            chatModel: () => "hosted:model",
          })),
          fetchImpl: vi.fn(),
        }),
    ).toThrow("concrete Chat Completions model");
  });

  it.each([
    {
      name: "provider object with valid chatModel",
      shouldConstruct: true,
      createProvider() {
        const model = {
          specificationVersion: "v3",
          doGenerate() {},
          doStream() {},
        };
        return Object.assign(
          Promise.reject(
            new Error("AI_REVIEWER_PROVIDER_PROMISE_OBJECT_SECRET"),
          ),
          {
            chatModel() {
              return model;
            },
          },
        );
      },
    },
    {
      name: "provider object without chatModel",
      shouldConstruct: false,
      createProvider() {
        return Promise.reject(
          new Error("AI_REVIEWER_PROVIDER_PROMISE_SHAPE_SECRET"),
        );
      },
    },
    {
      name: "provider chatModel",
      shouldConstruct: false,
      createProvider() {
        return {
          chatModel: Promise.reject(
            new Error("AI_REVIEWER_PROVIDER_CHAT_PROMISE_SECRET"),
          ),
        };
      },
    },
    {
      name: "model object with valid v3 methods",
      shouldConstruct: true,
      createProvider() {
        const model = Object.assign(
          Promise.reject(new Error("AI_REVIEWER_MODEL_PROMISE_OBJECT_SECRET")),
          {
            specificationVersion: "v3",
            doGenerate() {},
            doStream() {},
          },
        );
        return {
          chatModel() {
            return model;
          },
        };
      },
    },
    {
      name: "model specificationVersion",
      shouldConstruct: false,
      createProvider() {
        return {
          chatModel() {
            return {
              specificationVersion: Promise.reject(
                new Error("AI_REVIEWER_MODEL_SPECIFICATION_PROMISE_SECRET"),
              ),
              doGenerate() {},
              doStream() {},
            };
          },
        };
      },
    },
    {
      name: "model doGenerate",
      shouldConstruct: false,
      createProvider() {
        return {
          chatModel() {
            return {
              specificationVersion: "v3",
              doGenerate: Promise.reject(
                new Error("AI_REVIEWER_MODEL_GENERATE_PROMISE_SECRET"),
              ),
              doStream() {},
            };
          },
        };
      },
    },
    {
      name: "model doStream",
      shouldConstruct: false,
      createProvider() {
        return {
          chatModel() {
            return {
              specificationVersion: "v3",
              doGenerate() {},
              doStream: Promise.reject(
                new Error("AI_REVIEWER_MODEL_STREAM_PROMISE_SECRET"),
              ),
            };
          },
        };
      },
    },
  ])(
    "observes a rejected native promise in the constructor $name slot",
    async function ({ createProvider, shouldConstruct }) {
      let transport;
      let error;
      try {
        transport = new OllamaOpenAiTransport({
          baseUrl,
          modelTag,
          createProvider: /** @type {never} */ (createProvider),
          fetchImpl: vi.fn(),
        });
      } catch (cause) {
        error = cause;
      }

      if (shouldConstruct) {
        expect(transport).toBeInstanceOf(OllamaOpenAiTransport);
        expect(error).toBeUndefined();
      } else {
        expect(error).toBeInstanceOf(TypeError);
        expect(error.message).not.toContain("AI_REVIEWER_");
        expect(transport).toBeUndefined();
      }
      await new Promise((resolve) => setImmediate(resolve));
    },
  );

  it.each([
    {
      name: "specificationVersion before a throwing doGenerate getter",
      createModel(rejected) {
        const model = {
          specificationVersion: rejected,
          doStream() {},
        };
        Object.defineProperty(model, "doGenerate", {
          get() {
            throw new Error("Synthetic later model getter failure.");
          },
        });
        return model;
      },
    },
    {
      name: "doGenerate before a throwing doStream getter",
      createModel(rejected) {
        const model = {
          specificationVersion: "v3",
          doGenerate: rejected,
        };
        Object.defineProperty(model, "doStream", {
          get() {
            throw new Error("Synthetic later model getter failure.");
          },
        });
        return model;
      },
    },
  ])(
    "observes constructor $name immediately",
    async function ({ createModel }) {
      const rejected = Promise.reject(
        new Error("AI_REVIEWER_EARLY_MODEL_SLOT_PROMISE_PRIVATE"),
      );
      let error;
      try {
        new OllamaOpenAiTransport({
          baseUrl,
          modelTag,
          createProvider() {
            return {
              chatModel() {
                return createModel(rejected);
              },
            };
          },
          fetchImpl: vi.fn(),
        });
      } catch (cause) {
        error = cause;
      }

      expect(error).toMatchObject({
        code: "AI_PROVIDER_FAILED",
        category: "provider",
        retryable: true,
      });
      await flushProviderPromiseObservation();
    },
  );

  it.each([
    "factory invocation",
    "chatModel getter",
    "chatModel invocation",
    "model shape getter",
  ])(
    "redacts a provider-owned AgentGatewayError from constructor %s",
    function (boundary) {
      const providerError = providerAgentGatewayError("CONSTRUCTION");
      let error;
      try {
        new OllamaOpenAiTransport({
          baseUrl,
          modelTag,
          createProvider: providerConstructionThrower(boundary, providerError),
          fetchImpl: vi.fn(),
        });
      } catch (cause) {
        error = cause;
      }

      expect(error).not.toBe(providerError);
      expect(error).toMatchObject({
        code: "AI_PROVIDER_FAILED",
        category: "provider",
        retryable: true,
      });
      expect(error.message).not.toContain("AI_REVIEWER_");
      expect(error.code).not.toContain("AI_REVIEWER_");
    },
  );

  it.each([
    "factory invocation",
    "chatModel getter",
    "chatModel invocation",
    "model shape getter",
  ])(
    "observes a rejected native Promise thrown by constructor %s",
    async function (boundary) {
      const rejected = Promise.reject(
        new Error("AI_REVIEWER_CONSTRUCTION_THROWN_PROMISE_PRIVATE"),
      );
      let error;
      try {
        new OllamaOpenAiTransport({
          baseUrl,
          modelTag,
          createProvider: providerConstructionThrower(boundary, rejected),
          fetchImpl: vi.fn(),
        });
      } catch (cause) {
        error = cause;
      }

      expect(error).toMatchObject({
        code: "AI_PROVIDER_FAILED",
        category: "provider",
        retryable: true,
      });
      expect(error.message).not.toContain("AI_REVIEWER_");
      await flushProviderPromiseObservation();
    },
  );

  it.each([
    {
      name: "factory invocation",
      createProvider() {
        throw new Error("AI_REVIEWER_PROVIDER_CONSTRUCTION_SECRET");
      },
    },
    {
      name: "chatModel getter",
      createProvider() {
        const provider = {};
        Object.defineProperty(provider, "chatModel", {
          get() {
            throw new Error("AI_REVIEWER_PROVIDER_CONSTRUCTION_SECRET");
          },
        });
        return provider;
      },
    },
    {
      name: "chatModel invocation",
      createProvider() {
        return {
          chatModel() {
            throw new Error("AI_REVIEWER_PROVIDER_CONSTRUCTION_SECRET");
          },
        };
      },
    },
    {
      name: "model shape getter",
      createProvider() {
        const model = {};
        Object.defineProperty(model, "specificationVersion", {
          get() {
            throw new Error("AI_REVIEWER_PROVIDER_CONSTRUCTION_SECRET");
          },
        });
        return {
          chatModel() {
            return model;
          },
        };
      },
    },
  ])("bounds provider $name failure", function ({ createProvider }) {
    let error;
    try {
      new OllamaOpenAiTransport({
        baseUrl,
        modelTag,
        createProvider,
        fetchImpl: vi.fn(),
      });
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(AgentGatewayError);
    expect(error).toMatchObject({
      code: "AI_PROVIDER_FAILED",
      category: "provider",
      retryable: true,
    });
    expect(error.message).not.toContain(
      "AI_REVIEWER_PROVIDER_CONSTRUCTION_SECRET",
    );
  });

  it("rejects a chat model missing specificationVersion", function () {
    expect(
      () =>
        new OllamaOpenAiTransport({
          baseUrl,
          modelTag,
          createProvider: vi.fn(() => ({
            chatModel: () => ({
              doGenerate: vi.fn(),
              doStream: vi.fn(),
            }),
          })),
          fetchImpl: vi.fn(),
        }),
    ).toThrow("concrete Chat Completions model");
  });

  it.each(["v2", "v5"])(
    "rejects a chat model with specificationVersion %s",
    function (specificationVersion) {
      expect(
        () =>
          new OllamaOpenAiTransport({
            baseUrl,
            modelTag,
            createProvider: vi.fn(() => ({
              chatModel: () => ({
                specificationVersion,
                doGenerate: vi.fn(),
                doStream: vi.fn(),
              }),
            })),
            fetchImpl: vi.fn(),
          }),
      ).toThrow("concrete Chat Completions model");
    },
  );

  it("rejects a chat model missing doGenerate", function () {
    expect(
      () =>
        new OllamaOpenAiTransport({
          baseUrl,
          modelTag,
          createProvider: vi.fn(() => ({
            chatModel: () => ({
              specificationVersion: "v3",
              doStream: vi.fn(),
            }),
          })),
          fetchImpl: vi.fn(),
        }),
    ).toThrow("concrete Chat Completions model");
  });

  it("rejects a chat model missing doStream", function () {
    expect(
      () =>
        new OllamaOpenAiTransport({
          baseUrl,
          modelTag,
          createProvider: vi.fn(() => ({
            chatModel: () => ({
              specificationVersion: "v3",
              doGenerate: vi.fn(),
            }),
          })),
          fetchImpl: vi.fn(),
        }),
    ).toThrow("concrete Chat Completions model");
  });

  it("preserves cancellation and forces redirect rejection", async function () {
    const fixture = transportFixture();
    const providerOptions = fixture.createProvider.mock.calls[0][0];
    const controller = new AbortController();
    const response = await providerOptions.fetch(
      `${baseUrl}/chat/completions`,
      {
        method: "POST",
        redirect: "follow",
        signal: controller.signal,
      },
    );

    expect(response.status).toBe(200);
    expect(fixture.fetchImpl).toHaveBeenCalledExactlyOnceWith(
      `${baseUrl}/chat/completions`,
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        signal: controller.signal,
      }),
    );
  });

  it.each([
    "http://127.0.0.1:11434/v1/models",
    "http://127.0.0.1:11434/v1/chat/completions?model=x",
    "http://127.0.0.1:11435/v1/chat/completions",
    "http://localhost:11434/v1/chat/completions",
    "https://127.0.0.1:11434/v1/chat/completions",
  ])("rejects outbound URL %s before fetch", async function (requestUrl) {
    const fixture = transportFixture();
    const providerOptions = fixture.createProvider.mock.calls[0][0];

    const error = await captureError(providerOptions.fetch(requestUrl));

    expect(error).toMatchObject({
      code: "AI_OLLAMA_REQUEST_URL_NOT_ALLOWED",
      category: "configuration",
      retryable: false,
    });
    expect(fixture.fetchImpl).not.toHaveBeenCalled();
  });

  it("prevents provider code from mutating and rethrowing a local endpoint error", async function () {
    const model = concreteModel();
    let guardedFetch;
    const transport = new OllamaOpenAiTransport({
      baseUrl,
      modelTag,
      createProvider(options) {
        guardedFetch = options.fetch;
        return {
          chatModel() {
            return model;
          },
        };
      },
      fetchImpl: vi.fn(),
    });
    model.doGenerate.mockImplementation(async () => {
      try {
        await guardedFetch(`${baseUrl}/models`);
      } catch (error) {
        Reflect.set(error, "message", "AI_REVIEWER_MUTATED_MESSAGE_PRIVATE");
        Reflect.set(error, "code", "AI_REVIEWER_MUTATED_CODE_PRIVATE");
        Reflect.set(error, "category", "authentication");
        Reflect.set(error, "retryable", true);
        throw error;
      }
    });

    const error = await captureError(
      transport.generateChat({
        prompt: "Return exactly COMPAT_OK and nothing else.",
        maxOutputTokens: 32,
      }),
    );

    expect(error).toMatchObject({
      code: "AI_OLLAMA_REQUEST_URL_NOT_ALLOWED",
      category: "configuration",
      retryable: false,
    });
    expect(error.message).not.toContain("AI_REVIEWER_");
    expect(Object.isFrozen(error)).toBe(true);
  });

  it("accepts a Request input without replacing its abort signal", async function () {
    const fixture = transportFixture();
    const providerOptions = fixture.createProvider.mock.calls[0][0];
    const controller = new AbortController();
    const request = new Request(`${baseUrl}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
    });

    await providerOptions.fetch(request);

    expect(fixture.fetchImpl).toHaveBeenCalledOnce();
    const [forwardedRequest, forwardedInit] = fixture.fetchImpl.mock.calls[0];
    expect(forwardedRequest).toBe(request);
    expect(forwardedInit).toEqual({
      redirect: "error",
      dispatcher: expect.any(Agent),
    });
    const reason = new DOMException("Synthetic cancellation.", "AbortError");
    controller.abort(reason);
    expect(forwardedRequest.signal).toMatchObject({
      aborted: true,
      reason,
    });
  });

  it.each(Array.from({ length: 100 }, (_, index) => 300 + index))(
    "rejects returned redirect status %i after exactly one underlying request",
    async function (status) {
      const fetchImpl = vi.fn(async () => {
        return new Response(null, {
          status,
          headers: {
            location: "http://example.com/v1/chat/completions",
          },
        });
      });
      const fixture = transportFixture({ fetchImpl });
      const providerOptions = fixture.createProvider.mock.calls[0][0];

      const error = await captureError(
        providerOptions.fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
        }),
      );

      expect(error).toBeInstanceOf(AgentGatewayError);
      expect(error).toMatchObject({
        code: "AI_PROVIDER_REDIRECT_REJECTED",
        category: "provider",
        retryable: false,
      });
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(fetchImpl.mock.calls[0][1]).toMatchObject({
        redirect: "error",
      });
    },
  );

  it("keeps the OpenAI-compatible SDK import inside the transport adapter", function () {
    const productionImports = listProductionSourceFiles(appSourceDirectory)
      .flatMap((absolutePath) => {
        const source = fs.readFileSync(absolutePath, {
          encoding: "utf8",
        });
        return source.includes("@ai-sdk/openai-compatible")
          ? [absolutePath]
          : [];
      })
      .map((absolutePath) =>
        path
          .relative(appSourceDirectory, absolutePath)
          .split(path.sep)
          .join("/"),
      )
      .sort();

    expect(productionImports).toEqual(["OllamaOpenAiTransport.mjs"]);
  });

  it.each([
    {
      name: "a later content part after an invalid first part",
      result(rejected) {
        return plainGenerateResult({
          content: [
            {
              type: "reasoning",
              text: "unsupported",
            },
            {
              type: "text",
              text: rejected,
            },
          ],
        });
      },
    },
    {
      name: "content after an invalid finish reason",
      result(rejected) {
        return plainGenerateResult({
          content: [
            {
              type: "text",
              text: rejected,
            },
          ],
          finishReason: {
            unified: "other",
            raw: "other",
          },
        });
      },
    },
    {
      name: "known fields on a wrong content discriminant",
      result(rejected) {
        return plainGenerateResult({
          content: [
            {
              type: "tool-call",
              toolCallId: "synthetic-call",
              toolName: "lookup_synthetic_record",
              input: rejected,
            },
          ],
        });
      },
    },
  ])(
    "observes $name before rejecting a non-stream result",
    async function ({ result }) {
      const fixture = transportFixture();
      const rejected = Promise.reject(
        new Error("AI_REVIEWER_LATE_CONTENT_SLOT_PRIVATE"),
      );
      fixture.model.doGenerate.mockResolvedValue(result(rejected));

      const error = await captureError(
        fixture.transport.generateChat({
          prompt: "Return exactly COMPAT_OK and nothing else.",
          maxOutputTokens: 32,
        }),
      );

      expect(error).toMatchObject({
        code: "AI_PROVIDER_SCHEMA_INVALID",
        category: "schema",
        retryable: false,
      });
      expect(String(error)).not.toContain("AI_REVIEWER_");
      await flushProviderPromiseObservation();
    },
  );

  it("observes bounded non-stream warning entries while accepting the response", async function () {
    const fixture = transportFixture();
    const rejected = Promise.reject(
      new Error("AI_REVIEWER_NONSTREAM_WARNING_ENTRY_PRIVATE"),
    );
    fixture.model.doGenerate.mockResolvedValue(
      plainGenerateResult({
        warnings: [rejected],
      }),
    );

    const result = await fixture.transport.generateChat({
      prompt: "Return exactly COMPAT_OK and nothing else.",
      maxOutputTokens: 32,
    });

    expect(result).toMatchObject({ type: "completed", text: "COMPAT_OK" });
    await flushProviderPromiseObservation();
  });

  it("observes known content slots before rejecting an invalid generate envelope", async function () {
    const fixture = transportFixture();
    const rejected = Promise.reject(
      new Error("AI_REVIEWER_INVALID_ENVELOPE_CONTENT_PRIVATE"),
    );
    fixture.model.doGenerate.mockResolvedValue(
      plainGenerateResult({
        content: [
          {
            type: "text",
            text: rejected,
          },
        ],
        warnings: [
          {
            type: "other",
            message: "Synthetic warning.",
          },
        ],
      }),
    );

    const error = await captureError(
      fixture.transport.generateChat({
        prompt: "Return exactly COMPAT_OK and nothing else.",
        maxOutputTokens: 32,
      }),
    );

    expect(error).toMatchObject({
      code: "AI_PROVIDER_SCHEMA_INVALID",
      category: "schema",
      retryable: false,
    });
    await flushProviderPromiseObservation();
  });

  it("observes bounded stream warning entries before rejection", async function () {
    const fixture = transportFixture();
    const rejected = Promise.reject(
      new Error("AI_REVIEWER_STREAM_WARNING_ENTRY_PRIVATE"),
    );
    fixture.model.doStream.mockResolvedValue(
      providerStreamResult([
        {
          type: "stream-start",
          warnings: [rejected],
        },
      ]).result,
    );

    const error = await captureError(captureStream(fixture.transport));

    expect(error).toMatchObject({
      code: "AI_PROVIDER_SCHEMA_INVALID",
      category: "schema",
      retryable: false,
    });
    await flushProviderPromiseObservation();
  });

  it.each([
    {
      name: "text delta after finish",
      latePart(rejected) {
        return {
          type: "text-delta",
          id: rejected,
          delta: Promise.reject(
            new Error("AI_REVIEWER_POST_FINISH_DELTA_PRIVATE"),
          ),
        };
      },
    },
    {
      name: "duplicate finish",
      latePart(rejected) {
        return {
          type: "finish",
          finishReason: {
            unified: rejected,
            raw: "stop",
          },
          usage: {
            inputTokens: {
              total: 528,
            },
            outputTokens: {
              total: Promise.reject(
                new Error("AI_REVIEWER_DUPLICATE_FINISH_USAGE_PRIVATE"),
              ),
            },
          },
        };
      },
    },
  ])(
    "observes known fields on a $name before state rejection",
    async function ({ latePart }) {
      const fixture = transportFixture();
      const rejected = Promise.reject(
        new Error("AI_REVIEWER_POST_FINISH_SLOT_PRIVATE"),
      );
      fixture.model.doStream.mockResolvedValue(
        providerStreamResult([...plainStreamParts(), latePart(rejected)])
          .result,
      );

      const error = await captureError(captureStream(fixture.transport));

      expect(error).toMatchObject({
        code: "AI_PROVIDER_SCHEMA_INVALID",
        category: "schema",
        retryable: false,
      });
      await flushProviderPromiseObservation();
    },
  );

  it.each([
    ["reasoning-start", ["id"]],
    ["reasoning-delta", ["id", "delta"]],
    ["reasoning-end", ["id"]],
    [
      "tool-input-start",
      ["id", "toolName", "providerExecuted", "dynamic", "title"],
    ],
    ["tool-input-delta", ["id", "delta"]],
    ["tool-input-end", ["id"]],
    ["tool-approval-request", ["approvalId", "toolCallId"]],
    [
      "tool-call",
      ["toolCallId", "toolName", "input", "providerExecuted", "dynamic"],
    ],
    [
      "tool-result",
      ["toolCallId", "toolName", "result", "isError", "preliminary", "dynamic"],
    ],
    ["file", ["mediaType", "data"]],
    ["raw", ["rawValue"]],
    ["source", ["sourceType", "id", "url", "title", "mediaType", "filename"]],
  ])(
    "observes every safe known %s slot before rejecting the unsupported tag",
    async function (type, fields) {
      const fixture = transportFixture();
      const part = {
        type,
      };
      for (const field of fields) {
        part[field] = Promise.reject(
          new Error(`AI_REVIEWER_${type}_${field}_PRIVATE`),
        );
      }
      const providerMetadata = vi.fn(() => {
        throw new Error("AI_REVIEWER_PROVIDER_METADATA_PRIVATE");
      });
      Object.defineProperty(part, "providerMetadata", {
        get: providerMetadata,
      });
      fixture.model.doStream.mockResolvedValue(
        providerStreamResult([
          plainStreamParts()[0],
          part,
          ...plainStreamParts().slice(1),
        ]).result,
      );

      const error = await captureError(captureStream(fixture.transport));

      expect(error).toMatchObject({
        code: "AI_PROVIDER_SCHEMA_INVALID",
        category: "schema",
        retryable: false,
      });
      expect(providerMetadata).not.toHaveBeenCalled();
      await flushProviderPromiseObservation();
    },
  );

  it("observes safe response metadata fields without reading forbidden fields", async function () {
    const fixture = transportFixture();
    const part = {
      type: "response-metadata",
      id: Promise.reject(new Error("AI_REVIEWER_RESPONSE_METADATA_ID_PRIVATE")),
      timestamp: Promise.reject(
        new Error("AI_REVIEWER_RESPONSE_METADATA_TIMESTAMP_PRIVATE"),
      ),
      modelId: Promise.reject(
        new Error("AI_REVIEWER_RESPONSE_METADATA_MODEL_PRIVATE"),
      ),
    };
    const forbiddenGetters = ["headers", "providerMetadata", "raw"].map(
      (property) => {
        const getter = vi.fn(() => {
          throw new Error(`AI_REVIEWER_${property.toUpperCase()}_PRIVATE`);
        });
        Object.defineProperty(part, property, {
          get: getter,
        });
        return getter;
      },
    );
    fixture.model.doStream.mockResolvedValue(
      providerStreamResult([
        plainStreamParts()[0],
        part,
        ...plainStreamParts().slice(2),
      ]).result,
    );

    const error = await captureError(captureStream(fixture.transport));

    expect(error).toMatchObject({
      code: "AI_PROVIDER_SCHEMA_INVALID",
      category: "schema",
      retryable: false,
    });
    for (const getter of forbiddenGetters) {
      expect(getter).not.toHaveBeenCalled();
    }
    await flushProviderPromiseObservation();
  });

  it("observes own data siblings on a valid generate result", async function () {
    const fixture = transportFixture();
    const result = plainGenerateResult();
    for (const property of ["request", "response", "providerMetadata"]) {
      Object.defineProperty(result, property, {
        value: Promise.reject(
          new Error(`AI_REVIEWER_GENERATE_${property.toUpperCase()}_PRIVATE`),
        ),
        enumerable: true,
      });
    }
    fixture.model.doGenerate.mockResolvedValue(result);

    const completed = await fixture.transport.generateChat({
      prompt: "Return exactly COMPAT_OK and nothing else.",
      maxOutputTokens: 32,
    });

    expect(completed).toMatchObject({
      type: "completed",
      text: "COMPAT_OK",
    });
    await flushProviderPromiseObservation();
  });

  it("observes own data siblings on a valid stream result", async function () {
    const fixture = transportFixture();
    const result = providerStreamResult().result;
    for (const property of ["request", "response"]) {
      Object.defineProperty(result, property, {
        value: Promise.reject(
          new Error(`AI_REVIEWER_STREAM_${property.toUpperCase()}_PRIVATE`),
        ),
        enumerable: true,
      });
    }
    fixture.model.doStream.mockResolvedValue(result);

    const events = await captureStream(fixture.transport);

    expect(events.at(-1)).toMatchObject({
      type: "completed",
      finishReason: "stop",
    });
    await flushProviderPromiseObservation();
  });

  it("cancels a stream captured by a descriptor trap before honoring abort", async function () {
    const fixture = transportFixture();
    const controller = new AbortController();
    const reason = new DOMException(
      "AI_REVIEWER_RESULT_DESCRIPTOR_ABORT_PRIVATE",
      "AbortError",
    );
    const cancel = vi.fn();
    const stream = {
      cancel,
      getReader: vi.fn(),
    };
    const result = new Proxy(
      {
        stream,
      },
      {
        getOwnPropertyDescriptor(target, property) {
          const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
          if (property === "stream") {
            controller.abort(reason);
          }
          return descriptor;
        },
      },
    );
    fixture.model.doStream.mockResolvedValue(result);

    const error = await captureError(
      captureStream(fixture.transport, streamRequest, {
        signal: controller.signal,
      }),
    );

    expect(error).toMatchObject({
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
    expect(stream.getReader).not.toHaveBeenCalled();
  });

  it("unlocks a native stream when getReader aborts after acquisition", async function () {
    const fixture = transportFixture();
    const controller = new AbortController();
    const reason = new DOMException(
      "AI_REVIEWER_NATIVE_READER_ABORT_PRIVATE",
      "AbortError",
    );
    const underlyingCancel = vi.fn();
    const stream = new ReadableStream({
      cancel: underlyingCancel,
    });
    const nativeGetReader = stream.getReader.bind(stream);
    Object.defineProperty(stream, "getReader", {
      value() {
        const reader = nativeGetReader();
        controller.abort(reason);
        return reader;
      },
    });
    fixture.model.doStream.mockResolvedValue({
      stream,
    });

    const error = await captureError(
      captureStream(fixture.transport, streamRequest, {
        signal: controller.signal,
      }),
    );

    expect(error).toMatchObject({
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    await vi.waitFor(() => {
      expect(stream.locked).toBe(false);
      expect(underlyingCancel).toHaveBeenCalledExactlyOnceWith(reason);
    });
  });

  it("releases a native reader before stream fallback when cancel is invalid", async function () {
    const fixture = transportFixture();
    const controller = new AbortController();
    const reason = new DOMException(
      "AI_REVIEWER_INVALID_NATIVE_CANCEL_PRIVATE",
      "AbortError",
    );
    const underlyingCancel = vi.fn();
    const stream = new ReadableStream({
      cancel: underlyingCancel,
    });
    const nativeGetReader = stream.getReader.bind(stream);
    const releaseLock = vi.fn();
    Object.defineProperty(stream, "getReader", {
      value() {
        const reader = nativeGetReader();
        const nativeReleaseLock = reader.releaseLock.bind(reader);
        Object.defineProperties(reader, {
          cancel: {
            value: null,
          },
          releaseLock: {
            value: releaseLock.mockImplementation(() => nativeReleaseLock()),
          },
        });
        controller.abort(reason);
        return reader;
      },
    });
    fixture.model.doStream.mockResolvedValue({
      stream,
    });

    const error = await captureError(
      captureStream(fixture.transport, streamRequest, {
        signal: controller.signal,
      }),
    );

    expect(error).toMatchObject({
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    await vi.waitFor(() => {
      expect(releaseLock).toHaveBeenCalledOnce();
      expect(stream.locked).toBe(false);
      expect(underlyingCancel).toHaveBeenCalledExactlyOnceWith(reason);
    });
  });

  it.each(
    ["chat", "structured", "tool proposal", "tool continuation"].flatMap(
      (name) => [
        {
          name,
          boundary: "abort",
          reason: new DOMException(
            "Synthetic direct cancellation.",
            "AbortError",
          ),
          expected: {
            code: "AI_REQUEST_ABORTED",
            category: "aborted",
            retryable: false,
          },
        },
        {
          name,
          boundary: "timeout",
          reason: new DOMException(
            "Synthetic direct deadline.",
            "TimeoutError",
          ),
          expected: {
            code: "AI_REQUEST_TIMEOUT",
            category: "timeout",
            retryable: true,
          },
        },
      ],
    ),
  )(
    "settles a non-cooperative $name dispatch at $boundary and observes its late rejection",
    async function ({ name, reason, expected }) {
      const fixture = transportFixture();
      const invoke = await createDirectInvocation(fixture, name);
      const provider = deferred();
      fixture.model.doGenerate.mockImplementation(() => provider.promise);
      const controller = new AbortController();
      const pending = captureError(
        invoke({
          signal: controller.signal,
        }),
      );
      controller.abort(reason);
      const outcome = await Promise.race([
        pending,
        new Promise((resolve) => {
          setTimeout(() => resolve("did-not-settle"), 100);
        }),
      ]);
      provider.reject(
        new Error(`AI_REVIEWER_LATE_${name.replaceAll(" ", "_")}_PRIVATE`),
      );
      await flushProviderPromiseObservation();

      expect(outcome).not.toBe("did-not-settle");
      expect(outcome).toMatchObject(expected);
    },
  );

  it("accepts stream usage above a provided output token value", async function () {
    const fixture = transportFixture();
    const parts = plainStreamParts().map((part) =>
      part.type === "finish"
        ? {
            ...part,
            usage: {
              ...part.usage,
              outputTokens: {
                ...part.usage.outputTokens,
                total: 97,
              },
            },
          }
        : part,
    );
    fixture.model.doStream.mockResolvedValue(
      providerStreamResult(parts).result,
    );

    const events = await captureStream(fixture.transport);

    expect(events.at(-1)).toEqual({
      type: "completed",
      finishReason: "stop",
      usage: {
        inputTokens: 528,
        outputTokens: 97,
      },
    });
  });

  it("does not inspect a non-stream result that resolves after abort", async function () {
    const fixture = transportFixture();
    const provider = deferred();
    fixture.model.doGenerate.mockImplementation(() => provider.promise);
    const controller = new AbortController();
    const pending = captureError(
      fixture.transport.generateChat(
        {
          prompt: "Return exactly COMPAT_OK and nothing else.",
          maxOutputTokens: 32,
        },
        {
          signal: controller.signal,
        },
      ),
    );
    controller.abort(
      new DOMException("Synthetic direct cancellation.", "AbortError"),
    );
    const error = await pending;
    const content = vi.fn(() => []);
    const result = {};
    Object.defineProperty(result, "content", {
      get: content,
    });
    provider.resolve(result);
    await flushProviderPromiseObservation();

    expect(error).toMatchObject({
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    expect(content).not.toHaveBeenCalled();
  });

  it.each([
    ["specificationVersion", "doGenerate", "doStream"],
    ["doGenerate", "doStream"],
  ])(
    "observes every remaining model slot after the %s getter throws",
    async function (throwingProperty, ...remainingProperties) {
      const rejected = Promise.reject(
        new Error("AI_REVIEWER_LATER_MODEL_SLOT_PRIVATE"),
      );
      const reads = Object.fromEntries(
        ["specificationVersion", "doGenerate", "doStream"].map((property) => [
          property,
          vi.fn(),
        ]),
      );
      const model = {};
      for (const property of [
        "specificationVersion",
        "doGenerate",
        "doStream",
      ]) {
        Object.defineProperty(model, property, {
          get() {
            reads[property]();
            if (property === throwingProperty) {
              throw new Error("AI_REVIEWER_EARLY_MODEL_GETTER_PRIVATE");
            }
            return remainingProperties.includes(property)
              ? rejected
              : property === "specificationVersion"
                ? "v3"
                : vi.fn();
          },
        });
      }

      let error;
      try {
        new OllamaOpenAiTransport({
          baseUrl,
          modelTag,
          createProvider() {
            return {
              chatModel() {
                return model;
              },
            };
          },
          fetchImpl: vi.fn(),
        });
      } catch (cause) {
        error = cause;
      }

      expect(error).toMatchObject({
        code: "AI_PROVIDER_FAILED",
        category: "provider",
        retryable: true,
      });
      expect(reads.specificationVersion).toHaveBeenCalledOnce();
      expect(reads.doGenerate).toHaveBeenCalledOnce();
      expect(reads.doStream).toHaveBeenCalledOnce();
      await flushProviderPromiseObservation();
    },
  );

  it.each(["chat", "structured", "tool proposal", "tool continuation"])(
    "accepts %s usage above a provided output token value",
    async function (name) {
      const fixture = transportFixture();
      const invoke = await createDirectInvocation(fixture, name);
      const result =
        name === "structured"
          ? plainStructuredResult()
          : name === "tool proposal"
            ? plainToolProposalResult()
            : plainGenerateResult();
      result.usage.outputTokens.total = 33;
      fixture.model.doGenerate.mockResolvedValue(result);

      const completed = await invoke();

      expect(completed.usage).toMatchObject({
        outputTokens: 33,
      });
    },
  );

  it.each([
    {
      name: "chat",
      result: plainGenerateResult({
        content: [
          {
            type: "text",
            text: "x".repeat(60_000),
          },
          {
            type: "text",
            text: "x".repeat(40_001),
          },
        ],
      }),
    },
    {
      name: "structured",
      result: plainStructuredResult({
        content: [
          {
            type: "text",
            text: "x".repeat(100_001),
          },
        ],
      }),
    },
    {
      name: "tool proposal",
      result: plainToolProposalResult({
        content: [
          {
            type: "tool-call",
            toolCallId: "synthetic-call-001",
            toolName: "lookup_synthetic_record",
            input: "x".repeat(100_001),
          },
        ],
      }),
    },
    {
      name: "tool continuation",
      result: plainGenerateResult({
        content: [
          {
            type: "text",
            text: "x".repeat(100_001),
          },
        ],
      }),
    },
  ])(
    "rejects cumulative non-stream $name output above 100000 characters",
    async function ({ name, result }) {
      const fixture = transportFixture();
      const invoke = await createDirectInvocation(fixture, name);
      fixture.model.doGenerate.mockResolvedValue(result);

      const error = await captureError(invoke());

      expect(error).toMatchObject({
        code: "AI_PROVIDER_SCHEMA_INVALID",
        category: "schema",
        retryable: false,
      });
    },
  );

  it("attempts an aborting throwing releaseLock only once", async function () {
    const fixture = transportFixture();
    const controller = new AbortController();
    const reason = new DOMException(
      "AI_REVIEWER_RELEASE_ABORT_PRIVATE",
      "AbortError",
    );
    const releaseLock = vi.fn(() => {
      controller.abort(reason);
      throw new TypeError("Synthetic release failure.");
    });
    const reader = readerStreamFixture(
      () =>
        Promise.resolve({
          done: false,
          value: {
            type: "malformed",
          },
        }),
      {
        cancel: vi.fn(() => Promise.resolve()),
        releaseLock,
      },
    );
    fixture.model.doStream.mockResolvedValue(reader.result);

    const error = await captureError(
      captureStream(fixture.transport, streamRequest, {
        signal: controller.signal,
      }),
    );
    await flushProviderPromiseObservation();

    expect(error).toMatchObject({
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    expect(releaseLock).toHaveBeenCalledOnce();
  });

  it("deduplicates a permanent release failure across read and cancel settlement", async function () {
    const fixture = transportFixture();
    const controller = new AbortController();
    const reason = new DOMException(
      "AI_REVIEWER_PREABORTED_RELEASE_PRIVATE",
      "AbortError",
    );
    const releaseLock = vi.fn(() => {
      throw new TypeError("Synthetic release failure.");
    });
    const cancel = vi.fn(() => Promise.resolve());
    const reader = readerStreamFixture(
      () => {
        controller.abort(reason);
        return Promise.resolve({
          done: false,
          value: {
            type: "malformed",
          },
        });
      },
      {
        cancel,
        releaseLock,
      },
    );
    fixture.model.doStream.mockResolvedValue(reader.result);

    const error = await captureError(
      captureStream(fixture.transport, streamRequest, {
        signal: controller.signal,
      }),
    );
    await flushProviderPromiseObservation();

    expect(error).toMatchObject({
      code: "AI_REQUEST_ABORTED",
      category: "aborted",
      retryable: false,
    });
    expect(cancel).toHaveBeenCalledExactlyOnceWith(reason);
    expect(releaseLock).toHaveBeenCalledTimes(2);
  });
});
