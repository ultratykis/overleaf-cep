import Fs from "node:fs";
import Os from "node:os";
import Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertExternalAgentEditMatchesDocument,
  collectExternalAgentWorkspaceEdits,
  createExternalAgentHistorySnapshot,
  deriveExternalAgentTextEdits,
  ExternalAgentWorkspaceError,
  materializeExternalAgentWorkspace,
} from "../../../app/src/ExternalAgentWorkspace.mjs";

const temporaryRoots = [];

async function temporaryRoot() {
  const root = await Fs.promises.mkdtemp(
    Path.join(Os.tmpdir(), "ai-reviewer-workspace-test-"),
  );
  temporaryRoots.push(root);
  return root;
}

async function failureOf(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the operation to fail");
}

afterEach(async function () {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      Fs.promises.rm(root, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

function rawHistorySnapshot(files) {
  return {
    files: Object.fromEntries(
      files.map(({ path, text }) => [path, { content: text }]),
    ),
    projectVersion: "12.4",
    v2DocVersions: Object.fromEntries(
      files.map(({ documentId, path, revision }) => [
        documentId,
        { pathname: path, v: revision },
      ]),
    ),
    timestamp: "2026-08-07T00:00:00.000Z",
  };
}

function historySnapshot(files) {
  return createExternalAgentHistorySnapshot({
    projectId: "project-external-agent-0001",
    historyVersion: 1_234,
    rawSnapshot: rawHistorySnapshot(files),
  });
}

describe("AI reviewer non-Git external agent workspace", function () {
  it.each([
    ".git/config",
    ".codex/config.toml",
    ".agents/skills/injected/SKILL.md",
    "AGENTS.md",
    "sections/AGENTS.override.md",
  ])("rejects agent control path %s", function (path) {
    expect(() =>
      historySnapshot([
        {
          documentId: "document-control-file",
          path,
          revision: 1,
          text: "untrusted control text",
        },
      ]),
    ).toThrow(ExternalAgentWorkspaceError);
  });

  it("maps the previous real Codex wording change from a plain directory", async function () {
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
    const snapshot = historySnapshot([
      {
        documentId: "document-introduction",
        path: "sections/01_intro.tex",
        revision: 549,
        text: original,
      },
    ]);
    const workspace = await materializeExternalAgentWorkspace(
      await temporaryRoot(),
      snapshot,
    );

    expect(
      await Fs.promises
        .access(Path.join(workspace.workDirectory, ".git"))
        .then(() => true)
        .catch(() => false),
    ).toBe(false);
    await Fs.promises.writeFile(
      Path.join(workspace.workDirectory, "sections/01_intro.tex"),
      replacement,
    );

    const result = await collectExternalAgentWorkspaceEdits(workspace);

    expect(result.projectId).toBe("project-external-agent-0001");
    expect(result.historyVersion).toBe(1_234);
    expect(result.edits).toHaveLength(1);
    expect(result.edits[0]).toMatchObject({
      documentId: "document-introduction",
      path: "sections/01_intro.tex",
      baseRevision: 549,
    });
    const edit = result.edits[0];
    expect(original.slice(edit.range.from, edit.range.to)).toBe(edit.original);
    expect(
      original.slice(0, edit.range.from) +
        edit.replacement +
        original.slice(edit.range.to),
    ).toBe(replacement);
  });

  it("revalidates serialized input and keeps the baseline outside agent-visible work", async function () {
    const root = await temporaryRoot();
    const workRoot = Path.join(root, "work");
    const baselineRoot = Path.join(root, "baseline");
    await Promise.all([
      Fs.promises.mkdir(workRoot),
      Fs.promises.mkdir(baselineRoot),
    ]);
    const snapshot = structuredClone(
      historySnapshot([
        {
          documentId: "document-main",
          path: "main.tex",
          revision: 7,
          text: "original",
        },
      ]),
    );

    const workspace = await materializeExternalAgentWorkspace(
      workRoot,
      snapshot,
      { baselineRootDirectory: baselineRoot },
    );

    expect(Path.relative(workRoot, workspace.workDirectory)).not.toMatch(
      /^\.\./u,
    );
    expect(Path.relative(workRoot, workspace.baseDirectory)).toMatch(/^\.\./u);
    expect(workspace.baselineRunDirectory).not.toBeNull();

    snapshot.documents[0].path = "../outside.tex";
    expect(
      await failureOf(
        materializeExternalAgentWorkspace(workRoot, snapshot, {
          baselineRootDirectory: baselineRoot,
        }),
      ),
    ).toMatchObject({ code: "AI_EXTERNAL_WORKSPACE_INVALID_SNAPSHOT" });
  });

  it("returns separate exact UTF-16 edits across lines", function () {
    const original = "😀 alpha stays\nsecond line\nthird value";
    const replacement = "😀 beta stays\nsecond line\nthird result";

    const edits = deriveExternalAgentTextEdits(original, replacement);

    expect(edits).toEqual([
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
    ]);
  });

  it("preserves exact insertion and deletion ranges", function () {
    expect(deriveExternalAgentTextEdits("abc", "aXbc")).toEqual([
      {
        range: { from: 1, to: 1 },
        original: "",
        replacement: "X",
      },
    ]);
    expect(deriveExternalAgentTextEdits("abc", "ac")).toEqual([
      {
        range: { from: 1, to: 2 },
        original: "b",
        replacement: "",
      },
    ]);
  });

  it("fails closed when the live document changed after the history checkpoint", async function () {
    const snapshot = historySnapshot([
      {
        documentId: "document-main",
        path: "main.tex",
        revision: 7,
        text: "original text",
      },
    ]);
    const workspace = await materializeExternalAgentWorkspace(
      await temporaryRoot(),
      snapshot,
    );
    await Fs.promises.writeFile(
      Path.join(workspace.workDirectory, "main.tex"),
      "improved text",
    );
    const [edit] = (await collectExternalAgentWorkspaceEdits(workspace)).edits;

    expect(() =>
      assertExternalAgentEditMatchesDocument(edit, {
        documentId: "document-main",
        path: "main.tex",
        revision: 8,
        text: "collaborator text",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "AI_EXTERNAL_WORKSPACE_STALE" }),
    );
  });

  it("rejects an incomplete history document mapping", function () {
    expect(() =>
      createExternalAgentHistorySnapshot({
        projectId: "project-external-agent-0001",
        historyVersion: 1,
        rawSnapshot: {
          files: {
            "main.tex": { content: "mapped" },
            "unmapped.tex": { content: "not represented in v2DocVersions" },
          },
          v2DocVersions: {
            "document-main": { pathname: "main.tex", v: 2 },
          },
        },
      }),
    ).toThrowError(ExternalAgentWorkspaceError);
  });

  it("rejects additions, deletions, and renames instead of widening authority", async function () {
    const snapshot = historySnapshot([
      {
        documentId: "document-main",
        path: "main.tex",
        revision: 7,
        text: "original",
      },
    ]);
    const workspace = await materializeExternalAgentWorkspace(
      await temporaryRoot(),
      snapshot,
    );
    await Fs.promises.rename(
      Path.join(workspace.workDirectory, "main.tex"),
      Path.join(workspace.workDirectory, "renamed.tex"),
    );

    expect(
      await failureOf(collectExternalAgentWorkspaceEdits(workspace)),
    ).toMatchObject({
      code: "AI_EXTERNAL_WORKSPACE_UNSUPPORTED_CHANGE",
      details: {
        unsupportedPaths: ["renamed.tex"],
        missingPaths: ["main.tex"],
      },
    });
  });

  it("detects a changed runner-owned baseline", async function () {
    const snapshot = historySnapshot([
      {
        documentId: "document-main",
        path: "main.tex",
        revision: 7,
        text: "original",
      },
    ]);
    const workspace = await materializeExternalAgentWorkspace(
      await temporaryRoot(),
      snapshot,
    );
    await Fs.promises.writeFile(
      Path.join(workspace.baseDirectory, "main.tex"),
      "tampered",
    );

    expect(
      await failureOf(collectExternalAgentWorkspaceEdits(workspace)),
    ).toMatchObject({
      code: "AI_EXTERNAL_WORKSPACE_BASE_MISMATCH",
    });
  });
});
