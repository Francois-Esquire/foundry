import {
  type Draw,
  draw,
  type Effect,
  effect,
  type Frame,
  type Geometry,
  type Gpu,
  geometry,
  type ShaderSource,
  type StorageBuffer,
  sampler,
  storage,
  type Target,
  type Texture,
  type TimerSpan,
  target,
} from "vgpu";
import { type ClipLayout, clipLayout, levelIndices } from "../land/clipmap";
import { createDebris, DEBRIS_MAPS, type DebrisShaders } from "../land/debris";
import { MAP_NAMES, type MapName } from "../maps/map-params";
import type { MapSource } from "../maps/maps";
import { createPost, type PostShaders } from "../post/post";
import type { View } from "../view/camera";
import {
  createSelectionCache,
  type SelectionShaders,
} from "../view/selection-cache";
import { createTown, type TownShaders } from "../world/town-draw";
import type { WorldLayer, WorldPlan } from "../world/world";
import { createFoliage, type FoliageShaders } from "../world/world-foliage";
import { createSurfaces } from "../world/world-surfaces";
import {
  debrisLightOf,
  postLookOf,
  terrainUniforms,
  waterUniforms,
} from "./frame-uniforms";
import type { Look } from "./look";

export interface IslandsShaders
  extends DebrisShaders,
    FoliageShaders,
    PostShaders,
    SelectionShaders,
    TownShaders {
  surfaces: ShaderSource;
  terrain: ShaderSource;
  water: ShaderSource;
}

export interface SceneTimers {
  terrain?: TimerSpan;
  water?: TimerSpan;
}

const FILM_FORMAT = "rgba16float";
const FILM_DEPTH = "depth32float";

function filmSize(
  output: readonly [number, number],
  scale: number
): [number, number] {
  return [
    Math.max(1, Math.round(output[0] * scale)),
    Math.max(1, Math.round(output[1] * scale)),
  ];
}

export interface Scene {
  readonly clip: ClipLayout | null;
  compile: (output: Target) => Promise<void>;
  dispose: () => void;
  readonly film: Target;
  render: (
    frame: Frame,
    output: Target,
    view: View,
    maps: MapSource,
    look: Look,
    timers?: SceneTimers
  ) => void;
  setIslandColors: (colors: Float32Array<ArrayBuffer>) => void;
  setSelection: (
    selection: StorageBuffer,
    members: Uint32Array<ArrayBuffer>
  ) => void;
  setWorld: (plan: WorldPlan) => void;
}

export type WorldLayerFactory = (
  gpu: Gpu,
  shaders: IslandsShaders,
  linear: GPUSampler
) => WorldLayer;

const WORLD_LAYERS: readonly WorldLayerFactory[] = [
  (gpu, shaders, linear) => createSurfaces(gpu, shaders.surfaces, linear),
  createTown,
  createFoliage,
];

const sameTextures = (
  a: Readonly<Record<MapName, Texture>> | null,
  b: Readonly<Record<MapName, Texture>>,
  names: readonly MapName[] = MAP_NAMES
) => a !== null && (a === b || names.every((name) => a[name] === b[name]));

export function createScene(
  gpu: Gpu,
  shaders: IslandsShaders,
  layers: readonly WorldLayerFactory[] = WORLD_LAYERS
): Scene {
  const film = target(gpu, {
    depth: FILM_DEPTH,
    format: FILM_FORMAT,
    label: "islands-film",
    size: [1, 1],
  });
  const linear = sampler(gpu, { magFilter: "linear", minFilter: "linear" });
  const meshOf = (isRing: boolean): Geometry =>
    geometry(gpu, {
      buffers: [],
      indices: levelIndices(isRing),
      label: isRing ? "islands-clip-ring" : "islands-clip-square",
      topology: "triangle-list",
    });
  const meshes = [meshOf(false), meshOf(true)] as const;
  const terrainDraw = (mesh: Geometry, label: string): Draw =>
    draw(gpu, {
      cull: "none",
      depth: { compare: "greater" },
      geometry: mesh,
      label,
      shader: shaders.terrain,
    });
  const square = terrainDraw(meshes[0], "islands-terrain-square");
  const ring = terrainDraw(meshes[1], "islands-terrain-ring");
  const terrain = [square, ring] as const;
  const water: Effect = effect(gpu, shaders.water, {
    label: "islands-water",
    set: { film, filmDepth: film, filmSampler: linear, mapSampler: linear },
  });
  const debris = createDebris(gpu, shaders, linear);
  const world = layers.map((make) => make(gpu, shaders, linear));
  const post = createPost(gpu, shaders, linear);
  let placedOn: Readonly<Record<MapName, Texture>> | null = null;
  let placedWith = "";
  let islandColors: StorageBuffer = storage(gpu, 16, "read");
  const bindColors = () => {
    for (const d of terrain) {
      d.set({ islandColors });
    }
  };
  bindColors();
  for (const d of terrain) {
    d.set({ mapSampler: linear });
  }

  let bound: Readonly<Record<MapName, Texture>> | null = null;
  let clip: ClipLayout | null = null;
  let members: StorageBuffer = storage(gpu, 8, "read");
  let selectionBuffer = storage(gpu, 16, "read");
  water.set({ members, selection: selectionBuffer });
  let largeWater: Draw | undefined;
  let selectionCache: ReturnType<typeof createSelectionCache> | undefined;

  const bindMaps = (textures: Readonly<Record<MapName, Texture>>) => {
    if (sameTextures(bound, textures)) {
      return;
    }
    bound = textures;
    const {
      distance,
      islands,
      coverage,
      height,
      rings,
      flow,
      light,
      shade,
      paint,
      files,
      zoning,
      seabed,
    } = textures;
    for (const d of terrain) {
      d.set({
        coverage,
        distance,
        files,
        flow,
        height,
        islands,
        light,
        paint,
        rings,
        seabed,
        shade,
        zoning,
      });
    }
    water.set({
      distance,
      flow,
      height,
      islands,
      light,
      paint,
      rings,
      seabed,
      shade,
    });
  };

  return {
    get clip() {
      return clip;
    },
    async compile(output) {
      await Promise.all([
        square.compile(film),
        ring.compile(film),
        water.compile(post.frame),
        debris.compile(film),
        ...world.map((layer) => layer.compile(film)),
        post.compile(output),
      ]);
    },
    dispose() {
      largeWater?.dispose();
      selectionCache?.dispose();
      for (const item of [square, ring, water, debris, ...world, post]) {
        item.dispose();
      }
      for (const mesh of meshes) {
        mesh.destroy();
      }
    },
    film,
    render(frame, output, view, maps, look, timers = {}) {
      const size = filmSize(output.size, look.renderScale);
      if (size[0] !== film.size[0] || size[1] !== film.size[1]) {
        film.resize(size);
      }
      bindMaps(maps.textures);
      let activeWater: Effect | Draw = water;
      if (maps.selection) {
        if (!largeWater) {
          largeWater = draw(gpu, {
            constants: { SCALABLE_SELECTION: true },
            label: "islands-water-large",
            set: {
              film,
              filmDepth: film,
              filmSampler: linear,
              mapSampler: linear,
              members,
              selection: selectionBuffer,
            },
            shader: shaders.water,
          });
        }
        selectionCache ??= createSelectionCache(gpu, shaders);
        const cached = selectionCache.encode(
          frame,
          maps,
          selectionBuffer,
          members
        );
        const { height, light, shade, distance, flow, paint, islands, seabed } =
          maps.textures;
        largeWater.set({
          distance,
          flow,
          height,
          islands,
          light,
          paint,
          rings: cached,
          seabed,
          shade,
        });
        activeWater = largeWater;
      }
      const { frame: grid } = maps;
      const pixel = (2 * view.aperture[1]) / size[1];
      clip = clipLayout(view.eye, pixel, grid, clip?.stride, maps.seabed);
      const terrainSet = terrainUniforms(view, clip, grid, maps.seabed, look);
      for (const d of terrain) {
        d.set(terrainSet);
      }
      activeWater.set(waterUniforms(view, grid, maps.seabed, look));
      const density = JSON.stringify([look.debris, look.top, look.sandHeight]);
      if (
        !sameTextures(placedOn, maps.textures, DEBRIS_MAPS) ||
        placedWith !== density
      ) {
        debris.place(frame, grid, maps.textures, look.debris, look);
        placedOn = maps.textures;
        placedWith = density;
      }
      for (const layer of world) {
        layer.settle(frame, grid, maps.textures);
      }
      const rings = clip.levels - 1;
      frame.pass(
        {
          clear: [0, 0, 0, 1],
          clearDepth: 0,
          target: film,
          timer: timers.terrain,
        },
        (pass) => {
          pass.draw(square, { firstInstance: 0, instances: 1 });
          if (rings > 0) {
            pass.draw(ring, { firstInstance: 1, instances: rings });
          }
          if (look.view === "shaded") {
            const light = debrisLightOf(view, look, size);
            debris.draw(pass, light);
            for (const layer of world) {
              layer.draw(pass, light, grid);
            }
          }
        }
      );
      post.resize(output.size);
      frame.pass({ target: post.frame, timer: timers.water }, activeWater);
      post.render(frame, output, postLookOf(look));
    },
    setIslandColors(colors) {
      if (colors.byteLength !== islandColors.size) {
        islandColors = storage(gpu, Math.max(colors.byteLength, 16), "read");
        bindColors();
      }
      islandColors.write(colors);
    },
    setSelection(selection, masks) {
      if (masks.byteLength !== members.size) {
        members = storage(gpu, masks.byteLength, "read");
      }
      members.write(masks);
      selectionBuffer = selection;
      water.set({ members, selection });
      largeWater?.set({ members, selection });
    },
    setWorld(plan) {
      for (const layer of world) {
        layer.set(plan);
      }
    },
  };
}
