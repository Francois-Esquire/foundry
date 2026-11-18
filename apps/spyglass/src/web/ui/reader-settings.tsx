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

const customAngle = "custom";
const angleOrder: readonly CameraAngleId[] = ["top-down", "chart", "isometric"];

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
