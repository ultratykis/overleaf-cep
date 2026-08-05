import { expect } from "chai";
import sinon from "sinon";

import {
  AgentStreamError,
  streamAgentEvents,
} from "../../frontend/js/services/agent-stream";
import type { AgentEvent, AgentRequest } from "../../shared/contract-types";

const createdAt = "2026-07-24T00:00:00.000Z";
const baseTextHash = "a".repeat(64);
const otherTextHash = "b".repeat(64);

function wireClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function selectionRequest(): AgentRequest {
  return {
    requestId: "request-stream-0001",
    projectId: "project-0001",
    action: "rewrite",
    instruction: "Rewrite the selected synthetic phrase.",
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
  };
}

function projectRequest(): AgentRequest {
  return {
    requestId: "request-stream-0001",
    projectId: "project-0001",
    action: "review",
    instruction: "Review the synthetic project.",
    skill: "referee-review",
    scope: {
      kind: "project",
    },
  };
}

function documentRequest(): AgentRequest {
  return {
    requestId: "request-stream-0001",
    projectId: "project-0001",
    action: "rewrite",
    instruction: "Rewrite one part of the synthetic document.",
    skill: "line-edit",
    scope: {
      kind: "document",
      documentId: "document-0001",
      path: "main.tex",
      baseRevision: 7,
      baseTextHash,
      text: "Alpha beta gamma.",
    },
  };
}

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    path: "main.tex",
    range: {
      from: 6,
      to: 10,
    },
    revision: 7,
    textHash: baseTextHash,
    ...overrides,
  };
}

function startedEvent(overrides: Record<string, unknown> = {}) {
  return {
    type: "started",
    eventId: "event-started-0001",
    requestId: "request-stream-0001",
    sequence: 0,
    createdAt,
    provider: "fake",
    model: "deterministic-v1",
    skill: "line-edit",
    ...overrides,
  };
}

function findingEvent({
  eventOverrides = {},
  findingOverrides = {},
  evidenceOverrides = {},
}: {
  eventOverrides?: Record<string, unknown>;
  findingOverrides?: Record<string, unknown>;
  evidenceOverrides?: Record<string, unknown>;
} = {}) {
  return {
    type: "finding",
    eventId: "event-finding-0001",
    requestId: "request-stream-0001",
    sequence: 1,
    createdAt,
    finding: {
      id: "finding-0001",
      requestId: "request-stream-0001",
      projectId: "project-0001",
      severity: "warning",
      category: "clarity",
      title: "Synthetic finding",
      message: "The selected phrase can be more precise.",
      evidence: [evidence(evidenceOverrides)],
      suggestionIds: ["suggestion-0001"],
      ...findingOverrides,
    },
    ...eventOverrides,
  };
}

function suggestionEvent({
  eventOverrides = {},
  suggestionOverrides = {},
  evidenceOverrides = {},
}: {
  eventOverrides?: Record<string, unknown>;
  suggestionOverrides?: Record<string, unknown>;
  evidenceOverrides?: Record<string, unknown>;
} = {}) {
  return {
    type: "suggestion",
    eventId: "event-suggestion-0001",
    requestId: "request-stream-0001",
    sequence: 1,
    createdAt,
    suggestion: {
      id: "suggestion-0001",
      requestId: "request-stream-0001",
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
      replacement: "Beta",
      rationale: "Start the selected synthetic phrase with a capital.",
      evidence: [evidence(evidenceOverrides)],
      provider: "fake",
      model: "deterministic-v1",
      skill: "line-edit",
      createdAt,
      status: "proposed",
      ...suggestionOverrides,
    },
    ...eventOverrides,
  };
}

function toolCallEvent({
  eventOverrides = {},
  argumentOverrides = {},
}: {
  eventOverrides?: Record<string, unknown>;
  argumentOverrides?: Record<string, unknown>;
} = {}) {
  return {
    type: "tool.call",
    eventId: "event-tool-0001",
    requestId: "request-stream-0001",
    sequence: 1,
    createdAt,
    call: {
      id: "tool-call-0001",
      name: "read_project_file",
      arguments: {
        path: "main.tex",
        range: {
          from: 6,
          to: 10,
        },
        ...argumentOverrides,
      },
    },
    ...eventOverrides,
  };
}

function completedEvent(sequence = 2, overrides: Record<string, unknown> = {}) {
  return {
    type: "completed",
    eventId: `event-completed-${sequence}`,
    requestId: "request-stream-0001",
    sequence,
    createdAt,
    finishReason: "stop",
    ...overrides,
  };
}

function responseForLines(
  lines: Array<string | Record<string, unknown>>,
  {
    close = true,
    contentType = "application/x-ndjson; charset=utf-8",
    cancelError,
    cancelResult,
  }: {
    close?: boolean;
    contentType?: string;
    cancelError?: Error;
    cancelResult?: Promise<void>;
  } = {},
) {
  const cancelReasons: unknown[] = [];
  const encoder = new TextEncoder();
  const payload = `${lines
    .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
    .join("\n")}\n`;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload));
      if (close) {
        controller.close();
      }
    },
    cancel(reason) {
      cancelReasons.push(reason);
      if (cancelError != null) {
        throw cancelError;
      }
      return cancelResult;
    },
  });
  return {
    response: new Response(body, {
      status: 200,
      headers: {
        "content-type": contentType,
      },
    }),
    cancelReasons,
  };
}

function spyOnResponseReader(response: Response) {
  if (response.body == null) {
    throw new Error("Expected a response body.");
  }
  const reader = response.body.getReader();
  const cancel = sinon.spy(reader, "cancel");
  const releaseLock = sinon.spy(reader, "releaseLock");
  const getReader = sinon.stub(response.body, "getReader").returns(reader);
  return {
    cancel,
    releaseLock,
    restore() {
      getReader.restore();
      cancel.restore();
      releaseLock.restore();
    },
  };
}

function responseForEvents(
  events: Array<Record<string, unknown>>,
  options?: Parameters<typeof responseForLines>[1],
) {
  return responseForLines(events, options);
}

async function captureError(operation: Promise<unknown>) {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the stream operation to fail.");
}

type PromptOutcome =
  | {
      status: "fulfilled";
    }
  | {
      status: "rejected";
      error: unknown;
    }
  | {
      status: "pending";
    };

async function settlePromptly(
  operation: Promise<unknown>,
): Promise<PromptOutcome> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then<PromptOutcome, PromptOutcome>(
        () => ({
          status: "fulfilled",
        }),
        (error: unknown) => ({
          status: "rejected",
          error,
        }),
      ),
      new Promise<PromptOutcome>((resolve) => {
        timeout = setTimeout(() => {
          resolve({
            status: "pending",
          });
        }, 100);
      }),
    ]);
  } finally {
    if (timeout != null) {
      clearTimeout(timeout);
    }
  }
}

function expectStreamError(
  error: unknown,
  {
    code,
    category,
    retryable,
  }: {
    code: string;
    category: string;
    retryable: boolean;
  },
) {
  expect(error).to.be.instanceOf(AgentStreamError);
  if (!(error instanceof AgentStreamError)) {
    throw new Error("Expected an AgentStreamError.");
  }
  expect(error.details).to.deep.include({
    code,
    category,
    retryable,
  });
}

async function runStream({
  request = selectionRequest(),
  projectId = "project-0001",
  response,
  fetchImpl,
  signal = new AbortController().signal,
}: {
  request?: AgentRequest;
  projectId?: string;
  response?: Response;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}) {
  const received: AgentEvent[] = [];
  const resolvedFetch =
    fetchImpl ?? (sinon.stub().resolves(response) as unknown as typeof fetch);
  const operation = streamAgentEvents({
    projectId,
    request,
    signal,
    csrfToken: "synthetic-csrf",
    fetchImpl: resolvedFetch,
    onEvent: (event) => {
      received.push(event);
    },
  });
  return {
    operation,
    received,
    fetchImpl: resolvedFetch,
  };
}

describe("AI reviewer: single document stream boundary", function () {
  it("delivers a valid selection-bound stream in order without cancelling its reader", async function () {
    const events = [
      startedEvent(),
      findingEvent(),
      suggestionEvent({
        eventOverrides: {
          sequence: 2,
          eventId: "event-suggestion-0002",
        },
      }),
      completedEvent(3),
    ];
    const stream = responseForEvents(events);
    const reader = spyOnResponseReader(stream.response);
    const run = await runStream({
      response: stream.response,
    });

    try {
      await run.operation;

      expect(run.received).to.deep.equal(events);
      expect(reader.cancel.called).to.equal(false);
      expect(reader.releaseLock.calledOnce).to.equal(true);
      expect(stream.cancelReasons).to.deep.equal([]);
    } finally {
      reader.restore();
    }
  });

  it("allows project-scoped cross-file events without claiming snapshot verification", async function () {
    const events = [
      startedEvent({
        skill: "referee-review",
      }),
      findingEvent({
        findingOverrides: {
          suggestionIds: ["suggestion-project-0001"],
        },
        evidenceOverrides: {
          path: "sections/other.tex",
          range: {
            from: 0,
            to: 5,
          },
          revision: 3,
          textHash: otherTextHash,
        },
      }),
      suggestionEvent({
        eventOverrides: {
          sequence: 2,
          eventId: "event-suggestion-project",
        },
        suggestionOverrides: {
          id: "suggestion-project-0001",
          documentId: "document-other",
          path: "sections/other.tex",
          baseRevision: 3,
          baseTextHash: otherTextHash,
          range: {
            from: 0,
            to: 5,
          },
          original: "Gamma",
          replacement: "Delta",
          skill: "referee-review",
        },
        evidenceOverrides: {
          path: "references.bib",
          range: {
            from: 10,
            to: 20,
          },
          revision: 2,
          textHash: otherTextHash,
        },
      }),
      toolCallEvent({
        eventOverrides: {
          sequence: 3,
          eventId: "event-tool-project",
        },
        argumentOverrides: {
          path: "appendix.tex",
          range: undefined,
        },
      }),
      completedEvent(4),
    ];
    const run = await runStream({
      request: projectRequest(),
      response: responseForEvents(events).response,
    });

    await run.operation;

    expect(run.received).to.deep.equal(wireClone(events));
  });

  it("allows document-scoped evidence and reads without a range", async function () {
    const events = [
      startedEvent(),
      findingEvent({
        evidenceOverrides: {
          range: undefined,
        },
      }),
      suggestionEvent({
        eventOverrides: {
          sequence: 2,
          eventId: "event-suggestion-document",
        },
      }),
      toolCallEvent({
        eventOverrides: {
          sequence: 3,
          eventId: "event-tool-document",
        },
        argumentOverrides: {
          range: undefined,
        },
      }),
      completedEvent(4),
    ];
    const run = await runStream({
      request: documentRequest(),
      response: responseForEvents(events).response,
    });

    await run.operation;

    expect(run.received).to.deep.equal(wireClone(events));
  });

  it("rejects a route project mismatch before fetch", async function () {
    const fetchImpl = sinon.stub();
    const run = await runStream({
      projectId: "project-other",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const error = await captureError(run.operation);

    expectStreamError(error, {
      code: "AI_STREAM_REQUEST_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(fetchImpl.called).to.equal(false);
    expect(run.received).to.deep.equal([]);
  });

  it("rejects a malformed request before fetch", async function () {
    const fetchImpl = sinon.stub();
    const malformedRequest = {
      ...selectionRequest(),
      unexpected: true,
    };
    const run = await runStream({
      request: malformedRequest as AgentRequest,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const error = await captureError(run.operation);

    expectStreamError(error, {
      code: "AI_STREAM_REQUEST_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(fetchImpl.called).to.equal(false);
    expect(run.received).to.deep.equal([]);
  });

  it("retains the invocation-time request ID while fetch is pending", async function () {
    const request = selectionRequest();
    let releaseFetch = () => {};
    let signalFetchStarted = () => {};
    const fetchStarted = new Promise<void>((resolve) => {
      signalFetchStarted = resolve;
    });
    const fetchImpl = sinon.stub().callsFake(async () => {
      signalFetchStarted();
      await new Promise<void>((resolve) => {
        releaseFetch = resolve;
      });
      return responseForEvents([
        startedEvent(),
        findingEvent(),
        completedEvent(),
      ]).response;
    });
    const run = await runStream({
      request,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await fetchStarted;

    request.requestId = "request-mutated";
    releaseFetch();

    await run.operation;

    const [, options] = fetchImpl.firstCall.args;
    expect(JSON.parse(String(options.body))).to.deep.equal(selectionRequest());
    expect(run.received).to.have.length(3);
  });

  it("rejects an event that matches a request ID mutated after fetch started", async function () {
    const request = selectionRequest();
    let releaseFetch = () => {};
    let signalFetchStarted = () => {};
    const fetchStarted = new Promise<void>((resolve) => {
      signalFetchStarted = resolve;
    });
    const fetchImpl = sinon.stub().callsFake(async () => {
      signalFetchStarted();
      await new Promise<void>((resolve) => {
        releaseFetch = resolve;
      });
      return responseForEvents([
        startedEvent({
          requestId: "request-mutated",
        }),
        completedEvent(1, {
          requestId: "request-mutated",
        }),
      ]).response;
    });
    const run = await runStream({
      request,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await fetchStarted;

    request.requestId = "request-mutated";
    releaseFetch();

    const error = await captureError(run.operation);

    expectStreamError(error, {
      code: "AI_STREAM_EVENT_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(run.received).to.deep.equal([]);
  });

  it("rejects evidence matching a path mutated after fetch started", async function () {
    const request = selectionRequest();
    let releaseFetch = () => {};
    let signalFetchStarted = () => {};
    const fetchStarted = new Promise<void>((resolve) => {
      signalFetchStarted = resolve;
    });
    const fetchImpl = sinon.stub().callsFake(async () => {
      signalFetchStarted();
      await new Promise<void>((resolve) => {
        releaseFetch = resolve;
      });
      return responseForEvents([
        startedEvent(),
        findingEvent({
          evidenceOverrides: {
            path: "mutated.tex",
          },
        }),
        completedEvent(),
      ]).response;
    });
    const run = await runStream({
      request,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await fetchStarted;
    if (request.scope.kind !== "selection") {
      throw new Error("Expected a selection request.");
    }

    request.scope.path = "mutated.tex";
    releaseFetch();

    const error = await captureError(run.operation);

    expectStreamError(error, {
      code: "AI_STREAM_EVENT_SCOPE_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(run.received).to.deep.equal([startedEvent()]);
  });

  const schemaCases: Array<{
    title: string;
    response: () => Response;
    code: string;
    expectedDelivered?: number;
  }> = [
    {
      title: "invalid content type",
      response: () =>
        new Response("not ndjson", {
          status: 200,
          headers: {
            "content-type": "text/plain",
          },
        }),
      code: "AI_STREAM_CONTENT_TYPE_INVALID",
    },
    {
      title: "malformed JSON",
      response: () => responseForLines(["{not-json"]).response,
      code: "AI_STREAM_JSON_INVALID",
    },
    {
      title: "invalid event schema",
      response: () =>
        responseForEvents([
          startedEvent({
            provider: "",
          }),
        ]).response,
      code: "AI_STREAM_EVENT_INVALID",
    },
    {
      title: "request ID mismatch",
      response: () =>
        responseForEvents([
          startedEvent({
            requestId: "request-other",
          }),
        ]).response,
      code: "AI_STREAM_EVENT_INVALID",
    },
    {
      title: "sequence mismatch",
      response: () =>
        responseForEvents([
          startedEvent(),
          findingEvent({
            eventOverrides: {
              sequence: 2,
            },
          }),
        ]).response,
      code: "AI_STREAM_EVENT_INVALID",
      expectedDelivered: 1,
    },
    {
      title: "event after terminal",
      response: () =>
        responseForEvents([
          startedEvent(),
          completedEvent(1),
          {
            type: "text.delta",
            eventId: "event-late-0001",
            requestId: "request-stream-0001",
            sequence: 2,
            createdAt,
            delta: "late",
          },
        ]).response,
      code: "AI_STREAM_AFTER_TERMINAL",
      expectedDelivered: 2,
    },
  ];

  for (const schemaCase of schemaCases) {
    it(`classifies ${schemaCase.title} as non-retryable schema failure`, async function () {
      const run = await runStream({
        response: schemaCase.response(),
      });

      const error = await captureError(run.operation);

      expectStreamError(error, {
        code: schemaCase.code,
        category: "schema",
        retryable: false,
      });
      expect(run.received).to.have.length(schemaCase.expectedDelivered ?? 0);
    });
  }

  it("classifies fetch rejection as retryable network failure", async function () {
    const fetchImpl = sinon
      .stub()
      .rejects(new Error("synthetic fetch failure"));
    const run = await runStream({
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const error = await captureError(run.operation);

    expectStreamError(error, {
      code: "AI_STREAM_NETWORK_ERROR",
      category: "network",
      retryable: true,
    });
  });

  it("classifies reader rejection as retryable network failure", async function () {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("synthetic reader failure"));
      },
    });
    const run = await runStream({
      response: new Response(body, {
        status: 200,
        headers: {
          "content-type": "application/x-ndjson",
        },
      }),
    });

    const error = await captureError(run.operation);

    expectStreamError(error, {
      code: "AI_STREAM_NETWORK_ERROR",
      category: "network",
      retryable: true,
    });
  });

  it("keeps an incomplete stream retryable", async function () {
    const run = await runStream({
      response: responseForEvents([startedEvent()]).response,
    });

    const error = await captureError(run.operation);

    expectStreamError(error, {
      code: "AI_STREAM_INCOMPLETE",
      category: "network",
      retryable: true,
    });
  });

  it("keeps a missing response body retryable", async function () {
    const run = await runStream({
      response: new Response(null, {
        status: 200,
        headers: {
          "content-type": "application/x-ndjson",
        },
      }),
    });

    const error = await captureError(run.operation);

    expectStreamError(error, {
      code: "AI_STREAM_BODY_MISSING",
      category: "network",
      retryable: true,
    });
  });

  it("keeps an unstructured HTTP failure retryable", async function () {
    const run = await runStream({
      response: new Response("synthetic unavailable", {
        status: 503,
        headers: {
          "content-type": "text/plain",
        },
      }),
    });

    const error = await captureError(run.operation);

    expectStreamError(error, {
      code: "AI_HTTP_ERROR",
      category: "network",
      retryable: true,
    });
  });

  it("preserves a typed HTTP error response", async function () {
    const typedError = {
      code: "AI_CONFIGURATION_INVALID",
      category: "configuration",
      message: "Synthetic configuration failure.",
      retryable: false,
    };
    const run = await runStream({
      response: new Response(
        JSON.stringify({
          error: typedError,
        }),
        {
          status: 400,
          headers: {
            "content-type": "application/json",
          },
        },
      ),
    });

    const error = await captureError(run.operation);

    expectStreamError(error, typedError);
  });

  it("cancels a pending HTTP error body with the exact abort reason", async function () {
    const controller = new AbortController();
    const reason = new DOMException("Synthetic cancellation.", "AbortError");
    const cancelReasons: unknown[] = [];
    const encoder = new TextEncoder();
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let signalPull = () => {};
    const pullStarted = new Promise<void>((resolve) => {
      signalPull = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      start(streamController) {
        bodyController = streamController;
      },
      pull() {
        signalPull();
      },
      cancel(cancelReason) {
        cancelReasons.push(cancelReason);
      },
    });
    const response = new Response(body, {
      status: 400,
      headers: {
        "content-type": "application/json",
      },
    });
    const run = await runStream({
      response,
      signal: controller.signal,
    });
    const eventualOutcome = run.operation.then<PromptOutcome, PromptOutcome>(
      () => ({
        status: "fulfilled",
      }),
      (error: unknown) => ({
        status: "rejected",
        error,
      }),
    );
    await pullStarted;

    controller.abort(reason);
    const promptOutcome = await settlePromptly(run.operation);
    if (promptOutcome.status === "pending") {
      bodyController?.enqueue(
        encoder.encode(
          JSON.stringify({
            error: {
              code: "AI_CONFIGURATION_INVALID",
              category: "configuration",
              message: "Synthetic configuration failure.",
              retryable: false,
            },
          }),
        ),
      );
      bodyController?.close();
      await eventualOutcome;
    }

    expect(promptOutcome).to.deep.equal({
      status: "rejected",
      error: reason,
    });
    expect(cancelReasons).to.deep.equal([reason]);
    expect(response.body?.locked).to.equal(false);
    expect(run.received).to.deep.equal([]);
  });

  it("accepts a sequence-zero terminal error without a started event", async function () {
    const terminalError = {
      type: "error",
      eventId: "event-error-0001",
      requestId: "request-stream-0001",
      sequence: 0,
      createdAt,
      error: {
        code: "AI_PROVIDER_UNAVAILABLE",
        category: "provider",
        message: "Synthetic provider failure.",
        retryable: true,
      },
    };
    const run = await runStream({
      response: responseForEvents([terminalError]).response,
    });

    await run.operation;

    expect(run.received).to.deep.equal([terminalError]);
  });

  it("rejects an already-aborted request before fetch with the exact reason", async function () {
    const controller = new AbortController();
    const reason = new DOMException("Synthetic cancellation.", "AbortError");
    controller.abort(reason);
    const fetchImpl = sinon.stub();
    const run = await runStream({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      signal: controller.signal,
    });

    const error = await captureError(run.operation);

    expect(error).to.equal(reason);
    expect(fetchImpl.called).to.equal(false);
  });

  it("rejects a pending fetch with the exact abort reason", async function () {
    const controller = new AbortController();
    const reason = new DOMException("Synthetic cancellation.", "AbortError");
    let resolveFetch = (_response: Response) => {};
    const pendingFetch = new Promise<Response>((resolve) => {
      resolveFetch = resolve;
    });
    const fetchImpl = sinon.stub().returns(pendingFetch);
    const run = await runStream({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      signal: controller.signal,
    });

    controller.abort(reason);
    const error = await captureError(run.operation);
    resolveFetch(responseForEvents([completedEvent(0)]).response);
    await Promise.resolve();

    expect(error).to.equal(reason);
    expect(fetchImpl.calledOnce).to.equal(true);
    expect(run.received).to.deep.equal([]);
  });
});

describe("AI reviewer: OT safety stream boundary", function () {
  it("rejects a first-event started skill mismatch before callback delivery", async function () {
    const run = await runStream({
      response: responseForEvents([
        startedEvent({
          skill: "other-skill",
        }),
        completedEvent(1),
      ]).response,
    });

    const error = await captureError(run.operation);

    expectStreamError(error, {
      code: "AI_STREAM_EVENT_SCOPE_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(run.received).to.deep.equal([]);
  });

  it("rejects a project-scoped suggestion project mismatch before callback delivery", async function () {
    const start = startedEvent({
      skill: "referee-review",
    });
    const run = await runStream({
      request: projectRequest(),
      response: responseForEvents([
        start,
        suggestionEvent({
          suggestionOverrides: {
            projectId: "project-other",
            skill: "referee-review",
          },
        }),
        completedEvent(),
      ]).response,
    });

    const error = await captureError(run.operation);

    expectStreamError(error, {
      code: "AI_STREAM_EVENT_SCOPE_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(run.received).to.deep.equal([start]);
  });

  const eventBindingCases: Array<{
    title: string;
    event: () => Record<string, unknown>;
  }> = [
    {
      title: "finding project",
      event: () =>
        findingEvent({
          findingOverrides: {
            projectId: "project-other",
          },
        }),
    },
    {
      title: "finding evidence path",
      event: () =>
        findingEvent({
          evidenceOverrides: {
            path: "other.tex",
          },
        }),
    },
    {
      title: "finding evidence missing selection range",
      event: () =>
        findingEvent({
          evidenceOverrides: {
            range: undefined,
          },
        }),
    },
    {
      title: "finding evidence lower bound",
      event: () =>
        findingEvent({
          evidenceOverrides: {
            range: {
              from: 5,
              to: 10,
            },
          },
        }),
    },
    {
      title: "finding evidence upper bound",
      event: () =>
        findingEvent({
          evidenceOverrides: {
            range: {
              from: 6,
              to: 11,
            },
          },
        }),
    },
    {
      title: "finding evidence revision",
      event: () =>
        findingEvent({
          evidenceOverrides: {
            revision: 8,
          },
        }),
    },
    {
      title: "finding evidence hash",
      event: () =>
        findingEvent({
          evidenceOverrides: {
            textHash: otherTextHash,
          },
        }),
    },
    {
      title: "suggestion project",
      event: () =>
        suggestionEvent({
          suggestionOverrides: {
            projectId: "project-other",
          },
        }),
    },
    {
      title: "suggestion skill",
      event: () =>
        suggestionEvent({
          suggestionOverrides: {
            skill: "other-skill",
          },
        }),
    },
    {
      title: "suggestion document",
      event: () =>
        suggestionEvent({
          suggestionOverrides: {
            documentId: "document-other",
          },
        }),
    },
    {
      title: "suggestion path",
      event: () =>
        suggestionEvent({
          suggestionOverrides: {
            path: "other.tex",
          },
        }),
    },
    {
      title: "suggestion revision",
      event: () =>
        suggestionEvent({
          suggestionOverrides: {
            baseRevision: 8,
          },
        }),
    },
    {
      title: "suggestion hash",
      event: () =>
        suggestionEvent({
          suggestionOverrides: {
            baseTextHash: otherTextHash,
          },
        }),
    },
    {
      title: "suggestion range",
      event: () =>
        suggestionEvent({
          suggestionOverrides: {
            range: {
              from: 5,
              to: 9,
            },
          },
        }),
    },
    {
      title: "suggestion upper range",
      event: () =>
        suggestionEvent({
          suggestionOverrides: {
            range: {
              from: 7,
              to: 11,
            },
          },
        }),
    },
    {
      title: "suggestion original",
      event: () =>
        suggestionEvent({
          suggestionOverrides: {
            original: "zeta",
          },
        }),
    },
    {
      title: "suggestion evidence path",
      event: () =>
        suggestionEvent({
          evidenceOverrides: {
            path: "other.tex",
          },
        }),
    },
    {
      title: "suggestion evidence missing selection range",
      event: () =>
        suggestionEvent({
          evidenceOverrides: {
            range: undefined,
          },
        }),
    },
    {
      title: "suggestion evidence lower bound",
      event: () =>
        suggestionEvent({
          evidenceOverrides: {
            range: {
              from: 5,
              to: 10,
            },
          },
        }),
    },
    {
      title: "suggestion evidence upper bound",
      event: () =>
        suggestionEvent({
          evidenceOverrides: {
            range: {
              from: 6,
              to: 11,
            },
          },
        }),
    },
    {
      title: "suggestion evidence revision",
      event: () =>
        suggestionEvent({
          evidenceOverrides: {
            revision: 8,
          },
        }),
    },
    {
      title: "suggestion evidence hash",
      event: () =>
        suggestionEvent({
          evidenceOverrides: {
            textHash: otherTextHash,
          },
        }),
    },
    {
      title: "read tool path",
      event: () =>
        toolCallEvent({
          argumentOverrides: {
            path: "other.tex",
          },
        }),
    },
    {
      title: "read tool missing selection range",
      event: () =>
        toolCallEvent({
          argumentOverrides: {
            range: undefined,
          },
        }),
    },
    {
      title: "read tool lower bound",
      event: () =>
        toolCallEvent({
          argumentOverrides: {
            range: {
              from: 5,
              to: 10,
            },
          },
        }),
    },
    {
      title: "read tool upper bound",
      event: () =>
        toolCallEvent({
          argumentOverrides: {
            range: {
              from: 6,
              to: 11,
            },
          },
        }),
    },
  ];

  for (const bindingCase of eventBindingCases) {
    it(`rejects a one-field ${bindingCase.title} mismatch before callback delivery`, async function () {
      const invalidEvent = bindingCase.event();
      const run = await runStream({
        response: responseForEvents([
          startedEvent(),
          invalidEvent,
          completedEvent(),
        ]).response,
      });

      const error = await captureError(run.operation);

      expectStreamError(error, {
        code: "AI_STREAM_EVENT_SCOPE_INVALID",
        category: "schema",
        retryable: false,
      });
      expect(run.received).to.deep.equal([startedEvent()]);
    });
  }

  it("cancels before release after a semantic protocol rejection without delivering it", async function () {
    const stream = responseForLines(
      [
        startedEvent(),
        findingEvent({
          evidenceOverrides: {
            path: "other.tex",
          },
        }),
        "{not-json",
      ],
      {
        close: false,
      },
    );
    const reader = spyOnResponseReader(stream.response);
    const run = await runStream({
      response: stream.response,
    });

    try {
      const error = await captureError(run.operation);

      expectStreamError(error, {
        code: "AI_STREAM_EVENT_SCOPE_INVALID",
        category: "schema",
        retryable: false,
      });
      expect(reader.cancel.calledOnceWithExactly(error)).to.equal(true);
      expect(reader.releaseLock.calledOnce).to.equal(true);
      expect(reader.cancel.calledBefore(reader.releaseLock)).to.equal(true);
      expect(stream.cancelReasons).to.deep.equal([error]);
      expect(run.received).to.deep.equal([startedEvent()]);
    } finally {
      reader.restore();
    }
  });

  it("does not let reader cancellation failure mask a protocol error", async function () {
    const stream = responseForLines(["{not-json"], {
      close: false,
      cancelError: new Error("synthetic cancel failure"),
    });
    const run = await runStream({
      response: stream.response,
    });

    const error = await captureError(run.operation);

    expectStreamError(error, {
      code: "AI_STREAM_JSON_INVALID",
      category: "schema",
      retryable: false,
    });
    expect(stream.cancelReasons).to.have.length(1);
    expect(run.received).to.deep.equal([]);
  });

  it("does not wait for non-cooperative reader cancellation before preserving a protocol error", async function () {
    const stream = responseForLines(["{not-json"], {
      close: false,
      cancelResult: new Promise<void>(() => {}),
    });
    const reader = spyOnResponseReader(stream.response);
    const run = await runStream({
      response: stream.response,
    });

    try {
      const outcome = await settlePromptly(run.operation);

      expect(outcome.status).to.equal("rejected");
      if (outcome.status !== "rejected") {
        throw new Error("Expected the protocol error to settle promptly.");
      }
      expectStreamError(outcome.error, {
        code: "AI_STREAM_JSON_INVALID",
        category: "schema",
        retryable: false,
      });
      expect(reader.cancel.calledOnceWithExactly(outcome.error)).to.equal(true);
      expect(reader.releaseLock.calledOnce).to.equal(true);
      expect(reader.cancel.calledBefore(reader.releaseLock)).to.equal(true);
      expect(stream.cancelReasons).to.deep.equal([outcome.error]);
      expect(run.received).to.deep.equal([]);
    } finally {
      reader.restore();
    }
  });

  it("cancels and releases the reader while preserving a callback exception", async function () {
    const callbackError = new Error("synthetic callback failure");
    const stream = responseForEvents([startedEvent(), completedEvent(1)], {
      close: false,
    });
    const reader = spyOnResponseReader(stream.response);
    const received: AgentEvent[] = [];

    try {
      const error = await captureError(
        streamAgentEvents({
          projectId: "project-0001",
          request: selectionRequest(),
          signal: new AbortController().signal,
          csrfToken: "synthetic-csrf",
          fetchImpl: sinon
            .stub()
            .resolves(stream.response) as unknown as typeof fetch,
          onEvent: (event) => {
            received.push(event);
            throw callbackError;
          },
        }),
      );

      expect(error).to.equal(callbackError);
      expect(reader.cancel.calledOnceWithExactly(callbackError)).to.equal(true);
      expect(reader.releaseLock.calledOnce).to.equal(true);
      expect(reader.cancel.calledBefore(reader.releaseLock)).to.equal(true);
      expect(received).to.deep.equal([startedEvent()]);
    } finally {
      reader.restore();
    }
  });

  it("stops same-chunk delivery when a callback aborts the request", async function () {
    const controller = new AbortController();
    const reason = new DOMException("Synthetic cancellation.", "AbortError");
    const stream = responseForEvents(
      [startedEvent(), findingEvent(), completedEvent()],
      {
        close: false,
      },
    );
    const received: AgentEvent[] = [];
    const operation = streamAgentEvents({
      projectId: "project-0001",
      request: selectionRequest(),
      signal: controller.signal,
      csrfToken: "synthetic-csrf",
      fetchImpl: sinon
        .stub()
        .resolves(stream.response) as unknown as typeof fetch,
      onEvent: (event) => {
        received.push(event);
        if (received.length === 1) {
          controller.abort(reason);
        }
      },
    });

    const error = await captureError(operation);

    expect(error).to.equal(reason);
    expect(received).to.deep.equal([startedEvent()]);
    expect(stream.cancelReasons).to.deep.equal([reason]);
  });

  it("rejects with the exact abort reason when the terminal callback aborts", async function () {
    const controller = new AbortController();
    const reason = new DOMException("Synthetic cancellation.", "AbortError");
    const encoder = new TextEncoder();
    const response = new Response("", {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson",
      },
    });
    if (response.body == null) {
      throw new Error("Expected a response body.");
    }
    const cancel = sinon.stub().resolves();
    const releaseLock = sinon.spy();
    const read = sinon.stub().resolves({
      done: true,
      value: encoder.encode(
        `${JSON.stringify(startedEvent())}\n${JSON.stringify(
          completedEvent(1),
        )}\n`,
      ),
    });
    const getReader = sinon.stub(response.body, "getReader").returns({
      cancel,
      read,
      releaseLock,
      closed: Promise.resolve(),
    } as unknown as ReturnType<typeof response.body.getReader>);
    const received: AgentEvent[] = [];

    try {
      const error = await captureError(
        streamAgentEvents({
          projectId: "project-0001",
          request: selectionRequest(),
          signal: controller.signal,
          csrfToken: "synthetic-csrf",
          fetchImpl: sinon.stub().resolves(response) as unknown as typeof fetch,
          onEvent: (event) => {
            received.push(event);
            if (event.type === "completed") {
              controller.abort(reason);
            }
          },
        }),
      );

      expect(error).to.equal(reason);
      expect(cancel.calledOnceWithExactly(reason)).to.equal(true);
      expect(releaseLock.calledOnce).to.equal(true);
      expect(cancel.calledBefore(releaseLock)).to.equal(true);
      expect(received).to.deep.equal([startedEvent(), completedEvent(1)]);
    } finally {
      getReader.restore();
    }
  });

  it("cancels a pending reader with the exact abort reason", async function () {
    const controller = new AbortController();
    const reason = new DOMException("Synthetic cancellation.", "AbortError");
    const cancelReasons: unknown[] = [];
    let signalPull = () => {};
    const pullStarted = new Promise<void>((resolve) => {
      signalPull = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      pull() {
        signalPull();
      },
      cancel(cancelReason) {
        cancelReasons.push(cancelReason);
      },
    });
    const run = await runStream({
      response: new Response(body, {
        status: 200,
        headers: {
          "content-type": "application/x-ndjson",
        },
      }),
      signal: controller.signal,
    });
    await pullStarted;

    controller.abort(reason);
    const error = await captureError(run.operation);

    expect(error).to.equal(reason);
    expect(cancelReasons).to.deep.equal([reason]);
    expect(run.received).to.deep.equal([]);
  });
});
