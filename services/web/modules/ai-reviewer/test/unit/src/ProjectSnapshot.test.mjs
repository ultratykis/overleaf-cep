import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { AgentGatewayError } from "../../../app/src/AgentGateway.mjs";
import { modelInputCharacterBudget } from "../../../app/src/ModelContextBudget.mjs";
import { createProjectSnapshot } from "../../../app/src/ProjectSnapshot.mjs";

const projectId = "project-snapshot-0001";
const contextLength = 8_192;
const mainText = [
  String.raw`\documentclass{article}`,
  String.raw`\input{sections/method}`,
  String.raw`See \cref{sec:method} and \cite{doe2024}.`,
  String.raw`\bibliography{refs}`,
  "PRIVATE_MANUSCRIPT_SENTINEL",
].join("\n");
const methodText = String.raw`\section{Method}\label{sec:method}`;
const bibliographyText =
  "@article{doe2024,\n  title = {Synthetic reference}\n}";

function documents() {
  return {
    "/main.tex": {
      _id: "document-main",
      version: 7,
      lines: mainText.split("\n"),
    },
    "/sections/method.tex": {
      _id: "document-method",
      version: 3,
      lines: [methodText],
    },
    "/refs.bib": {
      _id: "document-bibliography",
      version: 2,
      lines: bibliographyText.split("\n"),
    },
  };
}

function request() {
  return {
    requestId: "request-snapshot-0001",
    projectId,
    action: "review",
    instruction: "Review the synthetic project.",
    skill: null,
    scope: { kind: "project" },
  };
}

function createSnapshot(
  input = documents(),
  configuredContextLength = contextLength,
) {
  return createProjectSnapshot(projectId, input, {
    contextLength: configuredContextLength,
    request: request(),
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function captureError(work) {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject.");
}

describe("AI reviewer project snapshot", function () {
  it("builds a metadata-only manifest and expected LaTeX relationships", function () {
    const snapshot = createSnapshot();

    expect(snapshot.manifest).toEqual([
      {
        documentId: "document-main",
        path: "main.tex",
        revision: 7,
        textHash: sha256(mainText),
        textLength: mainText.length,
      },
      {
        documentId: "document-bibliography",
        path: "refs.bib",
        revision: 2,
        textHash: sha256(bibliographyText),
        textLength: bibliographyText.length,
      },
      {
        documentId: "document-method",
        path: "sections/method.tex",
        revision: 3,
        textHash: sha256(methodText),
        textLength: methodText.length,
      },
    ]);
    expect(snapshot.context.files).toEqual([
      { path: "main.tex", textLength: mainText.length },
      { path: "refs.bib", textLength: bibliographyText.length },
      { path: "sections/method.tex", textLength: methodText.length },
    ]);
    expect(
      snapshot.context.relationships.map(
        ({ kind, source, target }) => `${kind}:${source.path}:${target}`,
      ),
    ).toEqual([
      "input:main.tex:sections/method.tex",
      "ref:main.tex:sec:method",
      "cite:main.tex:doe2024",
      "bibliography:main.tex:refs.bib",
      "section:sections/method.tex:Method",
      "label:sections/method.tex:sec:method",
    ]);
    expect(snapshot.context.summary).toEqual({
      fileCount: 3,
      characterCount:
        mainText.length + methodText.length + bibliographyText.length,
      relationshipCount: 6,
      relationshipExclusionCount: 0,
      relationshipsTruncated: false,
    });
    expect(JSON.stringify(snapshot.context)).not.toContain(
      "PRIVATE_MANUSCRIPT_SENTINEL",
    );
  });

  it("supports bounded project-relative reads", async function () {
    const snapshot = createSnapshot();
    const matchFrom = mainText.indexOf("PRIVATE_MANUSCRIPT_SENTINEL");

    expect(
      await snapshot.readProjectFile(
        {
          path: "main.tex",
          range: { from: matchFrom, to: mainText.length },
        },
        { request: request() },
      ),
    ).toEqual({
      path: "main.tex",
      range: { from: matchFrom, to: mainText.length },
      revision: 7,
      textHash: sha256(mainText),
      text: "PRIVATE_MANUSCRIPT_SENTINEL",
    });
  });

  it("reports duplicate bibliography keys and unresolved citations", function () {
    const auditMainText = [
      String.raw`\documentclass{article}`,
      String.raw`\cite{duplicate,resolved,missing}`,
      String.raw`\bibliography{refs}`,
    ].join("\n");
    const auditBibliographyText = [
      "@article{duplicate, author={A}, title={PRIVATE_BIBLIOGRAPHY_SENTINEL}, journal={J}, year={2024}}",
      "@article{duplicate, author={B}, title={Other synthetic reference}, journal={J}, year={2025}}",
      "@article{resolved, author={C}, title={Resolved synthetic reference}, journal={J}, year={2026}}",
      "@article{incomplete, title={Missing metadata}}",
    ].join("\n");
    const snapshot = createSnapshot({
      "/main.tex": {
        _id: "document-audit-main",
        version: 1,
        lines: auditMainText.split("\n"),
      },
      "/refs.bib": {
        _id: "document-audit-bibliography",
        version: 1,
        lines: auditBibliographyText.split("\n"),
      },
    });

    expect(snapshot.context.citationAudit).toMatchObject({
      incomplete: false,
      truncated: false,
      issues: [
        {
          kind: "duplicate-key",
          key: "duplicate",
          proposal:
            'Rename one duplicate "duplicate" entry and update its citations.',
        },
        {
          kind: "missing-required-fields",
          key: "incomplete",
          entryType: "article",
          missingFields: ["author", "journal or journaltitle", "year or date"],
          proposal:
            'Add missing BibTeX fields to "incomplete": author, journal or journaltitle, year or date.',
        },
        {
          kind: "unresolved-citation",
          key: "missing",
          proposal:
            'Add a bibliography entry for "missing" or replace \\cite{missing}.',
        },
      ],
    });
    const [duplicateIssue, missingFieldsIssue, unresolvedIssue] =
      snapshot.context.citationAudit.issues;
    expect(
      duplicateIssue.evidence.map(({ path, range }) => ({
        path,
        text: auditBibliographyText.slice(range.from, range.to),
      })),
    ).toEqual([
      {
        path: "refs.bib",
        text: expect.stringContaining("@article{duplicate"),
      },
      {
        path: "refs.bib",
        text: expect.stringContaining("@article{duplicate"),
      },
    ]);
    expect(
      missingFieldsIssue.evidence.map(({ path, range }) => ({
        path,
        text: auditBibliographyText.slice(range.from, range.to),
      })),
    ).toEqual([
      {
        path: "refs.bib",
        text: expect.stringContaining("@article{incomplete"),
      },
    ]);
    expect(
      unresolvedIssue.evidence.map(({ path, range }) => ({
        path,
        text: auditMainText.slice(range.from, range.to),
      })),
    ).toEqual([
      {
        path: "main.tex",
        text: String.raw`\cite{duplicate,resolved,missing}`,
      },
    ]);
    expect(JSON.stringify(snapshot.context)).not.toContain(
      "PRIVATE_BIBLIOGRAPHY_SENTINEL",
    );

    const withoutBibliography = createSnapshot({
      "/main.tex": {
        _id: "document-audit-main",
        version: 1,
        lines: auditMainText.split("\n"),
      },
    });
    expect(withoutBibliography.context.citationAudit).toEqual({
      incomplete: true,
      truncated: false,
      issues: [],
    });
  });

  it("rejects unknown reads and evidence outside the captured snapshot", async function () {
    const snapshot = createSnapshot();

    expect(
      await captureError(
        snapshot.readProjectFile(
          { path: "../main.tex", range: { from: 0, to: 1 } },
          { request: request() },
        ),
      ),
    ).toBeInstanceOf(AgentGatewayError);
    expect(
      await captureError(
        snapshot.readProjectFile(
          {
            path: "main.tex",
            range: { from: 0, to: mainText.length + 1 },
          },
          { request: request() },
        ),
      ),
    ).toBeInstanceOf(AgentGatewayError);
    expect(() =>
      snapshot.validateEvidence(
        [
          {
            path: "main.tex",
            range: { from: 0, to: 4 },
            revision: 8,
            textHash: sha256(mainText),
          },
        ],
        { request: request() },
      ),
    ).toThrow(AgentGatewayError);
    expect(() =>
      snapshot.validateEvidence([{ path: "main.tex", revision: 7 }], {
        request: request(),
      }),
    ).toThrow(AgentGatewayError);
  });

  it("caps relationship metadata before it reaches the model context", function () {
    const lines = Array.from(
      { length: 150 },
      (_, index) => String.raw`\section{Section ${index}}`,
    );
    const snapshot = createSnapshot({
      "/main.tex": {
        _id: "document-many-sections",
        version: 1,
        lines,
      },
    });

    expect(snapshot.context.relationships.length).toBeGreaterThan(0);
    expect(snapshot.context.relationships.length).toBeLessThan(100);
    expect(snapshot.context.summary.relationshipsTruncated).toBe(true);
    expect(
      JSON.stringify({ request: request(), project: snapshot.context }).length,
    ).toBeLessThanOrEqual(modelInputCharacterBudget(contextLength));
  });

  it("derives a smaller model-facing read budget from a smaller context length", async function () {
    const text = "x".repeat(3_000);
    const input = {
      "/main.tex": {
        _id: "document-context-budget",
        version: 1,
        lines: [text],
      },
    };
    const small = createSnapshot(input, 2_048);
    const large = createSnapshot(input, 8_192);
    const read = {
      path: "main.tex",
      range: { from: 0, to: 1_000 },
    };

    expect(
      await captureError(small.readProjectFile(read, { request: request() })),
    ).toBeInstanceOf(AgentGatewayError);
    expect(
      await large.readProjectFile(read, { request: request() }),
    ).toMatchObject({
      path: "main.tex",
      range: read.range,
      text: "x".repeat(1_000),
    });
  });

  it("applies the model-facing budget across accumulated file reads", async function () {
    const snapshot = createSnapshot(
      {
        "/main.tex": {
          _id: "document-accumulated-budget",
          version: 1,
          lines: ["x".repeat(3_000)],
        },
      },
      4_096,
    );
    const read = {
      path: "main.tex",
      range: { from: 0, to: 700 },
    };

    expect(
      await snapshot.readProjectFile(read, { request: request() }),
    ).toMatchObject({ text: "x".repeat(700) });
    expect(
      await captureError(
        snapshot.readProjectFile(read, { request: request() }),
      ),
    ).toBeInstanceOf(AgentGatewayError);
  });
});
