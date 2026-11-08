import "./settings-controls.css";
import { useCallback } from "react";
import type { ChartSettings, ReaderSettings } from "../settings/chart-settings";
import { ReaderSettingsSection } from "./reader-settings";

/** The reader's controls: the camera and the atmosphere. */
export function ChartSettingsPanel({
  onChange,
  disabled,
  settings,
}: {
  onChange: (settings: ChartSettings) => void;
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
        disabled={disabled}
        onChange={changeReader}
        settings={settings}
      />
    </div>
  );
}
