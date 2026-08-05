// @ts-check

import { z } from "zod";

/** @import { JsonValue } from './contract-types' */

const IdentifierSchema = z.string().min(1).max(200);
const WorkspaceSubjectKeySchema = z.string().min(1).max(512);
const ShortTextSchema = z.string().min(1).max(2_000);
const ContentSchema = z.string().max(1_000_000);
export const DISCUSSION_CONTEXT_TURN_LIMIT = 12;
export const AI_REVIEWER_WORKSPACE_DISCUSSION_LIMIT = 20;
export const AI_REVIEWER_WORKSPACE_TURN_LIMIT = 100;

export const Sha256Schema = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "Expected a lowercase SHA-256 digest");

export const ProjectRelativePathSchema = z
  .string()
  .min(1)
  .max(1_024)
  .superRefine((value, context) => {
    const segments = value.split("/");
    const unsafe =
      value.startsWith("/") ||
      /^[a-zA-Z]:\//.test(value) ||
      value.includes("\\") ||
      value.includes("\0") ||
      /%(?:2e|2f|5c)/i.test(value) ||
      segments.some(
        (segment) =>
          segment.length === 0 || segment === "." || segment === "..",
      );

    if (unsafe) {
      context.addIssue({
        code: "custom",
        message: "Expected a normalized project-relative path",
      });
    }
  });

export const TextRangeSchema = z
  .object({
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
  })
  .strict()
  .refine((range) => range.to >= range.from, {
    message: "Range end must not precede its start",
    path: ["to"],
  });

export const EvidenceReferenceSchema = z
  .object({
    path: ProjectRelativePathSchema,
    range: TextRangeSchema.optional(),
    revision: z.number().int().nonnegative().optional(),
    textHash: Sha256Schema.optional(),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (
      evidence.range == null &&
      evidence.revision == null &&
      evidence.textHash == null
    ) {
      context.addIssue({
        code: "custom",
        message: "Evidence must include a range, revision, or text hash",
      });
    }
  });

const DocumentScopeBase = {
  documentId: IdentifierSchema,
  path: ProjectRelativePathSchema,
  baseRevision: z.number().int().nonnegative(),
  baseTextHash: Sha256Schema,
};

const SelectionScopeSchema = z
  .object({
    kind: z.literal("selection"),
    ...DocumentScopeBase,
    range: TextRangeSchema,
    text: ContentSchema,
  })
  .strict()
  .superRefine((scope, context) => {
    if (scope.text.length !== scope.range.to - scope.range.from) {
      context.addIssue({
        code: "custom",
        message: "Selection text length must match its range",
        path: ["text"],
      });
    }
  });

const DocumentScopeSchema = z
  .object({
    kind: z.literal("document"),
    ...DocumentScopeBase,
    text: ContentSchema,
  })
  .strict();

const ProjectScopeSchema = z
  .object({
    kind: z.literal("project"),
  })
  .strict();

export const DiscussionTurnSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    text: z.string().min(1),
  })
  .strict();

// One request covers both an editor selection action and an ordinary message,
// because the agent path behind them is one path. `instruction` is always the
// message the user just sent; `turns` is what was said before it. Editor
// actions carry their captured scope, while a message carries the mode the
// author can see beside the composer.
export const AgentRequestSchema = z
  .object({
    requestId: IdentifierSchema,
    projectId: IdentifierSchema,
    action: z.enum([
      "review",
      "rewrite",
      "shorten",
      "terminology",
      "citation-audit",
      "compile-fix",
      "complete",
    ]),
    instruction: z.string().min(1).max(20_000),
    skill: IdentifierSchema.nullable(),
    // The client sends both together: choosing a model in the unified list
    // also chooses the connection it came from. Both stay optional so a user
    // with a single connection offering a single model need not choose.
    connectionId: IdentifierSchema.optional(),
    model: IdentifierSchema.optional(),
    scope: z
      .discriminatedUnion("kind", [
        SelectionScopeSchema,
        DocumentScopeSchema,
        ProjectScopeSchema,
      ])
      .optional(),
    turns: z
      .array(DiscussionTurnSchema)
      .max(DISCUSSION_CONTEXT_TURN_LIMIT)
      .optional(),
  })
  .strict();

export const SuggestionStatusSchema = z.enum([
  "unresolved",
  "applied",
  "discarded",
  "conflict",
  "posted",
]);

export const SuggestionSchema = z
  .object({
    id: IdentifierSchema,
    requestId: IdentifierSchema,
    projectId: IdentifierSchema,
    documentId: IdentifierSchema,
    path: ProjectRelativePathSchema,
    baseRevision: z.number().int().nonnegative(),
    baseTextHash: Sha256Schema,
    range: TextRangeSchema,
    original: ContentSchema,
    replacement: ContentSchema,
    rationale: ShortTextSchema,
    evidence: z.array(EvidenceReferenceSchema).min(1).max(100),
    provider: IdentifierSchema,
    model: IdentifierSchema,
    skill: IdentifierSchema,
    createdAt: z.string().datetime({ offset: true }),
    status: SuggestionStatusSchema,
  })
  .strict()
  .superRefine((suggestion, context) => {
    if (
      suggestion.original.length !==
      suggestion.range.to - suggestion.range.from
    ) {
      context.addIssue({
        code: "custom",
        message: "Original text length must match its range",
        path: ["original"],
      });
    }
  });

export const UnresolvedSuggestionSchema = SuggestionSchema.safeExtend({
  status: z.literal("unresolved"),
});

const FindingBaseShape = {
  id: IdentifierSchema,
  requestId: IdentifierSchema,
  projectId: IdentifierSchema,
  severity: z.enum(["info", "suggestion", "warning", "error"]),
  category: IdentifierSchema,
  title: ShortTextSchema,
  message: z.string().min(1).max(20_000),
  evidence: z.array(EvidenceReferenceSchema).min(1).max(100),
  suggestionIds: z.array(IdentifierSchema).max(100),
};

export const OrdinaryFindingSchema = z
  .object({
    ...FindingBaseShape,
    artifactKind: z.literal("finding"),
  })
  .strict();

export const CitationFindingSchema = z
  .object({
    ...FindingBaseShape,
    artifactKind: z.literal("citation-finding"),
    proposedText: ContentSchema.min(1),
  })
  .strict();

export const FindingSchema = z.discriminatedUnion("artifactKind", [
  OrdinaryFindingSchema,
  CitationFindingSchema,
]);

export const DiscussionSubjectSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("finding"),
      sourceRequest: AgentRequestSchema,
      artifact: OrdinaryFindingSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("citation-finding"),
      sourceRequest: AgentRequestSchema,
      artifact: CitationFindingSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("suggestion"),
      sourceRequest: AgentRequestSchema,
      artifact: UnresolvedSuggestionSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("scope"),
      sourceRequest: AgentRequestSchema,
    })
    .strict(),
]);

export const WorkspaceFindingStatusSchema = z.enum([
  "unresolved",
  "discarded",
  "posted",
]);

export const WorkspaceFindingSchema = z
  .object({
    artifact: FindingSchema,
    status: WorkspaceFindingStatusSchema,
  })
  .strict()
  .superRefine((entry, context) => {
    if (
      entry.artifact.artifactKind === "citation-finding" &&
      entry.status === "posted"
    ) {
      context.addIssue({
        code: "custom",
        message: "A citation finding cannot be posted as a comment",
        path: ["status"],
      });
    }
  });

export const WorkspaceSuggestionSchema = z
  .object({
    artifact: SuggestionSchema,
    conflictCode: IdentifierSchema.optional(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.conflictCode != null && entry.artifact.status !== "conflict") {
      context.addIssue({
        code: "custom",
        message: "Only a conflicting suggestion may carry a conflict code",
        path: ["conflictCode"],
      });
    }
  });

const WorkspaceOrderSchema = z.number().int().nonnegative();
export const WorkspaceRevisionSchema = z.number().int().nonnegative();
const WorkspaceRunGroupSchema = z
  .object({
    id: IdentifierSchema,
    position: z.number().int().positive(),
    total: z.number().int().positive(),
  })
  .strict()
  .refine((group) => group.position <= group.total, {
    message: "Run group position must not exceed its total",
    path: ["position"],
  });

export const WorkspaceRunSchema = z
  .object({
    generation: WorkspaceOrderSchema,
    createdOrder: WorkspaceOrderSchema,
    request: AgentRequestSchema,
    provider: IdentifierSchema.optional(),
    model: IdentifierSchema.optional(),
    group: WorkspaceRunGroupSchema.optional(),
    // Records written before model-generated subjects remain readable. A
    // missing value hydrates to the same no-subject fallback as a run whose
    // model did not produce one.
    subject: ShortTextSchema.optional(),
    text: ContentSchema,
    findings: z.array(WorkspaceFindingSchema).max(100),
    suggestions: z.array(WorkspaceSuggestionSchema).max(100),
  })
  .strict();

export const WorkspaceDiscussionSchema = z
  .object({
    id: IdentifierSchema,
    createdOrder: WorkspaceOrderSchema,
    subjectKey: WorkspaceSubjectKeySchema.nullable(),
    subject: DiscussionSubjectSchema.nullable(),
    sourceGeneration: WorkspaceOrderSchema.nullable(),
    turns: z.array(DiscussionTurnSchema).max(AI_REVIEWER_WORKSPACE_TURN_LIMIT),
    suggestions: z.array(WorkspaceSuggestionSchema),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((discussion, context) => {
    const hasSubject = discussion.subject != null;
    if (
      hasSubject !== (discussion.subjectKey != null) ||
      hasSubject !== (discussion.sourceGeneration != null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Workspace discussion subject bindings must be all present or all null",
        path: ["subject"],
      });
    }
    if (!hasSubject && discussion.suggestions.length > 0) {
      context.addIssue({
        code: "custom",
        message: "An open discussion cannot contain suggestions",
        path: ["suggestions"],
      });
    }
  });

// The client keeps its model choice here so a reload, a discussion, and a
// rewrite all run against the same destination. An absent choice stays absent:
// neither the client nor the server may silently choose another destination.
export const WorkspaceModelSelectionSchema = z
  .object({
    connectionId: IdentifierSchema,
    model: IdentifierSchema,
  })
  .strict();

/**
 * Resolve a stored choice only against the user's live connections. Returning
 * null deliberately means no selection; there is no destination fallback.
 *
 * @param {import("./contract-types").WorkspaceModelSelection | null | undefined} selection
 * @param {readonly { id: string }[]} connections
 */
export function resolveWorkspaceModelSelection(selection, connections) {
  if (selection == null) {
    return null;
  }
  return connections.some(
    (connection) => connection.id === selection.connectionId,
  )
    ? selection
    : null;
}

export const AiReviewerWorkspaceSchema = z
  .object({
    runs: z.array(WorkspaceRunSchema),
    discussions: z
      .array(WorkspaceDiscussionSchema)
      .max(AI_REVIEWER_WORKSPACE_DISCUSSION_LIMIT),
    // Workspaces stored before this field existed carry no selection. Leaving
    // it absent rather than defaulting it keeps those records byte-identical
    // through a load and save, so no migration is needed; readers treat a
    // missing value the same as null.
    selectedModel: WorkspaceModelSelectionSchema.nullable().optional(),
  })
  .strict()
  .superRefine((workspace, context) => {
    const runsByRequestId = new Map();
    const runGenerations = new Set();
    const createdOrders = new Set();
    const discussionIds = new Set();
    const discussionSubjectKeys = new Set();

    for (const [runIndex, run] of workspace.runs.entries()) {
      const requestId = run.request.requestId;
      if (runsByRequestId.has(requestId)) {
        context.addIssue({
          code: "custom",
          message: "Workspace run request IDs must be unique",
          path: ["runs", runIndex, "request", "requestId"],
        });
      } else {
        runsByRequestId.set(requestId, run);
      }
      if (runGenerations.has(run.generation)) {
        context.addIssue({
          code: "custom",
          message: "Workspace run generations must be unique",
          path: ["runs", runIndex, "generation"],
        });
      }
      runGenerations.add(run.generation);
      if (createdOrders.has(run.createdOrder)) {
        context.addIssue({
          code: "custom",
          message: "Workspace timeline order must be unique",
          path: ["runs", runIndex, "createdOrder"],
        });
      }
      createdOrders.add(run.createdOrder);

      for (const [findingIndex, finding] of run.findings.entries()) {
        if (
          finding.artifact.requestId !== requestId ||
          finding.artifact.projectId !== run.request.projectId
        ) {
          context.addIssue({
            code: "custom",
            message: "Workspace finding must belong to its run",
            path: ["runs", runIndex, "findings", findingIndex, "artifact"],
          });
        }
      }
      for (const [suggestionIndex, suggestion] of run.suggestions.entries()) {
        if (
          suggestion.artifact.requestId !== requestId ||
          suggestion.artifact.projectId !== run.request.projectId
        ) {
          context.addIssue({
            code: "custom",
            message: "Workspace suggestion must belong to its run",
            path: [
              "runs",
              runIndex,
              "suggestions",
              suggestionIndex,
              "artifact",
            ],
          });
        }
      }
    }

    for (const [
      discussionIndex,
      discussion,
    ] of workspace.discussions.entries()) {
      if (discussionIds.has(discussion.id)) {
        context.addIssue({
          code: "custom",
          message: "Workspace discussion IDs must be unique",
          path: ["discussions", discussionIndex, "id"],
        });
      }
      discussionIds.add(discussion.id);
      if (discussion.subjectKey != null) {
        if (discussionSubjectKeys.has(discussion.subjectKey)) {
          context.addIssue({
            code: "custom",
            message: "Workspace discussion subjects must be unique",
            path: ["discussions", discussionIndex, "subjectKey"],
          });
        }
        discussionSubjectKeys.add(discussion.subjectKey);
      }
      if (createdOrders.has(discussion.createdOrder)) {
        context.addIssue({
          code: "custom",
          message: "Workspace timeline order must be unique",
          path: ["discussions", discussionIndex, "createdOrder"],
        });
      }
      createdOrders.add(discussion.createdOrder);

      if (discussion.subject == null) {
        continue;
      }
      const sourceRequest = discussion.subject.sourceRequest;
      const sourceRun = runsByRequestId.get(sourceRequest.requestId);
      if (
        discussion.subject.kind !== "scope" &&
        (discussion.subject.artifact.requestId !== sourceRequest.requestId ||
          discussion.subject.artifact.projectId !== sourceRequest.projectId)
      ) {
        context.addIssue({
          code: "custom",
          message: "Workspace discussion subject must belong to its source run",
          path: ["discussions", discussionIndex, "subject", "artifact"],
        });
      }
      if (
        sourceRun == null ||
        sourceRun.generation !== discussion.sourceGeneration ||
        JSON.stringify(sourceRun.request) !== JSON.stringify(sourceRequest)
      ) {
        context.addIssue({
          code: "custom",
          message: "Workspace discussion must belong to its source run",
          path: ["discussions", discussionIndex, "subject"],
        });
      }
      for (const [
        suggestionIndex,
        suggestion,
      ] of discussion.suggestions.entries()) {
        if (
          suggestion.artifact.requestId !== sourceRequest.requestId ||
          suggestion.artifact.projectId !== sourceRequest.projectId
        ) {
          context.addIssue({
            code: "custom",
            message: "Discussion suggestion must belong to its source run",
            path: [
              "discussions",
              discussionIndex,
              "suggestions",
              suggestionIndex,
              "artifact",
            ],
          });
        }
      }
    }
  });

export const AiReviewerWorkspaceSnapshotSchema = z
  .object({
    revision: WorkspaceRevisionSchema,
    workspace: AiReviewerWorkspaceSchema,
  })
  .strict();

export const AgentErrorSchema = z
  .object({
    code: IdentifierSchema,
    category: z.enum([
      "aborted",
      "authentication",
      "configuration",
      "network",
      "provider",
      "rate-limit",
      "schema",
      "timeout",
      "unknown",
    ]),
    message: ShortTextSchema,
    retryable: z.boolean(),
  })
  .strict();

/** @type {z.ZodType<JsonValue>} */
export const JsonValueSchema = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

const EventBase = {
  eventId: IdentifierSchema,
  requestId: IdentifierSchema,
  sequence: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: true }),
};

const StartedEventSchema = z
  .object({
    type: z.literal("started"),
    ...EventBase,
    provider: IdentifierSchema,
    model: IdentifierSchema,
    skill: IdentifierSchema.nullable(),
  })
  .strict();

const TextDeltaEventSchema = z
  .object({
    type: z.literal("text.delta"),
    ...EventBase,
    delta: z.string().min(1).max(100_000),
  })
  .strict();

const SubjectEventSchema = z
  .object({
    type: z.literal("subject"),
    ...EventBase,
    subject: ShortTextSchema,
  })
  .strict();

const FindingEventSchema = z
  .object({
    type: z.literal("finding"),
    ...EventBase,
    finding: FindingSchema,
  })
  .strict();

const SuggestionEventSchema = z
  .object({
    type: z.literal("suggestion"),
    ...EventBase,
    suggestion: UnresolvedSuggestionSchema,
  })
  .strict();

export const ReadProjectFileArgumentsSchema = z
  .object({
    path: ProjectRelativePathSchema,
    range: TextRangeSchema.optional(),
  })
  .strict();

export const ZoteroSearchArgumentsSchema = z
  .object({
    query: z.string().trim().min(1).max(200),
  })
  .strict();

const ReadProjectFileToolCallSchema = z
  .object({
    id: IdentifierSchema,
    name: z.literal("read_project_file"),
    arguments: ReadProjectFileArgumentsSchema,
  })
  .strict();

const SearchZoteroToolCallSchema = z
  .object({
    id: IdentifierSchema,
    name: z.literal("search_zotero"),
    arguments: ZoteroSearchArgumentsSchema,
  })
  .strict();

// Only the reading tools are announced. The tools that emit artifacts already
// arrive as `finding` and `suggestion` events, and their arguments carry
// manuscript text that must not be shown as a tool line.
export const ToolCallSchema = z.discriminatedUnion("name", [
  ReadProjectFileToolCallSchema,
  SearchZoteroToolCallSchema,
]);

const ToolCallEventSchema = z
  .object({
    type: z.literal("tool.call"),
    ...EventBase,
    call: ToolCallSchema,
  })
  .strict();

const CompletedEventSchema = z
  .object({
    type: z.literal("completed"),
    ...EventBase,
    finishReason: z.enum(["stop", "cancelled", "length", "tool-calls"]),
    contextTruncated: z.literal(true).optional(),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();

const ErrorEventSchema = z
  .object({
    type: z.literal("error"),
    ...EventBase,
    error: AgentErrorSchema,
  })
  .strict();

const AgentEventUnionSchema = z.discriminatedUnion("type", [
  StartedEventSchema,
  SubjectEventSchema,
  TextDeltaEventSchema,
  FindingEventSchema,
  SuggestionEventSchema,
  ToolCallEventSchema,
  CompletedEventSchema,
  ErrorEventSchema,
]);

export const AgentEventSchema = AgentEventUnionSchema.superRefine(
  (event, context) => {
    const nestedRequestId =
      event.type === "finding"
        ? event.finding.requestId
        : event.type === "suggestion"
          ? event.suggestion.requestId
          : null;

    if (nestedRequestId != null && nestedRequestId !== event.requestId) {
      context.addIssue({
        code: "custom",
        message: "Nested payload request ID must match its event",
        path: [event.type, "requestId"],
      });
    }
  },
);
