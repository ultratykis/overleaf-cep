import { Chunk, MergeView, type DiffConfig } from "@codemirror/merge";
import { ChangeSet, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { TFunction } from "i18next";

import type { UnresolvedSuggestion } from "../../../shared/contract-types";
import { prepareSingleDocumentSuggestion } from "./single-document-suggestions";

const DIFF_CONFIG = Object.freeze({
  scanLimit: 500,
  timeout: 1_000,
}) satisfies DiffConfig;

const HUNK_ID_PREFIX = "ai-hunk-v1-";

type PlannedHunk = {
  id: string;
  ordinal: number;
  chunk: Chunk;
};

type LocalChangeSpec = {
  from: number;
  to: number;
  insert: string;
};

type SuggestionDiffPlan = {
  suggestion: UnresolvedSuggestion;
  chunks: readonly Chunk[];
  hunks: readonly PlannedHunk[];
};

type MountDetachedSuggestionDiffOptions = {
  parent: HTMLElement;
  request: unknown;
  suggestion: unknown;
  onSelectionChange?: (selectedHunkIds: readonly string[]) => void;
  t: TFunction<"translation">;
};

type CompileSelectedSuggestionHunksOptions = {
  request: unknown;
  suggestion: unknown;
  selectedHunkIds: unknown;
  documentLength: unknown;
};

export type MountedDetachedSuggestionDiff = {
  readonly hunkIds: readonly string[];
  destroy(): void;
};

export type CompiledSuggestionHunks =
  | {
      status: "ready";
      changes: ChangeSet;
      selectedHunkIds: readonly string[];
    }
  | {
      status: "empty";
      selectedHunkIds: readonly [];
    };

export class DetachedSuggestionDiffError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DetachedSuggestionDiffError";
  }
}

function fail(code: string, message: string): never {
  throw new DetachedSuggestionDiffError(code, message);
}

async function sha256(value: string): Promise<string> {
  if (globalThis.crypto?.subtle == null) {
    return fail(
      "AI_DIFF_CRYPTO_UNAVAILABLE",
      "The browser cannot create a suggestion plan fingerprint.",
    );
  }

  let digest: ArrayBuffer;
  try {
    digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(value),
    );
  } catch {
    return fail(
      "AI_DIFF_FINGERPRINT_FAILED",
      "The suggestion plan fingerprint could not be created.",
    );
  }

  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function chunkDescription(chunk: Chunk, original: string, replacement: string) {
  return {
    fromA: chunk.fromA,
    toA: chunk.toA,
    endA: chunk.endA,
    fromB: chunk.fromB,
    toB: chunk.toB,
    endB: chunk.endB,
    precise: chunk.precise,
    changes: chunk.changes.map((change) => [
      change.fromA,
      change.toA,
      change.fromB,
      change.toB,
    ]),
    originalSlice: original.slice(chunk.fromA, chunk.endA),
    replacementSlice: replacement.slice(chunk.fromB, chunk.endB),
  };
}

function localChangeSpecs(
  chunks: readonly Chunk[],
  original: string,
  replacement: string,
): LocalChangeSpec[] {
  const specs: LocalChangeSpec[] = [];
  let previousFrom = -1;
  let previousTo = -1;

  for (const chunk of chunks) {
    if (
      !Number.isInteger(chunk.fromA) ||
      !Number.isInteger(chunk.toA) ||
      !Number.isInteger(chunk.fromB) ||
      !Number.isInteger(chunk.toB) ||
      chunk.fromA < 0 ||
      chunk.fromB < 0 ||
      chunk.endA > original.length ||
      chunk.endB > replacement.length ||
      chunk.changes.length === 0
    ) {
      return fail(
        "AI_DIFF_PLAN_INVALID",
        "The diff engine returned an invalid suggestion plan.",
      );
    }

    for (const change of chunk.changes) {
      const from = chunk.fromA + change.fromA;
      const to = chunk.fromA + change.toA;
      const replacementFrom = chunk.fromB + change.fromB;
      const replacementTo = chunk.fromB + change.toB;
      if (
        !Number.isInteger(from) ||
        !Number.isInteger(to) ||
        !Number.isInteger(replacementFrom) ||
        !Number.isInteger(replacementTo) ||
        from < 0 ||
        to < from ||
        to > original.length ||
        replacementFrom < 0 ||
        replacementTo < replacementFrom ||
        replacementTo > replacement.length ||
        from < previousFrom ||
        (from < previousTo && (from !== to || previousFrom !== previousTo))
      ) {
        return fail(
          "AI_DIFF_PLAN_INVALID",
          "The diff engine returned overlapping or out-of-range changes.",
        );
      }

      specs.push({
        from,
        to,
        insert: replacement.slice(replacementFrom, replacementTo),
      });
      previousFrom = from;
      previousTo = to;
    }
  }

  return specs;
}

function assertCompletePlan(
  chunks: readonly Chunk[],
  original: string,
  replacement: string,
) {
  const specs = localChangeSpecs(chunks, original, replacement);
  if (specs.length === 0 && original !== replacement) {
    return fail(
      "AI_DIFF_PLAN_INVALID",
      "The diff engine did not describe the proposed replacement.",
    );
  }

  let reconstructed: string;
  try {
    reconstructed = ChangeSet.of(specs, original.length)
      .apply(EditorState.create({ doc: original }).doc)
      .toString();
  } catch {
    return fail(
      "AI_DIFF_PLAN_INVALID",
      "The diff engine returned changes that cannot be applied.",
    );
  }
  if (reconstructed !== replacement) {
    return fail(
      "AI_DIFF_PLAN_INVALID",
      "The diff engine plan does not reconstruct the proposed replacement.",
    );
  }
}

function suggestionPlanIdentity(suggestion: UnresolvedSuggestion) {
  return JSON.stringify([
    "ai-suggestion-diff-plan-v1",
    suggestion.id,
    suggestion.requestId,
    suggestion.projectId,
    suggestion.documentId,
    suggestion.path,
    suggestion.baseRevision,
    suggestion.baseTextHash,
    suggestion.range.from,
    suggestion.range.to,
    suggestion.original,
    suggestion.replacement,
  ]);
}

async function buildPreparedPlan(
  suggestion: UnresolvedSuggestion,
): Promise<SuggestionDiffPlan> {
  const originalDocument = EditorState.create({
    doc: suggestion.original,
  }).doc;
  const replacementDocument = EditorState.create({
    doc: suggestion.replacement,
  }).doc;
  const chunks = Chunk.build(
    originalDocument,
    replacementDocument,
    DIFF_CONFIG,
  );
  assertCompletePlan(chunks, suggestion.original, suggestion.replacement);

  const planFingerprint = await sha256(suggestionPlanIdentity(suggestion));
  const hunks = await Promise.all(
    chunks.map(async (chunk, ordinal) => ({
      id: `${HUNK_ID_PREFIX}${await sha256(
        JSON.stringify([
          planFingerprint,
          ordinal,
          chunkDescription(chunk, suggestion.original, suggestion.replacement),
        ]),
      )}`,
      ordinal,
      chunk,
    })),
  );
  if (new Set(hunks.map((hunk) => hunk.id)).size !== hunks.length) {
    return fail(
      "AI_DIFF_HUNK_COLLISION",
      "The suggestion plan produced duplicate hunk identifiers.",
    );
  }

  return {
    suggestion,
    chunks,
    hunks,
  };
}

async function buildPlan({
  request,
  suggestion,
}: {
  request: unknown;
  suggestion: unknown;
}) {
  return buildPreparedPlan(
    prepareSingleDocumentSuggestion({
      request,
      suggestion,
    }),
  );
}

function sameChunks(
  expected: readonly Chunk[],
  rendered: readonly Chunk[],
  suggestion: UnresolvedSuggestion,
) {
  if (expected.length !== rendered.length) {
    return false;
  }
  return expected.every(
    (chunk, index) =>
      JSON.stringify(
        chunkDescription(chunk, suggestion.original, suggestion.replacement),
      ) ===
      JSON.stringify(
        chunkDescription(
          rendered[index],
          suggestion.original,
          suggestion.replacement,
        ),
      ),
  );
}

function parseSelectedHunkIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return fail(
      "AI_DIFF_HUNK_SELECTION_INVALID",
      "Selected suggestion hunks must be an array.",
    );
  }

  const selected: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (
      typeof candidate !== "string" ||
      candidate.length === 0 ||
      candidate.length > 512
    ) {
      return fail(
        "AI_DIFF_HUNK_SELECTION_INVALID",
        "A selected suggestion hunk identifier is invalid.",
      );
    }
    if (seen.has(candidate)) {
      return fail(
        "AI_DIFF_HUNK_DUPLICATE",
        "A suggestion hunk was selected more than once.",
      );
    }
    seen.add(candidate);
    selected.push(candidate);
  }
  return selected;
}

function assertDocumentLength(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    return fail(
      "AI_DIFF_DOCUMENT_LENGTH_INVALID",
      "The current document length is invalid.",
    );
  }
}

export async function mountDetachedSuggestionDiff({
  parent,
  request,
  suggestion,
  onSelectionChange,
  t,
}: MountDetachedSuggestionDiffOptions): Promise<MountedDetachedSuggestionDiff> {
  const plan = await buildPlan({
    request,
    suggestion,
  });
  const ownerDocument = parent.ownerDocument;
  const container = ownerDocument.createElement("div");
  container.className = "ai-reviewer-detached-diff";
  const preview = ownerDocument.createElement("div");
  preview.className = "ai-reviewer-detached-diff-preview";
  const controls = ownerDocument.createElement("fieldset");
  controls.className = "ai-reviewer-detached-diff-hunks";
  const legend = ownerDocument.createElement("legend");
  legend.textContent = t("ai_reviewer_select_proposed_changes");
  controls.appendChild(legend);
  container.append(preview, controls);

  const immutableExtensions = [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorState.changeFilter.of(() => false),
  ];
  let mergeView: MergeView | null = null;
  let destroyed = false;
  const removeListeners: Array<() => void> = [];
  const selected = new Set<string>();

  const selectedInPlanOrder = () =>
    Object.freeze(
      plan.hunks.filter((hunk) => selected.has(hunk.id)).map((hunk) => hunk.id),
    );

  const destroy = () => {
    if (destroyed) {
      return;
    }
    destroyed = true;
    for (const removeListener of removeListeners.splice(0)) {
      removeListener();
    }
    mergeView?.destroy();
    mergeView = null;
    container.remove();
  };

  try {
    mergeView = new MergeView({
      a: {
        doc: plan.suggestion.original,
        extensions: immutableExtensions,
      },
      b: {
        doc: plan.suggestion.replacement,
        extensions: immutableExtensions,
      },
      parent: preview,
      root: parent.getRootNode() as Document | ShadowRoot,
      revertControls: undefined,
      highlightChanges: true,
      gutter: true,
      diffConfig: DIFF_CONFIG,
    });
    if (!sameChunks(plan.chunks, mergeView.chunks, plan.suggestion)) {
      return fail(
        "AI_DIFF_PLAN_MISMATCH",
        "The rendered preview does not match the suggestion plan.",
      );
    }

    for (const hunk of plan.hunks) {
      const label = ownerDocument.createElement("label");
      label.className = "ai-reviewer-detached-diff-hunk";
      const checkbox = ownerDocument.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.aiReviewerHunkId = hunk.id;
      checkbox.setAttribute(
        "aria-label",
        t("ai_reviewer_select_proposed_change_n", {
          number: hunk.ordinal + 1,
        }),
      );
      const onChange = () => {
        if (destroyed) {
          return;
        }
        if (checkbox.checked) {
          selected.add(hunk.id);
        } else {
          selected.delete(hunk.id);
        }
        onSelectionChange?.(selectedInPlanOrder());
      };
      checkbox.addEventListener("change", onChange);
      removeListeners.push(() =>
        checkbox.removeEventListener("change", onChange),
      );
      label.append(
        checkbox,
        ownerDocument.createTextNode(
          t("ai_reviewer_change_n", { number: hunk.ordinal + 1 }),
        ),
      );
      controls.appendChild(label);
    }

    parent.appendChild(container);
    onSelectionChange?.(Object.freeze([]));
  } catch (error) {
    destroy();
    if (error instanceof DetachedSuggestionDiffError) {
      throw error;
    }
    return fail(
      "AI_DIFF_PREVIEW_FAILED",
      "The detached suggestion preview could not be mounted.",
    );
  }

  const hunkIds = Object.freeze(plan.hunks.map((hunk) => hunk.id));
  return Object.freeze({
    hunkIds,
    destroy,
  });
}

export async function compileSelectedSuggestionHunks({
  request,
  suggestion,
  selectedHunkIds: rawSelectedHunkIds,
  documentLength: rawDocumentLength,
}: CompileSelectedSuggestionHunksOptions): Promise<CompiledSuggestionHunks> {
  const preparedSuggestion = prepareSingleDocumentSuggestion({
    request,
    suggestion,
  });
  assertDocumentLength(rawDocumentLength);
  if (preparedSuggestion.range.to > rawDocumentLength) {
    return fail(
      "AI_DIFF_DOCUMENT_LENGTH_INVALID",
      "The suggestion range is outside the current document.",
    );
  }

  const selectedHunkIds = parseSelectedHunkIds(rawSelectedHunkIds);
  const plan = await buildPreparedPlan(preparedSuggestion);
  const hunkById = new Map(plan.hunks.map((hunk) => [hunk.id, hunk]));
  for (const selectedHunkId of selectedHunkIds) {
    if (!hunkById.has(selectedHunkId)) {
      return fail(
        "AI_DIFF_HUNK_UNKNOWN",
        "A selected hunk does not belong to this suggestion plan.",
      );
    }
  }

  const orderedSelectedHunks = plan.hunks.filter((hunk) =>
    selectedHunkIds.includes(hunk.id),
  );
  const orderedSelectedHunkIds = Object.freeze(
    orderedSelectedHunks.map((hunk) => hunk.id),
  );
  if (orderedSelectedHunks.length === 0) {
    return {
      status: "empty",
      selectedHunkIds: [],
    };
  }

  const localSpecs = localChangeSpecs(
    orderedSelectedHunks.map((hunk) => hunk.chunk),
    plan.suggestion.original,
    plan.suggestion.replacement,
  );
  const offset = plan.suggestion.range.from;
  const changes = localSpecs.map((change) => {
    const from = offset + change.from;
    const to = offset + (change.to ?? change.from);
    if (
      from < plan.suggestion.range.from ||
      to > plan.suggestion.range.to ||
      from < 0 ||
      to < from ||
      to > rawDocumentLength
    ) {
      return fail(
        "AI_DIFF_CHANGE_OUT_OF_RANGE",
        "A selected hunk is outside the suggestion range.",
      );
    }
    return {
      from,
      to,
      insert: change.insert,
    };
  });

  let changeSet: ChangeSet;
  try {
    changeSet = ChangeSet.of(changes, rawDocumentLength);
  } catch {
    return fail(
      "AI_DIFF_CHANGESET_INVALID",
      "The selected suggestion hunks cannot form one document change.",
    );
  }

  return {
    status: "ready",
    changes: changeSet,
    selectedHunkIds: orderedSelectedHunkIds,
  };
}
