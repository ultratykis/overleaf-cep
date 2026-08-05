import { expect } from "chai";
import sinon from "sinon";

import {
  AgentStreamError,
  streamAgentEvents,
} from "../../frontend/js/services/agent-stream";
import type {
  AgentEvent,
  AgentRequest,
  UnresolvedSuggestion,
} from "../../shared/contract-types";

const createdAt = "2026-07-25T00:00:00.000Z";
const baseTextHash = "a".repeat(64);

/**
 * A conversation pinned to a review keeps that review's scope and skill, which
 * is what lets it answer with an edit. Only the wording and the history change.
 */
function pinnedConversationRequest(): AgentRequest {
  return {
    requestId: "conversation-stream-0001",
    projectId: "project-0001",
    action: "rewrite",
    instruction: "Explain this edit.",
    skill: "line-edit",
    scope: {
      kind: "selection",
      documentId: "document-0001",
      path: "main.tex",
      baseRevision: 7,
      baseTextHash,
      range: {
        from: 6,
        to: 10,
      },
      text: "beta",
    },
    turns: [{ role: "assistant", text: "Use a more precise term." }],
  };
}

// A conversation with nothing pinned carries no scope at all, and the server
// reads that as project-wide.
function openConversationRequest(): AgentRequest {
  return {
    requestId: "open-conversation-stream-0001",
    projectId: "project-0001",
    action: "review",
    instruction: "How should I approach this paragraph?",
    skill: null,
  };
}

function suggestion(
  requestId: string,
  overrides: Partial<UnresolvedSuggestion> = {},
) {
  return {
    id: "conversation-suggestion-0001",
    requestId,
    projectId: "project-0001",
    documentId: "document-0001",
    path: "main.tex",
    baseRevision: 7,
    baseTextHash,
    range: {
      from: 6,
      to: 10,
    },
    original: "beta",
    replacement: "clear",
    rationale: "Use a more precise term.",
    evidence: [
      {
        path: "main.tex",
        range: {
          from: 6,
          to: 10,
        },
        revision: 7,
        textHash: baseTextHash,
      },
    ],
    provider: "fake",
    model: "deterministic-v1",
    skill: "line-edit",
    createdAt,
    status: "unresolved" as const,
    ...overrides,
  };
}

function pinnedConversationEvents(
  emittedSuggestion = suggestion("conversation-stream-0001"),
): AgentEvent[] {
  const requestId = "conversation-stream-0001";
  return [
    {
      type: "started",
      eventId: "conversation-event-0001",
      requestId,
      sequence: 0,
      createdAt,
      provider: "fake",
      model: "deterministic-v1",
      skill: "line-edit",
    },
    {
      type: "tool.call",
      eventId: "conversation-event-0002",
      requestId,
      sequence: 1,
      createdAt,
      call: {
        id: "tool-0001",
        name: "read_project_file",
        arguments: { path: "main.tex", range: { from: 6, to: 10 } },
      },
    },
    {
      type: "text.delta",
      eventId: "conversation-event-0003",
      requestId,
      sequence: 2,
      createdAt,
      delta: "The replacement is more precise.",
    },
    {
      type: "suggestion",
      eventId: "conversation-event-0004",
      requestId,
      sequence: 3,
      createdAt,
      suggestion: emittedSuggestion,
    },
    {
      type: "completed",
      eventId: "conversation-event-0005",
      requestId,
      sequence: 4,
      createdAt,
      finishReason: "stop",
    },
  ];
}

function openConversationEvents({
  includeSuggestion = false,
}: {
  includeSuggestion?: boolean;
} = {}): AgentEvent[] {
  const requestId = "open-conversation-stream-0001";
  const events: AgentEvent[] = [
    {
      type: "started",
      eventId: "open-conversation-event-0001",
      requestId,
      sequence: 0,
      createdAt,
      provider: "fake",
      model: "deterministic-v1",
      skill: null,
    },
    {
      type: "tool.call",
      eventId: "open-conversation-event-0002",
      requestId,
      sequence: 1,
      createdAt,
      call: {
        id: "tool-0002",
        name: "search_zotero",
        arguments: { query: "greenwade" },
      },
    },
    {
      type: "text.delta",
      eventId: "open-conversation-event-0003",
      requestId,
      sequence: 2,
      createdAt,
      delta: "Start by identifying the paragraph's central claim.",
    },
  ];
  if (includeSuggestion) {
    events.push({
      type: "suggestion",
      eventId: "open-conversation-event-0004",
      requestId,
      sequence: 3,
      createdAt,
      suggestion: suggestion(requestId),
    });
  }
  events.push({
    type: "completed",
    eventId: "open-conversation-event-0005",
    requestId,
    sequence: includeSuggestion ? 4 : 3,
    createdAt,
    finishReason: "stop",
  });
  return events;
}

function responseForEvents(events: AgentEvent[]) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode(
          `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
        ),
      );
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
    },
  });
}

async function captureError(operation: Promise<unknown>) {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the conversation stream to fail.");
}

describe("AI reviewer: conversation stream boundary", function () {
  it("posts an open conversation to the one streaming endpoint", async function () {
    const request = openConversationRequest();
    const events = openConversationEvents();
    const fetchImpl = sinon
      .stub()
      .resolves(responseForEvents(events)) as unknown as typeof fetch;
    const received: AgentEvent[] = [];

    await streamAgentEvents({
      projectId: request.projectId,
      request,
      signal: new AbortController().signal,
      csrfToken: "synthetic-csrf",
      fetchImpl,
      onEvent: (event) => received.push(event),
    });

    expect(received).to.deep.equal(events);
    expect(fetchImpl).to.have.property("calledOnce", true);
    const [url, options] = (fetchImpl as unknown as sinon.SinonStub).firstCall
      .args;
    expect(url).to.equal("/project/project-0001/ai-reviewer/stream");
    expect(options).to.deep.include({
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify(request),
    });
    expect(options.headers).to.deep.equal({
      "Content-Type": "application/json",
      "X-Csrf-Token": "synthetic-csrf",
      Accept: "application/x-ndjson, application/json",
    });
  });

  it("delivers a scope-bound suggestion from a pinned conversation", async function () {
    const request = pinnedConversationRequest();
    const events = pinnedConversationEvents();
    const fetchImpl = sinon
      .stub()
      .resolves(responseForEvents(events)) as unknown as typeof fetch;
    const received: AgentEvent[] = [];

    await streamAgentEvents({
      projectId: request.projectId,
      request,
      signal: new AbortController().signal,
      csrfToken: "synthetic-csrf",
      fetchImpl,
      onEvent: (event) => received.push(event),
    });

    expect(received).to.deep.equal(events);
    const [url] = (fetchImpl as unknown as sinon.SinonStub).firstCall.args;
    expect(url).to.equal("/project/project-0001/ai-reviewer/stream");
  });

  it("rejects an out-of-scope conversation suggestion before callback delivery", async function () {
    const request = pinnedConversationRequest();
    const events = pinnedConversationEvents(
      suggestion("conversation-stream-0001", {
        path: "other.tex",
        evidence: [
          {
            path: "other.tex",
            range: {
              from: 6,
              to: 10,
            },
            revision: 7,
            textHash: baseTextHash,
          },
        ],
      }),
    );
    const received: AgentEvent[] = [];

    const error = await captureError(
      streamAgentEvents({
        projectId: request.projectId,
        request,
        signal: new AbortController().signal,
        csrfToken: "synthetic-csrf",
        fetchImpl: sinon
          .stub()
          .resolves(responseForEvents(events)) as unknown as typeof fetch,
        onEvent: (event) => received.push(event),
      }),
    );

    expect(error).to.be.instanceOf(AgentStreamError);
    expect((error as AgentStreamError).details).to.deep.include({
      code: "AI_STREAM_EVENT_SCOPE_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(received.map((event) => event.type)).to.deep.equal([
      "started",
      "tool.call",
      "text.delta",
    ]);
  });

  it("rejects a conversation suggestion with a stale full-text hash before callback delivery", async function () {
    const request = pinnedConversationRequest();
    const events = pinnedConversationEvents(
      suggestion("conversation-stream-0001", {
        baseTextHash: "b".repeat(64),
      }),
    );
    const received: AgentEvent[] = [];

    const error = await captureError(
      streamAgentEvents({
        projectId: request.projectId,
        request,
        signal: new AbortController().signal,
        csrfToken: "synthetic-csrf",
        fetchImpl: sinon
          .stub()
          .resolves(responseForEvents(events)) as unknown as typeof fetch,
        onEvent: (event) => received.push(event),
      }),
    );

    expect(error).to.be.instanceOf(AgentStreamError);
    expect((error as AgentStreamError).details).to.deep.include({
      code: "AI_STREAM_EVENT_SCOPE_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(received.map((event) => event.type)).to.deep.equal([
      "started",
      "tool.call",
      "text.delta",
    ]);
  });

  it("rejects a suggestion from a scopeless conversation before callback delivery", async function () {
    const request = openConversationRequest();
    const received: AgentEvent[] = [];

    const error = await captureError(
      streamAgentEvents({
        projectId: request.projectId,
        request,
        signal: new AbortController().signal,
        csrfToken: "synthetic-csrf",
        fetchImpl: sinon
          .stub()
          .resolves(
            responseForEvents(
              openConversationEvents({ includeSuggestion: true }),
            ),
          ) as unknown as typeof fetch,
        onEvent: (event) => received.push(event),
      }),
    );

    expect(error).to.be.instanceOf(AgentStreamError);
    expect((error as AgentStreamError).details).to.deep.include({
      code: "AI_STREAM_EVENT_SCOPE_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(received.map((event) => event.type)).to.deep.equal([
      "started",
      "tool.call",
      "text.delta",
    ]);
  });

  it("accepts a Zotero query with no path to bound against the scope", async function () {
    const request = pinnedConversationRequest();
    const events: AgentEvent[] = [
      {
        type: "started",
        eventId: "zotero-event-0001",
        requestId: request.requestId,
        sequence: 0,
        createdAt,
        provider: "fake",
        model: "deterministic-v1",
        skill: "line-edit",
      },
      {
        type: "tool.call",
        eventId: "zotero-event-0002",
        requestId: request.requestId,
        sequence: 1,
        createdAt,
        call: {
          id: "tool-0003",
          name: "search_zotero",
          arguments: { query: "greenwade" },
        },
      },
      {
        type: "completed",
        eventId: "zotero-event-0003",
        requestId: request.requestId,
        sequence: 2,
        createdAt,
        finishReason: "stop",
      },
    ];
    const received: AgentEvent[] = [];

    await streamAgentEvents({
      projectId: request.projectId,
      request,
      signal: new AbortController().signal,
      csrfToken: "synthetic-csrf",
      fetchImpl: sinon
        .stub()
        .resolves(responseForEvents(events)) as unknown as typeof fetch,
      onEvent: (event) => received.push(event),
    });

    expect(received).to.deep.equal(events);
  });
});
