import { describe, expect, it } from "vitest";

import { extractLatexProjectRelations } from "../../../app/src/LatexProjectRelations.mjs";

const cases = [
  ["input", "input", ["sections/intro"], String.raw`\input{sections/intro}`],
  [
    "include",
    "include",
    ["chapters/results"],
    String.raw`\include{chapters/results}`,
  ],
  ["section", "section", ["日本語😀"], String.raw`\section{日本語😀}`],
  ["section", "subsection", ["Related"], String.raw`\subsection{Related}`],
  ["section", "subsubsection", ["Detail"], String.raw`\subsubsection{Detail}`],
  ["label", "label", ["sec:emoji"], String.raw`\label{sec:emoji}`],
  ["ref", "ref", ["sec:emoji"], String.raw`\ref{sec:emoji}`],
  ["ref", "eqref", ["eq:one"], String.raw`\eqref{eq:one}`],
  ["ref", "autoref", ["sec:emoji"], String.raw`\autoref{sec:emoji}`],
  ["ref", "cref", ["eq:one"], String.raw`\cref{eq:one}`],
  ["ref", "Cref", ["sec:emoji"], String.raw`\Cref{sec:emoji}`],
  [
    "cite",
    "cite",
    ["alpha", "beta"],
    String.raw`\cite[see][p. 1]{alpha, beta}`,
  ],
  ["cite", "citet", ["gamma"], String.raw`\citet{gamma}`],
  ["cite", "citep", ["delta"], String.raw`\citep{delta}`],
  ["cite", "parencite", ["epsilon"], String.raw`\parencite{epsilon}`],
  ["cite", "textcite", ["zeta"], String.raw`\textcite{zeta}`],
  [
    "bibliography",
    "bibliography",
    ["references", "more"],
    String.raw`\bibliography{references, more}`,
  ],
  [
    "bibliography",
    "addbibresource",
    ["extra.bib"],
    String.raw`\addbibresource[location=local]{extra.bib}`,
  ],
];

describe("LaTeX project relationships", function () {
  it("extracts supported relationships with exact frozen ranges", function () {
    const source = cases.map((entry) => entry[3]).join("\n");
    const facts = extractLatexProjectRelations(source);

    expect(
      facts.map((fact) => [
        fact.kind,
        fact.macro,
        fact.values,
        source.slice(fact.range.from, fact.range.to),
      ]),
    ).toEqual(cases);
    expect(Object.isFrozen(facts)).toBe(true);
    for (const fact of facts) {
      expect(Object.keys(fact)).toEqual(["kind", "macro", "values", "range"]);
      expect(Object.isFrozen(fact)).toBe(true);
      expect(Object.isFrozen(fact.values)).toBe(true);
      expect(Object.isFrozen(fact.range)).toBe(true);
    }
  });

  it("uses JavaScript character offsets and ignores opaque source", function () {
    const source = [
      "😀",
      String.raw`% \input{ignored-comment}`,
      String.raw`\verb|\ref{ignored-verb}|`,
      String.raw`\begin{verbatim}`,
      String.raw`\cite{ignored-verbatim}`,
      String.raw`\end{verbatim}`,
      String.raw`\label{kept}`,
    ].join("\n");
    const facts = extractLatexProjectRelations(source);
    const invocation = String.raw`\label{kept}`;

    expect(facts).toHaveLength(1);
    expect(facts[0].values).toEqual(["kept"]);
    expect(facts[0].range.from).toBe(source.indexOf(invocation));
    expect(source.slice(facts[0].range.from, facts[0].range.to)).toBe(
      invocation,
    );
  });

  it("enforces the UTF-8 byte bound and does not scan malformed input", function () {
    const invocation = String.raw`\input{kept}`;
    const accepted =
      invocation + "x".repeat(102_400 - Buffer.byteLength(invocation, "utf8"));

    expect(Buffer.byteLength(accepted, "utf8")).toBe(102_400);
    expect(extractLatexProjectRelations(accepted)[0].values).toEqual(["kept"]);
    expect(() => extractLatexProjectRelations(`${accepted}x`)).toThrow(
      RangeError,
    );
    expect(() =>
      extractLatexProjectRelations(String.raw`\cite{broken`),
    ).toThrow();
  });
});
