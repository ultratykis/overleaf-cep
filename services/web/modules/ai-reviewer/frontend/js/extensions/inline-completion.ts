import { Extension, Prec, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import getMeta from "@/utils/meta";

import {
  getInlineCompletionState,
  inlineCompletionGate,
  subscribeToInlineCompletionState,
} from "../services/inline-completion-state";

const COMPLETION_DEBOUNCE_MS = 1_000;
const COMPLETION_MAX_LENGTH = 60;
const FAILURE_LIMIT = 3;
const FAILURE_PAUSE_MS = 60_000;

type Suggestion = {
  from: number;
  text: string;
};

type CompletionResult =
  | { status: "success"; data: string }
  | { status: "aborted" }
  | { status: "failure" };

const setSuggestion = StateEffect.define<Suggestion | null>();

class GhostTextWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  eq(other: GhostTextWidget) {
    return this.text === other.text;
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-ai-reviewer-ghost-text";
    span.textContent = this.text;
    return span;
  }
}

function ghostTextDecorations(suggestion: Suggestion): DecorationSet {
  return Decoration.set([
    Decoration.widget({
      widget: new GhostTextWidget(suggestion.text),
      side: 1,
    }).range(suggestion.from),
  ]);
}

const suggestionField = StateField.define<Suggestion | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setSuggestion)) return effect.value;
    }
    if (value == null) return null;
    if (transaction.docChanged) {
      let changeCount = 0;
      let simpleInsertion = true;
      let insertedText = "";
      let changeFrom = -1;
      transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
        changeCount += 1;
        const text = inserted.toString();
        if (from !== to || text.includes("\n")) simpleInsertion = false;
        insertedText += text;
        if (changeFrom === -1) changeFrom = from;
      });
      if (
        simpleInsertion &&
        changeCount === 1 &&
        changeFrom === value.from &&
        insertedText !== "" &&
        value.text.startsWith(insertedText)
      ) {
        const text = value.text.slice(insertedText.length);
        return text === ""
          ? null
          : { from: value.from + insertedText.length, text };
      }
      return null;
    }
    if (
      transaction.selection != null &&
      (!transaction.selection.main.empty ||
        transaction.selection.main.from !== value.from)
    ) {
      return null;
    }
    return value;
  },
  provide: (field) =>
    EditorView.decorations.compute([field], (state) => {
      const suggestion = state.field(field);
      return suggestion == null
        ? Decoration.none
        : ghostTextDecorations(suggestion);
    }),
});

export function completionRequestContext(text: string, cursor: number) {
  const boundedCursor = Math.max(0, Math.min(cursor, text.length));
  const leftLines = text.slice(0, boundedCursor).split("\n");
  const rightLines = text.slice(boundedCursor).split("\n");
  return {
    leftContext: leftLines.slice(-11).join("\n"),
    rightContext: rightLines.slice(0, 3).join("\n"),
    maxLength: COMPLETION_MAX_LENGTH,
  };
}

function shouldTriggerOnInsertion(update: ViewUpdate) {
  if (!update.docChanged) return false;
  let insertedLength = 0;
  let simpleInsertion = true;
  update.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
    const text = inserted.toString();
    if (from !== to || text.includes("\n")) simpleInsertion = false;
    insertedLength += text.length;
  });
  return simpleInsertion && insertedLength > 0 && insertedLength <= 30;
}

async function requestCompletion(
  body: {
    connectionId: string;
    model: string;
    leftContext: string;
    rightContext: string;
    maxLength: number;
  },
  signal: AbortSignal,
): Promise<CompletionResult> {
  try {
    const projectId = getMeta("ol-project_id");
    const response = await fetch(
      `/project/${encodeURIComponent(projectId)}/ai-reviewer/completion`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "Content-Type": "application/json",
          "X-Csrf-Token": getMeta("ol-csrfToken"),
        },
        body: JSON.stringify(body),
        signal,
      },
    );
    const parsed: unknown = await response.json();
    if (
      !response.ok ||
      parsed == null ||
      typeof parsed !== "object" ||
      (parsed as { success?: unknown }).success !== true ||
      typeof (parsed as { data?: unknown }).data !== "string"
    ) {
      return { status: "failure" };
    }
    return { status: "success", data: (parsed as { data: string }).data };
  } catch (error) {
    return signal.aborted ||
      (error instanceof DOMException && error.name === "AbortError")
      ? { status: "aborted" }
      : { status: "failure" };
  }
}

class InlineCompletionPlugin {
  private debounceTimer: number | null = null;
  private requestController: AbortController | null = null;
  private requestSequence = 0;
  private consecutiveFailures = 0;
  private pausedUntil = 0;
  private composing = false;
  private readonly unsubscribe: () => void;

  private readonly compositionStart = () => {
    this.composing = true;
    this.cancel();
  };

  private readonly compositionEnd = () => {
    this.composing = false;
    this.debounce();
  };

  constructor(private readonly view: EditorView) {
    view.dom.addEventListener("compositionstart", this.compositionStart);
    view.dom.addEventListener("compositionend", this.compositionEnd);
    this.unsubscribe = subscribeToInlineCompletionState(() => this.cancel());
  }

  update(update: ViewUpdate) {
    if (
      this.composing ||
      !update.state.selection.main.empty ||
      inlineCompletionGate(getInlineCompletionState()) !== "active"
    ) {
      this.cancel();
      return;
    }
    if (update.selectionSet && !update.docChanged) {
      this.cancel();
      return;
    }
    if (update.docChanged) this.abortRequest();
    if (shouldTriggerOnInsertion(update)) {
      this.debounce();
    } else if (update.docChanged) {
      this.cancel();
    }
  }

  destroy() {
    this.unsubscribe();
    this.view.dom.removeEventListener(
      "compositionstart",
      this.compositionStart,
    );
    this.view.dom.removeEventListener("compositionend", this.compositionEnd);
    this.cancel();
  }

  accept() {
    const suggestion = this.view.state.field(suggestionField, false);
    if (
      suggestion == null ||
      inlineCompletionGate(getInlineCompletionState()) !== "active" ||
      this.view.state.selection.main.head !== suggestion.from
    ) {
      return false;
    }
    this.view.dispatch({
      changes: { from: suggestion.from, insert: suggestion.text },
      selection: { anchor: suggestion.from + suggestion.text.length },
      effects: setSuggestion.of(null),
    });
    return true;
  }

  private debounce() {
    if (this.debounceTimer != null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      void this.trigger();
    }, COMPLETION_DEBOUNCE_MS);
  }

  private async trigger() {
    this.debounceTimer = null;
    const state = getInlineCompletionState();
    const selection = this.view.state.selection.main;
    if (
      this.composing ||
      !selection.empty ||
      inlineCompletionGate(state) !== "active" ||
      state.selectedConnectionId == null ||
      state.selectedModel == null ||
      Date.now() < this.pausedUntil
    ) {
      return;
    }

    this.cancel();
    const requestId = ++this.requestSequence;
    const controller = new AbortController();
    this.requestController = controller;
    const cursor = selection.head;
    const documentText = this.view.state.doc.toString();
    const context = completionRequestContext(documentText, cursor);
    const connectionId = state.selectedConnectionId;
    const model = state.selectedModel;
    const result = await requestCompletion(
      {
        connectionId,
        model,
        ...context,
      },
      controller.signal,
    );

    if (
      controller.signal.aborted ||
      requestId !== this.requestSequence ||
      this.requestController !== controller
    ) {
      return;
    }
    this.requestController = null;
    if (result.status === "aborted") return;
    if (result.status === "failure") {
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= FAILURE_LIMIT) {
        // ponytail: in-memory damping, no UI surfacing yet
        this.pausedUntil = Date.now() + FAILURE_PAUSE_MS;
        this.consecutiveFailures = 0;
      }
      return;
    }
    this.consecutiveFailures = 0;
    const currentState = getInlineCompletionState();
    if (
      result.data === "" ||
      this.view.state.doc.toString() !== documentText ||
      this.view.state.selection.main.head !== cursor ||
      inlineCompletionGate(currentState) !== "active" ||
      currentState.selectedConnectionId !== connectionId ||
      currentState.selectedModel !== model
    ) {
      return;
    }
    this.view.dispatch({
      effects: setSuggestion.of({ from: cursor, text: result.data }),
    });
  }

  private cancel() {
    if (this.debounceTimer != null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.abortRequest();
    if (this.view.state.field(suggestionField, false) != null) {
      // cancel() can run inside plugin update(), where dispatch is illegal;
      // defer so the clear lands in its own transaction.
      window.setTimeout(() => {
        if (this.view.state.field(suggestionField, false) != null) {
          this.view.dispatch({ effects: setSuggestion.of(null) });
        }
      }, 0);
    }
  }

  private abortRequest() {
    this.requestSequence += 1;
    this.requestController?.abort();
    this.requestController = null;
  }
}

const inlineCompletionPlugin = ViewPlugin.define(
  (view) => new InlineCompletionPlugin(view),
);

const ghostTextTheme = EditorView.baseTheme({
  ".cm-ai-reviewer-ghost-text": {
    color: "#888",
    opacity: "0.45",
    pointerEvents: "none",
    whiteSpace: "pre-wrap",
  },
});

export function extension(_options: Record<string, unknown>): Extension {
  return [
    suggestionField,
    inlineCompletionPlugin,
    Prec.highest(
      keymap.of([
        {
          key: "Tab",
          run: (view) => view.plugin(inlineCompletionPlugin)?.accept() ?? false,
        },
      ]),
    ),
    ghostTextTheme,
  ];
}
