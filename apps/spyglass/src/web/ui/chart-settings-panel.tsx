import type { RefObject } from "react";
import { useCallback } from "react";
import type {
  ChartSettings,
  DeveloperSettings,
  ReaderSettings,
} from "../chart-settings";
import { DeveloperSettingsSection } from "./developer-settings";
import { ReaderSettingsSection } from "./reader-settings";
import type { SpyglassMapHandle } from "./spyglass-map";

/**
 * The Chart section: the reader's layers, and in a developer session the
 * layout's and the renderer's controls beneath them.
 */
export function ChartSettingsPanel({
  developer = false,
  layoutPending = false,
  onChange,
  onReset,
  scene,
  settings,
}: {
  developer?: boolean;
  layoutPending?: boolean;
  onChange: (settings: ChartSettings) => void;
  onReset: () => void;
  scene: RefObject<SpyglassMapHandle | null>;
  settings: ChartSettings;
}) {
  const changeReader = useCallback(
    (reader: ReaderSettings) => onChange({ ...settings, ...reader }),
    [onChange, settings]
  );
  const changeDeveloper = useCallback(
    (next: DeveloperSettings) => onChange({ ...settings, ...next }),
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
      {developer && (
        <DeveloperSettingsSection
          disabled={disabled}
          layoutPending={layoutPending}
          onChange={changeDeveloper}
          scene={scene}
          settings={settings}
        />
      )}
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
