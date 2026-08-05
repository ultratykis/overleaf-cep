import type { TFunction } from "i18next";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import OLButton from "@/shared/components/ol/ol-button";

import type { UnresolvedSuggestion } from "../../../shared/contract-types";
import type {
  EditorSelectionSession,
  EditorSelectionSessionContext,
} from "../services/editor-selection-session";
import { applySelectedEditorSelectionSuggestion } from "../services/editor-suggestion-host-application";
import type { SelectedEditorSuggestionApplicationResult } from "../services/editor-suggestion-application";
import {
  DetachedSuggestionDiffError,
  mountDetachedSuggestionDiff,
  type MountedDetachedSuggestionDiff,
} from "../services/detached-suggestion-diff";
import type { SelectionSuggestionDecision } from "../services/selection-workspace-state";

export type MountSuggestionPreview = typeof mountDetachedSuggestionDiff;
export type ApplySelectionSuggestion = (
  options: Parameters<typeof applySelectedEditorSelectionSuggestion>[0],
) => Promise<SelectedEditorSuggestionApplicationResult>;
export type SuggestionPreviewDisposer = (reason: unknown) => void;
export type RegisterSuggestionPreviewLease = (
  dispose: SuggestionPreviewDisposer,
) => () => void;

type PreviewStatus =
  | "mounting"
  | "ready"
  | "applying"
  | "applied"
  | "discarded"
  | "conflict"
  | "cancelled"
  | "error";

type PreviewLease = {
  disposed: boolean;
  terminal: boolean;
  actionLocked: boolean;
  decisionSent: boolean;
  handle: MountedDetachedSuggestionDiff | null;
  hunkIds: readonly string[] | null;
  pendingSelection: unknown;
  selectedHunkIds: readonly string[];
  applicationController: AbortController | null;
};

function statusLabel(t: TFunction<"translation">, status: PreviewStatus) {
  switch (status) {
    case "mounting":
      return t("ai_reviewer_suggestion_status_preparing_preview");
    case "ready":
      return t("ai_reviewer_suggestion_status_preview_ready");
    case "applying":
      return t("ai_reviewer_suggestion_status_applying_selected_changes");
    case "applied":
      return t("ai_reviewer_suggestion_status_selected_changes_applied");
    case "discarded":
      return t("ai_reviewer_suggestion_status_discarded");
    case "conflict":
      return t("ai_reviewer_suggestion_status_conflict");
    case "cancelled":
      return t("ai_reviewer_suggestion_status_application_cancelled");
    case "error":
      return t("ai_reviewer_suggestion_status_preview_error");
  }
}

function cancellationReason(message: string) {
  return new DOMException(message, "AbortError");
}

function safeDestroy(handle: MountedDetachedSuggestionDiff | null) {
  if (handle == null) {
    return;
  }
  try {
    handle.destroy();
  } catch {
    // Cleanup failures must not revive or retain an invalid suggestion lease.
  }
}

function parseHunkIds(value: unknown, allowed?: ReadonlySet<string>) {
  if (!Array.isArray(value)) {
    return null;
  }

  const parsed: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (
      typeof candidate !== "string" ||
      candidate.length === 0 ||
      candidate.length > 512 ||
      seen.has(candidate) ||
      (allowed != null && !allowed.has(candidate))
    ) {
      return null;
    }
    seen.add(candidate);
    parsed.push(candidate);
  }
  return parsed;
}

function normalizeSelection(
  value: unknown,
  hunkIds: readonly string[],
): readonly string[] | null {
  const allowed = new Set(hunkIds);
  const parsed = parseHunkIds(value, allowed);
  if (parsed == null) {
    return null;
  }
  const selected = new Set(parsed);
  return Object.freeze(hunkIds.filter((hunkId) => selected.has(hunkId)));
}

function decisionStatus(decision: SelectionSuggestionDecision): PreviewStatus {
  return decision.status;
}

function decisionMessage(
  t: TFunction<"translation">,
  decision: SelectionSuggestionDecision,
) {
  if (decision.status === "conflict") {
    if (decision.code === "AI_EDITOR_SECURE_CONTEXT_REQUIRED") {
      return t("ai_reviewer_secure_context_required");
    }
    return t("ai_reviewer_suggestion_could_not_be_applied", {
      code: decision.code,
    });
  }
  if (decision.status === "applied") {
    return t("ai_reviewer_selected_changes_applied_through_editor");
  }
  if (decision.status === "discarded") {
    return t("ai_reviewer_suggestion_discarded_without_changes");
  }
  if (decision.status === "cancelled") {
    return t("ai_reviewer_suggestion_application_was_cancelled");
  }
  return t("ai_reviewer_suggestion_preview_could_not_be_completed");
}

function previewMountErrorMessage(
  error: unknown,
  t: TFunction<"translation">,
) {
  return error instanceof DetachedSuggestionDiffError &&
    error.code === "AI_DIFF_CRYPTO_UNAVAILABLE"
    ? t("ai_reviewer_secure_context_required")
    : t("ai_reviewer_suggestion_preview_mount_failed");
}

export function AiReviewerSuggestionPreview({
  session,
  suggestion,
  getContext,
  mountPreview = mountDetachedSuggestionDiff,
  applySuggestion = applySelectedEditorSelectionSuggestion,
  registerLease,
  onDecision,
  onErrorNotice,
}: {
  session: EditorSelectionSession;
  suggestion: UnresolvedSuggestion;
  getContext: () => EditorSelectionSessionContext;
  mountPreview?: MountSuggestionPreview;
  applySuggestion?: ApplySelectionSuggestion;
  registerLease?: RegisterSuggestionPreviewLease;
  onDecision?: (decision: SelectionSuggestionDecision) => void;
  onErrorNotice?: (message: string) => void;
}) {
  const { t } = useTranslation();
  const previewParent = useRef<HTMLDivElement | null>(null);
  const lease = useRef<PreviewLease | null>(null);
  const onDecisionRef = useRef(onDecision);
  const [status, setStatus] = useState<PreviewStatus>("mounting");
  const [selectedHunkIds, setSelectedHunkIds] = useState<readonly string[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    onDecisionRef.current = onDecision;
  }, [onDecision]);

  const disposeLease = useCallback(
    (candidate: PreviewLease, reason: unknown) => {
      if (candidate.disposed) {
        return;
      }
      candidate.disposed = true;
      candidate.actionLocked = true;
      const controller = candidate.applicationController;
      candidate.applicationController = null;
      if (controller != null && !controller.signal.aborted) {
        controller.abort(reason);
      }
      const handle = candidate.handle;
      candidate.handle = null;
      safeDestroy(handle);
    },
    [],
  );

  const finish = useCallback(
    (
      candidate: PreviewLease,
      decision: SelectionSuggestionDecision,
      nextMessage = decisionMessage(t, decision),
    ) => {
      if (
        candidate.disposed ||
        candidate.terminal ||
        candidate.decisionSent ||
        lease.current !== candidate
      ) {
        return;
      }
      candidate.terminal = true;
      candidate.actionLocked = true;
      candidate.decisionSent = true;
      candidate.applicationController = null;
      const handle = candidate.handle;
      candidate.handle = null;
      safeDestroy(handle);
      setStatus(decisionStatus(decision));
      setMessage(nextMessage);
      if (decision.status === "error") {
        onErrorNotice?.(nextMessage);
      }
      onDecisionRef.current?.(decision);
    },
    [onErrorNotice, t],
  );

  useEffect(() => {
    const parent = previewParent.current;
    if (parent == null) {
      return;
    }

    const candidate: PreviewLease = {
      disposed: false,
      terminal: false,
      actionLocked: false,
      decisionSent: false,
      handle: null,
      hunkIds: null,
      pendingSelection: Object.freeze([]),
      selectedHunkIds: Object.freeze([]),
      applicationController: null,
    };
    lease.current = candidate;
    setStatus("mounting");
    setSelectedHunkIds([]);
    setMessage(null);

    const dispose: SuggestionPreviewDisposer = (reason) => {
      disposeLease(candidate, reason);
    };
    let unregister = () => {};
    try {
      unregister = registerLease?.(dispose) ?? unregister;
    } catch {
      finish(
        candidate,
        {
          status: "error",
        },
        t("ai_reviewer_suggestion_preview_lifecycle_registration_failed"),
      );
    }

    const reportInvalidSelection = () => {
      finish(
        candidate,
        {
          status: "error",
        },
        t("ai_reviewer_suggestion_preview_invalid_hunk_selection"),
      );
    };

    const onSelectionChange = (value: readonly string[]) => {
      if (candidate.disposed || candidate.terminal || candidate.actionLocked) {
        return;
      }
      const parsed = parseHunkIds(value);
      if (parsed == null) {
        reportInvalidSelection();
        return;
      }
      candidate.pendingSelection = Object.freeze(parsed);
      if (candidate.hunkIds == null) {
        return;
      }
      const normalized = normalizeSelection(
        candidate.pendingSelection,
        candidate.hunkIds,
      );
      if (normalized == null) {
        reportInvalidSelection();
        return;
      }
      candidate.selectedHunkIds = normalized;
      setSelectedHunkIds(normalized);
      setMessage(null);
    };

    if (candidate.disposed || candidate.terminal) {
      return () => {
        unregister();
        if (lease.current === candidate) {
          lease.current = null;
        }
        disposeLease(
          candidate,
          cancellationReason("The suggestion preview was closed."),
        );
      };
    }

    let mounting: Promise<MountedDetachedSuggestionDiff>;
    try {
      mounting = Promise.resolve(
        mountPreview({
          parent,
          request: session.request,
          suggestion,
          onSelectionChange,
          t,
        }),
      );
    } catch (error) {
      finish(
        candidate,
        {
          status: "error",
        },
        previewMountErrorMessage(error, t),
      );
      mounting = Promise.reject(
        new Error("The detached suggestion preview could not be mounted."),
      );
      void mounting.catch(() => {});
    }

    void mounting.then(
      (handle) => {
        if (
          candidate.disposed ||
          candidate.terminal ||
          lease.current !== candidate
        ) {
          safeDestroy(handle);
          return;
        }
        try {
          candidate.handle = handle;
          const hunkIds = parseHunkIds(handle.hunkIds);
          if (hunkIds == null) {
            reportInvalidSelection();
            return;
          }
          candidate.hunkIds = Object.freeze(hunkIds);
          const normalized = normalizeSelection(
            candidate.pendingSelection,
            candidate.hunkIds,
          );
          if (normalized == null) {
            reportInvalidSelection();
            return;
          }
          candidate.selectedHunkIds = normalized;
          setSelectedHunkIds(normalized);
          setStatus("ready");
        } catch {
          finish(
            candidate,
            {
              status: "error",
            },
            t("ai_reviewer_suggestion_preview_invalid_plan"),
          );
        }
      },
      (error) => {
        finish(
          candidate,
          {
            status: "error",
          },
          previewMountErrorMessage(error, t),
        );
      },
    );

    return () => {
      unregister();
      if (lease.current === candidate) {
        lease.current = null;
      }
      disposeLease(
        candidate,
        cancellationReason("The suggestion preview was closed."),
      );
    };
  }, [
    disposeLease,
    finish,
    mountPreview,
    registerLease,
    session,
    suggestion,
    t,
  ]);

  const applySelected = useCallback(() => {
    const candidate = lease.current;
    if (
      candidate == null ||
      candidate.disposed ||
      candidate.terminal ||
      candidate.actionLocked ||
      candidate.hunkIds == null ||
      candidate.selectedHunkIds.length === 0
    ) {
      return;
    }

    candidate.actionLocked = true;
    const selectedSnapshot = Object.freeze([...candidate.selectedHunkIds]);
    const controller = new AbortController();
    candidate.applicationController = controller;
    setStatus("applying");
    setMessage(null);

    let application: Promise<SelectedEditorSuggestionApplicationResult>;
    try {
      application = Promise.resolve(
        applySuggestion({
          session,
          suggestion,
          selectedHunkIds: selectedSnapshot,
          getContext,
          signal: controller.signal,
        }),
      );
    } catch {
      finish(candidate, {
        status: "error",
      });
      return;
    }

    void application
      .then((result) => {
        if (
          candidate.disposed ||
          candidate.terminal ||
          lease.current !== candidate ||
          candidate.applicationController !== controller
        ) {
          return;
        }
        candidate.applicationController = null;
        if (result.status === "empty") {
          finish(
            candidate,
            {
              status: "error",
            },
            t("ai_reviewer_suggestion_no_applicable_change"),
          );
          return;
        }
        if (result.status === "conflict") {
          finish(candidate, {
            status: "conflict",
            code: result.code,
          });
          return;
        }
        if (result.status === "applied" || result.status === "cancelled") {
          finish(candidate, {
            status: result.status,
          });
          return;
        }
        finish(candidate, {
          status: "error",
        });
      })
      .catch(() => {
        if (
          candidate.disposed ||
          candidate.terminal ||
          lease.current !== candidate ||
          candidate.applicationController !== controller
        ) {
          return;
        }
        candidate.applicationController = null;
        finish(candidate, {
          status: "error",
        });
      });
  }, [applySuggestion, finish, getContext, session, suggestion, t]);

  const discard = useCallback(() => {
    const candidate = lease.current;
    if (
      candidate == null ||
      candidate.disposed ||
      candidate.terminal ||
      candidate.actionLocked
    ) {
      return;
    }
    candidate.actionLocked = true;
    finish(candidate, {
      status: "discarded",
    });
  }, [finish]);

  const cancelApplication = useCallback(() => {
    const candidate = lease.current;
    if (
      candidate == null ||
      candidate.disposed ||
      candidate.terminal ||
      candidate.applicationController == null
    ) {
      return;
    }
    const controller = candidate.applicationController;
    candidate.applicationController = null;
    if (!controller.signal.aborted) {
      controller.abort(
        cancellationReason("The suggestion application was cancelled."),
      );
    }
    finish(candidate, {
      status: "cancelled",
    });
  }, [finish]);

  const terminal =
    status === "applied" ||
    status === "discarded" ||
    status === "conflict" ||
    status === "cancelled" ||
    status === "error";

  return (
    <section
      aria-label={t("ai_reviewer_suggestion_preview")}
      className="ai-reviewer-suggestion-preview"
    >
      <p aria-live="polite">{statusLabel(t, status)}</p>
      <fieldset disabled={status !== "ready"}>
        <legend className="visually-hidden">
          {t("ai_reviewer_detached_suggestion_diff")}
        </legend>
        <div
          ref={previewParent}
          className="ai-reviewer-suggestion-preview-diff"
        />
      </fieldset>
      <div className="ai-reviewer-panel-actions">
        <OLButton
          type="button"
          variant="secondary"
          size="sm"
          disabled={status !== "ready" || selectedHunkIds.length === 0}
          onClick={applySelected}
        >
          {t("ai_reviewer_apply_selected_changes")}
        </OLButton>
        <OLButton
          type="button"
          variant="ghost"
          size="sm"
          disabled={status === "applying" || terminal}
          onClick={discard}
        >
          {t("ai_reviewer_discard_suggestion")}
        </OLButton>
        {status === "applying" && (
          <OLButton
            type="button"
            variant="ghost"
            size="sm"
            onClick={cancelApplication}
          >
            {t("ai_reviewer_cancel_application")}
          </OLButton>
        )}
      </div>
      {message != null && (
        <div
          className={
            status === "conflict"
              ? "alert alert-warning ai-reviewer-panel-notice"
              : status === "error"
                ? "alert alert-danger ai-reviewer-panel-notice"
                : "alert alert-info ai-reviewer-panel-notice"
          }
          role="status"
        >
          {message}
        </div>
      )}
    </section>
  );
}
