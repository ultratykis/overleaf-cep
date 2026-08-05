import { z } from "zod";

import {
  AgentErrorSchema,
  AgentEventSchema,
  AgentRequestSchema,
  AiReviewerWorkspaceSnapshotSchema,
  AiReviewerWorkspaceSchema,
  DiscussionSubjectSchema,
  DiscussionTurnSchema,
  EvidenceReferenceSchema,
  FindingSchema,
  ProjectRelativePathSchema,
  Sha256Schema,
  SuggestionSchema,
  SuggestionStatusSchema,
  TextRangeSchema,
  ToolCallSchema,
  UnresolvedSuggestionSchema,
  WorkspaceDiscussionSchema,
  WorkspaceFindingSchema,
  WorkspaceFindingStatusSchema,
  WorkspaceModelSelectionSchema,
  WorkspaceRunSchema,
  WorkspaceSuggestionSchema,
  ZoteroSearchArgumentsSchema,
} from "./contracts.mjs";

export type AgentError = z.infer<typeof AgentErrorSchema>;
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type AgentRequest = z.infer<typeof AgentRequestSchema>;
export type AiReviewerWorkspaceSnapshot = z.infer<
  typeof AiReviewerWorkspaceSnapshotSchema
>;
export type AiReviewerWorkspace = z.infer<typeof AiReviewerWorkspaceSchema>;
export type DiscussionSubject = z.infer<typeof DiscussionSubjectSchema>;
export type DiscussionTurn = z.infer<typeof DiscussionTurnSchema>;
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;
export type Finding = z.infer<typeof FindingSchema>;
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
export type ProjectRelativePath = z.infer<typeof ProjectRelativePathSchema>;
export type Sha256 = z.infer<typeof Sha256Schema>;
export type Suggestion = z.infer<typeof SuggestionSchema>;
export type SuggestionStatus = z.infer<typeof SuggestionStatusSchema>;
export type TextRange = z.infer<typeof TextRangeSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;
export type UnresolvedSuggestion = z.infer<typeof UnresolvedSuggestionSchema>;
export type WorkspaceDiscussion = z.infer<typeof WorkspaceDiscussionSchema>;
export type WorkspaceFinding = z.infer<typeof WorkspaceFindingSchema>;
export type WorkspaceFindingStatus = z.infer<
  typeof WorkspaceFindingStatusSchema
>;
export type WorkspaceModelSelection = z.infer<
  typeof WorkspaceModelSelectionSchema
>;
export type WorkspaceRun = z.infer<typeof WorkspaceRunSchema>;
export type WorkspaceSuggestion = z.infer<typeof WorkspaceSuggestionSchema>;
export type ZoteroSearchArguments = z.infer<typeof ZoteroSearchArgumentsSchema>;

export interface AgentGatewayOptions {
  signal?: AbortSignal;
}

export interface AgentGateway {
  stream(
    request: AgentRequest,
    options?: AgentGatewayOptions,
  ): AsyncIterable<AgentEvent>;
}
