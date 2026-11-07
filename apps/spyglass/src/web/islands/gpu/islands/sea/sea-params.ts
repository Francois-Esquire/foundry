/**
 * The sea's parameters: everything below sea level and everything the water
 * does at the shore, as one unit, by layer. The map-side layers (bathymetry, floor, flow) are baked into the
 * maps and rebuild through `MAP_OF_SEA_MAP_PARAM`; the frame-side ones (surface,
 * shore) are uniforms of the frame. Plain data, no GPU: `params.ts` and
 * `map-params.ts` import this file, so it must stay free of `vgpu` and
 * `.wgsl` imports.
 */
import type { MapPassName } from "../maps/map-params";
import { clamp01 } from "../maps/uniforms";

/** A linear colour, 0–1 a channel. */
export type Rgb = readonly [number, number, number];

/** A `#rrggbb` sRGB colour as linear 0–1 channels. */
export function hexToLinear(hex: string): Rgb {
  const channel = (at: number) => {
    const c = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
    return c <= 0.040_45 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return [channel(1), channel(3), channel(5)];
}

/** A linear 0–1 channel as an sRGB byte. */
function toSrgbByte(linear: number): number {
  const c = Math.min(1, Math.max(0, linear));
  const encoded = c <= 0.003_130_8 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

/** A linear colour as the `#rrggbb` a colour picker shows. */
export function linearToHex(rgb: readonly [number, number, number]): string {
  return `#${rgb.map((c) => toSrgbByte(c).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The sea's parameters baked into the maps. The bathymetry, in chart units:
 * on it each group a bank, every bank flat at one of the levels, the bottom
 * level `bankStep` above the platform and each rise above `bankTaper` times
 * the one below, the highest at `bankTop`. Each island's stack runs from its
 * top silhouette (its coast's hull, `bankHull`) out to its bottom (the
 * platform's outline, about `bankSpread` out), one ring of each of its
 * banks, every tread at least `bankRun`. The platform lies under the whole
 * archipelago at the foot of the stacks, `bankMargin` past them, its edge
 * falling over a scarp and a slope, in `bankDeepRings` rings, to the deep
 * `bankDeep` below it. The depths follow from the level count
 * (`seaDepthsOf`).
 */
export interface SeaMapParams {
  /** floor and surface: the sea's colour where the floor lies about as deep as the deep floor. */
  bandDeep: Rgb;
  /** floor and surface: the sea's colour over the top levels. */
  bandShallows: Rgb;
  /** floor and surface: the sea's colour over the lower levels and the platform. */
  bandShelf: Rgb;
  /** floor and surface: the sea's colour at the waterline. */
  bandShore: Rgb;
  /** floor and surface: the sea's colour down the slope past the platform. */
  bandSlope: Rgb;
  /** floor and surface: the sea's colour past the deep floor. */
  bandTrench: Rgb;
  /** bathymetry: how far a sand beach slopes from the top silhouette to the floor, chart units. */
  bankBeach: number;
  /** bathymetry: how far a bottom silhouette may run past its top, in platform reaches. */
  bankBottomReach: number;
  /**
   * bathymetry: how close two members' rings for a bank must come for the
   * bank to run across between them as one plate.
   */
  bankBridge: number;
  /** bathymetry: the drop from the platform to the deep floor, chart units. */
  bankDeep: number;
  /**
   * bathymetry: the rings the slope descends in, from the escarpment's foot
   * to the deep floor; 0 for a smooth slope.
   */
  bankDeepRings: number;
  /**
   * bathymetry: the top silhouette's smoothing, as a share of each island's
   * size (chart `Island.size`): its coast's bays fill and its pieces join
   * into one smooth hull. 0 for the coast itself.
   */
  bankHull: number;
  /**
   * bathymetry: the share a step's rise grows by between broad rings, 0–1;
   * less toward the top level, which stays at `bankTop`.
   */
  bankLift: number;
  /**
   * bathymetry: the tread, chart units, that takes all of `bankLift`;
   * narrower ones take less, crowded rings next to none.
   */
  bankLiftTread: number;
  /** bathymetry: how far the platform runs past the islands' stacks, a thin margin. */
  bankMargin: number;
  /**
   * bathymetry: the scale over which the islands' coasts merge into the
   * platform's one outline (a log-sum-exp union): two islands join where
   * the gap between them is under about twice `bankMargin` plus 1.4 times
   * this.
   */
  bankMerge: number;
  /**
   * bathymetry: the moat an island cuts in the plates of banks it is not
   * in, as a share of its size (chart `Island.size`), from its coast.
   */
  bankMoat: number;
  /** bathymetry: how much of a plate the moat cuts, 0 (none) to 1 (down to what lies beneath). */
  bankMoatAmount: number;
  /**
   * bathymetry: how ragged the platform's outline is, lobes and notches,
   * and so every bottom silhouette; 0 for none.
   */
  bankRagged: number;
  /**
   * bathymetry: the narrowest tread a ring may have, chart units (never
   * under 2.5 texels): an island's stack reaches at least its ring count
   * times this past its top silhouette. 0: no banks, the platform alone.
   */
  bankRun: number;
  /** bathymetry: the escarpment's share of the fall from the platform to the floor, 0–1. */
  bankScarp: number;
  /** bathymetry: a riser's width as a share of its ring's tread; never under 2.5 texels. */
  bankSlope: number;
  /**
   * bathymetry: how far the platform's outline, and so each island's bottom
   * silhouette, lies past the merged top silhouettes before its lobes and
   * notches, chart units: every island's rings share it out between them.
   */
  bankSpread: number;
  /** bathymetry: how far the bottom level stands above the platform, chart units. */
  bankStep: number;
  /**
   * bathymetry: each level's rise as a share of the rise below it, 0.4–1:
   * 1 spaces the levels evenly; under 1 the stacks flatten toward the top
   * and the deep rings crowd toward the platform.
   */
  bankTaper: number;
  /** bathymetry: the depth of the highest level, an island's top bench. */
  bankTop: number;
  /** bathymetry: the share of the platform's lobes the top silhouette takes: its shape in the sand. */
  bankTopReach: number;
  /**
   * bathymetry: the undulation every level but the top rides, as a share
   * of the level's own step, under half so no level meets its neighbour;
   * 0 for none.
   */
  bankUndulation: number;
  /** bathymetry: the way the undulation runs, degrees from east toward south. */
  bankUndulationAngle: number;
  /** bathymetry: how far the undulation's crests meander like a current, in wavelengths; 0 straight. */
  bankUndulationBend: number;
  /** bathymetry: chart units between the undulation's crests. */
  bankUndulationLength: number;
  /** bathymetry: the share of a wave each level's undulation is shifted from the one below. */
  bankUndulationShift: number;
  /** bathymetry: the terraces the undulation climbs in from trough to crest; 0 smooth. */
  bankUndulationSteps: number;
  /**
   * bathymetry: how far a ring's edge strays, as a share of its tread (at
   * most what keeps it off its neighbours'); 0 for none.
   */
  bankWander: number;
  /** floor: how far the floor's own colour takes its depth's band colour, 0–1. */
  floorTint: number;
  /** floor: sand, on the beaches and the shallow floor. */
  sandColor: Rgb;
  /**
   * seabed: how far the open floor's broad basins, winding troughs, hills
   * and sinkholes sink it further, at most, chart units. 0 for none.
   */
  seascapeBasins: number;
  /**
   * seabed: how deep the canyons running out downhill from the
   * archipelago's outline cut into the open floor, chart units; 0 for none.
   */
  seascapeCanyons: number;
  /**
   * seabed: the open sea's floor past the platform's slope, which only
   * sinks from the deep floor: how far it sinks away from the archipelago
   * per chart unit out from the coasts, past the platform's slope.
   */
  seascapeDescent: number;
  /** seabed: how far the open floor drops beyond its fault lines, chart units; 0 for none. */
  seascapeFaults: number;
  /** seabed: the abyssal hills furrowing the open floor, as a share of its basins' depth; 0 for none. */
  seascapeHills: number;
  /** seabed: the share of the open floor's sinkhole cells that hold one, 0–1. */
  seascapePits: number;
  /**
   * seabed: how far the open floor runs, as a multiple of the frame's
   * side: the seabed map's square, centred on the frame's.
   */
  seascapeReach: number;
  /** seabed: the open floor's formations' size, chart units: about a basin's width. */
  seascapeScale: number;
  /** seabed: which open floor: another seed, another seascape. */
  seascapeSeed: number;
  /**
   * seabed: the most of the open floor's fall its sills hold back on their
   * crests, 0–1, so the fall stalls and turns between basins; 0 for none.
   */
  seascapeSills: number;
  /**
   * seabed: each of the open floor's steps' depth against the one above
   * it, over 1, so the gaps widen as it goes deeper; 1 for no steps.
   */
  seascapeStep: number;
  /**
   * seabed: how far the warp bends the open floor's formations and its
   * fall swings, 0 not at all, 1 freely.
   */
  seascapeVeer: number;
  /**
   * flow: chart units the stirred shoal is carried back along the
   * transport, so sediment trails the surf.
   */
  sedimentDrift: number;
  /**
   * light: how fast the sun's penumbra widens with the water over the
   * floor: radians of the sun's apparent radius per chart unit of depth.
   * Light scatters on its way down, so an island's shadow lies crisp on
   * the shoal beside it and blurs out over the deep. 0 for the sun's own
   * radius at every depth.
   */
  shadowBlur: number;
  /**
   * bathymetry: the continental slope's width: past the platform's
   * escarpment the floor falls the rest of the way to the deep over this
   * distance, in `bankDeepRings` rings.
   */
  shelfWidth: number;
  /** bathymetry: a coast is all drop-off over a shelf this deep. */
  shoreCliffDepth: number;
  /** bathymetry: how far a drop-off falls from its coast, chart units (never under 2.5 texels). */
  shoreCliffWidth: number;
  /** bathymetry: how far dry sand runs into a bay before it dips under the water, chart units; 0 fills bays with sand. */
  shoreCove: number;
  /** bathymetry: the most a bay's water is deep, chart units: shallow enough, the swell breaks in it. */
  shoreCoveDepth: number;
  /** bathymetry: a coast is all sand beach over a shelf at most this deep. */
  shoreSandDepth: number;
  /** bathymetry: the sand's height above the water inside the top silhouette. */
  shoreSandHeight: number;
  /** bathymetry: a small island's extra sand, as a share of its beach. */
  shoreSmallSand: number;
  /** bathymetry: the island size (chart `Island.size`) by which the extra sand is gone. */
  shoreSmallSize: number;
  /** floor: silt, the floor's colour in the deep. */
  siltColor: Rgb;
  /** flow: radians clockwise from north (chart −y), where the swell comes from. */
  swellAzimuth: number;
  /** flow: chart units; a wave breaks where the depth is under about 1.3 times this. */
  swellHeight: number;
  /**
   * flow: chart units crest to crest. A wave feels the floor, and turns
   * toward the shallows, once the depth is under half this, and its shadow
   * behind an island blurs by diffraction over about the square root of
   * this times the distance.
   */
  swellLength: number;
}

/** The sea's parameters the frame reads as uniforms. */
interface SeaFrameParams {
  /** surface: light focused by the ripples, dancing on the shallow floor; 0 for none. */
  caustics: number;
  /**
   * surface: chart units of water through which the floor is seen at
   * exactly the shallow colour (`waterShallow` is its transmittance there).
   */
  clarity: number;
  /** shore: the foam where the swell meets a wall of rock, and its splashes; 0 for none. */
  cliffWash: number;
  /** debris: pebbles on the beaches and the shallows, the share of candidates kept on a lip; 0 for none. */
  debrisPebbles: number;
  /** debris: the foam rings on the water round each stack; 0 for none. */
  debrisRings: number;
  /** debris: shells on the sand at the water's edge, the share of candidates kept; 0 for none. */
  debrisShells: number;
  /** debris: multiplies every prop's size. */
  debrisSize: number;
  /** debris: sea stacks per thousand square chart units of shallow plate; 0 for none. */
  debrisStacks: number;
  /**
   * surface: the tint's curve. The floor's hue turns from its own toward
   * the shallow colour's as (depth / clarity) to this power, in optical
   * depth: 1 as the brightness does; higher holds the floor's colour
   * longer above `clarity` and turns it faster through and past it, so
   * the levels around `clarity` step in tint and the deep stays deep.
   */
  depthCurve: number;
  /** floor: the gold specks' strength on the shallow floor, thickest on the levels' lips; 0 for none. */
  floorSpecks: number;
  /** shore: the view fades into the sky with distance; 0 for none. */
  haze: number;
  /** shore: the haze far away, a warm horizon. */
  hazeFar: Rgb;
  /** shore: the haze near the camera, the cool sky. */
  hazeNear: Rgb;
  /** surface: the sky's reflection, by Fresnel. */
  reflection: number;
  /** surface: how far the floor seen through the water moves per unit of thickness and wave slope. */
  refraction: number;
  /**
   * surface: the most thickness, chart units, the refraction moves the
   * floor by: past it the deep floor wavers no more than this much water's.
   */
  refractionReach: number;
  /** floor: chart units between the sand ripples' crests. */
  rippleSpacing: number;
  /** floor: the sand ripples' strength on the shallow floor, crests parallel to the coast; 0 for none. */
  sandRipples: number;
  /** surface: the pale line at each sea step's lip. */
  seaLineColor: Rgb;
  /** surface: the sea step lines' strength; 0 for none. */
  seaLines: number;
  /**
   * surface: how strongly the floor's relief shades the water's colour, as
   * a chart's shading shows through its sea: cool in the floor's shadows
   * and on lee faces, calmer in the deep. 0–1, 0 for none.
   */
  seaRelief: number;
  /** surface: the pale rim on each step's riser where it faces the sun; 0 for none. */
  seaRim: number;
  /**
   * surface: how far the open floor keeps its relief and rim through the
   * deep, 0–1, where it has taken over (the height map's a): the seascape
   * read through the water. Nothing on the platform or its fall, so the
   * archipelago's own floor shades as it did.
   */
  seascapeRelief: number;
  /**
   * surface: how much of the water's own light (its colour and the sky's
   * reflection) survives in the land's shadow on the water, 0–1.
   */
  shadowAmbient: number;
  /** shore: light the pale sand under a beach gives back through the water; drop-offs have none. */
  shoalGlow: number;
  /** floor: the specks' colour. */
  speckColor: Rgb;
  /** floor: the share of cells holding a speck on a lip, 0–1; a third of it on flat floor. */
  speckDensity: number;
  /** floor: chart units of the specks' cells, at most one speck in each. */
  speckSize: number;
  /** surface: the sun's glint on the water. */
  specular: number;
  /** shore: the surf where the swell breaks, from the flow map; 0 for none. */
  surf: number;
  /** shore: chart units between the surf's crests as they roll ashore. */
  surfSpacing: number;
  /** shore: the swash, a sheet of water running up a beach's sand and back; 0 for none. */
  swash: number;
  /** shore: seconds between swashes. */
  swashPeriod: number;
  /** shore: how high up the sand the swash runs, chart units above the water, where the surf is full. */
  swashReach: number;
  /**
   * surface: the depth, chart units, at which the floor still passes
   * `VISIBLE_SHARE` (10%) of its light in the clearest channel; below it
   * the deep colour takes over. Past `clarity`.
   */
  visibleDepth: number;
  /** shore: seconds between the swells that send a ring of foam off a wall. */
  washPeriod: number;
  /** shore: chart units out from a wall the wash's rings spread to. */
  washWidth: number;
  /** surface: scatter, the colour the water builds to in the deep. */
  waterDeep: Rgb;
  /**
   * surface: how far the water's own colour is the chart's legend at the
   * floor's depth, as a chart's sea is, rather than `waterDeep`, 0–1.
   */
  waterLegend: number;
  /** surface: absorption, what the floor's light turns through `clarity` units of water. */
  waterShallow: Rgb;
  /** surface: multiplies the spectrum's amplitudes; 0 is a flat, still sea. */
  waveAmplitude: number;
  /**
   * surface: chart units per unit of the shared wave spectrum
   * (`src/shaders/water/waves.ts`, sized for /pond's toy boats). At 12 the
   * waves run from about 3 to 46 chart units long, against islands 40 to
   * 200 across.
   */
  waveScale: number;
  /** surface: the wave clock's rate. */
  waveSpeed: number;
  /** surface: radians the waves' directions spread either side of the swell's heading. */
  waveSpread: number;
  /** shore: how dark the sand the swash wets is, 0–1. */
  wetSand: number;
}

export type SeaParams = SeaMapParams & SeaFrameParams;

/**
 * Sized for Foundry's chart (about 1250 by 1600 units, islands 40 to 200
 * across, 19 levels): each stack spreads about 80 units past its hull to
 * the platform's outline, which runs on 15 past it, so a two-ring island's
 * treads are broad and a nineteen-ring island's about 4, never under 3; a
 * stack from 2 deep at the top down to the platform at about 56 (a
 * 4-unit bottom step, each above 0.96 of the one below, so every step,
 * the top one 1.9, casts a shadow that reads through the water), the deep
 * floor 24 under that (about 80) in six rings, so the scarp and slope
 * read; and a swell from the west-south-west that breaks on each coast's
 * beach and top ring (1.3 deep) and feels the floor from 20 deep, the
 * upper levels round each island, so it wraps around each island's headlands
 * without filling its lee. The floor's colours are Spyglass's chart: sand
 * going to silt, tinted by bands from a pale shore through turquoise over
 * the levels and cyan over the platform to navy over the deep. The water
 * is tuned to that floor: the floor is seen at the shallow colour 3 deep,
 * by the top levels, and the tint turns fastest there (`depthCurve` 2); it
 * still passes 10% at 40. The sun's penumbra widens 0.002
 * radians a unit of depth: twice the sun's own on the platform, three
 * times on the floor.
 */
export const DEFAULT_SEA_PARAMS: SeaParams = {
  bandDeep: hexToLinear("#0c3f6f"),
  bandShallows: hexToLinear("#4fd8cf"),
  bandShelf: hexToLinear("#1fb2c2"),
  bandShore: hexToLinear("#d2f6e8"),
  bandSlope: hexToLinear("#11769c"),
  bandTrench: hexToLinear("#051a38"),
  bankBeach: 16,
  bankBottomReach: 2,
  bankBridge: 40,
  bankDeep: 24,
  bankDeepRings: 6,
  bankHull: 0.35,
  bankLift: 0.3,
  bankLiftTread: 30,
  bankMargin: 15,
  bankMerge: 80,
  bankMoat: 0.25,
  bankMoatAmount: 0.5,
  bankRagged: 0.6,
  bankRun: 3,
  bankScarp: 0.5,
  bankSlope: 0.4,
  bankSpread: 80,
  bankStep: 4,
  bankTaper: 0.96,
  bankTop: 2,
  bankTopReach: 0.2,
  bankUndulation: 0.4,
  bankUndulationAngle: 45,
  bankUndulationBend: 0.6,
  bankUndulationLength: 80,
  bankUndulationShift: 0.45,
  bankUndulationSteps: 3,
  bankWander: 0.25,
  caustics: 1,
  clarity: 3,
  cliffWash: 1,
  debrisPebbles: 0.35,
  debrisRings: 1,
  debrisShells: 0.3,
  debrisSize: 1,
  debrisStacks: 0.03,
  depthCurve: 2,
  floorSpecks: 0.8,
  floorTint: 0.75,
  haze: 0.04,
  hazeFar: hexToLinear("#ffd6a3"),
  hazeNear: hexToLinear("#b8ccdb"),
  reflection: 0.6,
  refraction: 0.6,
  refractionReach: 18,
  rippleSpacing: 4,
  sandColor: hexToLinear("#f3e8c7"),
  sandRipples: 0.6,
  seaLineColor: hexToLinear("#a6eef0"),
  seaLines: 0.32,
  seaRelief: 0.9,
  seaRim: 1,
  seascapeBasins: 40,
  seascapeCanyons: 40,
  seascapeDescent: 0.035,
  seascapeFaults: 12,
  seascapeHills: 0.35,
  seascapePits: 0.3,
  seascapeReach: 4,
  seascapeRelief: 0.8,
  seascapeScale: 900,
  seascapeSeed: 1,
  seascapeSills: 0.6,
  seascapeStep: 1.12,
  seascapeVeer: 0.6,
  sedimentDrift: 8,
  shadowAmbient: 0.45,
  shadowBlur: 0.002,
  shelfWidth: 150,
  shoalGlow: 0.4,
  shoreCliffDepth: 50,
  shoreCliffWidth: 3,
  shoreCove: 6,
  shoreCoveDepth: 0.75,
  shoreSandDepth: 18,
  shoreSandHeight: 0.8,
  shoreSmallSand: 0.25,
  shoreSmallSize: 100,
  siltColor: hexToLinear("#66807f"),
  speckColor: hexToLinear("#f0c060"),
  speckDensity: 0.25,
  speckSize: 3.5,
  specular: 0.6,
  surf: 1.25,
  surfSpacing: 3,
  swash: 1,
  swashPeriod: 5,
  swashReach: 0.4,
  swellAzimuth: 4.4,
  swellHeight: 1,
  swellLength: 40,
  visibleDepth: 40,
  washPeriod: 3.5,
  washWidth: 6,
  waterDeep: [0.003_347, 0.0185, 0.080_22],
  waterLegend: 1,
  // #4fb3bf and #0b2550, linear.
  waterShallow: [0.078_19, 0.4508, 0.521],
  waveAmplitude: 1,
  waveScale: 12,
  waveSpeed: 1,
  waveSpread: 1,
  wetSand: 0.8,
};

/**
 * The open floor flat at the deep floor: no descent, no landform, no
 * steps, as the floor past the platform's slope lay before the seascape.
 * Nothing in the app uses it: it is here for the tests, which measure the
 * platform and its banks against it, so it stays beside the fields it
 * zeroes and fails to compile if one is renamed.
 */
export const FLAT_OPEN_FLOOR = {
  seascapeBasins: 0,
  seascapeCanyons: 0,
  seascapeDescent: 0,
  seascapeFaults: 0,
  seascapeStep: 1,
} as const satisfies Partial<SeaMapParams>;

/** The map each map-side parameter rebuilds (its dependants rebuild with it). */
export const MAP_OF_SEA_MAP_PARAM: Record<keyof SeaMapParams, MapPassName> = {
  bandDeep: "paint",
  bandShallows: "paint",
  bandShelf: "paint",
  bandShore: "paint",
  bandSlope: "paint",
  bandTrench: "paint",
  bankBeach: "height",
  bankBottomReach: "height",
  bankBridge: "height",
  bankDeep: "height",
  bankDeepRings: "height",
  bankHull: "height",
  bankLift: "height",
  bankLiftTread: "height",
  bankMargin: "height",
  bankMerge: "height",
  bankMoat: "height",
  bankMoatAmount: "height",
  bankRagged: "height",
  bankRun: "height",
  bankScarp: "height",
  bankSlope: "height",
  bankSpread: "height",
  bankStep: "height",
  bankTaper: "height",
  bankTop: "height",
  bankTopReach: "height",
  bankUndulation: "height",
  bankUndulationAngle: "height",
  bankUndulationBend: "height",
  bankUndulationLength: "height",
  bankUndulationShift: "height",
  bankUndulationSteps: "height",
  bankWander: "height",
  floorTint: "paint",
  sandColor: "paint",
  seascapeBasins: "height",
  seascapeCanyons: "height",
  seascapeDescent: "height",
  seascapeFaults: "height",
  seascapeHills: "height",
  seascapePits: "height",
  seascapeReach: "seabed",
  seascapeScale: "height",
  seascapeSeed: "height",
  seascapeSills: "height",
  seascapeStep: "height",
  seascapeVeer: "height",
  sedimentDrift: "flow",
  shadowBlur: "light",
  shelfWidth: "height",
  shoreCliffDepth: "height",
  shoreCliffWidth: "height",
  shoreCove: "height",
  shoreCoveDepth: "height",
  shoreSandDepth: "height",
  shoreSandHeight: "height",
  shoreSmallSand: "height",
  shoreSmallSize: "height",
  siltColor: "paint",
  swellAzimuth: "flow",
  swellHeight: "flow",
  swellLength: "flow",
};

/** `source`'s `keys`, and nothing else. */
export function pick<T, K extends keyof T>(
  source: T,
  keys: readonly K[]
): Pick<T, K> {
  const picked = {} as Pick<T, K>;
  for (const key of keys) {
    picked[key] = source[key];
  }
  return picked;
}

/** Every sea parameter: `DEFAULT_SEA_PARAMS` holds exactly `SeaParams`. */
export const SEA_KEYS = Object.keys(DEFAULT_SEA_PARAMS) as (keyof SeaParams)[];

/** The map-side ones: `MAP_OF_SEA_MAP_PARAM` holds exactly `SeaMapParams`. */
const SEA_MAP_KEYS = Object.keys(
  MAP_OF_SEA_MAP_PARAM
) as (keyof SeaMapParams)[];

/**
 * The sea's colours, linear here, which the settings hold as a picker's
 * sRGB hex (look.ts `seaParamsOf`).
 */
export const SEA_COLORS = [
  "sandColor",
  "siltColor",
  "bandShore",
  "bandShallows",
  "bandShelf",
  "bandSlope",
  "bandDeep",
  "bandTrench",
  "waterShallow",
  "waterDeep",
  "speckColor",
  "seaLineColor",
  "hazeNear",
  "hazeFar",
] as const satisfies readonly (keyof SeaParams)[];

/** The map-side part of a set of sea parameters. */
export const seaMapParamsOf = (sea: Readonly<SeaMapParams>): SeaMapParams =>
  pick(sea, SEA_MAP_KEYS);

/** The sea floor's depths below sea level, chart units, positive. */
export interface SeaDepths {
  /** The deep floor's: the platform plus `bankDeep`. */
  readonly floor: number;
  /** The platform's: the top plus the whole stack of levels under it. */
  readonly platform: number;
  /** The highest level's: `bankTop`. */
  readonly top: number;
}

/** The parameters the depths follow from. */
export type SeaDepthParams = Pick<
  SeaMapParams,
  "bankDeep" | "bankStep" | "bankTaper" | "bankTop"
>;

/** `bankTaper` as the bathymetry reads it: a share of the rise below, at most 1. */
export const taperOf = (sea: SeaDepthParams): number =>
  Math.min(Math.max(sea.bankTaper, 0), 1);

/**
 * How far level `level` (0 the deepest) stands above the platform: the
 * bottom one `bankStep`, each above `bankTaper` times the rise below it,
 * so the geometric sum `step × (1 − taper^(level + 1)) / (1 − taper)`, and
 * `step × (level + 1)` at taper 1. The bathymetry's `levelRise` is the same.
 */
export function levelRise(sea: SeaDepthParams, level: number): number {
  const step = Math.max(sea.bankStep, 0);
  const taper = taperOf(sea);
  const count = level + 1;
  if (taper >= 1) {
    return step * count;
  }
  return (step * (1 - taper ** count)) / (1 - taper);
}

/**
 * The depths for a chart whose banks stand on `levels` levels (banks.ts
 * `banksOf`): the top where art direction sets it, the platform under the
 * whole stack, the deep under that. With no levels the platform is at the
 * top. Every reader of the floor's depth takes it from here.
 */
export function seaDepthsOf(sea: SeaDepthParams, levels: number): SeaDepths {
  const top = Math.max(sea.bankTop, 0);
  const platform = top + (levels > 0 ? levelRise(sea, levels - 1) : 0);
  return { floor: platform + Math.max(sea.bankDeep, 0), platform, top };
}

/** The sea's colour bands, shallowest first: each colour and the depth it is reached at. */
export type SeaBands = readonly (readonly [number, number, number, number])[];

/**
 * The bands at the chart's depths: the shore at the waterline, the
 * shallows by the top levels, the shelf over the lower levels and the
 * platform, the slope down past it, the deep at the deep floor and the
 * trench past it. Depths derived, never fixed: every chart spends the
 * colours the same way over its own floor.
 */
export function seaBandsOf(
  sea: SeaDepthParams &
    Pick<
      SeaMapParams,
      | "bandDeep"
      | "bandShallows"
      | "bandShelf"
      | "bandShore"
      | "bandSlope"
      | "bandTrench"
    >,
  levels: number
): SeaBands {
  const { top, platform, floor } = seaDepthsOf(sea, levels);
  const band = (color: Rgb, depth: number) =>
    [color[0], color[1], color[2], depth] as const;
  return [
    band(sea.bandShore, 0),
    band(sea.bandShallows, Math.max(top, 0.5)),
    band(sea.bandShelf, Math.max(SHELF_SHARE * platform, top + 0.5)),
    band(sea.bandSlope, platform + SLOPE_SHARE * (floor - platform)),
    band(sea.bandDeep, Math.max(floor, platform + 1)),
    band(sea.bandTrench, Math.max(TRENCH_SCALE * floor, platform + 2)),
  ];
}

/**
 * The floor's colour by depth (sea/floor.wgsl `FloorPaint`): sand going to
 * silt by the platform's depth, tinted by the bands. The paint map paints
 * the chart's floor by it, and the terrain the open floor past the frame.
 */
export function floorPaintOf(
  sea: Parameters<typeof seaBandsOf>[0] &
    Pick<SeaMapParams, "floorTint" | "sandColor" | "siltColor">,
  levels: number
) {
  return {
    bands: seaBandsOf(sea, levels),
    sand: sea.sandColor,
    silt: sea.siltColor,
    siltDepth: Math.max(seaDepthsOf(sea, levels).platform, 1),
    tint: clamp01(sea.floorTint),
  };
}

/** The shelf's colour is reached this share of the way down to the platform. */
const SHELF_SHARE = 0.5;
/** The slope's colour is reached this share of the way from the platform to the deep floor. */
const SLOPE_SHARE = 0.4;
/** The trench's colour is reached at this many times the deep floor's depth. */
const TRENCH_SCALE = 2;

/**
 * The direction the swell travels, chart x and y (y south), unit: away
 * from `swellAzimuth`, which is where it comes from, clockwise from north.
 */
export function swellHeading(azimuth: number): [number, number] {
  return [-Math.sin(azimuth), Math.cos(azimuth)];
}

/** A wave breaks where the depth is under about this times its height. */
const BREAK_RATIO = 1.3;
/** Chart units are taken as metres for the breaker's speed. */
const GRAVITY = 9.81;

/** The depth a swell of `swellHeight` breaks in, chart units. */
export const breakDepth = (swellHeight: number): number =>
  BREAK_RATIO * Math.max(swellHeight, 0);

/**
 * The surf's transport at full breaking, chart units per second: the
 * breaker's shallow-water speed, sqrt(g · depth), at the break depth.
 */
export const surfSpeed = (swellHeight: number): number =>
  Math.sqrt(GRAVITY * breakDepth(swellHeight));
