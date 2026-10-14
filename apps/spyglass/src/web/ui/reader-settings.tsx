import type { ChangeEvent } from "react";
import { useCallback } from "react";
import type { ReaderSettings } from "../chart-settings";

const layers: readonly [keyof ReaderSettings, string][] = [
  ["trade", "Sea trade routes"],
  ["streams", "District streams"],
  ["volcanic", "Recorded change"],
  ["contours", "Topographic lines"],
];

/** The layers a reader may turn on; each draws data the scan measured. */
export function ReaderSettingsSection({
  disabled,
  onChange,
  settings,
}: {
  disabled: boolean;
  onChange: (settings: ReaderSettings) => void;
  settings: ReaderSettings;
}) {
  const changeLayer = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const key = layers.find(([name]) => name === event.currentTarget.name);
      if (key) {
        onChange({ ...settings, [key[0]]: event.currentTarget.checked });
      }
    },
    [onChange, settings]
  );
  return (
    <details open>
      <summary>Layers</summary>
      <p>
        Each layer draws something the scan measured. Turning one on or off does
        not move an island.
      </p>
      {layers.map(([key, label]) => (
        <label
          className="spyglass-boundary-control spyglass-layer-control"
          key={key}
        >
          <input
            checked={settings[key]}
            disabled={disabled}
            name={key}
            onChange={changeLayer}
            type="checkbox"
          />
          <span>{label}</span>
        </label>
      ))}
      <p>
        Trade routes join each package to its leading consumers. Inside an
        island, high fan-in files raise summits, and topographic lines trace
        them. Unresolved belonging is marsh. Streams draw the imports between
        districts and meet at composition junctions. Recorded change uses saved
        Git history.
      </p>
    </details>
  );
}
