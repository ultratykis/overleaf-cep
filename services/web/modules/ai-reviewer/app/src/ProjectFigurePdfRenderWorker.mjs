// @ts-check

import { parentPort, workerData } from "node:worker_threads";

// Installed in the web container for PDF and image rendering.
// eslint-disable-next-line import/no-extraneous-dependencies
import { createCanvas } from "@napi-rs/canvas";
// eslint-disable-next-line import/no-extraneous-dependencies
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const PDF_RENDER_SCALE = 2;
const loadingTask = getDocument({
  data: new Uint8Array(workerData.data),
  isEvalSupported: false,
  verbosity: 0,
});
let document;

try {
  document = await loadingTask.promise;
  if (!Number.isSafeInteger(document.numPages) || document.numPages < 1) {
    throw new Error("PDF has no pages.");
  }

  const page = await document.getPage(1);
  const unscaled = page.getViewport({ scale: 1 });
  const unscaledPixels = unscaled.width * unscaled.height;
  if (!Number.isFinite(unscaledPixels) || unscaledPixels <= 0) {
    throw new Error("PDF page dimensions are invalid.");
  }

  const scale = Math.min(
    PDF_RENDER_SCALE,
    Math.sqrt(workerData.maxPixels / unscaledPixels),
  );
  const viewport = page.getViewport({ scale });
  const width = Math.max(1, Math.floor(viewport.width));
  const height = Math.max(1, Math.floor(viewport.height));
  if (width * height > workerData.maxPixels) {
    throw new Error("PDF page exceeds the pixel limit.");
  }

  const canvas = createCanvas(width, height);
  await page.render({
    canvasContext: canvas.getContext("2d"),
    viewport,
  }).promise;
  const output = Uint8Array.from(canvas.toBuffer("image/png"));
  parentPort?.postMessage(output, [output.buffer]);
} finally {
  await document?.destroy();
}
