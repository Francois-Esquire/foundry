import { useCallback } from "react";
import {
  type CameraAngleId,
  cameraAngleAt,
  cameraAngles,
  type ReaderSettings,
  readerLayout,
  readerParams,
} from "../settings/chart-settings";
import { ParamSection, SettingsSelect } from "./settings-controls";

/** The option the angle list shows for an elevation between the named angles. */
const customAngle = "custom";
const angleOrder: readonly CameraAngleId[] = ["top-down", "chart", "isometric"];

/**
 * The camera's named angles, a preset over the elevation: choosing one
 * swings the camera there; an elevation between them shows as custom.
 */
function CameraAngle({
  disabled,
  elevation,
  onChange,
}: {
  disabled: boolean;
  elevation: number;
  onChange: (elevation: number) => void;
}) {
  const named = cameraAngleAt(elevation);
  const choose = useCallback(
    (_key: "angle", value: string) => {
      if (Object.hasOwn(cameraAngles, value)) {
        onChange(cameraAngles[value as CameraAngleId].elevation);
      }
    },
    [onChange]
  );
  return (
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
  );
}

/**
 * What a reader may change, drawn from `readerParams` in `readerLayout`'s
 * sections: the camera's elevation, with its named angles over it, and the
 * waves, which draw no data and move.
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
    (key: keyof ReaderSettings, value: ReaderSettings[keyof ReaderSettings]) =>
      onChange({ ...settings, [key]: value }),
    [onChange, settings]
  );
  const tilt = useCallback(
    (elevation: number) => onChange({ ...settings, elevation }),
    [onChange, settings]
  );
  return readerLayout.map((group) => (
    <ParamSection
      disabled={disabled}
      group={group}
      key={group.title}
      onChange={change}
      schema={readerParams}
      values={settings}
    >
      {group.keys.includes("elevation") && (
        <CameraAngle
          disabled={disabled}
          elevation={settings.elevation}
          onChange={tilt}
        />
      )}
    </ParamSection>
  ));
}
