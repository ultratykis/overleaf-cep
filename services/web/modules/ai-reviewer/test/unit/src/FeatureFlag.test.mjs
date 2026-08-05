import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const settingsPath = path.resolve(
  import.meta.dirname,
  "../../../../../config/settings.defaults.js",
);
const originalValue = process.env.OVERLEAF_AI_REVIEWER_ENABLED;

function loadSettings(value) {
  if (value == null) {
    delete process.env.OVERLEAF_AI_REVIEWER_ENABLED;
  } else {
    process.env.OVERLEAF_AI_REVIEWER_ENABLED = value;
  }
  delete require.cache[require.resolve(settingsPath)];
  return require(settingsPath);
}

function expectThinFrontendShells(settings) {
  expect(
    settings.overleafModuleImports.integrationPanelComponents.filter(
      (componentPath) =>
        componentPath.endsWith(
          "/modules/ai-reviewer/frontend/js/components/ai-integration-card.tsx",
        ),
    ),
  ).toHaveLength(1);
  expect(
    settings.overleafModuleImports.railEntries.filter((componentPath) =>
      componentPath.endsWith(
        "/modules/ai-reviewer/frontend/js/components/ai-reviewer-rail-entry.tsx",
      ),
    ),
  ).toHaveLength(1);
}

function aiReviewerSourceEditorExtensions(settings) {
  return settings.overleafModuleImports.sourceEditorExtensions.filter(
    (extensionPath) =>
      extensionPath.endsWith(
        "/modules/ai-reviewer/frontend/js/extensions/document-identity.ts",
      ),
  );
}

afterEach(function () {
  if (originalValue == null) {
    delete process.env.OVERLEAF_AI_REVIEWER_ENABLED;
  } else {
    process.env.OVERLEAF_AI_REVIEWER_ENABLED = originalValue;
  }
  delete require.cache[require.resolve(settingsPath)];
});

describe("AI reviewer: feature off", function () {
  it.each([undefined, "", "false", " FALSE "])(
    "does not register the module for %s",
    function (value) {
      const settings = loadSettings(value);

      expect(settings.aiReviewer.enabled).toBe(false);
      expect(
        settings.moduleImportSequence.filter((name) => name === "ai-reviewer"),
      ).toEqual([]);
      expect(aiReviewerSourceEditorExtensions(settings)).toEqual([]);
      expectThinFrontendShells(settings);
    },
  );

  it.each(["true", " TRUE "])(
    "registers the module exactly once for %s",
    function (value) {
      const settings = loadSettings(value);

      expect(settings.aiReviewer.enabled).toBe(true);
      expect(
        settings.moduleImportSequence.filter((name) => name === "ai-reviewer"),
      ).toEqual(["ai-reviewer"]);
      expect(aiReviewerSourceEditorExtensions(settings)).toHaveLength(1);
      expectThinFrontendShells(settings);
    },
  );

  it.each(["1", "yes", "tru"])(
    "rejects ambiguous boolean value %s",
    function (value) {
      expect(() => loadSettings(value)).toThrow(
        /OVERLEAF_AI_REVIEWER_ENABLED.*true.*false/,
      );
    },
  );
});
