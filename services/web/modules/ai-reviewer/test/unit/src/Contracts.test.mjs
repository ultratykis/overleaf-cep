import { describe, expect, it } from "vitest";

import {
  AI_REVIEWER_WORKSPACE_DISCUSSION_LIMIT,
  AI_REVIEWER_WORKSPACE_TURN_LIMIT,
  AgentEventSchema,
  AgentRequestSchema,
  AiReviewerWorkspaceSchema,
  DISCUSSION_CONTEXT_TURN_LIMIT,
  DiscussionSubjectSchema,
  FindingSchema,
  SuggestionSchema,
  SuggestionStatusSchema,
  WorkspaceFindingSchema,
  WorkspaceFindingStatusSchema,
} from "../../../shared/contracts.mjs";

const hash = "a".repeat(64);
const createdAt = "2026-07-24T00:00:00.000Z";

function selectionRequest() {
  return {
    requestId: "request-0001",
    projectId: "project-0001",
    action: "review",
    instruction: "Check the selected synthetic sentence.",
    skill: "line-edit",
    scope: {
      kind: "selection",
      documentId: "document-0001",
      path: "chapters/introduction.tex",
      baseRevision: 12,
      baseTextHash: hash,
      range: { from: 0, to: 15 },
      text: "Synthetic text.",
    },
  };
}

function suggestion() {
  return {
    id: "suggestion-0001",
    requestId: "request-0001",
    projectId: "project-0001",
    documentId: "document-0001",
    path: "chapters/introduction.tex",
    baseRevision: 12,
    baseTextHash: hash,
    range: { from: 0, to: 15 },
    original: "Synthetic text.",
    replacement: "Revised text.",
    rationale: "The shorter wording is clearer.",
    evidence: [
      {
        path: "chapters/introduction.tex",
        range: { from: 0, to: 15 },
        revision: 12,
        textHash: hash,
      },
    ],
    provider: "fake",
    model: "deterministic-v1",
    skill: "line-edit",
    createdAt,
    status: "unresolved",
  };
}

function finding(overrides = {}) {
  return {
    id: "finding-0001",
    requestId: "request-0001",
    projectId: "project-0001",
    severity: "warning",
    category: "synthetic",
    title: "Synthetic finding",
    message: "A deterministic finding.",
    evidence: [
      {
        path: "chapters/introduction.tex",
        range: { from: 0, to: 15 },
        revision: 12,
        textHash: hash,
      },
    ],
    suggestionIds: [],
    artifactKind: "finding",
    ...overrides,
  };
}

function conversationRequest(overrides = {}) {
  const { scope, ...request } = selectionRequest();
  return {
    ...request,
    requestId: "conversation-turn-0001",
    skill: null,
    instruction: "Explain this finding.",
    ...overrides,
  };
}

function workspace() {
  const request = selectionRequest();
  return {
    runs: [
      {
        generation: 1,
        createdOrder: 1,
        request,
        text: "A stored review summary.",
        findings: [
          {
            artifact: finding(),
            status: "unresolved",
          },
        ],
        suggestions: [
          {
            artifact: suggestion(),
          },
        ],
      },
    ],
    discussions: [
      {
        id: "discussion-0001",
        createdOrder: 2,
        subjectKey: "1:finding:finding-0001",
        subject: {
          kind: "finding",
          sourceRequest: request,
          artifact: finding(),
        },
        sourceGeneration: 1,
        turns: [
          { role: "user", text: "Explain this finding." },
          { role: "assistant", text: "A stored explanation." },
        ],
        suggestions: [],
        updatedAt: createdAt,
      },
    ],
  };
}

describe("AI reviewer: runtime contracts", function () {
  it("accepts a strict selection request", function () {
    expect(AgentRequestSchema.parse(selectionRequest())).toEqual(
      selectionRequest(),
    );
  });

  it.each([
    "/absolute.tex",
    "../secret.tex",
    "chapters/../../secret.tex",
    "chapters\\secret.tex",
    "chapters//secret.tex",
    "C:/secret.tex",
    "chapters/%2e%2e/secret.tex",
  ])("rejects unsafe project path %s", function (unsafePath) {
    const request = selectionRequest();
    request.scope.path = unsafePath;

    expect(AgentRequestSchema.safeParse(request).success).toBe(false);
  });

  it("requires selection offsets to match the original text", function () {
    const invalid = suggestion();
    invalid.range = { from: 0, to: 14 };

    expect(SuggestionSchema.safeParse(invalid).success).toBe(false);
  });

  it("uses the exact persisted suggestion status vocabulary", function () {
    expect(SuggestionStatusSchema.options).toEqual([
      "unresolved",
      "applied",
      "discarded",
      "conflict",
      "posted",
    ]);
  });

  it("uses the exact persisted finding status vocabulary", function () {
    expect(WorkspaceFindingStatusSchema.options).toEqual([
      "unresolved",
      "discarded",
      "posted",
    ]);
  });

  it("requires evidence to carry a verifiable anchor", function () {
    const invalid = suggestion();
    invalid.evidence = [{ path: "chapters/introduction.tex" }];

    expect(SuggestionSchema.safeParse(invalid).success).toBe(false);
  });

  it("accepts ordinary and citation findings as distinct artifact kinds", function () {
    const ordinary = finding();
    const citation = finding({
      artifactKind: "citation-finding",
      proposedText: "Add a synthetic bibliography entry.",
    });

    expect(FindingSchema.parse(ordinary)).toEqual(ordinary);
    expect(FindingSchema.parse(citation)).toEqual(citation);
  });

  it("allows only ordinary findings to carry the posted status", function () {
    const ordinary = {
      artifact: finding(),
      status: "posted",
    };
    const citation = {
      artifact: finding({
        artifactKind: "citation-finding",
        proposedText: "Add a synthetic bibliography entry.",
      }),
      status: "posted",
    };

    expect(WorkspaceFindingSchema.parse(ordinary)).toEqual(ordinary);
    expect(WorkspaceFindingSchema.safeParse(citation).success).toBe(false);
  });

  it.each([
    {
      name: "missing artifact discriminator",
      finding: (() => {
        const { artifactKind, ...withoutArtifactKind } = finding();
        return withoutArtifactKind;
      })(),
    },
    {
      name: "ordinary finding with proposed text",
      finding: finding({
        proposedText: "An ordinary finding cannot copy text.",
      }),
    },
    {
      name: "citation finding without proposed text",
      finding: finding({ artifactKind: "citation-finding" }),
    },
    {
      name: "citation finding with empty proposed text",
      finding: finding({
        artifactKind: "citation-finding",
        proposedText: "",
      }),
    },
  ])("rejects $name", function ({ finding: invalid }) {
    expect(FindingSchema.safeParse(invalid).success).toBe(false);
  });

  it("rejects unknown suggestion fields", function () {
    const invalid = { ...suggestion(), writeDocument: true };

    expect(SuggestionSchema.safeParse(invalid).success).toBe(false);
  });

  it("requires every suggestion to identify the skill that produced it", function () {
    const invalid = { ...suggestion(), skill: null };

    expect(SuggestionSchema.safeParse(invalid).success).toBe(false);
  });

  it("validates discriminated streamed events", function () {
    const event = {
      type: "suggestion",
      eventId: "event-0002",
      requestId: "request-0001",
      sequence: 1,
      createdAt,
      suggestion: suggestion(),
    };

    expect(AgentEventSchema.parse(event)).toEqual(event);
    expect(
      AgentEventSchema.safeParse({ ...event, type: "unknown" }).success,
    ).toBe(false);
  });

  it("rejects an event whose nested payload belongs to another request", function () {
    const event = {
      type: "suggestion",
      eventId: "event-0002",
      requestId: "request-0001",
      sequence: 1,
      createdAt,
      suggestion: {
        ...suggestion(),
        requestId: "request-0002",
      },
    };

    expect(AgentEventSchema.safeParse(event).success).toBe(false);
  });

  it("allows only unresolved suggestions in provider events", function () {
    const applied = {
      ...suggestion(),
      status: "applied",
    };
    const event = {
      type: "suggestion",
      eventId: "event-0002",
      requestId: "request-0001",
      sequence: 1,
      createdAt,
      suggestion: applied,
    };

    expect(SuggestionSchema.safeParse(applied).success).toBe(true);
    expect(AgentEventSchema.safeParse(event).success).toBe(false);
  });

  it("accepts the Zotero search tool with its strict typed query", function () {
    const event = {
      type: "tool.call",
      eventId: "event-0003",
      requestId: "request-0001",
      sequence: 1,
      createdAt,
      call: {
        id: "call-0002",
        name: "search_zotero",
        arguments: { query: "greenwade" },
      },
    };

    expect(AgentEventSchema.parse(event)).toEqual(event);
  });

  it("accepts the known read tool with strict typed arguments", function () {
    const event = {
      type: "tool.call",
      eventId: "event-0002",
      requestId: "request-0001",
      sequence: 1,
      createdAt,
      call: {
        id: "call-0001",
        name: "read_project_file",
        arguments: {
          path: "chapters/introduction.tex",
          range: { from: 0, to: 15 },
        },
      },
    };

    expect(AgentEventSchema.parse(event)).toEqual(event);
  });

  it("accepts a short streamed review subject", function () {
    const event = {
      type: "subject",
      eventId: "event-subject-0001",
      requestId: "request-0001",
      sequence: 1,
      createdAt,
      subject: "Claim support in chapter 3",
    };

    expect(AgentEventSchema.parse(event)).toEqual(event);
  });

  it("carries a bounded conversation history on one review request", function () {
    const turns = Array.from(
      { length: DISCUSSION_CONTEXT_TURN_LIMIT },
      (_, index) => ({
        role: index % 2 === 0 ? "assistant" : "user",
        text: `Turn ${index}`,
      }),
    );
    const request = conversationRequest({ turns });

    expect(AgentRequestSchema.parse(request)).toEqual(request);
    expect(
      AgentRequestSchema.safeParse({
        ...request,
        turns: [...turns, { role: "user", text: "One turn too many." }],
      }).success,
    ).toBe(false);
  });

  it("accepts a current-document fact without making it scope", function () {
    const request = conversationRequest({
      currentDocumentPath: "chapters/introduction.tex",
    });

    expect(AgentRequestSchema.parse(request)).toEqual(request);
    expect(request.currentDocumentPath).toBe("chapters/introduction.tex");
    expect(request).not.toHaveProperty("scope");
    expect(request).not.toHaveProperty("turns");
  });

  it("accepts only a bounded external Agent session identifier", function () {
    const request = conversationRequest({ agentSessionId: "discussion-0001" });

    expect(AgentRequestSchema.parse(request)).toEqual(request);
    expect(
      AgentRequestSchema.safeParse(conversationRequest({ agentSessionId: "" }))
        .success,
    ).toBe(false);
    expect(
      AgentRequestSchema.safeParse(
        conversationRequest({ agentSessionId: "x".repeat(201) }),
      ).success,
    ).toBe(false);
  });

  it("rejects an unsafe current-document fact", function () {
    expect(
      AgentRequestSchema.safeParse(
        conversationRequest({ currentDocumentPath: "../secret.tex" }),
      ).success,
    ).toBe(false);
  });

  it("keeps editor-action fields on the same request", function () {
    const request = conversationRequest({
      ...selectionRequest(),
      skill: "referee-review",
      turns: [{ role: "user", text: "An earlier question." }],
    });

    expect(AgentRequestSchema.parse(request)).toEqual(request);
  });

  it.each([
    ["finding", { kind: "finding", artifact: finding() }],
    [
      "citation finding",
      {
        kind: "citation-finding",
        artifact: finding({
          artifactKind: "citation-finding",
          proposedText: "Add a synthetic bibliography entry.",
        }),
      },
    ],
    ["suggestion", { kind: "suggestion", artifact: suggestion() }],
    ["review scope", { kind: "scope" }],
  ])("accepts a %s discussion subject", function (_label, subject) {
    const bound = { ...subject, sourceRequest: selectionRequest() };

    expect(DiscussionSubjectSchema.parse(bound)).toEqual(bound);
  });

  it("does not impose a fixed character cap on an individual turn", function () {
    const request = conversationRequest({
      turns: [{ role: "user", text: "x".repeat(25_000) }],
    });

    expect(AgentRequestSchema.safeParse(request).success).toBe(true);
  });

  it("accepts a strict persisted review workspace", function () {
    const stored = workspace();
    stored.runs[0].subject = "Persisted claim support";

    expect(AiReviewerWorkspaceSchema.parse(stored)).toEqual(stored);
  });

  it("accepts posted ordinary findings and suggestions in a workspace", function () {
    const stored = workspace();
    stored.runs[0].findings[0].status = "posted";
    stored.runs[0].suggestions[0].artifact.status = "posted";

    expect(AiReviewerWorkspaceSchema.parse(stored)).toEqual(stored);
  });

  it("accepts an open persisted discussion without a source run", function () {
    const firstDiscussion = {
      id: "open-discussion-0001",
      createdOrder: 1,
      subjectKey: null,
      subject: null,
      sourceGeneration: null,
      turns: [
        { role: "user", text: "What should I clarify?" },
        { role: "assistant", text: "Clarify the central claim." },
      ],
      suggestions: [],
      updatedAt: createdAt,
    };
    const stored = {
      runs: [],
      discussions: [
        firstDiscussion,
        {
          ...firstDiscussion,
          id: "open-discussion-0002",
          createdOrder: 2,
          turns: [{ role: "user", text: "A separate open question." }],
        },
      ],
    };

    expect(AiReviewerWorkspaceSchema.parse(stored)).toEqual(stored);
  });

  it("keeps open discussion bindings null and binds Agent suggestions to their turn", function () {
    const openDiscussion = {
      id: "open-discussion-invalid",
      createdOrder: 1,
      subjectKey: null,
      subject: null,
      sourceGeneration: null,
      turns: [{ role: "user", text: "A general question." }],
      suggestions: [],
      updatedAt: createdAt,
    };

    expect(
      AiReviewerWorkspaceSchema.safeParse({
        runs: [],
        discussions: [
          {
            ...openDiscussion,
            subjectKey: "open-discussion-invalid",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      AiReviewerWorkspaceSchema.safeParse({
        runs: [],
        discussions: [
          {
            ...openDiscussion,
            suggestions: [{ artifact: suggestion() }],
          },
        ],
      }).success,
    ).toBe(false);

    const sourceRequest = conversationRequest({
      requestId: "agent-turn-0001",
      projectId: "project-0001",
      skill: "line-edit",
      agentSessionId: openDiscussion.id,
      scope: {
        kind: "document",
        documentId: "document-0001",
        path: "chapters/introduction.tex",
        baseRevision: 12,
        baseTextHash: hash,
        text: "Synthetic text.",
      },
    });
    const artifact = { ...suggestion(), requestId: sourceRequest.requestId };
    const bound = {
      ...openDiscussion,
      suggestions: [{ artifact, sourceRequest }],
    };
    expect(
      AiReviewerWorkspaceSchema.safeParse({ runs: [], discussions: [bound] })
        .success,
    ).toBe(true);
    expect(
      AiReviewerWorkspaceSchema.safeParse({
        runs: [],
        discussions: [
          {
            ...bound,
            suggestions: [
              {
                artifact,
                sourceRequest: {
                  ...sourceRequest,
                  agentSessionId: "another-discussion",
                },
              },
            ],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("binds persisted artifacts and discussions to their source run", function () {
    const crossProjectArtifact = workspace();
    crossProjectArtifact.runs[0].findings[0].artifact.projectId =
      "another-project";
    const missingSourceRun = workspace();
    missingSourceRun.discussions[0].subject.sourceRequest.requestId =
      "another-request";
    const crossRequestSubject = workspace();
    crossRequestSubject.discussions[0].subject.artifact.requestId =
      "another-request";

    expect(
      AiReviewerWorkspaceSchema.safeParse(crossProjectArtifact).success,
    ).toBe(false);
    expect(AiReviewerWorkspaceSchema.safeParse(missingSourceRun).success).toBe(
      false,
    );
    expect(
      AiReviewerWorkspaceSchema.safeParse(crossRequestSubject).success,
    ).toBe(false);
  });

  it("bounds stored discussions without dropping an older discussion", function () {
    const stored = workspace();
    stored.discussions = Array.from(
      { length: AI_REVIEWER_WORKSPACE_DISCUSSION_LIMIT + 1 },
      (_, index) => ({
        ...stored.discussions[0],
        id: `discussion-${index}`,
        createdOrder: index + 2,
        subjectKey: `subject-${index}`,
      }),
    );

    const parsed = AiReviewerWorkspaceSchema.safeParse(stored);

    expect(parsed.success).toBe(false);
    expect(stored.discussions).toHaveLength(
      AI_REVIEWER_WORKSPACE_DISCUSSION_LIMIT + 1,
    );
  });

  it("bounds stored turns separately from model discussion context", function () {
    const stored = workspace();
    stored.discussions[0].turns = Array.from(
      { length: AI_REVIEWER_WORKSPACE_TURN_LIMIT + 1 },
      (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        text: `Stored turn ${index}`,
      }),
    );

    expect(AiReviewerWorkspaceSchema.safeParse(stored).success).toBe(false);
    expect(AI_REVIEWER_WORKSPACE_TURN_LIMIT).toBeGreaterThan(
      DISCUSSION_CONTEXT_TURN_LIMIT,
    );
  });

  it.each([
    {
      name: "provider permission",
      call: {
        id: "call-0001",
        name: "read_project_file",
        permission: "read",
        arguments: { path: "main.tex" },
      },
    },
    {
      name: "unknown tool",
      call: {
        id: "call-0001",
        name: "write_project_file",
        arguments: { path: "main.tex", content: "untrusted" },
      },
    },
    {
      name: "unsafe tool path",
      call: {
        id: "call-0001",
        name: "read_project_file",
        arguments: { path: "../secret.tex" },
      },
    },
    {
      name: "unexpected tool argument",
      call: {
        id: "call-0001",
        name: "read_project_file",
        arguments: { path: "main.tex", includeSecrets: true },
      },
    },
  ])("rejects $name", function ({ call }) {
    const event = {
      type: "tool.call",
      eventId: "event-0002",
      requestId: "request-0001",
      sequence: 1,
      createdAt,
      call,
    };

    expect(AgentEventSchema.safeParse(event).success).toBe(false);
  });
});
