import { Extension, Facet } from "@codemirror/state";

export type AiReviewerDocumentIdentity = {
  documentId: string;
  currentDocument: object;
};

type SourceEditorExtensionOptions = {
  currentDoc: {
    currentDocument: {
      doc_id: string;
    } | null;
  };
};

export const aiReviewerDocumentIdentity = Facet.define<
  AiReviewerDocumentIdentity,
  AiReviewerDocumentIdentity | null
>({
  combine(values) {
    return values.at(-1) ?? null;
  },
});

export function extension(options: SourceEditorExtensionOptions): Extension {
  const currentDocument = options.currentDoc.currentDocument;
  if (currentDocument == null) {
    return [];
  }
  return aiReviewerDocumentIdentity.of({
    documentId: currentDocument.doc_id,
    currentDocument,
  });
}
