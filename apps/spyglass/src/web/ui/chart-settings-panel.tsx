import type { RefObject } from "react";
import { useCallback } from "react";
import type { ChartSettings, ReaderSettings } from "../settings/chart-settings";
import { ReaderSettingsSection } from "./reader-settings";
import type { SpyglassMapHandle } from "./spyglass-map";

/**
 * The reader's chart layers and reset action.
 */
export function ChartSettingsPanel({
  onChange,
  onReset,
  scene,
  settings,
}: {
  onChange: (settings: ChartSettings) => void;
  onReset: () => void;
  scene: RefObject<SpyglassMapHandle | null>;
  settings: ChartSettings;
}) {
  const changeReader = useCallback(
    (reader: ReaderSettings) => onChange({ ...settings, ...reader }),
    [onChange, settings]
  );
  const disabled = !scene.current;
  return (
    <div className="spyglass-chart-settings">
      <ReaderSettingsSection
        disabled={disabled}
        onChange={changeReader}
        settings={settings}
      />
      <button
        className="spyglass-settings-reset"
        onClick={onReset}
        type="button"
      >
        Reset visualization
      </button>
    </div>
  );
}
