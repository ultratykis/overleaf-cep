import { beforeEach, describe, expect, it, vi } from "vitest";

const clientPath = "../../../../zotero/app/src/ZoteroApiClient.mjs";

describe("AI reviewer Zotero search boundary", function () {
  let fetchJson;
  let getCredentials;
  let client;

  beforeEach(async function () {
    vi.resetModules();
    fetchJson = vi.fn();
    getCredentials = vi.fn();

    vi.doMock("@overleaf/logger", () => ({
      default: { error: vi.fn() },
    }));
    vi.doMock("@overleaf/fetch-utils", async (importOriginal) => ({
      ...(await importOriginal()),
      fetchJson,
    }));
    vi.doMock("../../../../zotero/app/src/TokenManager.mjs", () => ({
      default: { getCredentials },
    }));
    vi.doMock("../../../../../app/src/models/User.mjs", () => ({
      User: { updateOne: vi.fn() },
    }));

    client = (await import(clientPath)).default;
  });

  it("returns only bounded normalized metadata from a personal library", async function () {
    const apiKey = "PRIVATE_ZOTERO_API_KEY_SENTINEL";
    getCredentials.mockResolvedValue({
      apiKey,
      zoteroUserId: "zotero-user-123",
    });
    fetchJson.mockResolvedValue([
      {
        key: "ITEM1",
        data: {
          itemType: "journalArticle",
          title: "A synthetic article",
          creators: [
            {
              firstName: "Alice",
              lastName: "Example",
              creatorType: "author",
            },
          ],
          date: "2026-04-01",
          DOI: "10.1000/synthetic",
          abstractNote: "PRIVATE_ABSTRACT_SENTINEL",
        },
      },
    ]);
    const signal = new AbortController().signal;

    const result = await client.searchItems("overleaf-user-123", {
      query: "synthetic article",
      signal,
    });

    expect(getCredentials).toHaveBeenCalledExactlyOnceWith("overleaf-user-123");
    expect(fetchJson).toHaveBeenCalledOnce();
    const [rawUrl, options] = fetchJson.mock.calls[0];
    const url = new URL(rawUrl);
    expect(url.pathname).toBe("/users/zotero-user-123/items/top");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      format: "json",
      include: "data",
      itemType: "-attachment",
      q: "synthetic article",
      qmode: "titleCreatorYear",
      limit: "5",
    });
    expect(options).toEqual({
      headers: expect.objectContaining({
        "Zotero-API-Key": apiKey,
        "Zotero-API-Version": "3",
      }),
      signal,
    });
    expect(result).toEqual([
      {
        itemKey: "ITEM1",
        itemType: "journalArticle",
        title: "A synthetic article",
        creators: [
          {
            firstName: "Alice",
            lastName: "Example",
            creatorType: "author",
          },
        ],
        year: "2026",
        doi: "10.1000/synthetic",
        verificationDepth: "metadata-only",
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(apiKey);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_ABSTRACT_SENTINEL");
  });

  it("does not call Zotero when the user has not linked an account", async function () {
    getCredentials.mockResolvedValue(null);

    expect(await client.isLinked("overleaf-user-123")).toBe(false);
    expect(
      await client.searchItems("overleaf-user-123", { query: "synthetic" }),
    ).toBeNull();
    expect(getCredentials).toHaveBeenCalledTimes(2);
    expect(fetchJson).not.toHaveBeenCalled();
  });
});
