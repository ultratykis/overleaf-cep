import { fireEvent, render, screen } from "@testing-library/react";
import { expect } from "chai";
import React from "react";

import { AiReviewerDiscussionMessages } from "../../frontend/js/components/ai-reviewer-discussion-messages";
import {
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
    const { container } = render(
      <AiReviewerExpandableMarkdown
        content={
          "> **Visible words continue**\n\n- first\n- second\n\nMore details"
        }
        contentLimit={18}
        checkNewLines={false}
      />,
    );

    const collapsedQuote = container.querySelector("blockquote");
    const showMore = screen.getByRole("button", { name: "show more" });
    expect(collapsedQuote).not.to.equal(null);
    expect(collapsedQuote?.contains(showMore)).to.equal(false);
    expect(container.querySelector("ul")).to.equal(null);
    fireEvent.click(showMore);
    expect(container.querySelector("strong")?.textContent).to.equal(
      "Visible words continue",
    );
    expect(container.querySelectorAll("ul > li")).to.have.length(2);
    fireEvent.click(screen.getByRole("button", { name: "show less" }));
    expect(container.querySelector("ul")).to.equal(null);
    expect(container.querySelector("blockquote")).not.to.equal(null);
  });
});
