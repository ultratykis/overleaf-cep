import { z } from "zod";

import {
  AgentErrorSchema,
  AgentEventSchema,
  AgentRequestSchema,
  EvidenceReferenceSchema,
  FindingSchema,
  ProjectRelativePathSchema,
  ProposedSuggestionSchema,
  Sha256Schema,
  SuggestionSchema,
  SuggestionStatusSchema,
  TextRangeSchema,
  ToolCallSchema,
} from "./contracts.mjs";

export type AgentError = z.infer<typeof AgentErrorSchema>;
export type AgentEvent = z.infer<typeof AgentEventSchema>;
export type AgentRequest = z.infer<typeof AgentRequestSchema>;
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
export type ProposedSuggestion = z.infer<typeof ProposedSuggestionSchema>;
export type Sha256 = z.infer<typeof Sha256Schema>;
export type Suggestion = z.infer<typeof SuggestionSchema>;
export type SuggestionStatus = z.infer<typeof SuggestionStatusSchema>;
export type TextRange = z.infer<typeof TextRangeSchema>;
export type ToolCall = z.infer<typeof ToolCallSchema>;

export interface AgentGatewayOptions {
  signal?: AbortSignal;
}

export interface AgentGateway {
  stream(
    request: AgentRequest,
    options?: AgentGatewayOptions,
  ): AsyncIterable<AgentEvent>;
}
