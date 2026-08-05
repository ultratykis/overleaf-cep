import { APICallError, simulateReadableStream } from "ai";
import { Agent } from "undici";
import { describe, expect, it, vi } from "vitest";

import { AgentGatewayError } from "../../../app/src/AgentGateway.mjs";
import {
  AzureAiSdkTransport,
  ClaudeAiSdkTransport,
  GeminiAiSdkTransport,
} from "../../../app/src/OllamaOpenAiTransport.mjs";

const credential = "PRIVATE_NATIVE_PROVIDER_CREDENTIAL";
const createdAt = "2026-07-26T00:00:00.000Z";
const azureBaseUrl = "https://reviewer.openai.azure.com/openai";
const plaintextAzureBaseUrl = "http://host.docker.internal:11434/openai";
const azureApiVersion = "2025-01-01-preview";
const azureDefaultApiVersion = "v1";
const azureDeployment = "gpt-5.6-terra";

const providers = [
  {
    name: "gemini",
    model: "gemini-2.5-pro",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    requestPath: "/models/gemini-2.5-pro:generateContent",
    Transport: GeminiAiSdkTransport,
    successResponse: {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "COMPAT_OK" }] },
          finishReason: "STOP",
        },
      ],
      usageMetadata: {
        promptTokenCount: 12,
        candidatesTokenCount: 3,
        totalTokenCount: 15,
      },
    },
  },
  {
    name: "claude",
    model: "claude-sonnet-4-20250514",
    baseUrl: "https://api.anthropic.com/v1",
    requestPath: "/messages",
    Transport: ClaudeAiSdkTransport,
    successResponse: {
      id: "msg_synthetic_0001",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-20250514",
      content: [{ type: "text", text: "COMPAT_OK" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 12, output_tokens: 3 },
    },
  },
];

function usage(inputTokens = 12, outputTokens = 3) {
  return {
    inputTokens: {
      total: inputTokens,
      noCache: inputTokens,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: outputTokens,
      text: outputTokens,
      reasoning: undefined,
    },
  };
}

function generateResult(overrides = {}) {
  return {
    content: [{ type: "text", text: "COMPAT_OK" }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: usage(),
    warnings: [],
    ...overrides,
  };
}

function geminiStreamResponse({ parts, finishReason = "STOP" }) {
  const chunk = {
    candidates: [
      {
        content: { role: "model", parts },
        finishReason,
      },
    ],
    usageMetadata: {
      promptTokenCount: 12,
      candidatesTokenCount: 3,
      totalTokenCount: 15,
    },
  };
  return new Response(`data: ${JSON.stringify(chunk)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function nativeTransportFixture({ Transport, model: modelId, fetchImpl } = {}) {
  const model = {
    specificationVersion: "v3",
    provider: "untrusted-provider-name",
    modelId,
    supportedUrls: {},
    doGenerate: vi.fn(),
    doStream: vi.fn(),
  };
  const provider = vi.fn(() => model);
  const createProvider = vi.fn(() => provider);
  const transport = new Transport({
    credential,
    modelTag: modelId,
    createProvider,
    ...(fetchImpl === undefined ? {} : { fetchImpl }),
  });
  return { createProvider, model, provider, transport };
}

async function captureError(work) {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject.");
}

async function collect(stream) {
  const values = [];
  for await (const value of stream) {
    values.push(value);
  }
  return values;
}

function conversationRequest() {
  return {
    requestId: "native-conversation-request-0001",
    projectId: "native-project-0001",
    action: "review",
    instruction: "Explain this synthetic case.",
    skill: null,
    scope: { kind: "project" },
  };
}

function documentReviewRequest() {
  return {
    requestId: "native-document-request-0001",
    projectId: "native-project-0001",
    action: "review",
    instruction: "Review this synthetic document.",
    skill: "referee-review",
    scope: {
      kind: "document",
      documentId: "native-document-0001",
      path: "main.tex",
      baseRevision: 1,
      baseTextHash: "a".repeat(64),
      text: "Synthetic.",
    },
  };
}

function expectAllObjectPropertiesRequired(schema) {
  if (schema == null || typeof schema !== "object") {
    return;
  }
  if (
    schema.properties != null &&
    typeof schema.properties === "object" &&
    !Array.isArray(schema.properties)
  ) {
    expect([...(schema.required ?? [])].sort()).toEqual(
      Object.keys(schema.properties).sort(),
    );
  }
  for (const nested of Array.isArray(schema) ? schema : Object.values(schema)) {
    expectAllObjectPropertiesRequired(nested);
  }
}

function expectProviderSchemaAllowsNull(schema) {
  const variants = [schema, ...(schema.anyOf ?? []), ...(schema.oneOf ?? [])];
  expect(
    variants.some(
      (variant) =>
        variant?.type === "null" ||
        (Array.isArray(variant?.type) && variant.type.includes("null")) ||
        variant?.const === null ||
        (Array.isArray(variant?.enum) && variant.enum.includes(null)),
    ),
  ).toBe(true);
}

function agentGateway(transport, options = {}) {
  return transport.createAgentGateway({
    contextLength: 8_192,
    readProjectFile: async () => ({ path: "main.tex", text: "Synthetic." }),
    ...options,
  });
}

describe("AI reviewer: native AI SDK provider transports", function () {
  it("blocks an Azure HTTP credential before constructing the review provider", function () {
    const createProvider = vi.fn();
    const fetchImpl = vi.fn();

    expect(
      () =>
        new AzureAiSdkTransport({
          baseUrl: plaintextAzureBaseUrl,
          requestStyle: "deployment",
          apiVersion: azureApiVersion,
          credential,
          modelTag: azureDeployment,
          createProvider,
          fetchImpl,
        }),
    ).toThrow("The API key was not sent because the endpoint uses HTTP");
    expect(createProvider).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("constructs Azure through its chat adapter and accepts its V4 model", async function () {
    const model = {
      specificationVersion: "v4",
      provider: "azure.chat",
      modelId: azureDeployment,
      supportedUrls: {},
      doGenerate: vi.fn(async () => generateResult()),
      doStream: vi.fn(),
    };
    const chat = vi.fn(() => model);
    const createProvider = vi.fn(() => ({ chat }));
    const transport = new AzureAiSdkTransport({
      baseUrl: azureBaseUrl,
      requestStyle: "deployment",
      apiVersion: azureApiVersion,
      credential,
      modelTag: azureDeployment,
      createProvider,
    });

    expect(createProvider).toHaveBeenCalledExactlyOnceWith({
      apiKey: credential,
      apiVersion: azureApiVersion,
      baseURL: azureBaseUrl,
      fetch: expect.any(Function),
      useDeploymentBasedUrls: true,
    });
    expect(chat).toHaveBeenCalledExactlyOnceWith(azureDeployment);
    expect(
      await transport.generateChat({ prompt: "Return COMPAT_OK." }),
    ).toMatchObject({ type: "completed", text: "COMPAT_OK" });
  });

  it("sends the real Azure SDK request to the deployment-based portal URL", async function () {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "SyntheticRequestCapture",
              message: "Synthetic rejection after request capture.",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );
    const transport = new AzureAiSdkTransport({
      baseUrl: azureBaseUrl,
      requestStyle: "deployment",
      apiVersion: azureApiVersion,
      credential,
      modelTag: azureDeployment,
      fetchImpl,
    });

    await captureError(
      transport.generateChat({ prompt: "Capture the Azure request." }),
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [request, init] = fetchImpl.mock.calls[0];
    expect(String(request)).toBe(
      `${azureBaseUrl}/deployments/${azureDeployment}/chat/completions?api-version=${azureApiVersion}`,
    );
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(new Headers(init.headers).get("api-key")).toBe(credential);
  });

  it("sends the real Azure SDK request to the v1 route", async function () {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "SyntheticRequestCapture",
              message: "Synthetic rejection after request capture.",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );
    const transport = new AzureAiSdkTransport({
      baseUrl: azureBaseUrl,
      requestStyle: "v1",
      credential,
      modelTag: azureDeployment,
      fetchImpl,
    });

    await captureError(
      transport.generateChat({ prompt: "Capture the Azure v1 request." }),
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [request, init] = fetchImpl.mock.calls[0];
    expect(String(request)).toBe(
      `${azureBaseUrl}/v1/chat/completions?api-version=${azureDefaultApiVersion}`,
    );
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(JSON.parse(String(init.body)).model).toBe(azureDeployment);
    expect(new Headers(init.headers).get("api-key")).toBe(credential);
  });

  it("keeps a blank deployment API version in storage and uses the SDK default on the request", async function () {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "SyntheticRequestCapture",
              message: "Synthetic rejection after request capture.",
            },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        ),
    );
    const transport = new AzureAiSdkTransport({
      baseUrl: azureBaseUrl,
      requestStyle: "deployment",
      credential,
      modelTag: azureDeployment,
      fetchImpl,
    });

    await captureError(
      transport.generateChat({
        prompt: "Capture the defaulted Azure request.",
      }),
    );

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      `${azureBaseUrl}/deployments/${azureDeployment}/chat/completions?api-version=${azureDefaultApiVersion}`,
    );
  });

  it("sends all six real Azure tool schemas with every object property required", async function () {
    let requestBody;
    const fetchImpl = vi.fn(async (_input, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          error: {
            code: "SyntheticRequestCapture",
            message: "Synthetic rejection after request capture.",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    });
    const transport = new AzureAiSdkTransport({
      baseUrl: azureBaseUrl,
      requestStyle: "deployment",
      apiVersion: azureApiVersion,
      credential,
      modelTag: azureDeployment,
      fetchImpl,
    });
    const gateway = agentGateway(transport, {
      skills: [
        {
          id: "native-skill-0001",
          name: "Evidence audit",
          description: "Check whether each claim is supported.",
          body: "Compare claims with their evidence.",
          referenceFiles: {
            "references/checklist.md": "Check the conclusion.",
          },
        },
      ],
      searchZotero: async () => ({ items: [] }),
      validateEvidence: async () => {},
    });

    await captureError(collect(gateway.stream(documentReviewRequest())));

    const tools = requestBody.tools;
    expect(tools.map((toolDefinition) => toolDefinition.function.name)).toEqual(
      [
        "read_project_file",
        "read_skill",
        "search_zotero",
        "report_subject",
        "report_finding",
        "propose_suggestion",
      ],
    );
    for (const toolDefinition of tools) {
      expect(toolDefinition.function.strict).toBe(true);
      expectAllObjectPropertiesRequired(toolDefinition.function.parameters);
    }

    const parameters = Object.fromEntries(
      tools.map((toolDefinition) => [
        toolDefinition.function.name,
        toolDefinition.function.parameters,
      ]),
    );
    const findingEvidence = parameters.report_finding.properties.evidence.items;
    const suggestionEvidence =
      parameters.propose_suggestion.properties.evidence.items;
    for (const optionalSchema of [
      parameters.read_project_file.properties.range,
      parameters.read_skill.properties.referencePath,
      parameters.report_finding.properties.proposedText,
      findingEvidence.properties.range,
      findingEvidence.properties.excerpt,
      findingEvidence.properties.revision,
      findingEvidence.properties.textHash,
      suggestionEvidence.properties.range,
      suggestionEvidence.properties.revision,
      suggestionEvidence.properties.textHash,
    ]) {
      expectProviderSchemaAllowsNull(optionalSchema);
    }
  });

  it("lets the Google SDK produce the Gemini finding declaration without strict mode", async function () {
    let requestBody;
    const fetchImpl = vi.fn(async (_input, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          error: {
            code: 400,
            message: "Synthetic rejection after request capture.",
            status: "INVALID_ARGUMENT",
          },
        }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    });
    const transport = new GeminiAiSdkTransport({
      credential,
      modelTag: "gemini-3.5-flash",
      fetchImpl,
    });
    const gateway = agentGateway(transport);

    await captureError(collect(gateway.stream(conversationRequest())));

    const declarations = requestBody.tools[0].functionDeclarations;
    for (const declaration of declarations) {
      expect(declaration.parameters).toMatchObject({ type: "object" });
    }
    const findingParameters = declarations.find(
      (declaration) => declaration.name === "report_finding",
    ).parameters;
    expect(findingParameters).toMatchObject({
      type: "object",
      properties: {
        artifactKind: {
          type: "string",
          enum: ["finding", "citation-finding"],
        },
        category: { type: "string", minLength: 1 },
        title: { type: "string", minLength: 1 },
        message: { type: "string", minLength: 1 },
        evidence: {
          type: "array",
          items: {
            type: "object",
            properties: {
              path: { type: "string", minLength: 1 },
              excerpt: { type: "string", minLength: 1 },
            },
          },
        },
        proposedText: { type: "string", minLength: 1 },
      },
    });
    expect(findingParameters).not.toHaveProperty("anyOf");
    expect(findingParameters.required).not.toContain("proposedText");
    expect(JSON.stringify(declarations)).not.toMatch(
      /"(?:additionalProperties|maxItems|maxLength|maximum|minItems|minimum|pattern)":/u,
    );
    expect(requestBody.toolConfig).toEqual({
      functionCallingConfig: { mode: "AUTO" },
    });
    expect(requestBody.systemInstruction).toMatchObject({
      parts: [expect.objectContaining({ text: expect.any(String) })],
    });
    expect(requestBody.contents[0]).toMatchObject({ role: "user" });
  });

  it("returns provider metadata to Gemini for the next tool step", async function () {
    const thoughtSignature = "PRIVATE_GEMINI_THOUGHT_SIGNATURE";
    const requestBodies = [];
    const fetchImpl = vi.fn(async (_input, init) => {
      requestBodies.push(JSON.parse(init.body));
      return requestBodies.length === 1
        ? geminiStreamResponse({
            parts: [
              {
                functionCall: {
                  name: "read_project_file",
                  args: { path: "main.tex" },
                },
                thoughtSignature,
              },
            ],
          })
        : geminiStreamResponse({ parts: [{ text: "Reviewed." }] });
    });
    const transport = new GeminiAiSdkTransport({
      credential,
      modelTag: "gemini-3.5-flash",
      fetchImpl,
    });
    const gateway = agentGateway(transport);

    const events = await collect(gateway.stream(conversationRequest()));

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(requestBodies[1].contents).toEqual([
      {
        role: "user",
        parts: [
          {
            text: [
              "## Task",
              "",
              "Action: review",
              "",
              "## Scope",
              "",
              "Scope: project",
            ].join("\n"),
          },
        ],
      },
      {
        role: "user",
        parts: [{ text: "Explain this synthetic case." }],
      },
      {
        role: "model",
        parts: [
          {
            functionCall: {
              name: "read_project_file",
              args: { path: "main.tex" },
            },
            thoughtSignature,
          },
        ],
      },
      {
        role: "user",
        parts: [
          {
            functionResponse: {
              name: "read_project_file",
              response: {
                name: "read_project_file",
                content: { path: "main.tex", text: "Synthetic." },
              },
            },
          },
        ],
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(thoughtSignature);
  });

  it.each(providers)(
    "constructs the real $name package without making a request",
    function ({ name, model: modelId, Transport }) {
      const fetchImpl = vi.fn();
      const transport = new Transport({
        credential,
        modelTag: modelId,
        fetchImpl,
      });
      const gateway = agentGateway(transport);

      expect(gateway).toMatchObject({
        provider: name,
        modelId,
        providerOptions: {},
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each(providers)(
    "keeps successful $name generation on the DNS-pinned fetch path",
    async function ({
      model: modelId,
      baseUrl,
      requestPath,
      successResponse,
      Transport,
    }) {
      const fetchImpl = vi.fn(
        async () =>
          new Response(JSON.stringify(successResponse), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      );
      const transport = new Transport({
        credential,
        modelTag: modelId,
        fetchImpl,
      });

      expect(
        await transport.generateChat({ prompt: "Return COMPAT_OK." }),
      ).toMatchObject({ type: "completed", text: "COMPAT_OK" });
      expect(fetchImpl).toHaveBeenCalledOnce();
      const [request, init] = fetchImpl.mock.calls[0];
      expect(String(request)).toBe(`${baseUrl}${requestPath}`);
      expect(init).toMatchObject({
        method: "POST",
        redirect: "error",
        dispatcher: expect.any(Agent),
      });
    },
  );

  it.each(providers)(
    "constructs $name from its provider package with only the fixed official base URL",
    async function ({ name, model: modelId, baseUrl, Transport }) {
      const fixture = nativeTransportFixture({ Transport, model: modelId });
      fixture.model.doGenerate.mockResolvedValue(generateResult());

      expect(fixture.createProvider).toHaveBeenCalledOnce();
      const providerOptions = fixture.createProvider.mock.calls[0][0];
      expect(providerOptions).toEqual({
        apiKey: credential,
        baseURL: baseUrl,
        fetch: expect.any(Function),
        name,
      });
      expect(fixture.provider).toHaveBeenCalledExactlyOnceWith(modelId);

      expect(
        await fixture.transport.generateChat({
          prompt: "Return exactly COMPAT_OK and nothing else.",
        }),
      ).toEqual({
        type: "completed",
        text: "COMPAT_OK",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 12, outputTokens: 3 },
      });
      expect(fixture.model.doGenerate.mock.calls[0][0]).toMatchObject({
        providerOptions: {},
      });
      expect(fixture.model.doGenerate.mock.calls[0][0]).not.toHaveProperty(
        "maxOutputTokens",
      );
    },
  );

  it.each(providers)(
    "accepts bounded provider warnings from $name non-stream responses",
    async function ({ model: modelId, Transport }) {
      const secret = "PRIVATE_NATIVE_PROVIDER_WARNING";
      const fixture = nativeTransportFixture({ Transport, model: modelId });
      fixture.model.doGenerate.mockResolvedValue(
        generateResult({
          warnings: [{ type: "other", message: secret }],
        }),
      );

      const result = await fixture.transport.generateChat({
        prompt: "Return exactly COMPAT_OK and nothing else.",
      });
      expect(result).toEqual({
        type: "completed",
        text: "COMPAT_OK",
        toolCalls: [],
        finishReason: "stop",
        usage: { inputTokens: 12, outputTokens: 3 },
      });
      expect(String(result)).not.toContain(secret);
    },
  );

  it.each(providers)(
    "passes $name streams through the shared bounded gateway normalizer",
    async function ({ name, model: modelId, Transport }) {
      const secret = "PRIVATE_NATIVE_STREAM_WARNING";
      const fixture = nativeTransportFixture({ Transport, model: modelId });
      fixture.model.doStream.mockResolvedValue({
        stream: simulateReadableStream({
          chunks: [
            {
              type: "stream-start",
              warnings: [{ type: "other", message: secret }],
            },
            { type: "text-start", id: "native-text-0001" },
            {
              type: "text-delta",
              id: "native-text-0001",
              delta: "Bounded native response.",
            },
            { type: "text-end", id: "native-text-0001" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: "stop" },
              usage: usage(),
            },
          ],
          initialDelayInMs: null,
          chunkDelayInMs: null,
        }),
      });
      let id = 0;
      const gateway = agentGateway(fixture.transport, {
        now: () => createdAt,
        createId: (kind) => `${kind}-${(id += 1)}`,
      });

      const events = await collect(gateway.stream(conversationRequest()));
      expect(events).toEqual([
        expect.objectContaining({
          type: "started",
          provider: name,
          model: modelId,
        }),
        expect.objectContaining({
          type: "text.delta",
          delta: "Bounded native response.",
        }),
        expect.objectContaining({
          type: "completed",
          finishReason: "stop",
        }),
      ]);
      expect(JSON.stringify(events)).not.toContain(secret);
      expect(fixture.model.doStream.mock.calls[0][0]).toMatchObject({
        providerOptions: {},
      });
      expect(
        fixture.model.doStream.mock.calls[0][0].maxOutputTokens,
      ).toBeUndefined();
    },
  );

  it.each(providers)(
    "classifies a marked 429 from $name as a provider rate limit",
    async function ({ model: modelId, Transport }) {
      const sentinel = "PRIVATE_NATIVE_RATE_LIMIT_BODY";
      const fixture = nativeTransportFixture({ Transport, model: modelId });
      fixture.model.doStream.mockRejectedValue(
        new APICallError({
          message: sentinel,
          url: "https://provider.invalid/v1/review",
          requestBodyValues: { prompt: sentinel },
          statusCode: 429,
          responseBody: sentinel,
          isRetryable: true,
        }),
      );
      const gateway = agentGateway(fixture.transport);

      const error = await captureError(
        collect(gateway.stream(conversationRequest())),
      );

      expect(error).toMatchObject({
        code: "AI_PROVIDER_RATE_LIMITED",
        category: "rate-limit",
        retryable: true,
        providerStatusCode: 429,
        providerErrorType: "AI_APICallError",
      });
      expect(String(error)).not.toContain(sentinel);
      expect(JSON.stringify(error)).not.toContain(sentinel);
    },
  );

  it.each(providers)(
    "refuses $name redirects in the provider fetch seam",
    async function ({ model: modelId, baseUrl, Transport }) {
      const fetchImpl = vi.fn(async () =>
        Response.redirect("https://redirect.example.test/", 302),
      );
      const fixture = nativeTransportFixture({
        Transport,
        model: modelId,
        fetchImpl,
      });
      const providerFetch = fixture.createProvider.mock.calls[0][0].fetch;

      const error = await captureError(
        providerFetch(`${baseUrl}/models/test:generateContent`, {
          method: "POST",
        }),
      );
      expect(error).toBeInstanceOf(AgentGatewayError);
      expect(error).toMatchObject({
        code: "AI_PROVIDER_REDIRECT_REJECTED",
        category: "provider",
        retryable: false,
      });
      expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
        `${baseUrl}/models/test:generateContent`,
        expect.objectContaining({ redirect: "error" }),
      );
    },
  );

  it.each(providers)(
    "refuses a nonofficial $name request URL before sending credentials",
    async function ({ model: modelId, Transport }) {
      const fetchImpl = vi.fn();
      const fixture = nativeTransportFixture({
        Transport,
        model: modelId,
        fetchImpl,
      });
      const providerFetch = fixture.createProvider.mock.calls[0][0].fetch;

      const error = await captureError(
        providerFetch("https://untrusted-provider.example.test/v1/messages", {
          method: "POST",
        }),
      );
      expect(error).toBeInstanceOf(AgentGatewayError);
      expect(error).toMatchObject({
        code: "AI_PROVIDER_CONFIGURATION_INVALID",
        category: "configuration",
        retryable: false,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
});
