const { expect } = require("chai");

const {
  SingleDocumentSuggestionError,
  discardSingleDocumentSuggestion,
  prepareSingleDocumentSuggestion,
  preflightSingleDocumentSuggestion,
} = require("../../frontend/js/services/single-document-suggestions");

const createdAt = "2026-07-24T00:00:00.000Z";
const baseText = "Alpha beta gamma.";
const baseTextHash =
  "aea23d46109af9b94c5f15085d69113cc2cefa85f05748897a4df172a1ee5104";

function request(overrides = {}) {
  return {
    requestId: "request-0001",
    projectId: "project-0001",
    action: "rewrite",
    instruction: "Rewrite the selected phrase.",
    skill: "line-edit",
    scope: {
      kind: "selection",
      documentId: "document-0001",
      path: "main.tex",
      baseRevision: 7,
      baseTextHash,
      range: {
        from: 6,
        to: 10,
      },
      text: "beta",
    },
    ...overrides,
  };
}

function evidence(overrides = {}) {
  return {
    path: "main.tex",
    range: {
      from: 6,
      to: 10,
    },
    revision: 7,
    textHash: baseTextHash,
    ...overrides,
  };
}

function suggestion(overrides = {}) {
  return {
    id: "suggestion-0001",
    requestId: "request-0001",
    projectId: "project-0001",
    documentId: "document-0001",
    path: "main.tex",
    baseRevision: 7,
    baseTextHash,
    range: {
      from: 6,
      to: 10,
    },
    original: "beta",
    replacement: "clear",
    rationale: "Use a more precise synthetic term.",
    evidence: [evidence()],
    provider: "fake",
    model: "deterministic-v1",
    skill: "line-edit",
    createdAt,
    status: "unresolved",
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    projectId: "project-0001",
    documentId: "document-0001",
    path: "main.tex",
    revision: 7,
    textHash: baseTextHash,
    text: baseText,
    connected: true,
    ...overrides,
  };
}

describe("AI reviewer: single document", function () {
  it("keeps a validated rewrite read-only until explicit acceptance preflight", function () {
    const source = snapshot();
    const prepared = prepareSingleDocumentSuggestion({
      request: request(),
      suggestion: suggestion(),
    });

    expect(prepared.status).to.equal("unresolved");
    expect(source.text).to.equal(baseText);

    const result = preflightSingleDocumentSuggestion({
      request: request(),
      suggestion: prepared,
      snapshot: source,
    });

    expect(result).to.deep.equal({
      status: "ready",
      change: {
        from: 6,
        to: 10,
        insert: "clear",
      },
      userEvent: "input.ai-reviewer.accept",
    });
    expect(source.text).to.equal(baseText);
  });

  it("discards a proposed rewrite without returning a document change", function () {
    const discarded = discardSingleDocumentSuggestion(
      prepareSingleDocumentSuggestion({
        request: request(),
        suggestion: suggestion(),
      }),
    );

    expect(discarded.status).to.equal("discarded");
    expect(discarded).not.to.have.property("change");
  });
});

describe("AI reviewer: OT safety", function () {
  const staleCases = [
    [
      "project",
      { projectId: "project-other" },
      "AI_SUGGESTION_PROJECT_CHANGED",
    ],
    [
      "document",
      { documentId: "document-other" },
      "AI_SUGGESTION_DOCUMENT_CHANGED",
    ],
    ["path", { path: "other.tex" }, "AI_SUGGESTION_DOCUMENT_CHANGED"],
    ["revision", { revision: 8 }, "AI_SUGGESTION_REVISION_STALE"],
    ["hash", { textHash: "b".repeat(64) }, "AI_SUGGESTION_HASH_STALE"],
    ["range", { text: "Alpha be" }, "AI_SUGGESTION_ORIGINAL_STALE"],
    ["offline state", { connected: false }, "AI_EDITOR_OFFLINE"],
  ];

  for (const [name, snapshotOverride, expectedCode] of staleCases) {
    it(`fails closed after a ${name} change`, function () {
      const result = preflightSingleDocumentSuggestion({
        request: request(),
        suggestion: prepareSingleDocumentSuggestion({
          request: request(),
          suggestion: suggestion(),
        }),
        snapshot: snapshot(snapshotOverride),
      });

      expect(result).to.deep.equal({
        status: "conflict",
        code: expectedCode,
      });
    });
  }
});

describe("AI reviewer: single document malformed schema", function () {
  const evidenceMismatchCases = [
    ["path", { path: "other.tex" }],
    [
      "range",
      {
        range: {
          from: 5,
          to: 6,
        },
      },
    ],
    ["revision", { revision: 999 }],
    ["hash", { textHash: "b".repeat(64) }],
    ["missing selection range", { range: undefined }],
  ];

  it("rejects malformed output before it becomes a previewable suggestion", function () {
    const malformed = {
      ...suggestion(),
      unexpectedWritePermission: true,
    };

    expect(() =>
      prepareSingleDocumentSuggestion({
        request: request(),
        suggestion: malformed,
      }),
    )
      .to.throw(SingleDocumentSuggestionError)
      .with.property("code", "AI_SUGGESTION_SCHEMA_INVALID");
  });

  it("rejects a structurally valid suggestion bound to another request", function () {
    expect(() =>
      prepareSingleDocumentSuggestion({
        request: request(),
        suggestion: suggestion({
          requestId: "request-other",
        }),
      }),
    )
      .to.throw(SingleDocumentSuggestionError)
      .with.property("code", "AI_SUGGESTION_REQUEST_MISMATCH");
  });

  for (const [name, evidenceOverride] of evidenceMismatchCases) {
    it(`rejects an evidence ${name} mismatch in isolation`, function () {
      expect(() =>
        prepareSingleDocumentSuggestion({
          request: request(),
          suggestion: suggestion({
            evidence: [evidence(evidenceOverride)],
          }),
        }),
      )
        .to.throw(SingleDocumentSuggestionError)
        .with.property("code", "AI_SUGGESTION_EVIDENCE_MISMATCH");
    });
  }
});
