// @ts-check

import { z } from "zod";

import { ProjectRelativePathSchema } from "../../shared/contracts.mjs";
import { AgentGatewayAbortError, AgentGatewayError } from "./AgentGateway.mjs";

export const PROJECT_COMMENTS_MAX_THREADS = 40;
export const PROJECT_COMMENTS_MAX_MESSAGES_PER_THREAD = 12;
export const PROJECT_COMMENTS_MAX_MESSAGE_CHARACTERS = 600;
export const PROJECT_COMMENTS_MAX_QUOTED_TEXT_CHARACTERS = 400;

const ReadProjectCommentsArgumentsSchema = z
  .object({
    docPath: ProjectRelativePathSchema.optional(),
    threadId: z.string().min(1).optional(),
  })
  .strict();

function commentsError() {
  return new AgentGatewayError(
    "The requested project comments are unavailable.",
    {
      code: "AI_PROJECT_CONTENT_NOT_AVAILABLE",
      category: "configuration",
      retryable: false,
    },
  );
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof AgentGatewayError
      ? signal.reason
      : new AgentGatewayAbortError();
  }
}

/** @param {unknown} value */
function idString(value) {
  const id = value?.toString?.();
  return typeof id === "string" && id.length > 0 ? id : null;
}

/** @param {any} user */
function displayName(user) {
  const parts = [user?.first_name, user?.last_name]
    .filter((part) => typeof part === "string" && part.trim().length > 0)
    .map((part) => part.trim());
  return parts.length === 0 ? null : parts.join(" ");
}

/**
 * @param {{
 *   getThreads: (projectId: string) => unknown | Promise<unknown>,
 *   loadProjectDocuments: (
 *     projectId: string,
 *     options: { signal?: AbortSignal },
 *   ) => unknown | Promise<unknown>,
 *   getUsers: (
 *     userIds: Set<unknown>,
 *     projection: Record<string, boolean>,
 *   ) => unknown | Promise<unknown>,
 * }} dependencies
 */
export function createProjectCommentsReader({
  getThreads,
  loadProjectDocuments,
  getUsers,
}) {
  if (
    typeof getThreads !== "function" ||
    typeof loadProjectDocuments !== "function" ||
    typeof getUsers !== "function"
  ) {
    throw new TypeError("Project comment dependencies are required.");
  }

  return async function readProjectComments(projectId, input, { signal } = {}) {
    throwIfAborted(signal);
    const parsed = ReadProjectCommentsArgumentsSchema.safeParse(input);
    if (!parsed.success || typeof projectId !== "string" || projectId === "") {
      throw commentsError();
    }

    let rawThreads;
    let rawDocuments;
    try {
      [rawThreads, rawDocuments] = await Promise.all([
        getThreads(projectId),
        loadProjectDocuments(projectId, { signal }),
      ]);
    } catch {
      throwIfAborted(signal);
      throw commentsError();
    }
    throwIfAborted(signal);
    if (
      rawThreads == null ||
      typeof rawThreads !== "object" ||
      Array.isArray(rawThreads) ||
      rawDocuments == null ||
      typeof rawDocuments !== "object" ||
      Array.isArray(rawDocuments)
    ) {
      throw commentsError();
    }

    const { docPath: docPathFilter, threadId: threadIdFilter } = parsed.data;
    const anchors = new Map();
    for (const [rawDocPath, document] of Object.entries(rawDocuments).sort(
      ([left], [right]) => left.localeCompare(right),
    )) {
      const docPath = rawDocPath.startsWith("/")
        ? rawDocPath.slice(1)
        : rawDocPath;
      if (
        !ProjectRelativePathSchema.safeParse(docPath).success ||
        (docPathFilter != null && docPath !== docPathFilter)
      ) {
        continue;
      }
      const lines = /** @type {any} */ (document)?.lines;
      if (
        !Array.isArray(lines) ||
        lines.some((line) => typeof line !== "string")
      ) {
        throw commentsError();
      }
      const text = lines.join("\n");
      const comments = /** @type {any} */ (document)?.ranges?.comments;
      if (!Array.isArray(comments)) continue;
      for (const comment of comments) {
        const threadId = idString(comment?.op?.t);
        const offset = comment?.op?.p;
        const quotedText = comment?.op?.c;
        if (
          threadId == null ||
          anchors.has(threadId) ||
          (threadIdFilter != null && threadId !== threadIdFilter) ||
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          offset > text.length ||
          typeof quotedText !== "string"
        ) {
          continue;
        }
        anchors.set(threadId, {
          docPath,
          quotedText,
          offset,
          line: text.slice(0, offset).split("\n").length,
        });
      }
    }

    let truncated = false;
    let candidates = Object.entries(rawThreads)
      .flatMap(([rawThreadId, thread]) => {
        const threadId = idString(rawThreadId);
        const anchor = threadId == null ? null : anchors.get(threadId);
        if (
          threadId == null ||
          anchor == null ||
          /** @type {any} */ (thread)?.resolved === true ||
          (threadIdFilter != null && threadId !== threadIdFilter)
        ) {
          return [];
        }
        return [{ threadId, thread: /** @type {any} */ (thread), ...anchor }];
      })
      .sort(
        (left, right) =>
          left.docPath.localeCompare(right.docPath) ||
          left.offset - right.offset ||
          left.threadId.localeCompare(right.threadId),
      );
    if (candidates.length > PROJECT_COMMENTS_MAX_THREADS) {
      candidates = candidates.slice(0, PROJECT_COMMENTS_MAX_THREADS);
      truncated = true;
    }

    const bounded = candidates.map((candidate) => {
      const allMessages = Array.isArray(candidate.thread.messages)
        ? candidate.thread.messages
        : [];
      let messages = allMessages;
      if (messages.length > PROJECT_COMMENTS_MAX_MESSAGES_PER_THREAD) {
        messages = [
          messages[0],
          ...messages.slice(-(PROJECT_COMMENTS_MAX_MESSAGES_PER_THREAD - 1)),
        ];
        truncated = true;
      }
      const quotedText = candidate.quotedText.slice(
        0,
        PROJECT_COMMENTS_MAX_QUOTED_TEXT_CHARACTERS,
      );
      truncated ||=
        quotedText.length !== candidate.quotedText.length ||
        messages.some(
          (message) =>
            typeof message?.content === "string" &&
            message.content.length > PROJECT_COMMENTS_MAX_MESSAGE_CHARACTERS,
        );
      return {
        ...candidate,
        quotedText,
        messages: messages.map((message) => ({
          userId: idString(message?.user_id),
          content:
            typeof message?.content === "string"
              ? message.content.slice(
                  0,
                  PROJECT_COMMENTS_MAX_MESSAGE_CHARACTERS,
                )
              : "",
        })),
      };
    });

    const userIds = new Set(
      bounded.flatMap(({ messages }) =>
        messages.flatMap(({ userId }) => (userId == null ? [] : [userId])),
      ),
    );
    let users;
    try {
      users = await getUsers(userIds, {
        _id: true,
        first_name: true,
        last_name: true,
      });
    } catch {
      throwIfAborted(signal);
      throw commentsError();
    }
    throwIfAborted(signal);
    if (!Array.isArray(users)) throw commentsError();
    const namesById = new Map(
      users.flatMap((user) => {
        const userId = idString(user?._id);
        const author = displayName(user);
        return userId == null || author == null ? [] : [[userId, author]];
      }),
    );

    const threads = bounded.map(
      ({ threadId, docPath, quotedText, line, messages }) =>
        Object.freeze({
          threadId,
          docPath,
          quotedText,
          line,
          messages: Object.freeze(
            messages.map(({ userId, content }) => {
              const author = userId == null ? null : namesById.get(userId);
              return Object.freeze({
                ...(author == null ? {} : { author }),
                content,
              });
            }),
          ),
        }),
    );
    return Object.freeze({
      threads: Object.freeze(threads),
      ...(truncated ? { truncated: true } : {}),
    });
  };
}
