const {
  fireEvent,
  render,
  screen,
  waitFor,
} = require("@testing-library/react");
const { expect } = require("chai");
const React = require("react");
const { useTranslation } = require("react-i18next");
const sinon = require("sinon");

const {
  AiIntegrationCard,
  createAiIntegrationCard,
} = require("../../frontend/js/components/ai-integration-card");
const {
  AiReviewerPanelView,
} = require("../../frontend/js/components/ai-reviewer-panel");
const {
  createAiReviewerRailEntry,
} = require("../../frontend/js/components/ai-reviewer-rail-entry");
const {
  streamAgentEvents,
} = require("../../frontend/js/services/agent-stream");

const createdAt = "2026-07-24T00:00:00.000Z";

function request() {
  return {
    requestId: "request-0001",
    projectId: "project-0001",
    action: "review",
    instruction: "Review the selected phrase.",
    skill: "referee-review",
    scope: {
      kind: "selection",
      documentId: "document-0001",
      path: "main.tex",
      baseRevision: 1,
      baseTextHash: "a".repeat(64),
      range: { from: 0, to: 4 },
      text: "Body",
    },
  };
}

async function captureSelectionSession() {
  return {
    status: "ready",
    session: Object.freeze({
      request: Object.freeze(request()),
      binding: Object.freeze({
        currentDocument: {},
        shareDocument: {},
        trackChanges: false,
      }),
    }),
  };
}

function events() {
  return [
    {
      type: "started",
      eventId: "event-0001",
      requestId: "request-0001",
      sequence: 0,
      createdAt,
      provider: "fake",
      model: "deterministic-v1",
      skill: "referee-review",
    },
    {
      type: "text.delta",
      eventId: "event-0002",
      requestId: "request-0001",
      sequence: 1,
      createdAt,
      delta: "Synthetic review.",
    },
    {
      type: "completed",
      eventId: "event-0003",
      requestId: "request-0001",
      sequence: 2,
      createdAt,
      finishReason: "stop",
    },
  ];
}

function responseForEvents() {
  const encoder = new TextEncoder();
  const payload = `${events()
    .map((event) => JSON.stringify(event))
    .join("\n")}\n`;
  const splitAt = payload.indexOf("\n") + 7;
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(payload.slice(0, splitAt)));
        controller.enqueue(encoder.encode(payload.slice(splitAt)));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/x-ndjson; charset=utf-8",
      },
    },
  );
}

describe("AI reviewer: module shell", function () {
  it("renders a missing translation key instead of a blank label", function () {
    const missingKey = "ai_reviewer_intentionally_missing_translation";
    const MissingTranslation = () => {
      const { t } = useTranslation();
      return React.createElement("span", null, t(missingKey));
    };

    render(React.createElement(MissingTranslation));

    expect(screen.getByText(missingKey).textContent).to.equal(missingKey);
  });

  it("parses a typed incremental NDJSON stream with authenticated fetch headers", async function () {
    const fetchImpl = sinon.stub().resolves(responseForEvents());
    const received = [];

    await streamAgentEvents({
      projectId: "project-0001",
      request: request(),
      signal: new AbortController().signal,
      csrfToken: "synthetic-csrf",
      fetchImpl,
      onEvent: (event) => received.push(event),
    });

    expect(received).to.deep.equal(events());
    expect(fetchImpl.calledOnce).to.equal(true);
    const [url, options] = fetchImpl.firstCall.args;
    expect(url).to.equal("/project/project-0001/ai-reviewer/stream");
    expect(options).to.include({
      method: "POST",
      credentials: "same-origin",
    });
    expect(options.headers).to.deep.include({
      "Content-Type": "application/json",
      "X-Csrf-Token": "synthetic-csrf",
      Accept: "application/x-ndjson, application/json",
    });
    expect(JSON.parse(String(options.body))).to.deep.equal(request());
  });

  it("does not start a request until the user explicitly runs review", async function () {
    const streamRequest = sinon.stub().callsFake(async ({ onEvent }) => {
      for (const event of events()) {
        onEvent(event);
      }
    });

    render(
      React.createElement(AiReviewerPanelView, {
        projectId: "project-0001",
        createRequestId: () => "request-0001",
        captureSelectionSession,
        selectionPreview: {
          filename: "main.tex",
          fromLine: 1,
          toLine: 1,
          wordCount: 1,
        },
        streamRequest,
      }),
    );

    expect(streamRequest.called).to.equal(false);
    fireEvent.click(screen.getByRole("button", { name: "Review selection" }));

    await screen.findByText("Synthetic review.");
    expect(screen.getByText("Completed")).to.exist;
    expect(streamRequest.calledOnce).to.equal(true);
  });

  it("cancels and discards a deliberately late event", async function () {
    let releaseLateEvent = () => {};
    const streamRequest = sinon.stub().callsFake(
      ({ onEvent }) =>
        new Promise((resolve) => {
          releaseLateEvent = () => {
            onEvent(events()[1]);
            resolve();
          };
        }),
    );

    render(
      React.createElement(AiReviewerPanelView, {
        projectId: "project-0001",
        createRequestId: () => "request-0001",
        captureSelectionSession,
        selectionPreview: {
          filename: "main.tex",
          fromLine: 1,
          toLine: 1,
          wordCount: 1,
        },
        streamRequest,
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Review selection" }));
    await screen.findByText("Streaming");
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    releaseLateEvent();

    await waitFor(() => expect(screen.getByText("Cancelled")).to.exist);
    expect(screen.queryByText("Synthetic review.")).not.to.exist;
  });
});

describe("AI reviewer: feature off lazy shells", function () {
  it("does not load the rail panel or integrations details", function () {
    const loadPanel = sinon.stub();
    const loadDetails = sinon.stub();

    const railEntry = createAiReviewerRailEntry({
      enabled: false,
      loadPanel,
    });
    const integrationCard = createAiIntegrationCard({
      enabled: false,
      loadDetails,
    });
    const { container } = render(
      React.createElement(AiIntegrationCard, {
        enabled: false,
        loadDetails,
      }),
    );

    expect(railEntry.hide).to.equal(true);
    expect(railEntry.component).to.equal(null);
    expect(integrationCard).to.equal(null);
    expect(container.childElementCount).to.equal(0);
    expect(loadPanel.called).to.equal(false);
    expect(loadDetails.called).to.equal(false);
  });
});
