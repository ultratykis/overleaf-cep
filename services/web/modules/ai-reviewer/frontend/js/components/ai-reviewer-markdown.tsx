import OLButton from "@/shared/components/ol/ol-button";
import { PreventSelectingEntry } from "@/features/review-panel/components/review-panel-prevent-selecting";
import DOMPurify from "dompurify";
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { useCallback, useId, useMemo, useRef, useState, type FC } from "react";
import { useTranslation } from "react-i18next";

const MARKDOWN_TAGS = [
  "#text",
  "a",
  "blockquote",
  "code",
  "del",
  "em",
  "h2",
  "input",
  "li",
  "ol",
  "p",
  "pre",
  "section",
  "strong",
  "sup",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
  "ul",
];

const MARKDOWN_ATTRIBUTES = [
  "align",
  "aria-describedby",
  "aria-label",
  "checked",
  "class",
  "data-footnote-backref",
  "data-footnote-ref",
  "data-footnotes",
  "disabled",
  "href",
  "id",
  "rel",
  "target",
  "type",
];

export const AI_REVIEWER_FINDING_MARKDOWN_CONTENT_LIMIT = 240;

function renderSafeMarkdown(content: string, clobberPrefix: string) {
  const setSafeLinkAttributes = (node: Element) => {
    if (node.nodeName !== "A") {
      return;
    }
    if (node.getAttribute("href") === "") {
      node.removeAttribute("href");
      return;
    }
    if (node.getAttribute("href")?.startsWith("#")) {
      node.removeAttribute("rel");
      node.removeAttribute("target");
      return;
    }
    node.setAttribute("rel", "noreferrer noopener");
    node.setAttribute("target", "_blank");
  };

  DOMPurify.addHook("afterSanitizeAttributes", setSafeLinkAttributes);
  try {
    const footnoteLabelId = `${clobberPrefix}footnote-label`;
    const markdownHtml = micromark(content, {
      allowDangerousHtml: false,
      extensions: [gfm()],
      htmlExtensions: [
        gfmHtml({
          clobberPrefix,
          labelAttributes: 'class="visually-hidden"',
        }),
      ],
    })
      // The installed GFM extension does not apply clobberPrefix to its fixed
      // label id, so namespace both the label and every accessibility reference.
      .replace('id="footnote-label"', `id="${footnoteLabelId}"`)
      .replaceAll(
        'aria-describedby="footnote-label"',
        `aria-describedby="${footnoteLabelId}"`,
      );
    // Model HTML must remain text. The allowlist is a second boundary around
    // micromark so later parser changes cannot make new live markup available.
    return DOMPurify.sanitize(markdownHtml, {
      ALLOWED_TAGS: MARKDOWN_TAGS,
      ALLOWED_ATTR: MARKDOWN_ATTRIBUTES,
    });
  } finally {
    DOMPurify.removeHook("afterSanitizeAttributes");
  }
}

export const AiReviewerMarkdown: FC<{
  content: string;
  className?: string;
  translate?: "yes" | "no";
}> = ({ content, className, translate }) => {
  const markdownId = useId();
  const clobberPrefix = `ai-reviewer-${markdownId.replace(
    /[^A-Za-z0-9_-]/gu,
    "-",
  )}-`;
  const html = useMemo(
    () => renderSafeMarkdown(content, clobberPrefix),
    [clobberPrefix, content],
  );

  return (
    <div
      className={`ai-reviewer-markdown${
        className == null ? "" : ` ${className}`
      }`}
      translate={translate}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
};

export const AiReviewerExpandableMarkdown: FC<{
  content: string;
  className?: string;
  contentLimit?: number;
  newLineCharsLimit?: number;
  checkNewLines?: boolean;
  translate?: "yes" | "no";
}> = ({
  content,
  className,
  contentLimit = 50,
  newLineCharsLimit = 3,
  checkNewLines = true,
  translate,
}) => {
  const { t } = useTranslation();
  const contentRef = useRef<HTMLDivElement>(null);
  const [isExpanded, setIsExpanded] = useState(false);
  const limit = checkNewLines
    ? Math.min(
        contentLimit,
        indexOfNthLine(content, newLineCharsLimit) ?? Infinity,
      )
    : contentLimit;
  const isOverflowing = content.length > limit;
  const renderedContent = isExpanded ? content : content.slice(0, limit);

  const setExpanded = useCallback((expanded: boolean) => {
    setIsExpanded(expanded);
    contentRef.current?.dispatchEvent(
      new CustomEvent("review-panel:position", { bubbles: true }),
    );
  }, []);

  return (
    <>
      <div
        ref={contentRef}
        className={`review-panel-expandable-content${
          className == null ? "" : ` ${className}`
        }`}
        translate={translate}
      >
        <AiReviewerMarkdown content={renderedContent} />
        {isOverflowing && !isExpanded && "..."}
      </div>
      <div className="review-panel-expandable-links">
        <PreventSelectingEntry>
          {isExpanded ? (
            <OLButton
              variant="link"
              className="btn-inline-link"
              onClick={() => setExpanded(false)}
            >
              {t("show_less")}
            </OLButton>
          ) : (
            isOverflowing && (
              <OLButton
                variant="link"
                className="btn-inline-link"
                onClick={() => setExpanded(true)}
              >
                {t("show_more")}
              </OLButton>
            )
          )}
        </PreventSelectingEntry>
      </div>
    </>
  );
};

function indexOfNthLine(content: string, n: number) {
  if (n < 1) {
    return null;
  }
  let line = 0;
  for (let index = 0; index < content.length; index += 1) {
    if (content[index] === "\n") {
      line += 1;
      if (line === n) {
        return index;
      }
    }
  }
  return null;
}
