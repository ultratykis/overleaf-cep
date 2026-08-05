// @ts-check

import { z } from "zod";

/** @import { JsonValue } from './contract-types' */

const IdentifierSchema = z.string().min(1).max(200);
const ShortTextSchema = z.string().min(1).max(2_000);
const ContentSchema = z.string().max(1_000_000);

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
    scope: z.discriminatedUnion("kind", [
      SelectionScopeSchema,
      DocumentScopeSchema,
      ProjectScopeSchema,
    ]),
  })
  .strict();

export const SuggestionStatusSchema = z.enum([
  "proposed",
  "accepted",
  "rejected",
  "stale",
  "conflict",
  "failed",
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

export const ProposedSuggestionSchema = SuggestionSchema.safeExtend({
  status: z.literal("proposed"),
});

export const FindingSchema = z
  .object({
    id: IdentifierSchema,
    requestId: IdentifierSchema,
    projectId: IdentifierSchema,
    severity: z.enum(["info", "suggestion", "warning", "error"]),
    category: IdentifierSchema,
    title: ShortTextSchema,
    message: z.string().min(1).max(20_000),
    evidence: z.array(EvidenceReferenceSchema).min(1).max(100),
    suggestionIds: z.array(IdentifierSchema).max(100),
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
    suggestion: ProposedSuggestionSchema,
  })
  .strict();

export const ReadProjectFileArgumentsSchema = z
  .object({
    path: ProjectRelativePathSchema,
    range: TextRangeSchema.optional(),
  })
  .strict();

const ReadProjectFileToolCallSchema = z
  .object({
    id: IdentifierSchema,
    name: z.literal("read_project_file"),
    arguments: ReadProjectFileArgumentsSchema,
  })
  .strict();

export const ToolCallSchema = z.discriminatedUnion("name", [
  ReadProjectFileToolCallSchema,
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
