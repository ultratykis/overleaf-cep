import { expect } from "chai";
import sinon from "sinon";

import {
  AgentStreamError,
  streamDiscussionEvents,
} from "../../frontend/js/services/agent-stream";
import type {
  DiscussionEvent,
  DiscussionRequest,
  UnresolvedSuggestion,
} from "../../shared/contract-types";

const createdAt = "2026-07-25T00:00:00.000Z";
const baseTextHash = "a".repeat(64);

function discussionRequest(): DiscussionRequest {
  return {
    requestId: "discussion-stream-0001",
    discussionId: "discussion-0001",
    projectId: "project-0001",
    subject: {
      kind: "scope",
      sourceRequest: {
        requestId: "source-request-0001",
        projectId: "project-0001",
        action: "rewrite",
        instruction: "Rewrite the selected phrase.",
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
      },
    },
    turns: [{ role: "user", text: "Explain this edit." }],
  };
}

function openDiscussionRequest(): DiscussionRequest {
  return {
    requestId: "open-discussion-stream-0001",
    discussionId: "open-discussion-0001",
    projectId: "project-0001",
    subject: null,
    turns: [{ role: "user", text: "How should I approach this paragraph?" }],
  };
}

function suggestion(overrides: Partial<UnresolvedSuggestion> = {}) {
  return {
    id: "discussion-suggestion-0001",
    requestId: "source-request-0001",
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

function discussionEvents(emittedSuggestion = suggestion()): DiscussionEvent[] {
  return [
    {
      type: "started",
      eventId: "discussion-event-0001",
      requestId: "discussion-stream-0001",
      sequence: 0,
      createdAt,
      provider: "fake",
      model: "deterministic-v1",
    },
    {
      type: "text.delta",
      eventId: "discussion-event-0002",
      requestId: "discussion-stream-0001",
      sequence: 1,
      createdAt,
      delta: "The replacement is more precise.",
    },
    {
      type: "suggestion",
      eventId: "discussion-event-0003",
      requestId: "discussion-stream-0001",
      sequence: 2,
      createdAt,
      suggestion: emittedSuggestion,
    },
    {
      type: "completed",
      eventId: "discussion-event-0004",
      requestId: "discussion-stream-0001",
      sequence: 3,
      createdAt,
      finishReason: "stop",
    },
  ];
}

function openDiscussionEvents({
  includeSuggestion = false,
}: {
  includeSuggestion?: boolean;
} = {}): DiscussionEvent[] {
  const requestId = "open-discussion-stream-0001";
  const events: DiscussionEvent[] = [
    {
      type: "started",
      eventId: "open-discussion-event-0001",
      requestId,
      sequence: 0,
      createdAt,
      provider: "fake",
      model: "deterministic-v1",
    },
    {
      type: "text.delta",
      eventId: "open-discussion-event-0002",
      requestId,
      sequence: 1,
      createdAt,
      delta: "Start by identifying the paragraph's central claim.",
    },
  ];
  if (includeSuggestion) {
    events.push({
      type: "suggestion",
      eventId: "open-discussion-event-0003",
      requestId,
      sequence: 2,
      createdAt,
      suggestion: suggestion(),
    });
  }
  events.push({
    type: "completed",
    eventId: "open-discussion-event-0004",
    requestId,
    sequence: includeSuggestion ? 3 : 2,
    createdAt,
    finishReason: "stop",
  });
  return events;
}

function responseForEvents(events: DiscussionEvent[]) {
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
  throw new Error("Expected the discussion stream to fail.");
}

describe("AI reviewer: discussion stream boundary", function () {
  it("uses the shared authenticated transport for an open discussion", async function () {
    const request = openDiscussionRequest();
    const events = openDiscussionEvents();
    const fetchImpl = sinon
      .stub()
      .resolves(responseForEvents(events)) as unknown as typeof fetch;
    const received: DiscussionEvent[] = [];

    await streamDiscussionEvents({
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
    expect(url).to.equal("/project/project-0001/ai-reviewer/discussion-stream");
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

  it("uses the shared authenticated transport and delivers a source-bound suggestion", async function () {
    const request = discussionRequest();
    const events = discussionEvents();
    const fetchImpl = sinon
      .stub()
      .resolves(responseForEvents(events)) as unknown as typeof fetch;
    const received: DiscussionEvent[] = [];

    await streamDiscussionEvents({
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
    expect(url).to.equal("/project/project-0001/ai-reviewer/discussion-stream");
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

  it("rejects an out-of-scope discussion suggestion before callback delivery", async function () {
    const request = discussionRequest();
    const events = discussionEvents(
      suggestion({
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
    const received: DiscussionEvent[] = [];

    const error = await captureError(
      streamDiscussionEvents({
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
      code: "AI_DISCUSSION_EVENT_SCOPE_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(received.map((event) => event.type)).to.deep.equal([
      "started",
      "text.delta",
    ]);
  });

  it("rejects a discussion suggestion with a stale full-text hash before callback delivery", async function () {
    const request = discussionRequest();
    const staleTextHash = "b".repeat(64);
    const events = discussionEvents(
      suggestion({
        baseTextHash: staleTextHash,
      }),
    );
    const received: DiscussionEvent[] = [];

    const error = await captureError(
      streamDiscussionEvents({
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
      code: "AI_DISCUSSION_EVENT_SCOPE_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(received.map((event) => event.type)).to.deep.equal([
      "started",
      "text.delta",
    ]);
  });

  it("rejects an unbound open-discussion suggestion before callback delivery", async function () {
    const request = openDiscussionRequest();
    const received: DiscussionEvent[] = [];

    const error = await captureError(
      streamDiscussionEvents({
        projectId: request.projectId,
        request,
        signal: new AbortController().signal,
        csrfToken: "synthetic-csrf",
        fetchImpl: sinon
          .stub()
          .resolves(
            responseForEvents(
              openDiscussionEvents({ includeSuggestion: true }),
            ),
          ) as unknown as typeof fetch,
        onEvent: (event) => received.push(event),
      }),
    );

    expect(error).to.be.instanceOf(AgentStreamError);
    expect((error as AgentStreamError).details).to.deep.include({
      code: "AI_DISCUSSION_EVENT_SCOPE_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(received.map((event) => event.type)).to.deep.equal([
      "started",
      "text.delta",
    ]);
  });
});
