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
  DiscussionEvent,
  DiscussionRequest,
  DiscussionSubject,
  DiscussionTurn,
  Finding,
  ProposedSuggestion,
} from "../../../shared/contract-types";
import { DISCUSSION_CONTEXT_TURN_LIMIT } from "../../../shared/contracts.mjs";
import {
  AiReviewerSuggestionPreview,
  type ApplySelectionSuggestion,
  type MountSuggestionPreview,
  type RegisterSuggestionPreviewLease,
  type SuggestionPreviewDisposer,
} from "./ai-reviewer-suggestion-preview";
import { useEditorSelectionSessionContext } from "../hooks/use-editor-selection-session-context";
import {
  AgentStreamError,
  streamAgentEvents,
  streamDiscussionEvents,
} from "../services/agent-stream";
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
  initialReviewWorkspaceState,
  reduceReviewWorkspaceState,
  type FindingArtifactStatus,
  type SelectionWorkspaceState,
  type SelectionSuggestionDecision,
  type SelectionWorkspaceStatus,
  type SuggestionArtifactStatus,
} from "../services/selection-workspace-state";

type StreamRequest = typeof streamAgentEvents;
type StreamDiscussionRequest = typeof streamDiscussionEvents;
type NavigateEvidence = typeof navigateToEditorEvidence;
type CaptureSelectionRequest = {
  requestId: string;
  action: EditorSelectionSessionAction;
  instruction: string;
};
type CaptureSelectionSession = (
  request: CaptureSelectionRequest,
) => Promise<EditorSelectionSessionResult>;
type CitationFinding = Extract<Finding, { artifactKind: "citation-finding" }>;
type CopyText = (text: string) => Promise<void>;

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
  discussionId: string | null;
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

type CitationCopyNotice = {
  generation: number;
  requestId: string;
  finding: CitationFinding;
  status: "copying" | "copied" | "error";
};

type DiscussionStatus = "idle" | "streaming" | "error";

type Discussion = {
  id: string;
  createdOrder: number;
  subjectKey: string;
  subject: DiscussionSubject;
  subjectLabel: string;
  sourceGeneration: number;
  sourceSession: EditorSelectionSession | null;
  turns: DiscussionTurn[];
  suggestions: ProposedSuggestion[];
  suggestionStatuses: Readonly<
    Record<string, SuggestionArtifactStatus | undefined>
  >;
  suggestionConflictCodes: Readonly<Record<string, string | undefined>>;
  status: DiscussionStatus;
  error: string | null;
  updatedAt: string;
};

type ActiveDiscussionRequest = {
  discussionId: string;
  requestId: string;
  controller: AbortController;
  terminal: "completed" | "error" | null;
  suggestionIds: Set<string>;
};

const statusLabels: Record<SelectionWorkspaceStatus, string> = {
  idle: "Ready",
  capturing: "Capturing review target",
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
  instruction: string;
}> = [
  {
    action: "review",
    label: "Review selection",
    instruction: "Review the selected phrase.",
  },
  {
    action: "rewrite",
    label: "Rewrite selection",
    instruction: "Rewrite the selected phrase.",
  },
  {
    action: "shorten",
    label: "Shorten selection",
    instruction: "Shorten the selected phrase.",
  },
];

const projectReviewInstruction =
  "Review this project and identify the most important issue.";
const documentReviewInstruction = "Review the current document.";

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

function findingStatus(
  statuses: Readonly<Record<string, FindingArtifactStatus | undefined>>,
  findingId: string,
): FindingArtifactStatus {
  return Object.prototype.hasOwnProperty.call(statuses, findingId)
    ? (statuses[findingId] ?? "unresolved")
    : "unresolved";
}

function suggestionStatus(
  statuses: Readonly<Record<string, SuggestionArtifactStatus | undefined>>,
  suggestionId: string,
): SuggestionArtifactStatus {
  return Object.prototype.hasOwnProperty.call(statuses, suggestionId)
    ? (statuses[suggestionId] ?? "unresolved")
    : "unresolved";
}

function artifactStatusLabel(
  status: FindingArtifactStatus | SuggestionArtifactStatus,
) {
  switch (status) {
    case "unresolved":
      return "Unresolved";
    case "applied":
      return "Applied";
    case "discarded":
      return "Discarded";
    case "conflict":
      return "Conflict";
  }
}

function reviewScopeLabel(scopeKind: AgentRequest["scope"]["kind"] | null) {
  switch (scopeKind) {
    case "selection":
      return "Selection";
    case "document":
      return "Current document";
    case "project":
      return "Project";
    default:
      return "Review scope";
  }
}

function discussionSubjectLabel(subject: DiscussionSubject) {
  switch (subject.kind) {
    case "finding":
      return `Finding: ${subject.artifact.title}`;
    case "citation-finding":
      return `Citation finding: ${subject.artifact.title}`;
    case "suggestion":
      return `Suggestion: ${subject.artifact.rationale}`;
    case "scope":
      return `Scope: ${reviewScopeLabel(subject.sourceRequest.scope.kind)}`;
  }
}

function isTerminalArtifactStatus(
  status: FindingArtifactStatus | SuggestionArtifactStatus,
) {
  return status !== "unresolved";
}

async function copyTextToClipboard(text: string) {
  if (globalThis.navigator?.clipboard?.writeText == null) {
    throw new Error("Clipboard access is unavailable.");
  }
  await globalThis.navigator.clipboard.writeText(text);
}

export function AiReviewerPanelView({
  projectId,
  createRequestId = uuid,
  createDiscussionId = uuid,
  createDiscussionRequestId = uuid,
  now = () => new Date().toISOString(),
  streamRequest = streamAgentEvents,
  streamDiscussionRequest = streamDiscussionEvents,
  captureSelectionSession,
  captureDocumentSession,
  getSelectionContext,
  navigateEvidence = navigateToEditorEvidence,
  mountSuggestionPreview,
  applySelectionSuggestion,
  copyText = copyTextToClipboard,
}: {
  projectId: string;
  createRequestId?: () => string;
  createDiscussionId?: () => string;
  createDiscussionRequestId?: () => string;
  now?: () => string;
  streamRequest?: StreamRequest;
  streamDiscussionRequest?: StreamDiscussionRequest;
  captureSelectionSession?: CaptureSelectionSession;
  captureDocumentSession?: CaptureSelectionSession;
  getSelectionContext?: () => EditorSelectionSessionContext;
  navigateEvidence?: NavigateEvidence;
  mountSuggestionPreview?: MountSuggestionPreview;
  applySelectionSuggestion?: ApplySelectionSuggestion;
  copyText?: CopyText;
}) {
  const [workspace, dispatch] = useReducer(
    reduceReviewWorkspaceState,
    initialReviewWorkspaceState,
  );
  const [discussions, setDiscussions] = useState<Discussion[]>([]);
  const [activeDiscussionId, setActiveDiscussionId] = useState<string | null>(
    null,
  );
  const [discussionInput, setDiscussionInput] = useState("");
  const [activeSuggestionPreview, setActiveSuggestionPreview] =
    useState<ActiveSuggestionPreview | null>(null);
  const [evidenceNavigationNotice, setEvidenceNavigationNotice] =
    useState<EvidenceNavigationNotice | null>(null);
  const [citationCopyNotice, setCitationCopyNotice] =
    useState<CitationCopyNotice | null>(null);
  const activeRun = useRef<ActiveRun | null>(null);
  const activeSuggestionIdentity = useRef<ActiveSuggestionPreview | null>(null);
  const activeSuggestionLease = useRef<ActiveSuggestionLease | null>(null);
  const activeEvidenceNavigation = useRef<ActiveEvidenceNavigation | null>(
    null,
  );
  const activeCitationCopy = useRef<CitationCopyNotice | null>(null);
  const activeDiscussionRequest = useRef<ActiveDiscussionRequest | null>(null);
  const discussionsRef = useRef<Discussion[]>([]);
  const nextGeneration = useRef(0);
  const nextWorkspaceOrder = useRef(0);
  const mounted = useRef(true);

  const updateDiscussions = useCallback(
    (update: (current: Discussion[]) => Discussion[]) => {
      setDiscussions((current) => {
        const next = update(current);
        discussionsRef.current = next;
        return next;
      });
    },
    [],
  );

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

  const clearCitationCopy = useCallback(() => {
    activeCitationCopy.current = null;
    if (mounted.current) {
      setCitationCopyNotice(null);
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
    (
      status: "capturing" | "streaming",
      scopeKind: AgentRequest["scope"]["kind"],
    ) => {
      clearCitationCopy();
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
      nextWorkspaceOrder.current += 1;
      activeRun.current = run;
      dispatch({
        type: "begin",
        status,
        generation: run.generation,
        requestId: run.requestId,
        scopeKind,
        createdOrder: nextWorkspaceOrder.current,
      });
      return run;
    },
    [
      createRequestId,
      clearCitationCopy,
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
      activeCitationCopy.current = null;
      const discussionRequest = activeDiscussionRequest.current;
      activeDiscussionRequest.current = null;
      if (
        discussionRequest != null &&
        !discussionRequest.controller.signal.aborted
      ) {
        discussionRequest.controller.abort(
          cancellationReason("The AI reviewer panel was closed."),
        );
      }
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
        if (event.type === "suggestion" && request.scope.kind === "project") {
          failRun(
            run,
            "AI_PROJECT_SUGGESTION_NOT_ALLOWED",
            "A project review cannot return edit suggestions.",
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
    const run = beginRun("streaming", "project");
    const request: AgentRequest = Object.freeze({
      requestId: run.requestId,
      projectId,
      action: "review",
      instruction: projectReviewInstruction,
      skill: "referee-review",
      scope: Object.freeze({
        kind: "project",
      }),
    });

    dispatch({
      type: "request",
      generation: run.generation,
      requestId: run.requestId,
      request,
    });
    void executeStream(run, request);
  }, [beginRun, executeStream, projectId]);

  const runDocumentBoundReview = useCallback(
    async ({
      action,
      instruction,
      captureSession,
      scopeKind,
    }: {
      action: EditorSelectionSessionAction;
      instruction: string;
      captureSession: CaptureSelectionSession | undefined;
      scopeKind: "selection" | "document";
    }) => {
      if (captureSession == null) {
        return;
      }
      const instructionSnapshot = instruction;
      const run = beginRun("capturing", scopeKind);

      let result: EditorSelectionSessionResult;
      try {
        result = await captureSession({
          requestId: run.requestId,
          action,
          instruction: instructionSnapshot,
        });
      } catch {
        failRun(
          run,
          "AI_WORKSPACE_CAPTURE_FAILED",
          "The editor review target could not be captured.",
        );
        return;
      }
      if (!isActiveRun(run) || run.controller.signal.aborted) {
        return;
      }
      if (result.status === "conflict") {
        invalidateRun(
          run,
          cancellationReason("The editor review target has a conflict."),
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
        request.scope.kind !== scopeKind
      ) {
        failRun(
          run,
          "AI_WORKSPACE_CAPTURE_SCOPE_INVALID",
          "The captured review target does not match the active project and request.",
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
    [beginRun, executeStream, failRun, invalidateRun, isActiveRun, projectId],
  );

  const runSelectionReview = useCallback(
    (action: EditorSelectionSessionAction) => {
      const selectedAction = selectionActions.find(
        (candidate) => candidate.action === action,
      );
      if (selectedAction == null) {
        return;
      }
      return runDocumentBoundReview({
        action,
        instruction: selectedAction.instruction,
        captureSession: captureSelectionSession,
        scopeKind: "selection",
      });
    },
    [captureSelectionSession, runDocumentBoundReview],
  );

  const runCurrentDocumentReview = useCallback(
    () =>
      runDocumentBoundReview({
        action: "review",
        instruction: documentReviewInstruction,
        captureSession: captureDocumentSession,
        scopeKind: "document",
      }),
    [captureDocumentSession, runDocumentBoundReview],
  );

  const openFindingEvidence = useCallback(
    (
      runState: SelectionWorkspaceState,
      finding: Finding,
      evidenceIndex: number,
    ) => {
      const session = runState.session;
      const requestId = runState.requestId;
      if (
        runState.status !== "completed" ||
        session == null ||
        requestId == null ||
        getSelectionContext == null ||
        session.request.scope.kind === "project" ||
        session.request.requestId !== requestId ||
        !runState.findings.includes(finding) ||
        findingStatus(runState.findingStatuses, finding.id) !== "unresolved"
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
        previous?.generation === runState.generation &&
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
        generation: runState.generation,
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
    [disposeActiveEvidenceNavigation, getSelectionContext, navigateEvidence],
  );

  const discardFinding = useCallback(
    (runState: SelectionWorkspaceState, finding: Finding) => {
      if (
        runState.status !== "completed" ||
        runState.requestId == null ||
        finding.requestId !== runState.requestId ||
        !runState.findings.includes(finding) ||
        findingStatus(runState.findingStatuses, finding.id) !== "unresolved"
      ) {
        return;
      }
      const activeNavigation = activeEvidenceNavigation.current;
      if (activeNavigation?.finding === finding) {
        disposeActiveEvidenceNavigation(
          cancellationReason("The finding was discarded."),
        );
      }
      if (activeCitationCopy.current?.finding === finding) {
        clearCitationCopy();
      }
      dispatch({
        type: "discard-finding",
        generation: runState.generation,
        requestId: runState.requestId,
        findingId: finding.id,
      });
    },
    [clearCitationCopy, disposeActiveEvidenceNavigation],
  );

  const copyCitationProposedText = useCallback(
    (runState: SelectionWorkspaceState, finding: CitationFinding) => {
      if (
        runState.status !== "completed" ||
        runState.requestId == null ||
        finding.requestId !== runState.requestId ||
        !runState.findings.includes(finding) ||
        findingStatus(runState.findingStatuses, finding.id) !== "unresolved"
      ) {
        return;
      }
      const identity: CitationCopyNotice = {
        generation: runState.generation,
        requestId: runState.requestId,
        finding,
        status: "copying",
      };
      activeCitationCopy.current = identity;
      setCitationCopyNotice(identity);
      void Promise.resolve()
        .then(() => copyText(finding.proposedText))
        .then(
          () => {
            if (!mounted.current || activeCitationCopy.current !== identity) {
              return;
            }
            const settled: CitationCopyNotice = {
              ...identity,
              status: "copied",
            };
            activeCitationCopy.current = settled;
            setCitationCopyNotice(settled);
          },
          () => {
            if (!mounted.current || activeCitationCopy.current !== identity) {
              return;
            }
            const settled: CitationCopyNotice = {
              ...identity,
              status: "error",
            };
            activeCitationCopy.current = settled;
            setCitationCopyNotice(settled);
          },
        );
    },
    [copyText],
  );

  const busy = workspace.runs.some(
    (run) =>
      run.status === "capturing" ||
      run.status === "streaming" ||
      run.status === "finalizing",
  );
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
    (runState: SelectionWorkspaceState, suggestion: ProposedSuggestion) => {
      const session = runState.session;
      const requestId = runState.requestId;
      if (
        runState.status !== "completed" ||
        session == null ||
        requestId == null ||
        getSelectionContext == null ||
        session.request.scope.kind === "project" ||
        session.request.requestId !== requestId ||
        suggestion.requestId !== requestId ||
        suggestionStatus(runState.suggestionStatuses, suggestion.id) !==
          "unresolved"
      ) {
        return;
      }

      if (
        activeSuggestionIdentity.current?.generation === runState.generation &&
        activeSuggestionIdentity.current.requestId === requestId &&
        activeSuggestionIdentity.current.discussionId == null &&
        activeSuggestionIdentity.current.session === session &&
        activeSuggestionIdentity.current.suggestion === suggestion
      ) {
        return;
      }

      disposeActiveSuggestion(
        cancellationReason("Another suggestion preview was selected."),
      );
      const identity = {
        generation: runState.generation,
        requestId,
        discussionId: null,
        session,
        suggestion,
      };
      activeSuggestionIdentity.current = identity;
      setActiveSuggestionPreview(identity);
    },
    [disposeActiveSuggestion, getSelectionContext],
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
      if (!mounted.current) {
        return;
      }
      if (identity.discussionId != null) {
        if (decision.status === "cancelled" || decision.status === "error") {
          return;
        }
        updateDiscussions((current) =>
          current.map((discussion) =>
            discussion.id === identity.discussionId
              ? {
                  ...discussion,
                  suggestionStatuses: {
                    ...discussion.suggestionStatuses,
                    [identity.suggestion.id]: decision.status,
                  },
                  suggestionConflictCodes:
                    decision.status === "conflict"
                      ? {
                          ...discussion.suggestionConflictCodes,
                          [identity.suggestion.id]: decision.code,
                        }
                      : discussion.suggestionConflictCodes,
                  updatedAt: now(),
                }
              : discussion,
          ),
        );
      } else {
        dispatch({
          type: "suggestion-decision",
          generation: identity.generation,
          requestId: identity.requestId,
          suggestionId: identity.suggestion.id,
          decision,
        });
      }
    },
    [disposeActiveSuggestion, now, updateDiscussions],
  );

  const discardSuggestion = useCallback(
    (runState: SelectionWorkspaceState, suggestion: ProposedSuggestion) => {
      const requestId = runState.requestId;
      const status = suggestionStatus(
        runState.suggestionStatuses,
        suggestion.id,
      );
      if (
        runState.status !== "completed" ||
        requestId == null ||
        suggestion.requestId !== requestId ||
        !runState.suggestions.includes(suggestion) ||
        (status !== "unresolved" && status !== "conflict")
      ) {
        return;
      }
      if (activeSuggestionIdentity.current?.suggestion === suggestion) {
        disposeActiveSuggestion(
          cancellationReason("The suggestion was discarded."),
        );
      }
      dispatch({
        type: "discard-suggestion",
        generation: runState.generation,
        requestId,
        suggestionId: suggestion.id,
      });
    },
    [disposeActiveSuggestion],
  );

  const openDiscussion = useCallback(
    (
      runState: SelectionWorkspaceState,
      subject: DiscussionSubject,
      subjectIdentity: string,
    ) => {
      const subjectBelongsToRun =
        subject.kind === "scope" ||
        (subject.kind === "suggestion"
          ? runState.suggestions.includes(subject.artifact)
          : runState.findings.includes(subject.artifact));
      if (
        runState.status !== "completed" ||
        runState.request == null ||
        subject.sourceRequest !== runState.request ||
        !subjectBelongsToRun
      ) {
        return;
      }
      const subjectKey = `${runState.generation}:${subjectIdentity}`;
      const existing = discussionsRef.current.find(
        (discussion) => discussion.subjectKey === subjectKey,
      );
      if (existing != null) {
        setActiveDiscussionId(existing.id);
        return;
      }

      const id = createDiscussionId();
      nextWorkspaceOrder.current += 1;
      const discussion: Discussion = {
        id,
        createdOrder: nextWorkspaceOrder.current,
        subjectKey,
        subject,
        subjectLabel: discussionSubjectLabel(subject),
        sourceGeneration: runState.generation,
        sourceSession: runState.session,
        turns: [],
        suggestions: [],
        suggestionStatuses: {},
        suggestionConflictCodes: {},
        status: "idle",
        error: null,
        updatedAt: now(),
      };
      updateDiscussions((current) => [...current, discussion]);
      setActiveDiscussionId(id);
    },
    [createDiscussionId, now, updateDiscussions],
  );

  const failDiscussionRequest = useCallback(
    (active: ActiveDiscussionRequest, message: string) => {
      if (!mounted.current || activeDiscussionRequest.current !== active) {
        return;
      }
      active.terminal = "error";
      if (!active.controller.signal.aborted) {
        active.controller.abort(cancellationReason(message));
      }
      updateDiscussions((current) =>
        current.map((discussion) =>
          discussion.id === active.discussionId
            ? {
                ...discussion,
                status: "error",
                error: message,
                updatedAt: now(),
              }
            : discussion,
        ),
      );
    },
    [now, updateDiscussions],
  );

  const submitDiscussionMessage = useCallback(() => {
    const discussionId = activeDiscussionId;
    const text = discussionInput.trim();
    if (discussionId == null || text === "") {
      return;
    }
    const discussion = discussionsRef.current.find(
      (candidate) => candidate.id === discussionId,
    );
    if (discussion == null || discussion.status === "streaming") {
      return;
    }

    const previous = activeDiscussionRequest.current;
    if (previous != null) {
      activeDiscussionRequest.current = null;
      if (!previous.controller.signal.aborted) {
        previous.controller.abort(
          cancellationReason("Another discussion response was requested."),
        );
      }
      updateDiscussions((current) =>
        current.map((candidate) =>
          candidate.id === previous.discussionId
            ? {
                ...candidate,
                status: "idle",
                error: null,
                updatedAt: now(),
              }
            : candidate,
        ),
      );
    }

    const requestId = createDiscussionRequestId();
    const userTurn: DiscussionTurn = {
      role: "user",
      text,
    };
    const turns = [...discussion.turns, userTurn].slice(
      -DISCUSSION_CONTEXT_TURN_LIMIT,
    );
    const request: DiscussionRequest = {
      requestId,
      discussionId: discussion.id,
      projectId,
      subject: discussion.subject,
      turns,
    };
    const active: ActiveDiscussionRequest = {
      discussionId,
      requestId,
      controller: new AbortController(),
      terminal: null,
      suggestionIds: new Set(),
    };
    activeDiscussionRequest.current = active;
    setDiscussionInput("");
    updateDiscussions((current) =>
      current.map((candidate) =>
        candidate.id === discussionId
          ? {
              ...candidate,
              turns: [...candidate.turns, userTurn],
              status: "streaming",
              error: null,
              updatedAt: now(),
            }
          : candidate,
      ),
    );

    const onEvent = (event: DiscussionEvent) => {
      if (
        !mounted.current ||
        activeDiscussionRequest.current !== active ||
        active.controller.signal.aborted
      ) {
        return;
      }
      if (event.requestId !== active.requestId) {
        failDiscussionRequest(
          active,
          "The AI reviewer returned an event for another discussion request.",
        );
        return;
      }
      if (active.terminal != null) {
        failDiscussionRequest(
          active,
          "The AI reviewer returned data after a terminal discussion event.",
        );
        return;
      }
      if (event.type === "text.delta") {
        updateDiscussions((current) =>
          current.map((candidate) => {
            if (candidate.id !== discussionId) {
              return candidate;
            }
            const lastTurn = candidate.turns[candidate.turns.length - 1];
            const nextTurns =
              lastTurn?.role === "assistant"
                ? [
                    ...candidate.turns.slice(0, -1),
                    {
                      role: "assistant" as const,
                      text: `${lastTurn.text}${event.delta}`,
                    },
                  ]
                : [
                    ...candidate.turns,
                    {
                      role: "assistant" as const,
                      text: event.delta,
                    },
                  ];
            return {
              ...candidate,
              turns: nextTurns,
              updatedAt: now(),
            };
          }),
        );
      } else if (event.type === "suggestion") {
        if (active.suggestionIds.has(event.suggestion.id)) {
          failDiscussionRequest(
            active,
            "The AI reviewer returned a duplicate discussion suggestion.",
          );
          return;
        }
        active.suggestionIds.add(event.suggestion.id);
        updateDiscussions((current) =>
          current.map((candidate) =>
            candidate.id === discussionId
              ? {
                  ...candidate,
                  suggestions: [...candidate.suggestions, event.suggestion],
                  suggestionStatuses: {
                    ...candidate.suggestionStatuses,
                    [event.suggestion.id]: "unresolved",
                  },
                  updatedAt: now(),
                }
              : candidate,
          ),
        );
      } else if (event.type === "completed") {
        active.terminal = "completed";
      } else if (event.type === "error") {
        active.terminal = "error";
        updateDiscussions((current) =>
          current.map((candidate) =>
            candidate.id === discussionId
              ? {
                  ...candidate,
                  status: "error",
                  error: event.error.message,
                  updatedAt: now(),
                }
              : candidate,
          ),
        );
      }
    };

    void streamDiscussionRequest({
      projectId,
      request,
      signal: active.controller.signal,
      onEvent,
    })
      .then(() => {
        if (
          !mounted.current ||
          activeDiscussionRequest.current !== active ||
          active.controller.signal.aborted
        ) {
          return;
        }
        if (active.terminal == null) {
          failDiscussionRequest(
            active,
            "The AI reviewer discussion ended before completion.",
          );
          return;
        }
        if (active.terminal === "completed") {
          updateDiscussions((current) =>
            current.map((candidate) =>
              candidate.id === discussionId
                ? {
                    ...candidate,
                    status: "idle",
                    error: null,
                    updatedAt: now(),
                  }
                : candidate,
            ),
          );
        }
      })
      .catch((error: unknown) => {
        if (
          !mounted.current ||
          activeDiscussionRequest.current !== active ||
          active.controller.signal.aborted
        ) {
          return;
        }
        failDiscussionRequest(active, streamErrorMessage(error));
      })
      .finally(() => {
        if (activeDiscussionRequest.current === active) {
          activeDiscussionRequest.current = null;
        }
      });
  }, [
    activeDiscussionId,
    createDiscussionRequestId,
    discussionInput,
    failDiscussionRequest,
    now,
    projectId,
    streamDiscussionRequest,
    updateDiscussions,
  ]);

  const cancelDiscussionResponse = useCallback(() => {
    const active = activeDiscussionRequest.current;
    if (active == null || active.discussionId !== activeDiscussionId) {
      return;
    }
    activeDiscussionRequest.current = null;
    if (!active.controller.signal.aborted) {
      active.controller.abort(
        cancellationReason("The discussion response was cancelled."),
      );
    }
    updateDiscussions((current) =>
      current.map((discussion) =>
        discussion.id === active.discussionId
          ? {
              ...discussion,
              status: "idle",
              error: null,
              updatedAt: now(),
            }
          : discussion,
      ),
    );
  }, [activeDiscussionId, now, updateDiscussions]);

  const openDiscussionSuggestionPreview = useCallback(
    (discussion: Discussion, suggestion: ProposedSuggestion) => {
      const session = discussion.sourceSession;
      if (
        session == null ||
        getSelectionContext == null ||
        discussion.subject.sourceRequest.scope.kind === "project" ||
        session.request !== discussion.subject.sourceRequest ||
        !discussion.suggestions.includes(suggestion) ||
        suggestionStatus(discussion.suggestionStatuses, suggestion.id) !==
          "unresolved"
      ) {
        return;
      }

      disposeActiveSuggestion(
        cancellationReason("Another suggestion preview was selected."),
      );
      const identity: ActiveSuggestionPreview = {
        generation: discussion.sourceGeneration,
        requestId: session.request.requestId,
        discussionId: discussion.id,
        session,
        suggestion,
      };
      activeSuggestionIdentity.current = identity;
      setActiveSuggestionPreview(identity);
    },
    [disposeActiveSuggestion, getSelectionContext],
  );

  const discardDiscussionSuggestion = useCallback(
    (discussion: Discussion, suggestion: ProposedSuggestion) => {
      const status = suggestionStatus(
        discussion.suggestionStatuses,
        suggestion.id,
      );
      if (
        !discussion.suggestions.includes(suggestion) ||
        (status !== "unresolved" && status !== "conflict")
      ) {
        return;
      }
      if (activeSuggestionIdentity.current?.suggestion === suggestion) {
        disposeActiveSuggestion(
          cancellationReason("The suggestion was discarded."),
        );
      }
      updateDiscussions((current) =>
        current.map((candidate) =>
          candidate.id === discussion.id
            ? {
                ...candidate,
                suggestionStatuses: {
                  ...candidate.suggestionStatuses,
                  [suggestion.id]: "discarded",
                },
                suggestionConflictCodes: {
                  ...candidate.suggestionConflictCodes,
                  [suggestion.id]: undefined,
                },
                updatedAt: now(),
              }
            : candidate,
        ),
      );
    },
    [disposeActiveSuggestion, now, updateDiscussions],
  );

  const activeDiscussion =
    activeDiscussionId == null
      ? null
      : (discussions.find(
          (discussion) => discussion.id === activeDiscussionId,
        ) ?? null);

  const renderSuggestionPreview = (
    identity: ActiveSuggestionPreview,
    suggestion: ProposedSuggestion,
  ) =>
    getSelectionContext == null ? null : (
      <AiReviewerSuggestionPreview
        key={`${identity.discussionId ?? "run"}:${identity.generation}:${identity.requestId}:${suggestion.id}`}
        session={identity.session}
        suggestion={suggestion}
        getContext={getSelectionContext}
        mountPreview={mountSuggestionPreview}
        applySuggestion={applySelectionSuggestion}
        registerLease={activeLeaseRegistrar}
        onDecision={(nextDecision) =>
          recordSuggestionDecision(identity, nextDecision)
        }
      />
    );

  const renderRun = (runState: SelectionWorkspaceState) => {
    const findings = runState.findings.filter(
      (finding) => finding.artifactKind === "finding",
    );
    const citationFindings = runState.findings.filter(
      (finding): finding is CitationFinding =>
        finding.artifactKind === "citation-finding",
    );
    const canDiscuss =
      runState.status === "completed" && runState.request != null;

    const renderFinding = (finding: Finding) => {
      const status = findingStatus(runState.findingStatuses, finding.id);
      const body = (
        <>
          <p>{finding.message}</p>
          <ul>
            {finding.evidence.map((reference, index) => {
              const navigationTarget =
                status === "unresolved" &&
                runState.status === "completed" &&
                runState.session != null &&
                runState.requestId != null &&
                getSelectionContext != null &&
                runState.session.request.requestId === runState.requestId
                  ? createEditorEvidenceNavigationTarget({
                      session: runState.session,
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
                      onClick={() =>
                        openFindingEvidence(runState, finding, index)
                      }
                    >
                      Go to location {index + 1}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="d-flex flex-wrap gap-2">
            {canDiscuss && runState.request != null && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() =>
                  openDiscussion(
                    runState,
                    {
                      kind: "finding",
                      sourceRequest: runState.request!,
                      artifact: finding,
                    },
                    `finding:${finding.id}`,
                  )
                }
              >
                Discuss finding
              </button>
            )}
            {status === "unresolved" && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => discardFinding(runState, finding)}
              >
                Discard finding
              </button>
            )}
          </div>
        </>
      );
      return isTerminalArtifactStatus(status) ? (
        <details key={finding.id}>
          <summary>
            <span>{finding.title}</span>
            {" — "}
            <span>Status: {artifactStatusLabel(status)}</span>
          </summary>
          {body}
        </details>
      ) : (
        <article key={finding.id}>
          <h5 className="h6">{finding.title}</h5>
          <p>Status: {artifactStatusLabel(status)}</p>
          {body}
        </article>
      );
    };

    const renderCitationFinding = (finding: CitationFinding) => {
      const status = findingStatus(runState.findingStatuses, finding.id);
      const copyNotice =
        citationCopyNotice?.generation === runState.generation &&
        citationCopyNotice.finding === finding
          ? citationCopyNotice
          : null;
      const body = (
        <>
          <p>{finding.message}</p>
          <p>Proposed text: {finding.proposedText}</p>
          <ul>
            {finding.evidence.map((reference, index) => {
              const navigationTarget =
                status === "unresolved" &&
                runState.status === "completed" &&
                runState.session != null &&
                runState.requestId != null &&
                getSelectionContext != null &&
                runState.session.request.requestId === runState.requestId
                  ? createEditorEvidenceNavigationTarget({
                      session: runState.session,
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
                      onClick={() =>
                        openFindingEvidence(runState, finding, index)
                      }
                    >
                      Go to location {index + 1}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="d-flex flex-wrap gap-2">
            {canDiscuss && runState.request != null && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() =>
                  openDiscussion(
                    runState,
                    {
                      kind: "citation-finding",
                      sourceRequest: runState.request!,
                      artifact: finding,
                    },
                    `citation-finding:${finding.id}`,
                  )
                }
              >
                Discuss citation finding
              </button>
            )}
            {status === "unresolved" && (
              <>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={copyNotice?.status === "copying"}
                  onClick={() => copyCitationProposedText(runState, finding)}
                >
                  Copy proposed text
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => discardFinding(runState, finding)}
                >
                  Discard citation finding
                </button>
              </>
            )}
          </div>
          {copyNotice != null && (
            <p aria-live="polite">
              {copyNotice.status === "copying"
                ? "Copying proposed text"
                : copyNotice.status === "copied"
                  ? "Proposed text copied"
                  : "Proposed text could not be copied"}
            </p>
          )}
        </>
      );
      return isTerminalArtifactStatus(status) ? (
        <details key={finding.id}>
          <summary>
            <span>{finding.title}</span>
            {" — "}
            <span>Status: {artifactStatusLabel(status)}</span>
          </summary>
          {body}
        </details>
      ) : (
        <article key={finding.id}>
          <h5 className="h6">{finding.title}</h5>
          <p>Status: {artifactStatusLabel(status)}</p>
          {body}
        </article>
      );
    };

    const renderSuggestion = (
      suggestion: ProposedSuggestion,
      index: number,
    ) => {
      const status = suggestionStatus(
        runState.suggestionStatuses,
        suggestion.id,
      );
      const previewAvailable =
        runState.status === "completed" &&
        runState.session != null &&
        getSelectionContext != null &&
        runState.session.request.scope.kind !== "project" &&
        runState.session.request.requestId === runState.requestId &&
        suggestion.requestId === runState.requestId &&
        status === "unresolved";
      const discardAvailable =
        runState.status === "completed" &&
        suggestion.requestId === runState.requestId &&
        (status === "unresolved" || status === "conflict");
      const previewActive =
        status === "unresolved" &&
        activeSuggestionPreview != null &&
        activeSuggestionPreview.discussionId == null &&
        activeSuggestionPreview.generation === runState.generation &&
        activeSuggestionPreview.requestId === runState.requestId &&
        activeSuggestionPreview.session === runState.session &&
        activeSuggestionPreview.suggestion === suggestion;
      const body = (
        <>
          <p>Original: {suggestion.original}</p>
          <p>Replacement: {suggestion.replacement}</p>
          <p>Rationale: {suggestion.rationale}</p>
          <ul>
            {suggestion.evidence.map((reference, evidenceIndex) => (
              <li key={`${suggestion.id}-evidence-${evidenceIndex}`}>
                {evidenceLocation(reference)}
              </li>
            ))}
          </ul>
          <div className="d-flex flex-wrap gap-2">
            {canDiscuss && runState.request != null && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() =>
                  openDiscussion(
                    runState,
                    {
                      kind: "suggestion",
                      sourceRequest: runState.request!,
                      artifact: suggestion,
                    },
                    `suggestion:${suggestion.id}`,
                  )
                }
              >
                Discuss suggestion
              </button>
            )}
            {previewAvailable && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => openSuggestionPreview(runState, suggestion)}
              >
                Preview diff {index + 1}
              </button>
            )}
            {discardAvailable && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => discardSuggestion(runState, suggestion)}
              >
                Discard suggestion
              </button>
            )}
          </div>
          {previewActive &&
            activeSuggestionPreview != null &&
            renderSuggestionPreview(activeSuggestionPreview, suggestion)}
          {status === "conflict" && (
            <p aria-live="polite">
              {runState.suggestionConflictCodes[suggestion.id] == null
                ? "Conflict"
                : `Conflict: ${runState.suggestionConflictCodes[suggestion.id]}`}
            </p>
          )}
        </>
      );
      return isTerminalArtifactStatus(status) ? (
        <details key={suggestion.id}>
          <summary>
            <span>{suggestion.rationale}</span>
            {" — "}
            <span>Status: {artifactStatusLabel(status)}</span>
          </summary>
          {body}
        </details>
      ) : (
        <article key={suggestion.id}>
          <p>Status: {artifactStatusLabel(status)}</p>
          {body}
        </article>
      );
    };

    return (
      <article
        key={`run:${runState.generation}`}
        aria-label={`Review run ${runState.generation}`}
        className="border rounded p-2"
      >
        <header className="d-flex flex-wrap justify-content-between gap-2">
          <h3 className="h5 mb-0">{reviewScopeLabel(runState.scopeKind)}</h3>
          <span aria-live="polite">{statusLabels[runState.status]}</span>
          <div className="d-flex flex-wrap gap-2">
            {canDiscuss && runState.request != null && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() =>
                  openDiscussion(
                    runState,
                    {
                      kind: "scope",
                      sourceRequest: runState.request!,
                    },
                    "scope",
                  )
                }
              >
                Discuss review scope
              </button>
            )}
            {activeRun.current?.generation === runState.generation && busy && (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={cancel}
              >
                Cancel
              </button>
            )}
          </div>
        </header>
        {runState.text !== "" && (
          <pre className="text-wrap">{runState.text}</pre>
        )}
        {findings.length > 0 && (
          <section aria-label="Review findings">
            <h4 className="h6">Findings</h4>
            {findings.map(renderFinding)}
          </section>
        )}
        {citationFindings.length > 0 && (
          <section aria-label="Review citation findings">
            <h4 className="h6">Citation findings</h4>
            {citationFindings.map(renderCitationFinding)}
          </section>
        )}
        {evidenceNavigationNotice?.identity.generation ===
          runState.generation && (
          <p aria-live="polite">
            {evidenceNavigationMessage(evidenceNavigationNotice)}
          </p>
        )}
        {runState.suggestions.length > 0 && (
          <section aria-label="Review suggestions">
            <h4 className="h6">Suggestions</h4>
            {runState.suggestions.map(renderSuggestion)}
          </section>
        )}
        {runState.conflict != null && (
          <div className="alert alert-warning" role="alert">
            Selection conflict: {runState.conflict}
          </div>
        )}
        {runState.error != null && (
          <div className="alert alert-danger" role="alert">
            {runState.error}
          </div>
        )}
      </article>
    );
  };

  if (activeDiscussion != null) {
    return (
      <section
        aria-label="AI reviewer discussion"
        className="p-3 d-flex flex-column"
        style={{ height: "100%", minHeight: 0 }}
      >
        <header className="flex-shrink-0 border-bottom pb-2">
          <button
            type="button"
            className="btn btn-link p-0"
            onClick={() => setActiveDiscussionId(null)}
          >
            Back to review list
          </button>
          <h2 className="h4 mb-0" data-testid="discussion-subject">
            {activeDiscussion.subjectLabel}
          </h2>
        </header>
        <div
          className="flex-grow-1 overflow-auto py-2"
          style={{ minHeight: 0 }}
          aria-label="Discussion turns"
        >
          {activeDiscussion.turns.map((turn, index) => (
            <article
              key={`${turn.role}:${index}`}
              aria-label={turn.role === "user" ? "Your message" : "AI response"}
            >
              <h3 className="h6">
                {turn.role === "user" ? "You" : "AI reviewer"}
              </h3>
              <pre className="text-wrap">{turn.text}</pre>
            </article>
          ))}
          {activeDiscussion.suggestions.length > 0 && (
            <section aria-label="Discussion suggestions">
              <h3 className="h5">Suggestions</h3>
              {activeDiscussion.suggestions.map((suggestion, index) => {
                const status = suggestionStatus(
                  activeDiscussion.suggestionStatuses,
                  suggestion.id,
                );
                const previewActive =
                  status === "unresolved" &&
                  activeSuggestionPreview?.discussionId ===
                    activeDiscussion.id &&
                  activeSuggestionPreview.suggestion === suggestion;
                const body = (
                  <>
                    <p>Original: {suggestion.original}</p>
                    <p>Replacement: {suggestion.replacement}</p>
                    <p>Rationale: {suggestion.rationale}</p>
                    <div className="d-flex flex-wrap gap-2">
                      {status === "unresolved" &&
                        activeDiscussion.sourceSession != null &&
                        getSelectionContext != null && (
                          <button
                            type="button"
                            className="btn btn-secondary"
                            onClick={() =>
                              openDiscussionSuggestionPreview(
                                activeDiscussion,
                                suggestion,
                              )
                            }
                          >
                            Preview discussion diff {index + 1}
                          </button>
                        )}
                      {(status === "unresolved" || status === "conflict") && (
                        <button
                          type="button"
                          className="btn btn-secondary"
                          onClick={() =>
                            discardDiscussionSuggestion(
                              activeDiscussion,
                              suggestion,
                            )
                          }
                        >
                          Discard suggestion
                        </button>
                      )}
                    </div>
                    {previewActive &&
                      activeSuggestionPreview != null &&
                      renderSuggestionPreview(
                        activeSuggestionPreview,
                        suggestion,
                      )}
                    {status === "conflict" && (
                      <p aria-live="polite">
                        {activeDiscussion.suggestionConflictCodes[
                          suggestion.id
                        ] == null
                          ? "Conflict"
                          : `Conflict: ${
                              activeDiscussion.suggestionConflictCodes[
                                suggestion.id
                              ]
                            }`}
                      </p>
                    )}
                  </>
                );
                return isTerminalArtifactStatus(status) ? (
                  <details key={suggestion.id}>
                    <summary>
                      <span>{suggestion.rationale}</span>
                      {" — "}
                      <span>Status: {artifactStatusLabel(status)}</span>
                    </summary>
                    {body}
                  </details>
                ) : (
                  <article key={suggestion.id}>
                    <p>Status: {artifactStatusLabel(status)}</p>
                    {body}
                  </article>
                );
              })}
            </section>
          )}
          {activeDiscussion.error != null && (
            <div className="alert alert-danger" role="alert">
              {activeDiscussion.error}
            </div>
          )}
        </div>
        <form
          className="flex-shrink-0 border-top pt-2"
          onSubmit={(event) => {
            event.preventDefault();
            submitDiscussionMessage();
          }}
        >
          <label className="form-label" htmlFor="ai-reviewer-discussion-input">
            Discussion message
          </label>
          <textarea
            id="ai-reviewer-discussion-input"
            className="form-control"
            value={discussionInput}
            disabled={activeDiscussion.status === "streaming"}
            onChange={(event) => setDiscussionInput(event.target.value)}
          />
          <div className="d-flex flex-wrap gap-2 mt-2">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={
                activeDiscussion.status === "streaming" ||
                discussionInput.trim() === ""
              }
            >
              Send message
            </button>
            {activeDiscussion.status === "streaming" && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={cancelDiscussionResponse}
              >
                Cancel response
              </button>
            )}
          </div>
        </form>
      </section>
    );
  }

  const timeline = [
    ...workspace.runs.map((run) => ({
      kind: "run" as const,
      createdOrder: run.createdOrder,
      run,
    })),
    ...discussions.map((discussion) => ({
      kind: "discussion" as const,
      createdOrder: discussion.createdOrder,
      discussion,
    })),
  ].sort((left, right) => left.createdOrder - right.createdOrder);

  return (
    <section aria-label="AI reviewer" className="p-3">
      <h2 className="h4">AI reviewer</h2>
      <div className="d-flex flex-wrap gap-2 mt-2">
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={runProjectReview}
        >
          Run review
        </button>
        {captureDocumentSession != null && (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => {
              void runCurrentDocumentReview();
            }}
          >
            Review current document
          </button>
        )}
        {captureSelectionSession != null &&
          selectionActions.map(({ action, label }) => (
            <button
              key={action}
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => {
                void runSelectionReview(action);
              }}
            >
              {label}
            </button>
          ))}
      </div>
      <div className="d-flex flex-column gap-3 mt-3" aria-label="Review list">
        {timeline.map((entry) =>
          entry.kind === "run" ? (
            renderRun(entry.run)
          ) : (
            <article
              key={`discussion:${entry.discussion.id}`}
              aria-label="Discussion summary"
              className="border rounded p-2 d-flex flex-wrap justify-content-between gap-2"
            >
              <button
                type="button"
                className="btn btn-link p-0"
                onClick={() => setActiveDiscussionId(entry.discussion.id)}
              >
                {entry.discussion.subjectLabel}
              </button>
              <span>
                {entry.discussion.status === "streaming"
                  ? "Responding"
                  : "Discussion"}
              </span>
              <time dateTime={entry.discussion.updatedAt}>
                Last updated: {entry.discussion.updatedAt}
              </time>
            </article>
          ),
        )}
      </div>
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
  const captureDocumentSession = useCallback(
    (request: CaptureSelectionRequest) =>
      captureEditorSelectionSession({
        ...request,
        target: "document",
        getContext: getSelectionContext,
      }),
    [getSelectionContext],
  );

  return (
    <AiReviewerPanelView
      projectId={projectId}
      captureSelectionSession={captureSelectionSession}
      captureDocumentSession={captureDocumentSession}
      getSelectionContext={getSelectionContext}
    />
  );
}
