import { simulateReadableStream } from "ai";
// eslint-disable-next-line import/no-unresolved
import { MockLanguageModelV3 } from "ai/test";
import { describe, expect, it, vi } from "vitest";
import logger from "@overleaf/logger";

import { AI_REVIEWER_COMPLETION_LOG_MESSAGE } from "../../../app/src/AiReviewerFailureLogger.mjs";
import { AiSdkAgentGateway } from "../../../app/src/AiSdkAgentGateway.mjs";
import {
  createProjectCommentsReader,
  PROJECT_COMMENTS_MAX_MESSAGE_CHARACTERS,
  PROJECT_COMMENTS_MAX_MESSAGES_PER_THREAD,
  PROJECT_COMMENTS_MAX_QUOTED_TEXT_CHARACTERS,
  PROJECT_COMMENTS_MAX_THREADS,
} from "../../../app/src/ProjectCommentsReader.mjs";
import { createRequestScopeReader } from "../../../app/src/RequestScopeReader.mjs";

const contentHash = "a".repeat(64);
const projectRequest = Object.freeze({
  requestId: "request-comments-0001",
  projectId: "project-comments-0001",
  action: "review",
  instruction: "Review the existing comments.",
  skill: "referee-review",
  scope: Object.freeze({ kind: "project" }),
});

function documentRequest() {
  return {
    ...projectRequest,
    requestId: "request-comments-document-0001",
    scope: {
      kind: "document",
      documentId: "document-comments-0001",
      path: "main.tex",
      baseRevision: 3,
      baseTextHash: contentHash,
      text: "First line\nSecond line",
    },
  };
}

function selectionTransformRequest() {
  return {
    ...projectRequest,
    requestId: "request-comments-selection-0001",
    action: "rewrite",
    skill: "rewrite",
    scope: {
      kind: "selection",
      documentId: "document-comments-0001",
      path: "main.tex",
      baseRevision: 3,
      baseTextHash: contentHash,
      range: { from: 0, to: 4 },
      text: "Text",
    },
  };
}

function httpRequest(body) {
  return {
    body,
    params: { project_id: body.projectId },
    user: { _id: { toString: () => "user-comments-0001" } },
  };
}

function finish() {
  return {
    type: "finish",
    finishReason: { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: 1, noCache: 1 },
      outputTokens: { total: 1, text: 1 },
    },
  };
}

function model() {
  return new MockLanguageModelV3({
    provider: "fixture",
    modelId: "comments-model",
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [finish()],
        initialDelayInMs: null,
        chunkDelayInMs: null,
      }),
    }),
  });
}

async function collect(stream) {
  const events = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function settle(stream) {
  try {
    await collect(stream);
  } catch {
    // A selection transform requires a suggestion; the provider request is
    // still available for checking the tools sent before that rejection.
  }
}

function documents() {
  return {
    "main.tex": {
      _id: "document-comments-0001",
      version: 3,
      lines: ["First line", "Second line"],
      ranges: {
        comments: [
          { id: "range-1", op: { p: 11, c: "Second", t: "thread-1" } },
          { id: "range-2", op: { p: 0, c: "First", t: "thread-2" } },
        ],
      },
    },
    "appendix.tex": {
      _id: "document-comments-0002",
      version: 1,
      lines: ["Appendix"],
      ranges: {
        comments: [
          {
            id: "range-3",
            op: { p: 0, c: "Appendix", t: "thread-3" },
          },
        ],
      },
    },
  };
}

describe("AI reviewer: project comments", function () {
  it("joins unresolved threads to anchors, orders them, and applies filters", async function () {
    const getThreads = vi.fn(async () => ({
      "thread-orphan": {
        messages: [{ content: "Orphan", user_id: "user-1" }],
      },
      "thread-1": {
        messages: [
          { content: "Please clarify.", user_id: "user-1" },
          { content: "Email-only user.", user_id: "user-2" },
        ],
      },
      "thread-2": {
        resolved: true,
        messages: [{ content: "Already fixed.", user_id: "user-1" }],
      },
      "thread-3": {
        messages: [{ content: "Check the appendix.", user_id: "user-1" }],
      },
    }));
    const getUsers = vi.fn(async () => [
      {
        _id: "user-1",
        first_name: "Ada",
        last_name: "Lovelace",
        email: "ada@example.com",
      },
      { _id: "user-2", email: "private@example.com" },
    ]);
    const reader = createProjectCommentsReader({
      getThreads,
      loadProjectDocuments: vi.fn(async () => documents()),
      getUsers,
    });

    const result = await reader(projectRequest.projectId, {});

    expect(result).toEqual({
      threads: [
        {
          threadId: "thread-3",
          docPath: "appendix.tex",
          quotedText: "Appendix",
          line: 1,
          messages: [
            { author: "Ada Lovelace", content: "Check the appendix." },
          ],
        },
        {
          threadId: "thread-1",
          docPath: "main.tex",
          quotedText: "Second",
          line: 2,
          messages: [
            { author: "Ada Lovelace", content: "Please clarify." },
            { content: "Email-only user." },
          ],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("@");
    expect(getUsers).toHaveBeenCalledWith(expect.any(Set), {
      _id: true,
      first_name: true,
      last_name: true,
    });
    expect(
      await reader(projectRequest.projectId, { docPath: "main.tex" }),
    ).toMatchObject({ threads: [{ threadId: "thread-1" }] });
    expect(
      await reader(projectRequest.projectId, { threadId: "thread-3" }),
    ).toMatchObject({ threads: [{ threadId: "thread-3" }] });
    expect(
      await reader(projectRequest.projectId, { docPath: "unknown.tex" }),
    ).toEqual({ threads: [] });
    expect(
      await reader(projectRequest.projectId, { threadId: "unknown-thread" }),
    ).toEqual({ threads: [] });
  });

  it("bounds threads, messages, quoted text, and message content", async function () {
    const threadCount = PROJECT_COMMENTS_MAX_THREADS + 1;
    const messageCount = PROJECT_COMMENTS_MAX_MESSAGES_PER_THREAD + 1;
    const threads = Object.fromEntries(
      Array.from({ length: threadCount }, (_, threadIndex) => [
        `thread-${threadIndex}`,
        {
          messages: Array.from({ length: messageCount }, (_, messageIndex) => ({
            content:
              threadIndex === 0 && messageIndex === 0
                ? "m".repeat(PROJECT_COMMENTS_MAX_MESSAGE_CHARACTERS + 1)
                : `message-${messageIndex}`,
            user_id: "user-1",
          })),
        },
      ]),
    );
    const reader = createProjectCommentsReader({
      getThreads: vi.fn(async () => threads),
      loadProjectDocuments: vi.fn(async () => ({
        "main.tex": {
          lines: ["x".repeat(threadCount)],
          ranges: {
            comments: Array.from({ length: threadCount }, (_, index) => ({
              id: `range-${index}`,
              op: {
                p: index,
                c:
                  index === 0
                    ? "q".repeat(
                        PROJECT_COMMENTS_MAX_QUOTED_TEXT_CHARACTERS + 1,
                      )
                    : `quote-${index}`,
                t: `thread-${index}`,
              },
            })),
          },
        },
      })),
      getUsers: vi.fn(async () => [
        { _id: "user-1", first_name: "Ada", last_name: "Lovelace" },
      ]),
    });

    const result = await reader(projectRequest.projectId, {});

    expect(result.truncated).toBe(true);
    expect(result.threads).toHaveLength(PROJECT_COMMENTS_MAX_THREADS);
    expect(result.threads.at(-1).threadId).toBe("thread-39");
    expect(result.threads[0].quotedText).toHaveLength(
      PROJECT_COMMENTS_MAX_QUOTED_TEXT_CHARACTERS,
    );
    expect(result.threads[0].messages).toHaveLength(
      PROJECT_COMMENTS_MAX_MESSAGES_PER_THREAD,
    );
    expect(result.threads[0].messages[0].content).toHaveLength(
      PROJECT_COMMENTS_MAX_MESSAGE_CHARACTERS,
    );
    expect(result.threads[0].messages[1].content).toBe("message-2");
    expect(result.threads[0].messages.at(-1).content).toBe("message-12");
  });

  it("defaults scoped reads to the active document and leaves project reads unfiltered", async function () {
    const loadProjectComments = vi.fn(async () => ({ threads: [] }));
    const scopeReader = createRequestScopeReader({
      loadProjectDocuments: vi.fn(async () => documents()),
      loadProjectComments,
    });
    const scopedRequest = documentRequest();
    const scoped = await scopeReader.read(httpRequest(scopedRequest), {
      contextLength: 8_192,
      contextLengthSource: "override",
    });

    await scoped.readProjectComments({}, { request: scopedRequest });
    await scoped.readProjectComments(
      { docPath: "appendix.tex", threadId: "thread-3" },
      { request: scopedRequest },
    );

    expect(loadProjectComments.mock.calls[0][1]).toEqual({
      docPath: "main.tex",
    });
    expect(loadProjectComments.mock.calls[1][1]).toEqual({
      docPath: "appendix.tex",
      threadId: "thread-3",
    });

    const project = await scopeReader.read(httpRequest(projectRequest), {
      contextLength: 8_192,
      contextLengthSource: "override",
    });
    await project.readProjectComments({}, { request: projectRequest });
    expect(loadProjectComments.mock.calls[2][1]).toEqual({});
  });

  it("exposes read_project_comments except for selection transforms", async function () {
    const projectModel = model();
    const selectionModel = model();
    const options = {
      provider: "fixture",
      modelId: "comments-model",
      contextLength: 8_192,
      readProjectFile: vi.fn(),
      readProjectComments: vi.fn(async () => ({ threads: [] })),
      now: () => "2026-08-14T00:00:00.000Z",
      createId: () => "event-comments-0001",
    };

    await settle(
      new AiSdkAgentGateway({ model: projectModel, ...options }).stream(
        projectRequest,
      ),
    );
    await settle(
      new AiSdkAgentGateway({ model: selectionModel, ...options }).stream(
        selectionTransformRequest(),
      ),
    );

    expect(
      projectModel.doStreamCalls[0].tools.map(({ name }) => name),
    ).toContain("read_project_comments");
    expect(
      selectionModel.doStreamCalls[0].tools.map(({ name }) => name),
    ).not.toContain("read_project_comments");
    expect(projectModel.doStreamCalls[0].prompt[0].content).toContain(
      "Use read_project_comments when the request is about the comments already on the manuscript",
    );
  });

  // The completion log folds undeclared tool names into "unknown", so a tool
  // missing from that allowlist becomes invisible in operations.
  it("logs a comment read under its own tool name", async function () {
    const info = vi.spyOn(logger, "info").mockImplementation(() => {});
    try {
      let step = 0;
      const toolCallingModel = new MockLanguageModelV3({
        provider: "fixture",
        modelId: "comments-model",
        doStream: async () => {
          const chunks =
            step++ === 0
              ? [
                  {
                    type: "tool-call",
                    toolCallId: "read-comments-call-0001",
                    toolName: "read_project_comments",
                    input: JSON.stringify({}),
                  },
                  { ...finish(), finishReason: { unified: "tool-calls", raw: "tool-calls" } },
                ]
              : [finish()];
          return {
            stream: simulateReadableStream({
              chunks,
              initialDelayInMs: null,
              chunkDelayInMs: null,
            }),
          };
        },
      });

      await settle(
        new AiSdkAgentGateway({
          model: toolCallingModel,
          provider: "fixture",
          modelId: "comments-model",
          contextLength: 8_192,
          readProjectFile: vi.fn(),
          readProjectComments: vi.fn(async () => ({ threads: [] })),
          now: () => "2026-08-14T00:00:00.000Z",
          createId: () => "event-comments-0001",
        }).stream(projectRequest),
      );

      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({
          toolCallCounts: expect.objectContaining({
            read_project_comments: 1,
          }),
        }),
        AI_REVIEWER_COMPLETION_LOG_MESSAGE,
      );
    } finally {
      info.mockRestore();
    }
  });
});
