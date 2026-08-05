export type DocumentReviewPart = {
  range: { from: number; to: number };
  text: string;
};

export type DocumentReviewPartition = {
  parts: DocumentReviewPart[];
  omitted: number;
};

function boundaries(text: string, command: "section" | "subsection") {
  const pattern = new RegExp(
    `^(?![\\t ]*%)^[\\t ]*\\\\${command}\\{[^\\n]*\\}`,
    "gm",
  );
  return [...text.matchAll(pattern)].map((match) => match.index);
}

function rangesFromBoundaries(
  text: string,
  starts: number[],
  offset = 0,
): DocumentReviewPart[] {
  return starts.map((start, index) => {
    const from = index === 0 ? 0 : start;
    const to = starts[index + 1] ?? text.length;
    return {
      range: { from: offset + from, to: offset + to },
      text: text.slice(from, to),
    };
  });
}

export function partitionDocumentReview(
  text: string,
  maxPartCharacters: number,
): DocumentReviewPartition | null {
  const sectionStarts = boundaries(text, "section");
  if (sectionStarts.length === 0) {
    return null;
  }

  const parts: DocumentReviewPart[] = [];
  let omitted = 0;
  for (const section of rangesFromBoundaries(text, sectionStarts)) {
    if (section.text.length <= maxPartCharacters) {
      parts.push(section);
      continue;
    }
    const subsectionStarts = boundaries(section.text, "subsection");
    if (subsectionStarts.length === 0) {
      omitted += 1;
      continue;
    }
    for (const subsection of rangesFromBoundaries(
      section.text,
      subsectionStarts,
      section.range.from,
    )) {
      if (subsection.text.length <= maxPartCharacters) {
        parts.push(subsection);
      } else {
        omitted += 1;
      }
    }
  }
  return { parts, omitted };
}
