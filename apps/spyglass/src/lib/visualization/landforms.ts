import { unit } from "./geography";
import {
  geologyLevels,
  type Landform,
  type LandformArchetype,
  rampLandform,
} from "./geology";
import { defaultTerrainSettings } from "./terrain";

/**
 * Landforms: the shape each island's land takes above the water. A package
 * is classified into one formation from what is true of it, and the
 * formation is built on one island anatomy: a beach, terraces separated by
 * escarpments, and a summit plateau. Every landform is 0 at the coast, at
 * most `geologyLevels.land`, and continuous by construction: a shape's
 * relief is capped by the island's own inland relief, so no shape lifts the
 * shore.
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
  /** Share of the island's depth at which the summit plateau begins. */
  reach: number;
  /** Share of each terrace step that is its escarpment. */
  riser: number;
  /** 0 is flat treads, 1 the straight ramp. */
  softness: number;
  /** Terrace steps between the beach and the summit. */
  terraces: number;
}

export const defaultLandformSettings = {
  atoll: {
    /** Share of the island's depth over which the rim falls to the lagoon floor. */
    fall: 0.3,
    formation: {
      height: 0.62,
      reach: 0.38,
      riser: 0.3,
      softness: 0.12,
      terraces: 2,
    },
    /**
     * Relief of the lagoon floor, 0 to 1: at 0 it is the beach bench, a
     * flat of pale sand inside the rim, still above the water.
     */
    lagoon: 0,
  },
  /**
   * Beach: a flat bench at the waterline, `width` map units deep and
   * `height` a share of `geologyLevels.land` high. Its seaward face rises
   * over the first `lip` share of the width; the rest is level sand up to
   * the foot of the first escarpment.
   */
  beach: { height: 0.04, lip: 0.4, width: 4 },
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
  },
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
  },
  ridge: {
    formation: {
      height: 0.92,
      reach: 0.8,
      riser: 0.3,
      softness: 0.12,
      terraces: 3,
    },
    /** Share of the land's half length the crest holds before it tapers. */
    shoulder: 0.45,
    /** Relief of the crest's undulation along the axis, 0 to 1. */
    undulation: 0.12,
  },
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

/** A height function of relief and inland distance, as a profile resolves its parameters. */
interface Anatomy {
  /** Elevation at an inland distance, with relief 0 to 1 already capped by the inland's. */
  elevation(inland: number, relief: number): number;
  /** Relief 0 to 1 that the inland distance alone allows. */
  inlandRelief(inland: number): number;
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

function anatomy(params: TerracedProfileParams): Anatomy {
  const height = Math.min(geologyLevels.land, Math.max(0, params.height));
  const reach = Math.max(params.reach, 1e-3);
  const beach = Math.min(Math.max(params.beach, 0), reach * 0.4);
  const beachHeight = Math.min(height, Math.max(0, params.beachHeight));
  const step = (reach - beach) / Math.max(1, Math.round(params.terraces));
  const riser = Math.min(
    1,
    Math.max(params.riser, params.minimumRiser / Math.max(step, 1e-6))
  );
  const face = beach * clamp01(params.beachLip);
  const lip = (inland: number) =>
    face > 0
      ? beachHeight * smoothstep(inland / face)
      : beachHeight * Number(inland > 0);
  return {
    elevation: (inland, relief) =>
      lip(inland) +
      (height - beachHeight) *
        terrace(relief, params.terraces, riser, params.softness),
    inlandRelief: (inland) => clamp01((inland - beach) / (reach - beach)),
  };
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
  const { elevation, inlandRelief } = anatomy(params);
  return (inland) => {
    const at = Math.max(0, inland);
    return elevation(at, inlandRelief(at));
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

/** Relief 0 to 1 at a map position, before the inland cap. */
type Relief = (x: number, y: number, inland: number) => number;

function shaped(profile: TerracedProfileParams, relief: Relief): Landform {
  const { elevation, inlandRelief } = anatomy(profile);
  return ({ inland, x, y }) => {
    const at = Math.max(0, inland);
    const capped = Math.min(clamp01(relief(x, y, at)), inlandRelief(at));
    return Math.min(geologyLevels.land, Math.max(0, elevation(at, capped)));
  };
}

/** A broad cone around a vent near the strongest hub, with a crater lip at its crown. */
function volcanicRelief(
  params: LandformParams,
  settings: LandformSettings["volcanic"]
): Relief {
  const [hub] = params.peaks;
  const pull = hub ? settings.ventPull : 1;
  const ventX = (hub?.x ?? params.x) + (params.x - (hub?.x ?? params.x)) * pull;
  const ventY = (hub?.y ?? params.y) + (params.y - (hub?.y ?? params.y)) * pull;
  const crater = Math.max(1, params.depth * settings.crater);
  const offset = Math.hypot(ventX - params.x, ventY - params.y);
  const cone = Math.max(
    crater + 1,
    Math.max(params.length, params.breadth) + offset
  );
  return (x, y) => {
    const distance = Math.hypot(x - ventX, y - ventY);
    if (distance < crater) {
      const inside = 1 - (distance / crater) ** 2;
      return 1 - settings.craterDepth * inside * inside;
    }
    return 1 - (distance - crater) / (cone - crater);
  };
}

/** A rim at the formation's reach, falling inland to a low lagoon floor. */
function atollRelief(
  params: LandformParams,
  settings: LandformSettings["atoll"]
): Relief {
  const rim = params.depth * settings.formation.reach;
  const fall = Math.max(1, params.depth * settings.fall);
  return (_x, _y, inland) =>
    1 - (1 - settings.lagoon) * smoothstep((inland - rim) / fall);
}

/** A crest along the principal axis, tapering at both ends and undulating with the seed. */
function ridgeRelief(
  params: LandformParams,
  seed: string,
  settings: LandformSettings["ridge"]
): Relief {
  const [ax, ay] = params.axis;
  const breadth = Math.max(1, params.breadth);
  const length = Math.max(1, params.length);
  const shoulder = length * settings.shoulder;
  const cycles = 1 + unit(`${seed}:ridge-cycles`);
  const phase = 2 * Math.PI * unit(`${seed}:ridge-phase`);
  return (x, y) => {
    const dx = x - params.x;
    const dy = y - params.y;
    const along = dx * ax + dy * ay;
    const across = Math.abs(-dx * ay + dy * ax);
    const crest = 1 - across / breadth;
    const taper =
      1 - Math.max(0, Math.abs(along) - shoulder) / (length - shoulder + 1);
    const wave =
      0.5 * (1 + Math.sin((Math.PI * cycles * along) / length + phase));
    return crest * taper * (1 - settings.undulation * wave);
  };
}

/** Low knolls at the package's hubs over a low base, so every piece of land is ground. */
function clusterRelief(
  params: LandformParams,
  settings: LandformSettings["cluster"]
): Relief {
  const radius = Math.max(settings.knollMinimum, params.depth * settings.knoll);
  const knolls = params.peaks.map((peak) => ({
    weight:
      settings.knollWeight + (1 - settings.knollWeight) * clamp01(peak.weight),
    x: peak.x,
    y: peak.y,
  }));
  return (x, y) => {
    let relief = settings.base;
    for (const knoll of knolls) {
      const t = Math.hypot(x - knoll.x, y - knoll.y) / radius;
      if (t < 1) {
        const bump = (1 - t * t) ** 2;
        relief = Math.max(relief, knoll.weight * bump);
      }
    }
    return relief;
  };
}

const fullRelief: Relief = () => 1;

/**
 * One formation's land over one island. Each is the island anatomy with a
 * formation's relief capped by the inland relief: a plateau is the anatomy
 * itself, broad and flat-topped behind steep escarpments; a seamount is a
 * low one; a volcano is a cone with a crater lip; an atoll is a rim around a
 * low lagoon floor; a ridge is a crest along the principal axis; a cluster
 * is low knolls at the hubs.
 */
export function archetypeLandform(
  archetype: LandformArchetype,
  params: LandformParams,
  seed: string,
  settings: LandformSettings = defaultLandformSettings
): Landform {
  const profile = (formation: FormationSettings) =>
    profileParams(formation, params, seed, settings);
  switch (archetype) {
    case "atoll":
      return shaped(
        profile(settings.atoll.formation),
        atollRelief(params, settings.atoll)
      );
    case "cluster":
      return shaped(
        profile(settings.cluster.formation),
        clusterRelief(params, settings.cluster)
      );
    case "plateau":
      return shaped(profile(settings.plateau.formation), fullRelief);
    case "ridge":
      return shaped(
        profile(settings.ridge.formation),
        ridgeRelief(params, seed, settings.ridge)
      );
    case "seamount":
      return shaped(profile(settings.seamount.formation), fullRelief);
    case "volcanic":
      return shaped(
        profile(settings.volcanic.formation),
        volcanicRelief(params, settings.volcanic)
      );
    default:
      throw new Error(
        `No landform is defined for ${archetype satisfies never}.`
      );
  }
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
