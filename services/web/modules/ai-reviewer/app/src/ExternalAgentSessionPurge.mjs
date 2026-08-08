// @ts-check

/** @param {any} claim */
function assertPurgeClaim(claim) {
  if (
    claim?.operationClaim?.type !== "purge" ||
    typeof claim.operationClaim.id !== "string" ||
    claim.operationClaim.id.length === 0 ||
    (claim.threadId !== null &&
      (typeof claim.threadId !== "string" || claim.threadId.length === 0)) ||
    typeof claim.stateRootKey !== "string" ||
    claim.stateRootKey.length === 0
  ) {
    throw new TypeError("The external AI reviewer purge claim is invalid.");
  }
}

export class AiReviewerExternalAgentSessionPurgeError extends Error {
  /** @param {unknown} cause */
  constructor(cause) {
    super("The external AI reviewer session purge failed.", { cause });
    this.name = "AiReviewerExternalAgentSessionPurgeError";
  }
}

async function finalizeFailedPurge(sessionStore, claimed) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await sessionStore.finalize({ ...claimed, type: "purge" });
      return;
    } catch (error) {
      if (attempt === 1) throw error;
    }
  }
}

/**
 * Internal destructive boundary. No user route calls this function.
 *
 * @param {{ session: any, sessionStore: any, runnerClient: any, signal?: AbortSignal }} input
 */
export async function purgeExternalAgentSession({
  session,
  sessionStore,
  runnerClient,
  signal,
}) {
  const scope = {
    userId: session?.userId,
    projectId: session?.projectId,
    clientSessionId: session?.clientSessionId,
  };
  const claim = await sessionStore.claim({
    ...scope,
    type: "purge",
    expectedRevision: session?.revision,
    expectedStatus: session?.status,
    expectedLastActivityAt: session?.lastActivityAt,
    expectedThreadId: session?.threadId,
  });
  assertPurgeClaim(claim);
  const claimed = {
    ...scope,
    claimId: claim.operationClaim.id,
    expectedRevision: claim.revision,
  };
  try {
    await runnerClient.purge(
      {
        stateRootKey: claim.stateRootKey,
        threadId: claim.threadId,
      },
      { signal },
    );
    await sessionStore.deleteClaimedPurge({
      ...claimed,
      expectedStatus: claim.status,
      expectedLastActivityAt: claim.lastActivityAt,
      expectedThreadId: claim.threadId,
      stateRootKey: claim.stateRootKey,
    });
  } catch (error) {
    await finalizeFailedPurge(sessionStore, claimed).catch(() => {});
    throw new AiReviewerExternalAgentSessionPurgeError(error);
  }
}
