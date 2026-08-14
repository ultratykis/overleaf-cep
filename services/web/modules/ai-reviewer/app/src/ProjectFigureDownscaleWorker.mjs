// @ts-check

import { parentPort, workerData } from "node:worker_threads";

// Installed in the web container for image rendering.
// eslint-disable-next-line import/no-extraneous-dependencies
import { createCanvas, loadImage } from "@napi-rs/canvas";

const input = Buffer.from(workerData.data);
const image = await loadImage(input);
let scale = Math.min(0.9, Math.sqrt(workerData.maxBytes / input.length) * 0.9);
let output = input;

for (let attempt = 0; attempt < 10; attempt += 1) {
  const width = Math.max(1, Math.floor(image.width * scale));
  const height = Math.max(1, Math.floor(image.height * scale));
  const canvas = createCanvas(width, height);
  canvas.getContext("2d").drawImage(image, 0, 0, width, height);
  output =
    workerData.mediaType === "image/jpeg"
      ? canvas.toBuffer("image/jpeg", 0.82)
      : canvas.toBuffer("image/png");
  if (output.length <= workerData.maxBytes || (width === 1 && height === 1)) {
    break;
  }
  scale *= Math.min(0.85, Math.sqrt(workerData.maxBytes / output.length) * 0.9);
}

const data = Uint8Array.from(output);
parentPort?.postMessage(data, [data.buffer]);
