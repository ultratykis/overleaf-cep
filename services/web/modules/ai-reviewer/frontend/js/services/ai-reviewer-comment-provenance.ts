import { deleteJSON, getJSON, putJSON } from "@/infrastructure/fetch-json";
import { useCallback, useSyncExternalStore } from "react";

const mongoIdentifierPattern = /^[0-9a-f]{24}$/;

type ProjectProvenanceEntry = {
  commentIds: Set<string>;
  listeners: Set<() => void>;
};

const projectProvenance = new Map<string, ProjectProvenanceEntry>();

function assertIdentifier(value: string, name: string) {
  if (!mongoIdentifierPattern.test(value)) {
    throw new TypeError(
      `${name} must be a lowercase 24-character hex identifier`,
    );
  }
}

function entryForProject(projectId: string) {
  let entry = projectProvenance.get(projectId);
  if (entry == null) {
    entry = {
      commentIds: new Set(),
      listeners: new Set(),
    };
    projectProvenance.set(projectId, entry);
  }
  return entry;
}

function notify(entry: ProjectProvenanceEntry) {
  for (const listener of entry.listeners) {
    listener();
  }
}

function provenancePath(projectId: string) {
  assertIdentifier(projectId, "projectId");
  return `/project/${projectId}/ai-reviewer/comment-provenance`;
}

function commentProvenancePath(projectId: string, commentId: string) {
  assertIdentifier(commentId, "commentId");
  return `${provenancePath(projectId)}/${commentId}`;
}

function parseCommentIds(value: unknown) {
  if (
    typeof value !== "object" ||
    value == null ||
    !("commentIds" in value) ||
    !Array.isArray(value.commentIds)
  ) {
    throw new TypeError("Invalid AI reviewer comment provenance response");
  }

  const commentIds = value.commentIds;
  for (const commentId of commentIds) {
    if (typeof commentId !== "string") {
      throw new TypeError("Invalid AI reviewer comment provenance response");
    }
    assertIdentifier(commentId, "commentId");
  }
  return commentIds;
}

export async function loadAiReviewerCommentProvenance(
  projectId: string,
  signal?: AbortSignal,
) {
  const response = await getJSON<unknown>(provenancePath(projectId), {
    signal,
    swallowAbortError: false,
  });
  return parseCommentIds(response);
}

export async function reserveAiReviewerCommentProvenance(
  projectId: string,
  commentId: string,
  signal?: AbortSignal,
) {
  const response = await putJSON<unknown>(
    commentProvenancePath(projectId, commentId),
    {
      signal,
      swallowAbortError: false,
    },
  );
  if (
    typeof response !== "object" ||
    response == null ||
    !("commentId" in response) ||
    response.commentId !== commentId ||
    !("created" in response) ||
    typeof response.created !== "boolean"
  ) {
    throw new TypeError("Invalid AI reviewer comment provenance response");
  }
  return {
    commentId,
    created: response.created,
  };
}

export async function releaseAiReviewerCommentProvenance(
  projectId: string,
  commentId: string,
  signal?: AbortSignal,
) {
  await deleteJSON(commentProvenancePath(projectId, commentId), {
    signal,
    swallowAbortError: false,
  });
}

export function mergeAiReviewerCommentProvenance(
  projectId: string,
  commentIds: readonly string[],
) {
  assertIdentifier(projectId, "projectId");
  const entry = entryForProject(projectId);
  let changed = false;
  for (const commentId of commentIds) {
    assertIdentifier(commentId, "commentId");
    if (!entry.commentIds.has(commentId)) {
      entry.commentIds.add(commentId);
      changed = true;
    }
  }
  if (changed) {
    notify(entry);
  }
}

export function recordAiReviewerCommentProvenance(
  projectId: string,
  commentId: string,
) {
  mergeAiReviewerCommentProvenance(projectId, [commentId]);
}

export function hasAiReviewerCommentProvenance(
  projectId: string,
  commentId: string,
) {
  return projectProvenance.get(projectId)?.commentIds.has(commentId) === true;
}

export function useAiReviewerCommentProvenance(
  projectId: string,
  commentId: string,
) {
  const subscribe = useCallback(
    (listener: () => void) => {
      const entry = entryForProject(projectId);
      entry.listeners.add(listener);
      return () => {
        entry.listeners.delete(listener);
      };
    },
    [projectId],
  );
  const getSnapshot = useCallback(
    () => hasAiReviewerCommentProvenance(projectId, commentId),
    [commentId, projectId],
  );

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

export function snapshotAiReviewerCommentProvenance(projectId: string) {
  return [...(projectProvenance.get(projectId)?.commentIds ?? [])].sort();
}

export function resetAiReviewerCommentProvenanceForTests() {
  projectProvenance.clear();
}
