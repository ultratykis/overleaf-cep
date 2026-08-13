// @ts-check

import { estimateModelInputTokens } from "./ModelContextBudget.mjs";

/**
 * @import {
 *   AgentRequest,
 *   DiscussionTurn,
 * } from '../../shared/contract-types'
 * @typedef {{ role: "user" | "assistant", content: string }} AgentMessage
 */

/**
 * @param {{ from: number, to: number }} range
 */
function formatRange(range) {
  return `[${range.from}, ${range.to})`;
}

/**
 * @param {NonNullable<AgentRequest["scope"]>} scope
 */
function formatScope(scope) {
  switch (scope.kind) {
    case "selection":
      return [
        "Scope: selection",
        `File: ${scope.path}`,
        `Range: ${formatRange(scope.range)}`,
        "",
        "Selected text:",
        scope.text,
      ].join("\n");
    case "document":
      return [
        "Scope: document",
        `File: ${scope.path}`,
        "",
        "Document text:",
        scope.text,
      ].join("\n");
    case "project":
      return "Scope: project";
  }
}

/**
 * @param {DiscussionTurn[]} turns
 * @returns {AgentMessage[]}
 */
function conversationMessages(turns) {
  return turns.map(({ role, text }) => ({ role, content: text }));
}

/**
 * Render the readable request context without flattening prior conversational
 * roles into labels inside one user message.
 *
 * @param {AgentRequest} request
 * @param {unknown} projectContext
 * @returns {AgentMessage[]}
 */
export function formatAgentMessages(request, projectContext) {
  const sections = [
    [
      "## Task",
      "",
      `Action: ${request.action}`,
      ...(request.skill == null ? [] : [`Skill: ${request.skill}`]),
    ].join("\n"),
  ];
  if (request.scope != null) {
    sections.push(["## Scope", "", formatScope(request.scope)].join("\n"));
  }
  if (projectContext != null) {
    sections.push(
      ["## Project", "", JSON.stringify(projectContext)].join("\n"),
    );
  }
  return [
    { role: "user", content: sections.join("\n\n") },
    ...conversationMessages(request.turns ?? []),
    { role: "user", content: request.instruction },
  ];
}

/**
 * Estimate the exact role-bearing input for the shared token budget. Project
 * snapshots and the gateway must call this same function so accepting a read
 * cannot be followed by a differently measured gateway rejection.
 *
 * @param {AgentRequest} request
 * @param {unknown} projectContext
 */
export function estimateAgentPromptTokens(request, projectContext) {
  return estimateModelInputTokens(formatAgentMessages(request, projectContext));
}

/**
 * Serialize the role-bearing input for the external runner protocol.
 *
 * @param {AgentRequest} request
 * @param {unknown} projectContext
 */
export function formatAgentPrompt(request, projectContext) {
  return JSON.stringify(formatAgentMessages(request, projectContext));
}
