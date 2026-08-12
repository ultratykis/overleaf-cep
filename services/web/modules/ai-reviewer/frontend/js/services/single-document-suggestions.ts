import { z } from "zod";

import {
  AgentRequestSchema,
  UnresolvedSuggestionSchema,
} from "../../../shared/contracts.mjs";
import type {
  AgentRequest,
  UnresolvedSuggestion,
} from "../../../shared/contract-types";

type SingleDocumentRequest = Omit<AgentRequest, "scope"> & {
  scope: Exclude<AgentRequest["scope"], { kind: "project" }>;
};

type DiscardedSuggestion = Omit<UnresolvedSuggestion, "status"> & {
  status: "discarded";
};

const SingleDocumentSnapshotSchema = z
  .object({
    projectId: z.string().min(1).max(200),
    documentId: z.string().min(1).max(200),
    path: z.string().min(1).max(1_024),
    revision: z.number().int().nonnegative(),
    textHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/, "Expected a lowercase SHA-256 digest"),
    text: z.string().max(1_000_000),
    connected: z.boolean(),
  })
  .strict();

export type SingleDocumentSnapshot = z.infer<
  typeof SingleDocumentSnapshotSchema
>;

export type SingleDocumentSuggestionConflictCode =
  | "AI_EDITOR_OFFLINE"
  | "AI_SUGGESTION_PROJECT_CHANGED"
  | "AI_SUGGESTION_DOCUMENT_CHANGED"
  | "AI_SUGGESTION_REVISION_STALE"
  | "AI_SUGGESTION_HASH_STALE"
  | "AI_SUGGESTION_ORIGINAL_STALE";

export type SingleDocumentSuggestionPreflight =
  | {
      status: "ready";
      change: {
        from: number;
        to: number;
        insert: string;
      };
      userEvent: "input.ai-reviewer.accept";
    }
  | {
      status: "conflict";
      code: SingleDocumentSuggestionConflictCode;
    };

export class SingleDocumentSuggestionError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SingleDocumentSuggestionError";
  }
}

function parseRequest(request: unknown): SingleDocumentRequest {
  const parsed = AgentRequestSchema.safeParse(request);
  if (!parsed.success) {
    throw new SingleDocumentSuggestionError(
      "AI_SUGGESTION_REQUEST_INVALID",
      "The AI reviewer request is invalid.",
    );
  }
  // A scopeless request is project-wide, so it cannot bind an edit either.
  if (parsed.data.scope == null || parsed.data.scope.kind === "project") {
    throw new SingleDocumentSuggestionError(
      "AI_SUGGESTION_SCOPE_UNSUPPORTED",
      "A single-document suggestion requires a document-bound request.",
    );
  }
  return parsed.data as SingleDocumentRequest;
}

function assertSuggestionMatchesRequest(
  request: SingleDocumentRequest,
  suggestion: UnresolvedSuggestion,
) {
  if (suggestion.requestId !== request.requestId) {
    throw new SingleDocumentSuggestionError(
      "AI_SUGGESTION_REQUEST_MISMATCH",
      "The suggestion belongs to another request.",
    );
  }
  if (suggestion.projectId !== request.projectId) {
    throw new SingleDocumentSuggestionError(
      "AI_SUGGESTION_PROJECT_MISMATCH",
      "The suggestion belongs to another project.",
    );
  }
  if (suggestion.skill !== request.skill || request.skill == null) {
    throw new SingleDocumentSuggestionError(
      "AI_SUGGESTION_SKILL_MISMATCH",
      "The suggestion skill does not match the request.",
    );
  }

  const scope = request.scope;
  if (
    suggestion.documentId !== scope.documentId ||
    suggestion.path !== scope.path ||
    suggestion.baseRevision !== scope.baseRevision ||
    suggestion.baseTextHash !== scope.baseTextHash
  ) {
    throw new SingleDocumentSuggestionError(
      "AI_SUGGESTION_BASE_MISMATCH",
      "The suggestion does not match the requested document state.",
    );
  }

  const lowerBound = scope.kind === "selection" ? scope.range.from : 0;
  const upperBound =
    scope.kind === "selection" ? scope.range.to : scope.text.length;
  const sourceOffset = suggestion.range.from - lowerBound;
  if (
    suggestion.range.from < lowerBound ||
    suggestion.range.to > upperBound ||
    sourceOffset < 0 ||
    scope.text.slice(
      sourceOffset,
      sourceOffset + suggestion.original.length,
    ) !== suggestion.original
  ) {
    throw new SingleDocumentSuggestionError(
      "AI_SUGGESTION_RANGE_MISMATCH",
      "The suggestion is outside the requested document range.",
    );
  }

  for (const evidence of suggestion.evidence) {
    const selectionRangeMissing =
      scope.kind === "selection" && evidence.range == null;
    const rangeOutside =
      evidence.range != null &&
      (evidence.range.from < lowerBound || evidence.range.to > upperBound);
    const revisionMismatch =
      evidence.revision != null && evidence.revision !== scope.baseRevision;
    const hashMismatch =
      evidence.textHash != null && evidence.textHash !== scope.baseTextHash;

    if (
      evidence.path !== scope.path ||
      selectionRangeMissing ||
      rangeOutside ||
      revisionMismatch ||
      hashMismatch
    ) {
      throw new SingleDocumentSuggestionError(
        "AI_SUGGESTION_EVIDENCE_MISMATCH",
        "The suggestion evidence does not match the requested document state.",
      );
    }
  }
}

export function prepareSingleDocumentSuggestion({
  request: rawRequest,
  suggestion: rawSuggestion,
}: {
  request: unknown;
  suggestion: unknown;
}): UnresolvedSuggestion {
  const request = parseRequest(rawRequest);
  const parsedSuggestion = UnresolvedSuggestionSchema.safeParse(rawSuggestion);
  if (!parsedSuggestion.success) {
    throw new SingleDocumentSuggestionError(
      "AI_SUGGESTION_SCHEMA_INVALID",
      "The AI reviewer returned an invalid suggestion.",
    );
  }

  assertSuggestionMatchesRequest(request, parsedSuggestion.data);
  return parsedSuggestion.data;
}

function conflict(
  code: SingleDocumentSuggestionConflictCode,
): SingleDocumentSuggestionPreflight {
  return {
    status: "conflict",
    code,
  };
}

export function preflightSingleDocumentSuggestion({
  request: rawRequest,
  suggestion: rawSuggestion,
  snapshot: rawSnapshot,
}: {
  request: unknown;
  suggestion: unknown;
  snapshot: unknown;
}): SingleDocumentSuggestionPreflight {
  const request = parseRequest(rawRequest);
  const suggestion = prepareSingleDocumentSuggestion({
    request,
    suggestion: rawSuggestion,
  });
  const parsedSnapshot = SingleDocumentSnapshotSchema.safeParse(rawSnapshot);
  if (!parsedSnapshot.success) {
    throw new SingleDocumentSuggestionError(
      "AI_EDITOR_SNAPSHOT_INVALID",
      "The current Editor snapshot is invalid.",
    );
  }
  const snapshot = parsedSnapshot.data;

  if (snapshot.projectId !== suggestion.projectId) {
    return conflict("AI_SUGGESTION_PROJECT_CHANGED");
  }
  if (
    snapshot.documentId !== suggestion.documentId ||
    snapshot.path !== suggestion.path
  ) {
    return conflict("AI_SUGGESTION_DOCUMENT_CHANGED");
  }
  if (!snapshot.connected) {
    return conflict("AI_EDITOR_OFFLINE");
  }
  if (snapshot.textHash !== suggestion.baseTextHash) {
    return conflict(
      snapshot.revision === suggestion.baseRevision
        ? "AI_SUGGESTION_HASH_STALE"
        : "AI_SUGGESTION_REVISION_STALE",
    );
  }
  if (
    suggestion.range.to > snapshot.text.length ||
    snapshot.text.slice(suggestion.range.from, suggestion.range.to) !==
      suggestion.original
  ) {
    return conflict("AI_SUGGESTION_ORIGINAL_STALE");
  }

  return {
    status: "ready",
    change: {
      from: suggestion.range.from,
      to: suggestion.range.to,
      insert: suggestion.replacement,
    },
    userEvent: "input.ai-reviewer.accept",
  };
}

export function discardSingleDocumentSuggestion(
  rawSuggestion: unknown,
): DiscardedSuggestion {
  const parsed = UnresolvedSuggestionSchema.safeParse(rawSuggestion);
  if (!parsed.success) {
    throw new SingleDocumentSuggestionError(
      "AI_SUGGESTION_SCHEMA_INVALID",
      "The AI reviewer returned an invalid suggestion.",
    );
  }
  return {
    ...parsed.data,
    status: "discarded",
  };
}
