import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { AgentGatewayError } from "../../../app/src/AgentGateway.mjs";
import { OllamaOpenAiTransport } from "../../../app/src/OllamaOpenAiTransport.mjs";

const appSourceDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../app/src",
);
const ollamaFixtureDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../fixtures/ollama",
);
const baseUrl = "http://127.0.0.1:11434/v1";
const modelTag = "overleaf-ai-reviewer-compat-8k:latest";
const prompt = "Return exactly COMPAT_OK and nothing else.";
const structuredPrompt =
  "Return the synthetic record as JSON with status ok, id SYNTH-001, and count 3. Do not add keys or prose.";
const forcedToolPrompt =
  "Call lookup_synthetic_record exactly once with id SYNTH-001. After the tool result, return exactly TOOL_OK and nothing else.";
const structuredSchema = JSON.parse(
  fs.readFileSync(
    path.join(ollamaFixtureDirectory, "structured-output.schema.json"),
    "utf8",
  ),
);
const forcedTool = JSON.parse(
  fs.readFileSync(
    path.join(ollamaFixtureDirectory, "tool-definition.json"),
    "utf8",
  ),
);
const fixedToolResult = {
  id: "SYNTH-001",
  value: "synthetic",
};
const latencyPrompt = [
  "Return exactly 80 copies of OK separated by one ASCII space and nothing else.",
  "BEGIN_SYNTHETIC_PAYLOAD",
  Array.from(
    {
      length: 512,
    },
    (_, index) => `w${String(index).padStart(4, "0")}`,
  ).join(" "),
  "END_SYNTHETIC_PAYLOAD",
].join("\n");

function listProductionSourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return listProductionSourceFiles(absolutePath);
    }
    return /\.(?:cjs|js|mjs|ts|tsx)$/u.test(entry.name) ? [absolutePath] : [];
  });
}

function hasAiPackageReference(source) {
  return (
    source.includes('"ai"') ||
    source.includes("'ai'") ||
    source.includes("`ai`")
  );
}

function successfulChatResponse() {
  return new Response(
    JSON.stringify({
      id: "synthetic-chat-completion",
      object: "chat.completion",
      created: 0,
      model: modelTag,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "COMPAT_OK",
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 3,
        total_tokens: 15,
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-ai-reviewer-secret": "AI_REVIEWER_RESPONSE_HEADER_SECRET",
      },
    },
  );
}

function successfulStructuredResponse() {
  return new Response(
    JSON.stringify({
      id: "synthetic-structured-completion",
      object: "chat.completion",
      created: 0,
      model: modelTag,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: JSON.stringify({
              status: "ok",
              id: "SYNTH-001",
              count: 3,
            }),
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 28,
        completion_tokens: 12,
        total_tokens: 40,
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-ai-reviewer-secret": "AI_REVIEWER_STRUCTURED_HEADER_SECRET",
      },
    },
  );
}

function successfulToolProposalResponse() {
  return new Response(
    JSON.stringify({
      id: "synthetic-tool-proposal",
      object: "chat.completion",
      created: 0,
      model: modelTag,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "synthetic-call-001",
                type: "function",
                function: {
                  name: "lookup_synthetic_record",
                  arguments: JSON.stringify({
                    id: "SYNTH-001",
                  }),
                },
              },
            ],
          },
          finish_reason: "tool_calls",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 36,
        completion_tokens: 10,
        total_tokens: 46,
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-ai-reviewer-secret": "AI_REVIEWER_TOOL_HEADER_SECRET",
      },
    },
  );
}

function successfulToolResultResponse() {
  return new Response(
    JSON.stringify({
      id: "synthetic-tool-result",
      object: "chat.completion",
      created: 0,
      model: modelTag,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: "TOOL_OK",
          },
          finish_reason: "stop",
          logprobs: null,
        },
      ],
      usage: {
        prompt_tokens: 48,
        completion_tokens: 3,
        total_tokens: 51,
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-ai-reviewer-secret": "AI_REVIEWER_TOOL_RESULT_HEADER_SECRET",
      },
    },
  );
}

function successfulStreamResponse() {
  const chunk = (choices, usage) => ({
    id: "synthetic-stream-completion",
    object: "chat.completion.chunk",
    created: 0,
    model: modelTag,
    choices,
    ...(usage == null
      ? {}
      : {
          usage,
        }),
  });
  const chunks = [
    chunk([
      {
        index: 0,
        delta: {
          role: "assistant",
        },
        finish_reason: null,
        logprobs: null,
      },
    ]),
    chunk([
      {
        index: 0,
        delta: {
          content: "",
        },
        finish_reason: null,
        logprobs: null,
      },
    ]),
    chunk([
      {
        index: 0,
        delta: {
          content: "OK ",
        },
        finish_reason: null,
        logprobs: null,
      },
    ]),
    chunk([
      {
        index: 0,
        delta: {
          content: "OK",
        },
        finish_reason: null,
        logprobs: null,
      },
    ]),
    chunk([
      {
        index: 0,
        delta: {},
        finish_reason: "stop",
        logprobs: null,
      },
    ]),
    chunk([], {
      prompt_tokens: 528,
      completion_tokens: 80,
      total_tokens: 608,
    }),
  ];
  const body = `${chunks
    .map((value) => `data: ${JSON.stringify(value)}\n\n`)
    .join("")}data: [DONE]\n\n`;
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "x-ai-reviewer-secret": "AI_REVIEWER_STREAM_HEADER_SECRET",
    },
  });
}

async function captureError(work) {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject.");
}

describe("AI reviewer: Ollama OpenAI protocol", function () {
  it("uses one real provider Chat Completions request with fixed settings", async function () {
    const requests = [];
    const fetchImpl = vi.fn(async (input, init) => {
      requests.push({
        url: typeof input === "string" ? input : input.url,
        body: JSON.parse(init.body),
        redirect: init.redirect,
      });
      return successfulChatResponse();
    });
    const transport = new OllamaOpenAiTransport({
      baseUrl,
      modelTag,
      fetchImpl,
    });

    const result = await transport.generateChat({
      prompt,
      maxOutputTokens: 32,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(requests).toEqual([
      {
        url: `${baseUrl}/chat/completions`,
        body: {
          model: modelTag,
          max_tokens: 32,
          temperature: 0,
          top_p: 1,
          seed: 424242,
          reasoning_effort: "none",
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
        },
        redirect: "error",
      },
    ]);
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
    expect(JSON.stringify(result)).not.toContain("AI_REVIEWER_");
  });

  it("omits sampling fields from the wire in reasoning model compatibility mode", async function () {
    let requestBody;
    const transport = new OllamaOpenAiTransport({
      baseUrl,
      modelTag,
      reasoningModelCompatibility: true,
      fetchImpl: vi.fn(async (_input, init) => {
        requestBody = JSON.parse(init.body);
        return successfulChatResponse();
      }),
    });

    await transport.generateChat({ prompt, maxOutputTokens: 32 });

    expect(requestBody).not.toHaveProperty("parallel_tool_calls");
    expect(requestBody).not.toHaveProperty("temperature");
    expect(requestBody).not.toHaveProperty("top_p");
    expect(requestBody).not.toHaveProperty("seed");
    expect(requestBody).toMatchObject({
      model: modelTag,
      max_tokens: 32,
      reasoning_effort: "none",
    });
  });

  it("attaches a remote credential only as the Authorization header and redacts transport failure text", async function () {
    const remoteBaseUrl = "https://api.example.com/openai/v1";
    const credential = "PRIVATE_REMOTE_PROVIDER_CREDENTIAL";
    const authorizations = [];
    const fetchImpl = vi.fn(async (_input, init) => {
      authorizations.push(new Headers(init.headers).get("authorization"));
      return successfulChatResponse();
    });
    const transport = new OllamaOpenAiTransport({
      baseUrl: remoteBaseUrl,
      credential,
      modelTag,
      fetchImpl,
    });

    const result = await transport.generateChat({
      prompt,
      maxOutputTokens: 32,
    });

    expect(authorizations).toEqual([`Bearer ${credential}`]);
    expect(JSON.stringify(result)).not.toContain(credential);

    const failedTransport = new OllamaOpenAiTransport({
      baseUrl: remoteBaseUrl,
      credential,
      modelTag,
      fetchImpl: vi.fn(async () => {
        throw new Error(credential);
      }),
    });
    const error = await captureError(
      failedTransport.generateChat({
        prompt,
        maxOutputTokens: 32,
      }),
    );
    expect(error).toMatchObject({
      code: "AI_PROVIDER_NETWORK_FAILED",
      category: "network",
      retryable: true,
    });
    expect(String(error)).not.toContain(credential);
  });

  it("uses one real provider stream with the fixed wire body and local DTOs", async function () {
    const requests = [];
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (input, init) => {
      requests.push({
        url: typeof input === "string" ? input : input.url,
        body: init.body,
        redirect: init.redirect,
        signal: init.signal,
      });
      return successfulStreamResponse();
    });
    const transport = new OllamaOpenAiTransport({
      baseUrl,
      modelTag,
      fetchImpl,
    });
    const events = [];

    for await (const event of transport.streamChat(
      {
        prompt: latencyPrompt,
        maxOutputTokens: 96,
      },
      {
        signal: controller.signal,
      },
    )) {
      events.push(event);
    }

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: `${baseUrl}/chat/completions`,
      redirect: "error",
      signal: controller.signal,
    });
    expect(Buffer.byteLength(requests[0].body, "utf8")).toBe(3_425);
    expect(
      crypto.createHash("sha256").update(requests[0].body).digest("hex"),
    ).toBe("7a369ce2684502b69926560ac7ff4c1b1da89bc2fa0da01d4d572c3c291e4087");
    expect(JSON.parse(requests[0].body)).toEqual({
      model: modelTag,
      max_tokens: 96,
      temperature: 0,
      top_p: 1,
      seed: 424242,
      reasoning_effort: "none",
      messages: [
        {
          role: "user",
          content: latencyPrompt,
        },
      ],
      stream: true,
      stream_options: {
        include_usage: true,
      },
    });
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
  });

  it("uses one real provider strict-schema request and validates its JSON result", async function () {
    const requests = [];
    const fetchImpl = vi.fn(async (input, init) => {
      requests.push({
        url: typeof input === "string" ? input : input.url,
        body: JSON.parse(init.body),
        redirect: init.redirect,
      });
      return successfulStructuredResponse();
    });
    const transport = new OllamaOpenAiTransport({
      baseUrl,
      modelTag,
      fetchImpl,
    });

    const result = await transport.generateStructuredChat({
      prompt: structuredPrompt,
      maxOutputTokens: 48,
      schema: structuredSchema,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(requests).toEqual([
      {
        url: `${baseUrl}/chat/completions`,
        body: {
          model: modelTag,
          max_tokens: 48,
          temperature: 0,
          top_p: 1,
          seed: 424242,
          reasoning_effort: "none",
          response_format: {
            type: "json_schema",
            json_schema: {
              schema: structuredSchema,
              strict: true,
              name: "response",
            },
          },
          messages: [
            {
              role: "user",
              content: structuredPrompt,
            },
          ],
        },
        redirect: "error",
      },
    ]);
    expect(result).toEqual({
      type: "structured.completed",
      value: {
        status: "ok",
        id: "SYNTH-001",
        count: 3,
      },
      finishReason: "stop",
      usage: {
        inputTokens: 28,
        outputTokens: 12,
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.usage)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("AI_REVIEWER_");
  });

  it("keeps both real provider tool-call halves explicit and separately measurable", async function () {
    const requests = [];
    const responses = [
      successfulToolProposalResponse(),
      successfulToolResultResponse(),
    ];
    const fetchImpl = vi.fn(async (input, init) => {
      requests.push({
        url: typeof input === "string" ? input : input.url,
        body: JSON.parse(init.body),
        redirect: init.redirect,
      });
      return responses.shift();
    });
    const transport = new OllamaOpenAiTransport({
      baseUrl,
      modelTag,
      fetchImpl,
    });

    const proposal = await transport.proposeForcedToolCall({
      prompt: forcedToolPrompt,
      maxOutputTokens: 64,
      tool: forcedTool,
    });

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(requests[0]).toEqual({
      url: `${baseUrl}/chat/completions`,
      body: {
        model: modelTag,
        parallel_tool_calls: false,
        max_tokens: 64,
        temperature: 0,
        top_p: 1,
        seed: 424242,
        reasoning_effort: "none",
        messages: [
          {
            role: "user",
            content: forcedToolPrompt,
          },
        ],
        tools: [forcedTool],
        tool_choice: {
          type: "function",
          function: {
            name: "lookup_synthetic_record",
          },
        },
      },
      redirect: "error",
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
        inputTokens: 36,
        outputTokens: 10,
      },
    });
    expect(Object.isFrozen(proposal)).toBe(true);
    expect(Object.isFrozen(proposal.call)).toBe(true);
    expect(Object.isFrozen(proposal.call.input)).toBe(true);
    expect(Object.isFrozen(proposal.usage)).toBe(true);

    const result = await transport.continueToolCall({
      proposal,
      toolResult: fixedToolResult,
      maxOutputTokens: 32,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(requests[1]).toEqual({
      url: `${baseUrl}/chat/completions`,
      body: {
        model: modelTag,
        max_tokens: 32,
        temperature: 0,
        top_p: 1,
        seed: 424242,
        reasoning_effort: "none",
        messages: [
          {
            role: "user",
            content: forcedToolPrompt,
          },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "synthetic-call-001",
                type: "function",
                function: {
                  name: "lookup_synthetic_record",
                  arguments: JSON.stringify({
                    id: "SYNTH-001",
                  }),
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "synthetic-call-001",
            content: JSON.stringify(fixedToolResult),
          },
        ],
      },
      redirect: "error",
    });
    expect(result).toEqual({
      type: "completed",
      text: "TOOL_OK",
      toolCalls: [],
      finishReason: "stop",
      usage: {
        inputTokens: 48,
        outputTokens: 3,
      },
    });
    expect(JSON.stringify({ proposal, result })).not.toContain("AI_REVIEWER_");
  });

  it("classifies a real provider missing-model response without retry", async function () {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: {
            message: "AI_REVIEWER_MISSING_MODEL_SECRET",
            type: "not_found_error",
          },
        }),
        {
          status: 404,
          headers: {
            "content-type": "application/json",
          },
        },
      );
    });
    const transport = new OllamaOpenAiTransport({
      baseUrl,
      modelTag: "overleaf-ai-missing-model-do-not-pull:latest",
      fetchImpl,
    });

    const error = await captureError(
      transport.generateChat({
        prompt,
        maxOutputTokens: 32,
      }),
    );

    expect(error).toBeInstanceOf(AgentGatewayError);
    expect(error).toMatchObject({
      code: "AI_PROVIDER_REQUEST_FAILED",
      category: "provider",
      retryable: false,
    });
    expect(error.message).not.toContain("AI_REVIEWER_MISSING_MODEL_SECRET");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("classifies a guarded fetch failure as retryable network failure", async function () {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("AI_REVIEWER_NETWORK_SECRET");
    });
    const transport = new OllamaOpenAiTransport({
      baseUrl,
      modelTag,
      fetchImpl,
    });

    const error = await captureError(
      transport.generateChat({
        prompt,
        maxOutputTokens: 32,
      }),
    );

    expect(error).toBeInstanceOf(AgentGatewayError);
    expect(error).toMatchObject({
      code: "AI_PROVIDER_NETWORK_FAILED",
      category: "network",
      retryable: true,
    });
    expect(error.message).not.toContain("AI_REVIEWER_NETWORK_SECRET");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("keeps high-level and provider SDK imports in their existing adapters", function () {
    const imports = listProductionSourceFiles(appSourceDirectory)
      .map((absolutePath) => {
        const source = fs.readFileSync(absolutePath, "utf8");
        return {
          path: path
            .relative(appSourceDirectory, absolutePath)
            .split(path.sep)
            .join("/"),
          importsAi: hasAiPackageReference(source),
          importsOpenAiCompatible: source.includes("@ai-sdk/openai-compatible"),
        };
      })
      .filter(
        ({ importsAi, importsOpenAiCompatible }) =>
          importsAi || importsOpenAiCompatible,
      )
      .sort(({ path: left }, { path: right }) =>
        left < right ? -1 : left > right ? 1 : 0,
      );

    expect(imports).toEqual([
      {
        path: "AiSdkAgentGateway.mjs",
        importsAi: true,
        importsOpenAiCompatible: false,
      },
      {
        path: "OllamaOpenAiTransport.mjs",
        importsAi: false,
        importsOpenAiCompatible: true,
      },
    ]);
  });

  it.each([
    'import("ai")',
    'require("ai")',
    'import "ai"',
    "import('ai')",
    "require('ai')",
    "import 'ai'",
    "import(`ai`)",
  ])("detects raw AI SDK package reference %s", function (source) {
    expect(hasAiPackageReference(source)).toBe(true);
  });
});
