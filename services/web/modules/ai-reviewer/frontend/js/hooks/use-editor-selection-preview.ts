import { useEffect, useState } from "react";

import type { EditorSelectionSessionContext } from "../services/editor-selection-session";

export type EditorSelectionScopeDescriptor = Readonly<{
  filename: string;
  fromLine: number;
  toLine: number;
  wordCount: number;
}>;

const latexControlSequence = /\\(?:[A-Za-z@]+\*?|[^\s])/gu;
const cjkOrWord =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]|[\p{L}\p{N}]+(?:[’'_-][\p{L}\p{N}]+)*/gu;

export function countEditorSelectionWords(text: string) {
  const visibleText = text.replace(latexControlSequence, " ");
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
    let count = 0;
    for (const segment of segmenter.segment(visibleText)) {
      if (segment.isWordLike) {
        count += 1;
      }
    }
    return count;
  }

  return [...visibleText.matchAll(cjkOrWord)].length;
}

function filenameFromPath(path: string | null) {
  return path?.split("/").at(-1) || "text";
}

export function readEditorSelectionScopeDescriptor(
  context: EditorSelectionSessionContext,
): EditorSelectionScopeDescriptor | null {
  const { view } = context;
  const range = view?.state.selection.main;
  if (view == null || range == null || range.empty) {
    return null;
  }

  const document = view.state.doc;
  const inclusiveEnd =
    range.to > range.from && document.lineAt(range.to).from === range.to
      ? range.to - 1
      : range.to;
  const selectedText = view.state.sliceDoc(range.from, range.to);
  return Object.freeze({
    filename: filenameFromPath(context.path),
    fromLine: document.lineAt(range.from).number,
    toLine: document.lineAt(inclusiveEnd).number,
    wordCount: countEditorSelectionWords(selectedText),
  });
}

/**
 * Selection actions only make sense while text is selected, so the floating
 * toolbar needs the selection as it changes rather than at capture time.
 * CodeMirror mirrors its selection into the DOM, so the document event is
 * enough and the tooltip extension remains concerned only with placement.
 */
export function useEditorSelectionPreview(
  getContext: () => EditorSelectionSessionContext,
) {
  const [preview, setPreview] = useState<EditorSelectionScopeDescriptor | null>(
    null,
  );

  useEffect(() => {
    const read = () => {
      setPreview(readEditorSelectionScopeDescriptor(getContext()));
    };
    read();
    document.addEventListener("selectionchange", read);
    return () => document.removeEventListener("selectionchange", read);
  }, [getContext]);

  return preview;
}
