import { useProjectContext } from "@/shared/context/project-context";
import { useCallback, useEffect, useRef, useState } from "react";
import { v4 as uuid } from "uuid";

import type { AgentEvent, AgentRequest } from "../../../shared/contract-types";
import { AgentStreamError, streamAgentEvents } from "../services/agent-stream";

type ReviewState =
  | { status: "idle"; text: ""; error: null }
  | { status: "streaming"; text: string; error: null }
  | { status: "completed"; text: string; error: null }
  | { status: "cancelled"; text: string; error: null }
  | { status: "error"; text: string; error: string };

type StreamRequest = typeof streamAgentEvents;

const statusLabels: Record<ReviewState["status"], string> = {
  idle: "Ready",
  streaming: "Streaming",
  completed: "Completed",
  cancelled: "Cancelled",
  error: "Error",
};

export function AiReviewerPanelView({
  projectId,
  createRequestId = uuid,
  streamRequest = streamAgentEvents,
}: {
  projectId: string;
  createRequestId?: () => string;
  streamRequest?: StreamRequest;
}) {
  const [instruction, setInstruction] = useState(
    "Review this project and identify the most important issue.",
  );
  const [state, setState] = useState<ReviewState>({
    status: "idle",
    text: "",
    error: null,
  });
  const activeRequest = useRef<{
    id: string;
    controller: AbortController;
  } | null>(null);

  const cancel = useCallback(() => {
    const active = activeRequest.current;
    if (active == null) {
      return;
    }
    activeRequest.current = null;
    active.controller.abort(
      new DOMException("The review was cancelled.", "AbortError"),
    );
    setState((current) => ({
      status: "cancelled",
      text: current.text,
      error: null,
    }));
  }, []);

  useEffect(() => cancel, [cancel]);

  const run = useCallback(() => {
    cancel();

    const requestId = createRequestId();
    const controller = new AbortController();
    activeRequest.current = {
      id: requestId,
      controller,
    };
    setState({
      status: "streaming",
      text: "",
      error: null,
    });

    const request: AgentRequest = {
      requestId,
      projectId,
      action: "review",
      instruction,
      skill: "referee-review",
      scope: {
        kind: "project",
      },
    };

    const onEvent = (event: AgentEvent) => {
      if (
        controller.signal.aborted ||
        activeRequest.current?.id !== requestId ||
        event.requestId !== requestId
      ) {
        return;
      }
      setState((current) => {
        if (event.type === "text.delta") {
          return {
            status: "streaming",
            text: `${current.text}${event.delta}`,
            error: null,
          };
        }
        if (event.type === "completed") {
          return {
            status: "completed",
            text: current.text,
            error: null,
          };
        }
        if (event.type === "error") {
          return {
            status: "error",
            text: current.text,
            error: event.error.message,
          };
        }
        return current;
      });
    };

    void streamRequest({
      projectId,
      request,
      signal: controller.signal,
      onEvent,
    })
      .catch((error: unknown) => {
        if (
          controller.signal.aborted ||
          activeRequest.current?.id !== requestId
        ) {
          return;
        }
        setState((current) => ({
          status: "error",
          text: current.text,
          error:
            error instanceof AgentStreamError
              ? error.message
              : "The AI reviewer request failed.",
        }));
      })
      .finally(() => {
        if (activeRequest.current?.id === requestId) {
          activeRequest.current = null;
        }
      });
  }, [cancel, createRequestId, instruction, projectId, streamRequest]);

  return (
    <section aria-label="AI reviewer" className="p-3">
      <h2 className="h4">AI reviewer</h2>
      <label className="form-label" htmlFor="ai-reviewer-instruction">
        Review instruction
      </label>
      <textarea
        id="ai-reviewer-instruction"
        className="form-control"
        value={instruction}
        disabled={state.status === "streaming"}
        onChange={(event) => setInstruction(event.target.value)}
      />
      <div className="d-flex gap-2 mt-2">
        <button
          type="button"
          className="btn btn-primary"
          disabled={
            state.status === "streaming" || instruction.trim().length === 0
          }
          onClick={run}
        >
          Run review
        </button>
        {state.status === "streaming" && (
          <button type="button" className="btn btn-secondary" onClick={cancel}>
            Cancel
          </button>
        )}
      </div>
      <p className="mt-2" aria-live="polite">
        {statusLabels[state.status]}
      </p>
      {state.text !== "" && <pre className="text-wrap">{state.text}</pre>}
      {state.error != null && (
        <div className="alert alert-danger" role="alert">
          {state.error}
        </div>
      )}
    </section>
  );
}

export default function AiReviewerPanel() {
  const { projectId } = useProjectContext();
  return <AiReviewerPanelView projectId={projectId} />;
}
