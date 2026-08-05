import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  ProjectRelativePathSchema,
  Sha256Schema,
  SuggestionSchema,
} from "../../../shared/contracts.mjs";

const fixtureRoot = path.resolve(
  import.meta.dirname,
  "../../fixtures/synthetic",
);

async function readJson(name) {
  return JSON.parse(await readFile(path.join(fixtureRoot, name), "utf8"));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

describe("AI reviewer: synthetic fixtures", function () {
  it("contains only manifest-addressed files with matching hashes", async function () {
    const manifest = await readJson("manifest.json");

    expect(manifest.synthetic).toBe(true);
    expect(manifest.version).toBe(1);
    expect(manifest.files).toHaveLength(5);

    for (const file of manifest.files) {
      ProjectRelativePathSchema.parse(file.path);
      Sha256Schema.parse(file.sha256);
      const content = await readFile(path.join(fixtureRoot, file.path));
      expect(sha256(content)).toBe(file.sha256);
    }
  });

  it("provides a schema-valid suggestion against an intentionally stale base", async function () {
    const fixture = await readJson("stale-suggestion.json");

    expect(SuggestionSchema.parse(fixture.suggestion)).toEqual(
      fixture.suggestion,
    );
    expect(sha256(fixture.baseDocument.text)).toBe(
      fixture.baseDocument.textHash,
    );
    expect(sha256(fixture.liveDocument.text)).toBe(
      fixture.liveDocument.textHash,
    );
    expect(fixture.liveDocument.revision).not.toBe(
      fixture.suggestion.baseRevision,
    );
    expect(fixture.liveDocument.textHash).not.toBe(
      fixture.suggestion.baseTextHash,
    );
  });

  it("marks the synthetic Zotero-linked bibliography as managed", async function () {
    const fixture = await readJson("zotero-linked-file.json");

    expect(fixture.managed).toBe(true);
    expect(fixture.linkedFileData.provider).toBe("zotero");
    expect(fixture.normalizedItems[0].verificationDepth).toBe("metadata-only");
    expect(fixture.normalizedItems[0].doi).toBeNull();
  });
});
