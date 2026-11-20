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

export const DEBRIS_MAPS = [
  "height",
  "light",
  "distance",
  "paint",
] as const satisfies readonly MapName[];

type DebrisMap = (typeof DEBRIS_MAPS)[number];

export interface DebrisDensity {
  readonly pebbles: number;
  readonly shells: number;
  readonly size: number;
  readonly stacks: number;
}

export interface DebrisLight {
  readonly occlusion: number;
  readonly occlusionSun: number;
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
  readonly viewport: readonly [number, number];
}

const DEBRIS_CELL = 1.25;
const DEBRIS_CAP = 65_536;
const INSTANCE_VEC4S = 3;
const BYTES_PER_VEC4 = 16;
const ARGS_U32S = 8;
const RINGS_OFFSET = 16;
const GROUP = 8;
const FADE_PIXELS = [0.45, 1.3] as const;
const FOAM = [0.97, 0.98, 0.96] as const;

export interface Debris {
  compile: (film: Target) => Promise<void>;
  count: () => Promise<number>;
  dispose: () => void;
  draw: (pass: FramePass, light: DebrisLight) => void;
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
