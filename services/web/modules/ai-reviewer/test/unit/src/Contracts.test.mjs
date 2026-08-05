import { describe, expect, it } from "vitest";

import {
  AgentEventSchema,
  AgentRequestSchema,
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
