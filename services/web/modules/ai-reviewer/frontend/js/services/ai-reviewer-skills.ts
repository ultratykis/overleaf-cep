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
  sizeBytes: number;
  referenceCount: number;
  provenance?: AiReviewerSkillGitProvenance;
};

export type AiReviewerSkillList = {
  skills: AiReviewerSkill[];
};

export type AiReviewerSkillUpload = {
  skillMarkdown: string;
  referenceFiles: Record<string, string>;
};

export type AiReviewerSkillGitHostType = "auto" | "github" | "gitlab";

export type AiReviewerSkillGitSource = {
  repository: string;
  gitHostType: AiReviewerSkillGitHostType;
  ref: string;
};

export type AiReviewerSkillGitOwner = {
  name: string;
  url?: string;
};

export type AiReviewerSkillGitProvenance = {
  kind: "git";
  service: "github" | "gitlab";
  host: string;
  repository: string;
  path: string;
  resolvedSha: string;
  pluginName?: string;
  pluginVersion?: string;
  license?: string;
  owner?: AiReviewerSkillGitOwner;
  homepage?: string;
};

export type AiReviewerSkillGitSkippedReferenceReason =
  | "outside-skill-directory"
  | "not-reference-file"
  | "not-readable"
  | "size-limit";

export type AiReviewerSkillGitPreview = {
  source: {
    service: "github" | "gitlab";
    host: string;
    repository: string;
    requestedRevision: string | null;
    resolvedSha: string;
  };
  manifestFound: boolean;
  plugins: Array<{
    name: string;
    version: string | null;
    license: string | null;
    owner: AiReviewerSkillGitOwner | null;
    homepage: string | null;
  }>;
  skills: Array<{
    path: string;
    name: string;
    description: string;
    bodySizeBytes: number;
    totalSizeBytes: number;
    referenceFiles: Array<{ path: string; sizeBytes: number }>;
    skippedReferences: Array<{
      path: string;
      reason: AiReviewerSkillGitSkippedReferenceReason;
    }>;
    pluginName?: string;
  }>;
  contentHash: string;
};

export type AiReviewerSkillGitConfirmation = AiReviewerSkillGitSource & {
  resolvedSha: string;
  contentHash: string;
  selectedPaths: string[];
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

const userSkillsPath = "/user/ai-reviewer/skills";

function previewPath(basePath: string) {
  return `${basePath}/import/preview`;
}

function importPath(basePath: string) {
  return `${basePath}/import`;
}

function previewGitImport(
  basePath: string,
  source: AiReviewerSkillGitSource,
  signal: AbortSignal,
) {
  return request(signal, () =>
    postJSON<AiReviewerSkillGitPreview>(previewPath(basePath), {
      body: source,
      signal,
      swallowAbortError: false,
    }),
  );
}

function confirmGitImport(
  basePath: string,
  confirmation: AiReviewerSkillGitConfirmation,
  signal: AbortSignal,
) {
  return request(signal, () =>
    postJSON<AiReviewerSkillList>(importPath(basePath), {
      body: confirmation,
      signal,
      swallowAbortError: false,
    }),
  );
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

export function previewAiReviewerSkillGitImport(
  projectId: string,
  source: AiReviewerSkillGitSource,
  signal: AbortSignal,
) {
  return previewGitImport(skillsPath(projectId), source, signal);
}

export function confirmAiReviewerSkillGitImport(
  projectId: string,
  confirmation: AiReviewerSkillGitConfirmation,
  signal: AbortSignal,
) {
  return confirmGitImport(skillsPath(projectId), confirmation, signal);
}

export function getUserAiReviewerSkills(
  _scopeKey: string,
  signal: AbortSignal,
) {
  return request(signal, () =>
    getJSON<AiReviewerSkillList>(userSkillsPath, {
      signal,
      swallowAbortError: false,
    }),
  );
}

export function uploadUserAiReviewerSkill(
  _scopeKey: string,
  upload: AiReviewerSkillUpload,
  signal: AbortSignal,
) {
  return request(signal, () =>
    postJSON<AiReviewerSkill>(userSkillsPath, {
      body: {
        skillMarkdown: upload.skillMarkdown,
        referenceFiles: upload.referenceFiles,
      },
      signal,
      swallowAbortError: false,
    }),
  );
}

export function deleteUserAiReviewerSkill(
  _scopeKey: string,
  skillId: string,
  signal: AbortSignal,
) {
  return request(signal, () =>
    deleteJSON<AiReviewerSkillList>(`${userSkillsPath}/${skillId}`, {
      signal,
      swallowAbortError: false,
    }),
  );
}

export function previewUserAiReviewerSkillGitImport(
  _scopeKey: string,
  source: AiReviewerSkillGitSource,
  signal: AbortSignal,
) {
  return previewGitImport(userSkillsPath, source, signal);
}

export function confirmUserAiReviewerSkillGitImport(
  _scopeKey: string,
  confirmation: AiReviewerSkillGitConfirmation,
  signal: AbortSignal,
) {
  return confirmGitImport(userSkillsPath, confirmation, signal);
}
