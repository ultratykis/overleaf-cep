import { createHash, randomUUID } from "node:crypto";
import Path from "node:path";

import { expressify } from "@overleaf/promise-utils";

import Errors from "../../../../app/src/Features/Errors/Errors.js";
import SessionManager from "../../../../app/src/Features/Authentication/SessionManager.mjs";
import UserAuditLogHandler from "../../../../app/src/Features/User/UserAuditLogHandler.mjs";
import LockManager from "../../../../app/src/infrastructure/LockManager.mjs";
import {
  AiReviewerExternalAgentSessionConflictError,
  AiReviewerExternalAgentSessionNotFoundError,
  EXTERNAL_AGENT_PURGE_OPTIONS,
  createExternalAgentSessionStore,
} from "../../../ai-reviewer/app/src/ExternalAgentSessionStore.mjs";
import { purgeExternalAgentSession } from "../../../ai-reviewer/app/src/ExternalAgentSessionPurge.mjs";
import { ExternalAgentRunnerClient } from "../../../ai-reviewer/app/src/ExternalAgentRunnerService.mjs";

const PLAN_KEY = "aiReviewerHistoryPurgePlan";
const PLAN_LIFETIME_MS = 10 * 60 * 1_000;
const VIEW = Path.resolve(import.meta.dirname, "../views/ai-reviewer-history");
const OPTIONS = Object.freeze({
  statuses: [
    { value: "resolved", label: "Resolved" },
    {
      value: "purge_failed",
      label: "Purge pending or previously failed",
    },
    { value: "active", label: "Active (extra confirmation required)" },
  ],
  inactivity: [
    { value: "90d", label: "At least 90 days inactive" },
    { value: "180d", label: "At least 180 days inactive" },
    { value: "365d", label: "At least 365 days inactive" },
  ],
  minimumSize: [
    { value: "any", label: "Any size" },
    { value: "10mib", label: "At least 10 MiB" },
    { value: "100mib", label: "At least 100 MiB" },
    { value: "1gib", label: "At least 1 GiB" },
  ],
});

const configuredDependencies = Object.freeze({
  auditLog: UserAuditLogHandler,
  createNonce: randomUUID,
  now: Date.now,
  operationTimeoutSignalFactory: () => AbortSignal.timeout(10_000),
  purge: purgeExternalAgentSession,
  runWithLock: (nonce, work) =>
    LockManager.promises.runWithLock("ai-reviewer-history-purge", nonce, work),
  runnerClient: new ExternalAgentRunnerClient(),
  sessionStore: createExternalAgentSessionStore(),
});

function invalidRequest() {
  throw new Errors.InvalidError("Invalid AI history purge request.");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function parseCriteria(value) {
  if (
    !hasExactKeys(value, ["status", "inactivity", "minimumSize"]) ||
    !EXTERNAL_AGENT_PURGE_OPTIONS.statuses.includes(value.status) ||
    !EXTERNAL_AGENT_PURGE_OPTIONS.inactivity.includes(value.inactivity) ||
    !EXTERNAL_AGENT_PURGE_OPTIONS.minimumSize.includes(value.minimumSize)
  ) {
    invalidRequest();
  }
  return {
    status: value.status,
    inactivity: value.inactivity,
    minimumSize: value.minimumSize,
  };
}

function parsePlan(value) {
  if (
    !hasExactKeys(value, [
      "criteria",
      "plannedAt",
      "count",
      "bytes",
      "nonce",
    ]) ||
    !Number.isSafeInteger(value.plannedAt) ||
    value.plannedAt < 0 ||
    !Number.isSafeInteger(value.count) ||
    value.count < 0 ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    typeof value.nonce !== "string" ||
    value.nonce.length === 0 ||
    value.nonce.length > 200
  ) {
    invalidRequest();
  }
  return {
    criteria: parseCriteria(value.criteria),
    plannedAt: value.plannedAt,
    count: value.count,
    bytes: value.bytes,
    nonce: value.nonce,
  };
}

function criteriaFromBody(body) {
  if (!hasExactKeys(body, ["_csrf", "status", "inactivity", "minimumSize"])) {
    invalidRequest();
  }
  return parseCriteria({
    status: body.status,
    inactivity: body.inactivity,
    minimumSize: body.minimumSize,
  });
}

function confirmationFromBody(body, plan) {
  if (
    !hasExactKeys(body, ["_csrf", "nonce", "count", "bytes", "confirmation"]) ||
    body.nonce !== plan.nonce ||
    body.count !== String(plan.count) ||
    body.bytes !== String(plan.bytes) ||
    body.confirmation !==
      (plan.criteria.status === "active" ? "PURGE ACTIVE" : "PURGE")
  ) {
    invalidRequest();
  }
}

function purgeLockId(req) {
  if (typeof req.sessionID !== "string" || req.sessionID.length === 0) {
    invalidRequest();
  }
  return createHash("sha256")
    .update(`ai-reviewer-history-purge-plan:${req.sessionID}`)
    .digest("hex");
}

async function saveSession(session) {
  if (typeof session?.save !== "function") invalidRequest();
  await new Promise((resolve, reject) => {
    session.save((error) => (error == null ? resolve() : reject(error)));
  });
}

async function reloadSession(session) {
  if (typeof session?.reload !== "function") invalidRequest();
  await new Promise((resolve, reject) => {
    session.reload((error) => (error == null ? resolve() : reject(error)));
  });
}

async function audit(req, operation, info, dependencies) {
  const adminId = SessionManager.getLoggedInUserId(req.session);
  if (adminId == null) invalidRequest();
  await dependencies.auditLog.promises.addEntry(
    adminId,
    operation,
    adminId,
    req.ip,
    info,
  );
}

async function renderPage(res, dependencies, locals = {}, at) {
  const summaryAt = at ?? dependencies.now();
  const summary = await dependencies.sessionStore.summarizeForPurge({
    at: new Date(summaryAt),
  });
  res.render(VIEW, {
    title: "AI history storage",
    options: OPTIONS,
    summary,
    plan: null,
    result: null,
    ...locals,
  });
}

export async function executePurgeBatch(plan, dependencies) {
  const matched = await dependencies.sessionStore.previewPurge({
    criteria: plan.criteria,
    plannedAt: plan.plannedAt,
  });
  const base = {
    plannedCount: plan.count,
    plannedBytes: plan.bytes,
    matchedCount: matched.count,
    matchedBytes: matched.bytes,
  };
  if (matched.count !== plan.count || matched.bytes !== plan.bytes) {
    return {
      ...base,
      outcome: "stale",
      deletedCount: 0,
      deletedBytes: 0,
      recoveredCount: 0,
      skippedCount: plan.count,
      failedCount: 0,
      remainingCount: matched.count,
      remainingBytes: matched.bytes,
    };
  }

  const candidates = (
    await dependencies.sessionStore.loadPurgeBatch({
      criteria: plan.criteria,
      plannedAt: plan.plannedAt,
    })
  ).slice(0, 10);
  let deletedCount = 0;
  let deletedBytes = 0;
  let recoveredCount = 0;
  let skippedCount = Math.max(
    0,
    Math.min(matched.count, 10) - candidates.length,
  );
  let failedCount = 0;
  const operationSignal = dependencies.operationTimeoutSignalFactory();
  for (const [index, session] of candidates.entries()) {
    if (operationSignal.aborted) {
      skippedCount += candidates.length - index;
      break;
    }
    try {
      if (session.operationClaim?.type === "purge") {
        await dependencies.sessionStore.recoverStalePurgeClaim({
          session,
          plannedAt: plan.plannedAt,
        });
        recoveredCount += 1;
      } else {
        await dependencies.purge({
          session,
          sessionStore: dependencies.sessionStore,
          runnerClient: dependencies.runnerClient,
          signal: operationSignal,
        });
        deletedCount += 1;
        deletedBytes += session.stateBytes;
      }
    } catch (error) {
      if (
        error instanceof AiReviewerExternalAgentSessionConflictError ||
        error instanceof AiReviewerExternalAgentSessionNotFoundError
      ) {
        skippedCount += 1;
      } else {
        failedCount += 1;
      }
    }
  }
  return {
    ...base,
    outcome: "completed",
    deletedCount,
    deletedBytes,
    recoveredCount,
    skippedCount,
    failedCount,
    remainingCount: Math.max(0, matched.count - deletedCount),
    remainingBytes: Math.max(0, matched.bytes - deletedBytes),
  };
}

export async function showAiReviewerHistory(req, res, dependencies) {
  await renderPage(res, dependencies);
}

export async function dryRunAiReviewerHistory(req, res, dependencies) {
  const criteria = criteriaFromBody(req.body);
  const plannedAt = dependencies.now();
  const preview = await dependencies.sessionStore.previewPurge({
    criteria,
    plannedAt,
  });
  const plan = {
    criteria,
    plannedAt,
    count: preview.count,
    bytes: preview.bytes,
    nonce: dependencies.createNonce(),
  };
  req.session[PLAN_KEY] = plan;
  await saveSession(req.session);
  await audit(
    req,
    "ai-reviewer-history-purge-dry-run",
    {
      criteria,
      plannedAt,
      count: plan.count,
      bytes: plan.bytes,
    },
    dependencies,
  );
  await renderPage(res, dependencies, { plan }, plannedAt);
}

export async function purgeAiReviewerHistory(req, res, dependencies) {
  const { plan, startedAt } = await dependencies.runWithLock(
    purgeLockId(req),
    async () => {
      await reloadSession(req.session);
      const plan = parsePlan(req.session?.[PLAN_KEY]);
      confirmationFromBody(req.body, plan);
      const startedAt = dependencies.now();
      if (
        startedAt < plan.plannedAt ||
        startedAt - plan.plannedAt > PLAN_LIFETIME_MS
      ) {
        delete req.session[PLAN_KEY];
        await saveSession(req.session);
        invalidRequest();
      }
      delete req.session[PLAN_KEY];
      await saveSession(req.session);
      return { plan, startedAt };
    },
  );

  await audit(
    req,
    "ai-reviewer-history-purge-execute-start",
    {
      criteria: plan.criteria,
      plannedAt: plan.plannedAt,
      startedAt,
      count: plan.count,
      bytes: plan.bytes,
    },
    dependencies,
  );

  const result = await executePurgeBatch(plan, dependencies);
  const completedAt = dependencies.now();
  await audit(
    req,
    "ai-reviewer-history-purge-execute-complete",
    {
      criteria: plan.criteria,
      plannedAt: plan.plannedAt,
      startedAt,
      completedAt,
      planned: { count: result.plannedCount, bytes: result.plannedBytes },
      matched: { count: result.matchedCount, bytes: result.matchedBytes },
      deleted: { count: result.deletedCount, bytes: result.deletedBytes },
      recoveredCount: result.recoveredCount,
      skippedCount: result.skippedCount,
      failedCount: result.failedCount,
      remaining: { count: result.remainingCount, bytes: result.remainingBytes },
      outcome: result.outcome,
    },
    dependencies,
  );
  if (result.outcome === "stale") res.status(409);
  await renderPage(res, dependencies, { result }, completedAt);
}

export default {
  show: expressify((req, res) =>
    showAiReviewerHistory(req, res, configuredDependencies),
  ),
  dryRun: expressify((req, res) =>
    dryRunAiReviewerHistory(req, res, configuredDependencies),
  ),
  purge: expressify((req, res) =>
    purgeAiReviewerHistory(req, res, configuredDependencies),
  ),
};
