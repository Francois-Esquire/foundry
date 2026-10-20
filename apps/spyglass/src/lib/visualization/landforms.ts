import { type DrainageSettings, drainage, type Valley } from "./drainage";
import { unit } from "./geography";
import {
  geologyLevels,
  type Landform,
  type LandformArchetype,
  rampLandform,
} from "./geology";
import { type FractalSettings, fbm, gradientNoise, noiseSeed } from "./noise";
import { defaultTerrainSettings } from "./terrain";

/**
 * Landforms: the shape each island's land takes above the water. A package
 * is classified into one formation from what is true of it, and the
 * formation is built on one island anatomy: a beach, terraces separated by
 * escarpments, and a summit plateau. The terraces step a sculpted relief,
 * not the distance inland alone: the inland distance swells and meanders
 * round the island, the formation's own shape caps it, and valleys cut it
 * toward the sea, so the escarpments wander with spurs and re-entrants
 * while the treads stay level. Every landform is 0 at the coast, at most
 * `geologyLevels.land`, and continuous by construction: a shape's relief is
 * capped by the island's own inland relief, so no shape lifts the shore.
 */

/** What a package's island is classified from, in plain numbers. */
export interface LandformMetrics {
  /** Separate pieces of land in the island's coast. */
  coastPieces: number;
  /** The land's principal-axis ratio, 1 or more: 1 is round. */
  elongation: number;
  /** Files in the package. */
  files: number;
  /**
   * The package's most imported file's internal fan-in over the next one's,
   * 1 or more; 1 without internals.
   */
  hubDominance: number;
  /**
   * The high fan-in files' mean distance from the files' centre, over every
   * file's; 0 without hubs. Near 1 or above, the hubs sit out at the rim.
   */
  hubRim: number;
  /** High fan-in files: the package's hubs. */
  hubs: number;
}

/** A place an island rises toward, as a map position and a weight from 0 to 1. */
export interface LandformPeak {
  weight: number;
  x: number;
  y: number;
}

/** The head of a bay in the coast, where drainage reaches the sea. */
export interface LandformOutlet {
  /** Map units the bay reaches in from the coast's convex hull. */
  depth: number;
  x: number;
  y: number;
}

/** The island geometry a landform is built over, in map units and map positions. */
export interface LandformParams {
  /** Unit vector of the land's principal axis. */
  axis: readonly [number, number];
  /** Half the land's width across its principal axis. */
  breadth: number;
  /** Map units inland of the island's deepest point. */
  depth: number;
  /** Half the land's length along its principal axis. */
  length: number;
  /** The coast's bays, deepest first; absent or empty without bays. */
  outlets?: readonly LandformOutlet[];
  /** The package's hubs, strongest first; empty without internals. */
  peaks: readonly LandformPeak[];
  /** The land's centre of area. */
  x: number;
  y: number;
}

/** One island's formation and the geometry it is built over. */
export interface IslandLandform {
  archetype: LandformArchetype;
  params: LandformParams;
}

/** One formation's anatomy: how high, how far inland, and how its terraces step. */
export interface FormationSettings {
  /** Summit height as a share of `geologyLevels.land`. */
  height: number;
  /**
   * Share of the island's depth at which the inland relief reaches the
   * summit. Beyond it the formation's shape alone caps the relief.
   */
  reach: number;
  /** Share of each terrace step that is its escarpment. */
  riser: number;
  /** 0 is flat treads, 1 the straight ramp. */
  softness: number;
  /** Terrace steps between the beach and the summit. */
  terraces: number;
}

/** How many valleys a formation's drainage has, and how they are sized. */
interface ValleySettings {
  /** Valleys at least, one toward each bay first. */
  count: number;
  /** Share of the island's depth below its head over which a valley deepens to full. */
  deepen: number;
  /** Share of the relief a valley takes on its axis, 0 to 1. */
  depth: number;
  /** Share of the island's depth a valley reaches up from the coast. */
  reach: number;
  /** Half a valley's width at the mouth, as a share of the island's depth. */
  width: number;
}

/** A fractal noise field at a wavelength in map units. */
interface NoiseField extends FractalSettings {
  /** Map units per lattice cell. */
  wavelength: number;
}

export const defaultLandformSettings = {
  atoll: {
    /** Share of the island's depth over which the rim falls to the lagoon floor. */
    fall: 0.2,
    formation: {
      height: 0.45,
      reach: 0.38,
      riser: 0.3,
      softness: 0.12,
      terraces: 1,
    },
    /**
     * Relief of the lagoon floor, 0 to 1: at 0 it is the beach bench, a
     * flat of pale sand inside the rim, still above the water.
     */
    lagoon: 0,
    /**
     * The rim's motus: islets where a noise field at `spacing` map units
     * passes `threshold`, rising over the noise's `edge`, joined by saddles
     * at `saddle` relief.
     */
    motus: { edge: 0.45, saddle: 0, spacing: 20, threshold: -0.05 },
  },
  /**
   * Beach: a flat bench at the waterline, `width` map units deep and
   * `height` a share of `geologyLevels.land` high. Its seaward face rises
   * over the first `lip` share of the width; the rest is level sand up to
   * the foot of the first escarpment. On a small piece of land the bench is
   * at most `share` of the piece's depth, so an islet keeps land behind its
   * sand.
   */
  beach: { height: 0.04, lip: 0.4, share: 0.28, width: 4 },
  /**
   * Classification thresholds, tested in order: seamount, cluster, ridge,
   * atoll, volcanic; anything else is a plateau.
   */
  classify: {
    /** Hubs an atoll's rim needs; with fewer, where they sit says nothing. */
    atollHubs: 3,
    /** Hubs at least this far out, relative to the files, ring the rim. */
    atollRim: 0.8,
    /** Coast pieces at which the land is a cluster. */
    clusterPieces: 3,
    /** Principal-axis ratio at which the land is a ridge. */
    ridgeElongation: 1.6,
    /** At most this many files barely breaks the surface. */
    seamountFiles: 10,
    /** One hub this many times the next makes a volcano. */
    volcanicDominance: 1.8,
  },
  cluster: {
    /** Relief of the low land between knolls, 0 to 1. */
    base: 0.25,
    formation: {
      height: 0.55,
      reach: 0.6,
      riser: 0.3,
      softness: 0.12,
      terraces: 2,
    },
    /** Each knoll's radius as a share of the island's depth, at least `knollMinimum` map units. */
    knoll: 0.9,
    knollMinimum: 10,
    /** The weakest knoll's relief, 0 to 1. */
    knollWeight: 0.55,
    /** Share by which a knoll's radius swells and narrows round it, in lobes `wavelength` of the radius across. */
    lobes: { amount: 0.3, wavelength: 0.6 },
    valleys: { count: 2, deepen: 0.35, depth: 0.7, reach: 0.9, width: 0.25 },
  },
  /** How valleys deepen downstream, narrow at the head and meander. */
  drainage: {
    /** Share of the island's depth a trunk toward a bay may run past the high point. */
    beyond: 0.25,
    head: 0.45,
    meander: { amplitude: 2.5, wavelength: 14 },
  } satisfies DrainageSettings & { beyond: number },
  /**
   * Escarpments are never narrower than this many map units, so the
   * preview's 1-unit land lattice resolves them as walls.
   */
  minimumRiser: 3,
  plateau: {
    formation: {
      height: 0.8,
      reach: 0.7,
      riser: 0.3,
      softness: 0.12,
      terraces: 2,
    },
    /**
     * The summit breaks into mesas: where a noise field at `wavelength`
     * map units passes `threshold`, the summit falls one terrace, over the
     * noise's `edge`.
     */
    mesa: { edge: 0.4, octaves: 2, threshold: 0.05, wavelength: 30 },
    /**
     * Each trunk takes a tributary `angle` radians off its course, joining
     * `junction` of the way from the trunk's head to the coast. It reaches
     * `length` of the trunk's reach up, at `size` of its depth and width.
     */
    tributary: { angle: 0.6, junction: 0.5, length: 0.55, size: 0.8 },
    valleys: { count: 3, deepen: 0.35, depth: 0.85, reach: 1.1, width: 0.3 },
  },
  ridge: {
    /** The crest's sideways wander: `amount` of the land's half breadth, in bends `wavelength` of its half length apart. */
    bend: { amount: 0.35, wavelength: 0.6 },
    formation: {
      height: 0.92,
      reach: 0.8,
      riser: 0.3,
      softness: 0.12,
      terraces: 3,
    },
    /**
     * Gullies down the flanks: their heads `head` of the half breadth off the
     * crest, spread along it and each nudged by up to `nudge` of its slot,
     * leaning along the axis by up to `lean` of their run.
     */
    gullies: { head: 0.2, lean: 0.35, nudge: 0.4 },
    /** The power of the crest's section: above 1 its top is broad and its flanks steep. */
    section: 1.6,
    /** Share of the land's half length the crest holds before it tapers. */
    shoulder: 0.45,
    /**
     * Side spurs: the crest's flanks reach out by up to `reach` of its half
     * breadth, in lobes `wavelength` map units apart along each side.
     */
    spurs: { edge: 0.35, reach: 0.6, wavelength: 16 },
    /** Relief of the crest's saddles below its peaks, 0 to 1, about `wavelength` map units apart. */
    undulation: { depth: 0.3, wavelength: 34 },
    valleys: { count: 4, deepen: 0.5, depth: 0.7, reach: 1, width: 0.22 },
  },
  /**
   * The inland distance is sculpted before it is stepped: it swells and
   * narrows by up to `swell` of itself round the island, so treads widen
   * and pinch, and every escarpment wanders by up to `meander` map units,
   * so it runs out in spurs and back in re-entrants. A piece of land less
   * than `full` map units deep is sculpted less, so a speck stays a cay.
   */
  sculpt: {
    full: 12,
    meander: {
      amplitude: 6,
      gain: 0.5,
      lacunarity: 2,
      octaves: 2,
      wavelength: 18,
    },
    swell: {
      amplitude: 0.7,
      gain: 0.5,
      lacunarity: 2,
      octaves: 2,
      wavelength: 40,
    },
  } satisfies { full: number } & Record<
    "meander" | "swell",
    NoiseField & { amplitude: number }
  >,
  seamount: {
    formation: {
      height: 0.2,
      reach: 0.6,
      riser: 0.5,
      softness: 0.12,
      terraces: 1,
    },
  },
  /** Share by which a seeded jitter may lower an island's summit. */
  variation: 0.1,
  volcanic: {
    /**
     * The barrancos' heads lie `head` of the summit tread's width down the
     * flank, each lowered by up to `stagger` more and made up to `vary`
     * shallower with the seed.
     */
    barrancos: { head: 1, stagger: 0.6, vary: 0.3 },
    /** The cone's foot, as a share of the land's half length out from the vent. */
    cone: 0.8,
    /** Crater radius as a share of the island's depth. */
    crater: 0.22,
    /** Relief the crater floor sinks below the lip, 0 to 1. */
    craterDepth: 0.3,
    formation: {
      height: 1,
      reach: 0.6,
      riser: 0.25,
      softness: 0.12,
      terraces: 3,
    },
    /**
     * Share by which the cone's flanks swell and narrow round the vent, in
     * lobes `wavelength` map units across; at the crater lip only `lip` of it.
     */
    lobes: { amount: 0.3, lip: 0.4, wavelength: 18 },
    /**
     * A parasitic cone on the flank down the principal axis: its radius as a
     * share of the island's depth, where it sits as a share of the land's
     * half length, and how far it stands above the flank, 0 to 1.
     */
    parasite: { along: 0.55, radius: 0.32, rise: 0.3 },
    valleys: { count: 6, deepen: 0.25, depth: 0.55, reach: 1, width: 0.2 },
    /** Share of the way from the strongest hub to the centre where the vent sits. */
    ventPull: 0.5,
  },
};
export type LandformSettings = typeof defaultLandformSettings;

/** A package's formation, from what is true of it. */
export function classifyLandform(
  metrics: LandformMetrics,
  settings: LandformSettings = defaultLandformSettings
): LandformArchetype {
  const rules = settings.classify;
  if (metrics.files <= rules.seamountFiles) {
    return "seamount";
  }
  if (metrics.coastPieces >= rules.clusterPieces) {
    return "cluster";
  }
  if (metrics.elongation >= rules.ridgeElongation) {
    return "ridge";
  }
  if (metrics.hubs >= rules.atollHubs && metrics.hubRim >= rules.atollRim) {
    return "atoll";
  }
  if (metrics.hubs >= 1 && metrics.hubDominance >= rules.volcanicDominance) {
    return "volcanic";
  }
  return "plateau";
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function smoothstep(value: number): number {
  const t = clamp01(value);
  return t * t * (3 - 2 * t);
}

/** The terrace profile's input: one formation's anatomy over one island. */
export interface TerracedProfileParams {
  /** Beach width in map units. */
  beach: number;
  /** Beach bench height, in `geologyLevels` units. */
  beachHeight: number;
  /** Share of the beach's width over which its seaward face rises; 0 to 1. */
  beachLip: number;
  /** Summit height, in `geologyLevels` units; held to `geologyLevels.land`. */
  height: number;
  /** Escarpments are never narrower than this many map units. */
  minimumRiser: number;
  /** Map units inland at which the summit plateau begins. */
  reach: number;
  /** Share of each terrace step that is its escarpment. */
  riser: number;
  /** 0 is flat treads, 1 the straight ramp. */
  softness: number;
  /** Terrace steps between the beach and the summit. */
  terraces: number;
}

/**
 * The steps from shore to summit, in relief from 0 to 1: each step opens
 * with its escarpment, a smooth rise over `riser` of the step, and then
 * holds a tread. The last tread is the summit. `softness` tilts the treads
 * toward the straight ramp.
 */
function terrace(
  relief: number,
  steps: number,
  riser: number,
  softness: number
): number {
  const u = clamp01(relief);
  const count = Math.max(1, Math.round(steps));
  const scaled = u * count;
  const index = Math.min(count - 1, Math.floor(scaled));
  const rise = smoothstep((scaled - index) / Math.max(riser, 1e-6));
  const stepped = (index + rise) / count;
  return stepped + clamp01(softness) * (u - stepped);
}

/** The beach width the profile keeps, at most 40% of the reach. */
function beachWidth(params: TerracedProfileParams): number {
  return Math.min(
    Math.max(params.beach, 0),
    Math.max(params.reach, 1e-3) * 0.4
  );
}

/** Each escarpment's share of its step: `riser`, widened to at least `minimumRiser` map units. */
function riserShare(params: TerracedProfileParams): number {
  const reach = Math.max(params.reach, 1e-3);
  const step =
    (reach - beachWidth(params)) / Math.max(1, Math.round(params.terraces));
  return Math.min(
    1,
    Math.max(params.riser, params.minimumRiser / Math.max(step, 1e-6))
  );
}

/** The beach bench's height at an inland distance: its seaward face, then level sand. */
function beachLip(
  inland: number,
  beach: number,
  lip: number,
  height: number
): number {
  const face = beach * clamp01(lip);
  return face > 0
    ? height * smoothstep(inland / face)
    : height * Number(inland > 0);
}

/**
 * Island anatomy as a function of inland distance: a beach bench over the
 * first `beach` map units, its seaward face rising over `beachLip` of it,
 * then terraces separated by escarpments, and a summit plateau from
 * `reach` inland. It is 0 at the coast, continuous, and at
 * most `geologyLevels.land`.
 */
export function terracedProfile(
  params: TerracedProfileParams
): (inland: number) => number {
  const height = Math.min(geologyLevels.land, Math.max(0, params.height));
  const reach = Math.max(params.reach, 1e-3);
  const beach = beachWidth(params);
  const beachHeight = Math.min(height, Math.max(0, params.beachHeight));
  const riser = riserShare(params);
  return (inland) => {
    const at = Math.max(0, inland);
    return (
      beachLip(at, beach, params.beachLip, beachHeight) +
      (height - beachHeight) *
        terrace(
          clamp01((at - beach) / (reach - beach)),
          params.terraces,
          riser,
          params.softness
        )
    );
  };
}

/** A formation's terrace profile over one island, its summit lowered by a seeded jitter. */
function profileParams(
  formation: FormationSettings,
  params: LandformParams,
  seed: string,
  settings: LandformSettings
): TerracedProfileParams {
  const jitter = 1 - settings.variation * unit(`${seed}:height`);
  return {
    beach: settings.beach.width,
    beachHeight: settings.beach.height * geologyLevels.land,
    beachLip: settings.beach.lip,
    height: formation.height * jitter * geologyLevels.land,
    minimumRiser: settings.minimumRiser,
    reach: Math.max(1, params.depth * formation.reach),
    riser: formation.riser,
    softness: formation.softness,
    terraces: formation.terraces,
  };
}

/**
 * Relief 0 to 1 at a map position, before the inland cap. `inland` is the
 * surveyed inland distance in map units, unsculpted, so a shape that keys
 * on it stays where the island's other layers expect it.
 */
type Relief = (x: number, y: number, inland: number) => number;

/** A fractal noise field over map positions, from -1 to 1. */
function noiseField(
  field: NoiseField,
  seed: string
): (x: number, y: number) => number {
  const integer = noiseSeed(seed);
  const wavelength = Math.max(field.wavelength, 1e-3);
  return (x, y) => fbm(x / wavelength, y / wavelength, integer, field);
}

/** Two octaves of noise at a wavelength in map units: broad shapes without grain. */
function smoothNoise(
  wavelength: number,
  seed: string
): (x: number, y: number) => number {
  return noiseField({ gain: 0.5, lacunarity: 2, octaves: 2, wavelength }, seed);
}

/** One formation over one island: its shape, its valleys and its anatomy. */
interface Sculpture {
  formation: FormationSettings;
  relief: Relief;
  valleys: readonly Valley[];
}

/**
 * A formation's land: the beach bench, then the terraces stepped over the
 * sculpted relief. The inland distance swells and meanders, the inland cap
 * rises over the formation's `reach` share of the island's depth, the
 * formation's shape caps it beyond, and the valleys carve it, all before
 * the steps, so the treads stay level and the escarpments stay crisp. The
 * beach narrows on a small piece of land to `share` of the piece's depth.
 */
function sculpted(
  formed: Sculpture,
  params: LandformParams,
  seed: string,
  settings: LandformSettings
): Landform {
  const profile = profileParams(formed.formation, params, seed, settings);
  const height = Math.min(geologyLevels.land, Math.max(0, profile.height));
  const beachHeight = Math.min(height, Math.max(0, profile.beachHeight));
  const riser = riserShare(profile);
  const { reach } = profile;
  const swell = noiseField(settings.sculpt.swell, `${seed}:swell`);
  const meander = noiseField(settings.sculpt.meander, `${seed}:meander`);
  const carve = drainage(
    formed.valleys,
    noiseSeed(`${seed}:drainage`),
    settings.drainage
  );
  const { terraces, softness } = formed.formation;
  return ({ inland, pieceDepth, x, y }) => {
    const at = Math.max(0, inland);
    if (at <= 0) {
      return 0;
    }
    const piece = pieceDepth ?? params.depth;
    const beach = Math.min(settings.beach.width, settings.beach.share * piece);
    const strength = smoothstep(piece / settings.sculpt.full);
    const sculptedInland =
      at * (1 + strength * settings.sculpt.swell.amplitude * swell(x, y)) +
      strength *
        settings.sculpt.meander.amplitude *
        meander(x, y) *
        smoothstep(at / settings.beach.width);
    const inlandRelief = clamp01(
      (sculptedInland - beach) / Math.max(1, reach - beach)
    );
    // On the beach the inland cap is 0, and with it the shape and valleys.
    const capped =
      inlandRelief > 0
        ? Math.min(clamp01(formed.relief(x, y, at)), inlandRelief)
        : 0;
    const relief = capped > 0 ? capped * (1 - carve(x, y)) : 0;
    const elevation =
      beachLip(at, beach, settings.beach.lip, beachHeight) +
      (height - beachHeight) * terrace(relief, terraces, riser, softness);
    return Math.min(geologyLevels.land, Math.max(0, elevation));
  };
}

/** A direction's angle, from -π to π. */
function bearing(fromX: number, fromY: number, toX: number, toY: number) {
  return Math.atan2(toY - fromY, toX - fromX);
}

/**
 * Bearings round a centre: one toward each bay, deepest first, then more
 * set into the widest gaps between them, each nudged by the seed, until
 * there are `count`.
 */
function drainageBearings(
  centreX: number,
  centreY: number,
  outlets: readonly LandformOutlet[],
  count: number,
  seed: string
): number[] {
  const bearings = outlets
    .slice(0, count)
    .map((outlet) => bearing(centreX, centreY, outlet.x, outlet.y));
  if (bearings.length === 0 && count > 0) {
    bearings.push(2 * Math.PI * unit(`${seed}:bearing`) - Math.PI);
  }
  while (bearings.length < count) {
    const sorted = [...bearings].sort((a, b) => a - b);
    let widest = 0;
    let from = sorted[0] ?? 0;
    for (const [index, angle] of sorted.entries()) {
      const next = sorted[(index + 1) % sorted.length] ?? angle;
      const gap = (next - angle + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI;
      if (gap > widest) {
        widest = gap;
        from = angle;
      }
    }
    const nudge = 0.3 * (unit(`${seed}:bearing:${bearings.length}`) - 0.5);
    bearings.push(from + widest * (0.5 + nudge));
  }
  return bearings;
}

/** A valley's size over one island: how far it deepens, how deep and how wide, in map units. */
interface ValleySize {
  deepen: number;
  depth: number;
  width: number;
}

/** A formation's valley size over one island; the half width never under the minimum riser. */
function valleySize(
  params: LandformParams,
  valleys: ValleySettings,
  settings: LandformSettings
): ValleySize {
  return {
    deepen: params.depth * valleys.deepen,
    depth: valleys.depth,
    width: Math.max(settings.minimumRiser + 1, params.depth * valleys.width),
  };
}

/** A valley's course: from a head on the high ground, down a bearing toward the coast. */
interface CourseLine {
  /** The bearing downstream, in radians. */
  angle: number;
  /** Map units from the head to the coast, about. */
  coast: number;
  headX: number;
  headY: number;
}

/** The valley down a course, its mouth `overshoot` map units past the coast. */
function valleyAlong(
  course: CourseLine,
  size: ValleySize,
  overshoot: number
): Valley {
  const end = course.coast + overshoot;
  return {
    ...size,
    headX: course.headX,
    headY: course.headY,
    mouthX: course.headX + end * Math.cos(course.angle),
    mouthY: course.headY + end * Math.sin(course.angle),
  };
}

/** Map units from the land's centre to its coast along a bearing, as the land's axes bound it. */
function axisRadius(params: LandformParams, angle: number): number {
  const turn = angle - Math.atan2(params.axis[1], params.axis[0]);
  const length = Math.max(1, params.length);
  const breadth = Math.max(1, params.breadth);
  return 1 / Math.hypot(Math.cos(turn) / length, Math.sin(turn) / breadth);
}

/** How far a set of courses reaches up from the coast, in map units. */
interface CourseSpan {
  /** The furthest a head toward a bay may lie past the high point. */
  beyond: number;
  /** How far a head lies up from the coast. */
  reach: number;
  /** The nearest a head may lie to the high point. */
  start: number;
}

/**
 * Courses down from a high point, one per bearing: toward each bay first,
 * then toward the coast the land's axes bound. Each head lies `reach` up
 * from the coast, at least `start` from the high point, and never more than
 * `beyond` past it.
 */
function coursesFrom(
  high: { x: number; y: number },
  bearings: readonly number[],
  params: LandformParams,
  span: CourseSpan
): CourseLine[] {
  const outlets = params.outlets ?? [];
  const offset = Math.hypot(high.x - params.x, high.y - params.y);
  return bearings.map((angle, index) => {
    const outlet = outlets[index];
    const coast = outlet
      ? Math.hypot(outlet.x - high.x, outlet.y - high.y)
      : axisRadius(params, angle) + offset;
    const along = Math.max(
      span.start,
      coast - Math.min(span.reach, coast + span.beyond)
    );
    return {
      angle,
      coast: coast - along,
      headX: high.x + along * Math.cos(angle),
      headY: high.y + along * Math.sin(angle),
    };
  });
}

/** Valleys down from the land's centre, a trunk toward each bay first and then into the gaps. */
function centralValleys(
  params: LandformParams,
  valleys: ValleySettings,
  seed: string,
  settings: LandformSettings
): { courses: CourseLine[]; size: ValleySize } {
  const bearings = drainageBearings(
    params.x,
    params.y,
    params.outlets ?? [],
    valleys.count,
    seed
  );
  return {
    courses: coursesFrom(params, bearings, params, {
      beyond: params.depth * settings.drainage.beyond,
      reach: params.depth * valleys.reach,
      start: 0,
    }),
    size: valleySize(params, valleys, settings),
  };
}

/** Where a volcano's vent sits: part of the way from its strongest hub to the centre. */
function ventOf(
  params: LandformParams,
  settings: LandformSettings["volcanic"]
) {
  const [hub] = params.peaks;
  const pull = hub ? settings.ventPull : 1;
  return {
    x: (hub?.x ?? params.x) + (params.x - (hub?.x ?? params.x)) * pull,
    y: (hub?.y ?? params.y) + (params.y - (hub?.y ?? params.y)) * pull,
  };
}

/**
 * A lobed cone around a vent near the strongest hub, a crater lip at its
 * crown and a parasitic cone down one end of the principal axis. Its
 * barrancos radiate down the flanks from below the summit's tread to the
 * sea, one into each bay first, each opening and cutting its own way.
 */
function volcanic(
  params: LandformParams,
  seed: string,
  settings: LandformSettings
): Sculpture {
  const volcano = settings.volcanic;
  const vent = ventOf(params, volcano);
  const crater = Math.max(1, params.depth * volcano.crater);
  const offset = Math.hypot(vent.x - params.x, vent.y - params.y);
  const cone = Math.max(
    crater + 1,
    Math.max(params.length, params.breadth) * volcano.cone + offset
  );
  const flank = (distance: number) => 1 - (distance - crater) / (cone - crater);
  const lobes = smoothNoise(volcano.lobes.wavelength, `${seed}:lobes`);
  const side = unit(`${seed}:parasite`) < 0.5 ? -1 : 1;
  const parasite = {
    radius: Math.max(4, params.depth * volcano.parasite.radius),
    x:
      params.x + side * params.axis[0] * params.length * volcano.parasite.along,
    y:
      params.y + side * params.axis[1] * params.length * volcano.parasite.along,
  };
  const parasiteTop = Math.min(
    1,
    flank(Math.hypot(parasite.x - vent.x, parasite.y - vent.y)) +
      volcano.parasite.rise
  );
  const relief: Relief = (x, y) => {
    const distance = Math.hypot(x - vent.x, y - vent.y);
    if (distance < crater) {
      const inside = 1 - (distance / crater) ** 2;
      return 1 - volcano.craterDepth * inside * inside;
    }
    const t = Math.hypot(x - parasite.x, y - parasite.y) / parasite.radius;
    const knoll = t < 1 ? parasiteTop * (1 - t * t) ** 2 : 0;
    // The lobes grow from `lip` of their swell at the crater to full a crater radius below it.
    const swell =
      volcano.lobes.amount *
      lobes(x, y) *
      (volcano.lobes.lip +
        (1 - volcano.lobes.lip) * smoothstep((distance - crater) / crater));
    return Math.max(flank(crater + (distance - crater) * (1 - swell)), knoll);
  };
  const { barrancos } = volcano;
  const bearings = drainageBearings(
    vent.x,
    vent.y,
    params.outlets ?? [],
    volcano.valleys.count,
    seed
  );
  const size = valleySize(params, volcano.valleys, settings);
  // The summit's tread spans the top terrace's share of the flank.
  const summit =
    (cone - crater) / Math.max(1, Math.round(volcano.formation.terraces));
  const courses = coursesFrom(vent, bearings, params, {
    beyond: 0,
    reach: Number.POSITIVE_INFINITY,
    start: crater + summit * barrancos.head,
  });
  const valleys = courses.map((course, index) => {
    const lower =
      summit * barrancos.stagger * unit(`${seed}:barranco:${index}`);
    const shallower = barrancos.vary * unit(`${seed}:barranco-depth:${index}`);
    return valleyAlong(
      {
        ...course,
        coast: course.coast - lower,
        headX: course.headX + lower * Math.cos(course.angle),
        headY: course.headY + lower * Math.sin(course.angle),
      },
      { ...size, depth: size.depth * (1 - shallower) },
      params.depth
    );
  });
  return { formation: volcano.formation, relief, valleys };
}

/**
 * A broad top behind escarpments, broken into mesas where the summit falls
 * a terrace, and dissected by branching valleys: a trunk from the high
 * middle toward each bay, each joined halfway down by one tributary.
 */
function plateau(
  params: LandformParams,
  seed: string,
  settings: LandformSettings
): Sculpture {
  const { formation, mesa, tributary, valleys } = settings.plateau;
  const mesas = noiseField(
    { ...mesa, gain: 0.5, lacunarity: 2 },
    `${seed}:mesa`
  );
  const fall = 1 / Math.max(1, Math.round(formation.terraces));
  const relief: Relief = (x, y) =>
    1 -
    fall *
      smoothstep((mesas(x, y) - mesa.threshold) / Math.max(mesa.edge, 1e-3));
  const { courses, size } = centralValleys(params, valleys, seed, settings);
  const branch = {
    ...size,
    depth: size.depth * tributary.size,
    width: size.width * tributary.size,
  };
  const branches = courses.map((trunk, index): Valley => {
    const turn =
      trunk.angle +
      (unit(`${seed}:tributary:${index}`) < 0.5 ? -1 : 1) * tributary.angle;
    const junction = trunk.coast * tributary.junction;
    const length = params.depth * valleys.reach * tributary.length;
    return valleyAlong(
      {
        angle: turn,
        coast: length,
        headX:
          trunk.headX +
          junction * Math.cos(trunk.angle) -
          length * Math.cos(turn),
        headY:
          trunk.headY +
          junction * Math.sin(trunk.angle) -
          length * Math.sin(turn),
      },
      branch,
      size.width
    );
  });
  return {
    formation,
    relief,
    valleys: [
      ...courses.map((trunk) => valleyAlong(trunk, size, params.depth)),
      ...branches,
    ],
  };
}

/**
 * A rim at the formation's reach, falling inland to a low lagoon floor. The
 * rim is a ring of motus: where a noise field of islet-sized blobs passes
 * its threshold the rim stands full, and between the blobs it sinks to
 * sandy saddles.
 */
function atoll(
  params: LandformParams,
  seed: string,
  settings: LandformSettings
): Sculpture {
  const { fall: fallShare, formation, lagoon, motus } = settings.atoll;
  const rim = params.depth * formation.reach;
  const fall = Math.max(1, params.depth * fallShare);
  const islets = smoothNoise(motus.spacing, `${seed}:motus`);
  const relief: Relief = (x, y, inland) => {
    const ring = 1 - (1 - lagoon) * smoothstep((inland - rim) / fall);
    const islet = smoothstep(
      (islets(x, y) - motus.threshold) / Math.max(motus.edge, 1e-3)
    );
    return ring * (motus.saddle + (1 - motus.saddle) * islet);
  };
  return { formation, relief, valleys: [] };
}

/**
 * A crest along the principal axis that wanders from side to side, throws
 * out spurs down each flank in turn, dips through saddles between its
 * peaks and tapers at both ends. Gullies run down both flanks to the sea.
 */
function ridge(
  params: LandformParams,
  seed: string,
  settings: LandformSettings
): Sculpture {
  const shape = settings.ridge;
  const [ax, ay] = params.axis;
  const breadth = Math.max(1, params.breadth);
  const length = Math.max(1, params.length);
  const shoulder = length * shape.shoulder;
  const bendSeed = noiseSeed(`${seed}:ridge-bend`);
  const spurSeed = noiseSeed(`${seed}:ridge-spurs`);
  const saddleSeed = noiseSeed(`${seed}:ridge-saddles`);
  const bendWavelength = Math.max(8, length * shape.bend.wavelength);
  const relief: Relief = (x, y) => {
    const dx = x - params.x;
    const dy = y - params.y;
    const along = dx * ax + dy * ay;
    const across =
      -dx * ay +
      dy * ax -
      shape.bend.amount *
        breadth *
        gradientNoise(along / bendWavelength, 0.5, bendSeed);
    // Each flank reads its own row of the noise, so the spurs alternate.
    const flankRow = across < 0 ? 3.5 : 7.5;
    const spur =
      1 +
      shape.spurs.reach *
        smoothstep(
          gradientNoise(along / shape.spurs.wavelength, flankRow, spurSeed) /
            shape.spurs.edge
        );
    const crest = 1 - (Math.abs(across) / (breadth * spur)) ** shape.section;
    const taper =
      1 - Math.max(0, Math.abs(along) - shoulder) / (length - shoulder + 1);
    const saddle =
      1 -
      shape.undulation.depth *
        0.5 *
        (1 +
          gradientNoise(along / shape.undulation.wavelength, 0.5, saddleSeed));
    return crest * taper * saddle;
  };
  const size = valleySize(params, shape.valleys, settings);
  const { gullies } = shape;
  const perSide = Math.max(1, Math.round(shape.valleys.count / 2));
  const valleys: Valley[] = [];
  for (const side of [-1, 1]) {
    for (let index = 0; index < perSide; index += 1) {
      const nudge =
        gullies.nudge * (unit(`${seed}:gully:${side}:${index}`) - 0.5);
      const along = (2 * ((index + 0.5 + nudge) / perSide) - 1) * shoulder;
      const lean =
        gullies.lean * (unit(`${seed}:gully-lean:${side}:${index}`) - 0.5);
      // Down the flank, normal to the axis, leaning along it.
      const angle = Math.atan2(side * ax + lean * ay, -side * ay + lean * ax);
      valleys.push(
        valleyAlong(
          {
            angle,
            coast: breadth * (1 - gullies.head),
            headX: params.x + along * ax - side * ay * breadth * gullies.head,
            headY: params.y + along * ay + side * ax * breadth * gullies.head,
          },
          size,
          params.depth
        )
      );
    }
  }
  return { formation: shape.formation, relief, valleys };
}

/**
 * Low knolls at the package's hubs over a low base, lobed with the seed, so
 * every piece of land is ground; where two knolls meet, the ground between
 * them is a saddle. A valley runs down toward each of the largest bays.
 */
function cluster(
  params: LandformParams,
  seed: string,
  settings: LandformSettings
): Sculpture {
  const shape = settings.cluster;
  const radius = Math.max(shape.knollMinimum, params.depth * shape.knoll);
  const lobes = smoothNoise(radius * shape.lobes.wavelength, `${seed}:lobes`);
  const knolls = params.peaks.map((peak) => ({
    weight: shape.knollWeight + (1 - shape.knollWeight) * clamp01(peak.weight),
    x: peak.x,
    y: peak.y,
  }));
  const relief: Relief = (x, y) => {
    let highest = shape.base;
    const reach = radius * (1 + shape.lobes.amount * lobes(x, y));
    for (const knoll of knolls) {
      const t = Math.hypot(x - knoll.x, y - knoll.y) / reach;
      if (t < 1) {
        highest = Math.max(highest, knoll.weight * (1 - t * t));
      }
    }
    return highest;
  };
  const { courses, size } = centralValleys(
    params,
    shape.valleys,
    seed,
    settings
  );
  return {
    formation: shape.formation,
    relief,
    valleys: courses.map((course) => valleyAlong(course, size, params.depth)),
  };
}

const fullRelief: Relief = () => 1;

/** One formation's shape and valleys over one island. */
function sculpture(
  archetype: LandformArchetype,
  params: LandformParams,
  seed: string,
  settings: LandformSettings
): Sculpture {
  switch (archetype) {
    case "atoll":
      return atoll(params, seed, settings);
    case "cluster":
      return cluster(params, seed, settings);
    case "plateau":
      return plateau(params, seed, settings);
    case "ridge":
      return ridge(params, seed, settings);
    case "seamount":
      return {
        formation: settings.seamount.formation,
        relief: fullRelief,
        valleys: [],
      };
    case "volcanic":
      return volcanic(params, seed, settings);
    default:
      throw new Error(
        `No landform is defined for ${archetype satisfies never}.`
      );
  }
}

/**
 * One formation's land over one island. Each is the island anatomy over a
 * sculpted relief: a plateau is broad and flat-topped behind wandering
 * escarpments, broken into mesas and cut by branching valleys; a seamount
 * is a low knoll; a volcano is a cone with a crater lip, a parasitic cone
 * and radial barrancos; an atoll is a rim of motus around a low lagoon
 * floor; a ridge is a wandering crest with spurs and saddles and gullies
 * between them; a cluster is lobed knolls at the hubs.
 */
export function archetypeLandform(
  archetype: LandformArchetype,
  params: LandformParams,
  seed: string,
  settings: LandformSettings = defaultLandformSettings
): Landform {
  return sculpted(
    sculpture(archetype, params, seed, settings),
    params,
    seed,
    settings
  );
}

/**
 * Every island's landform, by island id: each built once, seeded by its id.
 * An island without one takes `fallback`, the straight ramp by default.
 */
export function landformFor(
  islands: ReadonlyMap<string, IslandLandform>,
  fallback: Landform = rampLandform(defaultTerrainSettings.land),
  settings: LandformSettings = defaultLandformSettings
): Landform {
  const landforms = new Map(
    [...islands].map(([id, island]) => [
      id,
      archetypeLandform(island.archetype, island.params, id, settings),
    ])
  );
  return (sample) => (landforms.get(sample.islandId) ?? fallback)(sample);
}
