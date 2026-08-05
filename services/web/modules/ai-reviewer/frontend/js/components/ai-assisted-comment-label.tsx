import OLBadge from "@/shared/components/ol/ol-badge";
import { useProjectContext } from "@/shared/context/project-context";
import getMeta from "@/utils/meta";
import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useAiReviewerCommentProvenance } from "../services/ai-reviewer-comment-provenance";

type AiAssistedCommentLabelProps = {
  commentId: string;
  children: ReactNode;
};

function EnabledAiAssistedCommentLabel({
  commentId,
  children,
}: AiAssistedCommentLabelProps) {
  const { t } = useTranslation();
  const { projectId } = useProjectContext();
  const isAiAssisted = useAiReviewerCommentProvenance(projectId, commentId);

  if (!isAiAssisted) {
    return <Fragment>{children}</Fragment>;
  }

  return (
    <div className="review-panel-comment">
      <OLBadge bg="info" className="mb-1">
        {t("ai_reviewer_ai_assisted_comment_label")}
      </OLBadge>
      {children}
    </div>
  );
}

export default function AiAssistedCommentLabel(
  props: AiAssistedCommentLabelProps,
) {
  if (getMeta("ol-ExposedSettings").aiReviewerEnabled === false) {
    return <Fragment>{props.children}</Fragment>;
  }
  return <EnabledAiAssistedCommentLabel {...props} />;
}
