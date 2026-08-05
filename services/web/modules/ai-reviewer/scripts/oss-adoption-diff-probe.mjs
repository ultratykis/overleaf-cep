/* eslint-disable @overleaf/require-script-runner */

import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { gzipSync } from "node:zlib";

const EXPECTED_FIXTURE_IDS = [
  "insert",
  "delete",
  "replace",
  "adjacent",
  "empty-range",
  "multibyte",
];

const ISOLATED_PACKAGES = [
  "@codemirror/merge",
  "@codemirror/state",
  "@codemirror/view",
  "jsdom",
  "esbuild",
];

function sliceHash(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function hunkId(fixtureId, chunk, original, replacement) {
  const originalSlice = original.slice(chunk.fromA, chunk.endA);
  const replacementSlice = replacement.slice(chunk.fromB, chunk.endB);
  const slices = `${originalSlice.length}:${originalSlice}\u0000${replacementSlice.length}:${replacementSlice}`;
  return `${fixtureId}:${chunk.endA}:${chunk.endB}:${sliceHash(slices)}`;
}

function validateFixtures(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    !Array.isArray(value.cases)
  ) {
    throw new TypeError("The diff fixture file must contain a cases array");
  }

  const fixtureIds = value.cases.map((fixture) => fixture?.id);
  if (
    fixtureIds.length !== EXPECTED_FIXTURE_IDS.length ||
    EXPECTED_FIXTURE_IDS.some((id) => !fixtureIds.includes(id)) ||
    new Set(fixtureIds).size !== EXPECTED_FIXTURE_IDS.length
  ) {
    throw new TypeError(
      `The diff fixture set must contain exactly: ${EXPECTED_FIXTURE_IDS.join(", ")}`,
    );
  }

  return EXPECTED_FIXTURE_IDS.map((id) => {
    const fixture = value.cases.find((candidate) => candidate.id === id);
    if (
      typeof fixture.original !== "string" ||
      typeof fixture.replacement !== "string"
    ) {
      throw new TypeError(
        `Diff fixture ${id} must provide string original and replacement values`,
      );
    }
    return {
      id,
      original: fixture.original,
      replacement: fixture.replacement,
    };
  });
}

async function packageRootForEntry(entryFile, expectedName) {
  let current = path.dirname(entryFile);
  while (true) {
    const manifestFile = path.join(current, "package.json");
    try {
      const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
      if (manifest.name === expectedName) {
        return {
          root: await realpath(current),
          manifest,
        };
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(
        `Could not locate package.json for ${expectedName} from ${entryFile}`,
      );
    }
    current = parent;
  }
}

async function loadIsolatedPackages(installRoot) {
  const absoluteInstallRoot = await realpath(path.resolve(installRoot));
  const requireFromInstall = createRequire(
    path.join(absoluteInstallRoot, "package.json"),
  );
  const entries = Object.fromEntries(
    ISOLATED_PACKAGES.map((packageName) => [
      packageName,
      requireFromInstall.resolve(packageName),
    ]),
  );
  const packageInfo = {};

  for (const packageName of ISOLATED_PACKAGES) {
    const located = await packageRootForEntry(
      entries[packageName],
      packageName,
    );
    packageInfo[packageName] = {
      version: located.manifest.version,
      entry: await realpath(entries[packageName]),
      root: located.root,
    };
  }

  const requireFromMerge = createRequire(entries["@codemirror/merge"]);
  const mergeStateEntry = await realpath(
    requireFromMerge.resolve("@codemirror/state"),
  );
  const mergeViewEntry = await realpath(
    requireFromMerge.resolve("@codemirror/view"),
  );
  const directStateEntry = packageInfo["@codemirror/state"].entry;
  const directViewEntry = packageInfo["@codemirror/view"].entry;

  return {
    installRoot: absoluteInstallRoot,
    requireFromInstall,
    packageInfo,
    singleRuntime: {
      state: directStateEntry === mergeStateEntry,
      view: directViewEntry === mergeViewEntry,
      directStateEntry,
      mergeStateEntry,
      directViewEntry,
      mergeViewEntry,
    },
    merge: requireFromInstall("@codemirror/merge"),
    state: requireFromInstall("@codemirror/state"),
    view: requireFromInstall("@codemirror/view"),
    jsdom: requireFromInstall("jsdom"),
    esbuild: requireFromInstall("esbuild"),
  };
}

function installDomGlobals(window) {
  const descriptors = new Map();
  const values = {
    window,
    document: window.document,
    navigator: window.navigator,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    Text: window.Text,
    MutationObserver: window.MutationObserver,
    DOMRect: window.DOMRect,
    Range: window.Range,
    Selection: window.Selection,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  };

  for (const [name, value] of Object.entries(values)) {
    descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: false,
      writable: true,
      value,
    });
  }

  if (typeof window.matchMedia !== "function") {
    window.matchMedia = (query) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() {
        return false;
      },
    });
  }

  const emptyRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    width: 0,
    height: 0,
    toJSON() {
      return this;
    },
  });
  if (typeof window.Range.prototype.getClientRects !== "function") {
    window.Range.prototype.getClientRects = () => [];
  }
  if (typeof window.Range.prototype.getBoundingClientRect !== "function") {
    window.Range.prototype.getBoundingClientRect = emptyRect;
  }

  return () => {
    for (const [name, descriptor] of descriptors) {
      if (descriptor === undefined) {
        delete globalThis[name];
      } else {
        Object.defineProperty(globalThis, name, descriptor);
      }
    }
  };
}

function renderFixtureInDom({
  fixture,
  document,
  Event,
  MergeView,
  EditorState,
  EditorView,
}) {
  const container = document.createElement("section");
  container.dataset.fixtureId = fixture.id;
  const preview = document.createElement("div");
  preview.dataset.detachedPreview = fixture.id;
  const choices = document.createElement("fieldset");
  choices.dataset.hunkChoices = fixture.id;
  container.append(preview, choices);
  document.body.append(container);

  const transactionCount = { a: 0, b: 0 };
  const docChangedTransactions = { a: 0, b: 0 };
  const guardedExtensions = (side) => [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorState.changeFilter.of(() => false),
    EditorView.updateListener.of((update) => {
      transactionCount[side] += update.transactions.length;
      docChangedTransactions[side] += update.transactions.filter(
        (transaction) => transaction.docChanged,
      ).length;
    }),
  ];

  const mergeView = new MergeView({
    a: {
      doc: fixture.original,
      extensions: guardedExtensions("a"),
    },
    b: {
      doc: fixture.replacement,
      extensions: guardedExtensions("b"),
    },
    parent: preview,
    root: document,
    revertControls: undefined,
    highlightChanges: true,
    gutter: true,
    diffConfig: {
      scanLimit: 500,
      timeout: 1_000,
    },
  });

  const blockedMutationBefore = {
    a: mergeView.a.state.doc.toString(),
    b: mergeView.b.state.doc.toString(),
  };
  mergeView.a.dispatch({
    changes: { from: 0, insert: "blocked-a" },
    userEvent: "oss-diff-probe",
  });
  mergeView.b.dispatch({
    changes: { from: 0, insert: "blocked-b" },
    userEvent: "oss-diff-probe",
  });
  const blockedMutationAfter = {
    a: mergeView.a.state.doc.toString(),
    b: mergeView.b.state.doc.toString(),
  };

  const selectedHunkIds = new Set();
  const hunks = mergeView.chunks.map((chunk) => {
    const id = hunkId(fixture.id, chunk, fixture.original, fixture.replacement);
    const label = document.createElement("label");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.dataset.hunkId = id;
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) {
        selectedHunkIds.add(id);
      } else {
        selectedHunkIds.delete(id);
      }
    });
    label.append(checkbox, document.createTextNode(id));
    choices.append(label);
    return {
      id,
      fromA: chunk.fromA,
      endA: chunk.endA,
      fromB: chunk.fromB,
      endB: chunk.endB,
      precise: chunk.precise,
      originalSliceHash: sliceHash(
        fixture.original.slice(chunk.fromA, chunk.endA),
      ),
      replacementSliceHash: sliceHash(
        fixture.replacement.slice(chunk.fromB, chunk.endB),
      ),
    };
  });

  const checkboxBaseline = {
    docs: {
      a: mergeView.a.state.doc.toString(),
      b: mergeView.b.state.doc.toString(),
    },
    transactionCount: { ...transactionCount },
    docChangedTransactions: { ...docChangedTransactions },
  };
  for (const checkbox of choices.querySelectorAll('input[type="checkbox"]')) {
    checkbox.checked = true;
    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
  }
  const checkboxResult = {
    docs: {
      a: mergeView.a.state.doc.toString(),
      b: mergeView.b.state.doc.toString(),
    },
    transactionCount: { ...transactionCount },
    docChangedTransactions: { ...docChangedTransactions },
  };

  return {
    report: {
      id: fixture.id,
      rendered: mergeView.dom.isConnected,
      sideBySideEditors: mergeView.dom.querySelectorAll(
        ".cm-mergeViewEditor > .cm-editor",
      ).length,
      revertControlCount:
        mergeView.dom.querySelectorAll(".cm-merge-revert").length,
      hunkCount: hunks.length,
      hunks,
      selectedHunkIds: [...selectedHunkIds],
      stateGuards: {
        a: {
          readOnly: mergeView.a.state.facet(EditorState.readOnly),
          editable: mergeView.a.state.facet(EditorView.editable),
          changeFilterCount: mergeView.a.state.facet(EditorState.changeFilter)
            .length,
        },
        b: {
          readOnly: mergeView.b.state.facet(EditorState.readOnly),
          editable: mergeView.b.state.facet(EditorView.editable),
          changeFilterCount: mergeView.b.state.facet(EditorState.changeFilter)
            .length,
        },
      },
      blockedMutation: {
        docsUnchanged:
          blockedMutationBefore.a === blockedMutationAfter.a &&
          blockedMutationBefore.b === blockedMutationAfter.b,
        docChangedTransactions: { ...docChangedTransactions },
      },
      checkboxSelection: {
        docsUnchanged:
          checkboxBaseline.docs.a === checkboxResult.docs.a &&
          checkboxBaseline.docs.b === checkboxResult.docs.b,
        transactionsUnchanged:
          checkboxBaseline.transactionCount.a ===
            checkboxResult.transactionCount.a &&
          checkboxBaseline.transactionCount.b ===
            checkboxResult.transactionCount.b,
        docChangedTransactionsUnchanged:
          checkboxBaseline.docChangedTransactions.a ===
            checkboxResult.docChangedTransactions.a &&
          checkboxBaseline.docChangedTransactions.b ===
            checkboxResult.docChangedTransactions.b,
      },
    },
    destroy() {
      mergeView.destroy();
      container.remove();
    },
  };
}

function browserEntrySource(fixtures) {
  return `
import { MergeView } from '@codemirror/merge'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

const fixtures = ${JSON.stringify(fixtures)}

function sliceHash(value) {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function hunkId(fixtureId, chunk, original, replacement) {
  const originalSlice = original.slice(chunk.fromA, chunk.endA)
  const replacementSlice = replacement.slice(chunk.fromB, chunk.endB)
  const slices = originalSlice.length + ':' + originalSlice + '\\u0000' +
    replacementSlice.length + ':' + replacementSlice
  return fixtureId + ':' + chunk.endA + ':' + chunk.endB + ':' + sliceHash(slices)
}

function renderFixture(fixture, parent) {
  const section = document.createElement('section')
  section.dataset.fixtureId = fixture.id
  const heading = document.createElement('h2')
  heading.textContent = fixture.id
  const preview = document.createElement('div')
  preview.dataset.detachedPreview = fixture.id
  const choices = document.createElement('fieldset')
  choices.dataset.hunkChoices = fixture.id
  section.append(heading, preview, choices)
  parent.append(section)

  const transactions = { a: 0, b: 0 }
  const docChangedTransactions = { a: 0, b: 0 }
  const selectedHunkIds = new Set()
  const extensions = side => [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorState.changeFilter.of(() => false),
    EditorView.updateListener.of(update => {
      transactions[side] += update.transactions.length
      docChangedTransactions[side] += update.transactions.filter(
        transaction => transaction.docChanged
      ).length
    }),
  ]
  const view = new MergeView({
    a: { doc: fixture.original, extensions: extensions('a') },
    b: { doc: fixture.replacement, extensions: extensions('b') },
    parent: preview,
    revertControls: undefined,
    highlightChanges: true,
    gutter: true,
    diffConfig: { scanLimit: 500, timeout: 1000 },
  })

  const hunkIds = view.chunks.map(chunk => {
    const id = hunkId(fixture.id, chunk, fixture.original, fixture.replacement)
    const label = document.createElement('label')
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.dataset.hunkId = id
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selectedHunkIds.add(id)
      else selectedHunkIds.delete(id)
    })
    label.append(checkbox, document.createTextNode(id))
    choices.append(label)
    return id
  })

  return {
    id: fixture.id,
    hunkIds,
    selectedHunkIds,
    view,
    snapshot() {
      return {
        docs: {
          a: view.a.state.doc.toString(),
          b: view.b.state.doc.toString(),
        },
        transactions: { ...transactions },
        docChangedTransactions: { ...docChangedTransactions },
        hunkIds,
        selectedHunkIds: [...selectedHunkIds],
      }
    },
  }
}

async function boot() {
  const app = document.getElementById('app')
  const results = fixtures.map(fixture => renderFixture(fixture, app))
  window.__ossDiffProbe = {
    ready: true,
    fixtureIds: results.map(result => result.id),
    snapshots() {
      return results.map(result => result.snapshot())
    },
    attemptBlockedMutations() {
      const before = results.map(result => result.snapshot())
      for (const result of results) {
        result.view.a.dispatch({ changes: { from: 0, insert: 'FORBIDDEN' } })
        result.view.b.dispatch({ changes: { from: 0, insert: 'FORBIDDEN' } })
      }
      return {
        before,
        after: results.map(result => result.snapshot()),
      }
    },
    destroy() {
      for (const result of results) result.view.destroy()
    },
  }
}

void boot().catch(error => {
  window.__ossDiffProbe = {
    ready: false,
    error: String(error && error.stack ? error.stack : error),
  }
})
`;
}

const baselineEntrySource = `
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'

export function createReadOnlyEditor(parent, doc) {
  return new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
        EditorState.changeFilter.of(() => false),
      ],
    }),
  })
}
`;

function normalizeRelativePath(value) {
  return value.split(path.sep).join("/");
}

function relativeToInstallRoot(installRoot, value) {
  const relative = path.relative(installRoot, value);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(
      `Resolved package path is outside the isolated installation: ${path.basename(value)}`,
    );
  }
  return normalizeRelativePath(relative);
}

function normalizeMetafilePath(value) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("esbuild metafile paths must be non-empty strings");
  }

  const normalized = value.replaceAll("\\", "/");
  const nodeModulesMarker = "/node_modules/";
  const nodeModulesIndex = normalized.lastIndexOf(nodeModulesMarker);
  if (nodeModulesIndex >= 0) {
    return normalized.slice(nodeModulesIndex + 1);
  }
  if (normalized.startsWith("node_modules/")) {
    return normalized;
  }

  const entryName = path.posix.basename(normalized);
  if (
    entryName === "oss-diff-baseline.js" ||
    entryName === "oss-diff-browser.js"
  ) {
    return `<entry>/${entryName}`;
  }

  if (
    path.posix.isAbsolute(normalized) ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("/../")
  ) {
    throw new Error(
      `esbuild exposed a path outside the isolated report boundary: ${entryName}`,
    );
  }

  return normalized;
}

function summarizeMetafile(metafile) {
  return {
    inputs: Object.fromEntries(
      Object.entries(metafile.inputs)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, input]) => [
          normalizeMetafilePath(name),
          {
            bytes: input.bytes,
            imports: input.imports.map((imported) => ({
              path: normalizeMetafilePath(imported.path),
              kind: imported.kind,
              external: imported.external ?? false,
            })),
          },
        ]),
    ),
    outputs: Object.fromEntries(
      Object.entries(metafile.outputs)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, output]) => [
          normalizeMetafilePath(name),
          {
            bytes: output.bytes,
            entryPoint:
              output.entryPoint === undefined
                ? undefined
                : normalizeMetafilePath(output.entryPoint),
            inputs: Object.fromEntries(
              Object.entries(output.inputs).map(([inputName, input]) => [
                normalizeMetafilePath(inputName),
                input,
              ]),
            ),
          },
        ]),
    ),
  };
}

async function buildBundle({ esbuild, installRoot, source, sourcefile }) {
  const result = await esbuild.build({
    stdin: {
      contents: source,
      loader: "js",
      resolveDir: installRoot,
      sourcefile,
    },
    absWorkingDir: installRoot,
    bundle: true,
    format: "iife",
    platform: "browser",
    target: ["es2022"],
    minify: true,
    legalComments: "none",
    metafile: true,
    sourcemap: false,
    treeShaking: true,
    write: false,
  });
  const javascript =
    result.outputFiles.find((output) => output.path.endsWith(".js")) ??
    (result.outputFiles.length === 1 ? result.outputFiles[0] : undefined);
  if (javascript === undefined) {
    throw new Error(`esbuild produced no JavaScript output for ${sourcefile}`);
  }
  return {
    contents: javascript.contents,
    minifiedBytes: javascript.contents.byteLength,
    gzipBytes: gzipSync(javascript.contents, { level: 9 }).byteLength,
    sha256: createHash("sha256").update(javascript.contents).digest("hex"),
    metafile: summarizeMetafile(result.metafile),
  };
}

function htmlDocument() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Detached diff spike</title>
    <style>
      body { font-family: sans-serif; margin: 1rem; }
      section { border: 1px solid #bbb; margin: 0 0 1rem; padding: 0.75rem; }
      .cm-mergeView { height: 12rem; overflow: auto; }
      fieldset { border: 0; display: grid; gap: 0.25rem; margin-top: 0.5rem; }
    </style>
  </head>
  <body>
    <main id="app"></main>
    <script src="./bundle.js"></script>
  </body>
</html>
`;
}

function cypressConfigSource() {
  return `
const { readFile } = require('node:fs')
const http = require('node:http')
const path = require('node:path')

let server

module.exports = {
  e2e: {
    specPattern: 'cypress/e2e/**/*.cy.js',
    supportFile: false,
    async setupNodeEvents(on, config) {
      const root = __dirname
      server = http.createServer((request, response) => {
        const pathname = new URL(request.url, 'http://127.0.0.1').pathname
        const file = pathname === '/bundle.js' ? 'bundle.js' : 'index.html'
        readFile(path.join(root, file), (error, body) => {
          if (error) {
            response.writeHead(500)
            response.end(String(error))
            return
          }
          response.setHeader(
            'content-type',
            file.endsWith('.js')
              ? 'text/javascript; charset=utf-8'
              : 'text/html; charset=utf-8'
          )
          response.end(body)
        })
      })
      await new Promise((resolve, fail) => {
        server.once('error', fail)
        server.listen(0, '127.0.0.1', resolve)
      })
      const address = server.address()
      config.baseUrl = 'http://127.0.0.1:' + address.port
      on('after:run', () => new Promise(resolve => server.close(resolve)))
      return config
    },
  },
}
`;
}

function cypressSpecSource() {
  return `
describe('AI reviewer: detached diff spike', () => {
  it('renders six guarded side-by-side previews and selection is inert', () => {
    cy.visit('/')
    cy.window().its('__ossDiffProbe.ready').should('equal', true)
    cy.get('[data-fixture-id]').should('have.length', 6)
    cy.get('.cm-mergeView').should('have.length', 6)
    cy.get('.cm-mergeView').each(preview => {
      cy.wrap(preview).find('.cm-mergeViewEditor > .cm-editor').should('have.length', 2)
      cy.wrap(preview).find('.cm-merge-revert').should('not.exist')
    })

    cy.window().then(window => {
      window.__ossDiffProbeBefore = window.__ossDiffProbe.snapshots()
    })
    cy.get('input[type="checkbox"]').each(checkbox => {
      cy.wrap(checkbox).check()
    })
    cy.window().then(window => {
      const before = window.__ossDiffProbeBefore
      const after = window.__ossDiffProbe.snapshots()
      expect(after.map(item => item.docs)).to.deep.equal(
        before.map(item => item.docs)
      )
      expect(after.map(item => item.docChangedTransactions)).to.deep.equal(
        before.map(item => item.docChangedTransactions)
      )
      for (const item of after) {
        expect(item.selectedHunkIds).to.deep.equal(item.hunkIds)
      }
      const blocked = window.__ossDiffProbe.attemptBlockedMutations()
      expect(blocked.after.map(item => item.docs)).to.deep.equal(
        blocked.before.map(item => item.docs)
      )
      expect(blocked.after.map(item => item.docChangedTransactions)).to.deep.equal(
        blocked.before.map(item => item.docChangedTransactions)
      )
    })
  })
})
`;
}

async function writeBrowserArtifacts({
  browserOutputDir,
  bundle,
  bundleReport,
}) {
  const outputRoot = path.resolve(browserOutputDir);
  const specDirectory = path.join(outputRoot, "cypress", "e2e");
  await mkdir(specDirectory, { recursive: true });

  const files = {
    bundle: path.join(outputRoot, "bundle.js"),
    html: path.join(outputRoot, "index.html"),
    cypressConfig: path.join(outputRoot, "cypress.config.cjs"),
    cypressSpec: path.join(specDirectory, "detached-diff.cy.js"),
    bundleReport: path.join(outputRoot, "bundle-report.json"),
  };
  await Promise.all([
    writeFile(files.bundle, bundle),
    writeFile(files.html, htmlDocument()),
    writeFile(files.cypressConfig, cypressConfigSource()),
    writeFile(files.cypressSpec, cypressSpecSource()),
    writeFile(files.bundleReport, `${JSON.stringify(bundleReport, null, 2)}\n`),
  ]);

  const fileObservations = Object.fromEntries(
    await Promise.all(
      Object.entries(files).map(async ([kind, file]) => {
        const bytes = await readFile(file);
        return [
          kind,
          {
            path: path.relative(outputRoot, file),
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
        ];
      }),
    ),
  );
  return {
    files: fileObservations,
  };
}

export async function runDiffProbe({
  installRoot,
  fixtureFile,
  browserOutputDir,
}) {
  if (typeof installRoot !== "string" || installRoot.length === 0) {
    throw new TypeError("installRoot is required");
  }
  if (typeof fixtureFile !== "string" || fixtureFile.length === 0) {
    throw new TypeError("fixtureFile is required");
  }

  const fixtures = validateFixtures(
    JSON.parse(await readFile(path.resolve(fixtureFile), "utf8")),
  );
  const isolated = await loadIsolatedPackages(installRoot);
  const { MergeView } = isolated.merge;
  const { EditorState } = isolated.state;
  const { EditorView } = isolated.view;
  const { JSDOM } = isolated.jsdom;

  if (
    typeof MergeView !== "function" ||
    typeof EditorState?.readOnly?.of !== "function" ||
    typeof EditorView?.editable?.of !== "function"
  ) {
    throw new Error(
      "The isolated CodeMirror packages expose incompatible APIs",
    );
  }
  if (!isolated.singleRuntime.state || !isolated.singleRuntime.view) {
    throw new Error(
      "The isolated installation resolves more than one CodeMirror runtime",
    );
  }

  const dom = new JSDOM("<!doctype html><body></body>", {
    pretendToBeVisual: true,
    url: "http://127.0.0.1/oss-diff-probe",
  });
  const restoreGlobals = installDomGlobals(dom.window);
  const rendered = [];

  try {
    for (const fixture of fixtures) {
      rendered.push(
        renderFixtureInDom({
          fixture,
          document: dom.window.document,
          Event: dom.window.Event,
          MergeView,
          EditorState,
          EditorView,
        }),
      );
    }
    await new Promise((resolve) => dom.window.requestAnimationFrame(resolve));
  } finally {
    for (const fixture of rendered) {
      fixture.destroy();
    }
    restoreGlobals();
    dom.window.close();
  }

  const browserSource = browserEntrySource(fixtures);
  const [baselineBundle, candidateBundle] = await Promise.all([
    buildBundle({
      esbuild: isolated.esbuild,
      installRoot: isolated.installRoot,
      source: baselineEntrySource,
      sourcefile: "oss-diff-baseline.js",
    }),
    buildBundle({
      esbuild: isolated.esbuild,
      installRoot: isolated.installRoot,
      source: browserSource,
      sourcefile: "oss-diff-browser.js",
    }),
  ]);
  const bundleReport = {
    baseline: {
      minifiedBytes: baselineBundle.minifiedBytes,
      gzipBytes: baselineBundle.gzipBytes,
      sha256: baselineBundle.sha256,
      metafile: baselineBundle.metafile,
    },
    candidate: {
      minifiedBytes: candidateBundle.minifiedBytes,
      gzipBytes: candidateBundle.gzipBytes,
      sha256: candidateBundle.sha256,
      metafile: candidateBundle.metafile,
    },
    delta: {
      minifiedBytes:
        candidateBundle.minifiedBytes - baselineBundle.minifiedBytes,
      gzipBytes: candidateBundle.gzipBytes - baselineBundle.gzipBytes,
    },
  };
  const browserArtifacts =
    typeof browserOutputDir === "string" && browserOutputDir.length > 0
      ? await writeBrowserArtifacts({
          browserOutputDir,
          bundle: candidateBundle.contents,
          bundleReport,
        })
      : null;
  const fixtureReports = rendered.map((item) => item.report);
  const invariants = {
    fixtureIds:
      fixtureReports.map((fixture) => fixture.id).join(",") ===
      EXPECTED_FIXTURE_IDS.join(","),
    sideBySide: fixtureReports.every(
      (fixture) => fixture.sideBySideEditors === 2,
    ),
    readOnly: fixtureReports.every(
      (fixture) =>
        fixture.stateGuards.a.readOnly &&
        fixture.stateGuards.b.readOnly &&
        fixture.stateGuards.a.editable === false &&
        fixture.stateGuards.b.editable === false &&
        fixture.stateGuards.a.changeFilterCount > 0 &&
        fixture.stateGuards.b.changeFilterCount > 0,
    ),
    noRevertControls: fixtureReports.every(
      (fixture) => fixture.revertControlCount === 0,
    ),
    blockedMutation: fixtureReports.every(
      (fixture) =>
        fixture.blockedMutation.docsUnchanged &&
        fixture.blockedMutation.docChangedTransactions.a === 0 &&
        fixture.blockedMutation.docChangedTransactions.b === 0,
    ),
    selectionOnly: fixtureReports.every(
      (fixture) =>
        fixture.checkboxSelection.docsUnchanged &&
        fixture.checkboxSelection.docChangedTransactionsUnchanged &&
        fixture.selectedHunkIds.length === fixture.hunkCount,
    ),
    singleCodeMirrorRuntime:
      isolated.singleRuntime.state && isolated.singleRuntime.view,
  };
  const failures = Object.entries(invariants)
    .filter(([, passed]) => !passed)
    .map(([name]) => name);
  const runtimeCopies = {
    state: {
      count: isolated.singleRuntime.state ? 1 : 2,
      entries: [
        ...new Set([
          isolated.singleRuntime.directStateEntry,
          isolated.singleRuntime.mergeStateEntry,
        ]),
      ].map((entry) => relativeToInstallRoot(isolated.installRoot, entry)),
    },
    view: {
      count: isolated.singleRuntime.view ? 1 : 2,
      entries: [
        ...new Set([
          isolated.singleRuntime.directViewEntry,
          isolated.singleRuntime.mergeViewEntry,
        ]),
      ].map((entry) => relativeToInstallRoot(isolated.installRoot, entry)),
    },
  };

  return {
    pass: failures.length === 0,
    failures,
    packageInfo: Object.fromEntries(
      Object.entries(isolated.packageInfo).map(([name, info]) => [
        name,
        {
          version: info.version,
          entry: relativeToInstallRoot(isolated.installRoot, info.entry),
          root: relativeToInstallRoot(isolated.installRoot, info.root),
        },
      ]),
    ),
    fixtures: fixtureReports,
    bundle: bundleReport,
    runtimeCopies,
    domHarness: {
      package: "jsdom",
      version: isolated.packageInfo.jsdom.version,
      fixtureCount: fixtureReports.length,
      renderedFixtureCount: fixtureReports.filter((fixture) => fixture.rendered)
        .length,
      invariants,
    },
    browserArtifacts,
  };
}
