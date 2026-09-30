import type { ChangeEvent } from "react";
import { useCallback } from "react";
import type { RenderSettings } from "../chart-settings";
import { renderQualities, toneMappings } from "../chart-settings";
import type { RenderStatus } from "../scene/pipeline";

type NumericRenderKey = {
  [K in keyof RenderSettings]: RenderSettings[K] extends number ? K : never;
}[keyof RenderSettings];

type ToggleRenderKey = {
  [K in keyof RenderSettings]: RenderSettings[K] extends boolean ? K : never;
}[keyof RenderSettings];

const backendLabels = { webgl: "WebGL 2", webgpu: "WebGPU" } as const;

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
  const changeQuality = useCallback(
    (event: ChangeEvent<HTMLSelectElement, HTMLSelectElement>) => {
      const quality = Object.keys(renderQualities).find(
        (key) => key === event.target.value
      ) as RenderSettings["quality"] | undefined;
      if (quality) {
        onChange({ ...settings, quality });
      }
    },
    [onChange, settings]
  );
  const changeToneMapping = useCallback(
    (event: ChangeEvent<HTMLSelectElement, HTMLSelectElement>) => {
      const toneMapping = Object.keys(toneMappings).find(
        (key) => key === event.target.value
      ) as RenderSettings["toneMapping"] | undefined;
      if (toneMapping) {
        onChange({ ...settings, toneMapping });
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
  const giUnavailable = status !== null && !status.globalIlluminationAvailable;
  return (
    <fieldset aria-label="Rendering pipeline" disabled={disabled}>
      <label className="atlas-appearance-control">
        Quality
        <select
          aria-label="Rendering quality"
          onChange={changeQuality}
          value={settings.quality}
        >
          {Object.entries(renderQualities).map(([value, { label }]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <p role="status">
        {status
          ? `${backendLabels[status.backend]} · ${
              status.postProcessing
                ? "pipeline active"
                : "direct draw, map filter via CSS"
            }`
          : "Waiting for the map."}
      </p>
      <label className="atlas-appearance-control">
        Tone mapping
        <select
          aria-label="Tone mapping"
          disabled={off}
          onChange={changeToneMapping}
          value={settings.toneMapping}
        >
          {Object.entries(toneMappings).map(([value, { label }]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      {range("Exposure", "exposure", 0.25, 3, 0.05, "×")}
      {range("Saturation", "saturation", 0, 2, 0.05)}
      {range("Vibrance", "vibrance", -1, 1, 0.05)}
      {toggle("Ambient occlusion", "ambientOcclusion")}
      {range("Occlusion strength", "aoIntensity", 0, 2, 0.05)}
      {range("Occlusion reach", "aoRadius", 2, 60, 1)}
      {toggle("Bloom", "bloom")}
      {range("Bloom strength", "bloomStrength", 0, 1.5, 0.05)}
      {range("Bloom threshold", "bloomThreshold", 0, 1, 0.05)}
      {range("Bloom radius", "bloomRadius", 0, 1, 0.05)}
      {toggle("Indirect light (screen-space GI)", "globalIllumination")}
      {range("Indirect strength", "giIntensity", 0, 3, 0.05)}
      <p>
        {giUnavailable
          ? "Indirect light needs a perspective camera; it applies to wreck dives, not the top-down chart."
          : "Occlusion is subtle on the flat chart and strongest in wreck dives. Bloom lifts only the brightest ink."}
      </p>
    </fieldset>
  );
}
