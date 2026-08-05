import getMeta from "@/utils/meta";

import {
  AgentErrorSchema,
  AgentEventSchema,
} from "../../../shared/contracts.mjs";
import type {
  AgentError,
  AgentEvent,
  AgentRequest,
} from "../../../shared/contract-types";

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

function genericStreamError(
  code: string,
  message: string,
  category: AgentError["category"] = "network",
): AgentStreamError {
  return new AgentStreamError({
    code,
    category,
    message,
    retryable: true,
  });
}

async function errorFromResponse(response: Response) {
  if (response.headers.get("content-type")?.includes("application/json")) {
    const body = await response.json().catch(() => null);
    const parsed = AgentErrorSchema.safeParse(body?.error);
    if (parsed.success) {
      return new AgentStreamError(parsed.data);
    }
  }
  return genericStreamError(
    "AI_HTTP_ERROR",
    `The AI reviewer request failed with HTTP ${response.status}.`,
  );
}

export async function streamAgentEvents({
  projectId,
  request,
  signal,
  onEvent,
  csrfToken = getMeta("ol-csrfToken"),
  fetchImpl = fetch,
}: StreamAgentEventsOptions) {
  const response = await fetchImpl(
    `/project/${encodeURIComponent(projectId)}/ai-reviewer/stream`,
    {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-Csrf-Token": csrfToken,
        Accept: "application/x-ndjson, application/json",
      },
      body: JSON.stringify(request),
      signal,
    },
  );

  if (!response.ok) {
    throw await errorFromResponse(response);
  }
  if (!response.headers.get("content-type")?.includes("application/x-ndjson")) {
    throw genericStreamError(
      "AI_STREAM_CONTENT_TYPE_INVALID",
      "The AI reviewer returned an invalid stream type.",
      "schema",
    );
  }
  if (response.body == null) {
    throw genericStreamError(
      "AI_STREAM_BODY_MISSING",
      "The AI reviewer returned an empty stream.",
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let nextSequence = 0;
  let terminal = false;

  const consumeLine = (line: string) => {
    if (line.trim() === "") {
      return;
    }
    let rawEvent: unknown;
    try {
      rawEvent = JSON.parse(line);
    } catch {
      throw genericStreamError(
        "AI_STREAM_JSON_INVALID",
        "The AI reviewer returned malformed stream data.",
        "schema",
      );
    }
    const parsed = AgentEventSchema.safeParse(rawEvent);
    if (
      !parsed.success ||
      parsed.data.requestId !== request.requestId ||
      parsed.data.sequence !== nextSequence
    ) {
      throw genericStreamError(
        "AI_STREAM_EVENT_INVALID",
        "The AI reviewer returned an invalid stream event.",
        "schema",
      );
    }
    if (terminal) {
      throw genericStreamError(
        "AI_STREAM_AFTER_TERMINAL",
        "The AI reviewer returned data after a terminal event.",
        "schema",
      );
    }

    nextSequence += 1;
    terminal = parsed.data.type === "completed" || parsed.data.type === "error";
    onEvent(parsed.data);
  };

  try {
    while (true) {
      if (signal.aborted) {
        throw signal.reason;
      }
      const { done, value } = await reader.read();
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
      throw genericStreamError(
        "AI_STREAM_INCOMPLETE",
        "The AI reviewer stream ended before completion.",
      );
    }
  } finally {
    reader.releaseLock();
  }
}
