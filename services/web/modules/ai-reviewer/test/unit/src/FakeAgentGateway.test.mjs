import { describe, expect, it } from "vitest";

import {
  AgentGatewayAbortError,
  ScriptedFakeAgentGateway,
} from "../../../app/src/AgentGateway.mjs";

const createdAt = "2026-07-24T00:00:00.000Z";

function request() {
  return {
    requestId: "request-0001",
    projectId: "project-0001",
    action: "review",
    instruction: "Review the synthetic project.",
    skill: "referee-review",
    scope: {
      kind: "project",
    },
  };
}

function startedEvent(skill = "referee-review") {
  return {
    type: "started",
    eventId: "event-0001",
    requestId: "request-0001",
    sequence: 0,
    createdAt,
    provider: "fake",
    model: "deterministic-v1",
    skill,
  };
}

function events() {
  return [
    startedEvent(),
    {
      type: "text.delta",
      eventId: "event-0002",
      requestId: "request-0001",
      sequence: 1,
      createdAt,
      delta: "Synthetic review.",
    },
    {
      type: "completed",
      eventId: "event-0003",
      requestId: "request-0001",
      sequence: 2,
      createdAt,
      finishReason: "stop",
      usage: {
        inputTokens: 12,
        outputTokens: 3,
      },
    },
  ];
}

function selectionRequest() {
  return {
    ...request(),
    instruction: "Review the selected synthetic text.",
    skill: "line-edit",
    scope: {
      kind: "selection",
      documentId: "document-0001",
      path: "main.tex",
      baseRevision: 1,
      baseTextHash: "a".repeat(64),
      range: { from: 0, to: 4 },
      text: "Text",
    },
  };
}

function documentRequest() {
  return {
    ...request(),
    instruction: "Review the synthetic document.",
    skill: "line-edit",
    scope: {
      kind: "document",
      documentId: "document-0001",
      path: "main.tex",
      baseRevision: 1,
      baseTextHash: "a".repeat(64),
      text: "Text",
    },
  };
}

function suggestionEvent(overrides = {}) {
  return {
    type: "suggestion",
    eventId: "event-0002",
    requestId: "request-0001",
    sequence: 1,
    createdAt,
    suggestion: {
      id: "suggestion-0001",
      requestId: "request-0001",
      projectId: "project-0001",
      documentId: "document-0001",
      path: "main.tex",
      baseRevision: 1,
      baseTextHash: "a".repeat(64),
      range: { from: 0, to: 4 },
      original: "Text",
      replacement: "Edit",
      rationale: "Synthetic rationale.",
      evidence: [
        {
          path: "main.tex",
          range: { from: 0, to: 4 },
          revision: 1,
          textHash: "a".repeat(64),
        },
      ],
      provider: "fake",
      model: "deterministic-v1",
      skill: "line-edit",
      createdAt,
      status: "unresolved",
      ...overrides,
    },
  };
}

function findingEvent(evidence) {
  return {
    type: "finding",
    eventId: "event-0002",
    requestId: "request-0001",
    sequence: 1,
    createdAt,
    finding: {
      artifactKind: "finding",
      id: "finding-0001",
      requestId: "request-0001",
      projectId: "project-0001",
      severity: "warning",
      category: "synthetic",
      title: "Synthetic finding",
      message: "Synthetic finding message.",
      evidence,
      suggestionIds: [],
    },
  };
}

function toolCallEvent(arguments_) {
  return {
    type: "tool.call",
    eventId: "event-0002",
    requestId: "request-0001",
    sequence: 1,
    createdAt,
    call: {
      id: "tool-call-0001",
      name: "read_project_file",
      arguments: arguments_,
    },
  };
}

async function collect(stream) {
  const collected = [];
  for await (const event of stream) {
    collected.push(event);
  }
  return collected;
}

async function captureError(work) {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to fail.");
}

describe("AI reviewer: deterministic fake gateway", function () {
  it("emits the configured typed events without time or random input", async function () {
    const gateway = new ScriptedFakeAgentGateway({ events: events() });

    expect(await collect(gateway.stream(request()))).toEqual(events());
    expect(gateway.calls).toEqual([request()]);
    expect(gateway.emittedEventCount).toBe(3);
  });

  it("rejects an event belonging to another request", async function () {
    const invalidEvents = events();
    invalidEvents[1] = {
      ...invalidEvents[1],
      requestId: "request-0002",
    };
    const gateway = new ScriptedFakeAgentGateway({ events: invalidEvents });

    let caught;
    try {
      await collect(gateway.stream(request()));
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: "AI_EVENT_REQUEST_MISMATCH",
      category: "schema",
      retryable: false,
    });
  });

  it("rejects a suggestion belonging to another project", async function () {
    const invalidEvents = [
      events()[0],
      suggestionEvent({ projectId: "project-0002" }),
    ];
    const gateway = new ScriptedFakeAgentGateway({ events: invalidEvents });

    let caught;
    try {
      await collect(gateway.stream(request()));
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: "AI_EVENT_PROJECT_MISMATCH",
      category: "schema",
      retryable: false,
    });
  });

  it("classifies invalid requests as non-retryable schema errors", async function () {
    const gateway = new ScriptedFakeAgentGateway({ events: events() });
    const invalidRequest = {
      ...request(),
      unexpected: true,
    };

    let caught;
    try {
      await collect(gateway.stream(invalidRequest));
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: "AI_REQUEST_SCHEMA_INVALID",
      category: "schema",
      retryable: false,
    });
  });

  it.each([
    ["documentId", "document-0002"],
    ["path", "sections/other.tex"],
    ["baseRevision", 2],
    ["baseTextHash", "b".repeat(64)],
  ])(
    "binds selection suggestions to the request %s",
    async function (field, value) {
      const gateway = new ScriptedFakeAgentGateway({
        events: [
          startedEvent("line-edit"),
          suggestionEvent({ [field]: value }),
        ],
      });

      let caught;
      try {
        await collect(gateway.stream(selectionRequest()));
      } catch (error) {
        caught = error;
      }

      expect(caught).toMatchObject({
        code: "AI_EVENT_SCOPE_MISMATCH",
        category: "schema",
        retryable: false,
      });
    },
  );

  it("binds document suggestions to the requested document", async function () {
    const gateway = new ScriptedFakeAgentGateway({
      events: [
        startedEvent("line-edit"),
        suggestionEvent({ documentId: "document-0002" }),
      ],
    });

    let caught;
    try {
      await collect(gateway.stream(documentRequest()));
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: "AI_EVENT_SCOPE_MISMATCH",
      category: "schema",
      retryable: false,
    });
  });

  it.each([
    ["range outside the selection", { range: { from: 4, to: 8 } }],
    ["original text mismatch", { original: "Else" }],
  ])("rejects a selection suggestion with %s", async function (_name, patch) {
    const gateway = new ScriptedFakeAgentGateway({
      events: [startedEvent("line-edit"), suggestionEvent(patch)],
    });

    let caught;
    try {
      await collect(gateway.stream(selectionRequest()));
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      code: "AI_EVENT_SCOPE_MISMATCH",
      category: "schema",
      retryable: false,
    });
  });

  it("rejects a suggestion from a project review", async function () {
    const crossFile = suggestionEvent({
      documentId: "document-0002",
      path: "sections/other.tex",
      baseRevision: 7,
      baseTextHash: "b".repeat(64),
      skill: "referee-review",
    });
    const gateway = new ScriptedFakeAgentGateway({
      events: [events()[0], crossFile],
    });

    const caught = await captureError(collect(gateway.stream(request())));

    expect(caught).toMatchObject({
      code: "AI_PROJECT_SUGGESTION_NOT_ALLOWED",
      category: "schema",
      retryable: false,
    });
  });

  it.each([
    ["started event", [startedEvent("other-skill")]],
    [
      "suggestion",
      [startedEvent("line-edit"), suggestionEvent({ skill: "other-skill" })],
    ],
  ])("binds %s skill identity to the request", async function (_name, stream) {
    const gateway = new ScriptedFakeAgentGateway({ events: stream });
    const caught = await captureError(
      collect(gateway.stream(selectionRequest())),
    );

    expect(caught).toMatchObject({
      code: "AI_EVENT_SKILL_MISMATCH",
      category: "schema",
      retryable: false,
    });
  });

  it("accepts the resolved review skill for a modeless request", async function () {
    const modelessRequest = { ...selectionRequest(), skill: null };
    const stream = [startedEvent(null), suggestionEvent({ skill: "review" })];
    const gateway = new ScriptedFakeAgentGateway({ events: stream });

    expect(await collect(gateway.stream(modelessRequest))).toEqual(stream);
  });

  it("rejects another suggestion skill for a modeless request", async function () {
    const gateway = new ScriptedFakeAgentGateway({
      events: [
        startedEvent(null),
        suggestionEvent({ skill: "other-skill" }),
      ],
    });

    expect(
      await captureError(
        collect(gateway.stream({ ...selectionRequest(), skill: null })),
      ),
    ).toMatchObject({ code: "AI_EVENT_SKILL_MISMATCH" });
  });

  it.each([
    [
      "finding path",
      findingEvent([{ path: "other.tex", range: { from: 0, to: 4 } }]),
    ],
    [
      "finding range",
      findingEvent([{ path: "main.tex", range: { from: 3, to: 8 } }]),
    ],
    [
      "suggestion evidence revision",
      suggestionEvent({
        evidence: [
          {
            path: "main.tex",
            range: { from: 0, to: 4 },
            revision: 2,
            textHash: "a".repeat(64),
          },
        ],
      }),
    ],
    [
      "suggestion evidence hash",
      suggestionEvent({
        evidence: [
          {
            path: "main.tex",
            range: { from: 0, to: 4 },
            revision: 1,
            textHash: "b".repeat(64),
          },
        ],
      }),
    ],
  ])("rejects out-of-scope %s", async function (_name, scopedEvent) {
    const gateway = new ScriptedFakeAgentGateway({
      events: [startedEvent("line-edit"), scopedEvent],
    });
    const caught = await captureError(
      collect(gateway.stream(documentRequest())),
    );

    expect(caught).toMatchObject({
      code: "AI_EVENT_EVIDENCE_SCOPE_MISMATCH",
      category: "schema",
      retryable: false,
    });
  });

  it.each([
    ["path", { path: "other.tex", range: { from: 0, to: 4 } }],
    ["missing selection range", { path: "main.tex" }],
    ["range", { path: "main.tex", range: { from: 3, to: 8 } }],
  ])(
    "allows a selection tool read with a wider %s",
    async function (_name, arguments_) {
      const gateway = new ScriptedFakeAgentGateway({
        events: [startedEvent("line-edit"), toolCallEvent(arguments_)],
      });
      const emitted = await collect(gateway.stream(selectionRequest()));

      expect(emitted.at(-1)).toMatchObject({
        type: "tool.call",
        call: { name: "read_project_file", arguments: arguments_ },
      });
    },
  );

  it("stops before emitting the next event after cancellation", async function () {
    const checkpoint = new Promise(() => {});
    const gateway = new ScriptedFakeAgentGateway({
      events: events(),
      beforeEvent: async ({ index }) => {
        if (index === 1) {
          await checkpoint;
        }
      },
    });
    const controller = new AbortController();
    const iterator = gateway.stream(request(), {
      signal: controller.signal,
    });

    expect(await iterator.next()).toEqual({
      done: false,
      value: events()[0],
    });

    const pending = iterator.next();
    controller.abort();

    let caught;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AgentGatewayAbortError);
    expect(gateway.emittedEventCount).toBe(1);
  });

  it("classifies a timeout abort separately from user cancellation", async function () {
    const checkpoint = new Promise(() => {});
    const gateway = new ScriptedFakeAgentGateway({
      events: events(),
      beforeEvent: async ({ index }) => {
        if (index === 1) {
          await checkpoint;
        }
      },
    });
    const controller = new AbortController();
    const iterator = gateway.stream(request(), {
      signal: controller.signal,
    });

    expect(await iterator.next()).toEqual({
      done: false,
      value: events()[0],
    });

    const pending = iterator.next();
    controller.abort(
      new DOMException("The operation timed out.", "TimeoutError"),
    );

    let caught;
    try {
      await pending;
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      name: "AgentGatewayTimeoutError",
      code: "AI_REQUEST_TIMEOUT",
      category: "timeout",
      retryable: true,
    });
    expect(gateway.emittedEventCount).toBe(1);
  });
});
