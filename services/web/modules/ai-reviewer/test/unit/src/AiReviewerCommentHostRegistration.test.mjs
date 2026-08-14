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

afterEach(function () {
  if (originalValue == null) {
    delete process.env.OVERLEAF_AI_REVIEWER_ENABLED;
  } else {
    process.env.OVERLEAF_AI_REVIEWER_ENABLED = originalValue;
  }
  delete require.cache[require.resolve(settingsPath)];
});

describe("AI reviewer: comment host module registration", function () {
  it.each([undefined, "", "false", " FALSE "])(
    "keeps comment host module imports absent for %s",
    function (value) {
      const settings = loadSettings(value);

      expect(settings.overleafModuleImports.aiReviewerCommentBridges).toEqual(
        [],
      );
      expect(settings.overleafModuleImports.aiReviewerCommentLabels).toEqual(
        [],
      );
      expect(settings.overleafModuleImports.aiReviewerCommentActions).toEqual(
        [],
      );
    },
  );

  it.each(["true", " TRUE "])(
    "registers the comment host components exactly once for %s",
    function (value) {
      const settings = loadSettings(value);

      expect(
        settings.overleafModuleImports.aiReviewerCommentBridges.filter(
          (componentPath) =>
            componentPath.endsWith(
              "/modules/ai-reviewer/frontend/js/components/ai-reviewer-comment-bridge.tsx",
            ),
        ),
      ).toHaveLength(1);
      expect(
        settings.overleafModuleImports.aiReviewerCommentLabels.filter(
          (componentPath) =>
            componentPath.endsWith(
              "/modules/ai-reviewer/frontend/js/components/ai-assisted-comment-label.tsx",
            ),
        ),
      ).toHaveLength(1);
      expect(
        settings.overleafModuleImports.aiReviewerCommentActions.filter(
          (componentPath) =>
            componentPath.endsWith(
              "/modules/ai-reviewer/frontend/js/components/ai-reviewer-comment-actions.tsx",
            ),
        ),
      ).toHaveLength(1);
    },
  );
});
