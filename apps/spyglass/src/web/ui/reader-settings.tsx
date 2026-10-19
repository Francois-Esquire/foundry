import type { ChangeEvent } from "react";
import { useCallback } from "react";
import {
  type CameraAngleId,
  cameraAngleAt,
  cameraAngles,
  cameraElevationRange,
  type ReaderSettings,
} from "../settings/chart-settings";
import { SettingsRange, SettingsSelect } from "./settings-controls";

type ToggleKey = {
  [K in keyof ReaderSettings]: ReaderSettings[K] extends boolean ? K : never;
}[keyof ReaderSettings];

type Control = readonly [ToggleKey, string];

const layers: readonly Control[] = [
  ["trade", "Sea trade routes"],
  ["streams", "District streams"],
  ["volcanic", "Recorded change"],
  ["contours", "Topographic lines"],
];

const weather: readonly Control[] = [
  ["waves", "Water motion"],
  ["clouds", "Foundation light"],
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

/** The option the angle list shows for an elevation between the named angles. */
const customAngle = "custom";
/** The named angles in the order the list offers them. */
const angleOrder: readonly CameraAngleId[] = ["top-down", "chart", "isometric"];

/**
 * The camera's angle: a named view, or any elevation between straight down
 * and the lowest the camera may lie. A change swings the camera there.
 */
function CameraAngle({
  disabled,
  onChange,
  settings,
}: {
  disabled: boolean;
  onChange: (settings: ReaderSettings) => void;
  settings: ReaderSettings;
}) {
  const { elevation } = settings.camera;
  const named = cameraAngleAt(elevation);
  const choose = useCallback(
    (_key: "angle", value: string) => {
      if (Object.hasOwn(cameraAngles, value)) {
        onChange({
          ...settings,
          camera: { elevation: cameraAngles[value as CameraAngleId].elevation },
        });
      }
    },
    [onChange, settings]
  );
  const tilt = useCallback(
    (_key: "elevation", value: number) =>
      onChange({ ...settings, camera: { elevation: value } }),
    [onChange, settings]
  );
  return (
    <section aria-label="Camera">
      <h3>Camera</h3>
      <p>
        The angle the chart is seen from. Straight down reads as a flat map;
        lower angles show the relief. The light stays where it is.
      </p>
      <SettingsSelect
        disabled={disabled}
        label="Camera angle"
        name="angle"
        onChange={choose}
        options={[
          ...angleOrder.map((value) => ({
            label: cameraAngles[value].label,
            value,
          })),
          ...(named
            ? []
            : [{ disabled: true, label: "Custom", value: customAngle }]),
        ]}
        value={named ?? customAngle}
      />
      <SettingsRange
        disabled={disabled}
        label="Elevation"
        max={cameraElevationRange.max}
        min={cameraElevationRange.min}
        name="elevation"
        onChange={tilt}
        step={1}
        unit="°"
        value={elevation}
      />
    </section>
  );
}

/**
 * What a reader may turn on or off: the layers, each drawing data the scan
 * measured, and the weather, which draws none and moves.
 */
export function ReaderSettingsSection({
  category,
  disabled,
  onChange,
  settings,
}: {
  category: "map" | "atmosphere";
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
      {category === "map" && (
        <section aria-label="Measured layers">
          <h3>Measured layers</h3>
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
            Trade routes connect packages; streams connect districts.
            Topographic lines follow file fan-in. Recorded change uses saved Git
            history.
          </p>
        </section>
      )}
      {category === "atmosphere" && (
        <CameraAngle
          disabled={disabled}
          onChange={onChange}
          settings={settings}
        />
      )}
      {category === "atmosphere" && (
        <section aria-label="Atmosphere">
          <h3>Atmosphere</h3>
          <p>
            Decoration that carries no data: surface movement and surf along
            each archipelago&apos;s rim, and moving light over dependency
            foundations. Plateau positions and membership remain fixed. Both
            stand still when the system asks for reduced motion.
          </p>
          <Checkboxes
            controls={weather}
            disabled={disabled}
            onChange={change}
            settings={settings}
          />
        </section>
      )}
    </>
  );
}
