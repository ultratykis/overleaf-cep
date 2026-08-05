import { useFileTreePathContext } from "@/features/file-tree/contexts/file-tree-path";
import GenericConfirmModal from "@/features/ide-react/components/modals/generic-confirm-modal";
import { useEditorManagerContext } from "@/features/ide-react/context/editor-manager-context";
import { ExpandableContent } from "@/features/review-panel/components/review-panel-expandable-content";
import AutoExpandingTextArea from "@/shared/components/auto-expanding-text-area";
import {
  Dropdown,
  DropdownMenu,
  DropdownToggle,
} from "@/shared/components/dropdown/dropdown-menu";
import MaterialIcon from "@/shared/components/material-icon";
import OLButton from "@/shared/components/ol/ol-button";
import OLDropdownMenuItem from "@/shared/components/ol/ol-dropdown-menu-item";
import OLFormLabel from "@/shared/components/ol/ol-form-label";
import OLFormSelect from "@/shared/components/ol/ol-form-select";
import OLIconButton from "@/shared/components/ol/ol-icon-button";
import OLTooltip from "@/shared/components/ol/ol-tooltip";
import { useProjectContext } from "@/shared/context/project-context";
import type { TFunction } from "i18next";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { v4 as uuid } from "uuid";

import type {
  AgentError,
  AgentEvent,
  AgentRequest,
  AiReviewerWorkspace,
  DiscussionEvent,
  DiscussionRequest,
  DiscussionSubject,
  DiscussionTurn,
  Finding,
  UnresolvedSuggestion,
  WorkspaceDiscussion,
  WorkspaceRun,
} from "../../../shared/contract-types";
import {
  AI_REVIEWER_WORKSPACE_DISCUSSION_LIMIT,
  AI_REVIEWER_WORKSPACE_TURN_LIMIT,
  DISCUSSION_CONTEXT_TURN_LIMIT,
} from "../../../shared/contracts.mjs";
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
  createProjectEditorEvidenceNavigationTarget,
  navigateToEditorEvidence,
  type EditorEvidenceNavigationResult,
  type EditorEvidenceNavigationTarget,
  type OpenEditorEvidenceDocument,
  type ResolveEditorEvidenceDocument,
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
import {
  aiReviewerWorkspacePersistence,
  AiReviewerWorkspacePersistenceError,
  type AiReviewerWorkspacePersistence,
} from "../services/ai-reviewer-workspace-persistence";
import {
  postAiReviewerArtifactComment,
  type ArtifactCommentPostingResult,
  type PostEditorComment,
  type PostableAiReviewerArtifact,
} from "../services/editor-artifact-comment-posting";
import { readEditorSuggestionLiveContext } from "../services/editor-suggestion-host-application";
import { postAiReviewerComment } from "../services/ai-reviewer-comment-posting";

import "../../stylesheets/ai-reviewer.scss";

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
type OrdinaryFinding = Extract<Finding, { artifactKind: "finding" }>;
type CopyText = (text: string) => Promise<void>;

type CommentDraft = {
  key: string;
  generation: number;
  request: AgentRequest;
  artifact: PostableAiReviewerArtifact;
  discussionId: string | null;
  content: string;
  status: "editing" | "posting";
  error: string | null;
};

type ActiveCommentPosting = {
  key: string;
  controller: AbortController;
};

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
  suggestion: UnresolvedSuggestion;
};

type ActiveSuggestionLease = {
  dispose: SuggestionPreviewDisposer;
};

type ActiveEvidenceNavigation = {
  generation: number;
  requestId: string;
  session: EditorSelectionSession | null;
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
type ReviewScopeKind = AgentRequest["scope"]["kind"];

type Discussion = {
  id: string;
  createdOrder: number;
  subjectKey: string | null;
  subject: DiscussionSubject | null;
  subjectLabel: string;
  sourceGeneration: number | null;
  sourceSession: EditorSelectionSession | null;
  turns: DiscussionTurn[];
  suggestions: UnresolvedSuggestion[];
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

type PersistenceOperation = {
  generation: number;
  controller: AbortController;
};

const selectionActions: Array<{
  action: EditorSelectionSessionAction;
  instruction: string;
}> = [
  {
    action: "review",
    instruction: "Review the selected phrase.",
  },
  {
    action: "rewrite",
    instruction: "Rewrite the selected phrase.",
  },
  {
    action: "shorten",
    instruction: "Shorten the selected phrase.",
  },
];

const projectReviewInstruction =
  "Review this project and identify the most important issue.";
const documentReviewInstruction = "Review the current document.";

function cancellationReason(message: string) {
  return new DOMException(message, "AbortError");
}

function runStatusLabel(
  status: SelectionWorkspaceStatus,
  t: TFunction<"translation">,
) {
  switch (status) {
    case "idle":
      return t("ai_reviewer_run_status_ready");
    case "capturing":
      return t("ai_reviewer_run_status_capturing");
    case "streaming":
      return t("ai_reviewer_run_status_streaming");
    case "finalizing":
      return t("ai_reviewer_run_status_finalizing");
    case "completed":
      return t("ai_reviewer_run_status_completed");
    case "conflict":
      return t("ai_reviewer_run_status_conflict");
    case "cancelled":
      return t("ai_reviewer_run_status_cancelled");
    case "error":
      return t("ai_reviewer_run_status_error");
  }
}

function selectionActionLabel(
  action: EditorSelectionSessionAction,
  t: TFunction<"translation">,
) {
  switch (action) {
    case "review":
      return t("ai_reviewer_review_selection");
    case "rewrite":
      return t("ai_reviewer_rewrite_selection");
    case "shorten":
      return t("ai_reviewer_shorten_selection");
  }
}

function reviewActionLabel(
  scopeKind: ReviewScopeKind,
  t: TFunction<"translation">,
) {
  switch (scopeKind) {
    case "selection":
      return selectionActionLabel("review", t);
    case "document":
      return t("ai_reviewer_review_current_document");
    case "project":
      return t("ai_reviewer_run_review");
  }
}

function agentErrorMessage(
  error: AgentError,
  t: TFunction<"translation">,
): string {
  switch (`${error.category}:${error.code}`) {
    case "aborted:AI_REQUEST_ABORTED":
      return t("ai_reviewer_error_guidance_aborted");
    case "authentication:AI_PROVIDER_AUTHENTICATION_ERROR":
      return t("ai_reviewer_error_guidance_authentication");
    case "configuration:AI_PROVIDER_NOT_CONFIGURED":
      return t("ai_reviewer_error_guidance_configuration");
    case "network:AI_PROVIDER_NETWORK_ERROR":
      return t("ai_reviewer_error_guidance_network");
    case "configuration:AI_PROJECT_CONTENT_NOT_AVAILABLE":
      return t("ai_reviewer_error_guidance_project_content");
    case "provider:AI_PROVIDER_ERROR":
      return t("ai_reviewer_error_guidance_provider");
    case "rate-limit:AI_PROVIDER_RATE_LIMITED":
      return t("ai_reviewer_error_guidance_rate_limit");
    case "schema:AI_STREAM_PROTOCOL_ERROR":
      return t("ai_reviewer_error_guidance_schema");
    case "timeout:AI_REQUEST_TIMEOUT":
      return t("ai_reviewer_error_guidance_timeout");
    case "unknown:AI_PROVIDER_ERROR":
      return t("ai_reviewer_error_unknown");
  }

  switch (error.message) {
    case "The AI reviewer request was cancelled.":
      return t("ai_reviewer_error_request_cancelled");
    case "The AI provider rejected its credentials.":
      return t("ai_reviewer_error_provider_credentials_rejected");
    case "No AI provider is configured.":
      return t("ai_reviewer_error_provider_not_configured");
    case "The AI provider could not be reached.":
      return t("ai_reviewer_error_provider_unreachable");
    case "The AI provider request failed.":
      return t("ai_reviewer_error_provider_request_failed");
    case "The AI provider rate limit was reached.":
      return t("ai_reviewer_error_provider_rate_limited");
    case "The AI provider returned invalid stream data.":
      return t("ai_reviewer_error_provider_invalid_stream");
    case "The AI reviewer request timed out.":
      return t("ai_reviewer_error_request_timed_out");
    case "The project content could not be read for review.":
      return t("ai_reviewer_error_project_content_unavailable");
    case "The AI reviewer request is invalid.":
      return t("ai_reviewer_error_request_invalid");
    case "The AI reviewer request does not match this project.":
      return t("ai_reviewer_error_request_project_mismatch");
    case "The AI reviewer stream could not be read.":
      return t("ai_reviewer_error_stream_unreadable");
    case "The AI reviewer returned data outside the requested document scope.":
      return t("ai_reviewer_error_data_outside_document_scope");
    case "The AI reviewer returned evidence for another document state.":
      return t("ai_reviewer_error_evidence_document_state_mismatch");
    case "The AI reviewer started with a different skill.":
      return t("ai_reviewer_error_skill_mismatch");
    case "The AI reviewer returned a finding for another project.":
      return t("ai_reviewer_error_finding_project_mismatch");
    case "The AI reviewer returned a suggestion outside the active request.":
      return t("ai_reviewer_error_suggestion_request_mismatch");
    case "A project review cannot return edit suggestions.":
      return t("ai_reviewer_error_project_suggestion_not_allowed");
    case "The AI reviewer returned a suggestion outside the requested document scope.":
      return t("ai_reviewer_error_suggestion_outside_document_scope");
    case "The AI reviewer returned an invalid stream type.":
      return t("ai_reviewer_error_invalid_stream_type");
    case "The AI reviewer returned an empty stream.":
      return t("ai_reviewer_error_empty_stream");
    case "The AI reviewer returned data after a terminal event.":
      return t("ai_reviewer_error_data_after_terminal_event");
    case "The AI reviewer returned malformed stream data.":
      return t("ai_reviewer_error_malformed_stream_data");
    case "The AI reviewer returned an invalid stream event.":
      return t("ai_reviewer_error_invalid_stream_event");
    case "The AI reviewer stream ended before completion.":
      return t("ai_reviewer_error_stream_incomplete");
    case "The AI reviewer request does not match the active project.":
      return t("ai_reviewer_error_active_project_mismatch");
    case "An open discussion cannot return edit suggestions.":
      return t("ai_reviewer_error_open_discussion_suggestion_not_allowed");
    case "A project discussion cannot return edit suggestions.":
      return t("ai_reviewer_error_project_discussion_suggestion_not_allowed");
    case "The AI reviewer returned a discussion suggestion outside the subject scope.":
      return t("ai_reviewer_error_discussion_suggestion_outside_subject");
    case "The AI reviewer discussion does not match the active project.":
      return t("ai_reviewer_error_discussion_project_mismatch");
  }
  const httpStatus = error.message.match(
    /^The AI reviewer request failed with HTTP ([0-9]+)\.$/,
  )?.[1];
  if (httpStatus != null) {
    return t("ai_reviewer_error_http_status", { status: httpStatus });
  }
  return t("ai_reviewer_error_detail", { message: error.message });
}

function streamErrorMessage(error: unknown, t: TFunction<"translation">) {
  return error instanceof AgentStreamError
    ? agentErrorMessage(error.details, t)
    : t("ai_reviewer_error_request_failed");
}

function commentPostingErrorMessage(
  result: ArtifactCommentPostingResult,
  t: TFunction<"translation">,
) {
  if (result.status === "conflict") {
    switch (result.code) {
      case "AI_COMMENT_RANGE_STALE":
        return t("ai_reviewer_comment_range_stale");
      case "AI_COMMENT_DOCUMENT_UNAVAILABLE":
        return t("ai_reviewer_comment_document_unavailable");
      case "AI_COMMENT_ARTIFACT_NOT_POSTABLE":
        return t("ai_reviewer_comment_artifact_not_postable");
    }
  }
  return t("ai_reviewer_comment_post_failed");
}

function defaultCommentBody(
  artifact: PostableAiReviewerArtifact,
  t: TFunction<"translation">,
) {
  if ("artifactKind" in artifact) {
    return artifact.message;
  }
  return t("ai_reviewer_default_suggestion_comment", {
    rationale: artifact.rationale,
    replacement: artifact.replacement,
  });
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

function evidenceNavigationMessage(
  notice: EvidenceNavigationNotice,
  t: TFunction<"translation">,
) {
  if (notice.status === "pending") {
    return t("ai_reviewer_evidence_selecting");
  }
  if (notice.result.status === "navigated") {
    return t("ai_reviewer_evidence_selected");
  }
  if (notice.result.status === "opened") {
    return t("ai_reviewer_evidence_file_opened_range_unconfirmed");
  }
  if (notice.result.status === "conflict") {
    return t("ai_reviewer_evidence_unavailable", {
      code: notice.result.code,
    });
  }
  if (notice.result.status === "cancelled") {
    return t("ai_reviewer_evidence_navigation_cancelled");
  }
  return t("ai_reviewer_evidence_navigation_failed", {
    code: notice.result.code,
  });
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
  if (candidate.status === "opened") {
    return {
      status: "opened",
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
  t: TFunction<"translation">,
) {
  switch (status) {
    case "unresolved":
      return t("ai_reviewer_artifact_status_unresolved");
    case "applied":
      return t("ai_reviewer_artifact_status_applied");
    case "discarded":
      return t("ai_reviewer_artifact_status_discarded");
    case "conflict":
      return t("ai_reviewer_artifact_status_conflict");
    case "posted":
      return t("ai_reviewer_artifact_status_posted");
  }
}

function reviewScopeLabel(
  scopeKind: AgentRequest["scope"]["kind"] | null,
  t: TFunction<"translation">,
) {
  switch (scopeKind) {
    case "selection":
      return t("ai_reviewer_scope_selection");
    case "document":
      return t("ai_reviewer_scope_current_document");
    case "project":
      return t("ai_reviewer_scope_project");
    default:
      return t("ai_reviewer_scope");
  }
}

function discussionSubjectLabel(
  subject: DiscussionSubject | null,
  t: TFunction<"translation">,
) {
  if (subject == null) {
    return t("ai_reviewer_discussion_no_subject");
  }
  switch (subject.kind) {
    case "finding":
      return t("ai_reviewer_discussion_subject_finding", {
        title: subject.artifact.title,
      });
    case "citation-finding":
      return t("ai_reviewer_discussion_subject_citation_finding", {
        title: subject.artifact.title,
      });
    case "suggestion":
      return t("ai_reviewer_discussion_subject_suggestion", {
        rationale: subject.artifact.rationale,
      });
    case "scope":
      return t("ai_reviewer_discussion_subject_scope", {
        scope: reviewScopeLabel(subject.sourceRequest.scope.kind, t),
      });
  }
}

function persistenceErrorMessage(error: unknown, t: TFunction<"translation">) {
  if (error instanceof AiReviewerWorkspacePersistenceError) {
    if (
      error.code === "AI_REVIEWER_WORKSPACE_LIMIT_REACHED" ||
      error.code === "AI_WORKSPACE_LIMIT_REACHED"
    ) {
      return t("ai_reviewer_workspace_limit_reached");
    }
    if (error.code === "AI_REVIEWER_WORKSPACE_CHANGED") {
      return t("ai_reviewer_workspace_changed");
    }
    return t("ai_reviewer_error_detail", { message: error.message });
  }
  return t("ai_reviewer_workspace_save_failed");
}

function isPersistenceConflict(error: unknown) {
  return (
    error instanceof AiReviewerWorkspacePersistenceError &&
    error.code === "AI_REVIEWER_WORKSPACE_CHANGED"
  );
}

function workspaceRunFromState(
  runState: SelectionWorkspaceState,
): WorkspaceRun | null {
  if (runState.status !== "completed" || runState.request == null) {
    return null;
  }
  return {
    generation: runState.generation,
    createdOrder: runState.createdOrder,
    request: runState.request,
    text: runState.text,
    findings: runState.findings.map((finding) => ({
      artifact: finding,
      status: findingStatus(runState.findingStatuses, finding.id),
    })),
    suggestions: runState.suggestions.map((suggestion) => {
      const status = suggestionStatus(
        runState.suggestionStatuses,
        suggestion.id,
      );
      const conflictCode = runState.suggestionConflictCodes[suggestion.id];
      return {
        artifact: {
          ...suggestion,
          status,
        },
        ...(status === "conflict" && conflictCode != null
          ? { conflictCode }
          : {}),
      };
    }),
  };
}

function workspaceDiscussionFromState(
  discussion: Discussion,
): WorkspaceDiscussion {
  return {
    id: discussion.id,
    createdOrder: discussion.createdOrder,
    subjectKey: discussion.subjectKey,
    subject: discussion.subject,
    sourceGeneration: discussion.sourceGeneration,
    turns: discussion.turns,
    suggestions: discussion.suggestions.map((suggestion) => {
      const status = suggestionStatus(
        discussion.suggestionStatuses,
        suggestion.id,
      );
      const conflictCode = discussion.suggestionConflictCodes[suggestion.id];
      return {
        artifact: {
          ...suggestion,
          status,
        },
        ...(status === "conflict" && conflictCode != null
          ? { conflictCode }
          : {}),
      };
    }),
    updatedAt: discussion.updatedAt,
  };
}

function persistedWorkspaceFromState(
  workspace: { runs: SelectionWorkspaceState[] },
  discussions: Discussion[],
): AiReviewerWorkspace | null {
  if (discussions.some((discussion) => discussion.status === "streaming")) {
    return null;
  }
  return {
    runs: workspace.runs
      .map(workspaceRunFromState)
      .filter((run): run is WorkspaceRun => run != null),
    discussions: discussions.map(workspaceDiscussionFromState),
  };
}

function dropEmptyUnboundRuns(
  workspace: AiReviewerWorkspace,
): AiReviewerWorkspace {
  const boundRequestIds = new Set(
    workspace.discussions.flatMap((discussion) =>
      discussion.subject == null
        ? []
        : [discussion.subject.sourceRequest.requestId],
    ),
  );
  return {
    runs: workspace.runs.filter(
      (run) =>
        run.findings.length > 0 ||
        run.suggestions.length > 0 ||
        boundRequestIds.has(run.request.requestId),
    ),
    discussions: workspace.discussions,
  };
}

function mergeWorkspaceDecisionChanges(
  persisted: AiReviewerWorkspace,
  before: AiReviewerWorkspace,
  after: AiReviewerWorkspace,
): { workspace: AiReviewerWorkspace; conflicted: boolean } {
  let conflicted = false;
  const beforeRuns = new Map(
    before.runs.map((run) => [run.request.requestId, run]),
  );
  const afterRuns = new Map(
    after.runs.map((run) => [run.request.requestId, run]),
  );
  const mergeSuggestions = (
    persistedSuggestions: WorkspaceRun["suggestions"],
    beforeSuggestions: WorkspaceRun["suggestions"],
    afterSuggestions: WorkspaceRun["suggestions"],
  ) => {
    const beforeById = new Map(
      beforeSuggestions.map((entry) => [entry.artifact.id, entry]),
    );
    const afterById = new Map(
      afterSuggestions.map((entry) => [entry.artifact.id, entry]),
    );
    const persistedIds = new Set(
      persistedSuggestions.map((entry) => entry.artifact.id),
    );
    for (const [id, current] of afterById) {
      const previous = beforeById.get(id);
      if (
        previous != null &&
        !persistedIds.has(id) &&
        (previous.artifact.status !== current.artifact.status ||
          previous.conflictCode !== current.conflictCode)
      ) {
        conflicted = true;
      }
    }
    return persistedSuggestions.map((entry) => {
      const previous = beforeById.get(entry.artifact.id);
      const current = afterById.get(entry.artifact.id);
      if (
        previous == null ||
        current == null ||
        (previous.artifact.status === current.artifact.status &&
          previous.conflictCode === current.conflictCode)
      ) {
        return entry;
      }
      const persistedMatchesPrevious =
        entry.artifact.status === previous.artifact.status &&
        entry.conflictCode === previous.conflictCode;
      const persistedMatchesCurrent =
        entry.artifact.status === current.artifact.status &&
        entry.conflictCode === current.conflictCode;
      if (!persistedMatchesPrevious) {
        if (!persistedMatchesCurrent) {
          conflicted = true;
        }
        return entry;
      }
      const { conflictCode: _persistedConflictCode, ...withoutConflict } =
        entry;
      return {
        ...withoutConflict,
        artifact: {
          ...entry.artifact,
          status: current.artifact.status,
        },
        ...(current.conflictCode == null
          ? {}
          : { conflictCode: current.conflictCode }),
      };
    });
  };
  const runs = persisted.runs.map((run) => {
    const beforeRun = beforeRuns.get(run.request.requestId);
    const afterRun = afterRuns.get(run.request.requestId);
    if (beforeRun == null || afterRun == null) {
      return run;
    }
    const beforeFindings = new Map(
      beforeRun.findings.map((entry) => [entry.artifact.id, entry]),
    );
    const afterFindings = new Map(
      afterRun.findings.map((entry) => [entry.artifact.id, entry]),
    );
    const persistedFindingIds = new Set(
      run.findings.map((entry) => entry.artifact.id),
    );
    for (const [id, current] of afterFindings) {
      const previous = beforeFindings.get(id);
      if (
        previous != null &&
        !persistedFindingIds.has(id) &&
        previous.status !== current.status
      ) {
        conflicted = true;
      }
    }
    return {
      ...run,
      findings: run.findings.map((entry) => {
        const previous = beforeFindings.get(entry.artifact.id);
        const current = afterFindings.get(entry.artifact.id);
        if (
          previous == null ||
          current == null ||
          previous.status === current.status
        ) {
          return entry;
        }
        if (entry.status !== previous.status) {
          if (entry.status !== current.status) {
            conflicted = true;
          }
          return entry;
        }
        return {
          ...entry,
          status: current.status,
        };
      }),
      suggestions: mergeSuggestions(
        run.suggestions,
        beforeRun.suggestions,
        afterRun.suggestions,
      ),
    };
  });
  const persistedRunRequestIds = new Set(
    persisted.runs.map((run) => run.request.requestId),
  );
  for (const [requestId, afterRun] of afterRuns) {
    const beforeRun = beforeRuns.get(requestId);
    if (beforeRun == null || persistedRunRequestIds.has(requestId)) {
      continue;
    }
    const beforeFindings = new Map(
      beforeRun.findings.map((entry) => [entry.artifact.id, entry]),
    );
    const beforeSuggestions = new Map(
      beforeRun.suggestions.map((entry) => [entry.artifact.id, entry]),
    );
    if (
      afterRun.findings.some((entry) => {
        const previous = beforeFindings.get(entry.artifact.id);
        return previous != null && previous.status !== entry.status;
      }) ||
      afterRun.suggestions.some((entry) => {
        const previous = beforeSuggestions.get(entry.artifact.id);
        return (
          previous != null &&
          (previous.artifact.status !== entry.artifact.status ||
            previous.conflictCode !== entry.conflictCode)
        );
      })
    ) {
      conflicted = true;
    }
  }
  const beforeDiscussions = new Map(
    before.discussions.map((discussion) => [discussion.id, discussion]),
  );
  const afterDiscussions = new Map(
    after.discussions.map((discussion) => [discussion.id, discussion]),
  );
  const discussions = persisted.discussions.map((discussion) => {
    const beforeDiscussion = beforeDiscussions.get(discussion.id);
    const afterDiscussion = afterDiscussions.get(discussion.id);
    if (beforeDiscussion == null || afterDiscussion == null) {
      return discussion;
    }
    const suggestions = mergeSuggestions(
      discussion.suggestions,
      beforeDiscussion.suggestions,
      afterDiscussion.suggestions,
    );
    return suggestions.some(
      (entry, index) => entry !== discussion.suggestions[index],
    )
      ? {
          ...discussion,
          suggestions,
          updatedAt: afterDiscussion.updatedAt,
        }
      : discussion;
  });
  const persistedDiscussionIds = new Set(
    persisted.discussions.map((discussion) => discussion.id),
  );
  for (const [discussionId, afterDiscussion] of afterDiscussions) {
    const beforeDiscussion = beforeDiscussions.get(discussionId);
    if (
      beforeDiscussion == null ||
      persistedDiscussionIds.has(discussionId) ||
      beforeDiscussion.suggestions.length === 0
    ) {
      continue;
    }
    const beforeSuggestions = new Map(
      beforeDiscussion.suggestions.map((entry) => [entry.artifact.id, entry]),
    );
    if (
      afterDiscussion.suggestions.some((entry) => {
        const previous = beforeSuggestions.get(entry.artifact.id);
        return (
          previous != null &&
          (previous.artifact.status !== entry.artifact.status ||
            previous.conflictCode !== entry.conflictCode)
        );
      })
    ) {
      conflicted = true;
    }
  }
  return {
    workspace: {
      runs,
      discussions,
    },
    conflicted,
  };
}

function discussionFromWorkspace(
  discussion: WorkspaceDiscussion,
  t: TFunction<"translation">,
): Discussion {
  return {
    id: discussion.id,
    createdOrder: discussion.createdOrder,
    subjectKey: discussion.subjectKey,
    subject: discussion.subject,
    subjectLabel: discussionSubjectLabel(discussion.subject, t),
    sourceGeneration: discussion.sourceGeneration,
    sourceSession: null,
    turns: discussion.turns,
    suggestions: discussion.suggestions.map((entry) => ({
      ...entry.artifact,
      status: "unresolved",
    })),
    suggestionStatuses: Object.fromEntries(
      discussion.suggestions.map((entry) => [
        entry.artifact.id,
        entry.artifact.status,
      ]),
    ),
    suggestionConflictCodes: Object.fromEntries(
      discussion.suggestions
        .filter((entry) => entry.conflictCode != null)
        .map((entry) => [entry.artifact.id, entry.conflictCode]),
    ),
    status: "idle",
    error: null,
    updatedAt: discussion.updatedAt,
  };
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
  resolveEvidenceDocument,
  openEvidenceDocument,
  mountSuggestionPreview,
  applySelectionSuggestion,
  copyText = copyTextToClipboard,
  postEditorComment,
  workspacePersistence,
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
  resolveEvidenceDocument?: ResolveEditorEvidenceDocument;
  openEvidenceDocument?: OpenEditorEvidenceDocument;
  mountSuggestionPreview?: MountSuggestionPreview;
  applySelectionSuggestion?: ApplySelectionSuggestion;
  copyText?: CopyText;
  postEditorComment?: PostEditorComment;
  workspacePersistence?: AiReviewerWorkspacePersistence;
}) {
  const { t } = useTranslation();
  const [workspace, dispatch] = useReducer(
    reduceReviewWorkspaceState,
    initialReviewWorkspaceState,
  );
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const reviewScopes = useMemo<ReviewScopeKind[]>(() => {
    const scopes: ReviewScopeKind[] = [];
    if (captureSelectionSession != null) {
      scopes.push("selection");
    }
    if (captureDocumentSession != null) {
      scopes.push("document");
    }
    scopes.push("project");
    return scopes;
  }, [captureDocumentSession, captureSelectionSession]);
  const [reviewScope, setReviewScope] = useState<ReviewScopeKind>(
    reviewScopes[0] ?? "project",
  );
  const [discussions, setDiscussions] = useState<Discussion[]>([]);
  const [activeDiscussionId, setActiveDiscussionId] = useState<string | null>(
    null,
  );
  const activeDiscussionIdRef = useRef<string | null>(activeDiscussionId);
  activeDiscussionIdRef.current = activeDiscussionId;
  const [discussionInput, setDiscussionInput] = useState("");
  const [showDeleteWorkspaceConfirmation, setShowDeleteWorkspaceConfirmation] =
    useState(false);
  const [activeSuggestionPreview, setActiveSuggestionPreview] =
    useState<ActiveSuggestionPreview | null>(null);
  const [evidenceNavigationNotice, setEvidenceNavigationNotice] =
    useState<EvidenceNavigationNotice | null>(null);
  const [citationCopyNotice, setCitationCopyNotice] =
    useState<CitationCopyNotice | null>(null);
  const [persistenceReady, setPersistenceReady] = useState(
    workspacePersistence == null,
  );
  const [persistenceNotice, setPersistenceNotice] = useState<string | null>(
    null,
  );
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [commentDraft, setCommentDraft] = useState<CommentDraft | null>(null);
  const [persistenceMutationPending, setPersistenceMutationPending] =
    useState(false);
  const [persistenceSaveFailed, setPersistenceSaveFailed] = useState(false);
  const [persistenceConflict, setPersistenceConflict] = useState(false);
  const activeRun = useRef<ActiveRun | null>(null);
  const activeSuggestionIdentity = useRef<ActiveSuggestionPreview | null>(null);
  const activeSuggestionLease = useRef<ActiveSuggestionLease | null>(null);
  const activeEvidenceNavigation = useRef<ActiveEvidenceNavigation | null>(
    null,
  );
  const activeCitationCopy = useRef<CitationCopyNotice | null>(null);
  const activeCommentPosting = useRef<ActiveCommentPosting | null>(null);
  const activeDiscussionRequest = useRef<ActiveDiscussionRequest | null>(null);
  const discussionsRef = useRef<Discussion[]>([]);
  const nextGeneration = useRef(0);
  const nextWorkspaceOrder = useRef(0);
  const mounted = useRef(true);
  const persistenceGeneration = useRef(0);
  const persistenceQueue = useRef<Promise<void>>(Promise.resolve());
  const activePersistenceOperation = useRef<PersistenceOperation | null>(null);
  const lastQueuedWorkspace = useRef<string | null>(null);
  const persistenceRevision = useRef(0);
  const persistenceMutationPendingRef = useRef(false);
  const persistenceSaveFailedRef = useRef(false);
  const persistenceConflictRef = useRef(false);
  const hydratedPersistenceScope = useRef<{
    projectId: string;
    persistence: AiReviewerWorkspacePersistence;
  } | null>(null);

  useEffect(() => {
    if (!reviewScopes.includes(reviewScope)) {
      setReviewScope(reviewScopes[0] ?? "project");
    }
  }, [reviewScope, reviewScopes]);

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

  const enqueuePersistenceOperation = useCallback(
    <T,>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      const generation = persistenceGeneration.current;
      const result = persistenceQueue.current
        .catch(() => {})
        .then(async () => {
          if (
            persistenceGeneration.current !== generation ||
            persistenceConflictRef.current
          ) {
            throw new DOMException(
              "The workspace persistence operation was replaced.",
              "AbortError",
            );
          }
          const active: PersistenceOperation = {
            generation,
            controller: new AbortController(),
          };
          activePersistenceOperation.current = active;
          try {
            const value = await operation(active.controller.signal);
            if (
              persistenceGeneration.current !== generation ||
              active.controller.signal.aborted
            ) {
              throw (
                active.controller.signal.reason ??
                new DOMException(
                  "The workspace persistence operation was cancelled.",
                  "AbortError",
                )
              );
            }
            return value;
          } finally {
            if (activePersistenceOperation.current === active) {
              activePersistenceOperation.current = null;
            }
          }
        });
      persistenceQueue.current = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    [],
  );

  useEffect(() => {
    hydratedPersistenceScope.current = null;
    persistenceGeneration.current += 1;
    activePersistenceOperation.current?.controller.abort(
      cancellationReason("The workspace persistence scope changed."),
    );
    activePersistenceOperation.current = null;
    persistenceQueue.current = Promise.resolve();
    lastQueuedWorkspace.current = null;
    persistenceRevision.current = 0;
    persistenceMutationPendingRef.current = false;
    persistenceSaveFailedRef.current = false;
    persistenceConflictRef.current = false;
    setPersistenceMutationPending(false);
    setPersistenceSaveFailed(false);
    setPersistenceConflict(false);

    if (workspacePersistence == null) {
      setPersistenceReady(true);
      return;
    }

    const generation = persistenceGeneration.current;
    const controller = new AbortController();
    activePersistenceOperation.current = {
      generation,
      controller,
    };
    dispatch({
      type: "hydrate",
      runs: [],
    });
    updateDiscussions(() => []);
    setActiveDiscussionId(null);
    nextGeneration.current = 0;
    nextWorkspaceOrder.current = 0;
    setPersistenceReady(false);
    setPersistenceMutationPending(false);
    setPersistenceNotice(null);
    setActionNotice(null);

    void workspacePersistence
      .load(projectId, controller.signal)
      .then(
        (storedSnapshot) => {
          if (
            !mounted.current ||
            persistenceGeneration.current !== generation ||
            controller.signal.aborted
          ) {
            return;
          }
          const storedWorkspace = storedSnapshot.workspace;
          const hydratedDiscussions = storedWorkspace.discussions.map(
            (discussion) => discussionFromWorkspace(discussion, t),
          );
          dispatch({
            type: "hydrate",
            runs: storedWorkspace.runs,
          });
          updateDiscussions(() => hydratedDiscussions);
          nextGeneration.current = storedWorkspace.runs.reduce(
            (maximum, run) => Math.max(maximum, run.generation),
            0,
          );
          nextWorkspaceOrder.current = [
            ...storedWorkspace.runs,
            ...storedWorkspace.discussions,
          ].reduce(
            (maximum, entry) => Math.max(maximum, entry.createdOrder),
            0,
          );
          lastQueuedWorkspace.current = JSON.stringify(storedWorkspace);
          persistenceRevision.current = storedSnapshot.revision;
          persistenceSaveFailedRef.current = false;
          persistenceConflictRef.current = false;
          setPersistenceSaveFailed(false);
          setPersistenceConflict(false);
          hydratedPersistenceScope.current = {
            projectId,
            persistence: workspacePersistence,
          };
          setPersistenceReady(true);
        },
        (error) => {
          if (
            !mounted.current ||
            persistenceGeneration.current !== generation ||
            controller.signal.aborted
          ) {
            return;
          }
          setPersistenceNotice(persistenceErrorMessage(error, t));
        },
      )
      .finally(() => {
        if (
          activePersistenceOperation.current?.generation === generation &&
          activePersistenceOperation.current.controller === controller
        ) {
          activePersistenceOperation.current = null;
        }
      });

    return () => {
      controller.abort(
        cancellationReason("The workspace persistence scope changed."),
      );
    };
  }, [projectId, t, updateDiscussions, workspacePersistence]);

  useEffect(() => {
    const hydratedScope = hydratedPersistenceScope.current;
    if (
      workspacePersistence == null ||
      !persistenceReady ||
      persistenceConflictRef.current ||
      persistenceMutationPendingRef.current ||
      hydratedScope == null ||
      hydratedScope.projectId !== projectId ||
      hydratedScope.persistence !== workspacePersistence
    ) {
      return;
    }
    const storedWorkspace = persistedWorkspaceFromState(workspace, discussions);
    if (storedWorkspace == null) {
      return;
    }
    const encoded = JSON.stringify(storedWorkspace);
    if (lastQueuedWorkspace.current === encoded) {
      return;
    }
    lastQueuedWorkspace.current = encoded;
    const operationGeneration = persistenceGeneration.current;
    void enqueuePersistenceOperation(async (signal) => {
      const saved = await workspacePersistence
        .save(projectId, storedWorkspace, persistenceRevision.current, signal)
        .catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === "AbortError")) {
            persistenceSaveFailedRef.current = true;
            if (isPersistenceConflict(error)) {
              persistenceConflictRef.current = true;
            }
          }
          throw error;
        });
      if (persistenceGeneration.current === operationGeneration) {
        persistenceRevision.current = saved.revision;
      }
      return saved;
    }).then(
      () => {
        if (mounted.current) {
          persistenceSaveFailedRef.current = false;
          persistenceConflictRef.current = false;
          setPersistenceSaveFailed(false);
          setPersistenceConflict(false);
          setPersistenceNotice(null);
        }
      },
      (error) => {
        if (!mounted.current) {
          return;
        }
        if (lastQueuedWorkspace.current === encoded) {
          lastQueuedWorkspace.current = null;
        }
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          persistenceSaveFailedRef.current = true;
          setPersistenceSaveFailed(true);
          if (isPersistenceConflict(error)) {
            persistenceConflictRef.current = true;
            setPersistenceConflict(true);
          }
          setPersistenceNotice(persistenceErrorMessage(error, t));
        }
      },
    );
  }, [
    discussions,
    enqueuePersistenceOperation,
    persistenceMutationPending,
    persistenceReady,
    projectId,
    t,
    workspace,
    workspacePersistence,
  ]);

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
      persistenceGeneration.current += 1;
      activePersistenceOperation.current?.controller.abort(
        cancellationReason("The AI reviewer panel was closed."),
      );
      activePersistenceOperation.current = null;
      activeCitationCopy.current = null;
      activeCommentPosting.current?.controller.abort(
        cancellationReason("The AI reviewer panel was closed."),
      );
      activeCommentPosting.current = null;
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
            t("ai_reviewer_error_event_request_mismatch"),
          );
          return;
        }
        if (run.terminal != null) {
          failRun(
            run,
            "AI_WORKSPACE_EVENT_AFTER_TERMINAL",
            t("ai_reviewer_error_data_after_terminal_event"),
          );
          return;
        }
        if (event.type === "suggestion" && request.scope.kind === "project") {
          failRun(
            run,
            "AI_PROJECT_SUGGESTION_NOT_ALLOWED",
            t("ai_reviewer_error_project_suggestion_not_allowed"),
          );
          return;
        }
        if (event.type === "finding") {
          if (run.findingIds.has(event.finding.id)) {
            failRun(
              run,
              "AI_WORKSPACE_DUPLICATE_FINDING",
              t("ai_reviewer_error_duplicate_finding"),
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
              t("ai_reviewer_error_duplicate_suggestion"),
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
        const displayEvent =
          event.type === "error"
            ? {
                ...event,
                error: {
                  ...event.error,
                  message: agentErrorMessage(event.error, t),
                },
              }
            : event;
        dispatch({
          type: "event",
          generation: run.generation,
          requestId: run.requestId,
          event: displayEvent,
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
              t("ai_reviewer_error_missing_suggestion"),
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
            t("ai_reviewer_error_stream_incomplete"),
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
          streamErrorMessage(error, t),
        );
      } finally {
        if (activeRun.current === run) {
          activeRun.current = null;
        }
      }
    },
    [failRun, isActiveRun, streamRequest, t],
  );

  const runProjectReview = useCallback(() => {
    if (persistenceConflictRef.current) {
      return;
    }
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
      if (persistenceConflictRef.current || captureSession == null) {
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
          t("ai_reviewer_error_capture_failed"),
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
          t("ai_reviewer_error_capture_scope_invalid"),
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
      executeStream,
      failRun,
      invalidateRun,
      isActiveRun,
      projectId,
      t,
    ],
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

  const runSelectedReview = useCallback(() => {
    switch (reviewScope) {
      case "selection":
        void runSelectionReview("review");
        return;
      case "document":
        void runCurrentDocumentReview();
        return;
      case "project":
        runProjectReview();
    }
  }, [
    reviewScope,
    runCurrentDocumentReview,
    runProjectReview,
    runSelectionReview,
  ]);

  const rebindSuggestionSession = useCallback(
    (request: AgentRequest): EditorSelectionSession | null => {
      if (request.scope.kind === "project" || getSelectionContext == null) {
        return null;
      }
      let liveContext: ReturnType<typeof readEditorSuggestionLiveContext>;
      try {
        liveContext = readEditorSuggestionLiveContext(getSelectionContext());
      } catch {
        return null;
      }
      if (
        liveContext.status === "conflict" ||
        liveContext.context.projectId !== request.projectId ||
        liveContext.context.documentId !== request.scope.documentId ||
        liveContext.context.path !== request.scope.path
      ) {
        return null;
      }
      return Object.freeze({
        request,
        binding: Object.freeze({
          currentDocument: liveContext.context.currentDocument,
          shareDocument: liveContext.context.shareDocument,
          trackChanges: liveContext.context.trackChanges,
          connectionEpoch: liveContext.connectionEpoch,
        }),
      });
    },
    [getSelectionContext],
  );

  const rebindEvidenceSession = useCallback(
    (request: AgentRequest): EditorSelectionSession | null => {
      if (request.scope.kind === "project" || getSelectionContext == null) {
        return null;
      }
      try {
        const context = getSelectionContext();
        const currentDocument = context.currentDocument;
        const shareDocument = currentDocument?.doc;
        if (
          context.projectId !== request.projectId ||
          context.currentDocumentId !== request.scope.documentId ||
          context.path !== request.scope.path ||
          currentDocument == null ||
          currentDocument.doc_id !== request.scope.documentId ||
          shareDocument == null
        ) {
          return null;
        }
        return Object.freeze({
          request,
          binding: Object.freeze({
            currentDocument,
            shareDocument,
            trackChanges: context.trackChanges,
            connectionEpoch: context.connectionEpoch,
          }),
        });
      } catch {
        return null;
      }
    },
    [getSelectionContext],
  );

  const prepareFindingEvidenceNavigation = useCallback(
    (
      runState: SelectionWorkspaceState,
      finding: Finding,
      evidenceIndex: number,
    ): {
      session: EditorSelectionSession | null;
      target: EditorEvidenceNavigationTarget;
    } | null => {
      const request = runState.request;
      const requestId = runState.requestId;
      if (
        runState.status !== "completed" ||
        request == null ||
        requestId == null ||
        getSelectionContext == null ||
        request.requestId !== requestId ||
        !runState.findings.includes(finding) ||
        findingStatus(runState.findingStatuses, finding.id) !== "unresolved"
      ) {
        return null;
      }

      if (request.scope.kind === "project") {
        if (resolveEvidenceDocument == null || openEvidenceDocument == null) {
          return null;
        }
        const target = createProjectEditorEvidenceNavigationTarget({
          request,
          finding,
          evidenceIndex,
        });
        return target == null
          ? null
          : {
              session: null,
              target,
            };
      }

      const session = runState.session ?? rebindEvidenceSession(request);
      if (session == null || session.request.requestId !== requestId) {
        return null;
      }
      const target = createEditorEvidenceNavigationTarget({
        session,
        finding,
        evidenceIndex,
      });
      return target == null
        ? null
        : {
            session,
            target,
          };
    },
    [
      getSelectionContext,
      openEvidenceDocument,
      rebindEvidenceSession,
      resolveEvidenceDocument,
    ],
  );

  const openFindingEvidence = useCallback(
    (
      runState: SelectionWorkspaceState,
      finding: Finding,
      evidenceIndex: number,
    ) => {
      const prepared = prepareFindingEvidenceNavigation(
        runState,
        finding,
        evidenceIndex,
      );
      const requestId = runState.requestId;
      if (
        prepared == null ||
        requestId == null ||
        getSelectionContext == null
      ) {
        return;
      }
      const { session, target } = prepared;

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
              resolveDocument: resolveEvidenceDocument,
              openDocument: openEvidenceDocument,
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
      openEvidenceDocument,
      prepareFindingEvidenceNavigation,
      resolveEvidenceDocument,
    ],
  );

  const discardFinding = useCallback(
    (runState: SelectionWorkspaceState, finding: Finding) => {
      if (
        persistenceConflictRef.current ||
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

  const openCommentDraft = useCallback(
    ({
      key,
      generation,
      request,
      artifact,
      discussionId = null,
    }: {
      key: string;
      generation: number;
      request: AgentRequest;
      artifact: PostableAiReviewerArtifact;
      discussionId?: string | null;
    }) => {
      if (
        postEditorComment == null ||
        getSelectionContext == null ||
        request.projectId !== projectId
      ) {
        return;
      }
      activeCommentPosting.current?.controller.abort(
        cancellationReason("Another comment draft was opened."),
      );
      activeCommentPosting.current = null;
      setCommentDraft({
        key,
        generation,
        request,
        artifact,
        discussionId,
        content: defaultCommentBody(artifact, t),
        status: "editing",
        error: null,
      });
    },
    [getSelectionContext, postEditorComment, projectId, t],
  );

  const cancelCommentDraft = useCallback(() => {
    activeCommentPosting.current?.controller.abort(
      cancellationReason("Comment posting was cancelled."),
    );
    activeCommentPosting.current = null;
    setCommentDraft(null);
  }, []);

  const submitCommentDraft = useCallback(async () => {
    const draft = commentDraft;
    if (
      draft == null ||
      draft.status !== "editing" ||
      draft.content.trim() === "" ||
      postEditorComment == null ||
      getSelectionContext == null
    ) {
      return;
    }
    const identity: ActiveCommentPosting = {
      key: draft.key,
      controller: new AbortController(),
    };
    activeCommentPosting.current?.controller.abort(
      cancellationReason("Another comment was posted."),
    );
    activeCommentPosting.current = identity;
    setCommentDraft({
      ...draft,
      status: "posting",
      error: null,
    });

    const result = await postAiReviewerArtifactComment({
      request: draft.request,
      artifact: draft.artifact,
      content: draft.content,
      getContext: getSelectionContext,
      resolveDocument: resolveEvidenceDocument,
      openDocument: openEvidenceDocument,
      signal: identity.controller.signal,
      navigateEvidence,
      postComment: postEditorComment,
    });
    if (
      !mounted.current ||
      activeCommentPosting.current !== identity ||
      identity.controller.signal.aborted
    ) {
      return;
    }
    activeCommentPosting.current = null;
    if (result.status === "posted") {
      if (draft.discussionId == null) {
        dispatch(
          "artifactKind" in draft.artifact
            ? {
                type: "post-finding",
                generation: draft.generation,
                requestId: draft.request.requestId,
                findingId: draft.artifact.id,
              }
            : {
                type: "post-suggestion",
                generation: draft.generation,
                requestId: draft.request.requestId,
                suggestionId: draft.artifact.id,
              },
        );
      } else {
        updateDiscussions((current) =>
          current.map((discussion) =>
            discussion.id === draft.discussionId
              ? {
                  ...discussion,
                  suggestionStatuses: {
                    ...discussion.suggestionStatuses,
                    [draft.artifact.id]: "posted",
                  },
                  updatedAt: now(),
                }
              : discussion,
          ),
        );
      }
      setCommentDraft(null);
      return;
    }
    if (result.status === "cancelled") {
      setCommentDraft({
        ...draft,
        status: "editing",
        error: null,
      });
      return;
    }
    setCommentDraft({
      ...draft,
      status: "editing",
      error: commentPostingErrorMessage(result, t),
    });
  }, [
    commentDraft,
    getSelectionContext,
    navigateEvidence,
    now,
    openEvidenceDocument,
    postEditorComment,
    resolveEvidenceDocument,
    t,
    updateDiscussions,
  ]);

  const runInProgress = workspace.runs.some(
    (run) =>
      run.status === "capturing" ||
      run.status === "streaming" ||
      run.status === "finalizing",
  );
  const busy =
    (workspacePersistence != null && !persistenceReady) ||
    persistenceMutationPending ||
    persistenceConflict ||
    runInProgress;
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
    (runState: SelectionWorkspaceState, suggestion: UnresolvedSuggestion) => {
      const session =
        runState.session ??
        (runState.request == null
          ? null
          : rebindSuggestionSession(runState.request));
      const requestId = runState.requestId;
      if (
        persistenceConflictRef.current ||
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
        if (
          runState.status === "completed" &&
          runState.request?.scope.kind !== "project" &&
          session == null
        ) {
          setActionNotice(
            t("ai_reviewer_open_reviewed_document_in_source_mode"),
          );
        }
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

      setActionNotice(null);
      disposeActiveSuggestion(
        cancellationReason("Another suggestion preview was selected."),
      );
      if (runState.session == null) {
        dispatch({
          type: "rebind-session",
          generation: runState.generation,
          requestId,
          session,
        });
      }
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
    [disposeActiveSuggestion, getSelectionContext, rebindSuggestionSession, t],
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
    (runState: SelectionWorkspaceState, suggestion: UnresolvedSuggestion) => {
      const requestId = runState.requestId;
      const status = suggestionStatus(
        runState.suggestionStatuses,
        suggestion.id,
      );
      if (
        persistenceConflictRef.current ||
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
        persistenceConflictRef.current ||
        persistenceMutationPendingRef.current ||
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
        setActionNotice(null);
        setActiveDiscussionId(existing.id);
        return;
      }
      if (
        discussionsRef.current.length >= AI_REVIEWER_WORKSPACE_DISCUSSION_LIMIT
      ) {
        setActionNotice(t("ai_reviewer_workspace_limit_reached"));
        return;
      }

      const id = createDiscussionId();
      nextWorkspaceOrder.current += 1;
      const discussion: Discussion = {
        id,
        createdOrder: nextWorkspaceOrder.current,
        subjectKey,
        subject,
        subjectLabel: discussionSubjectLabel(subject, t),
        sourceGeneration: runState.generation,
        sourceSession:
          runState.session ?? rebindSuggestionSession(runState.request),
        turns: [],
        suggestions: [],
        suggestionStatuses: {},
        suggestionConflictCodes: {},
        status: "idle",
        error: null,
        updatedAt: now(),
      };
      updateDiscussions((current) => [...current, discussion]);
      setActionNotice(null);
      setActiveDiscussionId(id);
    },
    [createDiscussionId, now, rebindSuggestionSession, t, updateDiscussions],
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
    const text = discussionInput.trim();
    if (text === "") {
      return;
    }
    let discussion =
      activeDiscussionId == null
        ? null
        : (discussionsRef.current.find(
            (candidate) => candidate.id === activeDiscussionId,
          ) ?? null);
    if (discussion == null && activeDiscussionId == null) {
      if (
        persistenceConflictRef.current ||
        persistenceMutationPendingRef.current ||
        discussionsRef.current.some(
          (candidate) => candidate.status === "streaming",
        )
      ) {
        return;
      }
      if (
        discussionsRef.current.length >= AI_REVIEWER_WORKSPACE_DISCUSSION_LIMIT
      ) {
        setActionNotice(t("ai_reviewer_workspace_limit_reached"));
        return;
      }

      const id = createDiscussionId();
      nextWorkspaceOrder.current += 1;
      discussion = {
        id,
        createdOrder: nextWorkspaceOrder.current,
        subjectKey: null,
        subject: null,
        subjectLabel: discussionSubjectLabel(null, t),
        sourceGeneration: null,
        sourceSession: null,
        turns: [],
        suggestions: [],
        suggestionStatuses: {},
        suggestionConflictCodes: {},
        status: "idle",
        error: null,
        updatedAt: now(),
      };
      const openDiscussion = discussion;
      updateDiscussions((current) => [...current, openDiscussion]);
      setActionNotice(null);
      setActiveDiscussionId(id);
    }
    if (
      persistenceConflictRef.current ||
      persistenceMutationPendingRef.current ||
      discussion == null ||
      discussion.status === "streaming"
    ) {
      return;
    }
    const discussionId = discussion.id;
    if (discussion.turns.length + 2 > AI_REVIEWER_WORKSPACE_TURN_LIMIT) {
      setActionNotice(t("ai_reviewer_workspace_limit_reached"));
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
    setActionNotice(null);
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
          t("ai_reviewer_error_discussion_event_request_mismatch"),
        );
        return;
      }
      if (active.terminal != null) {
        failDiscussionRequest(
          active,
          t("ai_reviewer_error_discussion_data_after_terminal"),
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
            t("ai_reviewer_error_duplicate_discussion_suggestion"),
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
                  error: agentErrorMessage(event.error, t),
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
            t("ai_reviewer_error_discussion_incomplete"),
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
        failDiscussionRequest(active, streamErrorMessage(error, t));
      })
      .finally(() => {
        if (activeDiscussionRequest.current === active) {
          activeDiscussionRequest.current = null;
        }
      });
  }, [
    activeDiscussionId,
    createDiscussionId,
    createDiscussionRequestId,
    discussionInput,
    failDiscussionRequest,
    now,
    projectId,
    streamDiscussionRequest,
    t,
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

  useEffect(() => {
    if (!persistenceConflict) {
      return;
    }
    cancel();
    const active = activeDiscussionRequest.current;
    activeDiscussionRequest.current = null;
    if (active != null) {
      if (!active.controller.signal.aborted) {
        active.controller.abort(
          cancellationReason(
            "The saved review workspace changed in another session.",
          ),
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
    }
    disposeActiveSuggestion(
      cancellationReason(
        "The saved review workspace changed in another session.",
      ),
    );
  }, [
    cancel,
    disposeActiveSuggestion,
    now,
    persistenceConflict,
    updateDiscussions,
  ]);

  const openDiscussionSuggestionPreview = useCallback(
    (discussion: Discussion, suggestion: UnresolvedSuggestion) => {
      const sourceRequest = discussion.subject?.sourceRequest;
      const sourceGeneration = discussion.sourceGeneration;
      if (sourceRequest == null || sourceGeneration == null) {
        return;
      }
      const session =
        discussion.sourceSession ?? rebindSuggestionSession(sourceRequest);
      if (
        persistenceConflictRef.current ||
        session == null ||
        getSelectionContext == null ||
        sourceRequest.scope.kind === "project" ||
        session.request !== sourceRequest ||
        !discussion.suggestions.includes(suggestion) ||
        suggestionStatus(discussion.suggestionStatuses, suggestion.id) !==
          "unresolved"
      ) {
        if (sourceRequest.scope.kind !== "project" && session == null) {
          setActionNotice(
            t("ai_reviewer_open_reviewed_document_in_source_mode"),
          );
        }
        return;
      }

      if (discussion.sourceSession == null) {
        updateDiscussions((current) =>
          current.map((candidate) =>
            candidate.id === discussion.id
              ? {
                  ...candidate,
                  sourceSession: session,
                }
              : candidate,
          ),
        );
      }
      setActionNotice(null);
      disposeActiveSuggestion(
        cancellationReason("Another suggestion preview was selected."),
      );
      const identity: ActiveSuggestionPreview = {
        generation: sourceGeneration,
        requestId: session.request.requestId,
        discussionId: discussion.id,
        session,
        suggestion,
      };
      activeSuggestionIdentity.current = identity;
      setActiveSuggestionPreview(identity);
    },
    [
      disposeActiveSuggestion,
      getSelectionContext,
      rebindSuggestionSession,
      t,
      updateDiscussions,
    ],
  );

  const discardDiscussionSuggestion = useCallback(
    (discussion: Discussion, suggestion: UnresolvedSuggestion) => {
      const status = suggestionStatus(
        discussion.suggestionStatuses,
        suggestion.id,
      );
      if (
        persistenceConflictRef.current ||
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

  const finishDiscussionDeletion = useCallback(
    (
      discussionId: string,
      persistedAfterDeletion: AiReviewerWorkspace | null = null,
      beforeDeletion: AiReviewerWorkspace | null = null,
      clearDiscussionInput = false,
    ) => {
      let remainingDiscussions = discussionsRef.current.filter(
        (discussion) => discussion.id !== discussionId,
      );
      let mergeConflicted = false;
      if (persistedAfterDeletion != null) {
        const currentAfterDeletion = persistedWorkspaceFromState(
          workspaceRef.current,
          remainingDiscussions,
        );
        const mergeResult =
          beforeDeletion == null || currentAfterDeletion == null
            ? null
            : mergeWorkspaceDecisionChanges(
                persistedAfterDeletion,
                beforeDeletion,
                currentAfterDeletion,
              );
        mergeConflicted = mergeResult?.conflicted ?? false;
        const mergedWorkspace = mergeConflicted
          ? persistedAfterDeletion
          : (mergeResult?.workspace ?? persistedAfterDeletion);
        remainingDiscussions = mergedWorkspace.discussions.map((discussion) =>
          discussionFromWorkspace(discussion, t),
        );
        dispatch({
          type: "hydrate",
          runs: mergedWorkspace.runs,
        });
        nextGeneration.current = mergedWorkspace.runs.reduce(
          (maximum, run) => Math.max(maximum, run.generation),
          0,
        );
        nextWorkspaceOrder.current = [
          ...mergedWorkspace.runs,
          ...mergedWorkspace.discussions,
        ].reduce((maximum, entry) => Math.max(maximum, entry.createdOrder), 0);
        lastQueuedWorkspace.current = JSON.stringify(persistedAfterDeletion);
      } else {
        const storedWorkspace = persistedWorkspaceFromState(
          workspaceRef.current,
          remainingDiscussions,
        );
        const prunedWorkspace =
          storedWorkspace == null
            ? null
            : dropEmptyUnboundRuns(storedWorkspace);
        if (prunedWorkspace != null) {
          const retainedGenerations = new Set(
            prunedWorkspace.runs.map((run) => run.generation),
          );
          for (const run of workspaceRef.current.runs) {
            if (workspaceRunFromState(run) == null) {
              retainedGenerations.add(run.generation);
            }
          }
          dispatch({
            type: "retain-runs",
            generations: [...retainedGenerations],
          });
        } else {
          dispatch({
            type: "retain-runs",
            generations: workspaceRef.current.runs
              .filter((run) => workspaceRunFromState(run) == null)
              .map((run) => run.generation),
          });
        }
        lastQueuedWorkspace.current = null;
      }
      const discussionRequest = activeDiscussionRequest.current;
      if (discussionRequest?.discussionId === discussionId) {
        activeDiscussionRequest.current = null;
        if (!discussionRequest.controller.signal.aborted) {
          discussionRequest.controller.abort(
            cancellationReason("The discussion was deleted."),
          );
        }
      }
      if (activeSuggestionIdentity.current?.discussionId === discussionId) {
        disposeActiveSuggestion(
          cancellationReason("The discussion was deleted."),
        );
      }
      updateDiscussions(() => remainingDiscussions);
      if (activeDiscussionIdRef.current === discussionId) {
        setActiveDiscussionId(null);
      }
      if (clearDiscussionInput) {
        setDiscussionInput("");
      }
      return mergeConflicted;
    },
    [disposeActiveSuggestion, t, updateDiscussions],
  );

  const deleteDiscussion = useCallback(
    (discussion: Discussion) => {
      if (
        persistenceSaveFailedRef.current ||
        busy ||
        persistenceMutationPendingRef.current ||
        discussionsRef.current.some(
          (candidate) => candidate.status === "streaming",
        ) ||
        !discussionsRef.current.includes(discussion)
      ) {
        return;
      }
      if (activeSuggestionIdentity.current?.discussionId === discussion.id) {
        disposeActiveSuggestion(
          cancellationReason("The discussion was deleted."),
        );
      }
      const clearDiscussionInput =
        activeDiscussionIdRef.current === discussion.id;
      if (workspacePersistence == null) {
        finishDiscussionDeletion(
          discussion.id,
          null,
          null,
          clearDiscussionInput,
        );
        return;
      }
      const scope = hydratedPersistenceScope.current;
      if (
        scope == null ||
        scope.projectId !== projectId ||
        scope.persistence !== workspacePersistence
      ) {
        return;
      }
      const beforeDeletion = persistedWorkspaceFromState(
        workspaceRef.current,
        discussionsRef.current,
      );
      if (beforeDeletion == null) {
        return;
      }
      persistenceMutationPendingRef.current = true;
      setPersistenceMutationPending(true);
      const operationGeneration = persistenceGeneration.current;
      void enqueuePersistenceOperation(async (signal) => {
        if (persistenceSaveFailedRef.current) {
          throw new DOMException(
            "The saved workspace must be reloaded before deletion.",
            "AbortError",
          );
        }
        const snapshot = await workspacePersistence.deleteDiscussion(
          projectId,
          discussion.id,
          signal,
        );
        if (persistenceGeneration.current === operationGeneration) {
          persistenceRevision.current = snapshot.revision;
        }
        return snapshot;
      }).then(
        (snapshot) => {
          if (!mounted.current || hydratedPersistenceScope.current !== scope) {
            return;
          }
          const mergeConflicted = finishDiscussionDeletion(
            discussion.id,
            snapshot.workspace,
            beforeDeletion,
            clearDiscussionInput,
          );
          persistenceMutationPendingRef.current = false;
          setPersistenceMutationPending(false);
          if (mergeConflicted) {
            persistenceSaveFailedRef.current = true;
            persistenceConflictRef.current = true;
            setPersistenceSaveFailed(true);
            setPersistenceConflict(true);
            setPersistenceNotice(t("ai_reviewer_workspace_changed"));
          } else {
            persistenceSaveFailedRef.current = false;
            persistenceConflictRef.current = false;
            setPersistenceSaveFailed(false);
            setPersistenceConflict(false);
            setPersistenceNotice(null);
            setActionNotice(null);
          }
        },
        (error) => {
          if (!mounted.current || hydratedPersistenceScope.current !== scope) {
            return;
          }
          persistenceMutationPendingRef.current = false;
          setPersistenceMutationPending(false);
          if (!(error instanceof DOMException && error.name === "AbortError")) {
            persistenceSaveFailedRef.current = true;
            setPersistenceSaveFailed(true);
            if (isPersistenceConflict(error)) {
              persistenceConflictRef.current = true;
              setPersistenceConflict(true);
            }
            setPersistenceNotice(persistenceErrorMessage(error, t));
          }
        },
      );
    },
    [
      busy,
      disposeActiveSuggestion,
      enqueuePersistenceOperation,
      finishDiscussionDeletion,
      projectId,
      t,
      workspacePersistence,
    ],
  );

  const finishWorkspaceDeletion = useCallback(() => {
    const emptyWorkspace: AiReviewerWorkspace = {
      runs: [],
      discussions: [],
    };
    lastQueuedWorkspace.current = JSON.stringify(emptyWorkspace);
    const discussionRequest = activeDiscussionRequest.current;
    activeDiscussionRequest.current = null;
    if (
      discussionRequest != null &&
      !discussionRequest.controller.signal.aborted
    ) {
      discussionRequest.controller.abort(
        cancellationReason("The saved review workspace was deleted."),
      );
    }
    disposeActiveEvidenceNavigation(
      cancellationReason("The saved review workspace was deleted."),
    );
    disposeActiveSuggestion(
      cancellationReason("The saved review workspace was deleted."),
    );
    clearCitationCopy();
    dispatch({
      type: "hydrate",
      runs: [],
    });
    updateDiscussions(() => []);
    setActiveDiscussionId(null);
    setDiscussionInput("");
    nextGeneration.current = 0;
    nextWorkspaceOrder.current = 0;
  }, [
    clearCitationCopy,
    disposeActiveEvidenceNavigation,
    disposeActiveSuggestion,
    updateDiscussions,
  ]);

  const deleteWorkspace = useCallback(() => {
    if (
      persistenceConflictRef.current ||
      busy ||
      persistenceMutationPendingRef.current ||
      discussionsRef.current.some(
        (discussion) => discussion.status === "streaming",
      )
    ) {
      return;
    }
    disposeActiveSuggestion(
      cancellationReason("The saved review workspace was deleted."),
    );
    if (workspacePersistence == null) {
      finishWorkspaceDeletion();
      return;
    }
    const scope = hydratedPersistenceScope.current;
    if (
      scope == null ||
      scope.projectId !== projectId ||
      scope.persistence !== workspacePersistence
    ) {
      return;
    }
    persistenceMutationPendingRef.current = true;
    setPersistenceMutationPending(true);
    const operationGeneration = persistenceGeneration.current;
    void enqueuePersistenceOperation(async (signal) => {
      const snapshot = await workspacePersistence.deleteAll(projectId, signal);
      if (persistenceGeneration.current === operationGeneration) {
        persistenceRevision.current = snapshot.revision;
      }
      return snapshot;
    }).then(
      () => {
        if (!mounted.current || hydratedPersistenceScope.current !== scope) {
          return;
        }
        finishWorkspaceDeletion();
        persistenceMutationPendingRef.current = false;
        persistenceSaveFailedRef.current = false;
        persistenceConflictRef.current = false;
        setPersistenceMutationPending(false);
        setPersistenceSaveFailed(false);
        setPersistenceConflict(false);
        setPersistenceNotice(null);
        setActionNotice(null);
      },
      (error) => {
        if (!mounted.current || hydratedPersistenceScope.current !== scope) {
          return;
        }
        persistenceMutationPendingRef.current = false;
        setPersistenceMutationPending(false);
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          persistenceSaveFailedRef.current = true;
          setPersistenceSaveFailed(true);
          if (isPersistenceConflict(error)) {
            persistenceConflictRef.current = true;
            setPersistenceConflict(true);
          }
          setPersistenceNotice(persistenceErrorMessage(error, t));
        }
      },
    );
  }, [
    busy,
    disposeActiveSuggestion,
    enqueuePersistenceOperation,
    finishWorkspaceDeletion,
    projectId,
    t,
    workspacePersistence,
  ]);

  const activeDiscussion =
    activeDiscussionId == null
      ? null
      : (discussions.find(
          (discussion) => discussion.id === activeDiscussionId,
        ) ?? null);
  const activeDiscussionSourceRequest =
    activeDiscussion?.subject?.sourceRequest ?? null;
  const hasActiveDiscussionSuggestions =
    activeDiscussionSourceRequest != null &&
    activeDiscussion != null &&
    activeDiscussion.suggestions.length > 0;
  const workspaceNotice = persistenceConflict
    ? persistenceNotice
    : (actionNotice ?? persistenceNotice);

  const renderSuggestionPreview = (
    identity: ActiveSuggestionPreview,
    suggestion: UnresolvedSuggestion,
  ) =>
    getSelectionContext == null || persistenceConflict ? null : (
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

  const renderCommentDraft = (key: string) => {
    if (commentDraft?.key !== key) {
      return null;
    }
    return (
      <form
        className="ai-reviewer-comment-form"
        aria-label={t("ai_reviewer_post_artifact_comment_form")}
        onSubmit={(event) => {
          event.preventDefault();
          void submitCommentDraft();
        }}
      >
        <OLFormLabel htmlFor={`ai-comment-${key}`}>
          {t("ai_reviewer_comment_body")}
        </OLFormLabel>
        <AutoExpandingTextArea
          id={`ai-comment-${key}`}
          className="form-control ai-reviewer-panel-textarea"
          value={commentDraft.content}
          disabled={commentDraft.status === "posting"}
          onChange={(event) =>
            setCommentDraft((current) =>
              current?.key === key
                ? {
                    ...current,
                    content: event.target.value,
                    error: null,
                  }
                : current,
            )
          }
        />
        <div className="ai-reviewer-panel-actions">
          <OLButton
            type="submit"
            variant="secondary"
            size="sm"
            disabled={
              commentDraft.status === "posting" ||
              commentDraft.content.trim() === ""
            }
          >
            {commentDraft.status === "posting"
              ? t("ai_reviewer_posting_comment")
              : t("ai_reviewer_post_comment")}
          </OLButton>
          <OLButton
            type="button"
            variant="ghost"
            size="sm"
            onClick={cancelCommentDraft}
          >
            {t("ai_reviewer_cancel_comment")}
          </OLButton>
        </div>
        {commentDraft.error != null && (
          <p className="ai-reviewer-panel-error" role="alert">
            {commentDraft.error}
          </p>
        )}
      </form>
    );
  };

  const renderRun = (runState: SelectionWorkspaceState) => {
    const findings = runState.findings.filter(
      (finding): finding is OrdinaryFinding =>
        finding.artifactKind === "finding",
    );
    const citationFindings = runState.findings.filter(
      (finding): finding is CitationFinding =>
        finding.artifactKind === "citation-finding",
    );
    const canDiscuss =
      !persistenceConflict &&
      runState.status === "completed" &&
      runState.request != null;

    const renderFinding = (finding: OrdinaryFinding) => {
      const status = findingStatus(runState.findingStatuses, finding.id);
      const commentDraftKey = `run:${runState.generation}:finding:${finding.id}`;
      const body = (
        <>
          <ExpandableContent
            className="ai-reviewer-panel-prose"
            content={finding.message}
            contentLimit={240}
            checkNewLines
            translate="no"
          />
          <ul className="ai-reviewer-panel-locations">
            {finding.evidence.map((reference, index) => {
              const navigationTarget =
                prepareFindingEvidenceNavigation(runState, finding, index)
                  ?.target ?? null;
              const location = evidenceLocation(reference);
              return (
                <li key={`${finding.id}-evidence-${index}`}>
                  <code className="ai-reviewer-panel-location" title={location}>
                    {location}
                  </code>
                  {navigationTarget != null && (
                    <OLButton
                      type="button"
                      variant="link"
                      size="sm"
                      onClick={() =>
                        openFindingEvidence(runState, finding, index)
                      }
                    >
                      {t("ai_reviewer_go_to_location", {
                        index: index + 1,
                      })}
                    </OLButton>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="ai-reviewer-panel-actions">
            {canDiscuss && runState.request != null && (
              <OLButton
                type="button"
                variant="secondary"
                size="sm"
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
                {t("ai_reviewer_discuss_finding")}
              </OLButton>
            )}
            {status === "unresolved" &&
              runState.status === "completed" &&
              runState.request != null &&
              postEditorComment != null &&
              getSelectionContext != null && (
                <OLButton
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={
                    persistenceConflict ||
                    (commentDraft != null &&
                      commentDraft.key !== commentDraftKey)
                  }
                  onClick={() =>
                    openCommentDraft({
                      key: commentDraftKey,
                      generation: runState.generation,
                      request: runState.request!,
                      artifact: finding,
                    })
                  }
                >
                  {t("ai_reviewer_post_finding_as_comment")}
                </OLButton>
              )}
            {status === "unresolved" && (
              <OLButton
                type="button"
                variant="ghost"
                size="sm"
                disabled={
                  persistenceConflict || commentDraft?.key === commentDraftKey
                }
                onClick={() => discardFinding(runState, finding)}
              >
                {t("ai_reviewer_discard_finding")}
              </OLButton>
            )}
          </div>
          {renderCommentDraft(commentDraftKey)}
        </>
      );
      return isTerminalArtifactStatus(status) ? (
        <details
          key={finding.id}
          className="ai-reviewer-artifact ai-reviewer-artifact-resolved"
        >
          <summary className="ai-reviewer-artifact-summary">
            <span className="ai-reviewer-panel-truncate" title={finding.title}>
              {finding.title}
            </span>
            <span className="ai-reviewer-artifact-status">
              {t("ai_reviewer_artifact_status", {
                status: artifactStatusLabel(status, t),
              })}
            </span>
          </summary>
          {body}
        </details>
      ) : (
        <article key={finding.id} className="ai-reviewer-artifact">
          <h5 className="ai-reviewer-artifact-title">{finding.title}</h5>
          <p className="ai-reviewer-artifact-status">
            {t("ai_reviewer_artifact_status", {
              status: artifactStatusLabel(status, t),
            })}
          </p>
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
          <ExpandableContent
            className="ai-reviewer-panel-prose"
            content={finding.message}
            contentLimit={240}
            checkNewLines
            translate="no"
          />
          <p className="ai-reviewer-panel-quoted-source">
            {t("ai_reviewer_proposed_text", {
              proposedText: finding.proposedText,
            })}
          </p>
          <ul className="ai-reviewer-panel-locations">
            {finding.evidence.map((reference, index) => {
              const navigationTarget =
                prepareFindingEvidenceNavigation(runState, finding, index)
                  ?.target ?? null;
              const location = evidenceLocation(reference);
              return (
                <li key={`${finding.id}-evidence-${index}`}>
                  <code className="ai-reviewer-panel-location" title={location}>
                    {location}
                  </code>
                  {navigationTarget != null && (
                    <OLButton
                      type="button"
                      variant="link"
                      size="sm"
                      onClick={() =>
                        openFindingEvidence(runState, finding, index)
                      }
                    >
                      {t("ai_reviewer_go_to_location", {
                        index: index + 1,
                      })}
                    </OLButton>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="ai-reviewer-panel-actions">
            {canDiscuss && runState.request != null && (
              <OLButton
                type="button"
                variant="secondary"
                size="sm"
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
                {t("ai_reviewer_discuss_citation_finding")}
              </OLButton>
            )}
            {status === "unresolved" && (
              <>
                <OLButton
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={
                    persistenceConflict || copyNotice?.status === "copying"
                  }
                  onClick={() => copyCitationProposedText(runState, finding)}
                >
                  {t("ai_reviewer_copy_proposed_text")}
                </OLButton>
                <OLButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={persistenceConflict}
                  onClick={() => discardFinding(runState, finding)}
                >
                  {t("ai_reviewer_discard_citation_finding")}
                </OLButton>
              </>
            )}
          </div>
          {copyNotice != null && (
            <p aria-live="polite">
              {copyNotice.status === "copying"
                ? t("ai_reviewer_copying_proposed_text")
                : copyNotice.status === "copied"
                  ? t("ai_reviewer_proposed_text_copied")
                  : t("ai_reviewer_proposed_text_copy_failed")}
            </p>
          )}
        </>
      );
      return isTerminalArtifactStatus(status) ? (
        <details
          key={finding.id}
          className="ai-reviewer-artifact ai-reviewer-artifact-resolved"
        >
          <summary className="ai-reviewer-artifact-summary">
            <span className="ai-reviewer-panel-truncate" title={finding.title}>
              {finding.title}
            </span>
            <span className="ai-reviewer-artifact-status">
              {t("ai_reviewer_artifact_status", {
                status: artifactStatusLabel(status, t),
              })}
            </span>
          </summary>
          {body}
        </details>
      ) : (
        <article key={finding.id} className="ai-reviewer-artifact">
          <h5 className="ai-reviewer-artifact-title">{finding.title}</h5>
          <p className="ai-reviewer-artifact-status">
            {t("ai_reviewer_artifact_status", {
              status: artifactStatusLabel(status, t),
            })}
          </p>
          {body}
        </article>
      );
    };

    const renderSuggestion = (
      suggestion: UnresolvedSuggestion,
      index: number,
    ) => {
      const commentDraftKey = `run:${runState.generation}:suggestion:${suggestion.id}`;
      const status = suggestionStatus(
        runState.suggestionStatuses,
        suggestion.id,
      );
      const previewAvailable =
        runState.status === "completed" &&
        runState.request != null &&
        getSelectionContext != null &&
        runState.request.scope.kind !== "project" &&
        runState.request.requestId === runState.requestId &&
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
        activeSuggestionPreview.suggestion === suggestion;
      const body = (
        <>
          <p className="ai-reviewer-panel-quoted-source">
            {t("ai_reviewer_suggestion_original", {
              original: suggestion.original,
            })}
          </p>
          <p className="ai-reviewer-panel-quoted-source">
            {t("ai_reviewer_suggestion_replacement", {
              replacement: suggestion.replacement,
            })}
          </p>
          <p className="ai-reviewer-panel-prose">
            {t("ai_reviewer_suggestion_rationale", {
              rationale: suggestion.rationale,
            })}
          </p>
          <ul className="ai-reviewer-panel-locations">
            {suggestion.evidence.map((reference, evidenceIndex) => {
              const location = evidenceLocation(reference);
              return (
                <li key={`${suggestion.id}-evidence-${evidenceIndex}`}>
                  <code className="ai-reviewer-panel-location" title={location}>
                    {location}
                  </code>
                </li>
              );
            })}
          </ul>
          <div className="ai-reviewer-panel-actions">
            {canDiscuss && runState.request != null && (
              <OLButton
                type="button"
                variant="secondary"
                size="sm"
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
                {t("ai_reviewer_discuss_suggestion")}
              </OLButton>
            )}
            {previewAvailable && (
              <OLButton
                type="button"
                variant="secondary"
                size="sm"
                disabled={persistenceConflict}
                onClick={() => openSuggestionPreview(runState, suggestion)}
              >
                {t("ai_reviewer_preview_diff", {
                  index: index + 1,
                })}
              </OLButton>
            )}
            {status === "unresolved" &&
              runState.status === "completed" &&
              runState.request != null &&
              postEditorComment != null &&
              getSelectionContext != null && (
                <OLButton
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={
                    persistenceConflict ||
                    (commentDraft != null &&
                      commentDraft.key !== commentDraftKey)
                  }
                  onClick={() =>
                    openCommentDraft({
                      key: commentDraftKey,
                      generation: runState.generation,
                      request: runState.request!,
                      artifact: suggestion,
                    })
                  }
                >
                  {t("ai_reviewer_post_suggestion_as_comment")}
                </OLButton>
              )}
            {discardAvailable && (
              <OLButton
                type="button"
                variant="ghost"
                size="sm"
                disabled={
                  persistenceConflict || commentDraft?.key === commentDraftKey
                }
                onClick={() => discardSuggestion(runState, suggestion)}
              >
                {t("ai_reviewer_discard_suggestion")}
              </OLButton>
            )}
          </div>
          {renderCommentDraft(commentDraftKey)}
          {previewActive &&
            activeSuggestionPreview != null &&
            renderSuggestionPreview(activeSuggestionPreview, suggestion)}
          {status === "conflict" && (
            <p aria-live="polite">
              {runState.suggestionConflictCodes[suggestion.id] == null
                ? t("ai_reviewer_suggestion_conflict")
                : t("ai_reviewer_suggestion_conflict_with_code", {
                    code: runState.suggestionConflictCodes[suggestion.id],
                  })}
            </p>
          )}
        </>
      );
      return isTerminalArtifactStatus(status) ? (
        <details
          key={suggestion.id}
          className="ai-reviewer-artifact ai-reviewer-artifact-resolved"
        >
          <summary className="ai-reviewer-artifact-summary">
            <span
              className="ai-reviewer-panel-truncate"
              title={suggestion.rationale}
            >
              {suggestion.rationale}
            </span>
            <span className="ai-reviewer-artifact-status">
              {t("ai_reviewer_artifact_status", {
                status: artifactStatusLabel(status, t),
              })}
            </span>
          </summary>
          {body}
        </details>
      ) : (
        <article key={suggestion.id} className="ai-reviewer-artifact">
          <p className="ai-reviewer-artifact-status">
            {t("ai_reviewer_artifact_status", {
              status: artifactStatusLabel(status, t),
            })}
          </p>
          {body}
        </article>
      );
    };

    return (
      <article
        key={`run:${runState.generation}`}
        aria-label={t("ai_reviewer_review_run", {
          generation: runState.generation,
        })}
        className="ai-reviewer-run"
      >
        <header className="ai-reviewer-run-header">
          <div className="ai-reviewer-run-heading">
            <h3 className="ai-reviewer-run-title">
              {reviewScopeLabel(runState.scopeKind, t)}
            </h3>
            <span className="ai-reviewer-run-status" aria-live="polite">
              {runStatusLabel(runState.status, t)}
            </span>
          </div>
          <div className="ai-reviewer-panel-actions">
            {canDiscuss && runState.request != null && (
              <OLButton
                type="button"
                variant="secondary"
                size="sm"
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
                {t("ai_reviewer_discuss_review_scope")}
              </OLButton>
            )}
            {activeRun.current?.generation === runState.generation &&
              runInProgress && (
                <OLButton
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={cancel}
                >
                  {t("ai_reviewer_cancel_review")}
                </OLButton>
              )}
          </div>
        </header>
        {runState.text !== "" && (
          <ExpandableContent
            className="ai-reviewer-panel-prose"
            content={runState.text}
            contentLimit={320}
            checkNewLines
            translate="no"
          />
        )}
        {findings.length > 0 && (
          <section
            className="ai-reviewer-run-artifacts"
            aria-label={t("ai_reviewer_review_findings")}
          >
            <h4 className="ai-reviewer-run-section-title">
              {t("ai_reviewer_findings")}
            </h4>
            {findings.map(renderFinding)}
          </section>
        )}
        {citationFindings.length > 0 && (
          <section
            className="ai-reviewer-run-artifacts"
            aria-label={t("ai_reviewer_review_citation_findings")}
          >
            <h4 className="ai-reviewer-run-section-title">
              {t("ai_reviewer_citation_findings")}
            </h4>
            {citationFindings.map(renderCitationFinding)}
          </section>
        )}
        {evidenceNavigationNotice?.identity.generation ===
          runState.generation && (
          <p aria-live="polite">
            {evidenceNavigationMessage(evidenceNavigationNotice, t)}
          </p>
        )}
        {runState.suggestions.length > 0 && (
          <section
            className="ai-reviewer-run-artifacts"
            aria-label={t("ai_reviewer_review_suggestions")}
          >
            <h4 className="ai-reviewer-run-section-title">
              {t("ai_reviewer_suggestions")}
            </h4>
            {runState.suggestions.map(renderSuggestion)}
          </section>
        )}
        {runState.conflict != null && (
          <div
            className="alert alert-warning ai-reviewer-panel-notice"
            role="alert"
          >
            {t("ai_reviewer_selection_conflict", {
              code: runState.conflict,
            })}
          </div>
        )}
        {runState.error != null && (
          <div
            className="alert alert-danger ai-reviewer-panel-notice"
            role="alert"
          >
            {runState.error}
          </div>
        )}
      </article>
    );
  };

  if (activeDiscussion != null) {
    return (
      <section
        aria-label={t("ai_reviewer_discussion")}
        className="ai-reviewer-panel ai-reviewer-panel-discussion"
      >
        <header className="ai-reviewer-discussion-header">
          <div className="ai-reviewer-discussion-header-actions">
            <OLButton
              type="button"
              variant="link"
              size="sm"
              onClick={() => setActiveDiscussionId(null)}
            >
              {t("ai_reviewer_back_to_review_list")}
            </OLButton>
            <OLButton
              type="button"
              variant="danger-ghost"
              size="sm"
              disabled={
                busy ||
                persistenceSaveFailed ||
                activeDiscussion.status === "streaming"
              }
              onClick={() => deleteDiscussion(activeDiscussion)}
            >
              {t("ai_reviewer_delete_discussion")}
            </OLButton>
          </div>
          <h2
            className="ai-reviewer-discussion-subject"
            data-testid="discussion-subject"
            title={activeDiscussion.subjectLabel}
          >
            {activeDiscussion.subjectLabel}
          </h2>
        </header>
        {workspaceNotice != null && (
          <div
            className="alert alert-warning ai-reviewer-panel-notice"
            role="alert"
          >
            {workspaceNotice}
          </div>
        )}
        <div
          className="ai-reviewer-discussion-turns"
          aria-label={t("ai_reviewer_discussion_turns")}
        >
          {activeDiscussion.turns.map((turn, index) => (
            <article
              key={`${turn.role}:${index}`}
              className="ai-reviewer-discussion-turn"
              aria-label={
                turn.role === "user"
                  ? t("ai_reviewer_your_message")
                  : t("ai_reviewer_ai_response")
              }
            >
              <h3 className="ai-reviewer-discussion-turn-author">
                {turn.role === "user"
                  ? t("ai_reviewer_you")
                  : t("ai_reviewer_title")}
              </h3>
              <ExpandableContent
                className="ai-reviewer-panel-prose"
                content={turn.text}
                contentLimit={320}
                checkNewLines
                translate="no"
              />
            </article>
          ))}
          {hasActiveDiscussionSuggestions && (
            <section
              className="ai-reviewer-run-artifacts"
              aria-label={t("ai_reviewer_discussion_suggestions")}
            >
              <h3 className="ai-reviewer-run-section-title">
                {t("ai_reviewer_suggestions")}
              </h3>
              {activeDiscussion.suggestions.map((suggestion, index) => {
                const commentDraftKey = `discussion:${activeDiscussion.id}:suggestion:${suggestion.id}`;
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
                    <p className="ai-reviewer-panel-quoted-source">
                      {t("ai_reviewer_suggestion_original", {
                        original: suggestion.original,
                      })}
                    </p>
                    <p className="ai-reviewer-panel-quoted-source">
                      {t("ai_reviewer_suggestion_replacement", {
                        replacement: suggestion.replacement,
                      })}
                    </p>
                    <p className="ai-reviewer-panel-prose">
                      {t("ai_reviewer_suggestion_rationale", {
                        rationale: suggestion.rationale,
                      })}
                    </p>
                    <div className="ai-reviewer-panel-actions">
                      {status === "unresolved" &&
                        getSelectionContext != null &&
                        activeDiscussionSourceRequest?.scope.kind !==
                          "project" && (
                          <OLButton
                            type="button"
                            variant="secondary"
                            size="sm"
                            disabled={persistenceConflict}
                            onClick={() =>
                              openDiscussionSuggestionPreview(
                                activeDiscussion,
                                suggestion,
                              )
                            }
                          >
                            {t("ai_reviewer_preview_discussion_diff", {
                              index: index + 1,
                            })}
                          </OLButton>
                        )}
                      {status === "unresolved" &&
                        activeDiscussionSourceRequest != null &&
                        postEditorComment != null &&
                        getSelectionContext != null && (
                          <OLButton
                            type="button"
                            variant="secondary"
                            size="sm"
                            disabled={
                              persistenceConflict ||
                              (commentDraft != null &&
                                commentDraft.key !== commentDraftKey)
                            }
                            onClick={() =>
                              openCommentDraft({
                                key: commentDraftKey,
                                generation:
                                  activeDiscussion.sourceGeneration ?? 0,
                                request: activeDiscussionSourceRequest,
                                artifact: suggestion,
                                discussionId: activeDiscussion.id,
                              })
                            }
                          >
                            {t("ai_reviewer_post_suggestion_as_comment")}
                          </OLButton>
                        )}
                      {(status === "unresolved" || status === "conflict") && (
                        <OLButton
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={
                            persistenceConflict ||
                            commentDraft?.key === commentDraftKey
                          }
                          onClick={() =>
                            discardDiscussionSuggestion(
                              activeDiscussion,
                              suggestion,
                            )
                          }
                        >
                          {t("ai_reviewer_discard_suggestion")}
                        </OLButton>
                      )}
                    </div>
                    {renderCommentDraft(commentDraftKey)}
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
                          ? t("ai_reviewer_suggestion_conflict")
                          : t("ai_reviewer_suggestion_conflict_with_code", {
                              code: activeDiscussion.suggestionConflictCodes[
                                suggestion.id
                              ],
                            })}
                      </p>
                    )}
                  </>
                );
                return isTerminalArtifactStatus(status) ? (
                  <details
                    key={suggestion.id}
                    className="ai-reviewer-artifact ai-reviewer-artifact-resolved"
                  >
                    <summary className="ai-reviewer-artifact-summary">
                      <span
                        className="ai-reviewer-panel-truncate"
                        title={suggestion.rationale}
                      >
                        {suggestion.rationale}
                      </span>
                      <span className="ai-reviewer-artifact-status">
                        {t("ai_reviewer_artifact_status", {
                          status: artifactStatusLabel(status, t),
                        })}
                      </span>
                    </summary>
                    {body}
                  </details>
                ) : (
                  <article key={suggestion.id} className="ai-reviewer-artifact">
                    <p className="ai-reviewer-artifact-status">
                      {t("ai_reviewer_artifact_status", {
                        status: artifactStatusLabel(status, t),
                      })}
                    </p>
                    {body}
                  </article>
                );
              })}
            </section>
          )}
          {activeDiscussion.error != null && (
            <div
              className="alert alert-danger ai-reviewer-panel-notice"
              role="alert"
            >
              {activeDiscussion.error}
            </div>
          )}
        </div>
        <form
          className="ai-reviewer-panel-footer ai-reviewer-discussion-composer"
          onSubmit={(event) => {
            event.preventDefault();
            submitDiscussionMessage();
          }}
        >
          <OLFormLabel htmlFor="ai-reviewer-discussion-input">
            {t("ai_reviewer_discussion_message")}
          </OLFormLabel>
          <div className="ai-reviewer-panel-composer-input">
            <AutoExpandingTextArea
              id="ai-reviewer-discussion-input"
              className="form-control ai-reviewer-panel-textarea"
              value={discussionInput}
              disabled={busy || activeDiscussion.status === "streaming"}
              onChange={(event) => setDiscussionInput(event.target.value)}
            />
            <OLIconButton
              type="submit"
              variant="ghost"
              size="sm"
              icon="send"
              className="ai-reviewer-panel-send"
              accessibilityLabel={t("ai_reviewer_send_message")}
              disabled={
                busy ||
                activeDiscussion.status === "streaming" ||
                discussionInput.trim() === ""
              }
            />
          </div>
          {activeDiscussion.status === "streaming" && (
            <div className="ai-reviewer-panel-actions">
              <OLButton
                type="button"
                variant="ghost"
                size="sm"
                onClick={cancelDiscussionResponse}
              >
                {t("ai_reviewer_cancel_response")}
              </OLButton>
            </div>
          )}
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

  const workspaceIsEmpty =
    workspace.runs.length === 0 && discussions.length === 0;
  const workspaceDeletionDisabled =
    busy ||
    workspaceIsEmpty ||
    discussions.some((discussion) => discussion.status === "streaming");

  return (
    <section
      aria-label={t("ai_reviewer_title")}
      className="ai-reviewer-panel"
      data-testid="ai-reviewer-panel"
    >
      <header className="ai-reviewer-panel-header">
        <h2 className="ai-reviewer-panel-title">{t("ai_reviewer_title")}</h2>
        <Dropdown align="end">
          <OLTooltip
            id="ai-reviewer-more-options"
            description={t("more_options")}
            overlayProps={{ placement: "bottom" }}
          >
            <span>
              <DropdownToggle
                bsPrefix="ai-reviewer-panel-overflow-toggle"
                variant="ghost"
                aria-label={t("more_options")}
              >
                <MaterialIcon type="more_vert" />
              </DropdownToggle>
            </span>
          </OLTooltip>
          <DropdownMenu flip={false} popperConfig={{ strategy: "fixed" }}>
            <OLDropdownMenuItem
              as="button"
              variant="danger"
              disabled={workspaceDeletionDisabled}
              onClick={() => setShowDeleteWorkspaceConfirmation(true)}
            >
              {t("ai_reviewer_delete_all_saved_review_work")}
            </OLDropdownMenuItem>
          </DropdownMenu>
        </Dropdown>
      </header>

      <div
        className="ai-reviewer-panel-body"
        aria-label={t("ai_reviewer_review_list")}
      >
        {workspaceNotice != null && (
          <div
            className="alert alert-warning ai-reviewer-panel-notice"
            role="alert"
          >
            {workspaceNotice}
          </div>
        )}
        {timeline.length === 0 && persistenceReady && (
          <p className="ai-reviewer-panel-empty-state">
            {t("ai_reviewer_empty_state")}
          </p>
        )}
        <div className="ai-reviewer-panel-timeline">
          {timeline.map((entry) =>
            entry.kind === "run" ? (
              renderRun(entry.run)
            ) : (
              <article
                key={`discussion:${entry.discussion.id}`}
                aria-label={t("ai_reviewer_discussion_summary")}
                className="ai-reviewer-discussion-row"
              >
                <OLTooltip
                  id={`ai-reviewer-discussion-${entry.discussion.id}-subject`}
                  description={entry.discussion.subjectLabel}
                  overlayProps={{ placement: "right" }}
                >
                  <span className="ai-reviewer-discussion-row-subject-wrap">
                    <OLButton
                      type="button"
                      variant="link"
                      className="ai-reviewer-discussion-row-subject"
                      onClick={() => setActiveDiscussionId(entry.discussion.id)}
                    >
                      {entry.discussion.subjectLabel}
                    </OLButton>
                  </span>
                </OLTooltip>
                <span className="ai-reviewer-discussion-row-status">
                  {entry.discussion.status === "streaming"
                    ? t("ai_reviewer_discussion_status_responding")
                    : t("ai_reviewer_discussion_status_idle")}
                </span>
                <time
                  className="ai-reviewer-discussion-row-updated"
                  dateTime={entry.discussion.updatedAt}
                  title={entry.discussion.updatedAt}
                >
                  {t("ai_reviewer_last_updated", {
                    updatedAt: entry.discussion.updatedAt,
                  })}
                </time>
                <OLButton
                  type="button"
                  variant="danger-ghost"
                  size="sm"
                  disabled={
                    busy ||
                    persistenceSaveFailed ||
                    entry.discussion.status === "streaming"
                  }
                  onClick={() => deleteDiscussion(entry.discussion)}
                >
                  {t("ai_reviewer_delete_discussion")}
                </OLButton>
              </article>
            ),
          )}
        </div>
      </div>

      {!runInProgress && (
        <div
          className="ai-reviewer-panel-footer"
          data-testid="ai-reviewer-bottom-controls"
        >
          <div className="ai-reviewer-panel-scope">
            <OLFormLabel htmlFor="ai-reviewer-scope">
              {t("ai_reviewer_scope")}
            </OLFormLabel>
            <OLFormSelect
              id="ai-reviewer-scope"
              value={reviewScope}
              disabled={busy}
              onChange={(event) =>
                setReviewScope(event.target.value as ReviewScopeKind)
              }
            >
              {reviewScopes.map((scope) => (
                <option key={scope} value={scope}>
                  {reviewScopeLabel(scope, t)}
                </option>
              ))}
            </OLFormSelect>
          </div>
          <OLButton
            type="button"
            variant="primary"
            className="ai-reviewer-panel-review-action"
            disabled={busy}
            onClick={runSelectedReview}
          >
            {reviewActionLabel(reviewScope, t)}
          </OLButton>
          {reviewScope === "selection" && captureSelectionSession != null && (
            <div
              className="ai-reviewer-panel-auxiliary-actions"
              data-testid="ai-reviewer-selection-transforms"
            >
              {selectionActions
                .filter(({ action }) => action !== "review")
                .map(({ action }) => (
                  <OLButton
                    key={action}
                    type="button"
                    variant="link"
                    className="btn-inline-link ai-reviewer-panel-auxiliary-action"
                    disabled={busy}
                    onClick={() => {
                      void runSelectionReview(action);
                    }}
                  >
                    {selectionActionLabel(action, t)}
                  </OLButton>
                ))}
            </div>
          )}
          <form
            className="ai-reviewer-panel-composer"
            onSubmit={(event) => {
              event.preventDefault();
              submitDiscussionMessage();
            }}
          >
            <OLFormLabel htmlFor="ai-reviewer-discussion-input">
              {t("ai_reviewer_discussion_message")}
            </OLFormLabel>
            <div className="ai-reviewer-panel-composer-input">
              <AutoExpandingTextArea
                id="ai-reviewer-discussion-input"
                className="form-control ai-reviewer-panel-textarea"
                value={discussionInput}
                disabled={
                  busy ||
                  discussions.some(
                    (discussion) => discussion.status === "streaming",
                  )
                }
                onChange={(event) => setDiscussionInput(event.target.value)}
              />
              <OLIconButton
                type="submit"
                variant="ghost"
                size="sm"
                icon="send"
                className="ai-reviewer-panel-send"
                accessibilityLabel={t("ai_reviewer_send_message")}
                disabled={
                  busy ||
                  discussions.some(
                    (discussion) => discussion.status === "streaming",
                  ) ||
                  discussionInput.trim() === ""
                }
              />
            </div>
          </form>
        </div>
      )}

      {showDeleteWorkspaceConfirmation && (
        <GenericConfirmModal
          show
          title={t("ai_reviewer_delete_all_confirmation_title")}
          message={t("ai_reviewer_delete_all_confirmation_message")}
          confirmLabel={t("delete")}
          primaryVariant="danger"
          onHide={() => setShowDeleteWorkspaceConfirmation(false)}
          onConfirm={() => {
            setShowDeleteWorkspaceConfirmation(false);
            deleteWorkspace();
          }}
        />
      )}
    </section>
  );
}

export default function AiReviewerPanel() {
  const { projectId } = useProjectContext();
  const { findEntityByPath, pathInFolder } = useFileTreePathContext();
  const { openDocWithId } = useEditorManagerContext();
  const getSelectionContext = useEditorSelectionSessionContext();
  const resolveEvidenceDocument = useCallback<ResolveEditorEvidenceDocument>(
    (path) => {
      const result = findEntityByPath(path);
      if (result?.type !== "doc") {
        return null;
      }
      const resolvedPath = pathInFolder(result.entity._id);
      if (resolvedPath !== path) {
        return null;
      }
      return Object.freeze({
        documentId: result.entity._id,
        path: resolvedPath,
      });
    },
    [findEntityByPath, pathInFolder],
  );
  const openEvidenceDocument = useCallback<OpenEditorEvidenceDocument>(
    (documentId) =>
      openDocWithId(documentId, {
        keepCurrentView: true,
      }),
    [openDocWithId],
  );
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
      resolveEvidenceDocument={resolveEvidenceDocument}
      openEvidenceDocument={openEvidenceDocument}
      postEditorComment={postAiReviewerComment}
      workspacePersistence={aiReviewerWorkspacePersistence}
    />
  );
}
