import { useCallback } from "react";
import type { SceneComposition } from "../settings/scene-composition";
import type { ChromeContext } from "./chrome-entries";
import {
  DeveloperSettingsSection,
  SceneLayersSection,
} from "./developer-settings";

/** Imported only in development; production builds have no tools chunk. */
export function DeveloperStats({ actions, state }: ChromeContext) {
  const { settings } = actions;
  const compose = useCallback(
    (composition: SceneComposition) =>
      settings((current) => ({ ...current, composition })),
    [settings]
  );
  return (
    <div className="spyglass-chart-settings spyglass-development-tools">
      <SceneLayersSection
        composition={state.chartSettings.composition}
        onChange={compose}
      />
      <DeveloperSettingsSection scene={actions.scene} />
    </div>
  );
}
