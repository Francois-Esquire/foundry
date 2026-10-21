import "./settings-controls.css";
import { useCallback } from "react";
import type { ChartSettings, ReaderSettings } from "../settings/chart-settings";
import { ReaderSettingsSection } from "./reader-settings";

/**
 * Reader controls grouped by the meaning they add to the chart.
 */
export function ChartSettingsPanel({
  onChange,
  category,
  disabled,
  settings,
}: {
  onChange: (settings: ChartSettings) => void;
  category: "map" | "atmosphere";
  disabled: boolean;
  settings: ChartSettings;
}) {
  const changeReader = useCallback(
    (reader: ReaderSettings) => onChange({ ...settings, ...reader }),
    [onChange, settings]
  );
  return (
    <div className="spyglass-chart-settings">
      <ReaderSettingsSection
        category={category}
        disabled={disabled}
        onChange={changeReader}
        settings={settings}
      />
    </div>
  );
}
