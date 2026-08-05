import IntegrationCard from "@/features/integrations-panel/integration-card";
import MaterialIcon from "@/shared/components/material-icon";
import getMeta from "@/utils/meta";
import { lazy, Suspense, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

type DetailsModule = {
  default: React.ComponentType<{ onHide: () => void }>;
};

type AiIntegrationCardProps = {
  enabled: boolean;
  loadDetails?: () => Promise<DetailsModule>;
};

const loadDefaultDetails = () => import("./ai-integration-details");

export function AiIntegrationCard({
  enabled,
  loadDetails = loadDefaultDetails,
}: AiIntegrationCardProps) {
  const { t } = useTranslation();
  const [showDetails, setShowDetails] = useState(false);
  const Details = useMemo(() => lazy(loadDetails), [loadDetails]);

  if (!enabled) {
    return null;
  }

  return (
    <>
      <IntegrationCard
        title={t("ai_reviewer_title")}
        description={t("ai_reviewer_integration_description")}
        icon={<MaterialIcon type="smart_toy" />}
        showPaywallBadge={false}
        onClick={() => setShowDetails(true)}
      />
      {showDetails && (
        <Suspense fallback={null}>
          <Details onHide={() => setShowDetails(false)} />
        </Suspense>
      )}
    </>
  );
}

export function createAiIntegrationCard({
  enabled,
  loadDetails = loadDefaultDetails,
}: AiIntegrationCardProps) {
  if (!enabled) {
    return null;
  }
  return <AiIntegrationCard enabled={enabled} loadDetails={loadDetails} />;
}

export default function ConfiguredAiIntegrationCard() {
  return (
    <AiIntegrationCard
      enabled={getMeta("ol-ExposedSettings").aiReviewerEnabled}
    />
  );
}
