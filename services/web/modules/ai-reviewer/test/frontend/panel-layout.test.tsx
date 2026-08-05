import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect } from "chai";
import React from "react";
import sinon from "sinon";

import { AiReviewerPanelView } from "../../frontend/js/components/ai-reviewer-panel";
import {
  AgentStreamError,
  streamAgentEvents,
} from "../../frontend/js/services/agent-stream";

type StreamCall = Parameters<typeof streamAgentEvents>[0];

const projectId = "panel-layout-project";
const createdAt = "2026-07-26T00:00:00.000Z";
const emptyState =
  "Review a selection, document, or project, then discuss the results here.";
const publicFailureGuidanceCases = [
  {
    code: "AI_REQUEST_ABORTED",
    category: "aborted",
    retryable: false,
    guidance:
      "The AI reviewer request was cancelled. Run it again if you still need the result.",
  },
  {
    code: "AI_PROVIDER_AUTHENTICATION_ERROR",
    category: "authentication",
    retryable: false,
    guidance:
      "The AI provider rejected the credentials. Check the credential in AI Reviewer settings, then try again.",
  },
  {
    code: "AI_PROVIDER_NOT_CONFIGURED",
    category: "configuration",
    retryable: false,
    guidance:
      "AI Reviewer is not configured correctly. Check the provider and model in AI Reviewer settings, then try again.",
  },
  {
    code: "AI_PROVIDER_NETWORK_ERROR",
    category: "network",
    retryable: true,
    guidance:
      "AI Reviewer could not reach the provider. Check the provider endpoint and network connection, then try again.",
  },
  {
    code: "AI_PROJECT_CONTENT_NOT_AVAILABLE",
    category: "configuration",
    retryable: false,
    guidance:
      "AI Reviewer could not read the project content. Try narrowing the review scope or check that the project files are available.",
  },
  {
    code: "AI_PROVIDER_ERROR",
    category: "provider",
    retryable: true,
    guidance:
      "The AI provider could not complete the request. Try again; if it keeps failing, switch models or check the AI Reviewer settings.",
  },
  {
    code: "AI_PROVIDER_RATE_LIMITED",
    category: "rate-limit",
    retryable: true,
    guidance:
      "The AI provider rate limit was reached. Wait a little, then try again.",
  },
  {
    code: "AI_STREAM_PROTOCOL_ERROR",
    category: "schema",
    retryable: false,
    guidance:
      "AI Reviewer could not use the model response. Try narrowing the review scope, switching to a more capable model, or checking the AI Reviewer settings.",
  },
  {
    code: "AI_REQUEST_TIMEOUT",
    category: "timeout",
    retryable: true,
    guidance:
      "The AI reviewer request timed out. Try again or narrow the review scope.",
  },
  {
    code: "AI_PROVIDER_ERROR",
    category: "unknown",
    retryable: true,
    guidance:
      "AI Reviewer could not complete the request. Try again; if it keeps failing, check the AI Reviewer settings.",
  },
] as const;

function emitCompletedReview(call: StreamCall) {
  call.onEvent({
    type: "started",
    eventId: "panel-layout-started",
    requestId: call.request.requestId,
    sequence: 0,
    createdAt,
    provider: "fake",
    model: "deterministic-v1",
    skill: call.request.skill,
  });
  call.onEvent({
    type: "completed",
    eventId: "panel-layout-completed",
    requestId: call.request.requestId,
    sequence: 1,
    createdAt,
    finishReason: "stop",
  });
}

function renderPanel(
  props: Partial<React.ComponentProps<typeof AiReviewerPanelView>> = {},
) {
  return render(<AiReviewerPanelView projectId={projectId} {...props} />);
}

function primaryControls(container: HTMLElement) {
  return [...container.querySelectorAll<HTMLButtonElement>(".btn-primary")];
}

describe("AI reviewer: panel layout", function () {
  it("shows the one-line empty state before any run and keeps controls at the bottom", function () {
    const { container } = renderPanel({
      captureSelectionSession: sinon.stub(),
      captureDocumentSession: sinon.stub(),
    });

    const panel = screen.getByTestId("ai-reviewer-panel");
    const header = panel.querySelector(".ai-reviewer-panel-header");
    const bottomControls = screen.getByTestId("ai-reviewer-bottom-controls");
    const empty = screen.getByText(emptyState);
    const composer = screen
      .getByRole("textbox", { name: "Discussion message" })
      .closest(".ai-reviewer-panel-composer-input");
    const send = screen.getByRole("button", { name: "Send message" });

    expect(header).not.to.equal(null);
    if (header == null) {
      throw new Error("The panel header must render.");
    }
    expect(empty.closest(".ai-reviewer-panel-body")).not.to.equal(null);
    expect(
      header.compareDocumentPosition(bottomControls) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).to.not.equal(0);
    expect(primaryControls(container)).to.have.length(1);
    expect(primaryControls(container)[0]).to.equal(
      screen.getByRole("button", { name: "Review selection" }),
    );
    expect(composer).not.to.equal(null);
    if (composer == null) {
      throw new Error("The discussion composer input must render.");
    }
    expect(
      within(composer).getByRole("button", { name: "Send message" }),
    ).to.equal(send);
    expect(send.classList.contains("icon-button-small")).to.equal(true);
    expect(send.classList.contains("ai-reviewer-panel-send")).to.equal(true);
    expect(send.textContent).to.equal("send");
  });

  it("renders selection-only transforms only for the selection scope", function () {
    const { container } = renderPanel({
      captureSelectionSession: sinon.stub(),
      captureDocumentSession: sinon.stub(),
    });
    const scope = screen.getByRole("combobox", {
      name: "Review scope",
    });

    expect(screen.getByTestId("ai-reviewer-selection-transforms")).to.exist;
    const rewrite = screen.getByRole("button", {
      name: "Rewrite selection",
    });
    const shorten = screen.getByRole("button", {
      name: "Shorten selection",
    });
    expect(rewrite.classList.contains("btn-link")).to.equal(true);
    expect(rewrite.classList.contains("btn-inline-link")).to.equal(true);
    expect(rewrite.classList.contains("btn-secondary")).to.equal(false);
    expect(shorten.classList.contains("btn-link")).to.equal(true);
    expect(shorten.classList.contains("btn-inline-link")).to.equal(true);
    expect(shorten.classList.contains("btn-secondary")).to.equal(false);
    expect(primaryControls(container)).to.have.length(1);

    fireEvent.change(scope, { target: { value: "document" } });
    expect(screen.queryByTestId("ai-reviewer-selection-transforms")).not.to
      .exist;
    expect(screen.queryByRole("button", { name: "Rewrite selection" })).not.to
      .exist;
    expect(screen.queryByRole("button", { name: "Shorten selection" })).not.to
      .exist;
    expect(screen.getByRole("button", { name: "Review current document" })).to
      .exist;
    expect(primaryControls(container)).to.have.length(1);

    fireEvent.change(scope, { target: { value: "project" } });
    expect(screen.queryByTestId("ai-reviewer-selection-transforms")).not.to
      .exist;
    expect(screen.queryByRole("button", { name: "Rewrite selection" })).not.to
      .exist;
    expect(screen.queryByRole("button", { name: "Shorten selection" })).not.to
      .exist;
    expect(screen.getByRole("button", { name: "Run review" })).to.exist;
    expect(primaryControls(container)).to.have.length(1);
  });

  it("suppresses the bottom controls during a run and keeps cancel in its header", async function () {
    const streamRequest = sinon.stub().callsFake(
      ({ signal }: StreamCall) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
    );
    renderPanel({ streamRequest });

    fireEvent.click(screen.getByRole("button", { name: "Run review" }));
    const run = await screen.findByRole("article", { name: "Review run 1" });

    expect(screen.queryByTestId("ai-reviewer-bottom-controls")).not.to.exist;
    expect(
      within(run).getByRole("button", {
        name: "Cancel",
      }),
    ).to.exist;
    expect(screen.queryByRole("combobox", { name: "Review scope" })).not.to
      .exist;
    expect(screen.queryByRole("textbox", { name: "Discussion message" })).not.to
      .exist;

    fireEvent.click(within(run).getByRole("button", { name: "Cancel" }));
    await screen.findByText("Cancelled");
    expect(screen.getByTestId("ai-reviewer-bottom-controls")).to.exist;
  });

  it("keeps reset out of the main flow and requires confirmation", async function () {
    const streamRequest = sinon.stub().callsFake(async (call: StreamCall) => {
      emitCompletedReview(call);
    });
    renderPanel({ streamRequest });

    fireEvent.click(screen.getByRole("button", { name: "Run review" }));
    await screen.findByText("Completed");
    expect(
      screen.queryByRole("menuitem", {
        name: "Delete all saved review work",
      }),
    ).not.to.exist;

    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: "Delete all saved review work",
      }),
    );

    expect(screen.getByLabelText("Review run 1")).to.exist;
    expect(await screen.findByText("Delete all saved review work?")).to.exist;
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(screen.queryByLabelText("Review run 1")).not.to.exist;
    });
    expect(screen.getByText(emptyState)).to.exist;
  });

  for (const failure of publicFailureGuidanceCases) {
    it(`shows actionable ${failure.category} guidance from stable public metadata`, async function () {
      const boundedMessage = `Bounded public ${failure.category} failure wording.`;
      const streamRequest = sinon.stub().rejects(
        new AgentStreamError({
          code: failure.code,
          category: failure.category,
          message: boundedMessage,
          retryable: failure.retryable,
        }),
      );
      renderPanel({ streamRequest });

      fireEvent.click(screen.getByRole("button", { name: "Run review" }));
      const alert = await screen.findByRole("alert");

      expect(alert.textContent).to.equal(failure.guidance);
      expect(alert.textContent).not.to.include(failure.code);
      expect(alert.textContent).not.to.include(boundedMessage);
    });
  }
});
