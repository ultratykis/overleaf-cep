import { describe, expect, it } from "vitest";

import {
  AgentEventSchema,
  AgentRequestSchema,
  DISCUSSION_CONTEXT_TURN_LIMIT,
  DiscussionEventSchema,
  DiscussionRequestSchema,
  FindingSchema,
  SuggestionSchema,
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
    status: "proposed",
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

function discussionRequest(overrides = {}) {
  const sourceRequest = selectionRequest();
  return {
    requestId: "discussion-turn-0001",
    discussionId: "discussion-0001",
    projectId: sourceRequest.projectId,
    subject: {
      kind: "finding",
      sourceRequest,
      artifact: finding(),
    },
    turns: [{ role: "user", text: "Explain this finding." }],
    ...overrides,
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

  it("allows only proposed suggestions in provider events", function () {
    const accepted = {
      ...suggestion(),
      status: "accepted",
    };
    const event = {
      type: "suggestion",
      eventId: "event-0002",
      requestId: "request-0001",
      sequence: 1,
      createdAt,
      suggestion: accepted,
    };

    expect(SuggestionSchema.safeParse(accepted).success).toBe(true);
    expect(AgentEventSchema.safeParse(event).success).toBe(false);
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

  it("accepts only subject-bound discussions with bounded recent turns", function () {
    const turns = Array.from(
      { length: DISCUSSION_CONTEXT_TURN_LIMIT },
      (_, index) => ({
        role: index % 2 === 0 ? "assistant" : "user",
        text: `Turn ${index}`,
      }),
    );
    const request = discussionRequest({ turns });

    expect(DiscussionRequestSchema.parse(request)).toEqual(request);
    expect(
      DiscussionRequestSchema.safeParse({
        ...request,
        turns: [...turns, { role: "user", text: "One turn too many." }],
      }).success,
    ).toBe(false);
    expect(
      DiscussionRequestSchema.safeParse({
        ...request,
        turns: [{ role: "assistant", text: "Missing the active user turn." }],
      }).success,
    ).toBe(false);
    const { subject, ...withoutSubject } = request;
    expect(DiscussionRequestSchema.safeParse(withoutSubject).success).toBe(
      false,
    );
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
    const sourceRequest = selectionRequest();
    const request = discussionRequest({
      subject: {
        ...subject,
        sourceRequest,
      },
    });

    expect(DiscussionRequestSchema.parse(request)).toEqual(request);
  });

  it("does not impose a fixed character cap on an individual discussion turn", function () {
    const request = discussionRequest({
      turns: [{ role: "user", text: "x".repeat(25_000) }],
    });

    expect(DiscussionRequestSchema.safeParse(request).success).toBe(true);
  });

  it("binds discussion subjects to their source request", function () {
    const request = discussionRequest();

    expect(
      DiscussionRequestSchema.safeParse({
        ...request,
        projectId: "another-project",
      }).success,
    ).toBe(false);
    expect(
      DiscussionRequestSchema.safeParse({
        ...request,
        subject: {
          ...request.subject,
          artifact: finding({ requestId: "another-request" }),
        },
      }).success,
    ).toBe(false);
  });

  it("accepts discussion events whose envelope is distinct from a source suggestion", function () {
    const event = {
      type: "suggestion",
      eventId: "discussion-event-0001",
      requestId: "discussion-turn-0001",
      sequence: 1,
      createdAt,
      suggestion: suggestion(),
    };

    expect(DiscussionEventSchema.parse(event)).toEqual(event);
  });

  it("does not impose a fixed character cap on discussion text output", function () {
    const event = {
      type: "text.delta",
      eventId: "discussion-event-long-text",
      requestId: "discussion-turn-0001",
      sequence: 1,
      createdAt,
      delta: "x".repeat(125_000),
    };

    expect(DiscussionEventSchema.safeParse(event).success).toBe(true);
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
