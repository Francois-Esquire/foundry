import {
  Color,
  DataTexture,
  DataUtils,
  FloatType,
  HalfFloatType,
  LinearFilter,
  RGBAFormat,
  Vector4,
} from "three";
import {
  color,
  dFdx,
  dFdy,
  Fn,
  float,
  floor,
  fwidth,
  If,
  int,
  ivec2,
  log2,
  max,
  min,
  mix,
  positionLocal,
  positionWorld,
  texture as sampleTexture,
  smoothstep,
  step,
  textureLoad,
  uniform,
  uniformArray,
  vec2,
  vec3,
  vec4,
} from "three/tsl";
import { MeshBasicNodeMaterial, type Node } from "three/webgpu";
import {
  contourLevels,
  defaultContourSettings,
} from "../../lib/visualization/contours";
import {
  type GeologyGrid,
  geologyLevels,
} from "../../lib/visualization/geology";
import { noiseSeed } from "../../lib/visualization/noise";
import type {
  ClipmapLevel,
  ClipmapSettings,
} from "../../lib/visualization/screen-terrain-clipmap";
import { kernelNoise } from "../../lib/visualization/terrain-kernel-noise";
import { kernelPlate } from "../../lib/visualization/terrain-kernel-plate";
import type { SpyglassData } from "../data/types";
import { inks } from "../ladder/ink-ladder";
import type { ChartWorld } from "../layout/chart-world";
import { islandPigment } from "../layout/island-pigment";
import { contourInkNode } from "./contour-lines";
import { landSurfaceNode } from "./geology-land";
import {
  defaultGeologyPreviewSettings,
  depthKnots,
  type GeologyPreviewSettings,
} from "./geology-layer";
import { sunDirection, terrainLightNode } from "./geology-light";
import { reliefSun } from "./geology-relief";
import type { createEmanationTexture } from "./ocean-emanation";
import { oceanEmanationNode } from "./ocean-emanation";
import { cubicWeights, type ScreenTerrainBake } from "./screen-terrain-bake";
import { nodeMath } from "./terrain-kernel-tsl";
import { waterOpticsNode } from "./water-optics";

/**
 * The screen terrain's material: every pixel reads the clipmap level whose
 * texel matches its footprint, blended into the next across a level's
 * edge, and shades the geology preview's look from the height alone. The
 * normal comes from the baked gradient, the plates and contour lines from
 * the elevation's own contour coordinate on screen, cavity and curvature
 * from the world grid's means against the pixel's own elevation, and the
 * sun's horizon from the bake. Nothing is interpolated between vertices,
 * so every edge is as crisp as the pixel.
 */

/** Below this many units per pixel a field is flat. */
const flatFootprint = 1e-6;

/** `nominalDepth` as a node: one clamped span per pair of knots, summed. */
function depthNode(elevation: Node<"float">): Node<"float"> {
  const knots = depthKnots();
  let depth: Node<"float"> = float(0);
  for (let index = 1; index < knots.length; index += 1) {
    const upper = knots[index - 1];
    const lower = knots[index];
    if (upper && lower && upper.elevation > lower.elevation) {
      depth = depth.add(
        float(upper.elevation)
          .sub(elevation)
          .div(upper.elevation - lower.elevation)
          .clamp(0, 1)
          .mul(lower.depth - upper.depth)
      );
    }
  }
  return depth;
}

/**
 * A piecewise-linear function of elevation as a node: `values[i]` at
 * `elevations[i]`, held beyond the ends, as one clamped span per pair.
 */
function piecewise(
  elevation: Node<"float">,
  elevations: readonly number[],
  values: readonly number[]
): Node<"float"> {
  let result: Node<"float"> = float(values[0] ?? 0);
  for (let index = 1; index < elevations.length; index += 1) {
    const from = elevations[index - 1] ?? 0;
    const to = elevations[index] ?? 0;
    if (to > from) {
      result = result.add(
        elevation
          .sub(from)
          .div(to - from)
          .clamp(0, 1)
          .mul((values[index] ?? 0) - (values[index - 1] ?? 0))
      );
    }
  }
  return result;
}

/**
 * `contourCoordinate` over sorted level elevations as a node: each level
 * on its integer, half an index beyond the end levels at the field's
 * range ends, held past them.
 */
function coordinateNode(
  elevation: Node<"float">,
  levels: readonly number[]
): Node<"float"> {
  const first = levels[0] ?? 0;
  const last = levels.at(-1) ?? 0;
  const bottom = Math.min(geologyLevels.trenchFloor, first);
  const ceiling = Math.max(geologyLevels.land, last);
  const elevations = [bottom, ...levels, ceiling];
  const values = [
    -0.5,
    ...levels.map((_, index) => index),
    levels.length - 0.5,
  ];
  return piecewise(elevation, elevations, values);
}

/** The contour channels `contourChannels` bakes, from the elevation on screen. */
function contourNodes(
  elevation: Node<"float">,
  land: GeologyPreviewSettings["land"]["contours"]
) {
  const levels = contourLevels({ ...defaultContourSettings, land });
  const all = levels.map((level) => level.elevation);
  const majors = levels
    .filter((level) => level.rank === "major")
    .map((level) => level.elevation);
  return {
    coordinate: coordinateNode(elevation, all),
    elevation,
    major: coordinateNode(elevation, majors),
    visibility: piecewise(
      elevation,
      all,
      levels.map((level) => level.visibility)
    ),
  };
}

/** The sun's bearing over the chart, x right and y up, unit length. */
const sunBearing = (() => {
  const run = Math.hypot(sunDirection.x, sunDirection.y);
  return [sunDirection.x / run, sunDirection.y / run] as const;
})();

/**
 * The seabed's light across a plate, the geology preview's plate term as
 * the plate kernel builds it, read from the elevation's own contour
 * coordinate on screen, so the edges are as crisp as the pixel.
 */
function plateLightNode(options: {
  coordinate: Node<"float">;
  depth: Node<"float">;
  normal: Node<"vec3">;
  settings: GeologyPreviewSettings["terraces"];
}): Node<"float"> {
  const { coordinate, normal } = options;
  return kernelPlate(
    nodeMath,
    {
      coordinate,
      depth: options.depth,
      footprint: fwidth(coordinate),
      normal: [normal.x, normal.y, normal.z],
    },
    sunBearing,
    options.settings
  );
}

/** A box mean of a grid field over `2·reach + 1` cells each way, clamped to the grid, from a summed-area table. */
function boxMean(
  values: Float32Array,
  width: number,
  height: number,
  reach: number
): Float32Array {
  const stride = width + 1;
  const table = new Float64Array(stride * (height + 1));
  for (let row = 0; row < height; row += 1) {
    let line = 0;
    for (let column = 0; column < width; column += 1) {
      line += values[row * width + column] ?? 0;
      table[(row + 1) * stride + column + 1] =
        (table[row * stride + column + 1] ?? 0) + line;
    }
  }
  const means = new Float32Array(width * height);
  for (let row = 0; row < height; row += 1) {
    const top = Math.max(0, row - reach);
    const bottom = Math.min(height, row + reach + 1);
    for (let column = 0; column < width; column += 1) {
      const left = Math.max(0, column - reach);
      const right = Math.min(width, column + reach + 1);
      const sum =
        (table[bottom * stride + right] ?? 0) -
        (table[top * stride + right] ?? 0) -
        (table[bottom * stride + left] ?? 0) +
        (table[top * stride + left] ?? 0);
      means[row * width + column] = sum / ((bottom - top) * (right - left));
    }
  }
  return means;
}

/** Three fields as one half-float RGBA texture over the world grid, filtered. */
function meansTexture(
  fields: readonly Float32Array[],
  width: number,
  height: number
): DataTexture {
  const data = new Uint16Array(width * height * 4);
  for (let at = 0; at < width * height; at += 1) {
    for (const [channel, field] of fields.entries()) {
      data[at * 4 + channel] = DataUtils.toHalfFloat(field[at] ?? 0);
    }
  }
  const texture = new DataTexture(
    data,
    width,
    height,
    RGBAFormat,
    HalfFloatType
  );
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/**
 * The cavity's means on the world grid, as `bakeRelief` takes them: the
 * seabed's mean within each radius, and the mean of what stands over it,
 * softened by a cell. A pixel sets its own elevation against them.
 */
function cavityMeans(world: ChartWorld["world"], radii: readonly number[]) {
  const { width, height } = world;
  const seabed = Float32Array.from(world.elevation, (value) =>
    Math.min(0, value)
  );
  const over = boxMean(
    Float32Array.from(
      world.elevation,
      (value, at) => value - (seabed[at] ?? 0)
    ),
    width,
    height,
    1
  );
  const reaches = radii.map((radius) =>
    Math.max(1, Math.round(radius / world.cell))
  );
  return {
    over: meansTexture(
      reaches.map((reach) => boxMean(over, width, height, reach)),
      width,
      height
    ),
    seabed: meansTexture(
      reaches.map((reach) => boxMean(seabed, width, height, reach)),
      width,
      height
    ),
  };
}

/** Each island's pigment in linear light, one texel an island in owner order. */
function pigmentTexture(
  islandIds: readonly string[],
  data: Pick<SpyglassData, "territories">
): DataTexture {
  const values = new Float32Array(Math.max(1, islandIds.length) * 4);
  for (const [index, id] of islandIds.entries()) {
    const territory = data.territories.find((each) => each.id === id);
    const pigment = new Color(islandPigment(territory ?? { id }));
    values.set([pigment.r, pigment.g, pigment.b, 1], index * 4);
  }
  const texture = new DataTexture(
    values,
    Math.max(1, islandIds.length),
    1,
    RGBAFormat,
    FloatType
  );
  texture.needsUpdate = true;
  return texture;
}

/** One element of a uniform array of vec4s, by index. */
function vec4Element(
  array: ReturnType<typeof uniformArray>,
  index: Node<"int"> | number
): Node<"vec4"> {
  return array.element(index) as unknown as Node<"vec4">;
}

/** The clipmap's placement as uniforms the material and the mesh read. */
function clipmapUniforms(settings: ClipmapSettings) {
  const placement = Array.from(
    { length: settings.levels },
    () => new Vector4()
  );
  const centres = Array.from({ length: settings.levels }, () => new Vector4());
  return {
    centres: uniformArray(centres, "vec4"),
    /** The finest level baked for the view: no pixel reads finer. */
    finest: uniform(0),
    /** Each level's west and north edges, texel and first atlas column. */
    placement: uniformArray(placement, "vec4"),
    write(levels: readonly ClipmapLevel[], finest: number) {
      for (const level of levels) {
        placement[level.index]?.set(
          level.left,
          level.top,
          level.texel,
          level.index * settings.resolution
        );
        centres[level.index]?.set(level.centreX, level.centreY, 0, 0);
      }
      this.finest.value = finest;
    },
  };
}

type ClipmapUniforms = ReturnType<typeof clipmapUniforms>;

/**
 * The continuous level a point reads, `pixelLevel` as a node: the
 * footprint's, no finer than the finest baked, pushed coarser near each
 * level's edge.
 */
function levelNode(
  settings: ClipmapSettings,
  uniforms: ClipmapUniforms,
  point: Node<"vec2">,
  footprint: Node<"float">
): Node<"float"> {
  let covered: Node<"float"> = float(0);
  for (let index = 0; index < settings.levels - 1; index += 1) {
    const centre = vec4Element(uniforms.centres, index);
    const texel = vec4Element(uniforms.placement, index).z;
    const reach = max(point.x.sub(centre.x).abs(), point.y.sub(centre.y).abs());
    const inset = float(settings.resolution / 2 - settings.edge).sub(
      reach.div(texel)
    );
    covered = covered.add(inset.div(settings.fade).clamp(0, 1).oneMinus());
  }
  const level = max(
    max(log2(max(footprint, 1e-9).div(settings.finest)), uniforms.finest),
    covered
  );
  return min(level, settings.levels - 1);
}

/** The cubic B-spline's weights' slopes for a fraction: the derivative of `cubicWeights`. */
function bSplineSlopes(t: Node<"float">): Node<"float">[] {
  const s = t.oneMinus();
  const t2 = t.mul(t);
  return [
    s.mul(s).mul(-0.5),
    t2.mul(1.5).sub(t.mul(2)),
    t2.mul(-1.5).add(t).add(0.5),
    t2.mul(0.5),
  ];
}

/** One level of the clipmap at a map point: elevation, gradient and sun from a cubic B-spline over its texels, the owner nearest. */
function sampleLevel(
  bake: Pick<ScreenTerrainBake, "derived" | "heights">,
  settings: ClipmapSettings,
  uniforms: ClipmapUniforms,
  index: Node<"int">,
  point: Node<"vec2">,
  withDerived = true
) {
  const placed = vec4Element(uniforms.placement, index);
  const size = settings.resolution;
  const u = point.x.sub(placed.x).div(placed.z).sub(0.5);
  const v = point.y.sub(placed.y).div(placed.z).sub(0.5);
  const column = floor(u).clamp(0, size - 2);
  const row = floor(v).clamp(0, size - 2);
  // The elevation and its gradient, a cubic B-spline over the texels round
  // the point: continuous to its curvature, so neither the light nor an
  // edge drawn from a screen derivative shows the texel grid when the
  // camera comes closer than a texel.
  const fx = u.sub(column);
  const fy = v.sub(row);
  const wx = cubicWeights(fx, "b-spline");
  const wy = cubicWeights(fy, "b-spline");
  const dx = bSplineSlopes(fx);
  const dy = bSplineSlopes(fy);
  let elevation: Node<"float"> = float(0);
  let slopeX: Node<"float"> = float(0);
  let slopeY: Node<"float"> = float(0);
  for (let j = 0; j < 4; j += 1) {
    for (let i = 0; i < 4; i += 1) {
      const c = int(
        column
          .add(i - 1)
          .clamp(0, size - 1)
          .add(placed.w)
      );
      const r = int(row.add(j - 1).clamp(0, size - 1));
      const value = textureLoad(bake.heights.texture, ivec2(c, r)).x;
      const across = wx[i] as Node<"float">;
      const down = wy[j] as Node<"float">;
      elevation = elevation.add(value.mul(across).mul(down));
      slopeX = slopeX.add(value.mul(dx[i] as Node<"float">).mul(down));
      slopeY = slopeY.add(value.mul(across).mul(dy[j] as Node<"float">));
    }
  }
  // The owner of the nearest texel.
  const nearest = textureLoad(
    bake.heights.texture,
    ivec2(
      int(
        floor(u.add(0.5))
          .clamp(0, size - 1)
          .add(placed.w)
      ),
      int(floor(v.add(0.5)).clamp(0, size - 1))
    )
  );
  // The sun's visibility is soft: bilinear between the four texels round the point.
  const sunAt = (dc: number, dr: number) =>
    textureLoad(
      bake.derived.texture,
      ivec2(int(column.add(placed.w)).add(dc), int(row).add(dr))
    ).z;
  const sun = withDerived
    ? mix(
        mix(sunAt(0, 0), sunAt(1, 0), fx.clamp(0, 1)),
        mix(sunAt(0, 1), sunAt(1, 1), fx.clamp(0, 1)),
        fy.clamp(0, 1)
      )
    : float(1);
  return {
    elevation,
    gradient: vec2(slopeX, slopeY).div(placed.z),
    owner: nearest.y,
    sun,
  };
}

/** The share of each level's octave read from it alone, before it blends into the next. */
const levelBlend = 0.5;

/** Elevation units above the water over which the land's fine relief comes in. */
const waterlineRelief = 0.004;

/** The open abyss's lit seabed beyond the world grid, blended in over this many map units. */
const openSeaBand = 64;

/** The terrain's material and the uniforms it reads. */
export function screenTerrainMaterial(options: {
  bake: ScreenTerrainBake;
  chart: ChartWorld;
  clipmap: ClipmapSettings;
  data: Pick<SpyglassData, "territories">;
  emanationTexture: ReturnType<typeof createEmanationTexture>;
  settings?: GeologyPreviewSettings;
}) {
  const {
    bake,
    chart,
    clipmap,
    emanationTexture,
    settings = defaultGeologyPreviewSettings,
  } = options;
  const { world } = chart;
  const uniforms = clipmapUniforms(clipmap);
  const meshLevel = uniform(0);
  const { exaggeration } = settings;

  // The mesh: each vertex stands at its elevation from the level its
  // spacing asks for, so escarpments rise in the tilted view.
  const vertexPoint = vec2(positionLocal.x, positionLocal.y.negate());
  const vertexLevel = levelNode(clipmap, uniforms, vertexPoint, meshLevel);
  const vertexHeight = sampleLevel(
    bake,
    clipmap,
    uniforms,
    int(floor(vertexLevel)),
    vertexPoint,
    false
  ).elevation;

  // The pixel: its map point, footprint and continuous level.
  const point = vec2(positionWorld.x, positionWorld.y.negate()).toVar();
  const footprint = max(dFdx(point).length(), dFdy(point).length());
  const level = levelNode(clipmap, uniforms, point, footprint).toVar();
  const fine = int(floor(level));
  const coarse = int(min(floor(level).add(1), clipmap.levels - 1));
  // Each level is read alone over the lower part of its octave, its texel
  // at most √2 of the pixel, and blends into the next coarser over the
  // upper part; a pixel reads the coarser level only while it blends.
  const share = smoothstep(levelBlend, 1, level.fract());
  const a = sampleLevel(bake, clipmap, uniforms, fine, point);
  const read = Fn(() => {
    const value = vec4(a.elevation, a.gradient, a.sun).toVar();
    If(share.greaterThan(0), () => {
      const b = sampleLevel(bake, clipmap, uniforms, coarse, point);
      value.assign(mix(value, vec4(b.elevation, b.gradient, b.sun), share));
    });
    return value;
  })() as unknown as Node<"vec4">;
  const elevation = read.x;
  const gradient = read.yz;
  const sunShare = read.w;
  const { owner } = a;

  const underwater = float(1).sub(smoothstep(-0.001, 0, elevation));
  // World y is map y turned over, so the y slope changes sign.
  const normal = vec3(
    gradient.x.mul(-exaggeration),
    gradient.y.mul(exaggeration),
    1
  ).normalize();

  // Cavity and curvature, as `bakeRelief`'s, against the pixel's own elevation.
  const means = cavityMeans(world, settings.relief.cavity.radii);
  const gridPoint = vec2(
    point.x.sub(world.left).div(world.width * world.cell),
    point.y.sub(world.top).div(world.height * world.cell)
  );
  const seabedMeans = sampleTexture(means.seabed, gridPoint);
  const overMeans = sampleTexture(means.over, gridPoint);
  const seabedRelief = settings.light.relief.seabed;
  let hollow: Node<"float"> = float(0);
  let bowl: Node<"float"> = float(0);
  const { radii } = settings.relief.cavity;
  const below = elevation.lessThan(0);
  for (const [index, radius] of radii.entries()) {
    const channel = (["x", "y", "z"] as const)[index] ?? "x";
    const seabedPart = seabedMeans[channel].sub(elevation);
    const over = overMeans[channel];
    bowl = bowl.add(below.select(seabedPart, seabedPart.add(over)));
    hollow = hollow.add(
      seabedPart
        .mul(below.select(float(seabedRelief), float(1)))
        .add(over)
        .mul((exaggeration * settings.relief.cavity.gain) / radius)
        .clamp(0, 1)
    );
  }
  const curvature = bowl.div(radii.length);
  const sky = float(1).sub(
    hollow.mul(settings.relief.cavity.strength / radii.length)
  );

  // The seabed's albedo, `seabedAlbedo` per pixel, mottled by the kernel's noise.
  const noise = kernelNoise(nodeMath);
  const mottleSettings = settings.relief.mottle;
  const mottle = noise.fbm(
    point.x.div(mottleSettings.wavelength),
    point.y.div(mottleSettings.wavelength),
    nodeMath.uint(noiseSeed(mottleSettings.seed)),
    { gain: 0.5, lacunarity: 2, octaves: mottleSettings.octaves }
  );
  const depthUnder = depthNode(elevation);
  const slope = gradient.length();
  const seabedAlbedo = seabedAlbedoNode(settings.seabed, {
    curvature,
    depth: depthUnder,
    mottle,
    slope,
  });

  // The land's tread tone, `landTone` per pixel, from the island's pigment.
  const pigments = pigmentTexture(world.islandIds, options.data);
  const pigment = textureLoad(pigments, ivec2(int(max(owner, 0)), 0)).xyz;
  const tread = landToneNode(settings.land, {
    curvature,
    elevation,
    gradient,
    pigment,
  });
  const land = landSurfaceNode({
    albedo: tread,
    elevation,
    exaggeration,
    normal,
    settings: settings.land,
    sky,
  });

  const depth = depthUnder.add(underwater.mul(settings.shoreline.depth));
  const contours = contourNodes(elevation, settings.land.contours);
  const plates = mix(
    float(1),
    plateLightNode({
      coordinate: contours.coordinate,
      depth,
      normal,
      settings: settings.terraces,
    }),
    underwater
  );
  // The land's fine relief is raised on the mesh's facets; at the
  // waterline, where the seabed's light multiplies any slope eightfold, it
  // gives way to the smooth normal before the water begins.
  const waterline = max(
    underwater,
    smoothstep(0, waterlineRelief, elevation).oneMinus()
  );
  const light = terrainLightNode({
    fill: mix(
      float(settings.light.fill.land),
      float(settings.light.fill.seabed),
      underwater
    ),
    normal: mix(land.normal, normal, waterline),
    relief: mix(
      float(settings.light.relief.land),
      float(settings.light.relief.seabed),
      underwater
    ),
    settings: settings.light,
    sky: mix(land.sky, sky, underwater),
    sun: sunShare,
  });
  const open = openSeaNode(world, point);
  const openSeabed = seabedAlbedoNode(settings.seabed, {
    curvature: float(0),
    depth: depthNode(float(geologyLevels.abyss)),
    mottle: float(0),
    slope: float(0),
  }).mul(
    terrainLightNode({
      normal: vec3(0, 0, 1),
      relief: settings.light.relief.seabed,
      settings: settings.light,
      sky: float(1),
      sun: float(1),
    })
  );
  const seabed = mix(
    mix(land.albedo, seabedAlbedo, underwater).mul(light).mul(plates),
    openSeabed,
    open
  );
  const emanation = oceanEmanationNode({
    extent: emanationTexture.extent,
    texture: emanationTexture.texture,
  });
  const opticalDepth = mix(depth, emanation.waterDepth(depth), underwater);
  const optics = waterOpticsNode({
    depth: mix(
      opticalDepth,
      emanation.waterDepth(
        float(depthNode(float(geologyLevels.abyss))).add(
          settings.shoreline.depth
        )
      ),
      open
    ),
    seabedColour: seabed,
  });
  const ink = contourInkNode(contours)
    .mul(optics.visibility)
    .mul(mix(land.contours, float(1), underwater))
    .mul(open.oneMinus())
    .mul(settings.contours);
  const inkColour = mix(
    color(inks.landContour),
    color(inks.seaContour),
    underwater
  );
  const inked = mix(optics.colour, optics.colour.mul(inkColour), ink);
  const foam = float(1)
    .sub(
      smoothstep(
        settings.shoreline.foam.width - 0.5,
        settings.shoreline.foam.width + 0.5,
        elevation.negate().div(max(fwidth(elevation), flatFootprint))
      )
    )
    .mul(settings.shoreline.foam.strength)
    .mul(underwater);
  const material = new MeshBasicNodeMaterial();
  material.positionNode = vec3(
    positionLocal.x,
    positionLocal.y,
    vertexHeight.mul(exaggeration)
  );
  material.colorNode = mix(inked, color(settings.shoreline.foam.colour), foam);
  return {
    dispose() {
      material.dispose();
      optics.dispose();
      emanation.dispose();
      means.over.dispose();
      means.seabed.dispose();
      pigments.dispose();
    },
    material,
    /** Map units between the mesh's vertices, which picks the level they stand on. */
    meshLevel,
    uniforms,
  };
}

/** 1 past the world grid, 0 well inside it, as `geology-layer`'s open sea. */
function openSeaNode(grid: GeologyGrid, point: Node<"vec2">): Node<"float"> {
  const halfWidth = (grid.width * grid.cell) / 2;
  const halfHeight = (grid.height * grid.cell) / 2;
  const inside = min(
    float(halfWidth).sub(point.x.sub(grid.left + halfWidth).abs()),
    float(halfHeight).sub(point.y.sub(grid.top + halfHeight).abs())
  );
  const inset = 1.5 * grid.cell;
  return float(1).sub(smoothstep(inset, inset + openSeaBand, inside));
}

/** `seabedAlbedo` of `geology-layer` per pixel: sand, sediment and rock by depth, slope, curvature and mottling. */
function seabedAlbedoNode(
  seabed: GeologyPreviewSettings["seabed"],
  sample: {
    curvature: Node<"float">;
    depth: Node<"float">;
    mottle: Node<"float">;
    slope: Node<"float">;
  }
): Node<"vec3"> {
  const sediment = min(
    smoothstep(seabed.sedimentDepth.from, seabed.sedimentDepth.to, sample.depth)
      .add(
        smoothstep(
          seabed.basin.curvature.from,
          seabed.basin.curvature.to,
          sample.curvature
        ).mul(seabed.basin.share)
      )
      .add(max(sample.mottle, 0).mul(seabed.mottle.sediment)),
    1
  );
  const rock = min(
    smoothstep(seabed.steep.from, seabed.steep.to, sample.slope)
      .mul(seabed.steep.share)
      .add(
        smoothstep(
          seabed.crest.curvature.from,
          seabed.crest.curvature.to,
          sample.curvature.negate()
        ).mul(seabed.crest.share)
      ),
    1
  );
  return mix(
    mix(color(seabed.sand), color(seabed.sediment), sediment),
    color(seabed.rock),
    rock.mul(
      smoothstep(seabed.rockBelow.from, seabed.rockBelow.to, sample.depth)
    )
  ).mul(sample.mottle.mul(seabed.mottle.light).add(1));
}

/** `landTone` of `geology-land` per pixel: the pigment as a pastel, richer in hollows, paler exposed, warmer facing the sun. */
function landToneNode(
  settings: GeologyPreviewSettings["land"],
  sample: {
    curvature: Node<"float">;
    elevation: Node<"float">;
    gradient: Node<"vec2">;
    pigment: Node<"vec3">;
  }
): Node<"vec3"> {
  const { life } = settings;
  const paper = color(settings.pigment.paper);
  const hollow = smoothstep(
    life.hollow.curvature.from,
    life.hollow.curvature.to,
    sample.curvature
  );
  const exposed = smoothstep(
    life.exposed.curvature.from,
    life.exposed.curvature.to,
    sample.curvature.negate()
  );
  const deepened = mix(
    sample.pigment,
    paper,
    hollow.mul(life.hollow.deepen).add(settings.pigment.deepen).negate()
  ).clamp(0, 1);
  const paled = mix(deepened, paper, exposed.mul(life.exposed.lift));
  const sun = reliefSun(sunDirection);
  const slope = sample.gradient.length();
  const facing = sample.gradient
    .dot(vec2(sun.bearing[0], sun.bearing[1]))
    .negate()
    .div(max(slope, flatFootprint))
    .mul(smoothstep(0, life.aspect.slope, slope))
    .mul(step(flatFootprint, slope));
  const aspect = facing
    .greaterThan(0)
    .select(color(life.aspect.warm), color(life.aspect.cool));
  return mix(paled, aspect, facing.abs().mul(life.aspect.share)).mul(
    sample.elevation.mul(settings.summitLift).add(1)
  );
}
