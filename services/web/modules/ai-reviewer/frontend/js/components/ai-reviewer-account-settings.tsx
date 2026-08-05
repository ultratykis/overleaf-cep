import OLButton from "@/shared/components/ol/ol-button";
import getMeta from "@/utils/meta";
import { lazy, Suspense, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

type DetailsModule = {
  default: React.ComponentType<{ onHide: () => void }>;
};

type Props = {
  enabled: boolean;
  loadDetails?: () => Promise<DetailsModule>;
};

const loadDefaultDetails = async (): Promise<DetailsModule> => {
  const details = await import("./ai-integration-details");
  return { default: details.AiReviewerAccountSettingsDetails };
};

export function AiReviewerAccountSettings({
  enabled,
  loadDetails = loadDefaultDetails,
}: Props) {
  const { t } = useTranslation();
  const [showDetails, setShowDetails] = useState(false);
  const Details = useMemo(() => lazy(loadDetails), [loadDetails]);

  if (!enabled) return null;

  return (
    <>
      <hr />
      <section aria-labelledby="ai-reviewer-account-settings-heading">
        <h3 id="ai-reviewer-account-settings-heading">
          {t("ai_reviewer_title")}
        </h3>
        <p>{t("ai_reviewer_account_settings_description")}</p>
        <OLButton
          type="button"
          variant="secondary"
          onClick={() => setShowDetails(true)}
        >
          {t("ai_reviewer_manage_connections_and_skills")}
        </OLButton>
      </section>
      {showDetails && (
        <Suspense fallback={null}>
          <Details onHide={() => setShowDetails(false)} />
        </Suspense>
      )}
    </>
  );
}

export default function ConfiguredAiReviewerAccountSettings() {
  return (
    <AiReviewerAccountSettings
      enabled={getMeta("ol-ExposedSettings").aiReviewerEnabled}
    />
  );
}
