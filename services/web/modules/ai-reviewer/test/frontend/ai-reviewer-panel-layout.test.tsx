import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect } from "chai";
import { readFileSync } from "node:fs";
import path from "node:path";
import postcss from "postcss";
import React from "react";
import * as sass from "sass";

import { AiIntegrationDetailsView } from "../../frontend/js/components/ai-integration-details";
import { AiReviewerPanelView } from "../../frontend/js/components/ai-reviewer-panel";
import { AgentStreamError } from "../../frontend/js/services/agent-stream";
import type { AiProviderConnection } from "../../frontend/js/services/ai-provider-configuration";
import type { AiReviewerWorkspacePersistence } from "../../frontend/js/services/ai-reviewer-workspace-persistence";
import { AiReviewerWorkspaceSchema } from "../../shared/contracts.mjs";
import type { AiReviewerWorkspace } from "../../shared/contract-types";

const projectId = "panel-width-project";
const widths = [233, 116];
const narrowestWidth = Math.min(...widths);
const baseTextHash = "a".repeat(64);
const longPath = `chapters/${"narrow-panel-path-segment-".repeat(16)}finding.tex`;
const longFindingTitle = "a discussion subject that must truncate "
  .repeat(4)
  .trim();
const expectedDiscussionSubject = `Finding: ${longFindingTitle}`;
const longFailureGuidance =
  "AI Reviewer could not use the model response. Try narrowing the review scope, switching to a more capable model, or checking the AI Reviewer settings.";
const stylesheetPath = path.resolve(
  __dirname,
  "../../frontend/stylesheets/ai-reviewer.scss",
);
const panelSourcePath = path.resolve(
  __dirname,
  "../../frontend/js/components/ai-reviewer-panel.tsx",
);
const settingsSourcePath = path.resolve(
  __dirname,
  "../../frontend/js/components/ai-integration-details.tsx",
);
const listLayoutSelectors = [
  ".ai-reviewer-panel-header",
  ".ai-reviewer-panel-body",
  ".ai-reviewer-panel-timeline",
  ".ai-reviewer-panel-footer",
  ".ai-reviewer-panel-scope",
  ".ai-reviewer-panel-composer",
  ".ai-reviewer-panel-composer-input",
  ".ai-reviewer-panel .btn",
  ".ai-reviewer-panel .form-select",
  ".ai-reviewer-panel .form-control",
];
const emptyLayoutSelectors = [
  ...listLayoutSelectors,
  ".ai-reviewer-panel-auxiliary-actions",
];
const workspaceLayoutSelectors = [
  ...listLayoutSelectors,
  ".ai-reviewer-run",
  ".ai-reviewer-artifact",
  ".ai-reviewer-discussion-row",
  ".ai-reviewer-panel-actions",
];
const failureLayoutSelectors = [
  ...listLayoutSelectors,
  ".ai-reviewer-run",
  ".ai-reviewer-panel .alert",
  ".ai-reviewer-panel-notice",
];
const discussionLayoutSelectors = [
  ".ai-reviewer-discussion-header",
  ".ai-reviewer-discussion-header-actions",
  ".ai-reviewer-discussion-turns",
  ".ai-reviewer-discussion-turn",
  ".ai-reviewer-panel-footer",
  ".ai-reviewer-discussion-composer",
  ".ai-reviewer-panel-composer-input",
  ".ai-reviewer-panel .btn",
  ".ai-reviewer-panel .form-control",
];
const settingsLayoutSelectors = [
  ".modal-content",
  ".focus-trap-container",
  ".ai-reviewer-provider-settings-form",
  ".ai-reviewer-provider-settings-header",
  ".ai-reviewer-provider-settings-body",
  ".ai-reviewer-provider-settings-footer",
  ".ai-reviewer-provider-settings-field",
  ".ai-reviewer-provider-settings-details",
  ".ai-reviewer-provider-settings-details > *",
  ".ai-reviewer-provider-advanced",
  ".ai-reviewer-provider-advanced-summary",
  ".ai-reviewer-provider-advanced-content",
  ".ai-reviewer-provider-advanced-help",
  ".ai-reviewer-provider-settings-control",
  ".ai-reviewer-provider-settings-footer .btn",
];
const settingsWrapSelectors = [
  ".modal-title",
  ".form-label",
  ".ai-reviewer-provider-settings-details",
  ".ai-reviewer-provider-settings-details > *",
  ".ai-reviewer-provider-advanced-summary",
  ".ai-reviewer-provider-advanced-help",
  ".ai-reviewer-provider-settings-footer .button-content",
];
const settingsConnection: AiProviderConnection = {
  id: "layout-connection",
  label: "api.example.com",
  classification: "remote",
  config: {
    provider: "openai-compatible",
    baseUrl: "https://api.example.com/v1",
    contextLengthOverride: null,
    credentialSet: true,
    credentialUpdatedAt: "2026-07-26T01:02:03.000Z",
  },
};

function installPanelStyles() {
  const source = readFileSync(stylesheetPath, "utf8");
  const css = sass.compileString(source, {
    loadPaths: [path.dirname(stylesheetPath)],
  }).css;
  const parsed = postcss.parse(css);

  // JSDOM has no container-query implementation. Both tested widths match the
  // 100px query and remain below 250px, so materialize that exact rule set.
  parsed.walkAtRules("container", (rule) => {
    const minWidth = rule.params.match(/min-width:\s*(\d+)px/)?.[1];
    if (
      minWidth != null &&
      Number.parseInt(minWidth, 10) <= narrowestWidth &&
      rule.nodes != null
    ) {
      rule.replaceWith(...rule.nodes);
      return;
    }
    rule.remove();
  });
  parsed.walkDecls("container-type", (declaration) => declaration.remove());

  const style = document.createElement("style");
  style.dataset.testid = "ai-reviewer-layout-styles";
  style.textContent = parsed.toString();
  document.head.append(style);
  return style;
}

function hasZeroMinWidth(style: CSSStyleDeclaration) {
  return style.minWidth === "0" || style.minWidth === "0px";
}

function declarationsFor(selector: string) {
  const stylesheet = document.querySelector<HTMLStyleElement>(
    'style[data-testid="ai-reviewer-layout-styles"]',
  );
  if (stylesheet == null) {
    throw new Error("The AI reviewer stylesheet must be installed.");
  }
  const declarations = new Map<string, string>();
  postcss.parse(stylesheet.textContent ?? "").walkRules((rule) => {
    if (!rule.selectors.includes(selector)) {
      return;
    }
    rule.walkDecls((declaration) => {
      declarations.set(declaration.prop, declaration.value);
    });
  });
  return declarations;
}

function isInlineSizeBounded(style: CSSStyleDeclaration) {
  return style.width === "100%" || style.maxWidth.includes("100%");
}

// The frontend runner uses JSDOM, whose layout metrics are always zero. These
// assertions enforce the rendered shrink/wrap/truncation contract from the
// production SCSS; real clientWidth/scrollWidth checks remain browser-level.
function assertNarrowLayoutContract(
  expectedWidth: number,
  expectedSelectors: string[],
) {
  const panel = document.querySelector<HTMLElement>(".ai-reviewer-panel");
  expect(panel).not.to.equal(null);
  if (panel == null) {
    throw new Error("The AI reviewer panel must render.");
  }
  const wrapper = panel.parentElement;
  expect(wrapper).not.to.equal(null);
  if (wrapper == null) {
    throw new Error("The width fixture must wrap the panel.");
  }
  expect(wrapper.style.width).to.equal(`${expectedWidth}px`);

  const panelRule = declarationsFor(".ai-reviewer-panel");
  expect(panelRule.get("width")).to.equal("100%");
  expect(panelRule.get("max-width")).to.equal("100%");
  expect(panelRule.get("min-width")).to.equal("0");
  expect(panelRule.get("box-sizing")).to.equal("border-box");
  expect(panelRule.get("overflow")).to.equal("hidden");

  for (const selector of expectedSelectors) {
    const elements = panel.querySelectorAll<HTMLElement>(selector);
    expect(
      elements.length,
      `${selector} is represented in the fixture`,
    ).to.be.greaterThan(0);
    for (const element of elements) {
      const style = getComputedStyle(element);
      expect(
        hasZeroMinWidth(style),
        `${element.className} can shrink`,
      ).to.equal(true);
      expect(
        isInlineSizeBounded(style),
        `${element.className} is bounded by the panel (${style.width}/${style.maxWidth})`,
      ).to.equal(true);
    }
  }

  for (const element of panel.querySelectorAll<HTMLElement>(
    '[class^="ai-reviewer-"], [class*=" ai-reviewer-"]',
  )) {
    const style = getComputedStyle(element);
    expect(
      hasZeroMinWidth(style),
      `${element.className} has min-width 0`,
    ).to.equal(true);
    expect(
      style.boxSizing,
      `${element.className} uses the border box`,
    ).to.equal("border-box");
  }
}

function assertSettingsNarrowLayoutContract(
  settings: HTMLElement,
  expectedWidth: number,
) {
  expect(settings.style.width).to.equal(`${expectedWidth}px`);
  const settingsStyle = getComputedStyle(settings);
  expect(hasZeroMinWidth(settingsStyle)).to.equal(true);
  expect(settingsStyle.boxSizing).to.equal("border-box");

  for (const selector of settingsLayoutSelectors) {
    const elements = settings.querySelectorAll<HTMLElement>(selector);
    expect(
      elements.length,
      `${selector} is represented in the settings fixture`,
    ).to.be.greaterThan(0);
    for (const element of elements) {
      const style = getComputedStyle(element);
      expect(
        hasZeroMinWidth(style),
        `${element.className} can shrink`,
      ).to.equal(true);
      expect(
        isInlineSizeBounded(style),
        `${element.className} is bounded by the settings surface (${style.width}/${style.maxWidth})`,
      ).to.equal(true);
      expect(
        style.boxSizing,
        `${element.className} uses the border box`,
      ).to.equal("border-box");
    }
  }

  for (const selector of settingsWrapSelectors) {
    for (const element of settings.querySelectorAll<HTMLElement>(selector)) {
      expect(
        getComputedStyle(element).overflowWrap,
        `${element.className} wraps long copy`,
      ).to.equal("anywhere");
    }
  }

  const provider = settings.querySelector<HTMLSelectElement>(
    'select[name="ai-reviewer-provider"], #ai-reviewer-provider',
  );
  expect(provider).not.to.equal(null);
  if (provider == null) {
    throw new Error("The provider select must render.");
  }
  expect([...provider.options].map((option) => option.text)).to.deep.equal([
    "OpenAI-compatible (Ollama, LM Studio, vLLM)",
    "Google Gemini",
    "Anthropic Claude",
  ]);
  const providerStyle = getComputedStyle(provider);
  expect(providerStyle.overflow).to.equal("hidden");
  expect(providerStyle.textOverflow).to.equal("ellipsis");
  expect(providerStyle.whiteSpace).to.equal("nowrap");
}

function assertEllipsis(element: HTMLElement) {
  const style = getComputedStyle(element);
  expect(style.textOverflow).to.equal("ellipsis");
  expect(style.whiteSpace).to.equal("nowrap");
  expect(style.overflowX === "hidden" || style.overflow === "hidden").to.equal(
    true,
  );
  expect(hasZeroMinWidth(style)).to.equal(true);
  let current: HTMLElement | null = element;
  let hasBoundedAncestor = false;
  while (current != null && !hasBoundedAncestor) {
    hasBoundedAncestor = isInlineSizeBounded(getComputedStyle(current));
    current = current.parentElement;
  }
  expect(hasBoundedAncestor).to.equal(true);
}

function assertWrapsAnywhere(element: HTMLElement) {
  const style = getComputedStyle(element);
  expect(style.overflowWrap).to.equal("anywhere");
  expect(hasZeroMinWidth(style)).to.equal(true);
}

function layoutWorkspace(): AiReviewerWorkspace {
  const request = {
    requestId: "panel-width-request",
    projectId,
    action: "review" as const,
    instruction: "Review the selected phrase.",
    skill: "referee-review",
    scope: {
      kind: "selection" as const,
      documentId: "panel-width-document",
      path: longPath,
      baseRevision: 7,
      baseTextHash,
      range: {
        from: 0,
        to: 4,
      },
      text: "beta",
    },
  };
  const finding = {
    id: "panel-width-finding",
    requestId: request.requestId,
    projectId,
    artifactKind: "finding" as const,
    severity: "warning" as const,
    category: "clarity",
    title: longFindingTitle,
    message:
      "This finding has enough prose to exercise wrapping without changing the review contract.",
    evidence: [
      {
        path: longPath,
        range: request.scope.range,
        revision: request.scope.baseRevision,
        textHash: baseTextHash,
      },
    ],
    suggestionIds: [],
  };
  const resolvedFinding = {
    ...finding,
    id: "panel-width-resolved-finding",
    title: `Resolved ${longFindingTitle}`,
  };

  return AiReviewerWorkspaceSchema.parse({
    runs: [
      {
        generation: 1,
        createdOrder: 1,
        request,
        text: "Stored review text.",
        findings: [
          {
            artifact: finding,
            status: "unresolved",
          },
          {
            artifact: resolvedFinding,
            status: "discarded",
          },
        ],
        suggestions: [],
      },
    ],
    discussions: [
      {
        id: "panel-width-discussion",
        createdOrder: 2,
        subjectKey: `1:finding:${finding.id}`,
        subject: {
          kind: "finding",
          sourceRequest: request,
          artifact: finding,
        },
        sourceGeneration: 1,
        turns: [
          {
            role: "user",
            text: "unbroken-discussion-text-".repeat(24),
          },
          {
            role: "assistant",
            text: "The discussion response stays readable as prose in the narrow panel.",
          },
        ],
        suggestions: [],
        updatedAt: "2026-07-26T00:00:00.000Z",
      },
    ],
  });
}

function persistenceFor(
  workspace: AiReviewerWorkspace,
): AiReviewerWorkspacePersistence {
  return {
    load: async () => ({
      revision: 1,
      workspace: structuredClone(workspace),
    }),
    save: async (_loadedProjectId, nextWorkspace, revision) => ({
      revision: revision + 1,
      workspace: structuredClone(nextWorkspace),
    }),
    deleteDiscussion: async () => ({
      revision: 2,
      workspace: structuredClone(workspace),
    }),
    deleteAll: async () => ({
      revision: 2,
      workspace: {
        runs: [],
        discussions: [],
      },
    }),
  };
}

describe("AI reviewer panel width", function () {
  let panelStyles: HTMLStyleElement;

  before(function () {
    expect(readFileSync(panelSourcePath, "utf8")).to.include(
      'import "../../stylesheets/ai-reviewer.scss";',
    );
    expect(readFileSync(settingsSourcePath, "utf8")).to.include(
      'import "../../stylesheets/ai-reviewer.scss";',
    );
    panelStyles = installPanelStyles();
  });

  after(function () {
    panelStyles.remove();
  });

  for (const width of widths) {
    it(`keeps provider settings within ${width}px with recognisable option labels`, async function () {
      render(
        <AiIntegrationDetailsView
          projectId={projectId}
          onHide={() => {}}
          listConnections={async () => ({ connections: [settingsConnection] })}
          createConnection={async () => settingsConnection}
          updateConnection={async () => settingsConnection}
          deleteConnection={async () => ({ connections: [] })}
          testConnection={async () => ({
            ok: true,
            provider: "openai-compatible",
            modelCount: 2,
            classification: "remote",
          })}
        />,
      );

      const provider = await screen.findByRole("combobox", {
        name: "Provider",
      });
      await waitFor(() =>
        expect((provider as HTMLSelectElement).disabled).to.equal(false),
      );
      const settings = document.querySelector<HTMLElement>(
        ".ai-reviewer-provider-settings",
      );
      expect(settings).not.to.equal(null);
      if (settings == null) {
        throw new Error("The provider settings dialog must render.");
      }
      settings.style.width = `${width}px`;
      fireEvent.click(screen.getByText("Advanced settings"));

      assertSettingsNarrowLayoutContract(settings, width);
    });

    it(`keeps the empty-state no-overflow contract at ${width}px`, function () {
      render(
        <div style={{ width, height: 800 }}>
          <AiReviewerPanelView
            projectId={projectId}
            captureSelectionSession={async () => {
              throw new Error("The width test does not start a review.");
            }}
          />
        </div>,
      );

      expect(
        screen.getByText(
          "Review a selection, document, or project, then discuss the results here.",
        ),
      ).to.exist;
      assertNarrowLayoutContract(width, emptyLayoutSelectors);
    });

    it(`contains long failure guidance at ${width}px`, async function () {
      const streamRequest = async () => {
        throw new AgentStreamError({
          code: "AI_STREAM_PROTOCOL_ERROR",
          category: "schema",
          message: "Bounded public schema failure wording.",
          retryable: false,
        });
      };
      render(
        <div style={{ width, height: 800 }}>
          <AiReviewerPanelView
            projectId={projectId}
            streamRequest={streamRequest}
          />
        </div>,
      );

      fireEvent.click(screen.getByRole("button", { name: "Run review" }));
      const alert = await screen.findByRole("alert");

      expect(alert.textContent).to.equal(longFailureGuidance);
      assertWrapsAnywhere(alert);
      assertNarrowLayoutContract(width, failureLayoutSelectors);
    });

    it(`contains a long path and discussion subject at ${width}px`, async function () {
      const { container } = render(
        <div style={{ width, height: 800 }}>
          <AiReviewerPanelView
            projectId={projectId}
            workspacePersistence={persistenceFor(layoutWorkspace())}
          />
        </div>,
      );

      const locations = await screen.findAllByTitle(
        `${longPath} (chars 0\u20134)`,
      );
      expect(locations[0].textContent?.length ?? 0).to.be.greaterThan(233);
      assertEllipsis(locations[0]);

      const discussion = screen.getByRole("button", {
        name: expectedDiscussionSubject,
      });
      const subject = discussion.querySelector<HTMLElement>(".button-content");
      expect(subject).not.to.equal(null);
      if (subject == null) {
        throw new Error("The discussion subject must render.");
      }
      expect(subject.textContent?.length ?? 0).to.be.greaterThan(116);
      assertEllipsis(subject);

      const resolved = container.querySelector<HTMLDetailsElement>(
        ".ai-reviewer-artifact-resolved",
      );
      const summary = resolved?.querySelector<HTMLElement>("summary");
      expect(resolved).not.to.equal(null);
      expect(summary).not.to.equal(null);
      if (resolved == null || summary == null) {
        throw new Error("The resolved finding must render.");
      }
      fireEvent.click(summary);
      expect(resolved.open).to.equal(true);
      assertNarrowLayoutContract(width, workspaceLayoutSelectors);

      fireEvent.click(discussion);
      await screen.findByRole("region", {
        name: "AI reviewer discussion",
      });
      const activeSubject = screen.getByTestId("discussion-subject");
      assertEllipsis(activeSubject);
      for (const prose of document.querySelectorAll<HTMLElement>(
        ".ai-reviewer-discussion-turn .ai-reviewer-panel-prose",
      )) {
        assertWrapsAnywhere(prose);
      }
      assertNarrowLayoutContract(width, discussionLayoutSelectors);
    });
  }
});
