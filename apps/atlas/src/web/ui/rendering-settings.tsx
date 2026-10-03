import type { ChangeEvent } from "react";
import { useCallback } from "react";
import type { RenderSettings } from "../chart-settings";
import { renderQualities, renderStages, toneMappings } from "../chart-settings";
import type { RenderStatus } from "../scene/pipeline";

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
    parts.push("direct draw, map filter via CSS");
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
  const changeNumber = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const key = event.currentTarget.name as NumericRenderKey;
      if (typeof settings[key] === "number") {
        onChange({ ...settings, [key]: Number(event.currentTarget.value) });
      }
    },
    [onChange, settings]
  );
  const changeToggle = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const key = event.currentTarget.name as ToggleRenderKey;
      if (typeof settings[key] === "boolean") {
        onChange({ ...settings, [key]: event.currentTarget.checked });
      }
    },
    [onChange, settings]
  );
  const changeChoice = useCallback(
    (event: ChangeEvent<HTMLSelectElement, HTMLSelectElement>) => {
      const key = event.currentTarget.name as ChoiceRenderKey;
      const value = Object.keys(choices[key]).find(
        (option) => option === event.target.value
      );
      if (value) {
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
    unit = ""
  ) => (
    <label className="atlas-setting" key={key}>
      <span>
        {label}
        <output>
          {settings[key].toFixed(step < 1 ? 2 : 0)}
          {unit}
        </output>
      </span>
      <input
        aria-label={label}
        disabled={off}
        max={max}
        min={min}
        name={key}
        onChange={changeNumber}
        step={step}
        type="range"
        value={settings[key]}
      />
    </label>
  );
  const toggle = (label: string, key: ToggleRenderKey) => (
    <label className="atlas-check" key={key}>
      <input
        checked={settings[key]}
        disabled={off}
        name={key}
        onChange={changeToggle}
        type="checkbox"
      />
      {label}
    </label>
  );
  const choice = (label: string, key: ChoiceRenderKey, always = false) => (
    <label className="atlas-appearance-control" key={key}>
      {label}
      <select
        aria-label={label}
        disabled={off && !always}
        name={key}
        onChange={changeChoice}
        value={settings[key]}
      >
        {Object.entries(choices[key]).map(([value, option]) => (
          <option key={value} value={value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
  const giUnavailable = status !== null && !status.globalIlluminationAvailable;
  return (
    <fieldset aria-label="Rendering pipeline" disabled={disabled}>
      {choice("Quality", "quality", true)}
      {status?.quality === "low" && !status.globalIlluminationAvailable && (
        <p className="atlas-note">
          Light keeps engraved terrain shading and full-resolution ink.
          Screen-space occlusion is reserved for Balanced, Full, or its stage
          preview.
        </p>
      )}
      <p role="status">{statusText(status)}</p>
      {status?.adapted && (
        <p>
          Frames ran over budget, so the tier stepped down. Choose a quality to
          set it again.
        </p>
      )}
      {choice("Tone mapping", "toneMapping")}
      {range("Exposure", "exposure", 0.25, 3, 0.05, "×")}
      {range("Saturation", "saturation", 0, 2, 0.05)}
      {range("Vibrance", "vibrance", -1, 1, 0.05)}
      {toggle("Ambient occlusion", "ambientOcclusion")}
      {range("Occlusion strength", "aoIntensity", 0, 2, 0.05)}
      {range("Occlusion reach", "aoReach", 4, 48, 1, " px")}
      {toggle("Bloom", "bloom")}
      {range("Bloom strength", "bloomStrength", 0, 1.5, 0.05)}
      {range("Bloom threshold", "bloomThreshold", 0, 1, 0.05)}
      {range("Bloom radius", "bloomRadius", 0, 1, 0.05)}
      {toggle("Indirect light (screen-space GI)", "globalIllumination")}
      {range("Indirect strength", "giIntensity", 0, 3, 0.05)}
      {choice("Show stage", "stage")}
      <p>
        {giUnavailable
          ? "Indirect light needs a perspective camera; it applies to wreck dives, not the top-down chart."
          : "Occlusion engraves the relief on the chart and shades wreck dives. Bloom lifts only the brightest ink."}
      </p>
    </fieldset>
  );
}
