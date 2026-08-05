import { fireEvent, render, screen } from "@testing-library/react";
import { expect } from "chai";
import React from "react";

import { AiReviewerDiscussionMessages } from "../../frontend/js/components/ai-reviewer-discussion-messages";
import {
  AI_REVIEWER_FINDING_MARKDOWN_CONTENT_LIMIT,
  AiReviewerExpandableMarkdown,
  AiReviewerMarkdown,
} from "../../frontend/js/components/ai-reviewer-markdown";

describe("AI reviewer: model markdown", function () {
  it("renders the supported markdown constructs as elements", function () {
    const { container } = render(
      <AiReviewerMarkdown
        content={[
          "**bold** and *italic* with `inline code`.",
          "",
          "> quoted text",
          "",
          "- unordered item",
          "",
          "1. ordered item",
          "",
          "```ts",
          "const answer = 42;",
          "```",
          "",
          "[safe link](https://example.com/review)",
          "",
          "| Claim | Result |",
          "| :--- | ---: |",
          "| Alpha | **Supported** |",
          "",
          "~~superseded~~",
          "",
          "- [x] checked task",
          "- [ ] open task",
          "",
          "Evidence note[^evidence].",
          "",
          "[^evidence]: Footnote detail.",
        ].join("\n")}
      />,
    );

    expect(container.querySelector("strong")?.textContent).to.equal("bold");
    expect(container.querySelector("em")?.textContent).to.equal("italic");
    expect(container.querySelector("p > code")?.textContent).to.equal(
      "inline code",
    );
    expect(container.querySelector("pre > code")?.textContent).to.equal(
      "const answer = 42;\n",
    );
    expect(container.querySelector("blockquote")?.textContent).to.contain(
      "quoted text",
    );
    expect(container.querySelector("ul > li")?.textContent).to.equal(
      "unordered item",
    );
    expect(container.querySelector("ol > li")?.textContent).to.equal(
      "ordered item",
    );
    const link = container.querySelector("a");
    expect(link?.textContent).to.equal("safe link");
    expect(link?.getAttribute("href")).to.equal("https://example.com/review");
    expect(link?.getAttribute("target")).to.equal("_blank");
    expect(link?.getAttribute("rel")).to.equal("noreferrer noopener");
    const table = container.querySelector("table");
    expect(table?.querySelectorAll("thead th")).to.have.length(2);
    expect(
      table?.querySelector("tbody td:last-child strong")?.textContent,
    ).to.equal("Supported");
    expect(
      table?.querySelector("th:first-child")?.getAttribute("align"),
    ).to.equal("left");
    expect(
      table?.querySelector("th:last-child")?.getAttribute("align"),
    ).to.equal("right");
    expect(container.querySelector("del")?.textContent).to.equal("superseded");
    const tasks = container.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(tasks).to.have.length(2);
    expect(tasks[0].checked).to.equal(true);
    expect(tasks[0].disabled).to.equal(true);
    expect(tasks[1].checked).to.equal(false);
    const footnoteReference = container.querySelector<HTMLAnchorElement>(
      "a[data-footnote-ref]",
    );
    const footnoteId = footnoteReference?.getAttribute("href")?.slice(1);
    expect(footnoteId).to.match(/^ai-reviewer-.+-fn-evidence$/u);
    expect(container.querySelector(`[id="${footnoteId}"]`)).not.to.equal(null);
    expect(footnoteReference?.getAttribute("target")).to.equal(null);
    const footnoteLabelId = footnoteReference?.getAttribute("aria-describedby");
    const footnoteLabel = container.querySelector(`[id="${footnoteLabelId}"]`);
    expect(footnoteLabel?.classList.contains("visually-hidden")).to.equal(true);
    expect(footnoteLabel?.textContent).to.equal("Footnotes");
    expect(
      container.querySelector("section[data-footnotes] li")?.textContent,
    ).to.contain("Footnote detail.");
  });

  it("namespaces every footnote id across adjacent markdown blocks", function () {
    const { container } = render(
      <>
        <AiReviewerMarkdown content={"First[^1].\n\n[^1]: First note."} />
        <AiReviewerMarkdown content={"Second[^1].\n\n[^1]: Second note."} />
      </>,
    );

    const ids = Array.from(container.querySelectorAll<HTMLElement>("[id]"))
      .map((element) => element.id)
      .filter(Boolean);
    expect(new Set(ids).size).to.equal(ids.length);
    for (const link of container.querySelectorAll<HTMLAnchorElement>(
      'a[href^="#"]',
    )) {
      expect(
        container.querySelector(
          `[id="${link.getAttribute("href")?.slice(1)}"]`,
        ),
      ).not.to.equal(null);
    }
  });

  it("keeps raw HTML inert and removes a javascript link destination", function () {
    const { container } = render(
      <AiReviewerMarkdown
        content={
          '<img src=x onerror="globalThis.pwned=true"><script>globalThis.pwned=true</script>\n\n[unsafe](javascript:alert(1))'
        }
      />,
    );

    expect(container.querySelector("img")).to.equal(null);
    expect(container.querySelector("script")).to.equal(null);
    expect(container.textContent).to.contain("<img src=x");
    const unsafeLink = screen.getByText("unsafe").closest("a");
    expect(unsafeLink).not.to.equal(null);
    expect(unsafeLink?.hasAttribute("href")).to.equal(false);
    expect((globalThis as unknown as { pwned?: boolean }).pwned).to.equal(
      undefined,
    );
  });

  it("renders assistant turns as markdown in the conversation", function () {
    const { container } = render(
      <AiReviewerDiscussionMessages
        turns={[{ role: "assistant", text: "**reviewer text**" }]}
      />,
    );
    const messages = container.querySelectorAll(".message-content");

    expect(messages).to.have.length(1);
    expect(messages[0].querySelector("strong")?.textContent).to.equal(
      "reviewer text",
    );
  });

  it("keeps show more and show less working on parsed markdown", function () {
    const content = [
      `> **Visible words continue** ${"bounded detail ".repeat(20)}`,
      "",
      "| Check | State |",
      "| --- | --- |",
      "| Markdown | rendered |",
    ].join("\n");
    const { container } = render(
      <AiReviewerExpandableMarkdown
        content={content}
        contentLimit={AI_REVIEWER_FINDING_MARKDOWN_CONTENT_LIMIT}
      />,
    );

    const collapsedQuote = container.querySelector("blockquote");
    const showMore = screen.getByRole("button", { name: "show more" });
    expect(collapsedQuote).not.to.equal(null);
    expect(collapsedQuote?.contains(showMore)).to.equal(false);
    expect(collapsedQuote?.querySelector("strong")?.textContent).to.equal(
      "Visible words continue",
    );
    expect(collapsedQuote?.textContent).not.to.contain("**");
    expect(container.querySelector("table")).to.equal(null);
    fireEvent.click(showMore);
    expect(container.querySelector("strong")?.textContent).to.equal(
      "Visible words continue",
    );
    expect(container.querySelectorAll("table tbody td")).to.have.length(2);
    fireEvent.click(screen.getByRole("button", { name: "show less" }));
    expect(container.querySelector("table")).to.equal(null);
    expect(container.querySelector("blockquote")).not.to.equal(null);
  });
});
