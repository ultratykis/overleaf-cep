// @ts-check

/**
 * @import {
 *   AgentRequest,
 *   DiscussionTurn,
 * } from '../../shared/contract-types'
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
 */
function formatConversation(turns) {
  return turns
    .map(
      ({ role, text }) => `${role === "user" ? "User" : "Assistant"}:\n${text}`,
    )
    .join("\n\n");
}

/**
 * Render the readable prompt. Project snapshots call this same formatter so
 * accepting a read cannot be followed by a second, differently measured
 * gateway rejection.
 *
 * @param {AgentRequest} request
 * @param {unknown} projectContext
 */
export function formatAgentPrompt(request, projectContext) {
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
  sections.push(
    [
      "## Conversation",
      "",
      formatConversation([
        ...(request.turns ?? []),
        { role: "user", text: request.instruction },
      ]),
    ].join("\n"),
  );
  return sections.join("\n\n");
}
