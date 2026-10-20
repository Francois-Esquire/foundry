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
  min,
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
  type GeologyGrid,
  geologyLevels,
  landformArchetypes,
  nominalDepth,
  sampleGrid,
} from "../../lib/visualization/geology";
import {
  defaultWorldTerrainSettings,
  type TerraceSettings,
} from "../../lib/visualization/world-terrain";
import type { SpyglassData } from "../data/types";
import { inks } from "../ladder/ink-ladder";
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
  contourInkNode,
  contourLineNode,
  createStepTexture,
  type StepSample,
  type StepTexture,
  sampleSteps,
} from "./contour-lines";
import {
  defaultLandSurfaceSettings,
  landPalette,
  landSurfaceNode,
  landTone,
} from "./geology-land";
import {
  defaultTerrainLightSettings,
  sunDirection,
  terrainLight,
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
   * fade them. 0: the land's levels read from its terraces and light
   * alone, with no line drawn on them.
   */
  contours: 0,
  /**
   * The deep seabed drawn as a chart draws it: past the depth where the
   * water hides the seabed, a faint hillshade of its relief laid over the
   * water's colour, so seamounts, canyons and escarpments still read in
   * the twilight. It shows as far as the optics hide the seabed, nothing
   * where the seabed is clear. `strength` is the most it lightens a slope
   * facing the sun or darkens one turned from it; `relief` multiplies the
   * slope first, the deep's relief being low beside its depth.
   */
  deep: { relief: 3, strength: 0.18 },
  /**
   * Map units of height per elevation unit. At 14 a terrace riser, at
   * least 3 map units wide and over a third of full land high, rises some
   * 5.3 map units, about 60° at its middle, so escarpments read as walls
   * in the tilted view; full land stands 14 units over its coast, the open
   * abyss 14 units under it, and a trench floor 17.5.
   */
  exaggeration: 14,
  /**
   * The land above the water: its tread tone, sand, escarpments, strata
   * and fine relief, cut per pixel.
   */
  land: defaultLandSurfaceSettings,
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
   * sun's horizon over map-unit distances, the seabed's mottling, and the
   * cells over which the seabed's slope is softened for its light.
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
    smoothing: 1,
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
   * Bathymetric contours: thin pale lines on every terraced level, each on
   * its plate's edge, the top of the riser, so every plate's outline is a
   * contour. Drawn over the water, so they read where the seabed fades,
   * yet fading with depth: full to `depth.from` nominal metres, down to
   * `depth.floor` of their strength by `depth.to`, and gone over the
   * depths of `abyss`, where the levels lie on the abyssal plain and would
   * only trace its roughness; the deep relief draws the deep instead.
   * They come in past `shore` metres, clear of the waterline's foam.
   * Majors, on the depth bands' boundaries, are wider and stronger. A
   * family fades where its lines crowd closer on screen than `spacing.to`
   * pixels and is gone at `spacing.from`, so steep escarpments and far
   * zooms never draw moiré. Their strengths are 0: the plates' own
   * steps carry the levels, with no line drawn over them.
   */
  seaContours: {
    abyss: { from: 1100, to: 1450 },
    colour: "#eef8f4",
    depth: { floor: 0.4, from: 100, to: 1000 },
    major: { strength: 0, width: 1.4 },
    minor: { strength: 0, width: 1 },
    shore: { from: 3, to: 7 },
    spacing: { from: 2.5, to: 7 },
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
   * Stepped bathymetry as cut paper: each tread drops over a riser, crisp
   * on screen. The lip's strength is 0, so no pale outline is drawn on a
   * tread's edge; the step reads from its light alone. The plate's parts are read
   * from the step coordinate (`contourStepField`), an integer on the
   * middle of each riser the terrace pass cuts, traced from the world
   * field and measured by distance, so its edges are smooth at any zoom
   * rather than tracing the grid. The riser spans the share of its span
   * the terrace pass gives it (`TerraceSettings.riser`), centred on the
   * integer; the lip is its top `lip.width` share, or `pixels` on screen,
   * whichever is wider, ending crisply on the tread's edge. The lip lifts
   * the seabed's light by `lip.strength` facing the sun and `lip.away`
   * less of that turned from it; the riser below it, turned from the sun,
   * loses `riser.away` of its light and, facing it, gains `riser.toward`,
   * on top of the shading the terrain light gives its slope. The baked
   * horizon casts the riser's shadow on the tread below. Edges fade where
   * a span is narrower on screen than `spacing` pixels, gone at `from`,
   * and where the terrace pass left the seabed unstepped. Plates come in
   * between the nominal depths of `depth`, full by the shelf, and grow by
   * `deep.gain` more between the depths of `deep`, so the escarpment's
   * steps still read through the water that fades them with the seabed; a
   * tread keeps its light at every depth. 0 turns an edge off. `reach` is
   * the map units within which the step coordinate seeks each line: a
   * tread broader than twice it is held level at its middle. The riser's
   * step in the water's depth is redrawn per pixel on the shelf, easing out
   * over the nominal depths of `redrawn`: below the platform's edge the
   * detail pass roughens the seabed after the terrace pass, so a staircase
   * redrawn there would invent treads the seabed does not have.
   */
  terraces: {
    deep: { from: 100, gain: 1, to: 500 },
    depth: { from: 5, to: 20 },
    lip: { away: 0.3, strength: 0, width: 0.4 },
    pixels: 1.5,
    reach: 32,
    redrawn: { from: 70, to: 110 },
    riser: { away: 0.6, toward: 0.2 },
    spacing: { from: 0.75, to: 2 },
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

/** What the albedo reads of one vertex. */
interface AlbedoSample {
  curvature: number;
  elevation: number;
  mottle: number;
  slope: number;
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
 * Each vertex's albedo in linear light: on land its tread's tone as
 * `landTone` gives it, which the material cuts into sand and escarpment,
 * under water the seabed as `seabedAlbedo` does, from the slope, the baked
 * curvature and the mottling.
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
  const sun = reliefSun(sunDirection);
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
      landTone(
        tone,
        pigment,
        {
          curvature: sample.curvature,
          elevation: sample.elevation,
          gradient: [
            relief.gradient[id * 2] ?? 0,
            relief.gradient[id * 2 + 1] ?? 0,
          ],
          sunBearing: sun.bearing,
        },
        ground,
        settings.land
      );
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

/**
 * The levels the plates and bathymetric contours are drawn at: every
 * bathymetric level and the shoreline, deepest first, as `contourLevels`
 * sorts them, so level `i` is the contour coordinate's integer `i` too.
 * `majors` are the indices of the band boundaries.
 */
export function seaLevels(): {
  elevations: number[];
  majors: number[];
  metres: number[];
} {
  const levels = contourLevels().filter(({ kind }) => kind !== "elevation");
  return {
    elevations: levels.map(({ elevation }) => elevation),
    majors: levels.flatMap(({ rank }, index) =>
      rank === "major" ? [index] : []
    ),
    metres: levels.map(({ metres }) => metres),
  };
}

/** Below this many units per pixel a field is flat, and no edge is drawn on it. */
const flatFootprint = 1e-6;

/** The sun's bearing over the chart, x right and y up, unit length. */
const sunBearing = (() => {
  const run = Math.hypot(sunDirection.x, sunDirection.y);
  return [sunDirection.x / run, sunDirection.y / run] as const;
})();

/** The terrace pass's riser and tread settings, which the plates' parts follow. */
export const terracePass = defaultWorldTerrainSettings.terrace;

/**
 * Half a riser's share of its span, as the terrace pass sizes it: its
 * width across the slope over the span's, held between its least and most
 * shares.
 */
function riserHalf(spacing: number, terrace: TerraceSettings): number {
  const most = Math.min(1, Math.max(0, terrace.riser.most));
  const least = Math.min(most, Math.max(0, terrace.riser.least));
  return (
    Math.min(
      most,
      Math.max(least, terrace.riser.width / Math.max(spacing, flatFootprint))
    ) / 2
  );
}

/**
 * How far the terrace pass stepped a span `spacing` map units across, 0 to
 * 1: none under half `minTread`, its full `strength` from `minTread`.
 */
function terraceWeight(spacing: number, terrace: TerraceSettings): number {
  return (
    Math.min(1, Math.max(0, terrace.strength)) *
    smooth(terrace.minTread / 2, terrace.minTread, spacing)
  );
}

/**
 * The seabed's light across a plate, 1 on its tread and on land: a pale lip
 * along the tread's edge, the top of the riser, then the riser below it,
 * darker turned from the sun and lighter facing it. `coordinate` is the
 * step coordinate, an integer on each riser's middle, `footprint` its
 * change across a screen pixel, `spacing` the map units across its span,
 * `downhill` the unit direction down it, world x right and y up, and
 * `depth` the nominal metres of water. The CPU twin of the material's
 * plate term, for tests and reference renders.
 */
export function plateShade(options: {
  coordinate: number;
  depth: number;
  downhill: readonly [number, number];
  footprint: number;
  settings?: GeologyPreviewSettings["terraces"];
  spacing: number;
  terrace?: TerraceSettings;
}): number {
  const {
    footprint,
    settings = defaultGeologyPreviewSettings.terraces,
    spacing,
    terrace = terracePass,
  } = options;
  const facing =
    options.downhill[0] * sunBearing[0] + options.downhill[1] * sunBearing[1];
  const half = Math.max(footprint, flatFootprint) / 2;
  const edge = (at: number, value: number) =>
    smooth(at - half, at + half, value);
  const offset = options.coordinate - Math.round(options.coordinate);
  const riser = riserHalf(spacing, terrace);
  const lipWidth = Math.min(
    2 * riser,
    Math.max(2 * riser * settings.lip.width, footprint * settings.pixels)
  );
  const top = 1 - edge(riser, offset);
  const lip = edge(riser - lipWidth, offset) * top;
  const face = edge(-riser, offset) * top - lip;
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
      (lip * lift + face * shade) *
        resolved *
        terraceWeight(spacing, terrace) *
        smooth(settings.depth.from, settings.depth.to, options.depth) *
        deepened
  );
}

/** `riserHalf` as a node. */
function riserHalfNode(
  spacing: Node<"float">,
  terrace: TerraceSettings
): Node<"float"> {
  const most = Math.min(1, Math.max(0, terrace.riser.most));
  const least = Math.min(most, Math.max(0, terrace.riser.least));
  return float(terrace.riser.width)
    .div(max(spacing, flatFootprint))
    .clamp(least, most)
    .mul(0.5);
}

/** `terraceWeight` as a node. */
function terraceWeightNode(
  spacing: Node<"float">,
  terrace: TerraceSettings
): Node<"float"> {
  return smoothstep(terrace.minTread / 2, terrace.minTread, spacing).mul(
    Math.min(1, Math.max(0, terrace.strength))
  );
}

/**
 * The seabed's light across a plate, as `plateShade` gives it on the CPU:
 * 1 on a tread, a pale lip on the tread's edge and a riser below, shaded
 * by its bearing to the sun. Read from the step coordinate: each riser is
 * centred on an integer of it, its top on the shallow side.
 */
export function plateLight(options: {
  depth: Node<"float">;
  settings: GeologyPreviewSettings["terraces"];
  steps: StepSample;
  terrace: TerraceSettings;
}): Node<"float"> {
  const { settings, steps, terrace } = options;
  const facing = steps.downhill.dot(vec2(sunBearing[0], sunBearing[1]));
  const footprint = fwidth(steps.coordinate);
  const half = max(footprint, flatFootprint).mul(0.5);
  const edge = (at: Node<"float">, value: Node<"float">) =>
    smoothstep(at.sub(half), at.add(half), value);
  const offset = steps.coordinate.sub(steps.coordinate.round());
  const riser = riserHalfNode(steps.spacing, terrace);
  const lipWidth = min(
    riser.mul(2),
    max(riser.mul(2 * settings.lip.width), footprint.mul(settings.pixels))
  );
  const top = edge(riser, offset).oneMinus();
  const lip = edge(riser.sub(lipWidth), offset).mul(top);
  const face = edge(riser.negate(), offset).mul(top).sub(lip);
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
        .add(face.mul(shade))
        .mul(resolved)
        .mul(terraceWeightNode(steps.spacing, terrace))
        .mul(shelfward)
        .mul(deepened)
    ),
    0
  );
}

/**
 * Nominal metres at a contour coordinate over the sea levels' `metres`:
 * each level's depth on its integer, linear between them, as depth is
 * linear in elevation within a span, and held beyond the end levels.
 */
export function coordinateDepth(
  coordinate: number,
  metres: readonly number[]
): number {
  let depth = metres[0] ?? 0;
  for (let index = 1; index < metres.length; index += 1) {
    depth +=
      Math.min(1, Math.max(0, coordinate - index + 1)) *
      ((metres[index] ?? 0) - (metres[index - 1] ?? 0));
  }
  return depth;
}

/** `coordinateDepth` as a node: one clamped span per pair of levels, summed. */
function coordinateDepthNode(
  coordinate: Node<"float">,
  metres: readonly number[]
): Node<"float"> {
  let depth: Node<"float"> = float(metres[0] ?? 0);
  for (let index = 1; index < metres.length; index += 1) {
    depth = depth.add(
      coordinate
        .sub(index - 1)
        .clamp(0, 1)
        .mul((metres[index] ?? 0) - (metres[index - 1] ?? 0))
    );
  }
  return depth;
}

/**
 * The terrace pass's staircase over the step coordinate, per pixel: each
 * riser centred on an integer, its share of the span as the pass sizes it,
 * drawn toward the staircase by the pass's weight, as `terraceStep` does.
 */
function steppedCoordinateNode(
  steps: StepSample,
  terrace: TerraceSettings
): Node<"float"> {
  const level = steps.coordinate.round();
  const half = riserHalfNode(steps.spacing, terrace);
  const stair = level
    .add(smoothstep(half.negate(), half, steps.coordinate.sub(level)))
    .sub(0.5);
  return mix(
    steps.coordinate,
    stair,
    terraceWeightNode(steps.spacing, terrace)
  );
}

/**
 * The bathymetric contour coordinate: an integer on each plate's edge, the
 * top of its riser, where the terrace pass stepped the seabed, easing to
 * the riser's middle, the level itself, where it did not.
 */
function seaContourCoordinate(
  steps: StepSample,
  terrace: TerraceSettings
): Node<"float"> {
  return steps.coordinate.sub(
    riserHalfNode(steps.spacing, terrace).mul(
      terraceWeightNode(steps.spacing, terrace)
    )
  );
}

/**
 * The bathymetric contours' ink, 0 to 1, before depth fades it: minors on
 * every level, majors wider and stronger on the band boundaries at
 * `majors`, the step coordinate's integers of the major levels.
 */
export function seaContourInk(
  steps: StepSample,
  majors: readonly number[],
  settings: GeologyPreviewSettings["seaContours"],
  terrace: TerraceSettings
): Node<"float"> {
  const coordinate = seaContourCoordinate(steps, terrace);
  const level = coordinate.round();
  let major: Node<"float"> = float(0);
  for (const index of majors) {
    major = max(major, step(level.sub(index).abs(), 0.5));
  }
  const line = (options: { strength: number; width: number }) =>
    contourLineNode(coordinate, {
      spacing: settings.spacing,
      strength: options.strength,
      width: options.width,
    });
  return mix(line(settings.minor), line(settings.major), major);
}

/**
 * The share of the bathymetric contours' strength that shows at `depth`
 * nominal metres, 0 to 1: full to `depth.from`, easing to `depth.floor` by
 * `depth.to`, and none in the waterline's water nor over the abyss.
 */
export function seaContourFade(
  depth: number,
  settings: GeologyPreviewSettings["seaContours"] = defaultGeologyPreviewSettings.seaContours
): number {
  const deep = smooth(settings.depth.from, settings.depth.to, depth);
  return (
    smooth(settings.shore.from, settings.shore.to, depth) *
    (1 + (settings.depth.floor - 1) * deep) *
    (1 - smooth(settings.abyss.from, settings.abyss.to, depth))
  );
}

/** `seaContourFade` as a node. */
export function seaContourFadeNode(
  depth: Node<"float">,
  settings: GeologyPreviewSettings["seaContours"]
): Node<"float"> {
  return smoothstep(settings.shore.from, settings.shore.to, depth)
    .mul(
      mix(
        float(1),
        float(settings.depth.floor),
        smoothstep(settings.depth.from, settings.depth.to, depth)
      )
    )
    .mul(smoothstep(settings.abyss.from, settings.abyss.to, depth).oneMinus());
}

/**
 * The deep relief's factor on the water's colour, around 1: the seabed's
 * slope, multiplied by `relief`, lit by the sun against a level seabed's
 * light, at most `strength` either way, shown as far as the water hides
 * the seabed:
 * `visibility` is the optics' share of the seabed that shows. `normal` is
 * the seabed's unit normal, world x right, y up and z up. The CPU twin of
 * the material's deep relief.
 */
export function deepRelief(options: {
  normal: readonly [number, number, number];
  settings?: GeologyPreviewSettings["deep"];
  visibility: number;
}): number {
  const { settings = defaultGeologyPreviewSettings.deep } = options;
  const [nx, ny, nz] = options.normal;
  const x = nx * settings.relief;
  const y = ny * settings.relief;
  const length = Math.hypot(x, y, nz) || 1;
  const lit =
    (x * sunDirection.x + y * sunDirection.y + nz * sunDirection.z) /
    (length * sunDirection.z);
  const hidden = 1 - Math.min(1, Math.max(0, options.visibility));
  const swing = Math.min(1, Math.max(-1, lit - 1));
  return 1 + settings.strength * swing * hidden;
}

/** `deepRelief` as a node, the hidden share already masked to the seabed it applies to. */
export function deepReliefNode(options: {
  hidden: Node<"float">;
  normal: Node<"vec3">;
  settings: GeologyPreviewSettings["deep"];
}): Node<"float"> {
  const { normal, settings } = options;
  const tilted = vec3(normal.xy.mul(settings.relief), normal.z).normalize();
  const lit = tilted
    .dot(vec3(sunDirection.x, sunDirection.y, sunDirection.z))
    .div(sunDirection.z);
  return float(1).add(
    lit.sub(1).clamp(-1, 1).mul(options.hidden).mul(settings.strength)
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

/** Map units inside the world grid over which the seabed blends to the open abyss. */
const openSeaBand = 64;

/**
 * 1 past the world grid, 0 well inside it. The lattice's outer ring
 * stretches the grid's last cells out to the sea's edge, so past column
 * 1's centre every vertex attribute is one cell drawn some 2,000 map units
 * long, and the plate contours clamp to their edge texels: the seabed's
 * relief there would streak outward. Past the grid the seabed reads as one
 * uniform abyss, blended in over `openSeaBand`.
 */
function openSeaNode(grid: GeologyGrid): Node<"float"> {
  const halfWidth = (grid.width * grid.cell) / 2;
  const halfHeight = (grid.height * grid.cell) / 2;
  const centreX = grid.left + halfWidth;
  // World y is map y turned over.
  const centreY = -(grid.top + halfHeight);
  const inside = min(
    float(halfWidth).sub(positionWorld.x.sub(centreX).abs()),
    float(halfHeight).sub(positionWorld.y.sub(centreY).abs())
  );
  const inset = 1.5 * grid.cell;
  return float(1).sub(smoothstep(inset, inset + openSeaBand, inside));
}

/** The open abyss's lit seabed, level and unoccluded, in linear light. */
function openSeabed(settings: GeologyPreviewSettings): Color {
  const tone = seabedAlbedo(
    new Color(),
    { curvature: 0, elevation: geologyLevels.abyss, mottle: 0, slope: 0 },
    seabedPalette(settings.seabed),
    settings.seabed
  );
  const [r, g, b] = terrainLight({
    normal: [0, 0, 1],
    relief: settings.light.relief.seabed,
    settings: settings.light,
    sky: 1,
    sun: 1,
  });
  return new Color(tone.r * r, tone.g * g, tone.b * b);
}

/**
 * The terrain's material: unlit, since it lights the seabed itself and the
 * water must not be shaded by the relief beneath it. The colour is built in
 * four stages, each a named node:
 *
 * 1. `seabed`: the albedo under the terrain light (key, sky, baked
 *    occlusion and sun visibility), stepped at each plate's edge under
 *    water. It is lit before the water sees it, so depth attenuates relief.
 *    On land the albedo, normal and sky are the land surface's, cut per
 *    pixel by `landSurfaceNode`, and the light takes land's fill.
 * 2. `depth`: the nominal metres of water over the seabed, the one place
 *    depth enters the optics, each riser's step redrawn per pixel from the
 *    step coordinate. The outer hull's emanation reshapes the optics'
 *    depth alone, so the open sea darkens with distance while plates and
 *    contours keep the seabed's own depth.
 * 3. `optics`: the seabed seen through its column of water.
 * 4. `inked`: the chart's conventions over the water: the deep relief's
 *    hillshade where the water hides the seabed, land contours faded as
 *    the land asks, and pale bathymetric contours on every plate's edge,
 *    faded with depth. The hull's rings are not drawn here; the wireframe
 *    layer shows them.
 *
 * Foam then edges the waterline, and an inspection's ramp replaces it all
 * while one is shown.
 */
function terrainMaterial(
  settings: GeologyPreviewSettings,
  emanationTexture: ReturnType<typeof createEmanationTexture>,
  stepTexture: StepTexture,
  levels: ReturnType<typeof seaLevels>
) {
  const elevation = attribute<"float">("elevation", "float");
  const albedo = attribute<"vec3">("albedo", "vec3");
  const occlusion = attribute<"vec2">("occlusion", "vec2");
  const contour = attribute<"vec3">("contour", "vec3");
  const inspection = attribute<"float">("inspection", "float");
  const inspecting = uniform(0);
  const underwater = float(1).sub(smoothstep(-0.001, 0, elevation));
  // Past the world grid the lattice's stretched cells would streak the
  // seabed outward, so the open abyss stands in for it there.
  const open = openSeaNode(stepTexture.grid);
  const steps = sampleSteps(stepTexture);
  // The vertices' depth steps across a riser along the lattice's coarse
  // triangles, which would print them on the water's colour; past the
  // shallows the riser's step is redrawn per pixel from the step
  // coordinate, the rest of the seabed's relief kept from the vertices.
  const vertexDepth = depthNode(elevation);
  const riserStep = coordinateDepthNode(
    steppedCoordinateNode(steps, terracePass),
    levels.metres
  )
    .sub(coordinateDepthNode(contour.x, levels.metres))
    .mul(
      smoothstep(
        settings.terraces.depth.from,
        settings.terraces.depth.to,
        vertexDepth
      )
    )
    .mul(
      smoothstep(
        settings.terraces.redrawn.from,
        settings.terraces.redrawn.to,
        vertexDepth
      ).oneMinus()
    );
  const depth = mix(
    max(vertexDepth.add(riserStep), 0)
      .mul(underwater)
      .add(underwater.mul(settings.shoreline.depth)),
    float(nominalDepth(geologyLevels.abyss) + settings.shoreline.depth),
    open
  );
  const plates = mix(
    float(1),
    plateLight({
      depth,
      settings: settings.terraces,
      steps,
      terrace: terracePass,
    }),
    underwater
  );
  const land = landSurfaceNode({
    albedo,
    elevation,
    exaggeration: settings.exaggeration,
    normal: normalLocal,
    settings: settings.land,
    sky: occlusion.x,
  });
  const light = terrainLightNode({
    fill: mix(
      float(settings.light.fill.land),
      float(settings.light.fill.seabed),
      underwater
    ),
    normal: mix(land.normal, normalLocal, underwater),
    relief: mix(
      float(settings.light.relief.land),
      float(settings.light.relief.seabed),
      underwater
    ),
    settings: settings.light,
    sky: mix(land.sky, occlusion.x, underwater),
    sun: occlusion.y,
  });
  const seabed = mix(
    mix(land.albedo, albedo, underwater).mul(light).mul(plates),
    color(openSeabed(settings)),
    open
  );
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
  // Past the depth the water hides the seabed at, its relief is drawn
  // over the water as a chart draws it.
  const relief = optics.colour.mul(
    deepReliefNode({
      hidden: optics.visibility.oneMinus().mul(underwater).mul(open.oneMinus()),
      normal: normalLocal,
      settings: settings.deep,
    })
  );
  // Land contours darken the land, faded as its surface asks.
  const landInk = contourInkNode({
    coordinate: contour.x,
    elevation,
    major: contour.y,
    visibility: contour.z,
  })
    .mul(land.contours)
    .mul(underwater.oneMinus())
    .mul(settings.contours);
  const landInked = mix(relief, relief.mul(color(inks.landContour)), landInk);
  // Bathymetric contours lie pale over the water on every plate's edge.
  const seaInk = seaContourInk(
    steps,
    levels.majors,
    settings.seaContours,
    terracePass
  )
    .mul(seaContourFadeNode(depth, settings.seaContours))
    .mul(underwater)
    .mul(open.oneMinus());
  const inked = mix(landInked, color(settings.seaContours.colour), seaInk);
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
      stepTexture.texture.dispose();
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
    islands: chart.islands,
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
  const levels = seaLevels();
  const terrain = terrainMaterial(
    settings,
    createEmanationTexture(chartHull(data, extent).field),
    createStepTexture(chart.world, levels.elevations, settings.terraces.reach),
    levels
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
