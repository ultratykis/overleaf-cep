import { useProjectContext } from "@/shared/context/project-context";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { v4 as uuid } from "uuid";

import type {
  AgentEvent,
  AgentRequest,
  Finding,
  ProposedSuggestion,
} from "../../../shared/contract-types";
import {
  AiReviewerSuggestionPreview,
  type ApplySelectionSuggestion,
  type MountSuggestionPreview,
  type RegisterSuggestionPreviewLease,
  type SuggestionPreviewDisposer,
} from "./ai-reviewer-suggestion-preview";
import { useEditorSelectionSessionContext } from "../hooks/use-editor-selection-session-context";
import { AgentStreamError, streamAgentEvents } from "../services/agent-stream";
import {
  createEditorEvidenceNavigationTarget,
  navigateToEditorEvidence,
  type EditorEvidenceNavigationResult,
  type EditorEvidenceNavigationTarget,
} from "../services/editor-evidence-navigation";
import {
  captureEditorSelectionSession,
  type EditorSelectionSession,
  type EditorSelectionSessionAction,
  type EditorSelectionSessionContext,
  type EditorSelectionSessionResult,
} from "../services/editor-selection-session";
import {
  initialSelectionWorkspaceState,
  reduceSelectionWorkspaceState,
  type SelectionSuggestionDecision,
  type SelectionWorkspaceStatus,
} from "../services/selection-workspace-state";

type StreamRequest = typeof streamAgentEvents;
type NavigateEvidence = typeof navigateToEditorEvidence;
type CaptureSelectionRequest = {
  requestId: string;
  action: EditorSelectionSessionAction;
  instruction: string;
};
type CaptureSelectionSession = (
  request: CaptureSelectionRequest,
) => Promise<EditorSelectionSessionResult>;

type ActiveRun = {
  generation: number;
  requestId: string;
  controller: AbortController;
  invalidated: boolean;
  terminal: "completed" | "error" | null;
  session: EditorSelectionSession | null;
  findingIds: Set<string>;
  suggestionIds: Set<string>;
  referencedSuggestionIds: Set<string>;
};

type ActiveSuggestionPreview = {
  generation: number;
  requestId: string;
  session: EditorSelectionSession;
  suggestion: ProposedSuggestion;
};

type ActiveSuggestionLease = {
  dispose: SuggestionPreviewDisposer;
};

type ActiveEvidenceNavigation = {
  generation: number;
  requestId: string;
  session: EditorSelectionSession;
  finding: Finding;
  evidenceIndex: number;
  target: EditorEvidenceNavigationTarget;
  controller: AbortController;
};

type EvidenceNavigationNotice =
  | {
      identity: ActiveEvidenceNavigation;
      status: "pending";
    }
  | {
      identity: ActiveEvidenceNavigation;
      status: "settled";
      result: EditorEvidenceNavigationResult;
    };

const statusLabels: Record<SelectionWorkspaceStatus, string> = {
  idle: "Ready",
  capturing: "Capturing selection",
  streaming: "Streaming",
  finalizing: "Finalizing",
  completed: "Completed",
  conflict: "Conflict",
  cancelled: "Cancelled",
  error: "Error",
};

const selectionActions: Array<{
  action: EditorSelectionSessionAction;
  label: string;
}> = [
  {
    action: "review",
    label: "Review selection",
  },
  {
    action: "rewrite",
    label: "Rewrite selection",
  },
  {
    action: "shorten",
    label: "Shorten selection",
  },
];

function cancellationReason(message: string) {
  return new DOMException(message, "AbortError");
}

function streamErrorMessage(error: unknown) {
  return error instanceof AgentStreamError
    ? error.message
    : "The AI reviewer request failed.";
}

function evidenceLocation(reference: {
  path: string;
  range?: {
    from: number;
    to: number;
  };
}) {
  return reference.range == null
    ? reference.path
    : `${reference.path}:${reference.range.from}-${reference.range.to}`;
}

function evidenceNavigationMessage(notice: EvidenceNavigationNotice) {
  if (notice.status === "pending") {
    return "Selecting evidence";
  }
  if (notice.result.status === "navigated") {
    return "Evidence selected";
  }
  if (notice.result.status === "conflict") {
    return `Evidence unavailable: ${notice.result.code}`;
  }
  if (notice.result.status === "cancelled") {
    return "Evidence navigation cancelled";
  }
  return `Evidence navigation failed: ${notice.result.code}`;
}

function normalizeEvidenceNavigationResult(
  result: unknown,
): EditorEvidenceNavigationResult {
  if (typeof result !== "object" || result == null) {
    return {
      status: "error",
      code: "AI_EVIDENCE_NAVIGATION_FAILED",
    };
  }
  const candidate = result as {
    status?: unknown;
    code?: unknown;
  };
  if (candidate.status === "navigated") {
    return {
      status: "navigated",
    };
  }
  if (candidate.status === "cancelled") {
    return {
      status: "cancelled",
    };
  }
  if (candidate.status === "conflict") {
    switch (candidate.code) {
      case "AI_EVIDENCE_DOCUMENT_MISMATCH":
      case "AI_EVIDENCE_EDITOR_UNAVAILABLE":
      case "AI_EVIDENCE_PATH_MISMATCH":
      case "AI_EVIDENCE_PERMISSION_DENIED":
      case "AI_EVIDENCE_PROJECT_MISMATCH":
      case "AI_EVIDENCE_RANGE_INVALID":
      case "AI_EVIDENCE_REFERENCE_INVALID":
      case "AI_EVIDENCE_STATE_STALE":
        return {
          status: "conflict",
          code: candidate.code,
        };
    }
  }
  if (candidate.status === "error") {
    switch (candidate.code) {
      case "AI_EVIDENCE_HASH_FAILED":
      case "AI_EVIDENCE_NAVIGATION_FAILED":
        return {
          status: "error",
          code: candidate.code,
        };
    }
  }
  return {
    status: "error",
    code: "AI_EVIDENCE_NAVIGATION_FAILED",
  };
}

function suggestionDecision(
  decisions: Readonly<Record<string, SelectionSuggestionDecision | undefined>>,
  suggestionId: string,
) {
  return Object.prototype.hasOwnProperty.call(decisions, suggestionId)
    ? decisions[suggestionId]
    : undefined;
}

export function AiReviewerPanelView({
  projectId,
  createRequestId = uuid,
  streamRequest = streamAgentEvents,
  captureSelectionSession,
  getSelectionContext,
  navigateEvidence = navigateToEditorEvidence,
  mountSuggestionPreview,
  applySelectionSuggestion,
}: {
  projectId: string;
  createRequestId?: () => string;
  streamRequest?: StreamRequest;
  captureSelectionSession?: CaptureSelectionSession;
  getSelectionContext?: () => EditorSelectionSessionContext;
  navigateEvidence?: NavigateEvidence;
  mountSuggestionPreview?: MountSuggestionPreview;
  applySelectionSuggestion?: ApplySelectionSuggestion;
}) {
  const [instruction, setInstruction] = useState(
    "Review this project and identify the most important issue.",
  );
  const [state, dispatch] = useReducer(
    reduceSelectionWorkspaceState,
    initialSelectionWorkspaceState,
  );
  const [activeSuggestionPreview, setActiveSuggestionPreview] =
    useState<ActiveSuggestionPreview | null>(null);
  const [evidenceNavigationNotice, setEvidenceNavigationNotice] =
    useState<EvidenceNavigationNotice | null>(null);
  const activeRun = useRef<ActiveRun | null>(null);
  const activeSuggestionIdentity = useRef<ActiveSuggestionPreview | null>(null);
  const activeSuggestionLease = useRef<ActiveSuggestionLease | null>(null);
  const activeEvidenceNavigation = useRef<ActiveEvidenceNavigation | null>(
    null,
  );
  const nextGeneration = useRef(0);
  const mounted = useRef(true);

  const invalidateRun = useCallback((run: ActiveRun, reason: unknown) => {
    run.invalidated = true;
    if (activeRun.current === run) {
      activeRun.current = null;
    }
    if (!run.controller.signal.aborted) {
      run.controller.abort(reason);
    }
  }, []);

  const disposeActiveSuggestion = useCallback((reason: unknown) => {
    const activeLease = activeSuggestionLease.current;
    activeSuggestionLease.current = null;
    if (activeLease != null) {
      activeLease.dispose(reason);
    }
    activeSuggestionIdentity.current = null;
    if (mounted.current) {
      setActiveSuggestionPreview(null);
    }
  }, []);

  const disposeActiveEvidenceNavigation = useCallback((reason: unknown) => {
    const activeNavigation = activeEvidenceNavigation.current;
    activeEvidenceNavigation.current = null;
    if (
      activeNavigation != null &&
      !activeNavigation.controller.signal.aborted
    ) {
      activeNavigation.controller.abort(reason);
    }
    if (mounted.current) {
      setEvidenceNavigationNotice(null);
    }
  }, []);

  const registerSuggestionLease = useCallback(
    (identity: ActiveSuggestionPreview, dispose: SuggestionPreviewDisposer) => {
      if (activeSuggestionIdentity.current !== identity) {
        dispose(
          cancellationReason("The suggestion preview is no longer active."),
        );
        return () => {};
      }

      const previous = activeSuggestionLease.current;
      const lease = {
        dispose,
      };
      activeSuggestionLease.current = lease;
      if (previous != null && previous !== lease) {
        previous.dispose(
          cancellationReason("The suggestion preview was replaced."),
        );
      }
      return () => {
        if (activeSuggestionLease.current === lease) {
          activeSuggestionLease.current = null;
        }
      };
    },
    [],
  );

  const isActiveRun = useCallback(
    (run: ActiveRun) =>
      mounted.current && activeRun.current === run && !run.invalidated,
    [],
  );

  const beginRun = useCallback(
    (status: "capturing" | "streaming") => {
      disposeActiveEvidenceNavigation(
        cancellationReason("The evidence navigation was replaced."),
      );
      disposeActiveSuggestion(
        cancellationReason("The review was replaced by a new request."),
      );
      const previous = activeRun.current;
      if (previous != null) {
        invalidateRun(
          previous,
          cancellationReason("The review was replaced by a new request."),
        );
      }

      const run: ActiveRun = {
        generation: nextGeneration.current + 1,
        requestId: createRequestId(),
        controller: new AbortController(),
        invalidated: false,
        terminal: null,
        session: null,
        findingIds: new Set(),
        suggestionIds: new Set(),
        referencedSuggestionIds: new Set(),
      };
      nextGeneration.current = run.generation;
      activeRun.current = run;
      dispatch({
        type: "begin",
        status,
        generation: run.generation,
        requestId: run.requestId,
      });
      return run;
    },
    [
      createRequestId,
      disposeActiveEvidenceNavigation,
      disposeActiveSuggestion,
      invalidateRun,
    ],
  );

  const failRun = useCallback(
    (run: ActiveRun, code: string, message: string) => {
      if (!isActiveRun(run)) {
        return;
      }
      run.terminal = "error";
      const error = new AgentStreamError({
        code,
        category: "schema",
        message,
        retryable: false,
      });
      invalidateRun(run, error);
      if (mounted.current) {
        dispatch({
          type: "error",
          generation: run.generation,
          requestId: run.requestId,
          error: message,
        });
      }
    },
    [invalidateRun, isActiveRun],
  );

  const cancel = useCallback(() => {
    const run = activeRun.current;
    if (run == null) {
      return;
    }
    invalidateRun(run, cancellationReason("The review was cancelled."));
    if (mounted.current) {
      dispatch({
        type: "cancelled",
        generation: run.generation,
        requestId: run.requestId,
      });
    }
  }, [invalidateRun]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      disposeActiveEvidenceNavigation(
        cancellationReason("The AI reviewer panel was closed."),
      );
      disposeActiveSuggestion(
        cancellationReason("The AI reviewer panel was closed."),
      );
      const run = activeRun.current;
      if (run != null) {
        invalidateRun(
          run,
          cancellationReason("The AI reviewer panel was closed."),
        );
      }
    };
  }, [disposeActiveEvidenceNavigation, disposeActiveSuggestion, invalidateRun]);

  const executeStream = useCallback(
    async (run: ActiveRun, request: AgentRequest) => {
      const onEvent = (event: AgentEvent) => {
        if (!isActiveRun(run) || run.controller.signal.aborted) {
          return;
        }
        if (event.requestId !== run.requestId) {
          failRun(
            run,
            "AI_WORKSPACE_EVENT_REQUEST_MISMATCH",
            "The AI reviewer returned an event for another request.",
          );
          return;
        }
        if (run.terminal != null) {
          failRun(
            run,
            "AI_WORKSPACE_EVENT_AFTER_TERMINAL",
            "The AI reviewer returned data after a terminal event.",
          );
          return;
        }
        if (event.type === "finding") {
          if (run.findingIds.has(event.finding.id)) {
            failRun(
              run,
              "AI_WORKSPACE_DUPLICATE_FINDING",
              "The AI reviewer returned a duplicate finding identity.",
            );
            return;
          }
          run.findingIds.add(event.finding.id);
          for (const suggestionId of event.finding.suggestionIds) {
            run.referencedSuggestionIds.add(suggestionId);
          }
        }
        if (event.type === "suggestion") {
          if (run.suggestionIds.has(event.suggestion.id)) {
            failRun(
              run,
              "AI_WORKSPACE_DUPLICATE_SUGGESTION",
              "The AI reviewer returned a duplicate suggestion identity.",
            );
            return;
          }
          run.suggestionIds.add(event.suggestion.id);
        }
        if (event.type === "completed") {
          run.terminal = "completed";
        } else if (event.type === "error") {
          run.terminal = "error";
        }
        dispatch({
          type: "event",
          generation: run.generation,
          requestId: run.requestId,
          event,
        });
      };

      try {
        await streamRequest({
          projectId: request.projectId,
          request,
          signal: run.controller.signal,
          onEvent,
        });
        if (!isActiveRun(run) || run.controller.signal.aborted) {
          return;
        }
        if (run.terminal === "completed") {
          const missingSuggestion = [...run.referencedSuggestionIds].find(
            (suggestionId) => !run.suggestionIds.has(suggestionId),
          );
          if (missingSuggestion != null) {
            failRun(
              run,
              "AI_WORKSPACE_SUGGESTION_MISSING",
              "The AI reviewer referenced a missing suggestion.",
            );
            return;
          }
          dispatch({
            type: "completed",
            generation: run.generation,
            requestId: run.requestId,
          });
        } else if (run.terminal == null) {
          failRun(
            run,
            "AI_WORKSPACE_STREAM_INCOMPLETE",
            "The AI reviewer stream ended before completion.",
          );
        }
      } catch (error) {
        if (!isActiveRun(run) || run.controller.signal.aborted) {
          return;
        }
        failRun(
          run,
          error instanceof AgentStreamError
            ? error.details.code
            : "AI_WORKSPACE_STREAM_FAILED",
          streamErrorMessage(error),
        );
      } finally {
        if (activeRun.current === run) {
          activeRun.current = null;
        }
      }
    },
    [failRun, isActiveRun, streamRequest],
  );

  const runProjectReview = useCallback(() => {
    const instructionSnapshot = instruction;
    const run = beginRun("streaming");
    const request: AgentRequest = Object.freeze({
      requestId: run.requestId,
      projectId,
      action: "review",
      instruction: instructionSnapshot,
      skill: "referee-review",
      scope: Object.freeze({
        kind: "project",
      }),
    });

    void executeStream(run, request);
  }, [beginRun, executeStream, instruction, projectId]);

  const runSelectionReview = useCallback(
    async (action: EditorSelectionSessionAction) => {
      if (captureSelectionSession == null) {
        return;
      }
      const instructionSnapshot = instruction;
      const run = beginRun("capturing");

      let result: EditorSelectionSessionResult;
      try {
        result = await captureSelectionSession({
          requestId: run.requestId,
          action,
          instruction: instructionSnapshot,
        });
      } catch {
        failRun(
          run,
          "AI_WORKSPACE_CAPTURE_FAILED",
          "The editor selection could not be captured.",
        );
        return;
      }
      if (!isActiveRun(run) || run.controller.signal.aborted) {
        return;
      }
      if (result.status === "conflict") {
        invalidateRun(
          run,
          cancellationReason("The editor selection has a conflict."),
        );
        if (mounted.current) {
          dispatch({
            type: "conflict",
            generation: run.generation,
            requestId: run.requestId,
            conflict: result.code,
          });
        }
        return;
      }

      const session = result.session;
      const request = session.request;
      if (
        request.requestId !== run.requestId ||
        request.projectId !== projectId ||
        request.action !== action ||
        request.instruction !== instructionSnapshot ||
        request.scope.kind !== "selection"
      ) {
        failRun(
          run,
          "AI_WORKSPACE_CAPTURE_SCOPE_INVALID",
          "The captured selection does not match the active project and request.",
        );
        return;
      }

      run.session = session;
      dispatch({
        type: "session",
        generation: run.generation,
        requestId: run.requestId,
        session,
      });
      await executeStream(run, request);
    },
    [
      beginRun,
      captureSelectionSession,
      executeStream,
      failRun,
      instruction,
      invalidateRun,
      isActiveRun,
      projectId,
    ],
  );

  const openFindingEvidence = useCallback(
    (finding: Finding, evidenceIndex: number) => {
      const session = state.session;
      const requestId = state.requestId;
      if (
        state.status !== "completed" ||
        session == null ||
        requestId == null ||
        getSelectionContext == null ||
        nextGeneration.current !== state.generation ||
        session.request.scope.kind !== "selection" ||
        session.request.requestId !== requestId ||
        !state.findings.includes(finding)
      ) {
        return;
      }

      const target = createEditorEvidenceNavigationTarget({
        session,
        finding,
        evidenceIndex,
      });
      if (target == null) {
        return;
      }

      const previous = activeEvidenceNavigation.current;
      if (
        previous?.generation === state.generation &&
        previous.requestId === requestId &&
        previous.session === session &&
        previous.finding === finding &&
        previous.evidenceIndex === evidenceIndex
      ) {
        return;
      }

      disposeActiveEvidenceNavigation(
        cancellationReason("Another evidence reference was selected."),
      );
      const identity: ActiveEvidenceNavigation = {
        generation: state.generation,
        requestId,
        session,
        finding,
        evidenceIndex,
        target,
        controller: new AbortController(),
      };
      activeEvidenceNavigation.current = identity;
      setEvidenceNavigationNotice({
        identity,
        status: "pending",
      });

      void (async () => {
        let result: EditorEvidenceNavigationResult;
        try {
          result = normalizeEvidenceNavigationResult(
            await navigateEvidence({
              target,
              getContext: getSelectionContext,
              signal: identity.controller.signal,
            }),
          );
        } catch {
          result = {
            status: "error",
            code: "AI_EVIDENCE_NAVIGATION_FAILED",
          };
        }
        if (
          !mounted.current ||
          activeEvidenceNavigation.current !== identity ||
          identity.controller.signal.aborted
        ) {
          return;
        }
        activeEvidenceNavigation.current = null;
        setEvidenceNavigationNotice({
          identity,
          status: "settled",
          result,
        });
      })();
    },
    [
      disposeActiveEvidenceNavigation,
      getSelectionContext,
      navigateEvidence,
      state.findings,
      state.generation,
      state.requestId,
      state.session,
      state.status,
    ],
  );

  const busy =
    state.status === "capturing" ||
    state.status === "streaming" ||
    state.status === "finalizing";
  const instructionMissing = instruction.trim().length === 0;
  const activeLeaseRegistrar = useMemo<
    RegisterSuggestionPreviewLease | undefined
  >(() => {
    if (activeSuggestionPreview == null) {
      return undefined;
    }
    const identity = activeSuggestionPreview;
    return (dispose) => registerSuggestionLease(identity, dispose);
  }, [activeSuggestionPreview, registerSuggestionLease]);

  const openSuggestionPreview = useCallback(
    (suggestion: ProposedSuggestion) => {
      const session = state.session;
      const requestId = state.requestId;
      if (
        state.status !== "completed" ||
        session == null ||
        requestId == null ||
        getSelectionContext == null ||
        session.request.scope.kind !== "selection" ||
        session.request.requestId !== requestId ||
        suggestion.requestId !== requestId ||
        suggestionDecision(state.suggestionDecisions, suggestion.id) != null
      ) {
        return;
      }

      if (
        activeSuggestionIdentity.current?.generation === state.generation &&
        activeSuggestionIdentity.current.requestId === requestId &&
        activeSuggestionIdentity.current.session === session &&
        activeSuggestionIdentity.current.suggestion === suggestion
      ) {
        return;
      }

      disposeActiveSuggestion(
        cancellationReason("Another suggestion preview was selected."),
      );
      const identity = {
        generation: state.generation,
        requestId,
        session,
        suggestion,
      };
      activeSuggestionIdentity.current = identity;
      setActiveSuggestionPreview(identity);
    },
    [
      disposeActiveSuggestion,
      getSelectionContext,
      state.generation,
      state.requestId,
      state.session,
      state.status,
      state.suggestionDecisions,
    ],
  );

  const recordSuggestionDecision = useCallback(
    (
      identity: ActiveSuggestionPreview,
      decision: SelectionSuggestionDecision,
    ) => {
      if (activeSuggestionIdentity.current !== identity) {
        return;
      }
      disposeActiveSuggestion(
        cancellationReason("The suggestion preview reached a terminal state."),
      );
      if (mounted.current) {
        dispatch({
          type: "suggestion-decision",
          generation: identity.generation,
          requestId: identity.requestId,
          suggestionId: identity.suggestion.id,
          decision,
        });
      }
    },
    [disposeActiveSuggestion],
  );

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
        disabled={busy}
        onChange={(event) => setInstruction(event.target.value)}
      />
      <div className="d-flex flex-wrap gap-2 mt-2">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || instructionMissing}
          onClick={runProjectReview}
        >
          Run review
        </button>
        {captureSelectionSession != null &&
          selectionActions.map(({ action, label }) => (
            <button
              key={action}
              type="button"
              className="btn btn-primary"
              disabled={busy || instructionMissing}
              onClick={() => {
                void runSelectionReview(action);
              }}
            >
              {label}
            </button>
          ))}
        {busy && (
          <button type="button" className="btn btn-secondary" onClick={cancel}>
            Cancel
          </button>
        )}
      </div>
      <p className="mt-2" aria-live="polite">
        {statusLabels[state.status]}
      </p>
      {state.text !== "" && <pre className="text-wrap">{state.text}</pre>}
      {state.findings.length > 0 && (
        <section aria-label="Review findings">
          <h3 className="h5">Findings</h3>
          {state.findings.map((finding) => (
            <article key={finding.id}>
              <h4 className="h6">{finding.title}</h4>
              <p>{finding.message}</p>
              <ul>
                {finding.evidence.map((reference, index) => {
                  const navigationTarget =
                    state.status === "completed" &&
                    state.session != null &&
                    state.requestId != null &&
                    getSelectionContext != null &&
                    nextGeneration.current === state.generation &&
                    state.session.request.requestId === state.requestId
                      ? createEditorEvidenceNavigationTarget({
                          session: state.session,
                          finding,
                          evidenceIndex: index,
                        })
                      : null;
                  return (
                    <li key={`${finding.id}-evidence-${index}`}>
                      {evidenceLocation(reference)}
                      {navigationTarget != null && (
                        <button
                          type="button"
                          className="btn btn-link btn-sm"
                          onClick={() => openFindingEvidence(finding, index)}
                        >
                          Go to evidence {index + 1}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </article>
          ))}
          {evidenceNavigationNotice != null && (
            <p aria-live="polite">
              {evidenceNavigationMessage(evidenceNavigationNotice)}
            </p>
          )}
        </section>
      )}
      {state.suggestions.length > 0 && (
        <section aria-label="Review suggestions">
          <h3 className="h5">Suggestions</h3>
          {state.suggestions.map((suggestion, index) => {
            const decision = suggestionDecision(
              state.suggestionDecisions,
              suggestion.id,
            );
            const actionAvailable =
              state.status === "completed" &&
              state.session != null &&
              getSelectionContext != null &&
              state.session.request.scope.kind === "selection" &&
              state.session.request.requestId === state.requestId &&
              suggestion.requestId === state.requestId &&
              decision == null;
            const previewActive =
              activeSuggestionPreview != null &&
              activeSuggestionPreview.generation === state.generation &&
              activeSuggestionPreview.requestId === state.requestId &&
              activeSuggestionPreview.session === state.session &&
              activeSuggestionPreview.suggestion === suggestion;

            return (
              <article key={suggestion.id}>
                <p>Original: {suggestion.original}</p>
                <p>Replacement: {suggestion.replacement}</p>
                <p>Rationale: {suggestion.rationale}</p>
                <ul>
                  {suggestion.evidence.map((reference, index) => (
                    <li key={`${suggestion.id}-evidence-${index}`}>
                      {evidenceLocation(reference)}
                    </li>
                  ))}
                </ul>
                {actionAvailable && (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => openSuggestionPreview(suggestion)}
                  >
                    Preview suggestion {index + 1}
                  </button>
                )}
                {previewActive &&
                  activeSuggestionPreview != null &&
                  getSelectionContext != null && (
                    <AiReviewerSuggestionPreview
                      key={`${activeSuggestionPreview.generation}:${activeSuggestionPreview.requestId}:${suggestion.id}`}
                      session={activeSuggestionPreview.session}
                      suggestion={suggestion}
                      getContext={getSelectionContext}
                      mountPreview={mountSuggestionPreview}
                      applySuggestion={applySelectionSuggestion}
                      registerLease={activeLeaseRegistrar}
                      onDecision={(nextDecision) =>
                        recordSuggestionDecision(
                          activeSuggestionPreview,
                          nextDecision,
                        )
                      }
                    />
                  )}
                {decision != null && (
                  <p aria-live="polite">
                    {decision.status === "conflict"
                      ? `Conflict: ${decision.code}`
                      : decision.status === "applied"
                        ? "Applied"
                        : decision.status === "rejected"
                          ? "Rejected"
                          : decision.status === "cancelled"
                            ? "Cancelled"
                            : "Error"}
                  </p>
                )}
              </article>
            );
          })}
        </section>
      )}
      {state.conflict != null && (
        <div className="alert alert-warning" role="alert">
          Selection conflict: {state.conflict}
        </div>
      )}
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
  const getSelectionContext = useEditorSelectionSessionContext();
  const captureSelectionSession = useCallback(
    (request: CaptureSelectionRequest) =>
      captureEditorSelectionSession({
        ...request,
        getContext: getSelectionContext,
      }),
    [getSelectionContext],
  );

  return (
    <AiReviewerPanelView
      projectId={projectId}
      captureSelectionSession={captureSelectionSession}
      getSelectionContext={getSelectionContext}
    />
  );
}
