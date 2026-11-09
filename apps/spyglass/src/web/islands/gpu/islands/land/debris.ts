/**
 * The props on the shallows: pebbles, shells and now and then a sea stack,
 * as real 3D instances. `place` scatters them from the maps on the GPU
 * (shaders/land/debris/place.wgsl) whenever the maps or the densities change:
 * an atomic tally appends each kept candidate, and a finalize pass writes
 * the draws' arguments, so the CPU never reads a count back. `draw` puts
 * the bodies and the stacks' foam rings into the film with the terrain
 * (shaders/land/debris/props.wgsl).
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
import type { MapFrame } from "../maps/map-uniforms";

export interface DebrisShaders {
  debrisPlace: ShaderSource;
  debrisProps: ShaderSource;
}

/**
 * The maps `place` reads. Only their rebuilds move the props: a rebuilt
 * files or zoning map leaves the sea as it lies.
 */
export const DEBRIS_MAPS = [
  "height",
  "light",
  "distance",
  "paint",
] as const satisfies readonly MapName[];

type DebrisMap = (typeof DEBRIS_MAPS)[number];

/** What placement keeps, per candidate. */
export interface DebrisDensity {
  /** Pebbles: the share of candidates on a lip, a third of it on flat floor. */
  readonly pebbles: number;
  /** Shells: the share of candidates at the water's edge. */
  readonly shells: number;
  /** Multiplies every prop's size. */
  readonly size: number;
  /** Stacks per thousand square chart units of shallow plate. */
  readonly stacks: number;
}

/** What the draws read each frame. */
export interface DebrisLight {
  /** The baked occlusion's power, and the sun's share of it. */
  readonly occlusion: number;
  readonly occlusionSun: number;
  /** The foam rings round the stacks, 0 for none. */
  readonly rings: number;
  readonly rock: readonly number[];
  readonly seaFill: readonly number[];
  readonly shadowStrength: number;
  readonly skyColor: readonly number[];
  readonly skyStrength: number;
  readonly sun: readonly number[];
  readonly sunColor: readonly number[];
  readonly sunStrength: number;
  readonly time: number;
  readonly viewProjection: Float32Array | readonly number[];
  /** The film's size, pixels. */
  readonly viewport: readonly [number, number];
}

/** Chart units of a candidate cell: about a pebble's spacing at full density. */
const DEBRIS_CELL = 1.25;
/** The most props the buffer holds. */
const DEBRIS_CAP = 65_536;
/** vec4f per prop (shaders/land/debris/instance.wgsl). */
const INSTANCE_VEC4S = 3;
const BYTES_PER_VEC4 = 16;
/** u32 of draw arguments: the bodies, then the rings. */
const ARGS_U32S = 8;
const RINGS_OFFSET = 16;
const GROUP = 8;
/** Props shrink away between these radii on screen, pixels. */
const FADE_PIXELS = [0.45, 1.3] as const;
/** The surf's foam (shaders/sea/shore.wgsl `FOAM`). */
const FOAM = [0.97, 0.98, 0.96] as const;

export interface Debris {
  compile: (film: Target) => Promise<void>;
  /** Props placed, before the cap: for tests and logs. */
  count: () => Promise<number>;
  dispose: () => void;
  /** Draws the bodies and rings into the film pass. */
  draw: (pass: FramePass, light: DebrisLight) => void;
  /** Places the props on `textures`, encoding into `frame`. */
  place: (
    frame: Frame,
    grid: MapFrame,
    textures: Readonly<Record<DebrisMap, Texture>>,
    density: DebrisDensity,
    depths: { readonly top: number; readonly sandHeight: number }
  ) => void;
}

export function createDebris(
  gpu: Gpu,
  shaders: DebrisShaders,
  linear: GPUSampler
): Debris {
  const place: Compute = compute(gpu, shaders.debrisPlace, {
    entry: "cs_place",
    label: "islands-debris-place",
  });
  const finalize: Compute = compute(gpu, shaders.debrisPlace, {
    entry: "cs_finalize",
    label: "islands-debris-args",
  });
  const bodies: Draw = draw(gpu, {
    cull: "none",
    depth: { compare: "greater" },
    entry: { fragment: "fs_body", vertex: "vs_body" },
    label: "islands-debris",
    shader: shaders.debrisProps,
  });
  const rings: Draw = draw(gpu, {
    cull: "none",
    depth: { compare: "greater" },
    entry: { fragment: "fs_ring", vertex: "vs_ring" },
    label: "islands-debris-rings",
    shader: shaders.debrisProps,
  });
  const instances: StorageBuffer = storage(
    gpu,
    DEBRIS_CAP * INSTANCE_VEC4S * BYTES_PER_VEC4,
    "read-write"
  );
  const tally: StorageBuffer = storage(gpu, 4, "read-write");
  const args: StorageBuffer = storage(gpu, ARGS_U32S * 4, { indirect: true });
  let side = 1;
  let origin: readonly [number, number] = [0, 0];
  let placed = false;

  return {
    async compile(film) {
      await Promise.all([
        place.compile(),
        finalize.compile(),
        bodies.compile(film),
        rings.compile(film),
      ]);
    },
    async count() {
      return new Uint32Array(await tally.read())[0] ?? 0;
    },
    dispose() {
      for (const item of [place, finalize, bodies, rings]) {
        item.dispose();
      }
    },
    draw(pass, light) {
      if (!placed) {
        return;
      }
      const uniform = {
        fadeEnd: FADE_PIXELS[1],
        fadeStart: FADE_PIXELS[0],
        foam: FOAM,
        occlusion: light.occlusion,
        occlusionSun: light.occlusionSun,
        origin,
        rings: light.rings,
        rock: light.rock,
        seaFill: light.seaFill,
        shadowStrength: light.shadowStrength,
        side,
        skyColor: light.skyColor,
        skyStrength: light.skyStrength,
        sun: light.sun,
        sunColor: light.sunColor,
        sunStrength: light.sunStrength,
        time: light.time,
        viewProjection: light.viewProjection,
        viewport: light.viewport,
      };
      bodies.set({ props: uniform });
      pass.draw(bodies, { indirect: args });
      if (light.rings > 0) {
        rings.set({ props: uniform });
        pass.draw(rings, { indirect: { buffer: args, offset: RINGS_OFFSET } });
      }
    },
    place(frame, grid, textures, density, depths) {
      side = grid.texel * grid.resolution;
      origin = [grid.origin[0], grid.origin[1]];
      const cells = Math.ceil(side / DEBRIS_CELL);
      tally.write(new Uint32Array([0]));
      const params = {
        cap: DEBRIS_CAP,
        cell: DEBRIS_CELL,
        cells,
        origin,
        pebbles: Math.max(density.pebbles, 0),
        sandHeight: depths.sandHeight,
        shells: Math.max(density.shells, 0),
        side,
        size: Math.max(density.size, 0),
        stacks: (Math.max(density.stacks, 0) * DEBRIS_CELL ** 2) / 1000,
        top: depths.top,
      };
      place.set({
        distance: textures.distance,
        height: textures.height,
        instances,
        light: textures.light,
        linear,
        paint: textures.paint,
        params,
        tally,
      });
      finalize.set({ args, params, tally });
      const groups = Math.ceil(cells / GROUP);
      frame.computePass((c) => {
        c.dispatch(place, groups, groups);
        c.dispatch(finalize, 1);
      });
      for (const d of [bodies, rings]) {
        d.set({ instances, light: textures.light, linear });
      }
      placed = true;
    },
  };
}
