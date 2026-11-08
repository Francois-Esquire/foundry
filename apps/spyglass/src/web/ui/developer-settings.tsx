import type { RefObject } from "react";
import { useCallback, useEffect, useState } from "react";
import {
  type SceneComposition,
  sceneLayerParams,
  sceneLayout,
} from "../settings/scene-composition";
import type {
  CompositionNode,
  MapHandle,
  RenderStatus,
} from "../view/map-contract";
import { ParamSection } from "./settings-controls";

/** Frame time is rounded so the readout does not re-render on every tick. */
const renderStatusKey = (status: RenderStatus | null) =>
  status
    ? [
        status.backend,
        status.postProcessing,
        status.failure,
        status.globalIlluminationAvailable,
        status.quality,
        status.adapted,
        status.frameMs === null ? "" : Math.round(status.frameMs),
      ].join("|")
    : "";

/** The renderer's status, polled while the developer controls are open. */
function useRenderStatus(scene: RefObject<MapHandle | null>) {
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

/** The composition the map describes, polled while the developer controls are open. */
function useComposition(scene: RefObject<MapHandle | null>) {
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
 * The composition as one table: every node in order, with whether it is
 * drawn, its last update in milliseconds and what it holds. The GPU passes
 * have no CPU time of their own; their GPU milliseconds are in the counts.
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

function LiveComposition({ scene }: { scene: RefObject<MapHandle | null> }) {
  return <CompositionTable nodes={useComposition(scene)} />;
}

/** The renderer's status in one line: the backend, any failure, and the GPU's time per frame when the device gives it. */
export function renderStatusText(status: RenderStatus | null): string {
  if (!status) {
    return "Waiting for the map…";
  }
  const parts = [status.backend === "webgpu" ? "WebGPU" : "WebGL"];
  if (status.failure) {
    parts.push(`failed: ${status.failure}`);
  }
  parts.push(
    status.frameMs === null
      ? "no GPU timings"
      : `${status.frameMs.toFixed(1)} ms per frame on the GPU`
  );
  return parts.join(" · ");
}

function LiveRenderStatus({ scene }: { scene: RefObject<MapHandle | null> }) {
  return (
    <p className="spyglass-render-status" role="status">
      {renderStatusText(useRenderStatus(scene))}
    </p>
  );
}

/**
 * A developer session's readouts: what the renderer draws with, and the
 * map's composition, each node with its last update time and what it holds.
 */
export function DeveloperSettingsSection({
  scene,
}: {
  scene: RefObject<MapHandle | null>;
}) {
  return (
    <section
      aria-label="stats controls"
      className="spyglass-developer-settings"
    >
      <section>
        <h3>Renderer</h3>
        <LiveRenderStatus scene={scene} />
      </section>
      <section>
        <h3>Map composition</h3>
        <p>
          The labels the viewer letters over the canvas, each map Islands last
          rebuilt with the milliseconds it took to encode, then its two GPU
          passes.
        </p>
        <LiveComposition scene={scene} />
      </section>
    </section>
  );
}

/**
 * A developer session's controls, drawn from `sceneLayerParams` in
 * `sceneLayout`'s sections: which of the viewer's layers show over the map,
 * one at a time, where the app bar turns them on in groups.
 */
export function SceneLayersSection({
  composition,
  onChange,
}: {
  composition: SceneComposition;
  onChange: (composition: SceneComposition) => void;
}) {
  const change = useCallback(
    (key: keyof SceneComposition, value: boolean) =>
      onChange({ ...composition, [key]: value }),
    [composition, onChange]
  );
  return sceneLayout.map((group) => (
    <ParamSection
      disabled={false}
      group={group}
      key={group.title}
      onChange={change}
      schema={sceneLayerParams}
      values={composition}
    />
  ));
}
