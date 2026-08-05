import { FetchError, getJSON, putJSON } from "@/infrastructure/fetch-json";

import { AiReviewerModeInstructionsSnapshotSchema } from "../../../shared/contracts.mjs";
import type {
  AiReviewerModeInstructions,
  AiReviewerModeInstructionsSnapshot,
} from "../../../shared/contract-types";

const genericMessage = "The review perspectives could not be saved.";

export class AiReviewerModeInstructionPersistenceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "AiReviewerModeInstructionPersistenceError";
  }
}

function modeInstructionsPath(projectId: string) {
  return `/project/${encodeURIComponent(projectId)}/ai-reviewer/mode-instructions`;
}

function parseResponse(response: unknown) {
  const parsed = AiReviewerModeInstructionsSnapshotSchema.safeParse(response);
  if (!parsed.success) {
    throw new AiReviewerModeInstructionPersistenceError(
      genericMessage,
      "AI_REVIEWER_MODE_INSTRUCTIONS_INVALID",
    );
  }
  return parsed.data;
}

function persistenceError(error: unknown, signal: AbortSignal) {
  if (signal.aborted) {
    return new DOMException("The request was cancelled.", "AbortError");
  }
  if (error instanceof AiReviewerModeInstructionPersistenceError) {
    return error;
  }
  const code =
    error instanceof FetchError && typeof error.data?.error?.code === "string"
      ? error.data.error.code
      : "AI_REVIEWER_MODE_INSTRUCTIONS_FAILED";
  return new AiReviewerModeInstructionPersistenceError(genericMessage, code);
}

async function request<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw persistenceError(error, signal);
  }
}

export function loadAiReviewerModeInstructions(
  projectId: string,
  signal: AbortSignal,
) {
  return request(signal, async () =>
    parseResponse(
      await getJSON<AiReviewerModeInstructionsSnapshot>(
        modeInstructionsPath(projectId),
        { signal, swallowAbortError: false },
      ),
    ),
  );
}

export function saveAiReviewerModeInstructions(
  projectId: string,
  instructions: AiReviewerModeInstructions,
  revision: number,
  signal: AbortSignal,
) {
  return request(signal, async () =>
    parseResponse(
      await putJSON<AiReviewerModeInstructionsSnapshot>(
        modeInstructionsPath(projectId),
        {
          body: { revision, instructions },
          signal,
          swallowAbortError: false,
        },
      ),
    ),
  );
}

export type AiReviewerModeInstructionPersistence = {
  load: typeof loadAiReviewerModeInstructions;
  save: typeof saveAiReviewerModeInstructions;
};

export const aiReviewerModeInstructionPersistence: AiReviewerModeInstructionPersistence =
  {
    load: loadAiReviewerModeInstructions,
    save: saveAiReviewerModeInstructions,
  };
