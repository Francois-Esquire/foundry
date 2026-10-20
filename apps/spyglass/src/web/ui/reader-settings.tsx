import type { ChangeEvent } from "react";
import { useCallback } from "react";
import type { ReaderSettings } from "../settings/chart-settings";

type Control = readonly [keyof ReaderSettings, string];

const layers: readonly Control[] = [
  ["trade", "Sea trade routes"],
  ["streams", "District streams"],
  ["volcanic", "Recorded change"],
  ["contours", "Topographic lines"],
];

const weather: readonly Control[] = [
  ["waves", "Rim waves"],
  ["clouds", "Cloud shadow"],
];

/** One checkbox per control, named for its setting. */
function Checkboxes({
  controls,
  disabled,
  onChange,
  settings,
}: {
  controls: readonly Control[];
  disabled: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  settings: ReaderSettings;
}) {
  return controls.map(([key, label]) => (
    <label
      className="spyglass-boundary-control spyglass-layer-control"
      key={key}
    >
      <input
        checked={settings[key]}
        disabled={disabled}
        name={key}
        onChange={onChange}
        type="checkbox"
      />
      <span>{label}</span>
    </label>
  ));
}

/**
 * What a reader may turn on or off: the layers, each drawing data the scan
 * measured, and the weather, which draws none and moves.
 */
export function ReaderSettingsSection({
  disabled,
  onChange,
  settings,
}: {
  disabled: boolean;
  onChange: (settings: ReaderSettings) => void;
  settings: ReaderSettings;
}) {
  const change = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const key = [...layers, ...weather].find(
        ([name]) => name === event.currentTarget.name
      );
      if (key) {
        onChange({ ...settings, [key[0]]: event.currentTarget.checked });
      }
    },
    [onChange, settings]
  );
  return (
    <>
      <details open>
        <summary>Layers</summary>
        <p>
          Each layer draws something the scan measured. Turning one on or off
          does not move an island.
        </p>
        <Checkboxes
          controls={layers}
          disabled={disabled}
          onChange={change}
          settings={settings}
        />
        <p>
          Trade routes join each package to its leading consumers. Inside an
          island, high fan-in files raise summits, and topographic lines trace
          them. Unresolved belonging is marsh. Streams draw the imports between
          districts and meet at composition junctions. Recorded change uses
          saved Git history.
        </p>
      </details>
      <details open>
        <summary>Weather</summary>
        <p>
          Decoration that carries no data: surf along each archipelago&apos;s
          rim, and the shadow of clouds drifting over the chart. Both stand
          still when the system asks for reduced motion.
        </p>
        <Checkboxes
          controls={weather}
          disabled={disabled}
          onChange={change}
          settings={settings}
        />
      </details>
    </>
  );
}
