import {
  BufferGeometry,
  Color,
  Group,
  Mesh,
  PlaneGeometry,
  Sphere,
  Vector3,
} from "three";
import type { Renderer } from "three/webgpu";
import type { SpyglassData } from "../data/types";
import { islandPigment } from "../layout/island-pigment";
import { islandSpacing, type TrialPlan, trialPlan } from "../layout/sdf-trial";
import { isSceneLayerVisible } from "../settings/scene-composition";
import type { SceneLayer } from "./handle";
import { createSdfGpu, type SdfGpu } from "./sdf-gpu";
import { pulledSurface } from "./sdf-gpu-mesh";
import {
  sdfTerrainMaterial,
  sdfWaterMaterial,
  sdfWaterUniforms,
} from "./sdf-trial-material";

/**
 * The SDF trial: a developer's layer, hidden in every preset, that stands
 * the islands of the geology preview up as meshes built from true signed
 * distances, entirely on the GPU: each island's mesh is drawn from the
 * compute passes' buffers by an indirect draw, with nothing read back.
 * Nothing is built until the composition first shows it. It needs
 * compute and atomics, so on the WebGL 2 backend it draws nothing.
 */

/** The seabed beyond the regions, and the water sheet over the whole chart. */
function seaObjects(
  gpu: SdfGpu,
  plan: TrialPlan,
  water: ReturnType<typeof sdfWaterUniforms>
) {
  const { bounds } = gpu.seabed;
  const terrain = sdfTerrainMaterial({
    pigment: new Color(1, 1, 1),
    plates: { grid: plan.chart.world, macro: gpu.inputs.textures.macro },
    surface: gpu.seabed.pulled(),
  });
  const geometry = new BufferGeometry();
  geometry.setDrawRange(0, gpu.seabed.vertexCount);
  const centre = new Vector3(
    (bounds.left + bounds.right) / 2,
    (bounds.top + bounds.bottom) / 2,
    0
  );
  const width = bounds.right - bounds.left;
  const height = bounds.top - bounds.bottom;
  geometry.boundingSphere = new Sphere(centre, Math.hypot(width, height) / 2);
  const sheet = new PlaneGeometry(width, height);
  sheet.translate(centre.x, centre.y, 0);
  const sea = sdfWaterMaterial({ uniforms: water });
  const surface = new Mesh(sheet, sea.material);
  // Drawn after the terrain, which it reads from the frame.
  surface.renderOrder = 10;
  return {
    dispose() {
      terrain.dispose();
      geometry.dispose();
      sheet.dispose();
      sea.dispose();
    },
    objects: [new Mesh(geometry, terrain), surface],
  };
}

/** Each island's mesh, drawn from the shared buffers by its own indirect arguments, over the seabed. */
function islandMeshes(
  gpu: SdfGpu,
  plan: TrialPlan,
  data: SpyglassData,
  water: ReturnType<typeof sdfWaterUniforms>
) {
  const group = new Group();
  const sea = seaObjects(gpu, plan, water);
  group.add(...sea.objects);
  const surface = pulledSurface(gpu.buffers);
  const plates = { grid: plan.chart.world, macro: gpu.inputs.textures.macro };
  const disposers: (() => void)[] = [() => sea.dispose()];
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
    /** Holds every island at `spacing`, built again now; null hands it back to the view. */
    rebuild: (spacing: number | null) => void;
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
  /** Each island's built spacing, by its place in the plan. */
  let built: number[] = [];
  let held: number | null = null;
  const last = { buildMs: 0, rebuilt: 0 };
  const water = sdfWaterUniforms();
  const planned = () => {
    plan ??= trialPlan(data);
    return plan;
  };
  const pipeline = () => {
    gpu ??= createSdfGpu(planned());
    return gpu;
  };
  /** Builds each island whose spacing differs from the one it wants. */
  const bring = (wanted: (which: number) => number) => {
    const made = pipeline();
    const started = performance.now();
    let rebuilt = 0;
    for (const which of planned().islands.keys()) {
      const spacing = wanted(which);
      if (built[which] !== spacing) {
        made.build(renderer, which, spacing);
        built[which] = spacing;
        rebuilt += 1;
      }
    }
    if (rebuilt > 0) {
      last.buildMs = performance.now() - started;
      last.rebuilt = rebuilt;
    }
  };
  const rebuild = (spacing: number | null) => {
    held = spacing;
    built = [];
    if (spacing !== null) {
      bring(() => spacing);
    }
  };
  const stats = (): Record<string, number> =>
    gpu
      ? {
          bytes: gpu.bytes,
          close: built.filter((spacing) => spacing < 1).length,
          islands: built.length,
          lastBuildMs: last.buildMs,
          lastRebuilt: last.rebuilt,
        }
      : {};
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
    update(view, state, time) {
      if (
        !(
          supported &&
          isSceneLayerVisible(state.settings.composition, "sdf-trial")
        )
      ) {
        return;
      }
      if (!gpu) {
        pipeline().buildSeabed(renderer);
      }
      const { islands } = planned();
      const ratio = renderer.getPixelRatio();
      bring(
        (which) =>
          held ??
          islandSpacing(
            islands[which] ?? { height: 0, left: 0, top: 0, width: 0 },
            view,
            ratio,
            built[which]
          )
      );
      if (!meshes) {
        meshes = islandMeshes(pipeline(), planned(), data, water);
        group.add(meshes.group);
      }
      water.write(view, time);
    },
  };
}
