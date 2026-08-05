import {
  deleteJSON,
  FetchError,
  getJSON,
  putJSON,
} from "@/infrastructure/fetch-json";

import { AiReviewerWorkspaceSnapshotSchema } from "../../../shared/contracts.mjs";
import type {
  AiReviewerWorkspace,
  AiReviewerWorkspaceSnapshot,
} from "../../../shared/contract-types";

const genericPersistenceMessage =
  "The AI reviewer workspace could not be saved. Try again.";
export const workspaceLimitMessage =
  "Delete a discussion before adding more saved discussion content.";
export const workspaceChangedMessage =
  "The saved review workspace changed in another session. Reload before continuing.";

export class AiReviewerWorkspacePersistenceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "AiReviewerWorkspacePersistenceError";
  }
}

function workspacePath(projectId: string) {
  return `/project/${encodeURIComponent(projectId)}/ai-reviewer/workspace`;
}

function parseWorkspaceResponse(response: unknown) {
  const parsed = AiReviewerWorkspaceSnapshotSchema.safeParse(response);
  if (!parsed.success) {
    throw new AiReviewerWorkspacePersistenceError(
      genericPersistenceMessage,
      "AI_REVIEWER_WORKSPACE_INVALID",
    );
  }
  return parsed.data;
}

function toPersistenceError(error: unknown, signal: AbortSignal) {
  if (signal.aborted) {
    return new DOMException("The request was cancelled.", "AbortError");
  }
  if (error instanceof AiReviewerWorkspacePersistenceError) {
    return error;
  }
  const code =
    error instanceof FetchError && typeof error.data?.error?.code === "string"
      ? error.data.error.code
      : "AI_REVIEWER_WORKSPACE_FAILED";
  const limitReached =
    code === "AI_REVIEWER_WORKSPACE_LIMIT_REACHED" ||
    code === "AI_WORKSPACE_LIMIT_REACHED";
  const workspaceChanged = code === "AI_REVIEWER_WORKSPACE_CHANGED";
  return new AiReviewerWorkspacePersistenceError(
    limitReached
      ? workspaceLimitMessage
      : workspaceChanged
        ? workspaceChangedMessage
        : genericPersistenceMessage,
    code,
  );
}

async function request<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toPersistenceError(error, signal);
  }
}

export function loadAiReviewerWorkspace(
  projectId: string,
  signal: AbortSignal,
) {
  return request(signal, async () =>
    parseWorkspaceResponse(
      await getJSON<AiReviewerWorkspaceSnapshot>(workspacePath(projectId), {
        signal,
        swallowAbortError: false,
      }),
    ),
  );
}

export function saveAiReviewerWorkspace(
  projectId: string,
  workspace: AiReviewerWorkspace,
  revision: number,
  signal: AbortSignal,
) {
  return request(signal, async () =>
    parseWorkspaceResponse(
      await putJSON<AiReviewerWorkspaceSnapshot>(workspacePath(projectId), {
        body: {
          revision,
          workspace,
        },
        signal,
        swallowAbortError: false,
      }),
    ),
  );
}

export function deleteAiReviewerDiscussion(
  projectId: string,
  discussionId: string,
  signal: AbortSignal,
) {
  return request(signal, async () =>
    parseWorkspaceResponse(
      await deleteJSON<AiReviewerWorkspaceSnapshot>(
        `${workspacePath(projectId)}/discussions/${encodeURIComponent(
          discussionId,
        )}`,
        {
          signal,
          swallowAbortError: false,
        },
      ),
    ),
  );
}

export function deleteAiReviewerWorkspace(
  projectId: string,
  signal: AbortSignal,
) {
  return request(signal, async () =>
    parseWorkspaceResponse(
      await deleteJSON<AiReviewerWorkspaceSnapshot>(workspacePath(projectId), {
        signal,
        swallowAbortError: false,
      }),
    ),
  );
}

export type AiReviewerWorkspacePersistence = {
  load: typeof loadAiReviewerWorkspace;
  save: typeof saveAiReviewerWorkspace;
  deleteDiscussion: typeof deleteAiReviewerDiscussion;
  deleteAll: typeof deleteAiReviewerWorkspace;
};

export const aiReviewerWorkspacePersistence: AiReviewerWorkspacePersistence = {
  load: loadAiReviewerWorkspace,
  save: saveAiReviewerWorkspace,
  deleteDiscussion: deleteAiReviewerDiscussion,
  deleteAll: deleteAiReviewerWorkspace,
};
