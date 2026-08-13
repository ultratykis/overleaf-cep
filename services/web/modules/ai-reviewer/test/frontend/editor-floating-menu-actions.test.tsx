import { EditorState } from "@codemirror/state";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect } from "chai";
import React from "react";
import sinon from "sinon";

import { CodeMirrorStateContext } from "@/features/source-editor/components/codemirror-context";
import { AiReviewerFloatingMenuActions } from "../../frontend/js/components/ai-reviewer-floating-menu-actions";
import { AiReviewerPanelView } from "../../frontend/js/components/ai-reviewer-panel";
import {
  aiReviewerSelectionActions,
  dispatchAiReviewerSelectionToolbarBusy,
} from "../../frontend/js/services/selection-toolbar-events";
import type { EditorSelectionSessionContext } from "../../frontend/js/services/editor-selection-session";

function selectionContext(state: EditorState) {
  return () =>
    ({
      path: "chapters/1_intro.tex",
      view: { state },
    }) as EditorSelectionSessionContext;
}

function FloatingMenuActions({ state }: { state: EditorState }) {
  return (
    <CodeMirrorStateContext.Provider value={state}>
      <AiReviewerFloatingMenuActions
        getSelectionContext={selectionContext(state)}
      />
    </CodeMirrorStateContext.Provider>
  );
}

describe("AI reviewer: editor floating menu actions", function () {
  afterEach(function () {
    dispatchAiReviewerSelectionToolbarBusy(false);
  });

  it("self-gates on the editor selection", async function () {
    const empty = EditorState.create({ doc: "alpha beta" });
    const { rerender } = render(<FloatingMenuActions state={empty} />);

    expect(screen.queryByRole("button", { name: "Review" })).not.to.exist;

    const selected = EditorState.create({
      doc: "alpha beta",
      selection: { anchor: 0, head: 5 },
    });
    rerender(<FloatingMenuActions state={selected} />);

    const toolbar = await screen.findByRole("toolbar", {
      name: "1_intro.tex L1–1 (1 word)",
    });
    expect(toolbar.getAttribute("title")).to.equal("1_intro.tex L1–1 (1 word)");
    expect(screen.getByRole("button", { name: "Review" })).to.exist;
  });

  it("routes Review, Rewrite, and Shorten through the panel selection handler", async function () {
    const captureSelectionSession = sinon.stub().resolves({
      status: "conflict",
      code: "AI_SELECTION_REQUIRED",
    });
    const selected = EditorState.create({
      doc: "alpha beta",
      selection: { anchor: 0, head: 5 },
    });
    render(
      <>
        <AiReviewerPanelView
          projectId="floating-menu-project"
          createRequestId={() =>
            `floating-menu-request-${captureSelectionSession.callCount}`
          }
          captureSelectionSession={captureSelectionSession}
        />
        <FloatingMenuActions state={selected} />
      </>,
    );

    for (const expected of aiReviewerSelectionActions) {
      const label = expected.labelKey
        .replace("ai_reviewer_action_", "")
        .replace(/^./u, (letter) => letter.toUpperCase());
      fireEvent.click(await screen.findByRole("button", { name: label }));
      await waitFor(() => {
        expect(captureSelectionSession.callCount).to.equal(
          aiReviewerSelectionActions.indexOf(expected) + 1,
        );
      });
      expect(captureSelectionSession.lastCall.args[0]).to.include({
        action: expected.action,
        instruction: expected.instruction,
      });
    }
  });

  it("disables every action while a run is busy, including after a late mount", async function () {
    dispatchAiReviewerSelectionToolbarBusy(true);
    const selected = EditorState.create({
      doc: "alpha beta",
      selection: { anchor: 0, head: 5 },
    });
    render(<FloatingMenuActions state={selected} />);

    for (const label of ["Review", "Rewrite", "Shorten"]) {
      expect(
        await screen.findByRole("button", { name: label }),
      ).to.have.property("disabled", true);
    }
  });

  it("renders the selection scope above the panel composer without action buttons", function () {
    render(
      <AiReviewerPanelView
        projectId="floating-menu-project"
        captureSelectionSession={sinon.stub()}
        selectionPreview={{
          filename: "1_intro.tex",
          fromLine: 18,
          toLine: 19,
          wordCount: 49,
        }}
      />,
    );

    const scope = screen.getByTestId("ai-reviewer-selection-scope");
    const composer = document.querySelector("#ai-reviewer-message-input");
    expect(composer).not.to.equal(null);
    expect(scope.textContent).to.equal("1_intro.tex L18–19 (49 words)");
    expect(scope.getAttribute("title")).to.equal(
      "1_intro.tex L18–19 (49 words)",
    );
    expect(
      scope.compareDocumentPosition(composer!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.to.equal(0);
    expect(screen.queryByRole("button", { name: "Review selection" })).not.to
      .exist;
    expect(screen.queryByRole("button", { name: "Rewrite selection" })).not.to
      .exist;
    expect(screen.queryByRole("button", { name: "Shorten selection" })).not.to
      .exist;
  });
});
