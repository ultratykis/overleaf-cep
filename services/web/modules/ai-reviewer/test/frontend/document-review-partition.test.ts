import { expect } from "chai";

import { partitionDocumentReview } from "../../frontend/js/services/document-review-partition";

describe("document review partitioning", function () {
  it("splits oversized documents at section boundaries with exact ranges", function () {
    const text = [
      "\\documentclass{article}",
      "\\section{One}",
      "one",
      "\\section{Two}",
      "two",
    ].join("\n");
    const result = partitionDocumentReview(text, 50);

    expect(result?.omitted).to.equal(0);
    expect(result?.parts).to.have.length(2);
    for (const part of result?.parts ?? []) {
      expect(part.text).to.equal(text.slice(part.range.from, part.range.to));
    }
    expect(result?.parts[0].text).to.include("\\section{One}");
    expect(result?.parts[1].text).to.equal("\\section{Two}\ntwo");
  });

  it("descends only an oversized section to subsection boundaries", function () {
    const text = [
      "\\section{Large}",
      "\\subsection{A}",
      "aaaa",
      "\\subsection{B}",
      "bbbb",
      "\\section{Small}",
      "ok",
    ].join("\n");
    const result = partitionDocumentReview(text, 38);

    expect(result?.omitted).to.equal(0);
    expect(result?.parts.map((part) => part.text)).to.deep.equal([
      "\\section{Large}\n\\subsection{A}\naaaa\n",
      "\\subsection{B}\nbbbb\n",
      "\\section{Small}\nok",
    ]);
  });

  it("omits indivisible oversized subsections and keeps usable parts", function () {
    const text = [
      "\\section{Large}",
      "\\subsection{Too large}",
      "x".repeat(80),
      "\\subsection{Usable}",
      "ok",
      "\\section{Also usable}",
      "fine",
    ].join("\n");
    const result = partitionDocumentReview(text, 45);

    expect(result?.omitted).to.equal(1);
    expect(result?.parts.map((part) => part.text)).to.deep.equal([
      "\\subsection{Usable}\nok\n",
      "\\section{Also usable}\nfine",
    ]);
  });

  it("does not split documents without sections or commented section commands", function () {
    expect(partitionDocumentReview("plain text", 3)).to.equal(null);
    expect(
      partitionDocumentReview(
        ["% \\section{Ignored}", "  % \\section{Also ignored}", "plain"].join(
          "\n",
        ),
        3,
      ),
    ).to.equal(null);
  });
});
