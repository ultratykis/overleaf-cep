import { simulateReadableStream } from "ai";
// The SDK publishes this test entrypoint, but the repository resolver does not
// currently resolve package export subpaths.
// eslint-disable-next-line import/no-unresolved
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it } from "vitest";

import { AiSdkAgentGateway } from "../../../app/src/AiSdkAgentGateway.mjs";
import { modelInputCharacterBudget } from "../../../app/src/ModelContextBudget.mjs";
import { DISCUSSION_CONTEXT_TURN_LIMIT } from "../../../shared/contracts.mjs";

const createdAt = "2026-07-25T00:00:00.000Z";
const contentHash = "a".repeat(64);

function sourceRequest(overrides = {}) {
  return {
    requestId: "source-request-0001",
    projectId: "project-discussion-0001",
    action: "rewrite",
    instruction: "Improve the selected text.",
    skill: "line-edit",
    scope: {
      kind: "selection",
      documentId: "document-discussion-0001",
      path: "main.tex",
      baseRevision: 7,
      baseTextHash: contentHash,
      range: { from: 0, to: 4 },
      text: "Text",
    },
    ...overrides,
  };
}

function discussionRequest(overrides = {}) {
  const source = sourceRequest();
  return {
    requestId: "discussion-turn-0001",
    discussionId: "discussion-0001",
    projectId: source.projectId,
    subject: {
      kind: "scope",
      sourceRequest: source,
    },
    turns: [{ role: "user", text: "Why should this wording change?" }],
    ...overrides,
  };
}

function documentSourceRequest({
  suffix,
  path,
  text,
  baseRevision,
  baseTextHash,
}) {
  return sourceRequest({
    requestId: `source-request-${suffix}-internal`,
    projectId: `project-${suffix}-internal`,
    action: "review",
    instruction: `Transport instruction ${suffix} must stay private.`,
    skill: `skill-${suffix}-internal`,
    scope: {
      kind: "document",
      documentId: `document-${suffix}-internal`,
      path,
      baseRevision,
      baseTextHash,
      text,
    },
  });
}

function selectionSourceRequest({
  suffix,
  path,
  text,
  from,
  baseRevision,
  baseTextHash,
}) {
  return sourceRequest({
    requestId: `source-request-${suffix}-internal`,
    projectId: `project-${suffix}-internal`,
    instruction: `Transport instruction ${suffix} must stay private.`,
    skill: `skill-${suffix}-internal`,
    scope: {
      kind: "selection",
      documentId: `document-${suffix}-internal`,
      path,
      baseRevision,
      baseTextHash,
      range: { from, to: from + text.length },
      text,
    },
  });
}

function projectSourceRequest(suffix) {
  return sourceRequest({
    requestId: `source-request-${suffix}-internal`,
    projectId: `project-${suffix}-internal`,
    action: "review",
    instruction: `Transport instruction ${suffix} must stay private.`,
    skill: `skill-${suffix}-internal`,
    scope: { kind: "project" },
  });
}

function findingSubject(kind) {
  const suffix = kind === "finding" ? "finding" : "citation";
  const path = `chapters/${suffix}.tex`;
  const text =
    kind === "finding"
      ? "A pronoun has no clear antecedent in this sentence."
      : "The citation record is missing a required publication year.";
  const baseRevision = kind === "finding" ? 901_001 : 901_002;
  const baseTextHash = kind === "finding" ? "b".repeat(64) : "c".repeat(64);
  const source = documentSourceRequest({
    suffix,
    path,
    text,
    baseRevision,
    baseTextHash,
  });
  const artifact = {
    id: `artifact-${suffix}-internal`,
    requestId: source.requestId,
    projectId: source.projectId,
    artifactKind: kind,
    severity: kind === "finding" ? "warning" : "error",
    category: `category-${suffix}-internal`,
    title:
      kind === "finding" ? "Unclear antecedent" : "Missing publication year",
    message:
      kind === "finding"
        ? "The pronoun does not identify which method produced the result."
        : "The cited entry needs a publication year before it is complete.",
    evidence: [
      {
        path,
        range: { from: 0, to: 9 },
        revision: baseRevision,
        textHash: baseTextHash,
      },
      {
        path,
        range: { from: 10, to: 18 },
        revision: baseRevision,
        textHash: baseTextHash,
      },
    ],
    suggestionIds: [`linked-suggestion-${suffix}-internal`],
    ...(kind === "citation-finding"
      ? { proposedText: "Add the verified publication year." }
      : {}),
  };
  return {
    kind,
    sourceRequest: source,
    artifact,
  };
}

function suggestionSubject() {
  const original = "draft phrase";
  const baseRevision = 901_003;
  const baseTextHash = "d".repeat(64);
  const source = selectionSourceRequest({
    suffix: "suggestion",
    path: "chapters/suggestion.tex",
    text: original,
    from: 21,
    baseRevision,
    baseTextHash,
  });
  return {
    kind: "suggestion",
    sourceRequest: source,
    artifact: {
      id: "artifact-suggestion-internal",
      requestId: source.requestId,
      projectId: source.projectId,
      documentId: source.scope.documentId,
      path: source.scope.path,
      baseRevision,
      baseTextHash,
      range: source.scope.range,
      original,
      replacement: "precise phrase",
      rationale: "The replacement states the claim directly.",
      evidence: [
        {
          path: source.scope.path,
          range: source.scope.range,
          revision: baseRevision,
          textHash: baseTextHash,
        },
      ],
      provider: "provider-suggestion-internal",
      model: "model-suggestion-internal",
      skill: source.skill,
      createdAt,
      status: "unresolved",
    },
  };
}

function requestForSubject(suffix, subject) {
  return discussionRequest({
    requestId: `discussion-request-${suffix}-internal`,
    discussionId: `discussion-${suffix}-internal`,
    projectId:
      subject == null
        ? `project-${suffix}-internal`
        : subject.sourceRequest.projectId,
    subject,
    turns: [
      { role: "user", text: `Initial question for ${suffix}.` },
      { role: "assistant", text: `Earlier answer for ${suffix}.` },
      { role: "user", text: `Follow-up question for ${suffix}.` },
    ],
  });
}

function internalPromptValues(request) {
  const values = new Set([
    request.requestId,
    request.discussionId,
    request.projectId,
  ]);
  const { subject } = request;
  if (subject == null) {
    return [...values];
  }
  const { sourceRequest: source } = subject;
  values.add(source.requestId);
  values.add(source.projectId);
  values.add(source.instruction);
  values.add(source.skill);
  if (source.scope.kind !== "project") {
    values.add(source.scope.documentId);
    values.add(String(source.scope.baseRevision));
    values.add(source.scope.baseTextHash);
  }
  if (subject.kind === "scope") {
    return [...values].filter((value) => value != null);
  }
  const { artifact } = subject;
  values.add(artifact.id);
  values.add(artifact.requestId);
  values.add(artifact.projectId);
  for (const reference of artifact.evidence) {
    values.add(reference.revision == null ? null : String(reference.revision));
    values.add(reference.textHash);
  }
  if (subject.kind === "suggestion") {
    values.add(artifact.documentId);
    values.add(String(artifact.baseRevision));
    values.add(artifact.baseTextHash);
    values.add(artifact.provider);
    values.add(artifact.model);
    values.add(artifact.skill);
    values.add(artifact.createdAt);
    values.add(artifact.status);
  } else {
    values.add(artifact.category);
    for (const suggestionId of artifact.suggestionIds) {
      values.add(suggestionId);
    }
  }
  return [...values].filter((value) => value != null);
}

function sentPrompt(model) {
  return model.doStreamCalls[0].prompt[1].content[0].text;
}

function discussionPromptCases() {
  const finding = findingSubject("finding");
  const citationFinding = findingSubject("citation-finding");
  const suggestion = suggestionSubject();
  const selectionText = "selected scope excerpt";
  const selectionSource = selectionSourceRequest({
    suffix: "scope-selection",
    path: "chapters/selection-scope.tex",
    text: selectionText,
    from: 101,
    baseRevision: 901_004,
    baseTextHash: "e".repeat(64),
  });
  const documentText =
    "A complete document excerpt supplied as readable discussion context.";
  const documentSource = documentSourceRequest({
    suffix: "scope-document",
    path: "chapters/document-scope.tex",
    text: documentText,
    baseRevision: 901_005,
    baseTextHash: "f".repeat(64),
  });
  const projectSource = projectSourceRequest("scope-project");
  return [
    {
      label: "finding",
      request: requestForSubject("finding", finding),
      expected: [
        "Kind: finding",
        "Severity: warning",
        "Title: Unclear antecedent",
        "The pronoun does not identify which method produced the result.",
        "- chapters/finding.tex (range [0, 9))",
        "- chapters/finding.tex (range [10, 18))",
        "## Source scope",
        "Document text:",
        finding.sourceRequest.scope.text,
      ],
      hasSubject: true,
    },
    {
      label: "citation finding",
      request: requestForSubject("citation", citationFinding),
      expected: [
        "Kind: citation-finding",
        "Severity: error",
        "Title: Missing publication year",
        "The cited entry needs a publication year before it is complete.",
        "Proposed text:",
        "Add the verified publication year.",
        "- chapters/citation.tex (range [0, 9))",
        "- chapters/citation.tex (range [10, 18))",
        "## Source scope",
        citationFinding.sourceRequest.scope.text,
      ],
      hasSubject: true,
    },
    {
      label: "suggestion",
      request: requestForSubject("suggestion", suggestion),
      expected: [
        "Kind: suggestion",
        "File: chapters/suggestion.tex",
        "Range: [21, 33)",
        "Rationale:",
        "The replacement states the claim directly.",
        "Original:",
        "draft phrase",
        "Replacement:",
        "precise phrase",
        "## Source scope",
        "Selected text:",
      ],
      hasSubject: true,
    },
    {
      label: "selection scope",
      request: requestForSubject("scope-selection", {
        kind: "scope",
        sourceRequest: selectionSource,
      }),
      expected: [
        "Kind: scope",
        "Scope: selection",
        "File: chapters/selection-scope.tex",
        `Range: [101, ${101 + selectionText.length})`,
        "Selected text:",
        selectionText,
      ],
      hasSubject: true,
    },
    {
      label: "document scope",
      request: requestForSubject("scope-document", {
        kind: "scope",
        sourceRequest: documentSource,
      }),
      expected: [
        "Kind: scope",
        "Scope: document",
        "File: chapters/document-scope.tex",
        "Document text:",
        documentText,
      ],
      hasSubject: true,
    },
    {
      label: "project scope",
      request: requestForSubject("scope-project", {
        kind: "scope",
        sourceRequest: projectSource,
      }),
      expected: ["Kind: scope", "Scope: project"],
      hasSubject: true,
    },
    {
      label: "no subject",
      request: requestForSubject("open", null),
      expected: [],
      hasSubject: false,
    },
  ];
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
    finishReason: {
      unified: finishReason,
      raw: finishReason,
    },
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

function textStep(text, tokenUsage = usage()) {
  return streamResult([
    { type: "text-start", id: "discussion-text-0001" },
    {
      type: "text-delta",
      id: "discussion-text-0001",
      delta: text,
    },
    { type: "text-end", id: "discussion-text-0001" },
    finish("stop", tokenUsage),
  ]);
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
    readProjectFile: async () => {
      throw new Error("Discussion must not read project files.");
    },
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

describe("AI reviewer: discussion gateway", function () {
  it("streams an open discussion through the hardened model path without tools or a generation cap", async function () {
    const request = discussionRequest({ subject: null });
    const { model } = strictStreamModel([
      textStep("A response to the open question.", usage(5, 50_000)),
    ]);

    const events = await collect(
      createGateway(model).streamDiscussion(request),
    );

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "text.delta",
      "completed",
    ]);
    expect(events[1]).toMatchObject({
      requestId: "discussion-turn-0001",
      delta: "A response to the open question.",
    });
    expect(events[2]).toMatchObject({
      usage: {
        inputTokens: 5,
        outputTokens: 50_000,
      },
    });
    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0].maxOutputTokens).toBeUndefined();
    expect(model.doStreamCalls[0].responseFormat).toBeUndefined();
    expect(model.doStreamCalls[0].tools).toBeUndefined();
    expect(sentPrompt(model)).toBe(
      "## Conversation\n\nUser:\nWhy should this wording change?",
    );
  });

  it("streams free text through the hardened model path without a generation cap", async function () {
    const { model } = strictStreamModel([
      textStep("A concise discussion response.", usage(5, 50_000)),
    ]);
    const gateway = createGateway(model);

    const events = await collect(gateway.streamDiscussion(discussionRequest()));

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "text.delta",
      "completed",
    ]);
    expect(events[1]).toMatchObject({
      requestId: "discussion-turn-0001",
      delta: "A concise discussion response.",
    });
    expect(events[2]).toMatchObject({
      usage: {
        inputTokens: 5,
        outputTokens: 50_000,
      },
    });
    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0].maxOutputTokens).toBeUndefined();
    expect(model.doStreamCalls[0].responseFormat).toBeUndefined();
    expect(model.doStreamCalls[0].tools).toEqual([
      expect.objectContaining({
        type: "function",
        name: "propose_suggestion",
      }),
    ]);
    expect(model.doStreamCalls[0].prompt[0].content).toContain(
      "Do not start, claim to start, or simulate a review run.",
    );
    expect(sentPrompt(model)).toContain(
      "## Conversation\n\nUser:\nWhy should this wording change?",
    );
  });

  it.each(discussionPromptCases())(
    "sends readable $label context without transport metadata",
    async ({ request, expected, hasSubject }) => {
      const { model } = strictStreamModel([textStep("Readable response.")]);

      await collect(createGateway(model).streamDiscussion(request));

      const prompt = sentPrompt(model);
      expect(prompt).toContain("## Conversation");
      if (hasSubject) {
        expect(prompt).toContain("## Subject");
      } else {
        expect(prompt).not.toContain("## Subject");
      }
      for (const fragment of expected) {
        expect(prompt).toContain(fragment);
      }
      for (const value of internalPromptValues(request)) {
        expect(prompt).not.toContain(value);
      }
      for (const wireKey of [
        "sourceRequest",
        "requestId",
        "discussionId",
        "projectId",
        "documentId",
        "artifactKind",
        "baseRevision",
        "baseTextHash",
        "revision",
        "textHash",
        "suggestionIds",
        "provider",
        "model",
        "createdAt",
        "status",
      ]) {
        expect(prompt).not.toContain(wireKey);
      }
      let previousTurn = -1;
      for (const turn of request.turns) {
        const renderedTurn = `${
          turn.role === "user" ? "User" : "Assistant"
        }:\n${turn.text}`;
        const turnPosition = prompt.indexOf(renderedTurn);
        expect(turnPosition).toBeGreaterThan(previousTurn);
        previousTurn = turnPosition;
      }
      expect(prompt).not.toContain('"role"');
      expect(prompt).not.toContain('"turns"');
    },
  );

  it("keeps all 12 bounded turns in conversational order and rejects a thirteenth", async function () {
    const turns = Array.from(
      { length: DISCUSSION_CONTEXT_TURN_LIMIT },
      (_, index) => ({
        role: index % 2 === 0 ? "assistant" : "user",
        text: `Bounded turn ${index + 1}.`,
      }),
    );
    const request = discussionRequest({ subject: null, turns });
    const { model } = strictStreamModel([textStep("All turns received.")]);

    await collect(createGateway(model).streamDiscussion(request));

    expect(DISCUSSION_CONTEXT_TURN_LIMIT).toBe(12);
    const prompt = sentPrompt(model);
    let previousTurn = -1;
    for (const turn of turns) {
      const renderedTurn = `${
        turn.role === "user" ? "User" : "Assistant"
      }:\n${turn.text}`;
      const turnPosition = prompt.indexOf(renderedTurn);
      expect(turnPosition).toBeGreaterThan(previousTurn);
      previousTurn = turnPosition;
    }

    const { model: overLimitModel } = strictStreamModel([
      textStep("Must not run."),
    ]);
    expect(
      await captureError(
        collect(
          createGateway(overLimitModel).streamDiscussion({
            ...request,
            turns: [...turns, { role: "user", text: "Turn 13." }],
          }),
        ),
      ),
    ).toMatchObject({
      code: "AI_DISCUSSION_REQUEST_SCHEMA_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(overLimitModel.doStreamCalls).toHaveLength(0);
  });

  it("derives the discussion prompt budget from the configured context length", async function () {
    const request = discussionRequest({
      subject: null,
      turns: [{ role: "user", text: "x".repeat(1_200) }],
    });
    const { model: smallModel } = strictStreamModel([
      textStep("Must not run."),
    ]);
    const { model: largeModel } = strictStreamModel([textStep("Fits.")]);

    expect(
      await captureError(
        collect(
          createGateway(smallModel, {
            contextLength: 2_048,
          }).streamDiscussion(request),
        ),
      ),
    ).toMatchObject({
      code: "AI_PROJECT_CONTENT_NOT_AVAILABLE",
      category: "configuration",
      retryable: false,
    });
    expect(smallModel.doStreamCalls).toHaveLength(0);

    const events = await collect(
      createGateway(largeModel, {
        contextLength: 8_192,
      }).streamDiscussion(request),
    );
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      finishReason: "stop",
    });
    expect(largeModel.doStreamCalls).toHaveLength(1);
  });

  it("measures the budget against the exact readable prompt sent to the provider", async function () {
    const request = requestForSubject("budget", findingSubject("finding"));
    const { model: captureModel } = strictStreamModel([
      textStep("Capture the readable prompt."),
    ]);

    await collect(createGateway(captureModel).streamDiscussion(request));

    const readablePrompt = sentPrompt(captureModel);
    expect(readablePrompt).not.toBe(
      JSON.stringify({ subject: request.subject, turns: request.turns }),
    );
    const exactContextLength = readablePrompt.length * 2;
    const shortContextLength = (readablePrompt.length - 1) * 2;
    expect(modelInputCharacterBudget(exactContextLength)).toBe(
      readablePrompt.length,
    );
    expect(modelInputCharacterBudget(shortContextLength)).toBe(
      readablePrompt.length - 1,
    );

    const { model: shortModel } = strictStreamModel([
      textStep("Must not run."),
    ]);
    expect(
      await captureError(
        collect(
          createGateway(shortModel, {
            contextLength: shortContextLength,
          }).streamDiscussion(request),
        ),
      ),
    ).toMatchObject({
      code: "AI_PROJECT_CONTENT_NOT_AVAILABLE",
      category: "configuration",
      retryable: false,
    });
    expect(shortModel.doStreamCalls).toHaveLength(0);

    const { model: exactModel } = strictStreamModel([
      textStep("Exact prompt fits."),
    ]);
    await collect(
      createGateway(exactModel, {
        contextLength: exactContextLength,
      }).streamDiscussion(request),
    );
    expect(sentPrompt(exactModel)).toBe(readablePrompt);
  });

  it("emits a discussion suggestion bound to the source review request", async function () {
    const draft = {
      path: "main.tex",
      range: { from: 0, to: 4 },
      original: "Text",
      replacement: "Edit",
      rationale: "The replacement is more direct.",
      evidence: [
        {
          path: "main.tex",
          range: { from: 0, to: 4 },
        },
      ],
    };
    const toolStep = streamResult([
      {
        type: "tool-call",
        toolCallId: "discussion-tool-0001",
        toolName: "propose_suggestion",
        input: JSON.stringify(draft),
      },
      finish("tool-calls"),
    ]);
    const { model, consumed } = strictStreamModel([toolStep]);

    const events = await collect(
      createGateway(model).streamDiscussion(discussionRequest()),
    );

    expect(events.map((event) => event.type)).toEqual([
      "started",
      "suggestion",
      "completed",
    ]);
    expect(events[1]).toMatchObject({
      requestId: "discussion-turn-0001",
      suggestion: {
        ...draft,
        documentId: "document-discussion-0001",
        baseRevision: 7,
        baseTextHash: contentHash,
        evidence: [
          {
            ...draft.evidence[0],
            revision: 7,
            textHash: contentHash,
          },
        ],
        requestId: "source-request-0001",
        projectId: "project-discussion-0001",
        provider: "fixture-provider",
        model: "fixture-model",
        skill: "line-edit",
        status: "unresolved",
      },
    });
    expect(consumed()).toBe(1);
    const serializedTools = JSON.stringify(model.doStreamCalls[0].tools);
    expect(serializedTools).toContain('"path"');
    expect(serializedTools).toContain('"range"');
    for (const internalField of [
      "id",
      "requestId",
      "discussionId",
      "projectId",
      "artifactId",
      "documentId",
      "baseRevision",
      "baseTextHash",
      "revision",
      "textHash",
    ]) {
      expect(serializedTools).not.toContain(`"${internalField}"`);
    }
  });

  it("rejects a discussion suggestion outside the source request scope", async function () {
    const toolStep = streamResult([
      {
        type: "tool-call",
        toolCallId: "discussion-tool-outside",
        toolName: "propose_suggestion",
        input: JSON.stringify({
          path: "other.tex",
          range: { from: 0, to: 4 },
          original: "Text",
          replacement: "Edit",
          rationale: "Synthetic rationale.",
          evidence: [
            {
              path: "other.tex",
              range: { from: 0, to: 4 },
            },
          ],
        }),
      },
      finish("tool-calls"),
    ]);
    const { model } = strictStreamModel([toolStep]);

    expect(
      await captureError(
        collect(createGateway(model).streamDiscussion(discussionRequest())),
      ),
    ).toMatchObject({
      code: "AI_EVENT_EVIDENCE_SCOPE_MISMATCH",
      category: "schema",
      retryable: false,
    });
  });

  it("does not expose the suggestion tool for a project-scope discussion", async function () {
    const projectSource = sourceRequest({
      action: "review",
      instruction: "Review the project.",
      skill: "referee-review",
      scope: { kind: "project" },
    });
    const request = discussionRequest({
      subject: {
        kind: "scope",
        sourceRequest: projectSource,
      },
    });
    const { model } = strictStreamModel([textStep("Project discussion only.")]);

    await collect(createGateway(model).streamDiscussion(request));

    expect(model.doStreamCalls).toHaveLength(1);
    expect(model.doStreamCalls[0].tools).toBeUndefined();
  });
});
