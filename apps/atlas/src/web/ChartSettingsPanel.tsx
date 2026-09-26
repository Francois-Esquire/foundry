import type { RefObject } from "react";

import { useEffect, useRef, useState } from "react";

import type { BoundaryId } from "./boundaries";
import { boundaryStyles } from "./boundaries";
import type { ChartSettings } from "./chart-settings";
import { chartFilters } from "./chart-settings";
import { defaultLandmassSettings } from "./landmasses";
import { createPlayback, trackIds } from "./playback";
import type { createAtlasScene } from "./scene";

export function ChartSettingsPanel({
  scene,
  settings,
  onChange,
  onClose,
  onReset,
  layoutPending = false,
}: {
  scene: RefObject<ReturnType<typeof createAtlasScene> | null>;
  settings: ChartSettings;
  onChange: (settings: ChartSettings) => void;
  onClose: () => void;
  onReset: () => void;
  layoutPending?: boolean;
}) {
  const [playback, setPlayback] = useState(
    () => scene.current?.getPlayback() ?? createPlayback().snapshot()
  );
  const [reduced, setReduced] = useState(false);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const preference = () => {
      setReduced(motion.matches);
    };
    preference();
    motion.addEventListener("change", preference);
    const timer = window.setInterval(() => {
      const value = scene.current?.getPlayback();
      if (value) {
        setPlayback(value);
      }
    }, 150);
    return () => {
      clearInterval(timer);
      motion.removeEventListener("change", preference);
    };
  }, [scene]);
  const sync = () => {
    const value = scene.current?.getPlayback();
    if (value) {
      setPlayback(value);
    }
  };
  const range = (
    label: string,
    key: Exclude<
      keyof ChartSettings,
      "contours" | "waterColor" | "filter" | "boundaries" | "layers"
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
        onChange={(event) => {
          onChange({ ...settings, [key]: Number(event.target.value) });
        }}
        step={step}
        type="range"
        value={settings[key]}
      />
    </label>
  );
  return (
    <aside
      aria-labelledby="chart-settings-title"
      className="atlas-chart-settings"
      id="atlas-chart-settings"
    >
      <header>
        <h2 id="chart-settings-title">Chart settings</h2>
        <button aria-label="Close chart settings" onClick={onClose} ref={close}>
          Close
        </button>
      </header>
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
              onChange={(event) => {
                onChange({
                  ...settings,
                  layers: { ...settings.layers, [key]: event.target.checked },
                });
              }}
              type="checkbox"
            />
            <span>{label}</span>
          </label>
        ))}
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
          <button
            onClick={() => {
              onChange({ ...settings, ...defaultLandmassSettings });
            }}
          >
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
                  onChange={(event) => {
                    onChange({
                      ...settings,
                      boundaries: {
                        ...settings.boundaries,
                        [key]: event.target.checked,
                      },
                    });
                  }}
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
      <fieldset disabled={!scene.current}>
        <legend>Playback</legend>
        <div className="atlas-transport">
          <button
            aria-label={
              playback.playing && !reduced ? "Pause timeline" : "Play timeline"
            }
            disabled={reduced}
            onClick={() => {
              scene.current?.play(!playback.playing);
              sync();
            }}
          >
            {playback.playing && !reduced ? "Pause" : "Play"}
          </button>
          <output aria-label="Timeline position">
            {playback.time.toFixed(1)} s
          </output>
          <label>
            Speed
            <select
              onChange={(event) => {
                scene.current?.setPlaybackSpeed(Number(event.target.value));
                sync();
              }}
              value={playback.speed}
            >
              {[0.25, 0.5, 1, 2, 3].map((speed) => (
                <option key={speed} value={speed}>
                  {speed}×
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="atlas-setting">
          <span>
            Timeline <span>Seek to pause</span>
          </span>
          <input
            aria-label="Timeline"
            max={Math.max(120, Math.ceil(playback.time / 60) * 60)}
            min="0"
            onChange={(event) => {
              scene.current?.seek(Number(event.target.value));
              sync();
            }}
            step="0.1"
            type="range"
            value={playback.time}
          />
        </label>
        <div className="atlas-track-list">
          {trackIds.map((id) => (
            <div key={id}>
              <span>{id}</span>
              <output>{playback.tracks[id].time.toFixed(1)} s</output>
              <button
                aria-label={`${playback.tracks[id].playing ? "Pause" : "Resume"} ${id} track`}
                aria-pressed={!playback.tracks[id].playing}
                onClick={() => {
                  scene.current?.setTrackPlaying(
                    id,
                    !playback.tracks[id].playing
                  );
                  sync();
                }}
              >
                {playback.tracks[id].playing ? "Pause" : "Resume"}
              </button>
            </div>
          ))}
        </div>
        <p>
          {reduced
            ? "Reduced motion is on. Scrub to preview any frame."
            : "Pause one track while the others continue. Seeking moves every track."}
        </p>
      </fieldset>
      <details open>
        <summary>Wind</summary>
        <fieldset disabled={!scene.current}>
          {range("Direction toward", "windDirection", 0, 359, 1, "°")}
          <p>0° north · 90° east · 180° south · 270° west</p>
          {range("Wind strength", "windStrength", 0, 2, 0.05)}
        </fieldset>
      </details>
      <details open>
        <summary>Current</summary>
        <fieldset disabled={!scene.current}>
          {range("Current speed", "currentSpeed", 0, 3, 0.05, "×")}
          {range("Dependency influence", "dependencyInfluence", 0, 2, 0.05)}
          {range("Wind influence", "windInfluence", 0, 1, 0.05)}
        </fieldset>
      </details>
      <details open>
        <summary>Waves</summary>
        <fieldset disabled={!scene.current}>
          {range("Wave amount", "waveAmount", 0, 1, 0.05)}
          {range("Wavelength", "wavelength", 12, 100, 1)}
          {range("Wave strength", "waveStrength", 0, 2, 0.05)}
          <p>
            Depth-aware crests; quieter water behind islands. Not a water-level
            simulation.
          </p>
        </fieldset>
      </details>
      <details>
        <summary>Appearance</summary>
        <fieldset disabled={!scene.current}>
          <label className="atlas-appearance-control">
            Water pigment
            <input
              aria-label="Water pigment"
              onChange={(event) => {
                onChange({ ...settings, waterColor: event.target.value });
              }}
              type="color"
              value={settings.waterColor}
            />
          </label>
          <label className="atlas-appearance-control">
            Map filter
            <select
              aria-label="Map filter"
              onChange={(event) => {
                const filter = Object.keys(chartFilters).find(
                  (key) => key === event.target.value
                ) as ChartSettings["filter"] | undefined;
                if (filter) {
                  onChange({ ...settings, filter });
                }
              }}
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
          {range("Water contrast", "waterContrast", 0, 2, 0.05)}
          <label className="atlas-check">
            <input
              checked={settings.contours}
              onChange={(event) => {
                onChange({ ...settings, contours: event.target.checked });
              }}
              type="checkbox"
            />
            Topographic lines
          </label>
        </fieldset>
      </details>
      <button
        className="atlas-settings-reset"
        onClick={() => {
          onReset();
          sync();
        }}
      >
        Reset visualization
      </button>
    </aside>
  );
}
