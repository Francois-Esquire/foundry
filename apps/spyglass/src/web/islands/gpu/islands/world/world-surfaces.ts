/**
 * The world's surfaces (WORLD.md layer 3): the roads as ribbons and the
 * parcels as pads, packed on the CPU when the plan is set
 * (world-surfaces-build.ts) and drawn into the film in two draws, the pads
 * and then the roads (shaders/world/surfaces.wgsl). Each vertex's ground is
 * found once on the GPU when the plan or the height map changes
 * (`settle`, the shader's `cs_drape`); the frame reads it and does no CPU
 * work in proportion to the plan.
 *
 * Both draws blend their anti-aliased edges over what is already in the
 * film, so they go after the terrain and before anything that stands on
 * them (the town's bodies, its blended shadows, the foliage).
 */
import {
  type Compute,
  compute,
  type Draw,
  draw,
  type Gpu,
  type ShaderSource,
  type StorageBuffer,
  storage,
  type Texture,
} from "vgpu";
import type { WorldLayer } from "./world";
import { type PackedSurfaces, packSurfaces } from "./world-surfaces-build";

interface SurfaceCounts {
  readonly joints: number;
  readonly junctions: number;
  readonly padVertices: number;
  readonly ribbonVertices: number;
}

export interface Surfaces extends WorldLayer {
  /** What the last plan packed into, for readouts and tests. */
  readonly counts: SurfaceCounts;
}

/** Threads a workgroup of the drape (shaders/world/surfaces.wgsl `cs_drape`). */
const DRAPE_GROUP = 64;
const FLOAT_BYTES = 4;

export function createSurfaces(
  gpu: Gpu,
  shader: ShaderSource,
  linear: GPUSampler
): Surfaces {
  const surfaceDraw = (kind: "pad" | "road"): Draw =>
    draw(gpu, {
      blend: "alpha",
      cull: "none",
      depth: { compare: "greater" },
      entry: { fragment: `fs_${kind}`, vertex: `vs_${kind}` },
      label: `islands-surfaces-${kind}s`,
      shader,
    });
  const pads = surfaceDraw("pad");
  const roads = surfaceDraw("road");
  const drapeOf = (kind: string): Compute =>
    compute(gpu, shader, {
      entry: "cs_drape",
      label: `islands-surfaces-drape-${kind}`,
    });
  const padDrape = drapeOf("pads");
  const roadDrape = drapeOf("roads");
  // Reallocated only when a plan's size changes, as the town's are.
  const buffers: Record<string, StorageBuffer> = {};
  const fit = (
    name: string,
    bytes: number,
    access: "read" | "read-write"
  ): StorageBuffer => {
    const held = buffers[name];
    const buffer =
      held && held.size === bytes ? held : storage(gpu, bytes, access);
    buffers[name] = buffer;
    return buffer;
  };
  const upload = (name: string, data: Float32Array<ArrayBuffer>) => {
    const buffer = fit(name, data.byteLength, "read");
    buffer.write(data);
    return buffer;
  };
  let packed: PackedSurfaces | undefined;
  let settledOn: Texture | null = null;
  let light: Texture | undefined;
  let counts: SurfaceCounts = {
    joints: 0,
    junctions: 0,
    padVertices: 0,
    ribbonVertices: 0,
  };
  return {
    async compile(film) {
      await Promise.all([
        pads.compile(film),
        roads.compile(film),
        padDrape.compile(),
        roadDrape.compile(),
      ]);
    },
    get counts() {
      return counts;
    },
    dispose() {
      pads.dispose();
      roads.dispose();
      padDrape.dispose();
      roadDrape.dispose();
      // The buffers belong to the gpu: its dispose frees them.
    },
    draw(pass, sky, grid) {
      if (!(packed && light && settledOn)) {
        return;
      }
      const props = {
        occlusion: sky.occlusion,
        occlusionSun: sky.occlusionSun,
        origin: grid.origin,
        seaFill: sky.seaFill,
        shadowStrength: sky.shadowStrength,
        side: grid.texel * grid.resolution,
        skyColor: sky.skyColor,
        skyStrength: sky.skyStrength,
        sun: sky.sun,
        sunColor: sky.sunColor,
        sunStrength: sky.sunStrength,
        viewProjection: sky.viewProjection,
        viewport: sky.viewport,
      };
      if (packed.padVertices > 0) {
        pads.set({ light, linear, props });
        pass.draw(pads, { vertices: packed.padVertices });
      }
      if (packed.ribbonVertices > 0) {
        roads.set({ light, linear, props });
        pass.draw(roads, { vertices: packed.ribbonVertices });
      }
    },
    set(plan) {
      packed = packSurfaces(plan);
      counts = {
        joints: packed.joints,
        junctions: packed.junctions,
        padVertices: packed.padVertices,
        ribbonVertices: packed.ribbonVertices,
      };
      const ribbons = upload("ribbons", packed.ribbons);
      const padVertices = upload("pads", packed.pads);
      const ribbonGround = fit(
        "ribbonGround",
        Math.max(packed.ribbonVertices, 1) * FLOAT_BYTES,
        "read-write"
      );
      const padGround = fit(
        "padGround",
        Math.max(packed.padVertices, 1) * FLOAT_BYTES,
        "read-write"
      );
      roads.set({
        gaps: upload("gaps", packed.gaps),
        ribbonGround,
        ribbons,
        roads: upload("roads", packed.roads),
      });
      pads.set({
        outlines: upload("outlines", packed.outlines),
        padGround,
        pads: padVertices,
        parcels: upload("parcels", packed.parcels),
      });
      roadDrape.set({ grounds: ribbonGround, linear, placed: ribbons });
      padDrape.set({ grounds: padGround, linear, placed: padVertices });
      settledOn = null;
    },
    settle(frame, grid, textures) {
      ({ light } = textures);
      if (!packed || settledOn === textures.height) {
        return;
      }
      settledOn = textures.height;
      const side = grid.texel * grid.resolution;
      const runs = [
        [roadDrape, packed.ribbonVertices],
        [padDrape, packed.padVertices],
      ] as const;
      for (const [pass, count] of runs) {
        pass.set({
          drape: { count, origin: grid.origin, side },
          height: textures.height,
        });
      }
      frame.computePass((c) => {
        for (const [pass, count] of runs) {
          if (count > 0) {
            c.dispatch(pass, Math.ceil(count / DRAPE_GROUP));
          }
        }
      });
    },
  };
}
