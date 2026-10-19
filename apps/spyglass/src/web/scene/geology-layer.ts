import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Group,
  Mesh,
  PlaneGeometry,
  Vector3,
} from "three";
import {
  attribute,
  cameraViewMatrix,
  color,
  float,
  fwidth,
  max,
  mix,
  normalLocal,
  positionWorld,
  smoothstep,
  step,
  uniform,
  vec2,
  vec3,
} from "three/tsl";
import {
  MeshBasicNodeMaterial,
  MeshStandardNodeMaterial,
  type Node,
} from "three/webgpu";
import {
  type ContourSettings,
  contourChannelLayout,
  contourChannels,
  contourLevels,
  defaultContourSettings,
} from "../../lib/visualization/contours";
import {
  depthBand,
  depthBands,
  elevationAtDepth,
  geologyLevels,
  landformArchetypes,
  nominalDepth,
  sampleGrid,
} from "../../lib/visualization/geology";
import type { SpyglassData } from "../data/types";
import { grounds, inks } from "../ladder/ink-ladder";
import { chartHull } from "../layout/chart-hull";
import { chartSeaStacks } from "../layout/chart-sea-stacks";
import { type ChartWorld, chartWorld } from "../layout/chart-world";
import { type GeologyLattice, geologyLattice } from "../layout/geology-lattice";
import { islandPigment } from "../layout/island-pigment";
import { isSceneLayerVisible } from "../settings/scene-composition";
import {
  isGeologyInspection,
  type TerrainInspection,
} from "../settings/terrain-inspection";
import {
  type ContourTexture,
  contourInkNode,
  createContourTexture,
  sampleContours,
} from "./contour-lines";
import {
  defaultTerrainLightSettings,
  sunDirection,
  terrainLightNode,
} from "./geology-light";
import {
  bakeRelief,
  type Relief,
  type ReliefSettings,
  reliefSun,
} from "./geology-relief";
import type { SceneLayer } from "./handle";
import { createEmanationTexture, oceanEmanationNode } from "./ocean-emanation";
import { createSeaStacksMesh } from "./sea-stacks-mesh";
import { inspectionRamp } from "./water-material";
import { waterOpticsNode } from "./water-optics";
import type { WeatherNodes } from "./weather";

/**
 * The geology preview: the world terrain as one displaced mesh, seabed and
 * land together, under one nearly invisible water surface. The mesh is
 * shaded as the water shows it: the seabed is lit, then seen through its
 * own column of water by the optics, so the water's colour is composited in
 * the terrain's material and the surface above it only catches the light.
 * Every tunable is here; the preview builds once per layout, the first
 * time it is shown.
 */
export const defaultGeologyPreviewSettings = {
  /**
   * Contour lines' peak darkening, 0 to 1, before the water and each band
   * fade them: light enough that lines over the pale shallows stay fine.
   */
  contours: 0.4,
  /**
   * Map units of height per elevation unit. At 14 a terrace riser, at
   * least 3 map units wide and over a third of full land high, rises some
   * 5.3 map units, about 60° at its middle, so escarpments read as walls
   * in the tilted view; full land stands 14 units over its coast, the open
   * abyss 14 units under it, and a trench floor 17.5.
   */
  exaggeration: 14,
  land: {
    /**
     * The pale sand ring at the waterline: elevation where it gives way to
     * pigment. The landforms' beach bench stands at 0.04, all sand; the
     * foot of the first escarpment fades from it.
     */
    beach: { colour: "#f4ead0", from: 0.05, to: 0.08 },
    /**
     * Land contours: nominal metres between levels and every how many is a
     * major. Fine enough that the gentle rise of each terrace's tread
     * carries a line or two once the camera comes in to an island; on a
     * riser the levels crowd and fade, so the escarpment draws itself.
     */
    contours: { interval: 25, majorEvery: 4 },
    /**
     * Escarpments a share of the way to bare earth, by slope in elevation
     * per map unit: from above the beach's own seaward face to a terrace
     * riser's middle, so treads keep their pigment and risers read as
     * rock. The light then shades them by the way they face.
     */
    escarpment: {
      /** A pale sandstone: the light darkens the faces turned from the sun. */
      colour: "#c09c72",
      share: 0.6,
      slope: { from: 0.05, to: 0.16 },
    },
    /**
     * Each island's pigment is washed toward the paper for the chart; on
     * the terrain it is deepened back away from it by `deepen`, so tops
     * read as chalky pastels, sage, butter, peach, lavender and mint,
     * rather than as cream.
     */
    pigment: { deepen: 0.6, paper: grounds.land },
    /** How much lighter the summit is than the shore, as a share of the pigment. */
    summitLift: 0.08,
  },
  lattice: {
    /** Coarse cells around any land within which the lattice is refined. */
    margin: 3,
    /** Fine quads along a coarse cell's side near land: a 1-unit lattice on a 4-unit grid. */
    refine: 4,
    /** Elevation units every vertex keeps from the water level. */
    waterGap: 0.003,
  },
  /** The terrain's light: key, sky, wrap and the relief multiplied for light. */
  light: defaultTerrainLightSettings,
  /**
   * The relief baked at build: cavity occlusion over map-unit radii, the
   * sun's horizon over map-unit distances, and the seabed's mottling.
   */
  relief: {
    cavity: { gain: 1.6, radii: [8, 16, 32], strength: 0.75 },
    mottle: { octaves: 3, seed: "seabed-mottle", wavelength: 140 },
    shadow: {
      distances: [2, 4, 8, 16, 32, 48],
      seabed: 2,
      softness: 0.25,
      strength: 0.7,
    },
  } satisfies ReliefSettings,
  /**
   * The seabed's albedo, linear blends of sRGB hex colours. Pale sand on
   * banks and aprons, darker sediment on deeper treads and in hollows, rock
   * on risers and crests, and a low mottling over all of it.
   */
  seabed: {
    /**
     * Sediment in hollows and at the foot of risers: curvature, in
     * elevation units the surroundings stand over a vertex, from which it
     * shows, and its most share.
     */
    basin: { curvature: { from: 0.004, to: 0.03 }, share: 0.45 },
    /**
     * Rock on crests and plate lips: negative curvature from which it
     * shows, and its most share.
     */
    crest: { curvature: { from: 0.004, to: 0.025 }, share: 0.35 },
    /**
     * How much the mottling moves the albedo: `light` is its brightness
     * swing either way, `sediment` the share of sediment it lays over sand.
     */
    mottle: { light: 0.14, sediment: 0.45 },
    /** Bare rock on risers, escarpments and crests. */
    rock: "#6b6458",
    /** Nominal metres over which rock may come in: none on the shoreline's sand. */
    rockBelow: { from: 3, to: 12 },
    /** The shallows' pale coral sand: the optics' own calibration seabed. */
    sand: "#f1ead8",
    /** Darker sediment on deeper treads and in basins. */
    sediment: "#a59a82",
    /** Nominal metres over which deeper treads turn from sand to sediment. */
    sedimentDepth: { from: 14, to: 160 },
    /** Slope, elevation per map unit, from which the seabed turns to rock. */
    steep: { from: 0.006, share: 0.75, to: 0.03 },
  },
  /**
   * The waterline. `depth` is the nominal metres of water the waterline is
   * read through: enough that the water's edge steps off the beach, little
   * enough that it starts as a pale, clear turquoise over the sand and
   * deepens to aqua offshore, a sand halo round each island. The foam is a
   * thin line where the water meets the beach, its width in screen pixels
   * and its strength 0 to 1; 0 draws none. It stays under the bloom's
   * threshold, so it never glows.
   */
  shoreline: {
    depth: 1.5,
    foam: { colour: "#f2f4ee", strength: 0.25, width: 1.5 },
  },
  /**
   * A nearly invisible glossy surface over the water, catching the sun. Its
   * colour is the deep water's navy, so the veil it lays over the sea does
   * not lift red and green alike and turn deep water violet.
   */
  surface: {
    colour: "#0d2c45",
    /** How much of the weather's wave normal the surface takes. */
    motion: 0.45,
    opacity: 0.06,
    roughness: 0.25,
  },
  /**
   * Stepped bathymetry as cut paper: each tread ends in a pale lip and
   * drops over a riser, both crisp on screen. The terrace pass puts a
   * tread on each half-integer of the contour coordinate and spends the
   * rest of the span on risers, so the plate's parts are read from the
   * coordinate, filtered from the world field so its edges follow the
   * seabed rather than the mesh's triangles. Near a half-integer is the
   * tread, giving way between the offsets of `tread`: a tread is only
   * nearly level, so a hard edge there would trace the grid. Just below
   * it is the lip, `lip.width` of a span down the riser or `pixels` on
   * screen, whichever is wider, ending crisply; past the lip, and above
   * the tread out to `riser.foot` of a span, the riser. The lip lifts the
   * seabed's light by `lip.strength` facing the sun and `lip.away` less
   * of that turned from it; a riser turned from the sun loses
   * `riser.away` of its light and one facing it gains `riser.toward`, on
   * top of the shading the terrain light gives its slope. The baked
   * horizon casts the riser's shadow on the tread below. Edges fade where
   * a span is narrower on screen than `spacing` pixels, gone at `from`.
   * Plates come in between the nominal depths of `depth`, full by the
   * shelf, and grow by `deep.gain` more between the depths of `deep`, so
   * the escarpment's steps still read through the water that fades them
   * with the seabed; a tread keeps its light at every depth. 0 turns an
   * edge off.
   */
  terraces: {
    deep: { from: 100, gain: 1, to: 500 },
    depth: { from: 5, to: 20 },
    lip: { away: 0.3, strength: 0.6, width: 0.08 },
    pixels: 1.5,
    riser: { away: 0.6, foot: 0.3, toward: 0.2 },
    spacing: { from: 0.75, to: 2 },
    tread: { from: 0.01, to: 0.06 },
  },
};
export type GeologyPreviewSettings = typeof defaultGeologyPreviewSettings;

/**
 * The knots of `nominalDepth`: the depth bands' boundaries and the deepest
 * a feature carves. Between them depth is linear in elevation, so the
 * material reads nominal depth from its elevation as the chart does.
 */
export function depthKnots(): { depth: number; elevation: number }[] {
  const depths = [
    ...depthBands.map(({ from }) => from),
    nominalDepth(geologyLevels.trenchFloor),
  ];
  return depths.map((depth) => ({ depth, elevation: elevationAtDepth(depth) }));
}

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

function smooth(from: number, to: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

/** The seabed's palette in linear light, from its settings' hex. */
function seabedPalette(seabed: GeologyPreviewSettings["seabed"]) {
  return {
    rock: new Color(seabed.rock),
    sand: new Color(seabed.sand),
    sediment: new Color(seabed.sediment),
  };
}

/** The land's palette in linear light, from its settings' hex. */
function landPalette(land: GeologyPreviewSettings["land"]) {
  return {
    beach: new Color(land.beach.colour),
    earth: new Color(land.escarpment.colour),
    paper: new Color(land.pigment.paper),
  };
}

/** What the albedo reads of one vertex. */
interface AlbedoSample {
  curvature: number;
  elevation: number;
  mottle: number;
  slope: number;
}

/**
 * One land vertex's albedo into `tone`: its island's pigment deepened to a
 * pastel, a little lighter toward the summit, a sand ring over the beach
 * bench at the waterline, and escarpments toward bare earth, the foot of
 * the first one rising out of the sand.
 */
function landAlbedo(
  tone: Color,
  pigment: Color,
  sample: AlbedoSample,
  palette: ReturnType<typeof landPalette>,
  land: GeologyPreviewSettings["land"]
): Color {
  tone.copy(pigment).lerp(palette.paper, -land.pigment.deepen);
  tone.setRGB(
    Math.min(1, Math.max(0, tone.r)),
    Math.min(1, Math.max(0, tone.g)),
    Math.min(1, Math.max(0, tone.b))
  );
  return tone
    .multiplyScalar(1 + land.summitLift * sample.elevation)
    .lerp(
      palette.beach,
      1 - smooth(land.beach.from, land.beach.to, sample.elevation)
    )
    .lerp(
      palette.earth,
      land.escarpment.share *
        smooth(
          land.escarpment.slope.from,
          land.escarpment.slope.to,
          sample.slope
        )
    );
}

/**
 * One seabed vertex's albedo into `tone`: pale sand on banks and aprons,
 * sediment on deeper treads, in hollows and where the mottling lays it,
 * rock on risers and crests once the water is deep enough, and the
 * mottling's swing of brightness over all of it.
 */
function seabedAlbedo(
  tone: Color,
  sample: AlbedoSample,
  palette: ReturnType<typeof seabedPalette>,
  seabed: GeologyPreviewSettings["seabed"]
): Color {
  const depth = nominalDepth(sample.elevation);
  const sediment = Math.min(
    1,
    smooth(seabed.sedimentDepth.from, seabed.sedimentDepth.to, depth) +
      seabed.basin.share *
        smooth(
          seabed.basin.curvature.from,
          seabed.basin.curvature.to,
          sample.curvature
        ) +
      seabed.mottle.sediment * Math.max(0, sample.mottle)
  );
  const rock = Math.min(
    1,
    seabed.steep.share *
      smooth(seabed.steep.from, seabed.steep.to, sample.slope) +
      seabed.crest.share *
        smooth(
          seabed.crest.curvature.from,
          seabed.crest.curvature.to,
          -sample.curvature
        )
  );
  return tone
    .copy(palette.sand)
    .lerp(palette.sediment, sediment)
    .lerp(
      palette.rock,
      rock * smooth(seabed.rockBelow.from, seabed.rockBelow.to, depth)
    )
    .multiplyScalar(1 + seabed.mottle.light * sample.mottle);
}

/**
 * Each vertex's albedo in linear light: on land its island's pigment as
 * `landAlbedo` shades it, under water the seabed as `seabedAlbedo` does,
 * from the slope, the baked curvature and the mottling.
 */
function albedos(
  lattice: GeologyLattice,
  relief: Pick<Relief, "curvature" | "gradient" | "mottle">,
  data: Pick<SpyglassData, "territories">,
  settings: GeologyPreviewSettings
): Float32Array {
  const pigments = lattice.islandIds.map((id) => {
    const territory = data.territories.find((each) => each.id === id);
    return new Color(islandPigment(territory ?? { id }));
  });
  const ground = landPalette(settings.land);
  const sea = seabedPalette(settings.seabed);
  const tone = new Color();
  const values = new Float32Array(lattice.count * 3);
  for (let id = 0; id < lattice.count; id += 1) {
    const sample: AlbedoSample = {
      curvature: relief.curvature[id] ?? 0,
      elevation: lattice.elevation[id] ?? 0,
      mottle: relief.mottle[id] ?? 0,
      slope: Math.hypot(
        relief.gradient[id * 2] ?? 0,
        relief.gradient[id * 2 + 1] ?? 0
      ),
    };
    const pigment = pigments[lattice.owner[id] ?? -1];
    if (sample.elevation > 0 && pigment) {
      landAlbedo(tone, pigment, sample, ground, settings.land);
    } else {
      seabedAlbedo(tone, sample, sea, settings.seabed);
    }
    values.set([tone.r, tone.g, tone.b], id * 3);
  }
  return values;
}

/**
 * Each vertex's contour channels, as `contourChannels` bakes a texture's:
 * the vertices read as a one-row field, and the mesh interpolates the
 * channels as a texture's filter would, so the lines follow the refined
 * land rather than the coarser grid.
 */
function contourAttribute(
  lattice: GeologyLattice,
  land: ContourSettings["land"]
): Float32Array {
  const stride = contourChannelLayout.length;
  const channels = contourChannels(
    {
      cell: 1,
      elevation: lattice.elevation,
      height: 1,
      left: 0,
      top: 0,
      width: lattice.count,
    },
    contourLevels({ ...defaultContourSettings, land })
  );
  const values = new Float32Array(lattice.count * 3);
  for (let id = 0; id < lattice.count; id += 1) {
    values.set(channels.subarray(id * stride, id * stride + 3), id * 3);
  }
  return values;
}

/**
 * The lattice in world space: x right, y up the chart, z the exaggerated
 * elevation, normals from the baked gradient, and the baked albedo and
 * occlusion the material lights.
 */
function terrainGeometry(
  lattice: GeologyLattice,
  baked: {
    albedo: Float32Array;
    contour: Float32Array;
    gradient: Float32Array;
    occlusion: Float32Array;
  },
  exaggeration: number
): BufferGeometry {
  const positions = new Float32Array(lattice.count * 3);
  const normals = new Float32Array(lattice.count * 3);
  const normal = new Vector3();
  for (let id = 0; id < lattice.count; id += 1) {
    const elevation = lattice.elevation[id] ?? 0;
    positions.set(
      [
        lattice.points[id * 2] ?? 0,
        -(lattice.points[id * 2 + 1] ?? 0),
        elevation * exaggeration,
      ],
      id * 3
    );
    // World y is map y turned over, so the y slope changes sign.
    normal
      .set(
        -exaggeration * (baked.gradient[id * 2] ?? 0),
        exaggeration * (baked.gradient[id * 2 + 1] ?? 0),
        1
      )
      .normalize();
    normals.set([normal.x, normal.y, normal.z], id * 3);
  }
  const geometry = new BufferGeometry();
  geometry.setIndex(new BufferAttribute(lattice.index, 1));
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new BufferAttribute(normals, 3));
  geometry.setAttribute("elevation", new BufferAttribute(lattice.elevation, 1));
  geometry.setAttribute("albedo", new BufferAttribute(baked.albedo, 3));
  geometry.setAttribute("occlusion", new BufferAttribute(baked.occlusion, 2));
  geometry.setAttribute("contour", new BufferAttribute(baked.contour, 3));
  geometry.setAttribute(
    "inspection",
    new BufferAttribute(new Float32Array(lattice.count), 1)
  );
  geometry.computeBoundingSphere();
  return geometry;
}

/** Below this many units per pixel a field is flat, and no edge is drawn on it. */
const flatFootprint = 1e-6;

/** The sun's bearing over the chart, x right and y up, unit length. */
const sunBearing = (() => {
  const run = Math.hypot(sunDirection.x, sunDirection.y);
  return [sunDirection.x / run, sunDirection.y / run] as const;
})();

/**
 * How far a unit normal tilts from the vertical, as its horizontal length,
 * before its bearing counts: a tread's faint tilt has no side to the sun,
 * a riser's has.
 */
const facingTilt = { from: 0.01, to: 0.04 };

/**
 * The seabed's light across a plate, 1 on its tread and on land: a pale lip
 * where the tread ends, then the riser below it, darker turned from the
 * sun and lighter facing it. `coordinate` is the contour coordinate,
 * `footprint` its change across a screen pixel, `normal` the geometric
 * normal, world x right and y up, and `depth` the nominal metres of water.
 * The CPU twin of the material's plate term, for tests and reference
 * renders.
 */
export function plateShade(options: {
  coordinate: number;
  depth: number;
  footprint: number;
  normal: readonly [number, number, number];
  settings?: GeologyPreviewSettings["terraces"];
}): number {
  const { footprint, settings = defaultGeologyPreviewSettings.terraces } =
    options;
  const [nx, ny, nz] = options.normal;
  const length = Math.hypot(nx, ny, nz) || 1;
  const tilt = Math.hypot(nx, ny) / length;
  const facing =
    tilt > flatFootprint
      ? ((nx * sunBearing[0] + ny * sunBearing[1]) / (length * tilt)) *
        smooth(facingTilt.from, facingTilt.to, tilt)
      : 0;
  const half = Math.max(footprint, flatFootprint) / 2;
  const offset = options.coordinate - Math.floor(options.coordinate) - 0.5;
  const below = Math.max(0, -offset);
  const above = Math.max(0, offset);
  const lipEdge =
    settings.tread.to +
    Math.max(settings.lip.width, footprint * settings.pixels);
  const pastLip = smooth(lipEdge - half, lipEdge + half, below);
  const lip =
    smooth(settings.tread.from, settings.tread.to, below) * (1 - pastLip);
  const riser = Math.max(
    pastLip,
    smooth(settings.tread.from, settings.riser.foot, above)
  );
  const lift =
    settings.lip.strength * (1 - settings.lip.away * Math.max(0, -facing));
  const shade =
    settings.riser.toward * Math.max(0, facing) -
    settings.riser.away * Math.max(0, -facing);
  const resolved =
    footprint >= flatFootprint
      ? smooth(settings.spacing.from, settings.spacing.to, 1 / footprint)
      : 0;
  const deepened =
    1 +
    settings.deep.gain *
      smooth(settings.deep.from, settings.deep.to, options.depth);
  return Math.max(
    0,
    1 +
      (lip * lift + riser * shade) *
        resolved *
        smooth(settings.depth.from, settings.depth.to, options.depth) *
        deepened
  );
}

/**
 * The seabed's light across a plate, as `plateShade` gives it on the CPU:
 * 1 on a tread, a pale lip where it ends and a riser below, shaded by its
 * bearing to the sun. Read from the contour coordinate: each tread sits on
 * a half-integer of it, its lip just below and the risers either side.
 */
function plateLight(options: {
  coordinate: Node<"float">;
  depth: Node<"float">;
  normal: Node<"vec3">;
  settings: GeologyPreviewSettings["terraces"];
}): Node<"float"> {
  const { coordinate, settings } = options;
  const normal = options.normal.normalize();
  const tilt = normal.xy.length();
  const facing = normal.xy
    .div(max(tilt, flatFootprint))
    .dot(vec2(sunBearing[0], sunBearing[1]))
    .mul(smoothstep(facingTilt.from, facingTilt.to, tilt));
  const footprint = fwidth(coordinate);
  const half = max(footprint, flatFootprint).mul(0.5);
  const offset = coordinate.fract().sub(0.5);
  const below = max(offset.negate(), 0);
  const above = max(offset, 0);
  const lipEdge = max(
    float(settings.lip.width),
    footprint.mul(settings.pixels)
  ).add(settings.tread.to);
  const pastLip = smoothstep(lipEdge.sub(half), lipEdge.add(half), below);
  const treadEdge = (value: Node<"float">) =>
    smoothstep(settings.tread.from, settings.tread.to, value);
  const lip = treadEdge(below).mul(pastLip.oneMinus());
  const riser = max(
    pastLip,
    smoothstep(settings.tread.from, settings.riser.foot, above)
  );
  const lift = float(1)
    .sub(max(facing.negate(), 0).mul(settings.lip.away))
    .mul(settings.lip.strength);
  const shade = max(facing, 0)
    .mul(settings.riser.toward)
    .sub(max(facing.negate(), 0).mul(settings.riser.away));
  const resolved = smoothstep(
    settings.spacing.from,
    settings.spacing.to,
    float(1).div(max(footprint, flatFootprint))
  ).mul(step(flatFootprint, footprint));
  const shelfward = smoothstep(
    settings.depth.from,
    settings.depth.to,
    options.depth
  );
  const deepened = smoothstep(
    settings.deep.from,
    settings.deep.to,
    options.depth
  )
    .mul(settings.deep.gain)
    .add(1);
  return max(
    float(1).add(
      lip
        .mul(lift)
        .add(riser.mul(shade))
        .mul(resolved)
        .mul(shelfward)
        .mul(deepened)
    ),
    0
  );
}

/** A thin line along the waterline, 0 to 1, `width` screen pixels into the water. */
function foamLine(
  elevation: Node<"float">,
  settings: GeologyPreviewSettings["shoreline"]["foam"]
): Node<"float"> {
  const pixels = elevation.negate().div(max(fwidth(elevation), flatFootprint));
  return float(1)
    .sub(smoothstep(settings.width - 0.5, settings.width + 0.5, pixels))
    .mul(settings.strength);
}

/**
 * The terrain's material: unlit, since it lights the seabed itself and the
 * water must not be shaded by the relief beneath it. The colour is built in
 * four stages, each a named node:
 *
 * 1. `seabed`: the albedo under the terrain light (key, sky, baked
 *    occlusion and sun visibility), stepped at each plate's edge under
 *    water. It is lit before the water sees it, so depth attenuates relief.
 * 2. `depth`: the nominal metres of water over the seabed, the one place
 *    depth enters the optics. The outer hull's emanation reshapes the
 *    optics' depth alone, so the open sea darkens with distance while
 *    plates and contours keep the seabed's own depth.
 * 3. `optics`: the seabed seen through its column of water.
 * 4. `inked`: line inks over the water, contours faded as the seabed is.
 *    The hull's rings are not drawn here; the wireframe layer shows them.
 *
 * Foam then edges the waterline, and an inspection's ramp replaces it all
 * while one is shown.
 */
function terrainMaterial(
  settings: GeologyPreviewSettings,
  emanationTexture: ReturnType<typeof createEmanationTexture>,
  plateContours: ContourTexture
) {
  const elevation = attribute<"float">("elevation", "float");
  const albedo = attribute<"vec3">("albedo", "vec3");
  const occlusion = attribute<"vec2">("occlusion", "vec2");
  const contour = attribute<"vec3">("contour", "vec3");
  const inspection = attribute<"float">("inspection", "float");
  const inspecting = uniform(0);
  const underwater = float(1).sub(smoothstep(-0.001, 0, elevation));
  const depth = depthNode(elevation).add(
    underwater.mul(settings.shoreline.depth)
  );
  const plates = mix(
    float(1),
    plateLight({
      coordinate: sampleContours(plateContours).coordinate,
      depth,
      normal: normalLocal,
      settings: settings.terraces,
    }),
    underwater
  );
  const light = terrainLightNode({
    normal: normalLocal,
    relief: mix(
      float(settings.light.relief.land),
      float(settings.light.relief.seabed),
      underwater
    ),
    settings: settings.light,
    sky: occlusion.x,
    sun: occlusion.y,
  });
  const seabed = albedo.mul(light).mul(plates);
  // The open sea reads lighter round the islands and darker toward the
  // sea's edge; the change reaches only the water's colour, never the
  // plates or contours.
  const emanation = oceanEmanationNode({
    extent: emanationTexture.extent,
    texture: emanationTexture.texture,
  });
  const optics = waterOpticsNode({
    depth: mix(depth, emanation.waterDepth(depth), underwater),
    seabedColour: seabed,
  });
  const ink = contourInkNode({
    coordinate: contour.x,
    elevation,
    major: contour.y,
    visibility: contour.z,
  })
    .mul(optics.visibility)
    .mul(settings.contours);
  const inkColour = mix(
    color(inks.landContour),
    color(inks.seaContour),
    underwater
  );
  const inked = mix(optics.colour, optics.colour.mul(inkColour), ink);
  const water = mix(
    inked,
    color(settings.shoreline.foam.colour),
    foamLine(elevation, settings.shoreline.foam).mul(underwater)
  );
  const ramp = mix(
    mix(
      color(inspectionRamp.low),
      color(inspectionRamp.middle),
      inspection.mul(2).clamp(0, 1)
    ),
    color(inspectionRamp.high),
    inspection.mul(2).sub(1).clamp(0, 1)
  );
  const material = new MeshBasicNodeMaterial();
  material.colorNode = mix(water, ramp, inspecting);
  return {
    dispose() {
      material.dispose();
      optics.dispose();
      emanation.dispose();
      emanationTexture.texture.dispose();
      plateContours.texture.dispose();
      inspecting.dispose();
    },
    inspecting,
    material,
  };
}

/** The water's surface: a glossy sheet at the water level, nearly transparent, moving with the weather's waves. */
function surfaceSheet(
  extent: { height: number; width: number },
  weather: Pick<WeatherNodes, "surfaceNormal">,
  settings: GeologyPreviewSettings["surface"]
) {
  const material = new MeshStandardNodeMaterial({
    color: new Color(settings.colour),
    depthWrite: false,
    metalness: 0,
    opacity: settings.opacity,
    roughness: settings.roughness,
    transparent: true,
  });
  material.normalNode = mix(
    vec3(0, 0, 1),
    weather.surfaceNormal(positionWorld.xy),
    settings.motion
  )
    .normalize()
    .transformDirection(cameraViewMatrix);
  const geometry = new PlaneGeometry(extent.width, extent.height);
  return {
    dispose() {
      geometry.dispose();
      material.dispose();
    },
    mesh: new Mesh(geometry, material),
  };
}

/** Feature influence by world cell, 0 to 1: how far the seabed's features move it. */
function seafloorInfluence(chart: ChartWorld): Float32Array {
  const { world } = chart;
  const sum = new Float32Array(world.width * world.height);
  for (const feature of chart.seafloor.contributions) {
    for (let r = 0; r < feature.height; r += 1) {
      for (let c = 0; c < feature.width; c += 1) {
        const row = feature.row + r;
        const column = feature.column + c;
        if (
          row >= 0 &&
          column >= 0 &&
          row < world.height &&
          column < world.width
        ) {
          const at = row * world.width + column;
          sum[at] =
            (sum[at] ?? 0) +
            Math.abs(feature.values[r * feature.width + c] ?? 0);
        }
      }
    }
  }
  // A quarter of the elevation range reads as near full influence.
  return Float32Array.from(sum, (value) => 1 - Math.exp(-value / 0.25));
}

const bandOrder = depthBands.map(({ id }) => id);

/** One vertex's inspected value, 0 to 1, for a geology inspection; 0 for any other. */
function inspected(
  inspection: TerrainInspection,
  chart: ChartWorld,
  lattice: GeologyLattice,
  influence: () => Float32Array,
  id: number
): number {
  const elevation = lattice.elevation[id] ?? 0;
  switch (inspection) {
    case "world-elevation":
      return (
        (elevation - geologyLevels.trenchFloor) /
        (geologyLevels.land - geologyLevels.trenchFloor)
      );
    case "depth-band":
      // Land is light; each band darker to the trench at 0.
      return elevation >= 0
        ? 1
        : 1 -
            (bandOrder.indexOf(depthBand(nominalDepth(elevation))) + 1) /
              bandOrder.length;
    case "landform": {
      const island = lattice.islandIds[lattice.owner[id] ?? -1];
      const archetype = island
        ? chart.landforms.get(island)?.archetype
        : undefined;
      // Each formation its own grey, distinct from the sea's dark.
      return archetype
        ? 0.25 +
            (0.75 * landformArchetypes.indexOf(archetype)) /
              (landformArchetypes.length - 1)
        : 0;
    }
    case "seafloor":
      return sampleGrid(
        chart.world,
        influence(),
        lattice.points[id * 2] ?? 0,
        lattice.points[id * 2 + 1] ?? 0
      );
    default:
      return 0;
  }
}

/**
 * The preview built from the chart's layout: the world terrain, its
 * lattice, the terrain mesh, the sea stacks standing on it and the water's
 * surface, in one group. `extent`
 * is the sea's, which the lattice's outer ring and the surface reach to.
 */
export function buildGeologyPreview(options: {
  data: SpyglassData;
  extent: { height: number; width: number };
  settings?: GeologyPreviewSettings;
  weather: Pick<WeatherNodes, "surfaceNormal">;
}) {
  const {
    data,
    extent,
    settings = defaultGeologyPreviewSettings,
    weather,
  } = options;
  const chart = chartWorld(data);
  const lattice = geologyLattice({
    extent,
    islands: data.territories,
    landform: chart.landform,
    settings: settings.lattice,
    world: chart.world,
  });
  const seaStacks = chartSeaStacks(data, data.ownDependencies ?? []);
  const relief = bakeRelief({
    exaggeration: settings.exaggeration,
    lattice,
    seabedRelief: settings.light.relief.seabed,
    settings: settings.relief,
    stamps: seaStacks,
    sun: reliefSun(sunDirection),
    world: chart.world,
  });
  const geometry = terrainGeometry(
    lattice,
    {
      albedo: albedos(lattice, relief, data, settings),
      contour: contourAttribute(lattice, settings.land.contours),
      gradient: relief.gradient,
      occlusion: relief.occlusion,
    },
    settings.exaggeration
  );
  const terrain = terrainMaterial(
    settings,
    createEmanationTexture(chartHull(data, extent).field),
    createContourTexture(chart.world)
  );
  const surface = surfaceSheet(extent, weather, settings.surface);
  const group = new Group();
  const stacks = createSeaStacksMesh(seaStacks, {
    exaggeration: settings.exaggeration,
    light: settings.light,
    sample: (x, y) => chart.world.sample(x, y),
  });
  group.add(new Mesh(geometry, terrain.material), stacks.mesh, surface.mesh);
  let influence: Float32Array | undefined;
  let shown: TerrainInspection = "";
  return {
    chart,
    dispose() {
      geometry.dispose();
      terrain.dispose();
      stacks.dispose();
      surface.dispose();
    },
    geometry,
    group,
    /** Shows a geology inspection in place of the water, or the water for any other. */
    inspect(inspection: TerrainInspection) {
      const next = isGeologyInspection(inspection) ? inspection : "";
      if (next === shown) {
        return;
      }
      shown = next;
      terrain.inspecting.value = next ? 1 : 0;
      if (!next) {
        return;
      }
      const values = geometry.getAttribute("inspection");
      const lazyInfluence = () => {
        influence ??= seafloorInfluence(chart);
        return influence;
      };
      for (let id = 0; id < lattice.count; id += 1) {
        values.setX(id, inspected(next, chart, lattice, lazyInfluence, id));
      }
      values.needsUpdate = true;
    },
    lattice,
    material: terrain.material,
    stacks: stacks.mesh,
    surface: surface.mesh,
  };
}

export type GeologyPreview = ReturnType<typeof buildGeologyPreview>;

/**
 * The geology preview as a scene layer, hidden by default. Its group is
 * empty until the composition first shows it; then the preview is built,
 * once, and kept until the scene is disposed.
 */
export function createGeologyLayer(
  options: Omit<Parameters<typeof buildGeologyPreview>[0], "settings"> & {
    settings?: GeologyPreviewSettings;
  }
): SceneLayer & { preview: () => GeologyPreview } {
  const group = new Group();
  let built: GeologyPreview | undefined;
  const preview = () => {
    if (!built) {
      built = buildGeologyPreview(options);
      group.add(built.group);
    }
    return built;
  };
  return {
    dispose() {
      built?.dispose();
    },
    group,
    id: "geology",
    kind: "layer",
    preview,
    stats: (): Record<string, number> =>
      built
        ? {
            triangles: built.lattice.index.length / 3,
            vertices: built.lattice.count,
          }
        : {},
    update(_view, state) {
      if (!isSceneLayerVisible(state.settings.composition, "geology")) {
        return;
      }
      preview().inspect(state.settings.terrainInspection);
    },
  };
}
