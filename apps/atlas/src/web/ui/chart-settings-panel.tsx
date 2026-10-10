import type { ChangeEvent, RefObject } from "react";
import { useCallback, useEffect, useState } from "react";
import type { ChartSettings, RenderSettings } from "../chart-settings";
import { chartFilters } from "../chart-settings";
import { defaultLandmassSettings } from "../landmasses";
import type { BoundaryId } from "../scene/boundaries";
import { boundaryStyles } from "../scene/boundaries";
import type { RenderStatus } from "../scene/pipeline";
import type { AtlasMapHandle } from "./atlas-map";
import { RenderingSettings } from "./rendering-settings";

/** Frame time is rounded so the readout does not re-render on every tick. */
const renderStatusKey = (status: RenderStatus | null) =>
  status
    ? [
        status.backend,
        status.postProcessing,
        status.globalIlluminationAvailable,
        status.quality,
        status.adapted,
        status.frameMs === null ? "" : Math.round(status.frameMs),
      ].join("|")
    : "";

export function ChartSettingsPanel({
  scene,
  settings,
  onChange,
  onReset,
  layoutPending = false,
}: {
  scene: RefObject<AtlasMapHandle | null>;
  settings: ChartSettings;
  onChange: (settings: ChartSettings) => void;
  onReset: () => void;
  layoutPending?: boolean;
}) {
  const [renderStatus, setRenderStatus] = useState<RenderStatus | null>(
    () => scene.current?.getRenderStatus() ?? null
  );
  useEffect(() => {
    const timer = window.setInterval(() => {
      const status = scene.current?.getRenderStatus() ?? null;
      setRenderStatus((current) =>
        renderStatusKey(current) === renderStatusKey(status) ? current : status
      );
    }, 150);
    return () => {
      clearInterval(timer);
    };
  }, [scene]);
  const changeNumericSetting = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const key = event.currentTarget.name as keyof ChartSettings;
      if (typeof settings[key] === "number") {
        onChange({ ...settings, [key]: Number(event.currentTarget.value) });
      }
    },
    [onChange, settings]
  );
  const changeLayer = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const key = event.currentTarget.name as keyof ChartSettings["layers"];
      if (Object.hasOwn(settings.layers, key)) {
        onChange({
          ...settings,
          layers: { ...settings.layers, [key]: event.currentTarget.checked },
        });
      }
    },
    [onChange, settings]
  );
  const changeRendering = useCallback(
    (rendering: RenderSettings) => {
      onChange({ ...settings, rendering });
    },
    [onChange, settings]
  );
  const changeBoundary = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const key = event.currentTarget.name as BoundaryId;
      if (Object.hasOwn(boundaryStyles, key)) {
        onChange({
          ...settings,
          boundaries: {
            ...settings.boundaries,
            [key]: event.currentTarget.checked,
          },
        });
      }
    },
    [onChange, settings]
  );
  const range = (
    label: string,
    key: Exclude<
      keyof ChartSettings,
      | "contours"
      | "streams"
      | "volcanic"
      | "filter"
      | "boundaries"
      | "layers"
      | "rendering"
    >,
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
        max={max}
        min={min}
        name={key}
        onChange={changeNumericSetting}
        step={step}
        type="range"
        value={settings[key]}
      />
    </label>
  );
  const handleChange3 = useCallback(() => {
    onChange({ ...settings, ...defaultLandmassSettings });
  }, [onChange, settings]);
  const handleChange7 = useCallback(
    (event: ChangeEvent<HTMLSelectElement, HTMLSelectElement>) => {
      const filter = Object.keys(chartFilters).find(
        (key) => key === event.target.value
      ) as ChartSettings["filter"] | undefined;
      if (filter) {
        onChange({ ...settings, filter });
      }
    },
    [onChange, settings]
  );
  const handleChange8 = useCallback(
    (event: ChangeEvent<HTMLInputElement, HTMLInputElement>) => {
      onChange({ ...settings, contours: event.target.checked });
    },
    [onChange, settings]
  );
  const handleStreams = useCallback(
    (event: ChangeEvent<HTMLInputElement, HTMLInputElement>) => {
      onChange({ ...settings, streams: event.target.checked });
    },
    [onChange, settings]
  );
  const handleVolcanic = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      onChange({ ...settings, volcanic: event.target.checked });
    },
    [onChange, settings]
  );
  return (
    <div className="atlas-chart-settings">
      <h2>Chart settings</h2>
      <details open>
        <summary>Experimental layers</summary>
        <p>
          Island positions stay fixed. Roads and forests require connecting
          land.
        </p>
        {(
          [
            ["land", "Connecting land"],
            ["roads", "Road network"],
            ["houses", "Houses"],
            ["forests", "Forests"],
            ["trade", "Sea trade routes"],
          ] as const
        ).map(([key, label]) => (
          <label
            className="atlas-boundary-control atlas-layer-control"
            key={key}
          >
            <input
              checked={settings.layers[key]}
              disabled={
                !scene.current ||
                ((key === "roads" || key === "forests") &&
                  !settings.layers.land)
              }
              name={key}
              onChange={changeLayer}
              type="checkbox"
            />
            <span>{label}</span>
          </label>
        ))}
        <label className="atlas-boundary-control atlas-layer-control">
          <input
            checked={settings.streams}
            disabled={!scene.current}
            name="streams"
            onChange={handleStreams}
            type="checkbox"
          />
          <span>District streams</span>
        </label>
        <label className="atlas-boundary-control atlas-layer-control">
          <input
            checked={settings.volcanic}
            disabled={!scene.current}
            name="volcanic"
            onChange={handleVolcanic}
            type="checkbox"
          />
          <span>Recorded change · evidence in Place</span>
        </label>
        <p>
          Inside an island, high fan-in files raise summits. Unresolved
          belonging is marsh. Streams draw the imports between districts and
          meet at composition junctions. Recorded change dates and counts are in
          Place.
        </p>
      </details>
      <details>
        <summary>Display boundaries</summary>
        <fieldset aria-label="Landmass layout" disabled={!scene.current}>
          {range("Coastal buffer", "coastalBuffer", 0, 64, 4)}
          {range("Island clearance", "islandClearance", 8, 80, 1)}
          <p>
            Lower values tighten the outline and let islands fit closer. Changes
            settle after a brief pause; island shapes stay fixed.
          </p>
          <button onClick={handleChange3} type="button">
            Reset layout
          </button>
          <p role="status">
            {layoutPending
              ? "Updating layout…"
              : "Islands that cannot fit stay near a pocket mouth when space allows."}
          </p>
        </fieldset>
        <fieldset aria-label="Boundary layers" disabled={!scene.current}>
          <p>Independent outlines. Toggles do not change the layout.</p>
          {(Object.keys(boundaryStyles) as BoundaryId[]).map((key) => {
            const style = boundaryStyles[key];
            return (
              <label className="atlas-boundary-control" key={key}>
                <input
                  checked={settings.boundaries[key]}
                  name={key}
                  onChange={changeBoundary}
                  type="checkbox"
                />
                <svg
                  aria-hidden="true"
                  height="12"
                  viewBox="0 0 26 12"
                  width="26"
                >
                  <path
                    d="M0 6H26"
                    fill="none"
                    stroke={style.color}
                    strokeDasharray={style.dash.join(" ")}
                    strokeWidth="1.5"
                  />
                </svg>
                <span>
                  {style.label}
                  <small>{style.description}</small>
                </span>
              </label>
            );
          })}
        </fieldset>
      </details>
      <details>
        <summary>Rendering</summary>
        <RenderingSettings
          disabled={!scene.current}
          onChange={changeRendering}
          settings={settings.rendering}
          status={renderStatus}
        />
      </details>
      <details>
        <summary>Appearance</summary>
        <fieldset disabled={!scene.current}>
          <label className="atlas-appearance-control">
            Map filter
            <select
              aria-label="Map filter"
              onChange={handleChange7}
              value={settings.filter}
            >
              {Object.entries(chartFilters).map(([value, { label }]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <p>
            Filters tint the whole map. Monochrome filters replace package
            colors.
          </p>
          <label className="atlas-check">
            <input
              checked={settings.contours}
              onChange={handleChange8}
              type="checkbox"
            />
            Topographic lines
          </label>
        </fieldset>
      </details>
      <button className="atlas-settings-reset" onClick={onReset} type="button">
        Reset visualization
      </button>
    </div>
  );
}
