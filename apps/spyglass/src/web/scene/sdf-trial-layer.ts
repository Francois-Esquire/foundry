import { BufferGeometry, Color, Group, Mesh, Sphere, Vector3 } from "three";
import type { Renderer } from "three/webgpu";
import type { SpyglassData } from "../data/types";
import { islandPigment } from "../layout/island-pigment";
import { type TrialPlan, trialPlan } from "../layout/sdf-trial";
import { isSceneLayerVisible } from "../settings/scene-composition";
import type { SceneLayer } from "./handle";
import { createSdfGpu, type SdfGpu } from "./sdf-gpu";
import { pulledSurface } from "./sdf-gpu-mesh";
import { sdfTerrainMaterial } from "./sdf-trial-material";

/**
 * The SDF trial: a developer's layer, hidden in every preset, that stands
 * the islands of the geology preview up as meshes built from true signed
 * distances, entirely on the GPU: each island's mesh is drawn from the
 * compute passes' buffers by an indirect draw, with nothing read back.
 * Nothing is built until the composition first shows it. It needs
 * compute and atomics, so on the WebGL 2 backend it draws nothing.
 */

/** Each island's mesh, drawn from the shared buffers by its own indirect arguments. */
function islandMeshes(gpu: SdfGpu, plan: TrialPlan, data: SpyglassData) {
  const group = new Group();
  const surface = pulledSurface(gpu.buffers);
  const plates = { grid: plan.chart.world, macro: gpu.inputs.textures.macro };
  const disposers: (() => void)[] = [];
  for (const [which, island] of plan.islands.entries()) {
    const range = gpu.buffers.ranges[which];
    if (!range) {
      continue;
    }
    const territory = data.territories.find((each) => each.id === island.id);
    const material = sdfTerrainMaterial({
      pigment: new Color(islandPigment(territory ?? { id: island.id })),
      plates,
      surface,
    });
    const geometry = new BufferGeometry();
    geometry.setDrawRange(0, range.indexCapacity);
    geometry.setIndirect(gpu.buffers.attributes.args, which * 16);
    // The region's bounds, for culling: the mesh has no positions to measure.
    const centre = new Vector3(
      island.left + island.width / 2,
      -(island.top + island.height / 2),
      (island.zLow + island.zHigh) / 2
    );
    geometry.boundingSphere = new Sphere(
      centre,
      Math.hypot(island.width, island.height, island.zHigh - island.zLow) / 2
    );
    group.add(new Mesh(geometry, material));
    disposers.push(() => {
      geometry.dispose();
      material.dispose();
    });
  }
  return {
    dispose() {
      for (const dispose of disposers) {
        dispose();
      }
    },
    group,
  };
}

export function createSdfTrialLayer(options: {
  data: SpyglassData;
  renderer: Renderer;
}): SceneLayer & {
  /** The developer's controls: the plan, the pipeline and the last build's measures. */
  developer: {
    /** The GPU pipeline, made on first call. */
    gpu: () => SdfGpu;
    islands: () => { archetype: string; id: string }[];
    method: () => "dual-contouring";
    plan: () => TrialPlan;
    /** Builds every island again at `spacing`. */
    rebuild: (spacing: number) => void;
    setMethod: (method: string) => void;
    stats: () => Record<string, number>;
  };
} {
  const { data, renderer } = options;
  const group = new Group();
  const supported =
    (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ===
    true;
  let plan: TrialPlan | undefined;
  let gpu: SdfGpu | undefined;
  let meshes: ReturnType<typeof islandMeshes> | undefined;
  let built: number[] = [];
  const planned = () => {
    plan ??= trialPlan(data);
    return plan;
  };
  const pipeline = () => {
    gpu ??= createSdfGpu(planned());
    return gpu;
  };
  const rebuild = (spacing: number) => {
    const made = pipeline();
    built = planned().islands.map((_, which) => {
      made.build(renderer, which, spacing);
      return spacing;
    });
  };
  const stats = (): Record<string, number> =>
    gpu ? { bytes: gpu.bytes, islands: built.length } : {};
  return {
    developer: {
      gpu: pipeline,
      islands: () =>
        (plan?.islands ?? []).map((island) => ({
          archetype: island.archetype,
          id: island.id,
        })),
      method: () => "dual-contouring",
      plan: planned,
      rebuild,
      setMethod: () => undefined,
      stats,
    },
    dispose() {
      if (meshes) {
        group.remove(meshes.group);
        meshes.dispose();
      }
      meshes = undefined;
      gpu?.dispose();
      gpu = undefined;
      plan = undefined;
      built = [];
    },
    group,
    id: "sdf-trial",
    kind: "layer",
    stats,
    update(_view, state) {
      if (
        !(
          supported &&
          isSceneLayerVisible(state.settings.composition, "sdf-trial")
        )
      ) {
        return;
      }
      if (built.length === 0) {
        rebuild(1);
      }
      if (!meshes) {
        meshes = islandMeshes(pipeline(), planned(), data);
        group.add(meshes.group);
      }
    },
  };
}
