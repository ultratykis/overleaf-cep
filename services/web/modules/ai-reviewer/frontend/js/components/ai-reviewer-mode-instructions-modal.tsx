import OLButton from "@/shared/components/ol/ol-button";
import OLForm from "@/shared/components/ol/ol-form";
import OLFormControl from "@/shared/components/ol/ol-form-control";
import OLFormGroup from "@/shared/components/ol/ol-form-group";
import OLFormLabel from "@/shared/components/ol/ol-form-label";
import OLFormText from "@/shared/components/ol/ol-form-text";
import {
  OLModal,
  OLModalBody,
  OLModalFooter,
  OLModalHeader,
  OLModalTitle,
} from "@/shared/components/ol/ol-modal";
import { type FormEvent, useState } from "react";
import { useTranslation } from "react-i18next";

import type { AiReviewerModeInstructions } from "../../../shared/contract-types";
import { AI_REVIEWER_MODE_INSTRUCTION_MAX_LENGTH } from "../../../shared/contracts.mjs";

type Props = {
  initialInstructions: AiReviewerModeInstructions;
  saving: boolean;
  error: string | null;
  onHide: () => void;
  onSave: (instructions: AiReviewerModeInstructions) => void;
};

function normalizedInstructions(
  refereeReview: string,
  brainstorm: string,
): AiReviewerModeInstructions {
  const refereeReviewInstruction = refereeReview.trim();
  const brainstormInstruction = brainstorm.trim();
  return {
    ...(refereeReviewInstruction === ""
      ? {}
      : { "referee-review": refereeReviewInstruction }),
    ...(brainstormInstruction === ""
      ? {}
      : { brainstorm: brainstormInstruction }),
  };
}

export function AiReviewerModeInstructionsModal({
  initialInstructions,
  saving,
  error,
  onHide,
  onSave,
}: Props) {
  const { t } = useTranslation();
  const [refereeReview, setRefereeReview] = useState(
    initialInstructions["referee-review"] ?? "",
  );
  const [brainstorm, setBrainstorm] = useState(
    initialInstructions.brainstorm ?? "",
  );
  const invalid =
    refereeReview.length > AI_REVIEWER_MODE_INSTRUCTION_MAX_LENGTH ||
    brainstorm.length > AI_REVIEWER_MODE_INSTRUCTION_MAX_LENGTH;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!saving && !invalid) {
      onSave(normalizedInstructions(refereeReview, brainstorm));
    }
  };

  const field = (
    mode: "referee-review" | "brainstorm",
    value: string,
    setValue: (value: string) => void,
  ) => {
    const controlId = `ai-reviewer-${mode}-instruction`;
    const helpId = `${controlId}-help`;
    return (
      <OLFormGroup
        controlId={controlId}
        className="ai-reviewer-mode-instruction-field"
      >
        <div className="ai-reviewer-mode-instruction-heading">
          <OLFormLabel>
            {mode === "referee-review"
              ? t("ai_reviewer_mode_review")
              : t("ai_reviewer_mode_brainstorm")}
          </OLFormLabel>
          <OLButton
            type="button"
            variant="link"
            size="sm"
            disabled={saving || value === ""}
            onClick={() => setValue("")}
          >
            {t("ai_reviewer_perspective_use_built_in")}
          </OLButton>
        </div>
        <OLFormControl
          as="textarea"
          value={value}
          maxLength={AI_REVIEWER_MODE_INSTRUCTION_MAX_LENGTH}
          rows={8}
          disabled={saving}
          aria-describedby={helpId}
          placeholder={t("ai_reviewer_perspective_built_in_placeholder")}
          onChange={(event) => setValue(event.currentTarget.value)}
        />
        <OLFormText id={helpId}>
          {t("ai_reviewer_perspective_character_count", {
            count: value.length,
            limit: AI_REVIEWER_MODE_INSTRUCTION_MAX_LENGTH,
          })}
        </OLFormText>
      </OLFormGroup>
    );
  };

  return (
    <OLModal
      show
      scrollable
      onHide={onHide}
      dialogClassName="ai-reviewer-mode-instructions-settings"
    >
      <OLModalHeader closeButton closeLabel={t("close")}>
        <OLModalTitle>{t("ai_reviewer_perspectives")}</OLModalTitle>
      </OLModalHeader>
      <OLModalBody className="ai-reviewer-mode-instructions-body">
        <OLForm id="ai-reviewer-mode-instructions-form" onSubmit={submit}>
          <p>{t("ai_reviewer_perspectives_help")}</p>
          {field("referee-review", refereeReview, setRefereeReview)}
          {field("brainstorm", brainstorm, setBrainstorm)}
          {error != null && (
            <p className="ai-reviewer-mode-instruction-error mb-0" role="alert">
              {error}
            </p>
          )}
        </OLForm>
      </OLModalBody>
      <OLModalFooter>
        <OLButton
          type="button"
          variant="secondary"
          disabled={saving}
          onClick={onHide}
        >
          {t("cancel")}
        </OLButton>
        <OLButton
          type="submit"
          form="ai-reviewer-mode-instructions-form"
          variant="primary"
          disabled={saving || invalid}
        >
          {t("save")}
        </OLButton>
      </OLModalFooter>
    </OLModal>
  );
}
