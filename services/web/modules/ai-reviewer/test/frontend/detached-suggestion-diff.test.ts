import { Chunk } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
// @ts-expect-error diff-match-patch is vendored without a declaration file.
import DiffMatchPatch from "diff-match-patch";
import { expect } from "chai";
import sinon from "sinon";

import {
  compileSelectedSuggestionHunks,
  DetachedSuggestionDiffError,
  getSuggestionHunkIds,
  mountSuggestionCardDiff,
} from "../../frontend/js/services/detached-suggestion-diff";
import diffFixtureSet from "../fixtures/oss-adoption/diff-fixtures.json";

type DiffFixture = {
  id: string;
  original: string;
  replacement: string;
};

type SuggestionCase = {
  request: Record<string, unknown>;
  suggestion: Record<string, unknown>;
  fullText: string;
  expectedText: string;
  documentLength: number;
};

const baseTextHash = "a".repeat(64);
const fixtures = diffFixtureSet.cases as DiffFixture[];

before(function () {
  window.Range.prototype.getClientRects = () => [] as any as DOMRectList;
});

function createSuggestionCase({
  id,
  original,
  replacement,
  prefix = "",
  suffix = "",
  requestId = `request-${id}`,
  suggestionId = `suggestion-${id}`,
  projectId = "project-0001",
  documentId = "document-0001",
  path = "main.tex",
  baseRevision = 7,
  textHash = baseTextHash,
}: DiffFixture & {
  prefix?: string;
  suffix?: string;
  requestId?: string;
  suggestionId?: string;
  projectId?: string;
  documentId?: string;
  path?: string;
  baseRevision?: number;
  textHash?: string;
}): SuggestionCase {
  const from = prefix.length;
  const to = from + original.length;
  const range = {
    from,
    to,
  };

  return {
    request: {
      requestId,
      projectId,
      action: "rewrite",
      instruction: "Preview the synthetic rewrite.",
      skill: "line-edit",
      scope: {
        kind: "selection",
        documentId,
        path,
        baseRevision,
        baseTextHash: textHash,
        range,
        text: original,
      },
    },
    suggestion: {
      id: suggestionId,
      requestId,
      projectId,
      documentId,
      path,
      baseRevision,
      baseTextHash: textHash,
      range,
      original,
      replacement,
      rationale: "Exercise the detached diff boundary.",
      evidence: [
        {
          path,
          range,
          revision: baseRevision,
          textHash,
        },
      ],
      provider: "fake",
      model: "deterministic-v1",
      skill: "line-edit",
      createdAt: "2026-07-24T00:00:00.000Z",
      status: "unresolved",
    },
    fullText: `${prefix}${original}${suffix}`,
    expectedText: `${prefix}${replacement}${suffix}`,
    documentLength: prefix.length + original.length + suffix.length,
  };
}

async function captureError(operation: () => Promise<unknown>) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject.");
}

function renderedVersions(parent: HTMLElement) {
  const text = parent.querySelector<HTMLElement>(
    ".ai-reviewer-detached-diff-text",
  );
  if (text == null) {
    throw new Error("Expected a rendered suggestion diff.");
  }
  const nodes = Array.from(text.childNodes);
  return {
    original: nodes
      .filter((node) => node.nodeName !== "INS")
      .map((node) => node.textContent)
      .join(""),
    replacement: nodes
      .filter((node) => node.nodeName !== "DEL")
      .map((node) => node.textContent)
      .join(""),
  };
}

describe("AI reviewer: single document detached diff", function () {
  const parents: HTMLElement[] = [];

  function createParent() {
    const parent = document.createElement("section");
    document.body.appendChild(parent);
    parents.push(parent);
    return parent;
  }

  async function planCase(testCase: SuggestionCase) {
    return getSuggestionHunkIds({
      request: testCase.request,
      suggestion: testCase.suggestion,
    });
  }

  afterEach(function () {
    sinon.restore();
    for (const parent of parents.splice(0).reverse()) {
      parent.remove();
    }
  });

  for (const fixture of fixtures) {
    it(`plans and compiles every hunk of the ${fixture.id} fixture`, async function () {
      const testCase = createSuggestionCase(fixture);
      const hunkIds = await planCase(testCase);
      expect(hunkIds).to.have.length.greaterThan(0);
      expect(new Set(hunkIds).size).to.equal(hunkIds.length);
      expect(Object.isFrozen(hunkIds)).to.equal(true);

      const compiled = await compileSelectedSuggestionHunks({
        request: testCase.request,
        suggestion: testCase.suggestion,
        selectedHunkIds: hunkIds,
        documentLength: testCase.documentLength,
      });
      expect(compiled.status).to.equal("ready");
      if (compiled.status !== "ready") {
        throw new Error("Expected selected hunks to compile.");
      }
      const document = EditorState.create({
        doc: testCase.fullText,
      }).doc;
      expect(compiled.changes.apply(document).toString()).to.equal(
        testCase.expectedText,
      );
      expect(testCase.fullText).not.to.equal(testCase.expectedText);
    });
  }

  it("renders one card-integrated unified block in document order", function () {
    const original = "Your introduction goes beyond the topic.";
    const replacement = "This document explores the topic.";
    const parent = createParent();
    mountSuggestionCardDiff({ parent, original, replacement });
    const blocks = Array.from(
      parent.querySelectorAll<HTMLElement>(".ai-reviewer-detached-diff-block"),
    );

    expect(blocks).to.have.length(1);
    const text = blocks[0].querySelector(".ai-reviewer-detached-diff-text");
    expect(
      Array.from(text?.childNodes ?? []).map((node) => [
        node.nodeName,
        node.textContent,
      ]),
    ).to.deep.equal([
      ["DEL", "Your introduction goes beyond"],
      ["INS", "This document explores"],
      ["#text", " the topic."],
    ]);
    expect(renderedVersions(parent)).to.deep.equal({ original, replacement });
    expect(parent.querySelectorAll(".cm-mergeView")).to.have.length(0);
  });

  it("mounts the card diff from original and replacement strings alone", function () {
    const parent = createParent();
    const mounted = mountSuggestionCardDiff({
      parent,
      original: "alpha old omega",
      replacement: "alpha new omega",
    });

    expect(
      parent.querySelectorAll(".ai-reviewer-detached-diff-block"),
    ).to.have.length(1);
    expect(renderedVersions(parent)).to.deep.equal({
      original: "alpha old omega",
      replacement: "alpha new omega",
    });
    mounted.destroy();
    expect(parent.childElementCount).to.equal(0);
  });

  it("keeps hunk IDs stable for one plan and changes them with replacement content", async function () {
    const firstCase = createSuggestionCase({
      id: "stable",
      original: "alpha\nold\nomega\n",
      replacement: "alpha\nnew\nomega\n",
    });
    const remountedCase = createSuggestionCase({
      id: "stable",
      original: "alpha\nold\nomega\n",
      replacement: "alpha\nnew\nomega\n",
    });
    const changedCase = createSuggestionCase({
      id: "stable",
      original: "alpha\nold\nomega\n",
      replacement: "alpha\ndifferent\nomega\n",
    });

    const first = await planCase(firstCase);
    const remounted = await planCase(remountedCase);
    const changed = await planCase(changedCase);

    expect(remounted).to.deep.equal(first);
    expect(changed).not.to.deep.equal(first);
  });

  it("binds every hunk ID to the complete suggestion identity and base state", async function () {
    const common = {
      original: "alpha\nold\nomega\n",
      replacement: "alpha\nnew\nomega\n",
    };
    const baseline = await planCase(
      createSuggestionCase({
        id: "identity",
        ...common,
      }),
    );
    const variants = [
      createSuggestionCase({
        id: "identity",
        suggestionId: "suggestion-other",
        ...common,
      }),
      createSuggestionCase({
        id: "identity",
        requestId: "request-other",
        ...common,
      }),
      createSuggestionCase({
        id: "identity",
        projectId: "project-other",
        ...common,
      }),
      createSuggestionCase({
        id: "identity",
        documentId: "document-other",
        ...common,
      }),
      createSuggestionCase({
        id: "identity",
        path: "sections/other.tex",
        ...common,
      }),
      createSuggestionCase({
        id: "identity",
        baseRevision: 8,
        ...common,
      }),
      createSuggestionCase({
        id: "identity",
        textHash: "b".repeat(64),
        ...common,
      }),
      createSuggestionCase({
        id: "identity",
        prefix: "x",
        ...common,
      }),
    ];

    for (const variant of variants) {
      const hunkIds = await planCase(variant);
      expect(hunkIds).not.to.deep.equal(baseline);
    }
  });

  it("returns only frozen opaque hunk IDs", async function () {
    const testCase = createSuggestionCase({
      id: "public-shape",
      original: "old",
      replacement: "new",
    });
    const hunkIds = await planCase(testCase);

    expect(Object.isFrozen(hunkIds)).to.equal(true);
    expect(hunkIds).to.have.length(1);
    expect(hunkIds[0]).to.match(/^ai-hunk-v1-[0-9a-f]{64}$/);
  });

  it("compiles only the selected separated hunk and leaves the other change untouched", async function () {
    const testCase = createSuggestionCase({
      id: "partial",
      original:
        "start\nold-one\nkeep-1\nkeep-2\nkeep-3\nkeep-4\nkeep-5\nold-two\nend\n",
      replacement:
        "start\nnew-one\nkeep-1\nkeep-2\nkeep-3\nkeep-4\nkeep-5\nnew-two\nend\n",
    });
    const hunkIds = await planCase(testCase);
    expect(hunkIds).to.have.length(2);

    const compiled = await compileSelectedSuggestionHunks({
      request: testCase.request,
      suggestion: testCase.suggestion,
      selectedHunkIds: [hunkIds[0]],
      documentLength: testCase.documentLength,
    });
    expect(compiled.status).to.equal("ready");
    if (compiled.status !== "ready") {
      throw new Error("Expected one selected hunk to compile.");
    }
    const result = compiled.changes
      .apply(EditorState.create({ doc: testCase.fullText }).doc)
      .toString();
    expect(result).to.include("new-one");
    expect(result).to.include("old-two");
    expect(result).not.to.include("new-two");
  });

  it("compiles reversed hunk IDs into exact inner changes in plan order", async function () {
    const testCase = createSuggestionCase({
      id: "inner-change-order",
      prefix: "前😀:",
      original:
        "start\nalpha old omega\nkeep-1\nkeep-2\nkeep-3\nkeep-4\nkeep-5\nalpha old omega\nend\n",
      replacement:
        "start\nalpha new omega\nkeep-1\nkeep-2\nkeep-3\nkeep-4\nkeep-5\nalpha new omega\nend\n",
      suffix: ":後",
    });
    const hunkIds = await planCase(testCase);
    expect(hunkIds).to.have.length(2);

    const compiled = await compileSelectedSuggestionHunks({
      request: testCase.request,
      suggestion: testCase.suggestion,
      selectedHunkIds: [...hunkIds].reverse(),
      documentLength: testCase.documentLength,
    });
    expect(compiled.status).to.equal("ready");
    if (compiled.status !== "ready") {
      throw new Error("Expected reversed selected hunks to compile.");
    }

    const observedChanges: Array<{
      fromA: number;
      toA: number;
      fromB: number;
      toB: number;
      insert: string;
    }> = [];
    compiled.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
      observedChanges.push({
        fromA,
        toA,
        fromB,
        toB,
        insert: inserted.toString(),
      });
    }, true);
    const firstOld = testCase.fullText.indexOf("old");
    const secondOld = testCase.fullText.lastIndexOf("old");

    expect(compiled.selectedHunkIds).to.deep.equal(hunkIds);
    expect(observedChanges).to.deep.equal([
      {
        fromA: firstOld,
        toA: firstOld + 3,
        fromB: firstOld,
        toB: firstOld + 3,
        insert: "new",
      },
      {
        fromA: secondOld,
        toA: secondOld + 3,
        fromB: secondOld,
        toB: secondOld + 3,
        insert: "new",
      },
    ]);
    expect(
      compiled.changes
        .apply(EditorState.create({ doc: testCase.fullText }).doc)
        .toString(),
    ).to.equal(testCase.expectedText);
  });

  it("uses full-document UTF-16 coordinates for a non-zero suggestion range", async function () {
    const testCase = createSuggestionCase({
      id: "utf16-range",
      prefix: "前😀prefix\n",
      original: "日本語😀です",
      replacement: "日本語😺です",
      suffix: "\n後文",
    });
    const hunkIds = await planCase(testCase);

    const compiled = await compileSelectedSuggestionHunks({
      request: testCase.request,
      suggestion: testCase.suggestion,
      selectedHunkIds: hunkIds,
      documentLength: testCase.documentLength,
    });
    expect(compiled.status).to.equal("ready");
    if (compiled.status !== "ready") {
      throw new Error("Expected the UTF-16 hunk to compile.");
    }
    expect(
      compiled.changes
        .apply(EditorState.create({ doc: testCase.fullText }).doc)
        .toString(),
    ).to.equal(testCase.expectedText);
  });

  it("returns an explicit no-op for an empty selection", async function () {
    const testCase = createSuggestionCase({
      id: "empty-selection",
      original: "old",
      replacement: "new",
    });

    expect(
      await compileSelectedSuggestionHunks({
        request: testCase.request,
        suggestion: testCase.suggestion,
        selectedHunkIds: [],
        documentLength: testCase.documentLength,
      }),
    ).to.deep.equal({
      status: "empty",
      selectedHunkIds: [],
    });
  });

  it("treats an unchanged suggestion as an explicit no-op plan", async function () {
    const testCase = createSuggestionCase({
      id: "unchanged",
      original: "same",
      replacement: "same",
    });
    const hunkIds = await planCase(testCase);

    expect(hunkIds).to.deep.equal([]);
    expect(
      await compileSelectedSuggestionHunks({
        request: testCase.request,
        suggestion: testCase.suggestion,
        selectedHunkIds: [],
        documentLength: testCase.documentLength,
      }),
    ).to.deep.equal({
      status: "empty",
      selectedHunkIds: [],
    });
  });

  it("accepts a matching bounded imprecise plan without changing its edits", async function () {
    const testCase = createSuggestionCase({
      id: "imprecise",
      original: "alpha\nold\nomega\n",
      replacement: "alpha\nnew\nomega\n",
    });
    const actualChunks = Chunk.build(
      EditorState.create({ doc: "alpha\nold\nomega\n" }).doc,
      EditorState.create({ doc: "alpha\nnew\nomega\n" }).doc,
      {
        scanLimit: 500,
        timeout: 1_000,
      },
    );
    const impreciseChunks = actualChunks.map(
      (chunk) =>
        new Chunk(
          chunk.changes,
          chunk.fromA,
          chunk.toA,
          chunk.fromB,
          chunk.toB,
          false,
        ),
    );
    sinon.stub(Chunk, "build").returns(impreciseChunks);
    const hunkIds = await planCase(testCase);

    const compiled = await compileSelectedSuggestionHunks({
      request: testCase.request,
      suggestion: testCase.suggestion,
      selectedHunkIds: hunkIds,
      documentLength: testCase.documentLength,
    });
    expect(compiled.status).to.equal("ready");
    if (compiled.status !== "ready") {
      throw new Error("Expected the imprecise plan to compile.");
    }
    expect(
      compiled.changes
        .apply(EditorState.create({ doc: testCase.fullText }).doc)
        .toString(),
    ).to.equal(testCase.expectedText);
  });

  it("rejects duplicate, unknown, and foreign-plan hunk IDs", async function () {
    const testCase = createSuggestionCase({
      id: "selection-validation",
      original: "old",
      replacement: "new",
    });
    const foreignCase = createSuggestionCase({
      id: "foreign-selection",
      original: "old",
      replacement: "different",
    });
    const own = await planCase(testCase);
    const foreign = await planCase(foreignCase);

    const cases = [
      {
        name: "duplicate",
        selectedHunkIds: [own[0], own[0]],
        code: "AI_DIFF_HUNK_DUPLICATE",
      },
      {
        name: "unknown",
        selectedHunkIds: ["ai-hunk-v1-unknown"],
        code: "AI_DIFF_HUNK_UNKNOWN",
      },
      {
        name: "foreign",
        selectedHunkIds: [foreign[0]],
        code: "AI_DIFF_HUNK_UNKNOWN",
      },
    ];

    for (const test of cases) {
      const error = await captureError(() =>
        compileSelectedSuggestionHunks({
          request: testCase.request,
          suggestion: testCase.suggestion,
          selectedHunkIds: test.selectedHunkIds,
          documentLength: testCase.documentLength,
        }),
      );
      expect(error, test.name)
        .to.be.instanceOf(DetachedSuggestionDiffError)
        .and.have.property("code", test.code);
    }
  });

  it("does not derive a change from an attacker-controlled hunk ID", async function () {
    const testCase = createSuggestionCase({
      id: "opaque-id",
      prefix: "protected:",
      original: "old",
      replacement: "new",
      suffix: ":protected",
    });
    const error = await captureError(() =>
      compileSelectedSuggestionHunks({
        request: testCase.request,
        suggestion: testCase.suggestion,
        selectedHunkIds: ["0:999999:attacker text"],
        documentLength: testCase.documentLength,
      }),
    );

    expect(error)
      .to.be.instanceOf(DetachedSuggestionDiffError)
      .and.have.property("code", "AI_DIFF_HUNK_UNKNOWN");
  });

  it("rejects invalid document lengths and runtime selection values", async function () {
    const testCase = createSuggestionCase({
      id: "runtime-input",
      prefix: "prefix:",
      original: "old",
      replacement: "new",
    });
    const hunkIds = await planCase(testCase);
    const invalidInputs = [
      {
        name: "short document",
        selectedHunkIds: hunkIds,
        documentLength: 2,
        code: "AI_DIFF_DOCUMENT_LENGTH_INVALID",
      },
      {
        name: "fractional document",
        selectedHunkIds: hunkIds,
        documentLength: 10.5,
        code: "AI_DIFF_DOCUMENT_LENGTH_INVALID",
      },
      {
        name: "non-array selection",
        selectedHunkIds: "ai-hunk-v1-not-an-array",
        documentLength: testCase.documentLength,
        code: "AI_DIFF_HUNK_SELECTION_INVALID",
      },
      {
        name: "non-string selection",
        selectedHunkIds: [7],
        documentLength: testCase.documentLength,
        code: "AI_DIFF_HUNK_SELECTION_INVALID",
      },
    ];

    for (const input of invalidInputs) {
      const error = await captureError(() =>
        compileSelectedSuggestionHunks({
          request: testCase.request,
          suggestion: testCase.suggestion,
          selectedHunkIds: input.selectedHunkIds,
          documentLength: input.documentLength,
        }),
      );
      expect(error, input.name)
        .to.be.instanceOf(DetachedSuggestionDiffError)
        .and.have.property("code", input.code);
    }
  });

  it("rejects malformed suggestions before building an apply plan", async function () {
    const testCase = createSuggestionCase({
      id: "malformed",
      original: "old",
      replacement: "new",
    });
    const malformedSuggestion = {
      ...testCase.suggestion,
      unguardedWrite: true,
    };

    const error = await captureError(() =>
      getSuggestionHunkIds({
        request: testCase.request,
        suggestion: malformedSuggestion,
      }),
    );

    expect(error).to.have.property("code", "AI_SUGGESTION_SCHEMA_INVALID");
  });

  it("rejects an apply plan whose rendered segments disagree with the suggestion", async function () {
    const testCase = createSuggestionCase({
      id: "plan-mismatch",
      original: "alpha\nold\nomega\n",
      replacement: "alpha\nnew\nomega\n",
    });
    sinon.stub(DiffMatchPatch.prototype, "diff_main").returns([[0, "wrong"]]);

    const error = await captureError(() =>
      getSuggestionHunkIds({
        request: testCase.request,
        suggestion: testCase.suggestion,
      }),
    );

    expect(error)
      .to.be.instanceOf(DetachedSuggestionDiffError)
      .and.have.property("code", "AI_DIFF_PLAN_MISMATCH");
  });
});
