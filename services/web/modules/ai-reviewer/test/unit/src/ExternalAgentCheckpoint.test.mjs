import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { createExternalAgentCheckpoint } from "../../../app/src/ExternalAgentCheckpoint.mjs";

const projectId = "project-checkpoint-0001";
const documentId = "document-checkpoint-0001";
const path = "sections/main.tex";
const text = "Before 😀 selected text after.";
const selectionText = "selected text";
const selectionFrom = text.indexOf(selectionText);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function rawSnapshot({
  snapshotText = text,
  snapshotPath = path,
  extraUnmappedFile = false,
} = {}) {
  return {
    files: {
      [snapshotPath]: { content: snapshotText },
      ...(extraUnmappedFile
        ? { "unmapped.tex": { content: "not in v2DocVersions" } }
        : {}),
    },
    projectVersion: "12.4",
    timestamp: "2026-08-07T00:00:00.000Z",
  };
}

function versionInfo(
  version = 57,
  { snapshotDocumentId = documentId, snapshotPath = path, revision = 6 } = {},
) {
  return {
    version,
    docVersions: {
      [snapshotDocumentId]: { pathname: snapshotPath, v: revision },
    },
  };
}

function request(kind = "document") {
  return {
    requestId: "request-checkpoint-0001",
    projectId,
    action: "review",
    instruction: "Review this text.",
    skill: null,
    scope:
      kind === "selection"
        ? {
            kind,
            documentId,
            path,
            baseRevision: 7,
            baseTextHash: sha256(text),
            range: {
              from: selectionFrom,
              to: selectionFrom + selectionText.length,
            },
            text: selectionText,
          }
        : {
            kind,
            documentId,
            path,
            baseRevision: 7,
            baseTextHash: sha256(text),
            text,
          },
  };
}

function historyManager(snapshot = rawSnapshot(), latest = versionInfo()) {
  return {
    ensureNoResyncPending: vi.fn().mockResolvedValue(undefined),
    getLatestVersionInfo: vi.fn().mockResolvedValue(latest),
    getContentAtVersion: vi.fn().mockResolvedValue(snapshot),
  };
}

async function captureError(operation) {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the operation to reject.");
}

describe("AI reviewer external History checkpoint", function () {
  it("binds a document request in the required order with one AbortSignal", async function () {
    const signal = new AbortController().signal;
    const order = [];
    const history = {
      ensureNoResyncPending: vi.fn(async () => order.push("resync")),
      getLatestVersionInfo: vi.fn(async () => {
        order.push("latest");
        return versionInfo();
      }),
      getContentAtVersion: vi.fn(async () => {
        order.push("content");
        return rawSnapshot();
      }),
    };

    const checkpoint = await createExternalAgentCheckpoint(request(), {
      historyManager: history,
      signal,
    });

    expect(checkpoint.historyVersion).toBe(57);
    expect(checkpoint.documents[0]).toMatchObject({
      documentId,
      path,
      revision: 7,
      text,
      textHash: sha256(text),
    });
    expect(order).toEqual(["resync", "latest", "content", "resync"]);
    expect(history.ensureNoResyncPending).toHaveBeenNthCalledWith(
      1,
      projectId,
      {
        signal,
      },
    );
    expect(history.ensureNoResyncPending).toHaveBeenNthCalledWith(
      2,
      projectId,
      {
        signal,
      },
    );
    expect(history.getLatestVersionInfo).toHaveBeenCalledWith(projectId, {
      signal,
    });
    expect(history.getContentAtVersion).toHaveBeenCalledWith(projectId, 57, {
      signal,
    });
  });

  it("binds a selection to the exact UTF-16 range", async function () {
    const checkpoint = await createExternalAgentCheckpoint(
      request("selection"),
      { historyManager: historyManager() },
    );

    expect(checkpoint.documents[0].text).toBe(text);
  });

  it("binds the target while omitting an unrelated oversized History file", async function () {
    const oversizedMarker = "oversized-body-must-not-cross";
    const snapshot = {
      ...rawSnapshot(),
      files: {
        ...rawSnapshot().files,
        "acmart.dtx": {
          content: oversizedMarker + "x".repeat(200_001),
        },
      },
      v2DocVersions: {
        [documentId]: { pathname: path, v: 6 },
        "document-oversized-template": { pathname: "acmart.dtx", v: 2 },
      },
    };
    const history = historyManager(snapshot);

    const checkpoint = await createExternalAgentCheckpoint(request(), {
      historyManager: history,
    });

    expect(checkpoint.documents).toHaveLength(1);
    expect(checkpoint.documents[0]).toMatchObject({
      documentId,
      path,
      revision: 7,
      textHash: sha256(text),
    });
    expect(checkpoint.fileExclusions).toEqual([
      expect.objectContaining({
        path: "acmart.dtx",
        reason: "document-too-large",
      }),
    ]);
    expect(JSON.stringify(checkpoint)).not.toContain(oversizedMarker);
    expect(history.getLatestVersionInfo).toHaveBeenCalledTimes(1);
  });

  it("fails closed after one retry when the requested document is oversized", async function () {
    const oversizedText = "x".repeat(200_001);
    const snapshot = {
      ...rawSnapshot(),
      files: {
        ...rawSnapshot().files,
        "acmart.dtx": { content: oversizedText },
      },
      v2DocVersions: {
        [documentId]: { pathname: path, v: 6 },
        "document-oversized-template": { pathname: "acmart.dtx", v: 2 },
      },
    };
    const history = historyManager(snapshot);
    const input = request();
    Object.assign(input.scope, {
      documentId: "document-oversized-template",
      path: "acmart.dtx",
      baseRevision: 3,
      baseTextHash: sha256(oversizedText),
      text: oversizedText,
    });

    expect(
      await captureError(
        createExternalAgentCheckpoint(input, { historyManager: history }),
      ),
    ).toMatchObject({ code: "AI_EXTERNAL_CHECKPOINT_STALE" });
    expect(history.getLatestVersionInfo).toHaveBeenCalledTimes(2);
    expect(history.getContentAtVersion).toHaveBeenCalledTimes(2);
    expect(history.ensureNoResyncPending).toHaveBeenCalledTimes(4);
  });

  it("repeats the complete checkpoint once after a queue race", async function () {
    const history = historyManager();
    history.getLatestVersionInfo
      .mockResolvedValueOnce(versionInfo(57, { revision: 5 }))
      .mockResolvedValueOnce(versionInfo(58));
    history.getContentAtVersion
      .mockResolvedValueOnce(rawSnapshot())
      .mockResolvedValueOnce(rawSnapshot());

    const checkpoint = await createExternalAgentCheckpoint(request(), {
      historyManager: history,
    });

    expect(checkpoint.historyVersion).toBe(58);
    expect(history.ensureNoResyncPending).toHaveBeenCalledTimes(4);
    expect(history.getLatestVersionInfo).toHaveBeenCalledTimes(2);
    expect(history.getContentAtVersion).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["document id", { documentId: "other-document" }],
    ["path", { path: "other.tex" }],
    ["revision", { baseRevision: 8 }],
    ["full-text hash", { baseTextHash: "0".repeat(64) }],
    ["document text", { text: "Different text with equal authority." }],
  ])("fails closed after two %s mismatches", async function (_, change) {
    const history = historyManager();
    const input = request();
    Object.assign(input.scope, change);

    expect(
      await captureError(
        createExternalAgentCheckpoint(input, { historyManager: history }),
      ),
    ).toMatchObject({ code: "AI_EXTERNAL_CHECKPOINT_STALE" });
    expect(history.getLatestVersionInfo).toHaveBeenCalledTimes(2);
  });

  it("fails closed after two selection-text mismatches", async function () {
    const history = historyManager();
    const input = request("selection");
    input.scope.text = "rejected text";

    expect(
      await captureError(
        createExternalAgentCheckpoint(input, { historyManager: history }),
      ),
    ).toMatchObject({ code: "AI_EXTERNAL_CHECKPOINT_STALE" });
    expect(history.getLatestVersionInfo).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, { kind: "project" }])(
    "rejects a missing or project scope before History I/O",
    async function (scope) {
      const history = historyManager();
      const input = request();
      input.scope = scope;

      expect(
        await captureError(
          createExternalAgentCheckpoint(input, { historyManager: history }),
        ),
      ).toMatchObject({ code: "AI_EXTERNAL_CHECKPOINT_UNAVAILABLE" });
      expect(history.ensureNoResyncPending).not.toHaveBeenCalled();
    },
  );

  it("does not retry a pending resync", async function () {
    const history = historyManager();
    history.ensureNoResyncPending.mockRejectedValue(
      new Error("resync pending"),
    );

    expect(
      await captureError(
        createExternalAgentCheckpoint(request(), { historyManager: history }),
      ),
    ).toMatchObject({ code: "AI_EXTERNAL_CHECKPOINT_UNAVAILABLE" });
    expect(history.ensureNoResyncPending).toHaveBeenCalledTimes(1);
    expect(history.getLatestVersionInfo).not.toHaveBeenCalled();
  });

  it("does not retry an incomplete History snapshot", async function () {
    const history = historyManager(rawSnapshot({ extraUnmappedFile: true }));

    expect(
      await captureError(
        createExternalAgentCheckpoint(request(), { historyManager: history }),
      ),
    ).toMatchObject({ code: "AI_EXTERNAL_CHECKPOINT_UNAVAILABLE" });
    expect(history.getLatestVersionInfo).toHaveBeenCalledTimes(1);
    expect(history.ensureNoResyncPending).toHaveBeenCalledTimes(1);
  });

  it("does not retry missing document-version metadata", async function () {
    const history = historyManager(rawSnapshot(), {
      version: 57,
      docVersions: {},
    });

    expect(
      await captureError(
        createExternalAgentCheckpoint(request(), { historyManager: history }),
      ),
    ).toMatchObject({ code: "AI_EXTERNAL_CHECKPOINT_UNAVAILABLE" });
    expect(history.getLatestVersionInfo).toHaveBeenCalledTimes(1);
    expect(history.getContentAtVersion).toHaveBeenCalledTimes(1);
  });

  it("prefers document versions already bound to the content snapshot", async function () {
    const snapshot = {
      ...rawSnapshot(),
      v2DocVersions: {
        [documentId]: { pathname: path, v: 6 },
      },
    };
    const history = historyManager(
      snapshot,
      versionInfo(57, { snapshotPath: "stale.tex" }),
    );

    const checkpoint = await createExternalAgentCheckpoint(request(), {
      historyManager: history,
    });

    expect(checkpoint.documents[0].path).toBe(path);
    expect(checkpoint.documents[0].revision).toBe(7);
  });

  it("stops before History I/O when already aborted", async function () {
    const history = historyManager();
    const controller = new AbortController();
    controller.abort();

    expect(
      await captureError(
        createExternalAgentCheckpoint(request(), {
          historyManager: history,
          signal: controller.signal,
        }),
      ),
    ).toMatchObject({ code: "AI_REQUEST_ABORTED" });
    expect(history.ensureNoResyncPending).not.toHaveBeenCalled();
  });
});
