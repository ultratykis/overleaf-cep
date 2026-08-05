import type { RailElement } from "@/features/ide-react/util/rail-types";
import getMeta from "@/utils/meta";
import { lazy, Suspense } from "react";

type PanelModule = {
  default: React.ComponentType;
};

type RailEntryOptions = {
  enabled: boolean;
  loadPanel?: () => Promise<PanelModule>;
};

const loadDefaultPanel = () => import("./ai-reviewer-panel");

export function createAiReviewerRailEntry({
  enabled,
  loadPanel = loadDefaultPanel,
}: RailEntryOptions): RailElement {
  if (!enabled) {
    return {
      key: "ai-reviewer",
      icon: "smart_toy",
      title: "AI reviewer",
      component: null,
      hide: true,
    };
  }

  const LazyPanel = lazy(loadPanel);
  return {
    key: "ai-reviewer",
    icon: "smart_toy",
    title: "AI reviewer",
    component: (
      <Suspense fallback={null}>
        <LazyPanel />
      </Suspense>
    ),
    hide: false,
  };
}

export default createAiReviewerRailEntry({
  enabled: getMeta("ol-ExposedSettings").aiReviewerEnabled,
});
