import {
  deleteJSON,
  FetchError,
  getJSON,
  postJSON,
} from "@/infrastructure/fetch-json";

export type AiReviewerSkill = {
  id: string;
  name: string;
  description: string;
};

export type AiReviewerSkillList = {
  skills: AiReviewerSkill[];
};

export type AiReviewerSkillUpload = {
  skillMarkdown: string;
  referenceFiles: Record<string, string>;
};

export class AiReviewerSkillClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiReviewerSkillClientError";
  }
}

function toClientError(error: unknown) {
  const message =
    error instanceof FetchError &&
    typeof error.data?.error?.message === "string" &&
    error.data.error.message.length > 0
      ? error.data.error.message
      : "The AI reviewer skill request failed.";
  return new AiReviewerSkillClientError(message);
}

async function request<T>(
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (signal.aborted) {
      throw new DOMException("The request was cancelled.", "AbortError");
    }
    throw toClientError(error);
  }
}

function skillsPath(projectId: string) {
  return `/project/${projectId}/ai-reviewer/skills`;
}

export function getAiReviewerSkills(projectId: string, signal: AbortSignal) {
  return request(signal, () =>
    getJSON<AiReviewerSkillList>(skillsPath(projectId), {
      signal,
      swallowAbortError: false,
    }),
  );
}

export function uploadAiReviewerSkill(
  projectId: string,
  upload: AiReviewerSkillUpload,
  signal: AbortSignal,
) {
  return request(signal, () =>
    postJSON<AiReviewerSkill>(skillsPath(projectId), {
      body: {
        skillMarkdown: upload.skillMarkdown,
        referenceFiles: upload.referenceFiles,
      },
      signal,
      swallowAbortError: false,
    }),
  );
}

export function deleteAiReviewerSkill(
  projectId: string,
  skillId: string,
  signal: AbortSignal,
) {
  return request(signal, () =>
    deleteJSON<AiReviewerSkillList>(`${skillsPath(projectId)}/${skillId}`, {
      signal,
      swallowAbortError: false,
    }),
  );
}
