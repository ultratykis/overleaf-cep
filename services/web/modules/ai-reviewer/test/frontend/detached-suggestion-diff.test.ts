import { Chunk, MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { expect } from "chai";
import sinon from "sinon";

import {
  compileSelectedSuggestionHunks,
  DetachedSuggestionDiffError,
  mountDetachedSuggestionDiff,
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

type MountedDiff = Awaited<ReturnType<typeof mountDetachedSuggestionDiff>>;

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
      status: "proposed",
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

function hunkInputs(parent: HTMLElement) {
  return Array.from(
    parent.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"][data-ai-reviewer-hunk-id]',
    ),
  );
}

describe("AI reviewer: single document detached diff", function () {
  const mountedDiffs: MountedDiff[] = [];
  const parents: HTMLElement[] = [];

  function createParent() {
    const parent = document.createElement("section");
    document.body.appendChild(parent);
    parents.push(parent);
    return parent;
  }

  async function mountCase(
    testCase: SuggestionCase,
    onSelectionChange?: (selectedHunkIds: readonly string[]) => void,
  ) {
    const parent = createParent();
    const mounted = await mountDetachedSuggestionDiff({
      parent,
      request: testCase.request,
      suggestion: testCase.suggestion,
      onSelectionChange,
    });
    mountedDiffs.push(mounted);
    return {
      mounted,
      parent,
    };
  }

  afterEach(function () {
    sinon.restore();
    for (const mounted of mountedDiffs.splice(0).reverse()) {
      mounted.destroy();
    }
    for (const parent of parents.splice(0).reverse()) {
      parent.remove();
    }
  });

  for (const fixture of fixtures) {
    it(`renders and compiles the ${fixture.id} fixture without mutating the preview`, async function () {
      const testCase = createSuggestionCase(fixture);
      const selectionEvents: string[][] = [];
      const { mounted, parent } = await mountCase(
        testCase,
        (selectedHunkIds) => {
          selectionEvents.push([...selectedHunkIds]);
        },
      );

      expect(parent.querySelectorAll(".cm-mergeView")).to.have.length(1);
      expect(parent.querySelectorAll(".cm-merge-revert")).to.have.length(0);
      expect(parent.querySelectorAll(".cm-editor")).to.have.length(2);
      expect(mounted.hunkIds).to.have.length.greaterThan(0);
      expect(new Set(mounted.hunkIds).size).to.equal(mounted.hunkIds.length);
      expect(hunkInputs(parent)).to.have.length(mounted.hunkIds.length);
      expect(selectionEvents).to.deep.equal([[]]);

      const previewViews = Array.from(
        parent.querySelectorAll<HTMLElement>(".cm-editor"),
      ).map((editor) => EditorView.findFromDOM(editor));
      expect(previewViews.every((view) => view != null)).to.equal(true);

      for (const previewView of previewViews) {
        if (previewView == null) {
          throw new Error("Expected a mounted preview EditorView.");
        }
        const before = previewView.state.doc.toString();
        expect(previewView.state.facet(EditorState.readOnly)).to.equal(true);
        expect(previewView.state.facet(EditorView.editable)).to.equal(false);
        expect(
          previewView.state.facet(EditorState.changeFilter).length,
        ).to.be.greaterThan(0);
        previewView.dispatch({
          changes: {
            from: 0,
            insert: "blocked",
          },
        });
        expect(previewView.state.doc.toString()).to.equal(before);
      }

      for (const input of hunkInputs(parent)) {
        input.checked = true;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }
      expect(selectionEvents.at(-1)).to.deep.equal(mounted.hunkIds);

      const compiled = await compileSelectedSuggestionHunks({
        request: testCase.request,
        suggestion: testCase.suggestion,
        selectedHunkIds: mounted.hunkIds,
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

    const first = await mountCase(firstCase);
    const remounted = await mountCase(remountedCase);
    const changed = await mountCase(changedCase);

    expect(remounted.mounted.hunkIds).to.deep.equal(first.mounted.hunkIds);
    expect(changed.mounted.hunkIds).not.to.deep.equal(first.mounted.hunkIds);
  });

  it("binds every hunk ID to the complete suggestion identity and base state", async function () {
    const common = {
      original: "alpha\nold\nomega\n",
      replacement: "alpha\nnew\nomega\n",
    };
    const baseline = await mountCase(
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
      const mounted = await mountCase(variant);
      expect(mounted.mounted.hunkIds).not.to.deep.equal(
        baseline.mounted.hunkIds,
      );
    }
  });

  it("returns only opaque hunk IDs and an idempotent destroy function", async function () {
    const testCase = createSuggestionCase({
      id: "public-shape",
      original: "old",
      replacement: "new",
    });
    const { mounted } = await mountCase(testCase);

    expect(Object.keys(mounted).sort()).to.deep.equal(["destroy", "hunkIds"]);
    expect(Object.isFrozen(mounted)).to.equal(true);
    expect(Object.isFrozen(mounted.hunkIds)).to.equal(true);
    expect(mounted).not.to.have.any.keys(
      "a",
      "b",
      "chunks",
      "dom",
      "mergeView",
      "view",
    );
  });

  it("reports selection in plan order without changing either preview document", async function () {
    const testCase = createSuggestionCase({
      id: "selection-order",
      original:
        "start\nold-one\nkeep-1\nkeep-2\nkeep-3\nkeep-4\nkeep-5\nold-two\nend\n",
      replacement:
        "start\nnew-one\nkeep-1\nkeep-2\nkeep-3\nkeep-4\nkeep-5\nnew-two\nend\n",
    });
    const selectionEvents: string[][] = [];
    const { mounted, parent } = await mountCase(testCase, (selectedHunkIds) => {
      selectionEvents.push([...selectedHunkIds]);
    });
    const inputs = hunkInputs(parent);
    expect(inputs).to.have.length(2);
    const before = Array.from(
      parent.querySelectorAll<HTMLElement>(".cm-editor"),
    ).map((editor) => EditorView.findFromDOM(editor)?.state.doc.toString());

    inputs[1].checked = true;
    inputs[1].dispatchEvent(new Event("change", { bubbles: true }));
    inputs[0].checked = true;
    inputs[0].dispatchEvent(new Event("change", { bubbles: true }));

    expect(selectionEvents.at(-1)).to.deep.equal(mounted.hunkIds);
    expect(
      Array.from(parent.querySelectorAll<HTMLElement>(".cm-editor")).map(
        (editor) => EditorView.findFromDOM(editor)?.state.doc.toString(),
      ),
    ).to.deep.equal(before);
  });

  it("compiles only the selected separated hunk and leaves the other change untouched", async function () {
    const testCase = createSuggestionCase({
      id: "partial",
      original:
        "start\nold-one\nkeep-1\nkeep-2\nkeep-3\nkeep-4\nkeep-5\nold-two\nend\n",
      replacement:
        "start\nnew-one\nkeep-1\nkeep-2\nkeep-3\nkeep-4\nkeep-5\nnew-two\nend\n",
    });
    const { mounted } = await mountCase(testCase);
    expect(mounted.hunkIds).to.have.length(2);

    const compiled = await compileSelectedSuggestionHunks({
      request: testCase.request,
      suggestion: testCase.suggestion,
      selectedHunkIds: [mounted.hunkIds[0]],
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
    const { mounted } = await mountCase(testCase);
    expect(mounted.hunkIds).to.have.length(2);

    const compiled = await compileSelectedSuggestionHunks({
      request: testCase.request,
      suggestion: testCase.suggestion,
      selectedHunkIds: [...mounted.hunkIds].reverse(),
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

    expect(compiled.selectedHunkIds).to.deep.equal(mounted.hunkIds);
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
    const { mounted } = await mountCase(testCase);

    const compiled = await compileSelectedSuggestionHunks({
      request: testCase.request,
      suggestion: testCase.suggestion,
      selectedHunkIds: mounted.hunkIds,
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
    const selectionEvents: string[][] = [];
    const { mounted, parent } = await mountCase(testCase, (selectedHunkIds) => {
      selectionEvents.push([...selectedHunkIds]);
    });

    expect(mounted.hunkIds).to.deep.equal([]);
    expect(hunkInputs(parent)).to.deep.equal([]);
    expect(selectionEvents).to.deep.equal([[]]);
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
    const { mounted } = await mountCase(testCase);

    const compiled = await compileSelectedSuggestionHunks({
      request: testCase.request,
      suggestion: testCase.suggestion,
      selectedHunkIds: mounted.hunkIds,
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
    const own = await mountCase(testCase);
    const foreign = await mountCase(foreignCase);

    const cases = [
      {
        name: "duplicate",
        selectedHunkIds: [own.mounted.hunkIds[0], own.mounted.hunkIds[0]],
        code: "AI_DIFF_HUNK_DUPLICATE",
      },
      {
        name: "unknown",
        selectedHunkIds: ["ai-hunk-v1-unknown"],
        code: "AI_DIFF_HUNK_UNKNOWN",
      },
      {
        name: "foreign",
        selectedHunkIds: [foreign.mounted.hunkIds[0]],
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
    const { mounted } = await mountCase(testCase);
    const invalidInputs = [
      {
        name: "short document",
        selectedHunkIds: mounted.hunkIds,
        documentLength: 2,
        code: "AI_DIFF_DOCUMENT_LENGTH_INVALID",
      },
      {
        name: "fractional document",
        selectedHunkIds: mounted.hunkIds,
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

  it("rejects malformed suggestions before mounting a preview", async function () {
    const testCase = createSuggestionCase({
      id: "malformed",
      original: "old",
      replacement: "new",
    });
    const parent = createParent();
    const malformedSuggestion = {
      ...testCase.suggestion,
      unguardedWrite: true,
    };

    const error = await captureError(() =>
      mountDetachedSuggestionDiff({
        parent,
        request: testCase.request,
        suggestion: malformedSuggestion,
      }),
    );

    expect(error).to.have.property("code", "AI_SUGGESTION_SCHEMA_INVALID");
    expect(parent.childElementCount).to.equal(0);
  });

  it("rejects a preview whose rendered chunks disagree with the reconstructed plan", async function () {
    const testCase = createSuggestionCase({
      id: "plan-mismatch",
      original: "alpha\nold\nomega\n",
      replacement: "alpha\nnew\nomega\n",
    });
    const originalBuild = Chunk.build;
    const expectedChunks = originalBuild(
      EditorState.create({ doc: "alpha\nold\nomega\n" }).doc,
      EditorState.create({ doc: "alpha\nnew\nomega\n" }).doc,
      {
        scanLimit: 500,
        timeout: 1_000,
      },
    );
    const mismatchedChunks = originalBuild(
      EditorState.create({ doc: "old" }).doc,
      EditorState.create({ doc: "different" }).doc,
      {
        scanLimit: 500,
        timeout: 1_000,
      },
    );
    const build = sinon.stub(Chunk, "build");
    build.onFirstCall().returns(expectedChunks);
    build.onSecondCall().returns(mismatchedChunks);
    build.callsFake(originalBuild);
    const destroy = sinon.spy(MergeView.prototype, "destroy");
    const parent = createParent();

    const error = await captureError(() =>
      mountDetachedSuggestionDiff({
        parent,
        request: testCase.request,
        suggestion: testCase.suggestion,
      }),
    );

    expect(error)
      .to.be.instanceOf(DetachedSuggestionDiffError)
      .and.have.property("code", "AI_DIFF_PLAN_MISMATCH");
    expect(parent.childElementCount).to.equal(0);
    expect(destroy.calledOnce).to.equal(true);
  });

  it("destroys both detached editors and the selection controls", async function () {
    const testCase = createSuggestionCase({
      id: "destroy",
      original: "old",
      replacement: "new",
    });
    const destroy = sinon.spy(MergeView.prototype, "destroy");
    const { mounted, parent } = await mountCase(testCase);
    expect(parent.childElementCount).to.be.greaterThan(0);

    mounted.destroy();
    mounted.destroy();

    expect(parent.childElementCount).to.equal(0);
    expect(destroy.calledOnce).to.equal(true);
  });

  it("removes selection listeners when the preview is destroyed", async function () {
    const testCase = createSuggestionCase({
      id: "destroy-listener",
      original: "old",
      replacement: "new",
    });
    const selectionEvents: string[][] = [];
    const { mounted, parent } = await mountCase(testCase, (selectedHunkIds) => {
      selectionEvents.push([...selectedHunkIds]);
    });
    const input = hunkInputs(parent)[0];
    expect(selectionEvents).to.deep.equal([[]]);

    mounted.destroy();
    input.checked = true;
    input.dispatchEvent(new Event("change", { bubbles: true }));

    expect(selectionEvents).to.deep.equal([[]]);
  });
});
