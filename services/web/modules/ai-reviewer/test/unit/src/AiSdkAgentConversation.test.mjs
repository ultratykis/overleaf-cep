import { simulateReadableStream } from "ai";
// The SDK publishes this test entrypoint, but the repository resolver does not
// currently resolve package export subpaths.
// eslint-disable-next-line import/no-unresolved
import { MockLanguageModelV3 } from "ai/test";
import logger from "@overleaf/logger";
import Settings from "@overleaf/settings";
import { describe, expect, it, vi } from "vitest";

import { AiSdkAgentGateway } from "../../../app/src/AiSdkAgentGateway.mjs";
import { AI_REVIEWER_COMPLETION_LOG_MESSAGE } from "../../../app/src/AiReviewerFailureLogger.mjs";
import { estimateAgentPromptTokens } from "../../../app/src/AiReviewerPrompt.mjs";
import {
  estimateModelInputTokens,
  modelInputTokenBudget,
} from "../../../app/src/ModelContextBudget.mjs";
import {
  AI_REVIEWER_MODE_INSTRUCTION_MAX_LENGTH,
  DISCUSSION_CONTEXT_TURN_LIMIT,
  UnresolvedSuggestionSchema,
} from "../../../shared/contracts.mjs";

const createdAt = "2026-07-30T00:00:00.000Z";
const contentHash = "a".repeat(64);
const documentText = "The method is unclear. The result is unclear.";
const firstSentence = documentText.slice(0, 22);

function documentRequest(overrides = {}) {
  return {
    requestId: "conversation-0001",
    projectId: "project-conversation-0001",
    action: "review",
    instruction: "Why is the first sentence unclear?",
    skill: "line-edit",
    scope: {
      kind: "document",
      documentId: "document-conversation-0001",
      path: "main.tex",
      baseRevision: 7,
      baseTextHash: contentHash,
      text: documentText,
    },
    turns: [
      { role: "user", text: "What did you find in this file?" },
      { role: "assistant", text: "One unclear sentence." },
    ],
    ...overrides,
  };
}

function selectionTransformRequest(action) {
  return documentRequest({
    action,
    instruction:
      action === "shorten"
        ? "Shorten the selected phrase."
        : "Rewrite the selected phrase.",
    scope: {
      kind: "selection",
      documentId: "document-conversation-0001",
      path: "main.tex",
      baseRevision: 7,
      baseTextHash: contentHash,
      range: { from: 23, to: 45 },
      text: documentText.slice(23, 45),
    },
    turns: undefined,
  });
}

function projectRequest(overrides = {}) {
  return {
    requestId: "conversation-project-0001",
    projectId: "project-conversation-0001",
    action: "review",
    instruction: "Review the whole project.",
    skill: "referee-review",
    scope: { kind: "project" },
    ...overrides,
  };
}

function openRequest(overrides = {}) {
  return {
    requestId: "conversation-open-0001",
    projectId: "project-conversation-0001",
    action: "review",
    instruction: "Which chapter still needs work?",
    skill: null,
    turns: [{ role: "user", text: "An earlier question." }],
    ...overrides,
  };
}

function findingDraft(overrides = {}) {
  return {
    artifactKind: "finding",
    severity: "warning",
    category: "clarity",
    title: "Unclear antecedent",
    message: "The pronoun does not identify which method produced the result.",
    evidence: [
      {
        path: "main.tex",
        range: { from: 0, to: 22 },
        revision: 7,
        textHash: contentHash,
      },
    ],
    ...overrides,
  };
}

function suggestionDraft(overrides = {}) {
  return {
    documentId: "document-conversation-0001",
    path: "main.tex",
    baseRevision: 7,
    baseTextHash: contentHash,
    range: { from: 0, to: 22 },
    original: firstSentence,
    replacement: "The bisection method is described in Section 2.",
    rationale: "Naming the method removes the ambiguity.",
    evidence: [
      {
        path: "main.tex",
        range: { from: 0, to: 22 },
        revision: 7,
        textHash: contentHash,
      },
    ],
    ...overrides,
  };
}

function usage(inputTokens = 3, outputTokens = 2) {
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

function finish(finishReason, tokenUsage = usage()) {
  return {
    type: "finish",
    finishReason: { unified: finishReason, raw: finishReason },
    usage: tokenUsage,
  };
}

function streamResult(chunks) {
  return {
    stream: simulateReadableStream({
      chunks,
      initialDelayInMs: null,
      chunkDelayInMs: null,
    }),
  };
}

function textChunks(text, id = "conversation-text-0001") {
  return [
    { type: "text-start", id },
    { type: "text-delta", id, delta: text },
    { type: "text-end", id },
  ];
}

function toolChunk(toolName, input, toolCallId = `${toolName}-call-0001`) {
  return {
    type: "tool-call",
    toolCallId,
    toolName,
    input: JSON.stringify(input),
  };
}

function textStep(text, tokenUsage = usage()) {
  return streamResult([...textChunks(text), finish("stop", tokenUsage)]);
}

function toolStep(chunks) {
  return streamResult([...chunks, finish("tool-calls")]);
}

function strictStreamModel(results) {
  let index = 0;
  const model = new MockLanguageModelV3({
    provider: "fixture",
    modelId: "fixture-model",
    doStream: async () => {
      if (index >= results.length) {
        throw new Error("Unexpected extra model step.");
      }
      const result = results[index];
      index += 1;
      return result;
    },
  });
  return { model, consumed: () => index };
}

function createGateway(model, overrides = {}) {
  let id = 0;
  return new AiSdkAgentGateway({
    model,
    provider: "fixture-provider",
    modelId: "fixture-model",
    contextLength: 8_192,
    contextLengthSource: "override",
    readProjectFile: async () => ({
      path: "main.tex",
      range: { from: 0, to: 22 },
      text: firstSentence,
    }),
    now: () => createdAt,
    createId: (kind) => `${kind}-${String((id += 1)).padStart(4, "0")}`,
    ...overrides,
  });
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

async function captureError(work) {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject.");
}

function sentPrompt(model) {
  return model.doStreamCalls[0].prompt[1].content[0].text;
}

function sentConversationMessages(model) {
  return model.doStreamCalls[0].prompt.slice(2).map((message) => ({
    role: message.role,
    text: Array.isArray(message.content)
      ? message.content.map((part) => part.text ?? "").join("")
      : message.content,
  }));
}

function sentSystemInstruction(model) {
  return model.doStreamCalls[0].prompt[0].content;
}

describe("AI reviewer: one agent path for review and conversation", function () {
  it.each([
    {
      label: "review mode",
      request: () => projectRequest(),
      included: [
        "You are reviewing an academic manuscript as a referee.",
        "For each actionable point, call report_finding",
        "put every issue worth tracking in that tool",
        "if there are none, do not call it",
      ],
      excluded: ["You are a thinking partner for work in progress"],
    },
    {
      label: "brainstorm mode",
      request: () =>
        openRequest({
          skill: "brainstorm",
          instruction: "Help me choose between two research questions.",
        }),
      included: [
        "You are a thinking partner for work in progress, not a reviewer.",
        "Do not produce findings or verdicts",
      ],
      excluded: ["You are reviewing an academic manuscript as a referee."],
    },
    {
      label: "no mode",
      request: () => openRequest(),
      included: [],
      excluded: [
        "You are reviewing an academic manuscript as a referee.",
        "You are a thinking partner for work in progress, not a reviewer.",
      ],
    },
  ])("selects the built-in instruction for $label", async function (testCase) {
    const { model } = strictStreamModel([textStep("Mode selected.")]);

    await collect(createGateway(model).stream(testCase.request()));

    const systemInstruction = sentSystemInstruction(model);
    for (const text of testCase.included) {
      expect(systemInstruction).toContain(text);
    }
    for (const text of testCase.excluded) {
      expect(systemInstruction).not.toContain(text);
    }
  });

  it("replaces each built-in perspective independently", async function () {
    const refereePerspective =
      "Prioritize whether the causal identification supports the main claim.";
    const brainstormPerspective =
      "Explore rival framings before choosing the research question.";
    const modeInstructions = {
      "referee-review": refereePerspective,
      brainstorm: brainstormPerspective,
    };
    const { model: refereeModel } = strictStreamModel([
      textStep("Referee response."),
    ]);
    const { model: brainstormModel } = strictStreamModel([
      textStep("Brainstorm response."),
    ]);

    await collect(
      createGateway(refereeModel, { modeInstructions }).stream(
        projectRequest(),
      ),
    );
    await collect(
      createGateway(brainstormModel, { modeInstructions }).stream(
        openRequest({ skill: "brainstorm" }),
      ),
    );

    expect(sentSystemInstruction(refereeModel)).toContain(refereePerspective);
    expect(sentSystemInstruction(refereeModel)).toContain(
      "For each actionable point, call report_finding",
    );
    expect(sentSystemInstruction(refereeModel)).not.toContain(
      "You are reviewing an academic manuscript as a referee.",
    );
    expect(sentSystemInstruction(brainstormModel)).toContain(
      brainstormPerspective,
    );
    expect(sentSystemInstruction(brainstormModel)).not.toContain(
      "You are a thinking partner for work in progress",
    );
    expect(sentSystemInstruction(brainstormModel)).not.toContain(
      refereePerspective,
    );
  });

  it("rejects a custom perspective beyond the production character cap", function () {
    const { model } = strictStreamModel([textStep("Must not run.")]);

    expect(() =>
      createGateway(model, {
        modeInstructions: {
          "referee-review": "x".repeat(
            AI_REVIEWER_MODE_INSTRUCTION_MAX_LENGTH + 1,
          ),
        },
      }),
    ).toThrowError("modeInstructions must be bounded review perspectives");
    expect(model.doStreamCalls).toHaveLength(0);
  });

  it("keeps the maximum custom referee perspective inside the 8k instruction reserve", async function () {
    const { model } = strictStreamModel([textStep("Bounded response.")]);

    await collect(
      createGateway(model, {
        modeInstructions: {
          "referee-review": "x".repeat(AI_REVIEWER_MODE_INSTRUCTION_MAX_LENGTH),
        },
      }).stream(projectRequest()),
    );

    expect(
      estimateModelInputTokens(sentSystemInstruction(model)),
    ).toBeLessThanOrEqual(modelInputTokenBudget(8_192));
  });

  it.each([
    {
      label: "a review run",
      request: () => projectRequest(),
    },
    {
      label: "a conversation turn",
      request: () =>
        openRequest({
          skill: "brainstorm",
          instruction: "この研究課題を一緒に考えてください。",
        }),
    },
    {
      label: "a no-mode turn",
      request: () => openRequest({ skill: null }),
    },
  ])("carries the shared language rule into $label", async function (testCase) {
    const { model } = strictStreamModel([textStep("Language selected.")]);

    await collect(createGateway(model).stream(testCase.request()));

    expect(sentSystemInstruction(model)).toContain(
      [
        "Answer in the language the author writes in. Judge that from the author's own",
        "latest message. When the only instruction is a built-in English one, use the",
        "main language of the manuscript instead.",
      ].join("\n"),
    );
  });

  it("keeps review artifact tools out of brainstorm mode", async function () {
    const { model } = strictStreamModel([textStep("One question first.")]);

    await collect(
      createGateway(model, { searchZotero: async () => [] }).stream(
        documentRequest({
          skill: "brainstorm",
          agentSessionId: "discussion-agent-brainstorm",
        }),
      ),
    );

    expect(
      model.doStreamCalls[0].tools.map((declared) => declared.name),
    ).toEqual(["read_project_file", "search_zotero", "report_subject"]);
    expect(sentSystemInstruction(model)).not.toContain(
      "call propose_suggestion instead of pasting the replacement into prose",
    );
  });

  it("reads a project file while answering a conversation turn", async function () {
    const readProjectFile = vi.fn(async () => ({
      path: "main.tex",
      range: { from: 0, to: 22 },
      text: firstSentence,
    }));
    const { model } = strictStreamModel([
      toolStep([
        toolChunk("read_project_file", {
          path: "main.tex",
          range: { from: 0, to: 22 },
        }),
      ]),
      textStep("The subject of the sentence is never named."),
    ]);
    const gateway = createGateway(model, { readProjectFile });

    const events = await collect(gateway.stream(documentRequest()));

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "tool.call",
      "text.delta",
      "completed",
    ]);
    expect(events[1]).toMatchObject({
      call: {
        name: "read_project_file",
        arguments: { path: "main.tex", range: { from: 0, to: 22 } },
      },
    });
    expect(readProjectFile).toHaveBeenCalledExactlyOnceWith(
      { path: "main.tex", range: { from: 0, to: 22 } },
      { request: documentRequest(), signal: undefined },
    );
  });

  it("offers only reporting tools on the final step", async function () {
    const readSteps = Array.from({ length: 7 }, (_, index) =>
      toolStep([
        toolChunk(
          "read_project_file",
          { path: "main.tex", range: { from: 0, to: 22 } },
          `read-before-final-${index}`,
        ),
      ]),
    );
    const { model } = strictStreamModel([
      ...readSteps,
      textStep("Answered on the reserved final step."),
    ]);

    const events = await collect(
      createGateway(model, {
        skills: [
          {
            name: "Synthetic review skill",
            description: "Synthetic bounded reference.",
            body: "Synthetic body.",
            referenceFiles: {},
          },
        ],
        readProjectComments: async () => ({ threads: [] }),
        readProjectFigure: async () => ({
          path: "figure.png",
          mediaType: "image/png",
          bytes: 4,
          data: "AQIDBA==",
        }),
        searchZotero: async () => [],
        supportsImages: true,
      }).stream(documentRequest({ skill: "referee-review" })),
    );

    const initialTools = model.doStreamCalls[0].tools.map(({ name }) => name);
    const finalTools = model.doStreamCalls[7].tools.map(({ name }) => name);
    expect(initialTools).toHaveLength(8);
    expect(initialTools).toEqual(
      expect.arrayContaining([
        "read_project_file",
        "read_project_comments",
        "read_project_figure",
        "read_skill",
        "search_zotero",
        "report_subject",
        "report_finding",
        "propose_suggestion",
      ]),
    );
    expect(finalTools.toSorted()).toEqual(
      ["report_subject", "report_finding", "propose_suggestion"].toSorted(),
    );
    expect(model.doStreamCalls[0].prompt[0].content).not.toContain(
      "This is the last step.",
    );
    expect(model.doStreamCalls[7].prompt[0].content).toContain(
      "This is the last step. Answer now using only what you already have.",
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "text.delta",
        delta: "Answered on the reserved final step.",
      }),
    );
    expect(events.at(-1)).toMatchObject({ type: "completed" });
  });

  it("searches Zotero while answering a conversation turn", async function () {
    const searchZotero = vi.fn(async () => [
      { itemKey: "ITEM1", title: "Synthetic result" },
    ]);
    const { model } = strictStreamModel([
      toolStep([toolChunk("search_zotero", { query: "greenwade" })]),
      textStep("The library has one matching entry."),
    ]);
    const gateway = createGateway(model, { searchZotero });
    const request = documentRequest();

    const events = await collect(gateway.stream(request));

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "tool.call",
      "text.delta",
      "completed",
    ]);
    expect(events[1]).toMatchObject({
      call: { name: "search_zotero", arguments: { query: "greenwade" } },
    });
    expect(searchZotero).toHaveBeenCalledExactlyOnceWith(
      { query: "greenwade" },
      { request, signal: undefined },
    );
  });

  it("withholds the Zotero tool when no library is connected", async function () {
    const { model } = strictStreamModel([textStep("No library available.")]);

    await collect(createGateway(model).stream(documentRequest()));

    expect(
      model.doStreamCalls[0].tools.map((declared) => declared.name),
    ).toEqual([
      "read_project_file",
      "report_subject",
      "report_finding",
      "propose_suggestion",
    ]);
  });

  it.each([
    {
      action: "rewrite",
      replacement: "The result needs a clearer explanation.",
    },
    {
      action: "shorten",
      replacement: "Result unclear.",
    },
  ])(
    "turns a minimal $action result into a server-bound suggestion",
    async function ({ action, replacement }) {
      const request = selectionTransformRequest(action);
      const { model, consumed } = strictStreamModel([
        toolStep([
          toolChunk("propose_suggestion", {
            replacement,
            rationale: "Keep the edit focused on the selected sentence.",
          }),
        ]),
      ]);

      const events = await collect(createGateway(model).stream(request));

      expect(events.map((event) => event.type)).toEqual([
        "started",
        "suggestion",
        "completed",
      ]);
      expect(events[1].suggestion).toMatchObject({
        requestId: request.requestId,
        projectId: request.projectId,
        documentId: request.scope.documentId,
        path: request.scope.path,
        baseRevision: request.scope.baseRevision,
        baseTextHash: request.scope.baseTextHash,
        range: request.scope.range,
        original: request.scope.text,
        replacement,
        rationale: "Keep the edit focused on the selected sentence.",
        evidence: [
          {
            path: request.scope.path,
            range: request.scope.range,
            revision: request.scope.baseRevision,
            textHash: request.scope.baseTextHash,
          },
        ],
        skill: "line-edit",
        status: "unresolved",
      });
      expect(consumed()).toBe(1);
      expect(model.doStreamCalls[0].toolChoice).toEqual({
        type: "tool",
        toolName: "propose_suggestion",
      });
      expect(
        model.doStreamCalls[0].tools.map((declared) => declared.name),
      ).toEqual(["propose_suggestion"]);
      expect(sentSystemInstruction(model)).toContain(
        "Call propose_suggestion exactly once",
      );
      expect(sentSystemInstruction(model)).not.toContain(
        "Call report_subject exactly once",
      );
      expect(sentSystemInstruction(model)).not.toContain(
        "This is the last step.",
      );
    },
  );

  it("rejects a selection transform that returns prose without a replacement artifact", async function () {
    const { model } = strictStreamModel([
      textStep("The result is now shorter."),
    ]);

    expect(
      await captureError(
        collect(
          createGateway(model).stream(selectionTransformRequest("shorten")),
        ),
      ),
    ).toMatchObject({
      code: "AI_TRANSFORM_RESULT_MISSING",
      category: "schema",
      retryable: false,
    });
  });

  it("interleaves free text and structured findings in one stream", async function () {
    const { model } = strictStreamModel([
      toolStep([
        ...textChunks("Two sentences share the same problem.", "text-a"),
        toolChunk("report_finding", findingDraft(), "finding-call-a"),
      ]),
      toolStep([
        ...textChunks("The second one repeats it.", "text-b"),
        toolChunk(
          "report_finding",
          findingDraft({
            title: "Repeated wording",
            evidence: [
              {
                path: "main.tex",
                range: { from: 23, to: 45 },
                revision: 7,
                textHash: contentHash,
              },
            ],
          }),
          "finding-call-b",
        ),
      ]),
      textStep("Both are worth fixing together."),
    ]);

    const events = await collect(
      createGateway(model).stream(documentRequest()),
    );

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "text.delta",
      "finding",
      "text.delta",
      "finding",
      "text.delta",
      "completed",
    ]);
    expect(events.map((event) => event.sequence)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
    expect(events[2]).toMatchObject({
      finding: {
        artifactKind: "finding",
        title: "Unclear antecedent",
        requestId: "conversation-0001",
        projectId: "project-conversation-0001",
        suggestionIds: [],
      },
    });
    expect(events[4]).toMatchObject({
      finding: { title: "Repeated wording" },
    });
  });

  it("records a private-safe validation reason and completes after a corrected tool call", async function () {
    const manuscript = "PRIVATE_MALFORMED_FINDING_MANUSCRIPT_SENTINEL";
    const invalidFinding = {
      ...findingDraft({ message: manuscript }),
      [manuscript]: true,
    };
    const { model, consumed } = strictStreamModel([
      toolStep([
        toolChunk("report_finding", invalidFinding, "invalid-finding-call"),
      ]),
      toolStep([
        toolChunk("report_finding", findingDraft(), "valid-finding-call"),
      ]),
      textStep("Corrected."),
    ]);
    const previousDebugSetting = Settings.aiReviewer?.debugProviderErrors;
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    try {
      Settings.aiReviewer.debugProviderErrors = true;

      const events = await collect(
        createGateway(model).stream(documentRequest()),
      );

      expect(events.map((event) => event.type)).toEqual([
        "started",
        "finding",
        "text.delta",
        "completed",
      ]);
      expect(consumed()).toBe(3);
      expect(warn).toHaveBeenCalledExactlyOnceWith(
        {
          provider: "fixture-provider",
          model: "fixture-model",
          toolName: "report_finding",
          detail: expect.stringContaining("unrecognized_keys"),
        },
        "AI reviewer provider diagnostic",
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(manuscript);
      expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain(
        "Invalid input for tool report_finding",
      );
    } finally {
      Settings.aiReviewer.debugProviderErrors = previousDebugSetting;
      warn.mockRestore();
    }
  });

  it("fails clearly when an invalid artifact call is never corrected", async function () {
    const { model, consumed } = strictStreamModel([
      toolStep([
        toolChunk(
          "report_finding",
          findingDraft({ severity: "not-a-severity" }),
        ),
      ]),
      textStep("I could not correct the finding."),
    ]);

    expect(
      await captureError(
        collect(createGateway(model).stream(documentRequest())),
      ),
    ).toMatchObject({
      code: "AI_TOOL_INPUT_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(consumed()).toBe(2);
  });

  it("announces a tool by name and target without its arguments or result", async function () {
    const manuscript = "PRIVATE_MANUSCRIPT_SENTENCE";
    const readProjectFile = vi.fn(async () => ({
      path: "main.tex",
      range: { from: 0, to: 22 },
      text: manuscript,
    }));
    const { model } = strictStreamModel([
      toolStep([
        toolChunk("read_project_file", {
          path: "main.tex",
          range: { from: 0, to: 22 },
        }),
      ]),
      textStep("Answered."),
    ]);
    const gateway = createGateway(model, { readProjectFile });

    const events = await collect(gateway.stream(documentRequest()));
    const toolCall = events.find((event) => event.type === "tool.call");

    expect(Object.keys(toolCall.call).sort()).toEqual([
      "arguments",
      "id",
      "name",
    ]);
    expect(toolCall.call).not.toHaveProperty("result");
    expect(JSON.stringify(events)).not.toContain(manuscript);
    expect(JSON.stringify(events)).not.toContain(documentText);
  });

  it("does not announce the artifact tools as conversation tool lines", async function () {
    const { model } = strictStreamModel([
      toolStep([toolChunk("propose_suggestion", suggestionDraft())]),
      textStep("Proposed one edit."),
    ]);

    const events = await collect(
      createGateway(model).stream(documentRequest()),
    );

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "suggestion",
      "text.delta",
      "completed",
    ]);
    expect(events.some((event) => event.type === "tool.call")).toBe(false);
  });

  it("keeps a conversation suggestion applicable under the existing contract", async function () {
    const { model } = strictStreamModel([
      toolStep([toolChunk("propose_suggestion", suggestionDraft())]),
      textStep("That wording names the method."),
    ]);

    const events = await collect(
      createGateway(model).stream(documentRequest()),
    );
    const { suggestion } = events.find((event) => event.type === "suggestion");

    expect(UnresolvedSuggestionSchema.parse(suggestion)).toEqual(suggestion);
    expect(suggestion).toMatchObject({
      requestId: "conversation-0001",
      projectId: "project-conversation-0001",
      documentId: "document-conversation-0001",
      path: "main.tex",
      baseRevision: 7,
      baseTextHash: contentHash,
      range: { from: 0, to: 22 },
      original: firstSentence,
      provider: "fixture-provider",
      model: "fixture-model",
      skill: "line-edit",
      status: "unresolved",
    });
  });

  it("offers and stamps modeless discussion suggestions with the review skill", async function () {
    const request = documentRequest({
      skill: null,
      agentSessionId: "discussion-agent-modeless",
    });
    const { model } = strictStreamModel([
      toolStep([toolChunk("propose_suggestion", suggestionDraft())]),
      textStep("Naming the method makes the sentence concrete."),
    ]);

    const events = await collect(createGateway(model).stream(request));
    const { suggestion } = events.find((event) => event.type === "suggestion");

    expect(request.skill).toBeNull();
    expect(UnresolvedSuggestionSchema.parse(suggestion)).toEqual(suggestion);
    expect(suggestion.skill).toBe("review");
    expect(
      model.doStreamCalls[0].tools.map((declared) => declared.name),
    ).toContain("propose_suggestion");
    expect(sentSystemInstruction(model)).toContain(
      "call propose_suggestion instead of pasting the replacement into prose",
    );
  });

  it("keeps the discussion suggestion instruction out of a run", async function () {
    const { model } = strictStreamModel([textStep("Run response.")]);

    await collect(
      createGateway(model).stream(documentRequest({ skill: null })),
    );

    expect(sentSystemInstruction(model)).not.toContain(
      "call propose_suggestion instead of pasting the replacement into prose",
    );
  });

  it("shifts a selection-relative suggestion into absolute document positions", async function () {
    const selectionRequest = documentRequest({
      scope: {
        kind: "selection",
        documentId: "document-conversation-0001",
        path: "main.tex",
        baseRevision: 7,
        baseTextHash: contentHash,
        range: { from: 23, to: 45 },
        text: documentText.slice(23, 45),
      },
    });
    const { model } = strictStreamModel([
      toolStep([
        toolChunk(
          "propose_suggestion",
          suggestionDraft({
            range: { from: 0, to: 22 },
            original: documentText.slice(23, 45),
            evidence: [
              {
                path: "main.tex",
                range: { from: 0, to: 22 },
                revision: 7,
                textHash: contentHash,
              },
            ],
          }),
        ),
      ]),
      textStep("Rewritten."),
    ]);

    const events = await collect(createGateway(model).stream(selectionRequest));
    const { suggestion } = events.find((event) => event.type === "suggestion");

    expect(suggestion.range).toEqual({ from: 23, to: 45 });
    expect(suggestion.evidence[0].range).toEqual({ from: 23, to: 45 });
  });

  it("rejects evidence outside the requested document state", async function () {
    const { model } = strictStreamModel([
      toolStep([
        toolChunk(
          "report_finding",
          findingDraft({
            evidence: [
              {
                path: "other.tex",
                range: { from: 0, to: 22 },
                revision: 7,
                textHash: contentHash,
              },
            ],
          }),
        ),
      ]),
      textStep("Unreachable."),
    ]);

    expect(
      await captureError(
        collect(createGateway(model).stream(documentRequest())),
      ),
    ).toMatchObject({
      code: "AI_EVIDENCE_SCOPE_MISMATCH",
      category: "schema",
      retryable: false,
    });
  });

  it("resolves a whitespace-normalized excerpt to its captured project range", async function () {
    const readProjectFile = vi.fn(async () => ({
      path: "main.tex",
      range: { from: 10, to: 32 },
      revision: 7,
      textHash: contentHash,
      text: firstSentence,
    }));
    const validateEvidence = vi.fn();
    const { model } = strictStreamModel([
      toolStep([
        toolChunk("read_project_file", {
          path: "main.tex",
          range: { from: 10, to: 32 },
        }),
      ]),
      toolStep([
        toolChunk(
          "report_finding",
          findingDraft({
            evidence: [
              {
                path: "main.tex",
                excerpt: "method  \n is unclear.",
              },
            ],
          }),
        ),
      ]),
      textStep("Reported."),
    ]);
    const gateway = createGateway(model, {
      readProjectFile,
      validateEvidence,
    });

    const events = await collect(gateway.stream(projectRequest()));
    const { finding } = events.find((event) => event.type === "finding");

    expect(finding.evidence).toEqual([
      {
        path: "main.tex",
        range: { from: 14, to: 32 },
        revision: 7,
        textHash: contentHash,
      },
    ]);
    expect(validateEvidence).toHaveBeenCalledExactlyOnceWith(finding.evidence, {
      request: projectRequest(),
      signal: undefined,
    });
  });

  it("rejects an excerpt absent from the captured scope with a specific reason", async function () {
    const { model } = strictStreamModel([
      toolStep([
        toolChunk(
          "report_finding",
          findingDraft({
            evidence: [
              { path: "main.tex", excerpt: "A passage that is not present." },
            ],
          }),
        ),
      ]),
      textStep("I could not correct the evidence."),
    ]);

    expect(
      await captureError(
        collect(createGateway(model).stream(documentRequest())),
      ),
    ).toMatchObject({
      code: "AI_EVIDENCE_EXCERPT_NOT_FOUND",
      category: "schema",
      retryable: false,
      message:
        "The quoted evidence excerpt was not found in the captured scope text.",
    });
  });

  it("records an actual rejected finding excerpt by reason after correction", async function () {
    const readProjectFile = vi.fn(async () => ({
      path: "main.tex",
      range: { from: 10, to: 32 },
      revision: 7,
      textHash: contentHash,
      text: firstSentence,
    }));
    const { model } = strictStreamModel([
      toolStep([
        toolChunk("read_project_file", {
          path: "main.tex",
          range: { from: 10, to: 32 },
        }),
      ]),
      toolStep([
        toolChunk(
          "report_finding",
          findingDraft({
            evidence: [
              { path: "main.tex", excerpt: "A passage that is not present." },
            ],
          }),
          "rejected-finding-call",
        ),
      ]),
      toolStep([
        toolChunk(
          "report_finding",
          findingDraft({
            evidence: [{ path: "main.tex", excerpt: "method is unclear." }],
          }),
          "corrected-finding-call",
        ),
      ]),
      textStep("Corrected."),
    ]);
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      const events = await collect(
        createGateway(model, {
          readProjectFile,
          validateEvidence: vi.fn(),
        }).stream(projectRequest()),
      );

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "finding",
          finding: expect.objectContaining({ title: "Unclear antecedent" }),
        }),
      );
      expect(info).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          toolCallCounts: { read_project_file: 1, report_finding: 2 },
          reportFindingRejections: {
            count: 1,
            byCode: { AI_EVIDENCE_EXCERPT_NOT_FOUND: 1 },
          },
          pendingValidatedArtifactCount: 0,
          contentCharsRead: firstSentence.length,
          readToolCalls: 1,
        }),
        AI_REVIEWER_COMPLETION_LOG_MESSAGE,
      );
    } finally {
      info.mockRestore();
    }
  });

  it("records zero finding rejections when the first call succeeds", async function () {
    const { model } = strictStreamModel([
      toolStep([toolChunk("report_finding", findingDraft())]),
      textStep("Reported."),
    ]);
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      await collect(
        createGateway(model, { validateEvidence: vi.fn() }).stream(
          documentRequest(),
        ),
      );

      expect(info).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          toolCallCounts: { report_finding: 1 },
          reportFindingRejections: { count: 0, byCode: {} },
        }),
        AI_REVIEWER_COMPLETION_LOG_MESSAGE,
      );
    } finally {
      info.mockRestore();
    }
  });

  it("does not count a rejected suggestion as a finding rejection", async function () {
    const { model } = strictStreamModel([
      toolStep([
        toolChunk(
          "propose_suggestion",
          suggestionDraft({
            evidence: [
              {
                path: "other.tex",
                range: { from: 0, to: 22 },
                revision: 7,
                textHash: contentHash,
              },
            ],
          }),
          "rejected-suggestion-call",
        ),
      ]),
      toolStep([
        toolChunk(
          "propose_suggestion",
          suggestionDraft(),
          "corrected-suggestion-call",
        ),
      ]),
      textStep("Corrected."),
    ]);
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      const events = await collect(
        createGateway(model, { validateEvidence: vi.fn() }).stream(
          documentRequest(),
        ),
      );

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "suggestion",
          suggestion: expect.objectContaining({
            replacement: suggestionDraft().replacement,
          }),
        }),
      );
      expect(info).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          toolCallCounts: { propose_suggestion: 2 },
          reportFindingRejections: { count: 0, byCode: {} },
          pendingValidatedArtifactCount: 0,
        }),
        AI_REVIEWER_COMPLETION_LOG_MESSAGE,
      );
    } finally {
      info.mockRestore();
    }
  });

  it("rejects an excerpt that identifies more than one captured range", async function () {
    const repeatedText = "Repeated point. Repeated point.";
    const { model } = strictStreamModel([
      toolStep([
        toolChunk(
          "report_finding",
          findingDraft({
            evidence: [{ path: "main.tex", excerpt: "Repeated point." }],
          }),
        ),
      ]),
      textStep("I could not disambiguate the evidence."),
    ]);

    expect(
      await captureError(
        collect(
          createGateway(model).stream(
            documentRequest({
              scope: {
                kind: "document",
                documentId: "document-conversation-0001",
                path: "main.tex",
                baseRevision: 7,
                baseTextHash: contentHash,
                text: repeatedText,
              },
            }),
          ),
        ),
      ),
    ).toMatchObject({
      code: "AI_EVIDENCE_EXCERPT_AMBIGUOUS",
      category: "schema",
      retryable: false,
      message:
        "The quoted evidence excerpt matches more than one location in the captured scope text.",
    });
  });

  it("keeps accepting explicit evidence offsets", async function () {
    const validateEvidence = vi.fn();
    const { model } = strictStreamModel([
      toolStep([toolChunk("report_finding", findingDraft())]),
      textStep("Reported."),
    ]);
    const gateway = createGateway(model, { validateEvidence });
    const request = documentRequest();

    const events = await collect(gateway.stream(request));
    const { finding } = events.find((event) => event.type === "finding");

    expect(finding.evidence).toEqual(findingDraft().evidence);
    expect(validateEvidence).toHaveBeenCalledExactlyOnceWith(
      findingDraft().evidence,
      { request, signal: undefined },
    );
  });

  it.each([
    {
      label: "a project scope",
      request: () => projectRequest(),
      code: "AI_PROJECT_SUGGESTION_NOT_ALLOWED",
    },
    {
      label: "no scope at all",
      request: () => openRequest(),
      code: "AI_SUGGESTION_SCOPE_REQUIRED",
    },
  ])("refuses a suggestion for $label", async function ({ request, code }) {
    const { model } = strictStreamModel([
      toolStep([toolChunk("propose_suggestion", suggestionDraft())]),
    ]);

    expect(
      await captureError(collect(createGateway(model).stream(request()))),
    ).toMatchObject({ code, category: "schema", retryable: false });
    expect(
      model.doStreamCalls[0].tools.map((declared) => declared.name),
    ).not.toContain("propose_suggestion");
  });

  it("sends readable context and preserves every conversation role", async function () {
    const { model } = strictStreamModel([textStep("Readable.")]);
    const request = documentRequest();

    await collect(createGateway(model).stream(request));

    const prompt = sentPrompt(model);
    expect(prompt).toContain("## Task\n\nAction: review\nSkill: line-edit");
    expect(prompt).toContain("## Scope\n\nScope: document\nFile: main.tex");
    expect(prompt).toContain(documentText);
    expect(sentConversationMessages(model)).toEqual([
      ...request.turns,
      { role: "user", text: request.instruction },
    ]);
    for (const wireKey of [
      "requestId",
      "projectId",
      "documentId",
      "baseRevision",
      "baseTextHash",
      '"turns"',
    ]) {
      expect(prompt).not.toContain(wireKey);
    }
  });

  it("keeps all 12 bounded turns in order and rejects a thirteenth", async function () {
    const turns = Array.from(
      { length: DISCUSSION_CONTEXT_TURN_LIMIT },
      (_, index) => ({
        role: index % 2 === 0 ? "assistant" : "user",
        text: `Bounded turn ${index + 1}.`,
      }),
    );
    const { model } = strictStreamModel([textStep("All turns received.")]);

    await collect(createGateway(model).stream(openRequest({ turns })));

    expect(DISCUSSION_CONTEXT_TURN_LIMIT).toBe(12);
    expect(sentConversationMessages(model)).toEqual([
      ...turns,
      { role: "user", text: openRequest({ turns }).instruction },
    ]);

    const { model: overLimitModel } = strictStreamModel([
      textStep("Must not run."),
    ]);
    expect(
      await captureError(
        collect(
          createGateway(overLimitModel).stream(
            openRequest({
              turns: [...turns, { role: "user", text: "Turn 13." }],
            }),
          ),
        ),
      ),
    ).toMatchObject({
      code: "AI_REQUEST_SCHEMA_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(overLimitModel.doStreamCalls).toHaveLength(0);
  });

  it("measures the manuscript budget against the exact readable prompt", async function () {
    const baseRequest = documentRequest();
    const request = {
      ...baseRequest,
      scope: { ...baseRequest.scope, text: "x".repeat(3_000) },
    };
    const { model: captureModel } = strictStreamModel([textStep("Captured.")]);

    await collect(createGateway(captureModel).stream(request));

    const readablePromptTokens = estimateAgentPromptTokens(request, null);
    const readableContext = sentPrompt(captureModel);
    const systemInstruction = sentSystemInstruction(captureModel);
    const exactContextLength = Math.ceil(readablePromptTokens / 0.7);
    const shortContextLength = exactContextLength - 1;
    expect(modelInputTokenBudget(exactContextLength)).toBe(
      readablePromptTokens,
    );
    expect(estimateModelInputTokens(systemInstruction)).toBeLessThanOrEqual(
      readablePromptTokens,
    );

    const { model: shortModel } = strictStreamModel([
      textStep("Must not run."),
    ]);
    expect(
      await captureError(
        collect(
          createGateway(shortModel, {
            contextLength: shortContextLength,
          }).stream(request),
        ),
      ),
    ).toMatchObject({
      code: "AI_MODEL_CONTEXT_TOO_SMALL",
      category: "configuration",
      retryable: false,
      contextLength: shortContextLength,
      contextLengthSource: "override",
    });
    expect(shortModel.doStreamCalls).toHaveLength(0);

    const { model: exactModel } = strictStreamModel([textStep("Exact fit.")]);
    await collect(
      createGateway(exactModel, { contextLength: exactContextLength }).stream(
        request,
      ),
    );
    expect(sentSystemInstruction(exactModel)).toBe(systemInstruction);
    expect(sentPrompt(exactModel)).toBe(readableContext);
  });

  it("fits a 6000-character English document and conversation in a 32k context", async function () {
    const request = documentRequest({
      scope: {
        ...documentRequest().scope,
        text: "a".repeat(6_000),
      },
      turns: Array.from({ length: 4 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        text: "b".repeat(3_000),
      })),
    });
    const { model } = strictStreamModel([textStep("Fits.")]);

    const events = await collect(
      createGateway(model, { contextLength: 32_768 }).stream(request),
    );

    expect(model.doStreamCalls).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      finishReason: "stop",
    });
  });

  it("keeps the provider response body and the credential out of a failure", async function () {
    const secret = "PROVIDER_RESPONSE_BODY_AND_CREDENTIAL_SENTINEL";
    const model = new MockLanguageModelV3({
      provider: "fixture",
      modelId: "fixture-model",
      doStream: async () => {
        throw new Error(secret);
      },
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      const error = await captureError(
        collect(createGateway(model).stream(documentRequest())),
      );

      expect(error).toMatchObject({
        code: "AI_PROVIDER_FAILED",
        category: "provider",
        message: "The AI provider failed.",
      });
      expect(String(error)).not.toContain(secret);
      expect(JSON.stringify(error)).not.toContain(secret);
      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps run findings out of a conversation that names no scope", async function () {
    const { model } = strictStreamModel([textStep("Chapter three.")]);
    const gateway = createGateway(model, { searchZotero: async () => [] });

    await collect(gateway.stream(openRequest()));

    expect(
      model.doStreamCalls[0].tools.map((declared) => declared.name),
    ).toEqual(["read_project_file", "search_zotero", "report_subject"]);
    expect(sentSystemInstruction(model)).not.toContain("report_finding");
    expect(sentSystemInstruction(model)).not.toContain(
      "Do not restate a reported finding",
    );
  });

  it("keeps document-bound discussion findings supplementary to a standalone answer", async function () {
    const { model } = strictStreamModel([textStep("Explain the issue fully.")]);
    const gateway = createGateway(model, { searchZotero: async () => [] });

    const events = await collect(
      gateway.stream(
        documentRequest({ agentSessionId: "discussion-agent-0001" }),
      ),
    );

    expect(
      model.doStreamCalls[0].tools.map((declared) => declared.name),
    ).toContain("report_finding");
    expect(sentSystemInstruction(model)).toContain(
      "Keep the answer independently meaningful",
    );
    expect(sentSystemInstruction(model)).not.toContain(
      "Do not restate a reported finding",
    );
    expect(events.at(-1)).not.toHaveProperty("findingToolNotCalled");
  });

  it("does not tell a scope-free custom referee discussion to call a withheld finding tool", async function () {
    const { model } = strictStreamModel([textStep("Chapter three.")]);
    const customPerspective =
      "Assess the argument from the perspective of a skeptical area chair.";
    const gateway = createGateway(model, {
      searchZotero: async () => [],
      modeInstructions: { "referee-review": customPerspective },
    });

    await collect(gateway.stream(openRequest({ skill: "referee-review" })));

    expect(sentSystemInstruction(model)).toContain(customPerspective);
    expect(sentSystemInstruction(model)).not.toContain(
      "You are reviewing an academic manuscript as a referee.",
    );
    expect(sentSystemInstruction(model)).not.toContain("report_finding");
    expect(
      model.doStreamCalls[0].tools.map((declared) => declared.name),
    ).toEqual(["read_project_file", "search_zotero", "report_subject"]);
  });
});
