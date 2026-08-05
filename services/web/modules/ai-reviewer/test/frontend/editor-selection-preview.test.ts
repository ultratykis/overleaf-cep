import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { expect } from "chai";

import {
  countEditorSelectionWords,
  readEditorSelectionScopeDescriptor,
} from "../../frontend/js/hooks/use-editor-selection-preview";
import type { EditorSelectionSessionContext } from "../../frontend/js/services/editor-selection-session";

function selectionContext({
  doc,
  from,
  to,
  path = "chapters/main.tex",
}: {
  doc: string;
  from: number;
  to: number;
  path?: string;
}) {
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: from, head: to },
    }),
  });
  const context: EditorSelectionSessionContext = {
    view,
    projectId: "selection-preview-project",
    currentDocumentId: "selection-preview-document",
    path,
    currentDocument: null,
    sourceMode: true,
    connected: true,
    connectionEpoch: 1,
    permissions: { read: true, write: true, trackedWrite: true },
    trackChanges: false,
    wantTrackChanges: false,
  };
  return { context, view };
}

describe("AI reviewer: editor selection scope descriptor", function () {
  it("does not count the trailing empty line when the selection ends at a line start", function () {
    const doc = "first words\nsecond line\nthird line";
    const to = doc.indexOf("third line");
    const { context, view } = selectionContext({ doc, from: 0, to });

    expect(readEditorSelectionScopeDescriptor(context)).to.deep.equal({
      filename: "main.tex",
      fromLine: 1,
      toLine: 2,
      wordCount: 4,
    });
    view.destroy();
  });

  it("counts CJK segments while excluding LaTeX control sequence names", function () {
    const text = String.raw`\textbf{日本語の文章を査読する} with \cite{Key2024}`;
    const { context, view } = selectionContext({
      doc: text,
      from: 0,
      to: text.length,
    });

    expect(countEditorSelectionWords(text)).to.equal(8);
    expect(readEditorSelectionScopeDescriptor(context)).to.deep.include({
      filename: "main.tex",
      fromLine: 1,
      toLine: 1,
      wordCount: 8,
    });
    view.destroy();
  });
});
