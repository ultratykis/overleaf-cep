// @ts-check

import { createHash } from "node:crypto";

import { AiReviewerWorkspace as AiReviewerWorkspaceModel } from "../models/AiReviewerWorkspace.mjs";
import { AiReviewerWorkspaceSchema } from "../../shared/contracts.mjs";

export class AiReviewerWorkspaceValidationError extends Error {
  constructor() {
    super("The AI reviewer workspace is invalid.");
    this.name = "AiReviewerWorkspaceValidationError";
  }
}

export class AiReviewerWorkspaceLimitError extends Error {
  constructor() {
    super("The AI reviewer workspace limit was reached.");
    this.name = "AiReviewerWorkspaceLimitError";
  }
}

export class AiReviewerWorkspaceConflictError extends Error {
  constructor() {
    super("The AI reviewer workspace changed in another session.");
    this.name = "AiReviewerWorkspaceConflictError";
  }
}

const MAX_WORKSPACE_MUTATION_RETRIES = 5;

function emptyWorkspace() {
  return {
    runs: [],
    discussions: [],
  };
}

function emptySnapshot() {
  return {
    revision: 0,
    workspace: emptyWorkspace(),
  };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function boundedIdentifier(value) {
  try {
    const identifier = value?.toString?.();
    if (
      typeof identifier !== "string" ||
      identifier.length === 0 ||
      identifier.length > 200
    ) {
      throw new AiReviewerWorkspaceValidationError();
    }
    return identifier;
  } catch (error) {
    if (error instanceof AiReviewerWorkspaceValidationError) {
      throw error;
    }
    throw new AiReviewerWorkspaceValidationError();
  }
}

/** @param {unknown} value */
function scopeIdentifier(value) {
  const identifier = boundedIdentifier(value);
  return /^[0-9a-f]{24}$/i.test(identifier)
    ? identifier.toLowerCase()
    : identifier;
}

/**
 * MongoDB always enforces `_id` uniqueness, unlike schema indexes when
 * Mongoose auto-indexing is disabled. Hash only the normalized scope
 * identifiers so concurrent upserts for one user/project pair share one key.
 *
 * @param {string} userId
 * @param {string} projectId
 */
function workspaceScopeId(userId, projectId) {
  return createHash("sha256")
    .update(JSON.stringify([userId, projectId]))
    .digest("hex");
}

/** @param {any} record */
function storedRevision(record) {
  if (!Number.isSafeInteger(record?.revision) || record.revision < 0) {
    throw new AiReviewerWorkspaceValidationError();
  }
  return /** @type {number} */ (record.revision);
}

/** @param {unknown} value */
function expectedRevision(value) {
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) < 0) {
    throw new AiReviewerWorkspaceValidationError();
  }
  return /** @type {number} */ (value);
}

/** @param {unknown} error */
function isDuplicateKeyError(error) {
  return (
    typeof error === "object" &&
    error != null &&
    "code" in error &&
    error.code === 11000
  );
}

/** @param {any} issue */
function isWorkspaceBoundIssue(issue) {
  if (issue?.code !== "too_big" || !Array.isArray(issue.path)) {
    return false;
  }
  if (issue.path.length === 1 && issue.path[0] === "discussions") {
    return true;
  }
  return (
    issue.path[0] === "discussions" &&
    Number.isInteger(issue.path[1]) &&
    issue.path[2] === "turns"
  );
}

/**
 * @param {unknown} input
 * @param {string} projectId
 */
function parseWorkspace(input, projectId) {
  const parsed = AiReviewerWorkspaceSchema.safeParse(input);
  if (!parsed.success) {
    if (parsed.error.issues.some(isWorkspaceBoundIssue)) {
      throw new AiReviewerWorkspaceLimitError();
    }
    throw new AiReviewerWorkspaceValidationError();
  }

  for (const run of parsed.data.runs) {
    if (scopeIdentifier(run.request.projectId) !== projectId) {
      throw new AiReviewerWorkspaceValidationError();
    }
  }
  for (const discussion of parsed.data.discussions) {
    if (discussion.subject != null) {
      if (
        scopeIdentifier(discussion.subject.sourceRequest.projectId) !==
        projectId
      ) {
        throw new AiReviewerWorkspaceValidationError();
      }
      if (
        discussion.subject.kind !== "scope" &&
        scopeIdentifier(discussion.subject.artifact.projectId) !== projectId
      ) {
        throw new AiReviewerWorkspaceValidationError();
      }
    }
    if (
      discussion.suggestions.some(
        (suggestion) =>
          scopeIdentifier(suggestion.artifact.projectId) !== projectId,
      )
    ) {
      throw new AiReviewerWorkspaceValidationError();
    }
  }
  return parsed.data;
}

/**
 * @param {any} record
 * @param {string} scopeId
 * @param {string} userId
 * @param {string} projectId
 */
function storedWorkspace(record, scopeId, userId, projectId) {
  if (record == null) {
    return null;
  }
  if (
    scopeIdentifier(record._id) !== scopeId ||
    scopeIdentifier(record.userId) !== userId ||
    scopeIdentifier(record.projectId) !== projectId
  ) {
    throw new AiReviewerWorkspaceValidationError();
  }
  return parseWorkspace(record.workspace, projectId);
}

/**
 * @param {any} record
 * @param {string} scopeId
 * @param {string} userId
 * @param {string} projectId
 */
function storedSnapshot(record, scopeId, userId, projectId) {
  const workspace = storedWorkspace(record, scopeId, userId, projectId);
  return workspace == null
    ? null
    : {
        revision: storedRevision(record),
        workspace,
      };
}

/**
 * @param {import("../../shared/contract-types").AiReviewerWorkspace} workspace
 */
function dropEmptyUnboundRuns(workspace) {
  const boundRequestIds = new Set(
    workspace.discussions.flatMap((discussion) =>
      discussion.subject == null
        ? []
        : [discussion.subject.sourceRequest.requestId],
    ),
  );
  const runs = workspace.runs.filter(
    (run) =>
      run.findings.length > 0 ||
      run.suggestions.length > 0 ||
      boundRequestIds.has(run.request.requestId),
  );
  return runs.length === workspace.runs.length
    ? workspace
    : { ...workspace, runs };
}

/**
 * Remove only artifacts that were already resolved when this load began.
 * Discussions themselves remain until an explicit delete.
 *
 * @param {import("../../shared/contract-types").AiReviewerWorkspace} workspace
 */
export function clearResolvedWorkspace(workspace) {
  let changed = false;
  const discussions = workspace.discussions.map((discussion) => {
    const suggestions = discussion.suggestions.filter(
      (suggestion) => suggestion.artifact.status === "unresolved",
    );
    if (suggestions.length === discussion.suggestions.length) {
      return discussion;
    }
    changed = true;
    return {
      ...discussion,
      suggestions,
    };
  });
  const boundRequestIds = new Set(
    discussions.flatMap((discussion) =>
      discussion.subject == null
        ? []
        : [discussion.subject.sourceRequest.requestId],
    ),
  );
  const runs = [];
  for (const run of workspace.runs) {
    const findings = run.findings.filter(
      (finding) => finding.status === "unresolved",
    );
    const suggestions = run.suggestions.filter(
      (suggestion) => suggestion.artifact.status === "unresolved",
    );
    const runChanged =
      findings.length !== run.findings.length ||
      suggestions.length !== run.suggestions.length;
    const hasDiscussion = boundRequestIds.has(run.request.requestId);
    if (findings.length === 0 && suggestions.length === 0 && !hasDiscussion) {
      changed = true;
      continue;
    }
    if (runChanged) {
      changed = true;
      runs.push({
        ...run,
        findings,
        suggestions,
      });
    } else {
      runs.push(run);
    }
  }
  return {
    changed,
    workspace: changed ? { ...workspace, runs, discussions } : workspace,
  };
}

/**
 * @param {{ model?: typeof AiReviewerWorkspaceModel }} [dependencies]
 */
export function createAiReviewerWorkspaceStore({
  model = AiReviewerWorkspaceModel,
} = {}) {
  /**
   * @param {string} userId
   * @param {string} projectId
   * @param {import("../../shared/contract-types").AiReviewerWorkspace} workspace
   * @param {{ upsert: boolean, expectedRevision: number }} options
   */
  async function persist(
    userId,
    projectId,
    workspace,
    { upsert, expectedRevision },
  ) {
    const scopeId = workspaceScopeId(userId, projectId);
    const filter = {
      _id: scopeId,
      userId,
      projectId,
      revision: expectedRevision,
    };
    const record = await model
      .findOneAndUpdate(
        filter,
        {
          $set: { workspace },
          $inc: { revision: 1 },
        },
        {
          new: true,
          runValidators: true,
          setDefaultsOnInsert: true,
          upsert,
        },
      )
      .lean()
      .exec();
    if (record == null) {
      return null;
    }
    return storedSnapshot(record, scopeId, userId, projectId);
  }

  return {
    /**
     * Loading is the sole operation that clears artifacts resolved in a prior
     * session.
     *
     * @param {unknown} userIdInput
     * @param {unknown} projectIdInput
     */
    async load(userIdInput, projectIdInput) {
      const userId = scopeIdentifier(userIdInput);
      const projectId = scopeIdentifier(projectIdInput);
      const scopeId = workspaceScopeId(userId, projectId);
      for (
        let attempt = 0;
        attempt < MAX_WORKSPACE_MUTATION_RETRIES;
        attempt += 1
      ) {
        const record = await model
          .findOne({ _id: scopeId, userId, projectId })
          .lean()
          .exec();
        const snapshot = storedSnapshot(record, scopeId, userId, projectId);
        if (snapshot == null) {
          return emptySnapshot();
        }
        const cleaned = clearResolvedWorkspace(snapshot.workspace);
        if (!cleaned.changed) {
          return snapshot;
        }
        const validated = parseWorkspace(cleaned.workspace, projectId);
        const persisted = await persist(userId, projectId, validated, {
          upsert: false,
          expectedRevision: snapshot.revision,
        });
        if (persisted != null) {
          return persisted;
        }
      }
      throw new Error(
        "The AI reviewer workspace changed while resolved artifacts were cleared.",
      );
    },

    /**
     * @param {unknown} userIdInput
     * @param {unknown} projectIdInput
     * @param {unknown} input
     * @param {unknown} expectedRevisionInput
     */
    async save(userIdInput, projectIdInput, input, expectedRevisionInput) {
      const userId = scopeIdentifier(userIdInput);
      const projectId = scopeIdentifier(projectIdInput);
      const workspace = parseWorkspace(input, projectId);
      const revision = expectedRevision(expectedRevisionInput);
      try {
        const persisted = await persist(userId, projectId, workspace, {
          upsert: revision === 0,
          expectedRevision: revision,
        });
        if (persisted == null) {
          throw new AiReviewerWorkspaceConflictError();
        }
        return persisted;
      } catch (error) {
        if (isDuplicateKeyError(error)) {
          throw new AiReviewerWorkspaceConflictError();
        }
        throw error;
      }
    },

    /**
     * @param {unknown} userIdInput
     * @param {unknown} projectIdInput
     * @param {unknown} discussionIdInput
     */
    async deleteDiscussion(userIdInput, projectIdInput, discussionIdInput) {
      const userId = scopeIdentifier(userIdInput);
      const projectId = scopeIdentifier(projectIdInput);
      const discussionId = boundedIdentifier(discussionIdInput);
      const scopeId = workspaceScopeId(userId, projectId);
      for (
        let attempt = 0;
        attempt < MAX_WORKSPACE_MUTATION_RETRIES;
        attempt += 1
      ) {
        const record = await model
          .findOne({ _id: scopeId, userId, projectId })
          .lean()
          .exec();
        const snapshot = storedSnapshot(record, scopeId, userId, projectId);
        if (snapshot == null) {
          return emptySnapshot();
        }
        const discussions = snapshot.workspace.discussions.filter(
          (discussion) => discussion.id !== discussionId,
        );
        if (discussions.length === snapshot.workspace.discussions.length) {
          return snapshot;
        }
        const withoutDiscussion = dropEmptyUnboundRuns({
          ...snapshot.workspace,
          discussions,
        });
        const validated = parseWorkspace(withoutDiscussion, projectId);
        const persisted = await persist(userId, projectId, validated, {
          upsert: false,
          expectedRevision: snapshot.revision,
        });
        if (persisted != null) {
          return persisted;
        }
      }
      throw new Error(
        "The AI reviewer workspace changed while a discussion was deleted.",
      );
    },

    /**
     * @param {unknown} userIdInput
     * @param {unknown} projectIdInput
     */
    async deleteWorkspace(userIdInput, projectIdInput) {
      const userId = scopeIdentifier(userIdInput);
      const projectId = scopeIdentifier(projectIdInput);
      const scopeId = workspaceScopeId(userId, projectId);
      const record = await model
        .findOneAndUpdate(
          { _id: scopeId, userId, projectId },
          {
            $set: { workspace: emptyWorkspace() },
            $inc: { revision: 1 },
          },
          {
            new: true,
            runValidators: true,
            setDefaultsOnInsert: true,
            upsert: true,
          },
        )
        .lean()
        .exec();
      const snapshot = storedSnapshot(record, scopeId, userId, projectId);
      if (snapshot == null) {
        throw new Error("The AI reviewer workspace could not be cleared.");
      }
      return snapshot;
    },

    /** @param {unknown} projectIdInput */
    async deleteProject(projectIdInput) {
      const projectId = scopeIdentifier(projectIdInput);
      return await model.deleteMany({ projectId }).exec();
    },

    /** @param {unknown} userIdInput */
    async deleteUser(userIdInput) {
      const userId = scopeIdentifier(userIdInput);
      return await model.deleteMany({ userId }).exec();
    },
  };
}
