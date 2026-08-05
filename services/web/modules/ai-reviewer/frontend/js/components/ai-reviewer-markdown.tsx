import OLButton from "@/shared/components/ol/ol-button";
import { PreventSelectingEntry } from "@/features/review-panel/components/review-panel-prevent-selecting";
import DOMPurify from "dompurify";
import { micromark } from "micromark";
import { useCallback, useMemo, useRef, useState, type FC } from "react";
import { useTranslation } from "react-i18next";

const MARKDOWN_TAGS = [
  "#text",
  "a",
  "blockquote",
  "code",
  "em",
  "li",
  "ol",
  "p",
  "pre",
  "strong",
  "ul",
];

const MARKDOWN_ATTRIBUTES = ["href", "rel", "target"];

function renderSafeMarkdown(content: string) {
  const setSafeLinkAttributes = (node: Element) => {
    if (node.nodeName !== "A") {
      return;
    }
    if (node.getAttribute("href") === "") {
      node.removeAttribute("href");
      return;
    }
    node.setAttribute("rel", "noreferrer noopener");
    node.setAttribute("target", "_blank");
  };

  DOMPurify.addHook("afterSanitizeAttributes", setSafeLinkAttributes);
  try {
    // Model HTML must remain text. The allowlist is a second boundary around
    // micromark so later parser changes cannot make new live markup available.
    return DOMPurify.sanitize(
      micromark(content, { allowDangerousHtml: false }),
      {
        ALLOWED_TAGS: MARKDOWN_TAGS,
        ALLOWED_ATTR: MARKDOWN_ATTRIBUTES,
      },
    );
  } finally {
    DOMPurify.removeHook("afterSanitizeAttributes");
  }
}

export const AiReviewerMarkdown: FC<{
  content: string;
  className?: string;
  translate?: "yes" | "no";
}> = ({ content, className, translate }) => {
  const html = useMemo(() => renderSafeMarkdown(content), [content]);

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
