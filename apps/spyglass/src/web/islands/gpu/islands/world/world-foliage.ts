/**
 * The foliage (WORLD.md layer 5): trees and shrubs on the islands' tops.
 * `set` packs the trees the plan names; `settle` scatters the rest on the
 * GPU from the zoning map (shaders/world/foliage-scatter.wgsl), only when the
 * plan or a map it reads changed, appending every plant through an atomic
 * tally into a buffer for the trees and one for the shrubs; `draw` puts
 * them into the film with three indirect draws, the trees, the shrubs and
 * their shadows on the ground (shaders/world/foliage.wgsl). The frame does no
 * layout and the CPU never reads a count to draw.
 *
 * The buffers start at `FOLIAGE_CAP` plants each. Once a scatter has run,
 * its tallies are read back; a buffer that overflowed grows to hold them
 * and the next `settle` scatters again, so a chart is never left with a
 * truncated forest. Past the device's largest storage binding, `settle`
 * throws.
 */
import {
  type Compute,
  compute,
  type Draw,
  draw,
  type Frame,
  type FramePass,
  type Gpu,
  type ShaderSource,
  type StorageBuffer,
  storage,
  type Target,
  type Texture,
} from "vgpu";
import type { MapName } from "../maps/map-params";
import type { PlannedTree, WorldLayer, WorldPlan } from "./world";

export interface FoliageShaders {
  foliage: ShaderSource;
  foliageScatter: ShaderSource;
}

/** Chart units of a candidate cell: about a grove tree's spacing. */
const FOLIAGE_CELL = 1.75;
/** The plants each buffer holds before it first grows. */
const FOLIAGE_CAP = 32_768;
/** The plan's tree kinds as the scatter numbers them. */
const PLANNED_KINDS: Readonly<Record<PlannedTree["kind"], number>> = {
  garden: 3,
  grove: 1,
  pine: 2,
  street: 0,
};

/** vec4f a plant (shaders/world/foliage-scatter.wgsl `packInstance`). */
const INSTANCE_BYTES = 64;
/** vec4f a planned tree. */
const PLANNED_FLOATS = 4;
const GROUP = 8;
const PLANNED_GROUP = 64;
/** u32 of draw arguments: the trees, the shrubs, the shadows. */
const ARGS_BYTES = 48;
const SHRUB_ARGS = 16;
const SHADOW_ARGS = 32;

/** Plants placed, before the caps, and the plants the draws draw. */
interface FoliageCount {
  /** Trees and shrubs drawn: the placed, clamped to the buffers. */
  readonly drawn: number;
  /** The plan's named trees. */
  readonly planned: number;
  /** Shrubs scattered. */
  readonly shrubs: number;
  /** Trees scattered, the named ones apart. */
  readonly trees: number;
}

export interface Foliage extends WorldLayer {
  /** The plants the last scatter placed, read back: for tests and logs. */
  count: () => Promise<FoliageCount>;
}

/** The plan's trees as the scatter reads them: x, z, kind, crown radius. */
function packPlanned(trees: readonly PlannedTree[]): Float32Array<ArrayBuffer> {
  const data = new Float32Array(Math.max(trees.length, 1) * PLANNED_FLOATS);
  for (const [index, tree] of trees.entries()) {
    data.set(
      [tree.at[0], tree.at[1], PLANNED_KINDS[tree.kind], tree.size],
      index * PLANNED_FLOATS
    );
  }
  return data;
}

/** The starting cap doubled until it holds `count`. */
function capacityFor(count: number, start = FOLIAGE_CAP): number {
  let cap = Math.max(start, 1);
  while (cap < count) {
    cap *= 2;
  }
  return cap;
}

/**
 * The foliage layer on `gpu`. `cap` is the plants each buffer starts with,
 * `FOLIAGE_CAP` unless a test wants to see a buffer grow.
 */
export function createFoliage(
  gpu: Gpu,
  shaders: FoliageShaders,
  linear: GPUSampler,
  { cap = FOLIAGE_CAP }: { readonly cap?: number } = {}
): Foliage {
  const pass = (entry: string): Compute =>
    compute(gpu, shaders.foliageScatter, {
      entry,
      label: `islands-foliage-${entry}`,
    });
  const plantedPass = pass("cs_planned");
  const placePass = pass("cs_place");
  const finalizePass = pass("cs_finalize");
  const plants = (entry: "tree" | "shrub"): Draw =>
    draw(gpu, {
      cull: "none",
      depth: { compare: "greater" },
      entry: { fragment: "fs_plant", vertex: `vs_${entry}` },
      label: `islands-foliage-${entry}s`,
      shader: shaders.foliage,
    });
  const treeDraw = plants("tree");
  const shrubDraw = plants("shrub");
  // Over the terrain and the town, under nothing: no depth of its own.
  const shadowDraw: Draw = draw(gpu, {
    blend: "alpha",
    cull: "none",
    depth: { compare: "greater", write: false },
    entry: { fragment: "fs_shadow", vertex: "vs_shadow" },
    label: "islands-foliage-shadows",
    shader: shaders.foliage,
  });
  const largest = Math.floor(
    gpu.gpu.limits.maxStorageBufferBindingSize / INSTANCE_BYTES
  );
  const caps = { shrubs: cap, trees: cap };
  const buffer = (count: number) =>
    storage(gpu, count * INSTANCE_BYTES, "read-write");
  let trees: StorageBuffer = buffer(caps.trees);
  let shrubs: StorageBuffer = buffer(caps.shrubs);
  const tallies: StorageBuffer = storage(gpu, 8, "read-write");
  const counts: StorageBuffer = storage(gpu, 8, "read-write");
  const args: StorageBuffer = storage(gpu, ARGS_BYTES, { indirect: true });
  let planned: StorageBuffer = storage(gpu, 16, "read");
  let plannedCount = 0;
  let hasPlan = false;
  let settledOn: Readonly<Record<MapName, Texture>> | null = null;
  let height: Texture | undefined;
  let scattered = false;
  // Each scatter's number, so a late read-back of an older one is ignored.
  let scatters = 0;
  let failure: Error | null = null;

  const grow = (kind: "trees" | "shrubs", count: number) => {
    if (count <= caps[kind]) {
      return false;
    }
    if (count > largest) {
      failure = new Error(
        `Islands foliage: the scatter placed ${count} ${kind}, more than the ${largest} one storage binding holds on this device.`
      );
      return false;
    }
    caps[kind] = Math.min(capacityFor(count, caps[kind]), largest);
    if (kind === "trees") {
      trees = buffer(caps.trees);
    } else {
      shrubs = buffer(caps.shrubs);
    }
    return true;
  };

  // Once the scatter's frame has run: grow an overflowed buffer and have
  // the next settle scatter again.
  const check = async (scatter: number) => {
    const data = new Uint32Array(await tallies.read());
    if (scatter !== scatters) {
      return;
    }
    const grewTrees = grow("trees", data[0] ?? 0);
    const grewShrubs = grow("shrubs", data[1] ?? 0);
    if (grewTrees || grewShrubs) {
      settledOn = null;
    }
  };

  return {
    async compile(film: Target) {
      await Promise.all([
        plantedPass.compile(),
        placePass.compile(),
        finalizePass.compile(),
        treeDraw.compile(film),
        shrubDraw.compile(film),
        shadowDraw.compile(film),
      ]);
    },
    async count() {
      const [placed, drawn] = await Promise.all([
        tallies.read(),
        counts.read(),
      ]);
      const tally = new Uint32Array(placed);
      const draws = new Uint32Array(drawn);
      return {
        drawn: (draws[0] ?? 0) + (draws[1] ?? 0),
        planned: plannedCount,
        shrubs: tally[1] ?? 0,
        trees: (tally[0] ?? 0) - plannedCount,
      };
    },
    dispose() {
      for (const item of [
        plantedPass,
        placePass,
        finalizePass,
        treeDraw,
        shrubDraw,
        shadowDraw,
      ]) {
        item.dispose();
      }
    },
    draw(filmPass: FramePass, light, grid) {
      if (!scattered) {
        return;
      }
      const props = {
        occlusion: light.occlusion,
        occlusionSun: light.occlusionSun,
        origin: grid.origin,
        seaFill: light.seaFill,
        shadowStrength: light.shadowStrength,
        side: grid.texel * grid.resolution,
        skyColor: light.skyColor,
        skyStrength: light.skyStrength,
        sun: light.sun,
        sunColor: light.sunColor,
        sunStrength: light.sunStrength,
        viewProjection: light.viewProjection,
        viewport: light.viewport,
      };
      for (const d of [shadowDraw, treeDraw, shrubDraw]) {
        d.set({ props });
      }
      filmPass.draw(shadowDraw, {
        indirect: { buffer: args, offset: SHADOW_ARGS },
      });
      filmPass.draw(treeDraw, { indirect: args });
      filmPass.draw(shrubDraw, {
        indirect: { buffer: args, offset: SHRUB_ARGS },
      });
    },
    set(plan: WorldPlan) {
      plannedCount = plan.trees.length;
      const data = packPlanned(plan.trees);
      planned =
        planned.size === data.byteLength
          ? planned
          : storage(gpu, data.byteLength, "read");
      planned.write(data);
      // The planned trees always fit: they are placed before the scatter.
      grow("trees", plannedCount * 2);
      hasPlan = true;
      settledOn = null;
    },
    settle(frame: Frame, grid, textures) {
      if (failure) {
        throw failure;
      }
      // The maps the scatter reads; the light because each plant keeps
      // the occlusion and sun at its foot.
      const reads = ["height", "light", "distance", "zoning"] as const;
      if (
        !hasPlan ||
        (settledOn !== null &&
          reads.every((name) => settledOn?.[name] === textures[name]))
      ) {
        return;
      }
      settledOn = textures;
      ({ height } = textures);
      const side = grid.texel * grid.resolution;
      const cells = Math.ceil(side / FOLIAGE_CELL);
      const params = {
        cell: FOLIAGE_CELL,
        cells,
        origin: grid.origin,
        planned: plannedCount,
        shrubCap: caps.shrubs,
        side,
        treeCap: caps.trees,
      };
      tallies.write(new Uint32Array([0, 0]));
      const maps = {
        distance: textures.distance,
        height: textures.height,
        light: textures.light,
        linear,
      };
      plantedPass.set({ params, ...maps, planned, tallies, trees });
      placePass.set({
        params,
        ...maps,
        shrubs,
        tallies,
        trees,
        zoning: textures.zoning,
      });
      finalizePass.set({ args, counts, params, tallies });
      const groups = Math.ceil(cells / GROUP);
      frame.computePass((c) => {
        if (plannedCount > 0) {
          c.dispatch(plantedPass, Math.ceil(plannedCount / PLANNED_GROUP));
        }
        c.dispatch(placePass, groups, groups);
        c.dispatch(finalizePass, 1);
      });
      treeDraw.set({ instances: trees });
      shrubDraw.set({ instances: shrubs });
      shadowDraw.set({ counts, height, instances: trees, linear, shrubs });
      scattered = true;
      scatters += 1;
      const scatter = scatters;
      // Submitting replaces `frame.done`: read it once the callback returned.
      queueMicrotask(() => {
        frame.done.then(() => check(scatter));
      });
    },
  };
}
