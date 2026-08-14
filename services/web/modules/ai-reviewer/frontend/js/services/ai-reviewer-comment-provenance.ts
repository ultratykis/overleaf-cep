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

function assertBoundedIdentifier(value: string, name: string) {
  if (value.length === 0 || value.length > 200) {
    throw new TypeError(`${name} must contain between 1 and 200 characters`);
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

function keyedProvenancePath(
  projectId: string,
  runId: string,
  artifactId: string,
) {
  assertBoundedIdentifier(runId, "runId");
  assertBoundedIdentifier(artifactId, "artifactId");
  const query = new URLSearchParams({ runId, artifactId });
  return `${provenancePath(projectId)}?${query}`;
}

function parseReservation(value: unknown) {
  if (
    typeof value !== "object" ||
    value == null ||
    !("commentId" in value) ||
    typeof value.commentId !== "string" ||
    !("confirmed" in value) ||
    typeof value.confirmed !== "boolean"
  ) {
    throw new TypeError("Invalid AI reviewer comment provenance response");
  }
  assertIdentifier(value.commentId, "commentId");
  return {
    commentId: value.commentId,
    confirmed: value.confirmed,
  };
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
  runId: string,
  artifactId: string,
  signal?: AbortSignal,
) {
  assertBoundedIdentifier(runId, "runId");
  assertBoundedIdentifier(artifactId, "artifactId");
  const response = await putJSON<unknown>(
    `${commentProvenancePath(projectId, commentId)}?${new URLSearchParams({
      runId,
      artifactId,
    })}`,
    {
      signal,
      swallowAbortError: false,
    },
  );
  if (
    typeof response !== "object" ||
    response == null ||
    !("commentId" in response) ||
    typeof response.commentId !== "string" ||
    !("created" in response) ||
    typeof response.created !== "boolean" ||
    !("confirmed" in response) ||
    typeof response.confirmed !== "boolean"
  ) {
    throw new TypeError("Invalid AI reviewer comment provenance response");
  }
  assertIdentifier(response.commentId, "commentId");
  return {
    commentId: response.commentId,
    created: response.created,
    confirmed: response.confirmed,
  };
}

export async function lookupAiReviewerCommentProvenance(
  projectId: string,
  runId: string,
  artifactId: string,
  signal?: AbortSignal,
) {
  const response = await getJSON<unknown>(
    keyedProvenancePath(projectId, runId, artifactId),
    {
      signal,
      swallowAbortError: false,
    },
  );
  if (
    typeof response !== "object" ||
    response == null ||
    !("reservation" in response)
  ) {
    throw new TypeError("Invalid AI reviewer comment provenance response");
  }
  return response.reservation == null
    ? null
    : parseReservation(response.reservation);
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
