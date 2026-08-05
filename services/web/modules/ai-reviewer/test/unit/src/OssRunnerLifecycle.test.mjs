import { describe, expect, it } from "vitest";

import { allSettledOrThrow } from "../../../scripts/all-settled-or-throw.mjs";

async function captureError(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject.");
}

describe("AI reviewer: OSS runner lifecycle", function () {
  it("waits for sibling work before surfacing an early rejection", async function () {
    let finishSibling;
    let siblingFinished = false;
    const sibling = new Promise((resolve) => {
      finishSibling = () => {
        siblingFinished = true;
        resolve("publication");
      };
    });
    let rejectionObserved = false;
    const verification = captureError(
      allSettledOrThrow([
        Promise.reject(new Error("Synthetic retrieval failure.")),
        sibling,
      ]),
    ).then((error) => {
      rejectionObserved = true;
      return error;
    });

    await Promise.resolve();
    expect(rejectionObserved).toBe(false);
    expect(siblingFinished).toBe(false);

    finishSibling();
    const error = await verification;

    expect(siblingFinished).toBe(true);
    expect(error).toMatchObject({
      message: "Synthetic retrieval failure.",
    });
  });
});
