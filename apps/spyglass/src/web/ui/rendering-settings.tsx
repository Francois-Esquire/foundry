import { useCallback } from "react";
import type { RenderStatus } from "../scene/pipeline";
import { renderStages } from "../scene/stages/stages";
import type { RenderSettings } from "../settings/chart-settings";
import { renderQualities, toneMappings } from "../settings/chart-settings";
import {
  SettingsRange,
  SettingsSelect,
  SettingsToggle,
} from "./settings-controls";

type NumericRenderKey = {
  [K in keyof RenderSettings]: RenderSettings[K] extends number ? K : never;
}[keyof RenderSettings];

type ToggleRenderKey = {
  [K in keyof RenderSettings]: RenderSettings[K] extends boolean ? K : never;
}[keyof RenderSettings];

type ChoiceRenderKey = "quality" | "stage" | "toneMapping";

const backendLabels = { webgl: "WebGL 2", webgpu: "WebGPU" } as const;

const choices: Record<ChoiceRenderKey, Record<string, { label: string }>> = {
  quality: renderQualities,
  stage: renderStages,
  toneMapping: toneMappings,
};

function statusText(status: RenderStatus | null) {
  if (!status) {
    return "Waiting for the map.";
  }
  const parts: string[] = [backendLabels[status.backend]];
  if (status.postProcessing) {
    parts.push(`pipeline active · ${renderQualities[status.quality].label}`);
  } else if (status.failure) {
    parts.push(`direct draw, the pipeline failed: ${status.failure}`);
  } else {
    parts.push("direct draw");
  }
  if (status.frameMs !== null) {
    parts.push(`${status.frameMs.toFixed(0)} ms per frame`);
  }
  return parts.join(" · ");
}

/** Rendering pipeline controls: quality tier, exposure, grade, occlusion, bloom, indirect light. */
export function RenderingSettings({
  settings,
  status,
  disabled,
  onChange,
}: {
  settings: RenderSettings;
  status: RenderStatus | null;
  disabled: boolean;
  onChange: (settings: RenderSettings) => void;
}) {
  const off = settings.quality === "off";
  const engravedOnly =
    status?.quality === "low" &&
    !status.globalIlluminationAvailable &&
    settings.stage !== "occlusion";
  const changeNumber = useCallback(
    (key: NumericRenderKey, value: number) => {
      onChange({ ...settings, [key]: value });
    },
    [onChange, settings]
  );
  const changeToggle = useCallback(
    (key: ToggleRenderKey, value: boolean) => {
      const previews = {
        ambientOcclusion: "occlusion",
        bloom: "bloom",
        globalIllumination: "indirect",
        selectionGlow: "outline",
      } as const;
      onChange({
        ...settings,
        [key]: value,
        stage:
          !value && settings.stage === previews[key] ? "final" : settings.stage,
      });
    },
    [onChange, settings]
  );
  const changeChoice = useCallback(
    (key: ChoiceRenderKey, value: string) => {
      if (Object.hasOwn(choices[key], value)) {
        onChange({ ...settings, [key]: value });
      }
    },
    [onChange, settings]
  );
  const range = (
    label: string,
    key: NumericRenderKey,
    min: number,
    max: number,
    step: number,
    unit = "",
    inactive = false
  ) => (
    <SettingsRange
      disabled={off || inactive}
      key={key}
      label={label}
      max={max}
      min={min}
      name={key}
      onChange={changeNumber}
      step={step}
      unit={unit}
      value={settings[key]}
    />
  );
  const toggle = (label: string, key: ToggleRenderKey, inactive = false) => (
    <SettingsToggle
      checked={settings[key]}
      disabled={off || inactive}
      key={key}
      label={label}
      name={key}
      onChange={changeToggle}
    />
  );
  const unavailableStage = (value: string) =>
    (value === "occlusion" && !settings.ambientOcclusion) ||
    (value === "bloom" && !settings.bloom) ||
    (value === "outline" && !settings.selectionGlow) ||
    (value === "indirect" && (!settings.globalIllumination || giUnavailable));
  const choice = (label: string, key: ChoiceRenderKey, always = false) => (
    <SettingsSelect
      disabled={off && !always}
      key={key}
      label={label}
      name={key}
      onChange={changeChoice}
      options={Object.entries(choices[key]).map(([value, option]) => ({
        disabled: key === "stage" && unavailableStage(value),
        label: option.label,
        value,
      }))}
      value={settings[key]}
    />
  );
  const giUnavailable = status !== null && !status.globalIlluminationAvailable;
  return (
    <fieldset
      aria-label="Rendering pipeline"
      className="spyglass-rendering-controls"
      disabled={disabled}
    >
      <fieldset className="spyglass-control-group">
        <legend>Renderer</legend>
        {choice("Quality", "quality", true)}
        <p className="spyglass-render-status" role="status">
          {statusText(status)}
        </p>
        {status?.adapted && (
          <p>
            Quality stepped down to keep the map responsive. Select another tier
            to change it.
          </p>
        )}
        <p>
          Quality, tone mapping and effect switches rebuild the effects. Color
          sliders update live.
        </p>
      </fieldset>
      <fieldset className="spyglass-control-group">
        <legend>Color</legend>
        {choice("Tone mapping", "toneMapping")}
        {range("Exposure", "exposure", 0.25, 3, 0.05, "×")}
        {range("Saturation", "saturation", 0, 2, 0.05)}
        {range("Vibrance", "vibrance", -1, 1, 0.05)}
      </fieldset>
      <fieldset className="spyglass-control-group">
        <legend>Terrain shading</legend>
        {toggle("Ambient occlusion", "ambientOcclusion")}
        {range(
          "Occlusion strength",
          "aoIntensity",
          0,
          2,
          0.05,
          "",
          !settings.ambientOcclusion
        )}
        {range(
          "Occlusion reach",
          "aoReach",
          4,
          48,
          1,
          " px",
          !settings.ambientOcclusion || engravedOnly
        )}
        {engravedOnly && (
          <p>
            Light uses engraved relief shading. Screen-space reach applies on
            Balanced and Full.
          </p>
        )}
      </fieldset>
      <fieldset className="spyglass-control-group">
        <legend>Selection & bloom</legend>
        {toggle("Selection glow", "selectionGlow")}
        {toggle("Bloom", "bloom")}
        {range(
          "Bloom strength",
          "bloomStrength",
          0,
          1.5,
          0.05,
          "",
          !settings.bloom
        )}
        {range(
          "Bloom threshold",
          "bloomThreshold",
          0,
          1,
          0.05,
          "",
          !settings.bloom
        )}
        {range("Bloom radius", "bloomRadius", 0, 1, 0.05, "", !settings.bloom)}
        <p>
          Select an island to see its coastal glow. Bloom lifts the brightest
          pixels.
        </p>
      </fieldset>
      <fieldset className="spyglass-control-group">
        <legend>Indirect light</legend>
        {toggle("Screen-space GI", "globalIllumination", giUnavailable)}
        {range(
          "Indirect strength",
          "giIntensity",
          0,
          3,
          0.05,
          "",
          giUnavailable || !settings.globalIllumination
        )}
        {giUnavailable && (
          <p>
            Unavailable on the chart&apos;s orthographic camera, at every angle;
            this effect needs a perspective camera.
          </p>
        )}
      </fieldset>
      <fieldset className="spyglass-control-group">
        <legend>Inspect an effect</legend>
        {choice("Show stage", "stage")}
        <p>Enable an effect before choosing its preview.</p>
      </fieldset>
    </fieldset>
  );
}
