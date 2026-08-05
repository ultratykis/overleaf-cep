/* eslint-disable @overleaf/require-script-runner */

/**
 * Wait for every concurrent operation before surfacing the first rejection.
 * Cleanup may safely remove shared temporary state after this promise settles.
 *
 * @template T
 * @param {Iterable<PromiseLike<T> | T>} operations
 * @returns {Promise<T[]>}
 */
export async function allSettledOrThrow(operations) {
  const outcomes = await Promise.allSettled(operations);
  const rejection = outcomes.find((outcome) => outcome.status === "rejected");
  if (rejection != null && rejection.status === "rejected") {
    throw rejection.reason;
  }
  return outcomes.map((outcome) => {
    if (outcome.status !== "fulfilled") {
      throw new Error("Unreachable rejected outcome.");
    }
    return outcome.value;
  });
}
