import { useCallback } from "react";
import type { DeveloperSettings } from "../settings/chart-settings";
import type { ChromeContext } from "./chrome-entries";
import { DeveloperSettingsSection } from "./developer-settings";

/** Imported only in development; production builds have no tools chunk. */
export default function DeveloperTools({ state, actions }: ChromeContext) {
  const change = useCallback(
    (next: DeveloperSettings) =>
      actions.settings({ ...state.chartSettings, ...next }),
    [actions.settings, state.chartSettings]
  );
  return (
    <div className="spyglass-chart-settings spyglass-development-tools">
      <DeveloperSettingsSection
        disabled={!actions.scene.current}
        layoutPending={
          state.chartSettings.coastalBuffer !==
            state.layoutSettings.coastalBuffer ||
          state.chartSettings.islandClearance !==
            state.layoutSettings.islandClearance
        }
        onChange={change}
        scene={actions.scene}
        settings={state.chartSettings}
      />
    </div>
  );
}
