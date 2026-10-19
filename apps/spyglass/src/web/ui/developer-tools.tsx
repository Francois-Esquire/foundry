import { useCallback } from "react";
import type { DeveloperSettings } from "../settings/chart-settings";
import type { ChromeContext } from "./chrome-entries";
import { DeveloperSettingsSection } from "./developer-settings";

/** Imported only in development; production builds have no tools chunk. */
export default function DeveloperTools({
  state,
  actions,
  section,
}: ChromeContext & { section: "layers" | "rendering" | "stats" }) {
  const change = useCallback(
    (next: DeveloperSettings) =>
      actions.settings({ ...state.chartSettings, ...next }),
    [actions.settings, state.chartSettings]
  );
  return (
    <div className="spyglass-chart-settings spyglass-development-tools">
      <DeveloperSettingsSection
        disabled={!actions.sceneReady}
        layoutPending={
          state.chartSettings.coastalBuffer !==
            state.layoutSettings.coastalBuffer ||
          state.chartSettings.islandClearance !==
            state.layoutSettings.islandClearance ||
          state.chartSettings.foundationInfluence !==
            state.layoutSettings.foundationInfluence
        }
        onChange={change}
        scene={actions.scene}
        section={section}
        settings={state.chartSettings}
      />
    </div>
  );
}

export function DeveloperLayers(props: ChromeContext) {
  return <DeveloperTools {...props} section="layers" />;
}
export function DeveloperRendering(props: ChromeContext) {
  return <DeveloperTools {...props} section="rendering" />;
}
export function DeveloperStats(props: ChromeContext) {
  return <DeveloperTools {...props} section="stats" />;
}
