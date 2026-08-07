#!/usr/bin/env node

import assert from "node:assert/strict";
import Fs from "node:fs";
import Os from "node:os";
import Path from "node:path";

import {
  assertExternalAgentEditMatchesDocument,
  collectExternalAgentWorkspaceEdits,
  createExternalAgentHistorySnapshot,
  deriveExternalAgentTextEdits,
  materializeExternalAgentWorkspace,
} from "../app/src/ExternalAgentWorkspace.mjs";

const original = [
  String.raw`\section{Introduction}`,
  "The construction industry is essential to modern society, yet this critical sector is currently grappling with persistent, structural labor shortages that constrain productivity and make reliable project delivery increasingly difficult.",
  "A second paragraph remains unchanged.",
].join("\n");
const replacement = [
  String.raw`\section{Introduction}`,
  "The construction industry is essential to modern society, yet the sector faces persistent structural labor shortages that constrain productivity and make reliable project delivery increasingly difficult.",
  "A second paragraph remains unchanged.",
].join("\n");

const temporaryRoot = await Fs.promises.mkdtemp(
  Path.join(Os.tmpdir(), "ai-reviewer-non-git-probe-"),
);
try {
  const snapshot = createExternalAgentHistorySnapshot({
    projectId: "project-external-agent-probe",
    historyVersion: 1_234,
    rawSnapshot: {
      files: {
        "sections/01_intro.tex": { content: original },
      },
      projectVersion: "12.4",
      v2DocVersions: {
        "document-introduction": {
          pathname: "sections/01_intro.tex",
          v: 548,
        },
      },
      timestamp: "2026-08-07T00:00:00.000Z",
    },
  });
  const workspace = await materializeExternalAgentWorkspace(
    temporaryRoot,
    snapshot,
  );
  const gitDirectory = Path.join(workspace.workDirectory, ".git");
  await assert.rejects(Fs.promises.access(gitDirectory));
  await Fs.promises.writeFile(
    Path.join(workspace.workDirectory, "sections/01_intro.tex"),
    replacement,
  );

  const result = await collectExternalAgentWorkspaceEdits(workspace);
  assert.equal(result.historyVersion, 1_234);
  assert.equal(result.edits.length, 1);
  const edit = result.edits[0];
  assert.equal(original.slice(edit.range.from, edit.range.to), edit.original);
  assert.equal(
    original.slice(0, edit.range.from) +
      edit.replacement +
      original.slice(edit.range.to),
    replacement,
  );
  assert.equal(
    assertExternalAgentEditMatchesDocument(edit, {
      documentId: "document-introduction",
      path: "sections/01_intro.tex",
      revision: 549,
      text: original,
    }),
    edit,
  );
  assert.throws(
    () =>
      assertExternalAgentEditMatchesDocument(edit, {
        documentId: "document-introduction",
        path: "sections/01_intro.tex",
        revision: 550,
        text: `${original}\nconcurrent edit`,
      }),
    { code: "AI_EXTERNAL_WORKSPACE_STALE" },
  );

  assert.deepEqual(
    deriveExternalAgentTextEdits(
      "😀 alpha stays\nsecond line\nthird value",
      "😀 beta stays\nsecond line\nthird result",
    ),
    [
      {
        range: { from: 3, to: 7 },
        original: "alph",
        replacement: "bet",
      },
      {
        range: { from: 33, to: 38 },
        original: "value",
        replacement: "result",
      },
    ],
  );
  assert.deepEqual(deriveExternalAgentTextEdits("abc", "aXbc"), [
    {
      range: { from: 1, to: 1 },
      original: "",
      replacement: "X",
    },
  ]);
  assert.deepEqual(deriveExternalAgentTextEdits("abc", "ac"), [
    {
      range: { from: 1, to: 2 },
      original: "b",
      replacement: "",
    },
  ]);

  const unsupportedWorkspace = await materializeExternalAgentWorkspace(
    temporaryRoot,
    snapshot,
  );
  await Fs.promises.rename(
    Path.join(unsupportedWorkspace.workDirectory, "sections/01_intro.tex"),
    Path.join(unsupportedWorkspace.workDirectory, "sections/renamed.tex"),
  );
  await assert.rejects(
    collectExternalAgentWorkspaceEdits(unsupportedWorkspace),
    { code: "AI_EXTERNAL_WORKSPACE_UNSUPPORTED_CHANGE" },
  );

  const tamperedWorkspace = await materializeExternalAgentWorkspace(
    temporaryRoot,
    snapshot,
  );
  await Fs.promises.writeFile(
    Path.join(tamperedWorkspace.baseDirectory, "sections/01_intro.tex"),
    "tampered",
  );
  await assert.rejects(collectExternalAgentWorkspaceEdits(tamperedWorkspace), {
    code: "AI_EXTERNAL_WORKSPACE_BASE_MISMATCH",
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        gitRepository: false,
        historyVersion: result.historyVersion,
        documentId: edit.documentId,
        path: edit.path,
        baseRevision: edit.baseRevision,
        range: edit.range,
        originalLength: edit.original.length,
        replacementLength: edit.replacement.length,
        reconstructionMatches: true,
        utf16MultiHunkMatches: true,
        insertionAndDeletionMatch: true,
        staleRejected: true,
        unsupportedPathChangeRejected: true,
        baselineTamperRejected: true,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await Fs.promises.rm(temporaryRoot, { recursive: true, force: true });
}
