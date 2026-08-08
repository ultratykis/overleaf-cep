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

/**
 * Internal destructive boundary. No user route calls this function.
 *
 * @param {{ session: any, sessionStore: any, runnerClient: any }} input
 */
export async function purgeExternalAgentSession({
  session,
  sessionStore,
  runnerClient,
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
    await runnerClient.purge({
      stateRootKey: claim.stateRootKey,
      threadId: claim.threadId,
    });
    await sessionStore.deleteClaimedPurge({
      ...claimed,
      expectedStatus: claim.status,
      expectedLastActivityAt: claim.lastActivityAt,
      expectedThreadId: claim.threadId,
      stateRootKey: claim.stateRootKey,
    });
  } catch (error) {
    await sessionStore.finalize({ ...claimed, type: "purge" }).catch(() => {});
    throw error;
  }
}
