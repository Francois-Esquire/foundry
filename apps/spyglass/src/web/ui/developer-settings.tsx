import type { ChangeEvent, RefObject } from "react";
import { useCallback, useEffect, useState } from "react";
import { boundaryStyles } from "../layout/boundary-marks";
import type { CompositionNode } from "../scene/handle";
import type { RenderStatus } from "../scene/pipeline";
import type { BoundaryId } from "../settings/boundary-settings";
import type {
  DeveloperSettings,
  RenderSettings,
} from "../settings/chart-settings";
import { defaultLandmassSettings } from "../settings/landmass-settings";
import { RenderingSettings } from "./rendering-settings";
import type { SpyglassMapHandle } from "./spyglass-map";

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

/** The renderer's status, polled while the developer controls are open. */
function useRenderStatus(scene: RefObject<SpyglassMapHandle | null>) {
  const [status, setStatus] = useState<RenderStatus | null>(
    () => scene.current?.getRenderStatus() ?? null
  );
  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = scene.current?.getRenderStatus() ?? null;
      setStatus((current) =>
        renderStatusKey(current) === renderStatusKey(next) ? current : next
      );
    }, 150);
    return () => {
      clearInterval(timer);
    };
  }, [scene]);
  return status;
}

/** A node's row as text, so the table re-renders only when a node changes: times to a tenth of a millisecond. */
const nodeKey = (node: CompositionNode) =>
  [
    node.id,
    node.enabled,
    node.updateMs === null ? "" : node.updateMs.toFixed(1),
    Object.entries(node.counts ?? {})
      .map(([name, value]) => `${name}=${value.toFixed(1)}`)
      .join(","),
  ].join("|");

const compositionKey = (nodes: CompositionNode[]) =>
  nodes.map(nodeKey).join("\n");

/** The composition the scene describes, polled while the developer controls are open. */
function useComposition(scene: RefObject<SpyglassMapHandle | null>) {
  const [nodes, setNodes] = useState<CompositionNode[]>(
    () => scene.current?.describe() ?? []
  );
  useEffect(() => {
    const timer = window.setInterval(() => {
      const next = scene.current?.describe() ?? [];
      setNodes((current) =>
        compositionKey(current) === compositionKey(next) ? current : next
      );
    }, 150);
    return () => {
      clearInterval(timer);
    };
  }, [scene]);
  return nodes;
}

/** One node's counts as "marks 120 · batches 4"; a millisecond count keeps one decimal. */
function countsText(counts: Record<string, number> | undefined) {
  return Object.entries(counts ?? {})
    .map(
      ([name, value]) =>
        `${name} ${name.endsWith("Ms") ? value.toFixed(1) : value}`
    )
    .join(" · ");
}

/**
 * The composition as one table: every layer in the order it updates, with
 * whether it is drawn, its last update in milliseconds and what it holds,
 * then every stage of the pass graph and whether the graph holds it. Stages
 * have no time of their own; the GPU times the frame as a whole, which the
 * pipeline status reads out.
 */
function CompositionTable({ nodes }: { nodes: CompositionNode[] }) {
  return (
    <table className="spyglass-composition">
      <thead>
        <tr>
          <th scope="col">Node</th>
          <th scope="col">On</th>
          <th scope="col">ms</th>
          <th scope="col">Counts</th>
        </tr>
      </thead>
      <tbody>
        {nodes.map((node) => (
          <tr key={`${node.kind}:${node.id}`}>
            <th scope="row">
              {node.id}
              <small>{node.kind}</small>
            </th>
            <td>{node.enabled ? "on" : "off"}</td>
            <td>{node.updateMs === null ? "–" : node.updateMs.toFixed(1)}</td>
            <td>{countsText(node.counts)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const dependencyLayers = [
  ["land", "Connecting land"],
  ["roads", "Road network"],
] as const;

/**
 * A developer session's controls: the layers that draw package dependency
 * again, the layout's tuning and outlines, and the renderer.
 */
export function DeveloperSettingsSection({
  disabled,
  layoutPending,
  onChange,
  scene,
  settings,
}: {
  disabled: boolean;
  layoutPending: boolean;
  onChange: (settings: DeveloperSettings) => void;
  scene: RefObject<SpyglassMapHandle | null>;
  settings: DeveloperSettings;
}) {
  const renderStatus = useRenderStatus(scene);
  const composition = useComposition(scene);
  const changeLayer = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const key = dependencyLayers.find(
        ([name]) => name === event.currentTarget.name
      )?.[0];
      if (key) {
        onChange({
          ...settings,
          layers: { ...settings.layers, [key]: event.currentTarget.checked },
        });
      }
    },
    [onChange, settings]
  );
  const changeLayout = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const { name, value } = event.currentTarget;
      if (name === "coastalBuffer" || name === "islandClearance") {
        onChange({ ...settings, [name]: Number(value) });
      }
    },
    [onChange, settings]
  );
  const resetLayout = useCallback(() => {
    onChange({ ...settings, ...defaultLandmassSettings });
  }, [onChange, settings]);
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
  const changeRendering = useCallback(
    (rendering: RenderSettings) => {
      onChange({ ...settings, rendering });
    },
    [onChange, settings]
  );
  const range = (
    label: string,
    key: "coastalBuffer" | "islandClearance",
    min: number,
    max: number,
    step: number
  ) => (
    <label className="spyglass-setting" key={key}>
      <span>
        {label}
        <output>{settings[key].toFixed(0)}</output>
      </span>
      <input
        aria-label={label}
        max={max}
        min={min}
        name={key}
        onChange={changeLayout}
        step={step}
        type="range"
        value={settings[key]}
      />
    </label>
  );
  return (
    <section
      aria-label="Rendering controls"
      className="spyglass-developer-settings"
    >
      <details>
        <summary>Land and roads</summary>
        <p>
          Island positions follow dependency relationships. Connecting land
          joins islands that import from one another, and roads run over it;
          both rebuild the scene.
        </p>
        {dependencyLayers.map(([key, label]) => (
          <label
            className="spyglass-boundary-control spyglass-layer-control"
            key={key}
          >
            <input
              checked={settings.layers[key]}
              disabled={disabled || (key === "roads" && !settings.layers.land)}
              name={key}
              onChange={changeLayer}
              type="checkbox"
            />
            <span>{label}</span>
          </label>
        ))}
      </details>
      <details>
        <summary>Layout and boundaries</summary>
        <fieldset aria-label="Landmass layout" disabled={disabled}>
          {range("Coastal buffer", "coastalBuffer", 0, 64, 4)}
          {range("Island clearance", "islandClearance", 8, 80, 1)}
          <p>
            Coastal buffer widens connecting land; island clearance spaces each
            island from its neighbors. Changes settle after a brief pause;
            island shapes stay fixed.
          </p>
          <button onClick={resetLayout} type="button">
            Reset layout
          </button>
          <p role="status">
            {layoutPending ? "Updating layout…" : "Layout is up to date."}
          </p>
        </fieldset>
        <fieldset aria-label="Boundary layers" disabled={disabled}>
          <p>Independent outlines. Toggles do not change the layout.</p>
          {(Object.keys(boundaryStyles) as BoundaryId[]).map((key) => {
            const style = boundaryStyles[key];
            return (
              <label className="spyglass-boundary-control" key={key}>
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
        <summary>Lighting and color</summary>
        <RenderingSettings
          disabled={disabled}
          onChange={changeRendering}
          settings={settings.rendering}
          status={renderStatus}
        />
      </details>
      <details>
        <summary>Composition</summary>
        <p>
          The scene as one tree: each layer in the order it updates, with its
          last update time and what it holds, then the pass graph's stages.
        </p>
        <CompositionTable nodes={composition} />
      </details>
    </section>
  );
}
