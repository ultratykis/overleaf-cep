const { expect } = require("chai");

const {
  initialSelectionWorkspaceState,
  reduceSelectionWorkspaceState,
} = require("../../frontend/js/services/selection-workspace-state");

const requestId = "request-posted-state";
const projectId = "project-posted-state";
const hash = "a".repeat(64);

function finding({
  id = "finding-posted-state",
  artifactKind = "finding",
  artifactRequestId = requestId,
} = {}) {
  return {
    id,
    requestId: artifactRequestId,
    projectId,
    severity: "warning",
    category: "synthetic",
    title: "Synthetic finding",
    message: "A deterministic finding.",
    evidence: [
      {
        path: "chapters/main.tex",
        range: { from: 0, to: 4 },
        revision: 7,
        textHash: hash,
      },
    ],
    suggestionIds: [],
    artifactKind,
    ...(artifactKind === "citation-finding"
      ? { proposedText: "Add a synthetic citation." }
      : {}),
  };
}

function suggestion({
  id = "suggestion-posted-state",
  artifactRequestId = requestId,
} = {}) {
  return {
    id,
    requestId: artifactRequestId,
    projectId,
    documentId: "document-posted-state",
    path: "chapters/main.tex",
    baseRevision: 7,
    baseTextHash: hash,
    range: { from: 0, to: 4 },
    original: "Text",
    replacement: "Copy",
    rationale: "Use a deterministic replacement.",
    evidence: [
      {
        path: "chapters/main.tex",
        range: { from: 0, to: 4 },
        revision: 7,
        textHash: hash,
      },
    ],
    provider: "fake",
    model: "deterministic-v1",
    skill: "line-edit",
    createdAt: "2026-07-26T00:00:00.000Z",
    status: "unresolved",
  };
}

function completedState({
  findings = [],
  suggestions = [],
  findingStatuses = {},
  suggestionStatuses = {},
} = {}) {
  return {
    ...initialSelectionWorkspaceState,
    status: "completed",
    generation: 7,
    requestId,
    findings,
    suggestions,
    findingStatuses,
    suggestionStatuses,
  };
}

function boundAction(action) {
  return {
    generation: 7,
    requestId,
    ...action,
  };
}

describe("AI reviewer selection workspace posted state", function () {
  it("posts only an unresolved matching ordinary finding", function () {
    const ordinary = finding();
    const state = completedState({
      findings: [ordinary],
      findingStatuses: {
        [ordinary.id]: "unresolved",
      },
    });
    const action = boundAction({
      type: "post-finding",
      findingId: ordinary.id,
    });

    const posted = reduceSelectionWorkspaceState(state, action);

    expect(posted).not.to.equal(state);
    expect(posted.findingStatuses[ordinary.id]).to.equal("posted");
    expect(reduceSelectionWorkspaceState(posted, action)).to.equal(posted);

    const mismatched = finding({
      id: "finding-other-request",
      artifactRequestId: "request-other",
    });
    const mismatchedState = completedState({
      findings: [mismatched],
      findingStatuses: {
        [mismatched.id]: "unresolved",
      },
    });

    expect(
      reduceSelectionWorkspaceState(
        mismatchedState,
        boundAction({
          type: "post-finding",
          findingId: mismatched.id,
        }),
      ),
    ).to.equal(mismatchedState);
  });

  it("rejects posting a citation finding", function () {
    const citation = finding({
      id: "citation-finding-posted-state",
      artifactKind: "citation-finding",
    });
    const state = completedState({
      findings: [citation],
      findingStatuses: {
        [citation.id]: "unresolved",
      },
    });

    expect(
      reduceSelectionWorkspaceState(
        state,
        boundAction({
          type: "post-finding",
          findingId: citation.id,
        }),
      ),
    ).to.equal(state);
    expect(state.findingStatuses[citation.id]).to.equal("unresolved");
  });

  it("posts only an unresolved matching suggestion", function () {
    const unresolved = suggestion();
    const state = completedState({
      suggestions: [unresolved],
      suggestionStatuses: {
        [unresolved.id]: "unresolved",
      },
    });
    const action = boundAction({
      type: "post-suggestion",
      suggestionId: unresolved.id,
    });

    const posted = reduceSelectionWorkspaceState(state, action);

    expect(posted).not.to.equal(state);
    expect(posted.suggestionStatuses[unresolved.id]).to.equal("posted");
    expect(reduceSelectionWorkspaceState(posted, action)).to.equal(posted);

    const mismatched = suggestion({
      id: "suggestion-other-request",
      artifactRequestId: "request-other",
    });
    const mismatchedState = completedState({
      suggestions: [mismatched],
      suggestionStatuses: {
        [mismatched.id]: "unresolved",
      },
    });

    expect(
      reduceSelectionWorkspaceState(
        mismatchedState,
        boundAction({
          type: "post-suggestion",
          suggestionId: mismatched.id,
        }),
      ),
    ).to.equal(mismatchedState);
  });
});
