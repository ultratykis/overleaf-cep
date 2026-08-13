import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { expect } from "chai";
import React from "react";
import sinon from "sinon";

import { AiReviewerPanelView } from "../../frontend/js/components/ai-reviewer-panel";
import { AiReviewerSelectionToolbarActions } from "../../frontend/js/components/ai-reviewer-selection-toolbar";
import {
  aiReviewerSelectionActions,
  aiReviewerSelectionTooltipStateField,
  extension,
} from "../../frontend/js/extensions/selection-tooltip";
import { runSelectionAction } from "./helpers/selection-toolbar";

describe("AI reviewer: editor selection tooltip", function () {
  it("shows above a non-empty selection with room for Add comment", function () {
    let state = EditorState.create({
      doc: "alpha beta",
      extensions: [extension()],
    });

    expect(state.field(aiReviewerSelectionTooltipStateField).tooltip).to.equal(
      null,
    );
    state = state.update({
      selection: { anchor: 0, head: 5 },
      userEvent: "select",
    }).state;

    const tooltip = state.field(aiReviewerSelectionTooltipStateField).tooltip;
    expect(tooltip).not.to.equal(null);
    expect(tooltip?.above).to.equal(true);
    const tooltipView = tooltip?.create({} as never);
    expect(tooltipView?.dom.className).to.equal(
      "ai-reviewer-selection-tooltip-container",
    );
    expect(tooltipView?.offset).to.deep.equal({ x: 0, y: 48 });

    state = state.update({
      selection: { anchor: 5 },
      userEvent: "select",
    }).state;
    expect(state.field(aiReviewerSelectionTooltipStateField).tooltip).to.equal(
      null,
    );
  });

  it("routes Review, Rewrite, and Shorten through the panel selection handler", async function () {
    const captureSelectionSession = sinon.stub().resolves({
      status: "conflict",
      code: "AI_SELECTION_REQUIRED",
    });
    render(
      <>
        <AiReviewerPanelView
          projectId="selection-tooltip-project"
          createRequestId={() =>
            `selection-tooltip-request-${captureSelectionSession.callCount}`
          }
          captureSelectionSession={captureSelectionSession}
        />
        <AiReviewerSelectionToolbarActions
          disabled={false}
          onAction={runSelectionAction}
        />
      </>,
    );

    for (const expected of aiReviewerSelectionActions) {
      fireEvent.click(
        screen.getByRole("button", {
          name: expected.labelKey
            .replace("ai_reviewer_action_", "")
            .replace(/^./u, (letter) => letter.toUpperCase()),
        }),
      );
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

  it("disables every toolbar action while a run is busy", function () {
    render(
      <AiReviewerSelectionToolbarActions disabled onAction={sinon.stub()} />,
    );

    for (const label of ["Review", "Rewrite", "Shorten"]) {
      expect(screen.getByRole("button", { name: label })).to.have.property(
        "disabled",
        true,
      );
    }
  });
});
