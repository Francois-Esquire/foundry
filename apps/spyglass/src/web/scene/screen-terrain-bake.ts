import {
  DataTexture,
  FloatType,
  HalfFloatType,
  NearestFilter,
  RedFormat,
  RenderTarget,
  RGBAFormat,
  RGFormat,
} from "three";
import {
  Fn,
  float,
  floor,
  If,
  int,
  ivec2,
  Loop,
  max,
  min,
  mix,
  screenCoordinate,
  select,
  smoothstep,
  textureLoad,
  uniform,
  vec2,
  vec4,
} from "three/tsl";
import {
  MeshBasicNodeMaterial,
  type Node,
  QuadMesh,
  type Renderer,
  type Texture,
  type UniformNode,
} from "three/webgpu";
import { contourStepField } from "../../lib/visualization/contours";
import { geologyLevels } from "../../lib/visualization/geology";
import { defaultLagoonSettings } from "../../lib/visualization/lagoons";
import {
  type ClipmapLevel,
  type ClipmapSettings,
  defaultClipmapSettings,
} from "../../lib/visualization/screen-terrain-clipmap";
import {
  binCorner,
  type CoastBins,
  coastBins,
  coastSegments,
} from "../../lib/visualization/screen-terrain-coast";
import {
  kernelElevationAtDepth,
  kernelInletChannel,
} from "../../lib/visualization/terrain-kernel-lagoon";
import {
  islandStride,
  kernelWorldLandform,
  lagoonOffset,
  packLandforms,
} from "../../lib/visualization/terrain-kernel-landform";
import { kernelNoise } from "../../lib/visualization/terrain-kernel-noise";
import type { ChartWorld } from "../layout/chart-world";
import {
  defaultGeologyPreviewSettings,
  seaLevels,
  terracePass,
} from "./geology-layer";
import { sunDirection } from "./geology-light";
import { reliefSun } from "./geology-relief";
import { splineSample, terraceNode } from "./screen-terrain-seabed";
import { nodeMath } from "./terrain-kernel-tsl";

/**
 * The screen terrain's bake: the clipmap's levels drawn on the GPU, one
 * texel per sample, side by side in two atlases. The height pass writes
 * each texel's elevation and owning island: the world field's seabed read
 * bicubically between its cells, the preview's coasts measured exactly
 * from their segments, and land from each island's landform kernel at the
 * texel's own position, so a coast or an escarpment is as crisp as the
 * texel. The derived pass then reads the heights back for each texel's
 * gradient and its sun's horizon. A level is a full-screen pass into its
 * own square of each atlas, so the bake runs on WebGPU and on the WebGL 2
 * backend alike; a compute pass writing a storage texture is the WebGPU
 * path's later refinement (see `_screen-terrain.md`).
 */
export const defaultScreenTerrainBakeSettings = {
  /** Map units along a side of the coast's bins. */
  binCell: 8,
  clipmap: defaultClipmapSettings,
  /**
   * The seabed falls at least `slope` elevation units a map unit out from
   * the coast once `reach` map units out, nearly 1 m a map unit, easing in
   * from level at the coast itself:
   * the water deepens from nothing at the coast itself, so the elevation is
   * continuous across it and its zero lies on the coast's true line
   * between texels, not on the texel grid.
   */
  shore: { reach: 2, slope: 0.006 },
  /**
   * Map units either side of the coast over which the elevation is a
   * straight ramp of `slope` elevation units a map unit, and as far again
   * over which it hands back to the land and the seabed.
   */
  waterline: { band: 0.5, slope: 0.006 },
};
export type ScreenTerrainBakeSettings = typeof defaultScreenTerrainBakeSettings;

/** Texels across a wrapped one-dimensional data texture. */
const rowLength = 4096;

/** A float data texture read texel by texel. */
function dataTexture(
  values: Float32Array,
  width: number,
  height: number,
  format: typeof RedFormat | typeof RGFormat | typeof RGBAFormat
): DataTexture {
  const texture = new DataTexture(values, width, height, format, FloatType);
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** Values laid along wrapped rows of `rowLength`, `channels` a texel. */
function wrapped(
  values: ArrayLike<number>,
  channels: 1 | 4
): { height: number; values: Float32Array } {
  const texels = Math.max(1, Math.ceil(values.length / channels));
  const height = Math.ceil(texels / rowLength);
  const padded = new Float32Array(rowLength * height * channels);
  padded.set(Array.from(values));
  return { height, values: padded };
}

/**
 * The piece depth `world-terrain` gives a position in each cell: its own,
 * or on water the deepest of its neighbours'. Read nearest, it is the
 * world landform's piece depth anywhere.
 */
function nearPieceDepths(world: ChartWorld["world"]): Float32Array {
  const { height, pieceDepth, width } = world;
  return Float32Array.from(pieceDepth, (own, at) => {
    if (own > 0) {
      return own;
    }
    const column = at % width;
    const row = Math.floor(at / width);
    let deepest = 0;
    for (
      let r = Math.max(0, row - 1);
      r <= Math.min(height - 1, row + 1);
      r += 1
    ) {
      for (
        let c = Math.max(0, column - 1);
        c <= Math.min(width - 1, column + 1);
        c += 1
      ) {
        deepest = Math.max(deepest, pieceDepth[r * width + c] ?? 0);
      }
    }
    return deepest;
  });
}

/**
 * An island's landform record as the kernels read it: `read` a slot known
 * when the shader is built, `readAt` one computed in it, texel then
 * channel. `island` must be held (a variable) by the caller.
 */
export function islandRecordReader(
  inputs: ScreenTerrainInputs,
  island: Node<"int">
) {
  const read = (slot: number) => {
    const texel = textureLoad(
      inputs.textures.islands,
      ivec2(Math.floor(slot / 4), island)
    );
    return [texel.x, texel.y, texel.z, texel.w][slot % 4] as Node<"float">;
  };
  const readAt = (slot: Node<"float">): Node<"float"> => {
    const whole = int(slot);
    const texel = textureLoad(
      inputs.textures.islands,
      ivec2(whole.div(4), island)
    );
    const channel = float(whole.mod(4));
    return select(
      channel.lessThan(0.5),
      texel.x,
      select(
        channel.lessThan(1.5),
        texel.y,
        select(channel.lessThan(2.5), texel.z, texel.w)
      )
    );
  };
  return { read, readAt };
}

/**
 * The seabed at a map position as the bake composes it: the world field's
 * seabed before the terrace pass read as a cubic B-spline, its terraces
 * cut at the spline's slope, the detail pass added back, and at most the
 * shore's ramp out from the coast `distance` map units away.
 */
export function seabedNode(
  inputs: ScreenTerrainInputs,
  grid: Pick<ChartWorld["world"], "cell" | "height" | "left" | "top" | "width">,
  point: { x: Node<"float">; y: Node<"float"> },
  distance: Node<"float">,
  shore: ScreenTerrainBakeSettings["shore"] = defaultScreenTerrainBakeSettings.shore
): Node<"float"> {
  const field = splineSample(inputs.textures.macro, grid, point.x, point.y);
  const seabed = terraceNode(
    field.value.x,
    vec2(field.slopeX.x, field.slopeY.x),
    terracePass
  ).add(field.value.z);
  // Past the shore's reach the ramp climbs away, and the seabed is the field's.
  // It leaves the coast level, as the land's beach does, so the
  // elevation carries no crease along the coast for the light to catch.
  const ramp = distance
    .mul(-shore.slope)
    .mul(min(distance.div(shore.reach), 1))
    .add(max(distance.sub(shore.reach), 0));
  return min(seabed, ramp);
}

/** What the bake reads from the CPU: the world's fields, the coasts and the islands' records. */
export interface ScreenTerrainInputs {
  bins: CoastBins;
  /** Bytes the inputs hold on the GPU. */
  bytes: number;
  dispose: () => void;
  islandCount: number;
  segmentCount: number;
  textures: {
    bins: DataTexture;
    islands: DataTexture;
    list: DataTexture;
    macro: DataTexture;
    piece: DataTexture;
    segmentIsland: DataTexture;
    segments: DataTexture;
  };
}

/**
 * The bake's CPU inputs from the chart's world: the seabed and the
 * lagoons as one two-channel field on the world grid, each cell's piece
 * depth, the coasts' segments and bins, and each island's landform record.
 */
export function screenTerrainInputs(
  chart: ChartWorld,
  settings: ScreenTerrainBakeSettings = defaultScreenTerrainBakeSettings
): ScreenTerrainInputs {
  const { world } = chart;
  const cells = world.width * world.height;
  // The seabed before the terrace pass, and what the detail pass added:
  // the bake cuts the terraces per texel and adds the detail back. With
  // them, the traced step field's coordinate and span across the slope,
  // which the plates and bathymetric contours are drawn from: measured by
  // distance to the level lines, so a broad low rise just over a level is
  // a line round its edge, not a plate's lip over all of it.
  const steps = contourStepField(
    world,
    seaLevels().elevations,
    defaultGeologyPreviewSettings.terraces.reach
  );
  const macro = new Float32Array(cells * 4);
  for (let at = 0; at < cells; at += 1) {
    const featured = world.featured[at] ?? 0;
    // The seabed meets every coast at the water level, as the lattice's does.
    macro[at * 4] = Math.min(geologyLevels.waterLevel, featured);
    macro[at * 4 + 1] = steps.coordinate[at] ?? 0;
    macro[at * 4 + 2] = world.detail[at] ?? 0;
    macro[at * 4 + 3] = steps.spacing[at] ?? 0;
  }
  const segments = coastSegments(world.islands, world.islandIds);
  const bins = coastBins(world.islands, world.islandIds, segments, {
    cell: settings.binCell,
    height: Math.ceil((world.height * world.cell) / settings.binCell),
    left: world.left,
    top: world.top,
    width: Math.ceil((world.width * world.cell) / settings.binCell),
  });
  const binTexels = new Float32Array(bins.width * bins.height * 4);
  for (let at = 0; at < bins.width * bins.height; at += 1) {
    binTexels[at * 4] = bins.bins[at * 3] ?? 0;
    binTexels[at * 4 + 1] = bins.bins[at * 3 + 1] ?? 0;
    binTexels[at * 4 + 2] = bins.bins[at * 3 + 2] ?? 0;
  }
  const list = wrapped(bins.list, 1);
  const points = wrapped(segments.points, 4);
  const owners = wrapped(segments.island, 1);
  const records = Float32Array.from(
    packLandforms(chart.landforms, world.islandIds, undefined, world.lagoons)
  );
  const textures = {
    bins: dataTexture(binTexels, bins.width, bins.height, RGBAFormat),
    islands: dataTexture(
      records,
      islandStride / 4,
      Math.max(1, world.islandIds.length),
      RGBAFormat
    ),
    list: dataTexture(list.values, rowLength, list.height, RedFormat),
    macro: dataTexture(macro, world.width, world.height, RGBAFormat),
    piece: dataTexture(
      nearPieceDepths(world),
      world.width,
      world.height,
      RedFormat
    ),
    segmentIsland: dataTexture(
      owners.values,
      rowLength,
      owners.height,
      RedFormat
    ),
    segments: dataTexture(points.values, rowLength, points.height, RGBAFormat),
  };
  const bytes = Object.values(textures).reduce(
    (sum, texture) => sum + (texture.image.data as Float32Array).byteLength,
    0
  );
  return {
    bins,
    bytes,
    dispose() {
      for (const texture of Object.values(textures)) {
        texture.dispose();
      }
    },
    islandCount: world.islandIds.length,
    segmentCount: segments.island.length,
    textures,
  };
}

/** The placement of the level a pass draws, as uniforms. */
interface LevelUniforms {
  /** The level's first texel column in the atlas. */
  atlas: UniformNode<"float", number>;
  centreX: UniformNode<"float", number>;
  centreY: UniformNode<"float", number>;
  left: UniformNode<"float", number>;
  texel: UniformNode<"float", number>;
  top: UniformNode<"float", number>;
}

function levelUniforms(): LevelUniforms {
  return {
    atlas: uniform(0),
    centreX: uniform(0),
    centreY: uniform(0),
    left: uniform(0),
    texel: uniform(1),
    top: uniform(0),
  };
}

function writeLevel(
  uniforms: LevelUniforms,
  level: ClipmapLevel,
  resolution: number
): void {
  uniforms.atlas.value = level.index * resolution;
  uniforms.centreX.value = level.centreX;
  uniforms.centreY.value = level.centreY;
  uniforms.left.value = level.left;
  uniforms.texel.value = level.texel;
  uniforms.top.value = level.top;
}

/** A texel of a wrapped one-dimensional data texture. */
function wrappedTexel(texture: Texture, index: Node<"int">) {
  return textureLoad(
    texture,
    ivec2(index.mod(rowLength), index.div(rowLength))
  );
}

/**
 * Cubic weights for a fraction, as four nodes. Catmull–Rom interpolates,
 * so the samples hold at their texels, with a continuous slope between
 * them; the cubic B-spline has a continuous curvature too and never
 * overshoots, at the price of softening what it reads a little.
 */
export function cubicWeights(
  t: Node<"float">,
  kind: "b-spline" | "catmull-rom"
): Node<"float">[] {
  const t2 = t.mul(t);
  const t3 = t2.mul(t);
  if (kind === "b-spline") {
    const s = t.oneMinus();
    return [
      s.mul(s).mul(s).div(6),
      t3.mul(3).sub(t2.mul(6)).add(4).div(6),
      t3.mul(-3).add(t2.mul(3)).add(t.mul(3)).add(1).div(6),
      t3.div(6),
    ];
  }
  return [
    t.mul(t.mul(t.mul(-0.5).add(1)).sub(0.5)),
    t2.mul(t.mul(1.5).sub(2.5)).add(1),
    t.mul(t.mul(t.mul(-1.5).add(2)).add(0.5)),
    t2.mul(t.mul(0.5).sub(0.5)),
  ];
}

/**
 * The coast at a map position, as `coastDistance` measures it on the
 * CPU: the nearest listed segment of the position's bin, its island on
 * land, and land where the ray from the bin's corner crosses the coast an
 * odd number of times from a corner at sea. Returns the signed distance,
 * negative on land, and the island of the nearest coast, on land or
 * near it at sea: -1 only in a bin that lists no coast.
 */
export function coastNode(
  inputs: ScreenTerrainInputs,
  x: Node<"float">,
  y: Node<"float">
) {
  const { bins, textures } = inputs;
  const column = floor(x.sub(bins.left).div(bins.cell));
  const row = floor(y.sub(bins.top).div(bins.cell));
  const nearest = float(1e6).toVar();
  const owner = float(-1).toVar();
  const inside = float(0).toVar();
  const within = column
    .greaterThanEqual(0)
    .and(row.greaterThanEqual(0))
    .and(column.lessThan(bins.width))
    .and(row.lessThan(bins.height));
  If(within, () => {
    const bin = textureLoad(textures.bins, ivec2(int(column), int(row)));
    inside.assign(bin.z);
    // Ray from the bin's corner, in coordinates local to it for precision.
    const cornerX = column.mul(bins.cell).add(bins.left + binCorner.x);
    const cornerY = row.mul(bins.cell).add(bins.top + binCorner.y);
    const px = x.sub(cornerX).toVar();
    const py = y.sub(cornerY).toVar();
    const start = int(bin.x);
    Loop(
      { condition: "<", end: int(bin.y), start: int(0), type: "int" },
      ({ i }: { i: Node<"int"> }) => {
        const segment = int(wrappedTexel(textures.list, start.add(i)).x);
        const ends = wrappedTexel(textures.segments, segment);
        const ax = ends.x.sub(cornerX);
        const ay = ends.y.sub(cornerY);
        const bx = ends.z.sub(cornerX);
        const by = ends.w.sub(cornerY);
        const dx = bx.sub(ax);
        const dy = by.sub(ay);
        const length = dx.mul(dx).add(dy.mul(dy));
        const t = px
          .sub(ax)
          .mul(dx)
          .add(py.sub(ay).mul(dy))
          .div(max(length, 1e-12))
          .clamp(0, 1);
        const distance = vec2(
          px.sub(ax).sub(t.mul(dx)),
          py.sub(ay).sub(t.mul(dy))
        ).length();
        If(distance.lessThan(nearest), () => {
          nearest.assign(distance);
          owner.assign(wrappedTexel(textures.segmentIsland, segment).x);
        });
        // The ray from the corner (0, 0) to (px, py) against the segment.
        const side = (
          ux: Node<"float">,
          uy: Node<"float">,
          vx: Node<"float">,
          vy: Node<"float">,
          wx: Node<"float">,
          wy: Node<"float">
        ) =>
          vx
            .sub(ux)
            .mul(wy.sub(uy))
            .sub(vy.sub(uy).mul(wx.sub(ux)))
            .greaterThan(0)
            .select(float(1), float(0));
        const zero = float(0);
        const c = side(ax, ay, bx, by, zero, zero);
        const p = side(ax, ay, bx, by, px, py);
        const a = side(zero, zero, px, py, ax, ay);
        const b = side(zero, zero, px, py, bx, by);
        const differ = (one: Node<"float">, other: Node<"float">) =>
          one.sub(other).abs().greaterThan(0.5);
        If(differ(c, p).and(differ(a, b)), () => {
          inside.assign(float(1).sub(inside));
        });
      }
    );
  });
  const land = inside.greaterThan(0.5);
  return {
    distance: land.select(nearest.negate(), nearest),
    owner,
  };
}

/** The bake's two atlases and its passes. */
export function createScreenTerrainBake(options: {
  chart: ChartWorld;
  inputs: ScreenTerrainInputs;
  settings?: ScreenTerrainBakeSettings;
}) {
  const {
    chart,
    inputs,
    settings = defaultScreenTerrainBakeSettings,
  } = options;
  const clipmap: ClipmapSettings = settings.clipmap;
  const size = clipmap.resolution;
  const atlasWidth = size * clipmap.levels;
  const target = (
    type: typeof FloatType | typeof HalfFloatType,
    format: typeof RGFormat | typeof RGBAFormat
  ) => {
    const made = new RenderTarget(atlasWidth, size, {
      depthBuffer: false,
      format,
      generateMipmaps: false,
      magFilter: NearestFilter,
      minFilter: NearestFilter,
      type,
    });
    return made;
  };
  /** Each texel's elevation and owning island (-1 at sea). */
  const heights = target(FloatType, RGFormat);
  /** Each texel's gradient per map unit, x then y down the chart, and its sun's visibility. */
  const derived = target(HalfFloatType, RGBAFormat);

  const level = levelUniforms();
  const parent = levelUniforms();
  const { world } = chart;
  const grid = {
    cell: world.cell,
    height: world.height,
    left: world.left,
    top: world.top,
    width: world.width,
  };
  const noise = kernelNoise(nodeMath);

  /** The map position of the fragment's texel in the level being drawn. */
  const texelPoint = () => {
    const column = screenCoordinate.x.sub(level.atlas);
    return {
      x: level.left.add(column.mul(level.texel)).toVar(),
      y: level.top.add(screenCoordinate.y.mul(level.texel)).toVar(),
    };
  };

  const heightNode = Fn(() => {
    const { x, y } = texelPoint();
    const coast = coastNode(inputs, x, y);
    const distance = coast.distance.toVar();
    const owner = coast.owner.toVar();
    const elevation = seabedNode(
      inputs,
      grid,
      { x, y },
      distance,
      settings.shore
    ).toVar();
    // The island's record, nearest coast's island at sea.
    const island = int(max(owner, 0)).toVar();
    const { read, readAt } = islandRecordReader(inputs, island);
    // An atoll's inlets run on past the coast, cut into the seabed.
    If(distance.greaterThanEqual(0).and(owner.greaterThanEqual(0)), () => {
      const channel = kernelInletChannel(
        nodeMath,
        noise,
        {
          read: (slot) => read(lagoonOffset + slot),
          readAt: (slot) => readAt(slot.add(lagoonOffset)),
        },
        { x, y },
        defaultLagoonSettings
      );
      If(channel.greaterThan(0), () => {
        elevation.assign(
          min(elevation, kernelElevationAtDepth(nodeMath, channel))
        );
      });
    });
    If(distance.lessThan(0), () => {
      const cell = ivec2(
        int(floor(x.sub(grid.left).div(grid.cell)).clamp(0, grid.width - 1)),
        int(floor(y.sub(grid.top).div(grid.cell)).clamp(0, grid.height - 1))
      );
      // The island's landform, an atoll's lagoon and inlets carved in.
      const land = kernelWorldLandform(
        nodeMath,
        noise,
        { read, readAt },
        {
          inland: distance.negate(),
          pieceDepth: textureLoad(inputs.textures.piece, cell).x,
          x,
          y,
        },
        defaultLagoonSettings
      );
      elevation.assign(min(geologyLevels.land, land));
    });
    // Within the waterline's band the elevation is the signed distance's
    // own straight ramp, the same on both sides of the coast: a cubic read
    // of the texels reproduces a straight ramp exactly, so the waterline
    // falls on the coast's true line wherever it crosses the texel grid.
    const { band } = settings.waterline;
    const ramp = distance.mul(-settings.waterline.slope);
    const keep = smoothstep(band, band * 2, distance.abs());
    return vec4(mix(ramp, elevation, keep), owner, distance, 1);
  });

  /** A level's height at a map position, bilinear between its texels, clamped to the level. */
  const heightAt = (
    uniforms: LevelUniforms,
    x: Node<"float">,
    y: Node<"float">
  ): Node<"float"> => {
    const u = x.sub(uniforms.left).div(uniforms.texel).sub(0.5);
    const v = y.sub(uniforms.top).div(uniforms.texel).sub(0.5);
    const column = floor(u).clamp(0, size - 2);
    const row = floor(v).clamp(0, size - 2);
    const s = u.sub(column).clamp(0, 1);
    const t = v.sub(row).clamp(0, 1);
    const at = (dc: number, dr: number) =>
      textureLoad(
        heights.texture,
        ivec2(int(column.add(uniforms.atlas)).add(dc), int(row).add(dr))
      ).x;
    return mix(mix(at(0, 0), at(1, 0), s), mix(at(0, 1), at(1, 1), s), t);
  };

  const sun = reliefSun(sunDirection);
  const { relief, exaggeration } = defaultGeologyPreviewSettings;
  const seabedShadow =
    defaultGeologyPreviewSettings.light.relief.seabed * relief.shadow.seabed;

  const derivedNode = Fn(() => {
    const column = floor(screenCoordinate.x.sub(level.atlas));
    const row = floor(screenCoordinate.y);
    const load = (dc: number, dr: number) =>
      textureLoad(
        heights.texture,
        ivec2(
          int(
            column
              .add(dc)
              .clamp(0, size - 1)
              .add(level.atlas)
          ),
          int(row.add(dr).clamp(0, size - 1))
        )
      ).x;
    const own = load(0, 0).toVar();
    const gradient = vec2(
      load(1, 0).sub(load(-1, 0)),
      load(0, 1).sub(load(0, -1))
    ).div(level.texel.mul(2));
    const { x, y } = texelPoint();
    // The steepest rise toward the sun, the seabed's own relief raised
    // for the shadow as the CPU bake raises it; what stands over the water
    // keeps its true height.
    const reliefFactor = own.lessThan(0).select(float(seabedShadow), float(1));
    const horizon = float(-1e6).toVar();
    for (const distance of relief.shadow.distances) {
      const qx = x.add(sun.bearing[0] * distance);
      const qy = y.add(sun.bearing[1] * distance);
      const reach = max(
        qx.sub(level.centreX).abs(),
        qy.sub(level.centreY).abs()
      );
      const limit = level.texel.mul(size / 2 - 2);
      const there = reach
        .lessThan(limit)
        .select(heightAt(level, qx, qy), heightAt(parent, qx, qy));
      const rise = min(there, 0).sub(own).mul(reliefFactor).add(max(there, 0));
      horizon.assign(max(horizon, rise.mul(exaggeration / distance)));
    }
    const lit = float(1).sub(
      smoothstep(
        sun.slope - relief.shadow.softness,
        sun.slope + relief.shadow.softness,
        horizon
      ).mul(relief.shadow.strength)
    );
    return vec4(gradient, lit, 1);
  });

  const heightMaterial = new MeshBasicNodeMaterial();
  heightMaterial.fragmentNode = heightNode();
  heightMaterial.depthTest = false;
  heightMaterial.depthWrite = false;
  const derivedMaterial = new MeshBasicNodeMaterial();
  derivedMaterial.fragmentNode = derivedNode();
  derivedMaterial.depthTest = false;
  derivedMaterial.depthWrite = false;
  const heightQuad = new QuadMesh(heightMaterial);
  const derivedQuad = new QuadMesh(derivedMaterial);

  /**
   * Draws the heights of each listed level, then their derived values, in
   * place in the atlases. `levels` is the whole layout: the derived pass
   * reads the next coarser level where a horizon leaves the finer one.
   */
  const bake = (
    renderer: Renderer,
    levels: readonly ClipmapLevel[],
    indices: readonly number[]
  ) => {
    if (!indices.length) {
      return;
    }
    const previous = renderer.getRenderTarget();
    const { autoClear } = renderer;
    renderer.autoClear = false;
    // Coarse first: a finer level's horizon may read the coarser one.
    const order = [...indices].sort((a, b) => b - a);
    for (const index of order) {
      const placed = levels[index];
      if (placed) {
        writeLevel(level, placed, size);
        heights.viewport.set(index * size, 0, size, size);
        renderer.setRenderTarget(heights);
        heightQuad.render(renderer);
      }
    }
    for (const index of order) {
      const placed = levels[index];
      const coarser = levels[Math.min(levels.length - 1, index + 1)];
      if (placed && coarser) {
        writeLevel(level, placed, size);
        writeLevel(parent, coarser, size);
        derived.viewport.set(index * size, 0, size, size);
        renderer.setRenderTarget(derived);
        derivedQuad.render(renderer);
      }
    }
    renderer.setRenderTarget(previous);
    renderer.autoClear = autoClear;
  };

  return {
    bake,
    /** Bytes the atlases hold on the GPU. */
    bytes: atlasWidth * size * (8 + 8),
    derived,
    dispose() {
      heights.dispose();
      derived.dispose();
      heightMaterial.dispose();
      derivedMaterial.dispose();
    },
    heights,
  };
}

export type ScreenTerrainBake = ReturnType<typeof createScreenTerrainBake>;
