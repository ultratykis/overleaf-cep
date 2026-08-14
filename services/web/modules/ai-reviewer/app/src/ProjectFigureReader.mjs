// @ts-check

import { Buffer } from "node:buffer";
import { Worker } from "node:worker_threads";

import { z } from "zod";

import { ProjectRelativePathSchema } from "../../shared/contracts.mjs";
import { AgentGatewayAbortError, AgentGatewayError } from "./AgentGateway.mjs";

export const PROJECT_FIGURE_MAX_BYTES = 5 * 1024 * 1024;
export const PROJECT_FIGURE_DOWNSCALE_MAX_INPUT_BYTES = 25 * 1024 * 1024;
export const PROJECT_FIGURE_DOWNSCALE_MAX_PIXELS = 40_000_000;
export const PROJECT_FIGURE_DOWNSCALE_TIMEOUT_MILLISECONDS = 5_000;
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

function figureTooLarge() {
  return figureError(
    "The requested project figure exceeds the 5 MB size limit.",
    "AI_PROJECT_FIGURE_TOO_LARGE",
  );
}

function figureConversionFailed() {
  return figureError(
    "The requested project figure could not be converted within the image limits.",
    "AI_PROJECT_FIGURE_CONVERSION_FAILED",
  );
}

function figureConversionTimedOut() {
  return figureError(
    "The requested project figure conversion timed out.",
    "AI_PROJECT_FIGURE_CONVERSION_TIMEOUT",
  );
}

/** @param {Buffer} data @param {string} mediaType */
function imageDimensions(data, mediaType) {
  if (mediaType === "image/png") {
    if (
      data.length < 24 ||
      data.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      data.subarray(12, 16).toString("ascii") !== "IHDR"
    ) {
      return null;
    }
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
    return null;
  }
  let offset = 2;
  while (offset + 4 <= data.length) {
    while (offset < data.length && data[offset] === 0xff) offset += 1;
    if (offset >= data.length) return null;
    const marker = data[offset];
    offset += 1;
    if (marker === 0xd9 || marker === 0xda) return null;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > data.length) return null;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) return null;
    if (
      ((marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf)) &&
      length >= 7
    ) {
      return {
        width: data.readUInt16BE(offset + 5),
        height: data.readUInt16BE(offset + 3),
      };
    }
    offset += length;
  }
  return null;
}

/**
 * @param {Buffer} data
 * @param {{ mediaType: string, maxBytes: number, signal: AbortSignal }} options
 */
function downscaleFigureWithCanvas(data, { mediaType, maxBytes, signal }) {
  return new Promise((resolve, reject) => {
    const transferred = Uint8Array.from(data);
    const worker = new Worker(
      new URL("./ProjectFigureDownscaleWorker.mjs", import.meta.url),
      {
        workerData: { data: transferred.buffer, mediaType, maxBytes },
        transferList: [transferred.buffer],
      },
    );
    let settled = false;
    const finish = (work) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      work();
    };
    const onAbort = () => {
      finish(() => {
        void worker.terminate();
        reject(signal.reason);
      });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (output) =>
      finish(() => resolve(Buffer.from(output))),
    );
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) => {
      if (code !== 0) finish(() => reject(new Error("Figure worker exited.")));
    });
    if (signal.aborted) onAbort();
  });
}

/**
 * @param {Buffer} data
 * @param {string} mediaType
 * @param {AbortSignal | undefined} signal
 * @param {(data: Buffer, options: { mediaType: string, maxBytes: number, signal: AbortSignal }) => unknown | Promise<unknown>} downscaleFigure
 * @param {number} timeoutMilliseconds
 */
async function downscaleFigureData(
  data,
  mediaType,
  signal,
  downscaleFigure,
  timeoutMilliseconds,
) {
  const dimensions = imageDimensions(data, mediaType);
  if (
    dimensions == null ||
    dimensions.width <= 0 ||
    dimensions.height <= 0 ||
    dimensions.width * dimensions.height > PROJECT_FIGURE_DOWNSCALE_MAX_PIXELS
  ) {
    throw figureConversionFailed();
  }

  const timeoutController = new AbortController();
  const timeout = setTimeout(
    () => timeoutController.abort(),
    timeoutMilliseconds,
  );
  const workSignal =
    signal == null
      ? timeoutController.signal
      : AbortSignal.any([signal, timeoutController.signal]);
  let onAborted = () => {};
  const aborted = new Promise((_, reject) => {
    onAborted = () => reject(workSignal.reason);
    workSignal.addEventListener("abort", onAborted, { once: true });
  });
  try {
    const output = await Promise.race([
      Promise.resolve(
        downscaleFigure(data, {
          mediaType,
          maxBytes: PROJECT_FIGURE_MAX_BYTES,
          signal: workSignal,
        }),
      ),
      aborted,
    ]);
    if (!(output instanceof Uint8Array) || output.length === 0) {
      throw figureConversionFailed();
    }
    return Buffer.from(output);
  } catch (error) {
    throwIfAborted(signal);
    if (timeoutController.signal.aborted) {
      throw figureConversionTimedOut();
    }
    if (error instanceof AgentGatewayError) throw error;
    throw figureConversionFailed();
  } finally {
    clearTimeout(timeout);
    workSignal.removeEventListener("abort", onAborted);
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
 *   downscaleFigure?: (data: Buffer, options: { mediaType: string, maxBytes: number, signal: AbortSignal }) => unknown | Promise<unknown>,
 *   downscaleTimeoutMilliseconds?: number,
 * }} dependencies
 */
export function createProjectFigureReader({
  getAllFiles,
  requestBlobWithProjectId,
  downscaleFigure = downscaleFigureWithCanvas,
  downscaleTimeoutMilliseconds = PROJECT_FIGURE_DOWNSCALE_TIMEOUT_MILLISECONDS,
}) {
  if (
    typeof getAllFiles !== "function" ||
    typeof requestBlobWithProjectId !== "function" ||
    typeof downscaleFigure !== "function" ||
    !Number.isSafeInteger(downscaleTimeoutMilliseconds) ||
    downscaleTimeoutMilliseconds <= 0
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
      contentLength > PROJECT_FIGURE_DOWNSCALE_MAX_INPUT_BYTES
    ) {
      stopStream(stream);
      throw figureTooLarge();
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
        if (bytes > PROJECT_FIGURE_DOWNSCALE_MAX_INPUT_BYTES) {
          stopStream(stream);
          throw figureTooLarge();
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

    const original = Buffer.concat(chunks, bytes);
    const data =
      bytes <= PROJECT_FIGURE_MAX_BYTES
        ? original
        : await downscaleFigureData(
            original,
            mediaType,
            signal,
            downscaleFigure,
            downscaleTimeoutMilliseconds,
          );
    if (data.length > PROJECT_FIGURE_MAX_BYTES) {
      throw figureTooLarge();
    }
    return Object.freeze({
      path,
      mediaType,
      bytes: data.length,
      data: data.toString("base64"),
    });
  };
}
