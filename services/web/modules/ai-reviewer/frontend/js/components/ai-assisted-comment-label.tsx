import OLBadge from "@/shared/components/ol/ol-badge";
import { useProjectContext } from "@/shared/context/project-context";
import { Fragment, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useAiReviewerCommentProvenance } from "../services/ai-reviewer-comment-provenance";

type AiAssistedCommentLabelProps = {
  commentId: string;
  children: ReactNode;
};

export default function AiAssistedCommentLabel({
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
