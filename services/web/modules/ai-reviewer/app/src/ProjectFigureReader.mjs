// @ts-check

import { Buffer } from "node:buffer";

import { z } from "zod";

import { ProjectRelativePathSchema } from "../../shared/contracts.mjs";
import { AgentGatewayAbortError, AgentGatewayError } from "./AgentGateway.mjs";

export const PROJECT_FIGURE_MAX_BYTES = 4 * 1024 * 1024;
export const PROJECT_FIGURE_MODEL_INPUT_TOKENS = 1_600;

const ReadProjectFigureArgumentsSchema = z
  .object({ path: ProjectRelativePathSchema })
  .strict();

function figureError(message, code) {
  return new AgentGatewayError(message, {
    code,
    category: "configuration",
    retryable: false,
  });
}

function mediaTypeForPath(path) {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith(".png")) return "image/png";
  if (lowerPath.endsWith(".jpg") || lowerPath.endsWith(".jpeg")) {
    return "image/jpeg";
  }
  throw figureError(
    "The requested project figure must be a PNG or JPEG file.",
    "AI_PROJECT_FIGURE_TYPE_UNSUPPORTED",
  );
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof AgentGatewayError
      ? signal.reason
      : new AgentGatewayAbortError();
  }
}

function stopStream(stream) {
  try {
    if (typeof stream?.destroy === "function") {
      stream.destroy();
    } else if (typeof stream?.cancel === "function") {
      Promise.resolve(stream.cancel()).catch(() => {});
    }
  } catch {
    // Cleanup cannot replace the bounded read result.
  }
}

/**
 * @param {{
 *   getAllFiles: (projectId: string) => unknown | Promise<unknown>,
 *   requestBlobWithProjectId: (
 *     projectId: string,
 *     hash: unknown,
 *     method: "GET",
 *   ) => unknown | Promise<unknown>,
 * }} dependencies
 */
export function createProjectFigureReader({
  getAllFiles,
  requestBlobWithProjectId,
}) {
  if (
    typeof getAllFiles !== "function" ||
    typeof requestBlobWithProjectId !== "function"
  ) {
    throw new TypeError("Project figure file-store dependencies are required.");
  }

  return async function readProjectFigure(projectId, input, { signal } = {}) {
    throwIfAborted(signal);
    const parsed = ReadProjectFigureArgumentsSchema.safeParse(input);
    if (!parsed.success || typeof projectId !== "string" || projectId === "") {
      throw figureError(
        "The requested project figure path is invalid.",
        "AI_PROJECT_FIGURE_NOT_FOUND",
      );
    }
    const { path } = parsed.data;
    const mediaType = mediaTypeForPath(path);

    let files;
    try {
      files = await getAllFiles(projectId);
    } catch {
      throwIfAborted(signal);
      throw figureError(
        "The requested project figure could not be found.",
        "AI_PROJECT_FIGURE_NOT_FOUND",
      );
    }
    throwIfAborted(signal);
    const fileRef = files?.[path] ?? files?.[`/${path}`];
    if (fileRef?.hash == null) {
      throw figureError(
        "The requested project figure could not be found.",
        "AI_PROJECT_FIGURE_NOT_FOUND",
      );
    }

    let blob;
    try {
      blob = await requestBlobWithProjectId(projectId, fileRef.hash, "GET");
    } catch {
      throwIfAborted(signal);
      throw figureError(
        "The requested project figure could not be read.",
        "AI_PROJECT_FIGURE_NOT_FOUND",
      );
    }
    throwIfAborted(signal);
    const { stream, contentLength } = /** @type {any} */ (blob);
    if (
      Number.isFinite(contentLength) &&
      contentLength > PROJECT_FIGURE_MAX_BYTES
    ) {
      stopStream(stream);
      throw figureError(
        "The requested project figure exceeds the 4 MB size limit.",
        "AI_PROJECT_FIGURE_TOO_LARGE",
      );
    }
    if (stream == null || typeof stream[Symbol.asyncIterator] !== "function") {
      throw figureError(
        "The requested project figure could not be read.",
        "AI_PROJECT_FIGURE_NOT_FOUND",
      );
    }

    const chunks = [];
    let bytes = 0;
    try {
      for await (const chunk of stream) {
        throwIfAborted(signal);
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > PROJECT_FIGURE_MAX_BYTES) {
          stopStream(stream);
          throw figureError(
            "The requested project figure exceeds the 4 MB size limit.",
            "AI_PROJECT_FIGURE_TOO_LARGE",
          );
        }
        chunks.push(buffer);
      }
    } catch (error) {
      if (error instanceof AgentGatewayError) throw error;
      throwIfAborted(signal);
      throw figureError(
        "The requested project figure could not be read.",
        "AI_PROJECT_FIGURE_NOT_FOUND",
      );
    }

    return Object.freeze({
      path,
      mediaType,
      bytes,
      data: Buffer.concat(chunks, bytes).toString("base64"),
    });
  };
}
