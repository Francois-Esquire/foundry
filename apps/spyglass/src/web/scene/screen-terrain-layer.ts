import { BufferAttribute, BufferGeometry, Group, Mesh } from "three";
import type { Renderer } from "three/webgpu";
import {
  type ClipmapLevel,
  clipmapLayout,
  finestNeededLevel,
  type LevelBake,
  levelsToBake,
} from "../../lib/visualization/screen-terrain-clipmap";
import type { SpyglassData } from "../data/types";
import { chartHull } from "../layout/chart-hull";
import { chartWorld } from "../layout/chart-world";
import { isSceneLayerVisible } from "../settings/scene-composition";
import type { InkView } from "../view/chart-view";
import type { SceneLayer } from "./handle";
import { createEmanationTexture } from "./ocean-emanation";
import {
  createScreenTerrainBake,
  defaultScreenTerrainBakeSettings,
  screenTerrainInputs,
} from "./screen-terrain-bake";
import { screenTerrainMaterial } from "./screen-terrain-material";

/**
 * The screen terrain: the geology preview's world computed on the GPU at
 * about one sample a screen pixel, at any zoom. A developer's layer,
 * hidden in every preset; it stands in for the geology preview, so show one
 * or the other. The CPU keeps the decisions and the world grid; each
 * frame the layer bakes the clipmap levels the view needs whose place or
 * content changed, and a camera-fitted grid stands each vertex at its
 * elevation so escarpments rise in the tilted view, while every pixel is
 * shaded from the clipmap itself.
 */
const defaultScreenTerrainSettings = {
  bake: defaultScreenTerrainBakeSettings,
  mesh: {
    /** The grid's side as a share of the longer side of the view's ground. */
    cover: 1.4,
    /** Quads along each side of the grid. */
    segments: 512,
    /** Share of the grid's side the view may move before it is laid again. */
    shift: 0.12,
  },
};
export type ScreenTerrainSettings = typeof defaultScreenTerrainSettings;

/** The camera-fitted grid's placement, in world units. */
interface GridPlacement {
  side: number;
  x: number;
  y: number;
}

/** A flat grid of `segments` quads a side over a unit square, laid in world units by `layGrid`. */
function gridGeometry(segments: number): BufferGeometry {
  const across = segments + 1;
  const positions = new Float32Array(across * across * 3);
  const index = new Uint32Array(segments * segments * 6);
  let next = 0;
  for (let row = 0; row < segments; row += 1) {
    for (let column = 0; column < segments; column += 1) {
      const a = row * across + column;
      const b = a + 1;
      const c = a + across;
      const d = c + 1;
      // Rows run down the chart, so (a, c, b) winds anticlockwise from above.
      index.set([a, c, b, b, c, d], next);
      next += 6;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setIndex(new BufferAttribute(index, 1));
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  return geometry;
}

/** Writes the grid's vertices over a placement: world x right, y up. */
function layGrid(
  geometry: BufferGeometry,
  segments: number,
  placement: GridPlacement
): void {
  const across = segments + 1;
  const positions = geometry.getAttribute("position");
  for (let row = 0; row < across; row += 1) {
    for (let column = 0; column < across; column += 1) {
      positions.setXYZ(
        row * across + column,
        placement.x + (column / segments - 0.5) * placement.side,
        placement.y + (0.5 - row / segments) * placement.side,
        0
      );
    }
  }
  positions.needsUpdate = true;
}

/** The terrain built for a chart: its inputs, bake, material and mesh. */
function buildScreenTerrain(options: {
  data: SpyglassData;
  extent: { height: number; width: number };
  settings: ScreenTerrainSettings;
}) {
  const { data, extent, settings } = options;
  const started = performance.now();
  const chart = chartWorld(data);
  const charted = performance.now();
  const inputs = screenTerrainInputs(chart, settings.bake);
  const prepared = performance.now();
  const bake = createScreenTerrainBake({
    chart,
    inputs,
    settings: settings.bake,
  });
  const emanationTexture = createEmanationTexture(
    chartHull(data, extent).field
  );
  const terrain = screenTerrainMaterial({
    bake,
    chart,
    clipmap: settings.bake.clipmap,
    data,
    emanationTexture,
    inputs,
  });
  const geometry = gridGeometry(settings.mesh.segments);
  const mesh = new Mesh(geometry, terrain.material);
  // The grid is laid over the view in world units; its bounds move with it.
  mesh.frustumCulled = false;
  return {
    bake,
    chart,
    dispose() {
      geometry.dispose();
      terrain.dispose();
      bake.dispose();
      inputs.dispose();
      emanationTexture.texture.dispose();
    },
    geometry,
    inputs,
    mesh,
    terrain,
    timings: {
      chartMs: charted - started,
      inputsMs: prepared - charted,
      materialMs: performance.now() - prepared,
    },
  };
}

type ScreenTerrain = ReturnType<typeof buildScreenTerrain>;

/**
 * The screen terrain as a scene layer, hidden by default. Nothing is built
 * until the composition first shows it; each update while shown bakes what
 * the view needs and lays the grid over it.
 */
export function createScreenTerrainLayer(options: {
  data: SpyglassData;
  /** A developer session: each bake's GPU time is measured as `spyglass:screen-terrain:bake`. */
  developer?: boolean;
  extent: { height: number; width: number };
  renderer: Renderer;
  settings?: ScreenTerrainSettings;
}): SceneLayer & { terrain: () => ScreenTerrain } {
  const {
    data,
    developer = false,
    extent,
    renderer,
    settings = defaultScreenTerrainSettings,
  } = options;
  const group = new Group();
  const { clipmap } = settings.bake;
  let built: ScreenTerrain | undefined;
  const baked: (LevelBake | undefined)[] = [];
  let placement: GridPlacement | undefined;
  const last = { bakeMs: 0, finest: 0, levelsBaked: 0 };
  const terrain = () => {
    if (!built) {
      built = buildScreenTerrain({ data, extent, settings });
      group.add(built.mesh);
    }
    return built;
  };

  /** Bakes the levels the view needs and records what each was baked for. */
  const bakeFor = (view: InkView, shown: ScreenTerrain) => {
    const footprint = 1 / (view.pixelsPerUnit * renderer.getPixelRatio());
    const levels = clipmapLayout(clipmap, { x: view.x, y: view.y });
    const { key } = shown.chart.world;
    const due = levelsToBake({
      baked,
      footprint,
      key,
      levels,
      settings: clipmap,
    });
    const finest = finestNeededLevel(clipmap, footprint);
    if (due.length) {
      const start = performance.now();
      shown.bake.bake(renderer, levels, due);
      last.bakeMs = performance.now() - start;
      last.levelsBaked = due.length;
      for (const index of due) {
        const level = levels[index] as ClipmapLevel;
        baked[index] = { centreX: level.centreX, centreY: level.centreY, key };
      }
      if (developer) {
        measureBake(renderer, shown, start);
      }
    }
    last.finest = finest;
    shown.terrain.uniforms.write(levels, finest);
  };

  /** Lays the grid over the view's ground when the view has moved or zoomed far enough. */
  const layFor = (view: InkView, shown: ScreenTerrain) => {
    const { mesh } = settings;
    const side = Math.max(view.width, view.height) * mesh.cover;
    const { x } = view;
    // World y is map y turned over.
    const y = -view.y;
    const scale = placement ? side / placement.side : 0;
    const moved =
      !placement ||
      Math.abs(x - placement.x) > placement.side * mesh.shift ||
      Math.abs(y - placement.y) > placement.side * mesh.shift ||
      scale > 1.25 ||
      scale < 0.8;
    if (moved) {
      const spacing = side / mesh.segments;
      placement = {
        side,
        x: Math.round(x / spacing) * spacing,
        y: Math.round(y / spacing) * spacing,
      };
      layGrid(shown.geometry, mesh.segments, placement);
      shown.terrain.meshLevel.value = spacing;
    }
  };

  return {
    dispose() {
      built?.dispose();
    },
    group,
    id: "screen-terrain",
    kind: "layer",
    stats: (): Record<string, number> =>
      built
        ? {
            atlasBytes: built.bake.bytes,
            bakeMs: last.bakeMs,
            finestLevel: last.finest,
            inputBytes: built.inputs.bytes,
            levelsBaked: last.levelsBaked,
            segments: built.inputs.segmentCount,
            ...built.timings,
          }
        : {},
    terrain,
    update(view, state) {
      if (!isSceneLayerVisible(state.settings.composition, "screen-terrain")) {
        return;
      }
      const shown = terrain();
      bakeFor(view, shown);
      layFor(view, shown);
    },
  };
}

/**
 * A developer's measure of a bake's GPU time: from the bake's start until
 * a texel of it reads back, recorded as `spyglass:screen-terrain:bake`. It
 * waits on everything queued before the readback, so it is an upper bound.
 */
function measureBake(renderer: Renderer, shown: ScreenTerrain, start: number) {
  renderer
    .readRenderTargetPixelsAsync(shown.bake.derived, 0, 0, 1, 1)
    .then(() => {
      performance.measure("spyglass:screen-terrain:bake", {
        end: performance.now(),
        start,
      });
    })
    .catch(() => undefined);
}
