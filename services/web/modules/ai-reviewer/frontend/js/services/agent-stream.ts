import getMeta from "@/utils/meta";

import {
  AgentErrorSchema,
  AgentEventSchema,
  AgentRequestSchema,
  DiscussionEventSchema,
  DiscussionRequestSchema,
} from "../../../shared/contracts.mjs";
import type {
  AgentError,
  AgentEvent,
  AgentRequest,
  DiscussionEvent,
  DiscussionRequest,
  EvidenceReference,
} from "../../../shared/contract-types";
import { prepareSingleDocumentSuggestion } from "./single-document-suggestions";

export class AgentStreamError extends Error {
  constructor(public readonly details: AgentError) {
    super(details.message);
    this.name = "AgentStreamError";
  }
}

type StreamAgentEventsOptions = {
  projectId: string;
  request: AgentRequest;
  signal: AbortSignal;
  onEvent: (event: AgentEvent) => void;
  csrfToken?: string;
  fetchImpl?: typeof fetch;
};

type StreamDiscussionEventsOptions = {
  projectId: string;
  request: DiscussionRequest;
  signal: AbortSignal;
  onEvent: (event: DiscussionEvent) => void;
  csrfToken?: string;
  fetchImpl?: typeof fetch;
};

type StreamEnvelope = {
  requestId: string;
  sequence: number;
  type: string;
};

type RuntimeSchema<Value> = {
  safeParse: (
    value: unknown,
  ) => { success: true; data: Value } | { success: false; error: unknown };
};

function genericStreamError(
  code: string,
  message: string,
  category: AgentError["category"],
  retryable: boolean,
): AgentStreamError {
  return new AgentStreamError({
    code,
    category,
    message,
    retryable,
  });
}

function protocolError(code: string, message: string) {
  return genericStreamError(code, message, "schema", false);
}

function networkError(code: string, message: string) {
  return genericStreamError(code, message, "network", true);
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) {
    throw signal.reason;
  }
}

function waitWithAbort<T>(operation: Promise<T>, signal: AbortSignal) {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      finish(() => reject(signal.reason));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        finish(() => resolve(value));
      },
      (error: unknown) => {
        finish(() => reject(error));
      },
    );
  });
}

function normalizeTransportError(error: unknown, signal: AbortSignal) {
  if (signal.aborted) {
    return signal.reason;
  }
  if (error instanceof AgentStreamError) {
    return error;
  }
  return networkError(
    "AI_STREAM_NETWORK_ERROR",
    "The AI reviewer stream could not be read.",
  );
}

function cancelReaderWithoutWaiting(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  reason: unknown,
) {
  try {
    void Promise.resolve(reader.cancel(reason)).catch(() => {});
  } catch {
    // Preserve the stream, protocol, callback, or abort failure.
  }
}

async function readJsonResponseBody(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (response.body == null) {
    return null;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let failure: unknown;
  let failed = false;

  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await waitWithAbort(reader.read(), signal);
      } catch (error) {
        throw normalizeTransportError(error, signal);
      }
      const { done, value } = result;
      throwIfAborted(signal);
      body += decoder.decode(value, { stream: !done });
      if (done) {
        break;
      }
    }
  } catch (error) {
    failed = true;
    failure = signal.aborted ? signal.reason : error;
    cancelReaderWithoutWaiting(reader, failure);
  }
  try {
    reader.releaseLock();
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = normalizeTransportError(error, signal);
    }
  }
  if (failed) {
    throw failure;
  }

  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

async function errorFromResponse(response: Response, signal: AbortSignal) {
  if (response.headers.get("content-type")?.includes("application/json")) {
    const body = await readJsonResponseBody(response, signal);
    const responseError =
      body != null && typeof body === "object" && "error" in body
        ? body.error
        : undefined;
    const parsed = AgentErrorSchema.safeParse(responseError);
    if (parsed.success) {
      return new AgentStreamError(parsed.data);
    }
  }
  return networkError(
    "AI_HTTP_ERROR",
    `The AI reviewer request failed with HTTP ${response.status}.`,
  );
}

function assertPathAndRangeWithinRequest(
  request: AgentRequest,
  reference: {
    path: string;
    range?: {
      from: number;
      to: number;
    };
  },
) {
  if (request.scope.kind === "project") {
    return;
  }

  const scope = request.scope;
  const lowerBound = scope.kind === "selection" ? scope.range.from : 0;
  const upperBound =
    scope.kind === "selection" ? scope.range.to : scope.text.length;
  const selectionRangeMissing =
    scope.kind === "selection" && reference.range == null;
  const rangeOutside =
    reference.range != null &&
    (reference.range.from < lowerBound || reference.range.to > upperBound);
  if (reference.path !== scope.path || selectionRangeMissing || rangeOutside) {
    throw protocolError(
      "AI_STREAM_EVENT_SCOPE_INVALID",
      "The AI reviewer returned data outside the requested document scope.",
    );
  }
}

function assertEvidenceForRequest(
  request: AgentRequest,
  evidence: EvidenceReference[],
) {
  for (const reference of evidence) {
    assertPathAndRangeWithinRequest(request, reference);
    if (
      request.scope.kind !== "project" &&
      ((reference.revision != null &&
        reference.revision !== request.scope.baseRevision) ||
        (reference.textHash != null &&
          reference.textHash !== request.scope.baseTextHash))
    ) {
      throw protocolError(
        "AI_STREAM_EVENT_SCOPE_INVALID",
        "The AI reviewer returned evidence for another document state.",
      );
    }
  }
}

function assertEventForRequest(request: AgentRequest, event: AgentEvent) {
  if (event.type === "started") {
    if (event.skill !== request.skill) {
      throw protocolError(
        "AI_STREAM_EVENT_SCOPE_INVALID",
        "The AI reviewer started with a different skill.",
      );
    }
    return;
  }

  if (event.type === "finding") {
    if (event.finding.projectId !== request.projectId) {
      throw protocolError(
        "AI_STREAM_EVENT_SCOPE_INVALID",
        "The AI reviewer returned a finding for another project.",
      );
    }
    assertEvidenceForRequest(request, event.finding.evidence);
    return;
  }

  if (event.type === "suggestion") {
    if (
      event.suggestion.projectId !== request.projectId ||
      event.suggestion.skill !== request.skill
    ) {
      throw protocolError(
        "AI_STREAM_EVENT_SCOPE_INVALID",
        "The AI reviewer returned a suggestion outside the active request.",
      );
    }
    if (request.scope.kind === "project") {
      throw protocolError(
        "AI_STREAM_EVENT_SCOPE_INVALID",
        "A project review cannot return edit suggestions.",
      );
    }
    try {
      prepareSingleDocumentSuggestion({
        request,
        suggestion: event.suggestion,
      });
    } catch {
      throw protocolError(
        "AI_STREAM_EVENT_SCOPE_INVALID",
        "The AI reviewer returned a suggestion outside the requested document scope.",
      );
    }
    return;
  }

  if (event.type === "tool.call") {
    assertPathAndRangeWithinRequest(request, event.call.arguments);
  }
}

async function streamAuthenticatedEvents<
  Request extends { projectId: string; requestId: string },
  Event extends StreamEnvelope,
>({
  boundRequest,
  endpoint,
  eventSchema,
  signal,
  onEvent,
  assertEvent,
  csrfToken,
  fetchImpl,
}: {
  boundRequest: Request;
  endpoint: string;
  eventSchema: RuntimeSchema<Event>;
  signal: AbortSignal;
  onEvent: (event: Event) => void;
  assertEvent: (request: Request, event: Event) => void;
  csrfToken: string;
  fetchImpl: typeof fetch;
}) {
  let response: Response;
  try {
    response = await waitWithAbort(
      Promise.resolve(
        fetchImpl(endpoint, {
          method: "POST",
          credentials: "same-origin",
          headers: {
            "Content-Type": "application/json",
            "X-Csrf-Token": csrfToken,
            Accept: "application/x-ndjson, application/json",
          },
          body: JSON.stringify(boundRequest),
          signal,
        }),
      ),
      signal,
    );
  } catch (error) {
    throw normalizeTransportError(error, signal);
  }

  throwIfAborted(signal);
  if (!response.ok) {
    throw await errorFromResponse(response, signal);
  }
  if (!response.headers.get("content-type")?.includes("application/x-ndjson")) {
    throw protocolError(
      "AI_STREAM_CONTENT_TYPE_INVALID",
      "The AI reviewer returned an invalid stream type.",
    );
  }
  if (response.body == null) {
    throw networkError(
      "AI_STREAM_BODY_MISSING",
      "The AI reviewer returned an empty stream.",
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let nextSequence = 0;
  let terminal = false;
  let failure: unknown;
  let failed = false;

  const consumeLine = (line: string) => {
    if (line.trim() === "") {
      return;
    }
    throwIfAborted(signal);
    if (terminal) {
      throw protocolError(
        "AI_STREAM_AFTER_TERMINAL",
        "The AI reviewer returned data after a terminal event.",
      );
    }

    let rawEvent: unknown;
    try {
      rawEvent = JSON.parse(line);
    } catch {
      throw protocolError(
        "AI_STREAM_JSON_INVALID",
        "The AI reviewer returned malformed stream data.",
      );
    }
    const parsed = eventSchema.safeParse(rawEvent);
    if (
      !parsed.success ||
      parsed.data.requestId !== boundRequest.requestId ||
      parsed.data.sequence !== nextSequence
    ) {
      throw protocolError(
        "AI_STREAM_EVENT_INVALID",
        "The AI reviewer returned an invalid stream event.",
      );
    }

    assertEvent(boundRequest, parsed.data);
    nextSequence += 1;
    terminal = parsed.data.type === "completed" || parsed.data.type === "error";
    onEvent(parsed.data);
    throwIfAborted(signal);
  };

  try {
    while (true) {
      throwIfAborted(signal);
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await waitWithAbort(reader.read(), signal);
      } catch (error) {
        throw normalizeTransportError(error, signal);
      }
      const { done, value } = result;
      throwIfAborted(signal);
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        consumeLine(line);
      }
      if (done) {
        break;
      }
    }
    consumeLine(buffer);
    if (!terminal) {
      throw networkError(
        "AI_STREAM_INCOMPLETE",
        "The AI reviewer stream ended before completion.",
      );
    }
  } catch (error) {
    failed = true;
    failure = signal.aborted ? signal.reason : error;
    cancelReaderWithoutWaiting(reader, failure);
  }
  try {
    reader.releaseLock();
  } catch (error) {
    if (!failed) {
      failed = true;
      failure = normalizeTransportError(error, signal);
    }
  }
  if (failed) {
    throw failure;
  }
}

export async function streamAgentEvents({
  projectId,
  request,
  signal,
  onEvent,
  csrfToken = getMeta("ol-csrfToken"),
  fetchImpl = fetch,
}: StreamAgentEventsOptions) {
  throwIfAborted(signal);
  const parsedRequest = AgentRequestSchema.safeParse(request);
  if (!parsedRequest.success || parsedRequest.data.projectId !== projectId) {
    throw protocolError(
      "AI_STREAM_REQUEST_INVALID",
      "The AI reviewer request does not match the active project.",
    );
  }
  const boundRequest = parsedRequest.data;
  await streamAuthenticatedEvents({
    boundRequest,
    endpoint: `/project/${encodeURIComponent(boundRequest.projectId)}/ai-reviewer/stream`,
    eventSchema: AgentEventSchema,
    signal,
    onEvent,
    assertEvent: assertEventForRequest,
    csrfToken,
    fetchImpl,
  });
}

function assertDiscussionEventForRequest(
  request: DiscussionRequest,
  event: DiscussionEvent,
) {
  if (event.type !== "suggestion") {
    return;
  }

  const sourceRequest = request.subject.sourceRequest;
  if (sourceRequest.scope.kind === "project") {
    throw protocolError(
      "AI_DISCUSSION_EVENT_SCOPE_INVALID",
      "A project discussion cannot return edit suggestions.",
    );
  }
  try {
    prepareSingleDocumentSuggestion({
      request: sourceRequest,
      suggestion: event.suggestion,
    });
  } catch {
    throw protocolError(
      "AI_DISCUSSION_EVENT_SCOPE_INVALID",
      "The AI reviewer returned a discussion suggestion outside the subject scope.",
    );
  }
}

export async function streamDiscussionEvents({
  projectId,
  request,
  signal,
  onEvent,
  csrfToken = getMeta("ol-csrfToken"),
  fetchImpl = fetch,
}: StreamDiscussionEventsOptions) {
  throwIfAborted(signal);
  const parsedRequest = DiscussionRequestSchema.safeParse(request);
  if (!parsedRequest.success || parsedRequest.data.projectId !== projectId) {
    throw protocolError(
      "AI_DISCUSSION_REQUEST_INVALID",
      "The AI reviewer discussion does not match the active project.",
    );
  }
  const boundRequest = parsedRequest.data;
  await streamAuthenticatedEvents({
    boundRequest,
    endpoint: `/project/${encodeURIComponent(boundRequest.projectId)}/ai-reviewer/discussion-stream`,
    eventSchema: DiscussionEventSchema,
    signal,
    onEvent,
    assertEvent: assertDiscussionEventForRequest,
    csrfToken,
    fetchImpl,
  });
}
