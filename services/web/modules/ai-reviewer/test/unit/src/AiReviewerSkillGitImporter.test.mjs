import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import { describe, expect, it, vi } from "vitest";

import {
  AI_REVIEWER_SKILL_GIT_PREVIEW_MAX_RETAINED_BYTES,
  AiReviewerSkillGitImportError,
  createAiReviewerSkillGitImporter,
  parseAiReviewerSkillGitSource,
} from "../../../app/src/AiReviewerSkillGitImporter.mjs";

const resolvedSha = "0123456789abcdef0123456789abcdef01234567";
const marketplace = {
  name: "academic-research-skills",
  owner: { name: "Cheng-I Wu", url: "https://github.com/Imbad0202" },
  description:
    "Academic Research Skills — production-grade research, writing, peer review...",
  plugins: [
    {
      name: "academic-research-skills",
      source: "./",
      description: "4 skills + 27 modes + Material Passport pipeline...",
      version: "3.19.0",
      license: "CC-BY-NC-4.0",
      skills: [
        "./academic-paper",
        "./academic-paper-reviewer",
        "./academic-pipeline",
        "./deep-research",
      ],
    },
  ],
};
const pluginManifest = {
  name: "academic-research-skills",
  version: "3.19.0",
  description: "Academic research skills",
  author: { name: "Cheng-I Wu", url: "https://github.com/Imbad0202" },
  homepage: "https://github.com/imbad0202/academic-research-skills",
  repository: "https://github.com/imbad0202/academic-research-skills",
  license: "CC-BY-NC-4.0",
  keywords: ["academic", "research"],
};

function skillMarkdown(
  name,
  description = `Instructions for ${name}.`,
  body = "Review carefully.",
) {
  return `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;
}

function academicRepositoryFiles() {
  return {
    ".claude-plugin/marketplace.json": JSON.stringify(marketplace),
    ".claude-plugin/plugin.json": JSON.stringify(pluginManifest),
    "academic-paper/SKILL.md": skillMarkdown("academic-paper"),
    "academic-paper-reviewer/SKILL.md": skillMarkdown(
      "academic-paper-reviewer",
      "Review an academic paper.",
      "Read [the rubric](references/rubric.md).",
    ),
    "academic-paper-reviewer/references/rubric.md": "Use explicit criteria.",
    "academic-pipeline/SKILL.md": skillMarkdown("academic-pipeline"),
    "deep-research/SKILL.md": skillMarkdown("deep-research"),
    "scripts/run.py": "raise SystemExit('must never be imported')",
  };
}

const measuredSkillLayout = Object.freeze([
  { path: "academic-paper", fileCount: 61, markdownBytes: 944 * 1024 },
  {
    path: "academic-paper-reviewer",
    fileCount: 27,
    markdownBytes: 529 * 1024,
  },
  {
    path: "academic-pipeline",
    fileCount: 29,
    markdownBytes: 530 * 1024,
  },
  { path: "deep-research", fileCount: 53, markdownBytes: 684 * 1024 },
]);

function measuredAcademicRepositoryFiles() {
  const files = {
    ".claude-plugin/marketplace.json": JSON.stringify(marketplace),
    ".claude-plugin/plugin.json": JSON.stringify(pluginManifest),
  };
  for (const layout of measuredSkillLayout) {
    const referenceCount = layout.fileCount - 1;
    const references = Array.from(
      { length: referenceCount },
      (_, index) =>
        `references/reference-${String(index + 1).padStart(3, "0")}.md`,
    );
    const markdown = skillMarkdown(
      layout.path,
      `Instructions for ${layout.path}.`,
      references.map((path) => `Read [${path}](${path}).`).join("\n"),
    );
    files[`${layout.path}/SKILL.md`] = markdown;
    let remaining = layout.markdownBytes - Buffer.byteLength(markdown, "utf8");
    for (let index = 0; index < references.length; index += 1) {
      const pathsLeft = references.length - index;
      const size = Math.floor(remaining / pathsLeft);
      files[`${layout.path}/${references[index]}`] = Buffer.alloc(size, 97);
      remaining -= size;
    }
    if (remaining !== 0) throw new Error("Measured fixture size drifted.");
  }
  return files;
}

function repositoryFixtureNearArchiveSize(files, targetBytes) {
  let paddingBytes = Math.max(0, targetBytes - repositoryArchive(files).length);
  let repository;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    repository = repositoryFixture({
      ...files,
      "assets/unselected-corpus.bin": Buffer.alloc(paddingBytes, 0x5a),
    });
    paddingBytes = Math.max(
      0,
      paddingBytes + targetBytes - repository.archive.byteLength,
    );
  }
  return repository;
}

function gitBlobSha(bytes) {
  return createHash("sha1")
    .update(`blob ${bytes.byteLength}\0`, "utf8")
    .update(bytes)
    .digest("hex");
}

function repositoryFixture(files, extraTreeEntries = []) {
  const blobs = new Map();
  const tree = Object.entries(files).map(([path, content]) => {
    const bytes = Buffer.isBuffer(content)
      ? Buffer.from(content)
      : Buffer.from(content, "utf8");
    const sha = gitBlobSha(bytes);
    blobs.set(sha, bytes);
    return { path, mode: "100644", type: "blob", sha, size: bytes.length };
  });
  return {
    archive: repositoryArchive(files),
    blobs,
    tree: [...tree, ...extraTreeEntries],
  };
}

function tarOctal(header, offset, length, value) {
  const octal = value.toString(8).padStart(length - 1, "0");
  header.write(octal, offset, length - 1, "ascii");
  header[offset + length - 1] = 0;
}

function tarHeader(path, size, { mode = 0o644, type = "0" } = {}) {
  const header = Buffer.alloc(512);
  let name = path;
  let prefix = "";
  if (Buffer.byteLength(name, "utf8") > 100) {
    const separator = path.lastIndexOf("/");
    prefix = path.slice(0, separator);
    name = path.slice(separator + 1);
  }
  if (
    Buffer.byteLength(name, "utf8") > 100 ||
    Buffer.byteLength(prefix, "utf8") > 155
  ) {
    throw new Error(`Fixture tar path is too long: ${path}`);
  }
  header.write(name, 0, 100, "utf8");
  tarOctal(header, 100, 8, mode);
  tarOctal(header, 108, 8, 0);
  tarOctal(header, 116, 8, 0);
  tarOctal(header, 124, 12, size);
  tarOctal(header, 136, 12, 0);
  header.fill(32, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write(prefix, 345, 155, "utf8");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumText = checksum.toString(8).padStart(6, "0");
  header.write(checksumText, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 32;
  return header;
}

function repositoryArchive(files, compressionLevel = 0) {
  const root = `repository-${resolvedSha}`;
  const chunks = [tarHeader(`${root}/`, 0, { mode: 0o755, type: "5" })];
  for (const [path, content] of Object.entries(files).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    const bytes = Buffer.isBuffer(content)
      ? Buffer.from(content)
      : Buffer.from(content, "utf8");
    chunks.push(tarHeader(`${root}/${path}`, bytes.byteLength), bytes);
    const padding = (512 - (bytes.byteLength % 512)) % 512;
    if (padding > 0) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(chunks), { level: compressionLevel });
}

function jsonResponse(value, init = {}) {
  return new Response(JSON.stringify(value), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...init.headers,
    },
  });
}

function treeResponse(repository, init = {}) {
  return jsonResponse(
    { sha: resolvedSha, truncated: false, tree: repository.tree },
    init,
  );
}

function archiveResponse(bytes, init = {}) {
  return new Response(bytes, {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/x-gzip",
      "content-length": String(bytes.byteLength),
      ...init.headers,
    },
  });
}

function streamingArchiveResponse(bytes, onChunk) {
  let offset = 0;
  return new Response(
    new ReadableStream({
      pull(controller) {
        if (offset === bytes.byteLength) {
          controller.close();
          return;
        }
        const end = Math.min(offset + 16 * 1024, bytes.byteLength);
        const chunk = bytes.subarray(offset, end);
        offset = end;
        onChunk(chunk.byteLength);
        controller.enqueue(chunk);
      },
    }),
    {
      headers: {
        "content-type": "application/x-gzip",
        "content-length": String(bytes.byteLength),
      },
    },
  );
}

function githubFetch(repository, requests = []) {
  return vi.fn(async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith("/commits?per_page=1")) {
      return jsonResponse([{ sha: resolvedSha }]);
    }
    if (url.includes("/commits/")) return jsonResponse({ sha: resolvedSha });
    if (url.includes("/git/trees/")) return treeResponse(repository);
    if (url.includes("codeload.github.com")) {
      return archiveResponse(repository.archive);
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

function fixture(fetchImpl) {
  const dispatchers = [];
  const dispatcherFactory = vi.fn(() => {
    const dispatcher = { close: vi.fn(async () => {}) };
    dispatchers.push(dispatcher);
    return dispatcher;
  });
  const importer = createAiReviewerSkillGitImporter({
    fetchImpl,
    dispatcherFactory,
    timeoutSignal: () => new AbortController().signal,
  });
  return { dispatchers, dispatcherFactory, importer };
}

async function rejectedError(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected the promise to reject.");
}

describe("AI reviewer git skill importer", function () {
  it("accepts only a repository plus an optional revision and keeps custom host selection explicit", function () {
    expect(
      parseAiReviewerSkillGitSource({ repository: "owner/repository" }),
    ).toEqual({
      service: "github",
      host: "github.com",
      origin: "https://github.com",
      repository: "owner/repository",
      requestedRevision: null,
    });
    expect(
      parseAiReviewerSkillGitSource({
        repository: "https://gitlab.com/group/subgroup/repository.git",
        ref: "release-1",
      }),
    ).toMatchObject({
      service: "gitlab",
      host: "gitlab.com",
      repository: "group/subgroup/repository",
      requestedRevision: "release-1",
    });
    expect(() =>
      parseAiReviewerSkillGitSource({
        repository: "https://git.company.example/group/repository",
      }),
    ).toThrowError("Choose GitHub or GitLab for this self-hosted repository.");
    expect(
      parseAiReviewerSkillGitSource({
        repository: "https://git.company.example/group/repository",
        gitHostType: "gitlab",
      }),
    ).toMatchObject({
      service: "gitlab",
      host: "git.company.example",
      repository: "group/repository",
    });
  });

  it.each([
    "https://127.0.0.1/owner/repository",
    "https://127.0.0.2/owner/repository",
    "https://0.0.0.0/owner/repository",
    "https://[::1]/owner/repository",
    "https://[::]/owner/repository",
    "https://[::ffff:127.0.0.1]/owner/repository",
    "https://169.254.169.254/owner/repository",
    "https://metadata.google.internal/owner/repository",
  ])(
    "refuses the loopback, link-local, or metadata host %s",
    async function (repository) {
      const fetchImpl = vi.fn();
      const { importer } = fixture(fetchImpl);
      const error = await rejectedError(
        importer.preview({ repository, gitHostType: "github" }),
      );
      expect(error).toMatchObject({
        code: "AI_REVIEWER_SKILL_GIT_DESTINATION_NOT_ALLOWED",
      });
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("refuses a public-looking hostname when DNS resolves it to loopback", async function () {
    let dispatcherOptions;
    const fetchImpl = vi.fn(async () => {
      await dispatcherOptions.lookupAll("git.company.example", {
        all: true,
        verbatim: true,
      });
      return jsonResponse({ id: resolvedSha });
    });
    const importer = createAiReviewerSkillGitImporter({
      fetchImpl,
      lookupAll: vi.fn(async () => [{ address: "127.0.0.1", family: 4 }]),
      dispatcherFactory: vi.fn((options) => {
        dispatcherOptions = options;
        return { close: vi.fn(async () => {}) };
      }),
      timeoutSignal: () => new AbortController().signal,
    });

    const error = await rejectedError(
      importer.preview({
        repository: "https://git.company.example/group/repository",
        gitHostType: "gitlab",
      }),
    );
    expect(error).toMatchObject({
      code: "AI_REVIEWER_SKILL_GIT_DESTINATION_NOT_ALLOWED",
    });
  });

  it("discovers the real four-skill manifest through one bounded archive", async function () {
    const requests = [];
    const files = academicRepositoryFiles();
    const repository = repositoryFixture(files);
    const fetchImpl = githubFetch(repository, requests);
    const { dispatchers, importer } = fixture(fetchImpl);
    const source = { repository: "imbad0202/academic-research-skills" };

    const preview = await importer.preview(source);

    expect(preview.manifestFound).toBe(true);
    expect(preview.plugins).toEqual([
      {
        name: "academic-research-skills",
        version: "3.19.0",
        license: "CC-BY-NC-4.0",
        owner: {
          name: "Cheng-I Wu",
          url: "https://github.com/Imbad0202",
        },
        homepage: "https://github.com/imbad0202/academic-research-skills",
      },
    ]);
    expect(preview.skills.map(({ name }) => name)).toEqual([
      "academic-paper",
      "academic-paper-reviewer",
      "academic-pipeline",
      "deep-research",
    ]);
    expect(preview.skills[1]).toMatchObject({
      path: "academic-paper-reviewer/SKILL.md",
      description: "Review an academic paper.",
      referenceFiles: [{ path: "references/rubric.md", sizeBytes: 22 }],
    });
    expect(preview.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(requests.slice(0, 2).map(({ url }) => url)).toEqual([
      "https://api.github.com/repos/imbad0202/academic-research-skills/commits?per_page=1",
      `https://api.github.com/repos/imbad0202/academic-research-skills/git/trees/${resolvedSha}?recursive=1`,
    ]);
    expect(requests).toHaveLength(3);
    expect(
      requests.filter(({ url }) => url.includes("codeload.github.com")),
    ).toHaveLength(1);
    expect(requests[0].init).toMatchObject({
      method: "GET",
      redirect: "error",
      dispatcher: expect.any(Object),
      signal: expect.any(AbortSignal),
    });

    const confirmed = await importer.confirm({
      ...source,
      resolvedSha,
      contentHash: preview.contentHash,
      selectedPaths: [
        "academic-paper-reviewer/SKILL.md",
        "deep-research/SKILL.md",
      ],
    });

    expect(confirmed.skills).toHaveLength(2);
    expect(confirmed.skills[0].referenceFiles).toEqual({
      "references/rubric.md": "Use explicit criteria.",
    });
    expect(confirmed.skills.map(({ provenance }) => provenance)).toEqual([
      expect.objectContaining({
        path: "academic-paper-reviewer/SKILL.md",
        pluginVersion: "3.19.0",
        license: "CC-BY-NC-4.0",
        owner: { name: "Cheng-I Wu", url: "https://github.com/Imbad0202" },
      }),
      expect.objectContaining({ path: "deep-research/SKILL.md" }),
    ]);
    expect(requests).toHaveLength(5);
    expect(
      requests.filter(({ url }) => url.includes("/git/trees/")),
    ).toHaveLength(2);
    expect(
      requests.filter(({ url }) => url.includes("codeload.github.com")),
    ).toHaveLength(2);
    expect(
      dispatchers.every(({ close }) => close.mock.calls.length === 1),
    ).toBe(true);
  });

  it("falls back to discovering SKILL.md files when no manifest exists", async function () {
    const files = {
      "one/SKILL.md": skillMarkdown("one"),
      "two/SKILL.md": skillMarkdown("two"),
      "README.md": "Not a skill.",
    };
    const fetchImpl = githubFetch(repositoryFixture(files));
    const { importer } = fixture(fetchImpl);

    const preview = await importer.preview({ repository: "owner/repository" });

    expect(preview.manifestFound).toBe(false);
    expect(preview.plugins).toEqual([]);
    expect(preview.skills.map(({ name, path }) => ({ name, path }))).toEqual([
      { name: "one", path: "one/SKILL.md" },
      { name: "two", path: "two/SKILL.md" },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("discovers local plugin roots and reports external or unreadable marketplace entries", async function () {
    const realMarketplaceShapes = {
      plugins: [
        {
          name: "local-string-source",
          source: "./local-string",
        },
        {
          name: "local-object-source",
          source: { source: "git-subdir", path: "./local-object" },
        },
        {
          name: "external-url-source",
          source: {
            source: "url",
            url: "https://git.example.com/vendor/external.git",
            path: "skills/reviewer",
            sha: resolvedSha,
          },
        },
        {
          name: "external-github-source",
          source: {
            source: "github",
            repo: "vendor/reviewer-skills",
            commit: resolvedSha,
          },
        },
        {
          name: "ambiguous-external-source",
          source: {
            source: "future-index-format",
            url: "https://git.example.com/vendor/future.git",
            path: "skills/future",
          },
        },
        {
          name: "missing-explicit-skill",
          source: "./missing",
          skills: ["./reviewer"],
        },
        {
          name: "unsafe-local-source",
          source: { source: "git-subdir", path: "../outside" },
        },
      ],
    };
    const files = {
      ".claude-plugin/marketplace.json": JSON.stringify(realMarketplaceShapes),
      "local-string/nested/SKILL.md": skillMarkdown("local-string-review"),
      "local-object/SKILL.md": skillMarkdown("local-object-review"),
      "unlisted/SKILL.md": skillMarkdown("must-not-cross-plugin-root"),
    };
    const requests = [];
    const fetchImpl = githubFetch(repositoryFixture(files), requests);
    const { importer } = fixture(fetchImpl);

    const preview = await importer.preview({ repository: "owner/repository" });

    expect(preview.skills.map(({ name, path }) => ({ name, path }))).toEqual([
      {
        name: "local-string-review",
        path: "local-string/nested/SKILL.md",
      },
      { name: "local-object-review", path: "local-object/SKILL.md" },
    ]);
    expect(preview.skippedPlugins).toEqual([
      {
        name: "external-url-source",
        reason: "external-source",
        sourceUrl: "https://git.example.com/vendor/external.git",
        sourcePath: "skills/reviewer",
      },
      {
        name: "external-github-source",
        reason: "external-source",
        sourceUrl: "https://github.com/vendor/reviewer-skills",
      },
      {
        name: "ambiguous-external-source",
        reason: "external-source",
        sourceUrl: "https://git.example.com/vendor/future.git",
        sourcePath: "skills/future",
      },
      {
        name: "missing-explicit-skill",
        reason: "skill-not-readable",
        skillPath: "missing/reviewer/SKILL.md",
      },
      { name: "unsafe-local-source", reason: "invalid-plugin" },
    ]);
    expect(requests).toHaveLength(3);
    expect(
      requests.some(({ url }) =>
        url.includes("git.example.com/vendor/external"),
      ),
    ).toBe(false);
    expect(
      requests.some(({ url }) => url.includes("vendor/reviewer-skills")),
    ).toBe(false);
    expect(requests.some(({ url }) => url.includes("vendor/future"))).toBe(
      false,
    );
  });

  it("does not let an implicit repository-root plugin claim a nested plugin Skill", async function () {
    const files = {
      ".claude-plugin/marketplace.json": JSON.stringify({
        plugins: [
          {
            name: "repository-root",
            source: "./",
            version: "1.0.0",
            license: "ROOT-LICENSE",
          },
          {
            name: "nested-owner",
            source: "./nested-plugin",
            version: "2.0.0",
            license: "NESTED-LICENSE",
          },
        ],
      }),
      "nested-plugin/SKILL.md": skillMarkdown("nested-reviewer"),
    };
    const fetchImpl = githubFetch(repositoryFixture(files));
    const { importer } = fixture(fetchImpl);
    const source = { repository: "owner/repository" };

    const preview = await importer.preview(source);

    expect(preview.skills).toEqual([
      expect.objectContaining({
        path: "nested-plugin/SKILL.md",
        name: "nested-reviewer",
        pluginName: "nested-owner",
      }),
    ]);
    expect(preview.skippedPlugins).toContainEqual({
      name: "repository-root",
      reason: "no-readable-skills",
    });
    expect(preview.skippedPlugins).not.toContainEqual(
      expect.objectContaining({
        name: "nested-owner",
        reason: "duplicate-skill",
      }),
    );

    const confirmed = await importer.confirm({
      ...source,
      resolvedSha,
      contentHash: preview.contentHash,
      selectedPaths: ["nested-plugin/SKILL.md"],
    });
    expect(confirmed.skills[0].provenance).toMatchObject({
      pluginName: "nested-owner",
      pluginVersion: "2.0.0",
      license: "NESTED-LICENSE",
    });
  });

  it("previews more than twenty discovered skills and confirms only a bounded selection", async function () {
    const files = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => {
        const name = `review-${String(index + 1).padStart(2, "0")}`;
        return [`${name}/SKILL.md`, skillMarkdown(name)];
      }),
    );
    const requests = [];
    const fetchImpl = githubFetch(repositoryFixture(files), requests);
    const { importer } = fixture(fetchImpl);

    const preview = await importer.preview({ repository: "owner/repository" });
    expect(preview.skills).toHaveLength(25);
    expect(preview.truncated).toBe(false);

    const confirmed = await importer.confirm({
      repository: "owner/repository",
      resolvedSha,
      contentHash: preview.contentHash,
      selectedPaths: [
        "review-03/SKILL.md",
        "review-21/SKILL.md",
        "review-25/SKILL.md",
      ],
    });

    expect(confirmed.skills.map(({ skillMarkdown }) => skillMarkdown)).toEqual([
      files["review-03/SKILL.md"],
      files["review-21/SKILL.md"],
      files["review-25/SKILL.md"],
    ]);
    expect(requests).toHaveLength(5);
  });

  it("limits preview retention to 32 MiB without restoring a candidate-count limit", async function () {
    const candidateCount = 40;
    const files = Object.fromEntries(
      Array.from({ length: candidateCount }, (_, index) => {
        const name = `review-${String(index + 1).padStart(2, "0")}`;
        return [
          `${name}/SKILL.md`,
          skillMarkdown(
            name,
            `Instructions for ${name}.`,
            "a".repeat(900 * 1024),
          ),
        ];
      }),
    );
    const repository = repositoryFixture(files);
    repository.archive = repositoryArchive(files, 9);
    const requests = [];
    const { importer } = fixture(githubFetch(repository, requests));

    const preview = await importer.preview({ repository: "owner/repository" });

    expect(AI_REVIEWER_SKILL_GIT_PREVIEW_MAX_RETAINED_BYTES).toBe(
      32 * 1024 * 1024,
    );
    expect(preview.truncated).toBe(true);
    expect(preview.skills.length).toBeGreaterThan(20);
    expect(preview.skills.length).toBeLessThan(candidateCount);
    const retainedSkillBytes = preview.skills.reduce(
      (total, { path }) => total + Buffer.byteLength(files[path], "utf8"),
      0,
    );
    expect(retainedSkillBytes).toBeLessThanOrEqual(
      AI_REVIEWER_SKILL_GIT_PREVIEW_MAX_RETAINED_BYTES,
    );
    const firstOmittedPath = `review-${String(preview.skills.length + 1).padStart(2, "0")}/SKILL.md`;
    expect(
      retainedSkillBytes + Buffer.byteLength(files[firstOmittedPath], "utf8"),
    ).toBeGreaterThan(AI_REVIEWER_SKILL_GIT_PREVIEW_MAX_RETAINED_BYTES);

    const selectedPath = preview.skills.at(-1).path;
    const confirmed = await importer.confirm({
      repository: "owner/repository",
      resolvedSha,
      contentHash: preview.contentHash,
      selectedPaths: [selectedPath],
    });
    expect(confirmed.skills).toHaveLength(1);
    expect(confirmed.skills[0].provenance.path).toBe(selectedPath);
    expect(requests).toHaveLength(5);
  });

  it("imports 170 Markdown files from an 8.3 MiB repository in five requests", async function () {
    const files = measuredAcademicRepositoryFiles();
    const repository = repositoryFixtureNearArchiveSize(
      files,
      Math.round(8.3 * 1024 * 1024),
    );
    const requests = [];
    let archiveBytesTransferred = 0;
    const fetchImpl = vi.fn(async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/commits?per_page=1")) {
        return jsonResponse([{ sha: resolvedSha }]);
      }
      if (url.includes("/git/trees/")) return treeResponse(repository);
      if (url.includes("codeload.github.com")) {
        archiveBytesTransferred += repository.archive.byteLength;
        return archiveResponse(repository.archive);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const { importer } = fixture(fetchImpl);
    const markdownEntries = repository.tree.filter(({ path }) =>
      path.endsWith(".md"),
    );

    expect(markdownEntries).toHaveLength(170);
    expect(markdownEntries.reduce((total, { size }) => total + size, 0)).toBe(
      2_687 * 1024,
    );
    expect(repository.archive.byteLength / (1024 * 1024)).toBeCloseTo(8.3, 1);

    const preview = await importer.preview({ repository: "owner/repository" });
    const confirmed = await importer.confirm({
      repository: "owner/repository",
      resolvedSha,
      contentHash: preview.contentHash,
      selectedPaths: preview.skills.map(({ path }) => path),
    });

    expect(
      preview.skills.map(({ referenceFiles }) => referenceFiles.length),
    ).toEqual([60, 26, 28, 52]);
    expect(confirmed.skills).toHaveLength(4);
    expect(requests).toHaveLength(5);
    expect(
      requests.filter(({ url }) => url.includes("codeload.github.com")),
    ).toHaveLength(2);
    expect(requests.some(({ url }) => url.includes("/git/blobs/"))).toBe(false);
    expect(archiveBytesTransferred).toBe(repository.archive.byteLength * 2);
  });

  it("imports only mentioned Markdown beneath each selected skill", async function () {
    const body = `${skillMarkdown(
      "academic-paper-reviewer",
      "Review an academic paper.",
      "Use `references/quality.md` and `missing.md`. Do not load `scripts/check.py` or `/docs/shared.md`.",
    )}`;
    const files = {
      "academic-paper-reviewer/SKILL.md": body,
      "academic-paper-reviewer/references/quality.md": "Use explicit criteria.",
      "academic-paper-reviewer/unmentioned.md": "Do not import me.",
      "docs/shared.md": "Outside the skill.",
      "academic-paper-reviewer/scripts/check.py": "Do not import me.",
    };
    const requests = [];
    const repository = repositoryFixture(files);
    const requestRecords = [];
    const fetchImpl = githubFetch(repository, requestRecords);
    const { importer } = fixture(fetchImpl);

    const preview = await importer.preview({
      repository: "owner/repository",
      ref: "main",
    });

    expect(preview.skills[0].referenceFiles).toEqual([
      { path: "references/quality.md", sizeBytes: 22 },
    ]);
    expect(preview.skills[0].skippedReferences).toEqual([
      { path: "/docs/shared.md", reason: "outside-skill-directory" },
      { path: "missing.md", reason: "not-readable" },
    ]);
    requests.push(...requestRecords.map(({ url }) => url));
    expect(requests).toHaveLength(3);
    const referenceSha = gitBlobSha(
      Buffer.from(files["academic-paper-reviewer/references/quality.md"]),
    );
    expect(requests.some((url) => url.endsWith(referenceSha))).toBe(false);

    const confirmed = await importer.confirm({
      repository: "owner/repository",
      ref: "main",
      resolvedSha,
      contentHash: preview.contentHash,
      selectedPaths: ["academic-paper-reviewer/SKILL.md"],
    });

    expect(confirmed.skills[0].referenceFiles).toEqual({
      "references/quality.md": "Use explicit criteria.",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("pre-checks a declared oversized archive and reports exact streaming skill overage", async function () {
    const precheckedRepository = repositoryFixture(
      { "review/SKILL.md": skillMarkdown("review") },
      [
        {
          path: "oversized/SKILL.md",
          mode: "100644",
          type: "blob",
          sha: "f".repeat(40),
          size: 129 * 1024 * 1024,
        },
      ],
    );
    let precheckedArchiveRequests = 0;
    let precheckedArchiveBytes = 0;
    const precheckFetchImpl = vi.fn(async (url) => {
      if (url.endsWith("/commits?per_page=1")) {
        return jsonResponse([{ sha: resolvedSha }]);
      }
      if (url.includes("/git/trees/")) {
        return treeResponse(precheckedRepository);
      }
      if (url.includes("codeload.github.com")) {
        precheckedArchiveRequests += 1;
        precheckedArchiveBytes += precheckedRepository.archive.byteLength;
        return archiveResponse(precheckedRepository.archive);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const { importer: precheckingImporter } = fixture(precheckFetchImpl);

    const precheckError = await rejectedError(
      precheckingImporter.preview({ repository: "owner/repository" }),
    );

    expect(precheckError).toMatchObject({
      code: "AI_REVIEWER_SKILL_GIT_RESPONSE_TOO_LARGE",
      status: 413,
    });
    expect(precheckedArchiveRequests).toBe(0);
    expect(precheckedArchiveBytes).toBe(0);
    expect(precheckFetchImpl).toHaveBeenCalledTimes(2);

    const body =
      "Read `references/first.md` and `references/second.md` before reviewing.";
    const firstReferenceBytes = 400 * 1024;
    const secondReferenceBytes =
      1024 * 1024 +
      12_345 -
      Buffer.byteLength(body, "utf8") -
      firstReferenceBytes;
    const files = {
      "oversized/SKILL.md": skillMarkdown(
        "oversized-review",
        "Review a paper.",
        body,
      ),
      "oversized/references/first.md": Buffer.alloc(firstReferenceBytes, 97),
      "oversized/references/second.md": Buffer.alloc(secondReferenceBytes, 98),
    };
    const repository = repositoryFixtureNearArchiveSize(
      files,
      Math.round(8.3 * 1024 * 1024),
    );
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith("/commits?per_page=1")) {
        return jsonResponse([{ sha: resolvedSha }]);
      }
      if (url.includes("/git/trees/")) return treeResponse(repository);
      if (url.includes("codeload.github.com")) {
        // The skill header is intentionally streamed, but Web Streams may pull
        // later tar entries before DecompressionStream surfaces that header.
        return streamingArchiveResponse(repository.archive, () => {});
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const { importer } = fixture(fetchImpl);

    const error = await rejectedError(
      importer.preview({ repository: "owner/repository" }),
    );

    expect(error).toMatchObject({
      code: "AI_REVIEWER_SKILL_GIT_SKILL_SIZE_LIMIT_EXCEEDED",
      status: 413,
      message:
        'The skill "oversized-review" at "oversized/SKILL.md" exceeds the 1048576-byte storage limit by 12345 bytes.',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("skips traversal mentioned by one skill without losing other skills", async function () {
    const files = {
      "review/SKILL.md": skillMarkdown(
        "review",
        "Review a paper.",
        "Do not read `../outside.md`.",
      ),
      "other/SKILL.md": skillMarkdown("other"),
    };
    const fetchImpl = githubFetch(repositoryFixture(files));
    const { importer } = fixture(fetchImpl);

    const preview = await importer.preview({
      repository: "owner/repository",
      ref: "main",
    });

    expect(preview.skills.map(({ name }) => name)).toEqual(["other", "review"]);
    expect(
      preview.skills.find(({ name }) => name === "review")?.skippedReferences,
    ).toEqual([{ path: "../outside.md", reason: "outside-skill-directory" }]);

    const confirmed = await importer.confirm({
      repository: "owner/repository",
      ref: "main",
      resolvedSha,
      contentHash: preview.contentHash,
      selectedPaths: ["other/SKILL.md", "review/SKILL.md"],
    });
    expect(confirmed.skills).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("keeps GitLab resolve, tree, and archive differences inside the adapter", async function () {
    const repository = repositoryFixture({
      "SKILL.md": skillMarkdown(
        "review",
        "Review a paper.",
        "Read `references/rubric.md`.",
      ),
      "references/rubric.md": "Use explicit criteria.",
    });
    const fetchImpl = vi.fn(async (url, init) => {
      if (url.includes("/repository/commits/release")) {
        return jsonResponse({ id: resolvedSha });
      }
      if (url.includes("/repository/tree?")) {
        return jsonResponse(
          repository.tree.map(({ sha, size: _size, ...entry }) => ({
            ...entry,
            id: sha,
          })),
        );
      }
      if (url.includes("/repository/archive.tar.gz?")) {
        return archiveResponse(repository.archive);
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const { importer } = fixture(fetchImpl);

    const preview = await importer.preview({
      repository: "https://git.company.example/group/subgroup/repository",
      gitHostType: "gitlab",
      ref: "release",
    });

    expect(preview.skills[0].referenceFiles).toEqual([
      { path: "references/rubric.md", sizeBytes: 22 },
    ]);

    expect(fetchImpl.mock.calls.map(([url]) => url)).toEqual([
      "https://git.company.example/api/v4/projects/group%2Fsubgroup%2Frepository/repository/commits/release",
      `https://git.company.example/api/v4/projects/group%2Fsubgroup%2Frepository/repository/tree?ref=${resolvedSha}&recursive=true&per_page=10000`,
      `https://git.company.example/api/v4/projects/group%2Fsubgroup%2Frepository/repository/archive.tar.gz?sha=${resolvedSha}&include_lfs_blobs=false`,
    ]);
    expect(fetchImpl.mock.calls[2][1]).toMatchObject({
      method: "GET",
      redirect: "error",
    });
  });

  it("reports host rate limiting and its reset time instead of a private-repository hint", async function () {
    const reset = 1_800_000_000;
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { message: "API rate limit exceeded" },
        {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": String(reset),
          },
        },
      ),
    );
    const { importer } = fixture(fetchImpl);

    const error = await rejectedError(
      importer.preview({ repository: "owner/repository" }),
    );
    expect(error).toMatchObject({
      code: "AI_REVIEWER_SKILL_GIT_RATE_LIMITED",
      status: 429,
      category: "rate-limit",
      message: `The GitHub rate limit was reached. Try again after ${new Date(reset * 1_000).toISOString()}.`,
    });
    expect(error.message).not.toContain("Private repositories");
  });

  it("refuses redirects before reading their destination", async function () {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        {},
        { status: 302, headers: { location: "https://elsewhere.example/" } },
      ),
    );
    const { importer } = fixture(fetchImpl);

    const error = await rejectedError(
      importer.preview({ repository: "owner/repository" }),
    );
    expect(error).toMatchObject({ code: "AI_REVIEWER_SKILL_GIT_FETCH_FAILED" });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][1].redirect).toBe("error");
  });

  it("refuses an oversized API response before storing or parsing it", async function () {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { sha: resolvedSha },
        { headers: { "content-length": String(2 * 1024 * 1024 + 1) } },
      ),
    );
    const { importer } = fixture(fetchImpl);

    const error = await rejectedError(
      importer.preview({ repository: "owner/repository" }),
    );
    expect(error).toMatchObject({
      code: "AI_REVIEWER_SKILL_GIT_RESPONSE_TOO_LARGE",
      status: 413,
    });
  });

  it("caps compressed archive bytes while a dishonest stream is still arriving", async function () {
    const repository = repositoryFixture({
      "SKILL.md": skillMarkdown("review"),
    });
    let archiveCancelled = false;
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith("/commits?per_page=1")) {
        return jsonResponse([{ sha: resolvedSha }]);
      }
      if (url.includes("/git/trees/")) return treeResponse(repository);
      if (url.includes("codeload.github.com")) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Buffer.alloc(16 * 1024 * 1024 + 1));
            },
            cancel() {
              archiveCancelled = true;
            },
          }),
          { headers: { "content-type": "application/x-gzip" } },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const { importer } = fixture(fetchImpl);

    const error = await rejectedError(
      importer.preview({ repository: "owner/repository" }),
    );

    expect(error).toMatchObject({
      code: "AI_REVIEWER_SKILL_GIT_RESPONSE_TOO_LARGE",
      status: 413,
    });
    expect(archiveCancelled).toBe(true);
  });

  it("refuses archive content whose blob hash differs from the pinned tree", async function () {
    const original = skillMarkdown("review");
    const repository = repositoryFixture({ "SKILL.md": original });
    const changed = `${original.slice(0, -1)}x`;
    const changedArchive = repositoryArchive({ "SKILL.md": changed });
    let archiveRequestCount = 0;
    const fetchImpl = vi.fn(async (url) => {
      if (url.endsWith("/commits?per_page=1")) {
        return jsonResponse([{ sha: resolvedSha }]);
      }
      if (url.includes("/git/trees/")) return treeResponse(repository);
      if (url.includes("codeload.github.com")) {
        archiveRequestCount += 1;
        return archiveResponse(
          archiveRequestCount === 1 ? repository.archive : changedArchive,
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const { importer } = fixture(fetchImpl);
    const source = { repository: "owner/repository" };
    const preview = await importer.preview(source);

    const error = await rejectedError(
      importer.confirm({
        ...source,
        resolvedSha,
        contentHash: preview.contentHash,
        selectedPaths: ["SKILL.md"],
      }),
    );

    expect(error).toMatchObject({
      code: "AI_REVIEWER_SKILL_GIT_RESPONSE_INVALID",
      status: 502,
    });
    expect(archiveRequestCount).toBe(2);
  });

  it("refuses confirmation if the immutable tree does not match the preview hash", async function () {
    const repository = repositoryFixture({
      "SKILL.md": skillMarkdown("review"),
    });
    const fetchImpl = vi.fn(async () => treeResponse(repository));
    const { importer } = fixture(fetchImpl);

    const error = await rejectedError(
      importer.confirm({
        repository: "owner/repository",
        resolvedSha,
        contentHash: "0".repeat(64),
        selectedPaths: ["SKILL.md"],
      }),
    );
    expect(error).toBeInstanceOf(AiReviewerSkillGitImportError);
    expect(error).toMatchObject({
      code: "AI_REVIEWER_SKILL_GIT_PREVIEW_CHANGED",
      status: 409,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
