import type { FileRole } from "../../lib/lenses/file-roles-types";
import type { FrequentChangeGate } from "../../lib/lenses/frequent-change-types";
import { unit } from "../../lib/visualization/geography";
import { streamWidth } from "../data/bindings";
import type { Polygon, SpyglassFile, Territory } from "../data/types";
import type { BelongingRegion } from "./belonging";
import { compositionInsideLand } from "./composition-placement";
import { createLandRouter } from "./inland-routing";
import type { FrequentChangeEvidence } from "./internals";
import { buildLandmarks, type Landmark } from "./landmarks";
import {
  joinRiver,
  type RiverRun,
  riverBarriers,
  riverRuns,
} from "./river-network";

export interface FeaturePoint {
  x: number;
  y: number;
}

/** A module whose belonging is unresolved, with the districts it could join. */
export interface Marsh {
  /** Recorded candidates with partial land routes, never assignments. */
  drains: { candidate: string; points: FeaturePoint[] }[];
  region: BelongingRegion;
  /** Tuft positions inside the marsh, laid out once. */
  tufts: FeaturePoint[];
}

/** Imports from one district into another, drawn on the land between them. */
export interface Stream {
  consumerLabel: string;
  from: string;
  moduleEdges: number;
  /** The consumer file the stream reaches. */
  mouth: SpyglassFile;
  points: FeaturePoint[];
  spring: SpyglassFile;
  supplierLabel: string;
  symbols: readonly { name: string; importSites: number }[];
  to: string;
  width: number;
}

/** A geometric fork where tributaries join an actual shared downstream run. */
interface Confluence extends FeaturePoint {
  streams: number;
}

export interface NaturalFeatures {
  changeNote?: string;
  confluences: Confluence[];
  landmarks: Landmark[];
  marshes: Marsh[];
  omitted: {
    from: string;
    to: string;
    moduleEdges: number;
    reason: "land" | "crossing" | "endpoints";
  }[];
  rivers: RiverRun[];
  streams: Stream[];
  streamsEnabled?: boolean;
  /** Measured relationships omitted from this bounded, crossing-free drawing. */
  unrouted: number;
}

export interface NaturalEvidence {
  fileIds: Record<string, string>;
  /** The `file-roles` lens's roles bound to the island, by file id. */
  fileRoles: Readonly<Record<string, FileRole>>;
  /** Recorded change for the island; absent while the layer is off. */
  frequentChange?: FrequentChangeEvidence;
  relationships: readonly {
    dominantSymbols?: readonly {
      name: string;
      importSites: number;
      symbolId?: string;
    }[];
    from: string;
    moduleEdges: number;
    sourceModules: readonly string[];
    targetModules: readonly string[];
    to: string;
  }[];
  unresolved: readonly {
    candidates: readonly { region: string }[];
    module: string;
  }[];
}

const tuftSpacing = 3.8;
/** Tufts stay this close to the unresolved file, so a marsh reads as a patch. */
const marshReach = 4;
/** Fraction of the way a marsh drain runs toward its candidate district. */
const drainReach = 0.55;
const drainCandidates = 2;

function centroid(members: readonly SpyglassFile[]): FeaturePoint | undefined {
  if (!members.length) {
    return undefined;
  }
  return {
    x: members.reduce((sum, file) => sum + file.x, 0) / members.length,
    y: members.reduce((sum, file) => sum + file.y, 0) / members.length,
  };
}

function distance(a: FeaturePoint, b: FeaturePoint) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function tuftsInside(
  polygons: Polygon[],
  members: readonly SpyglassFile[]
): FeaturePoint[] {
  const points = polygons.flat(2);
  if (!points.length) {
    return [];
  }
  const xs = points.map(([x]) => x),
    ys = points.map(([, y]) => y);
  const tufts: FeaturePoint[] = [];
  for (
    let row = Math.ceil(Math.min(...ys) / tuftSpacing);
    row <= Math.floor(Math.max(...ys) / tuftSpacing);
    row += 1
  ) {
    const offset = Math.abs(row % 2) * (tuftSpacing / 2);
    for (
      let column = Math.ceil((Math.min(...xs) - offset) / tuftSpacing);
      column <= Math.floor((Math.max(...xs) - offset) / tuftSpacing);
      column += 1
    ) {
      const x =
          column * tuftSpacing +
          offset +
          (unit(`${column}:${row}:x`) - 0.5) * 1.4,
        y = row * tuftSpacing + (unit(`${column}:${row}:y`) - 0.5) * 1.4;
      if (
        compositionInsideLand(x, y, polygons) &&
        members.some((file) => distance(file, { x, y }) <= marshReach)
      ) {
        tufts.push({ x, y });
      }
    }
  }
  return tufts;
}

function marshes(
  regions: readonly BelongingRegion[],
  evidence: NaturalEvidence,
  route: ReturnType<typeof createLandRouter>
): Marsh[] {
  const byId = new Map(regions.map((region) => [region.id, region]));
  const ambiguity = new Map(
    evidence.unresolved.map((item) => [`unresolved:${item.module}`, item])
  );
  return regions
    .filter((region) => region.uncertain && !region.collection)
    .map((region) => {
      const origin = centroid(region.members);
      const drains = (ambiguity.get(region.id)?.candidates ?? [])
        .slice(0, drainCandidates)
        .flatMap((candidate) => {
          const target = centroid(byId.get(candidate.region)?.members ?? []);
          if (!(origin && target)) {
            return [];
          }
          const points = route(origin, target);
          if (!points) {
            return [];
          }
          return [
            {
              candidate: candidate.region,
              points: points.slice(
                0,
                Math.max(2, Math.ceil(points.length * drainReach))
              ),
            },
          ];
        });
      return {
        drains,
        region,
        tufts: tuftsInside(region.polygons, region.members),
      };
    });
}

function mouthOf(
  region: BelongingRegion,
  sources: ReadonlySet<string>,
  fileRoles: NaturalEvidence["fileRoles"]
): SpyglassFile | undefined {
  const byIncoming = (a: SpyglassFile, b: SpyglassFile) =>
    b.incoming - a.incoming || a.id.localeCompare(b.id);
  const junctions = region.members
    .filter((file) => fileRoles[file.id] === "junction")
    .sort(
      (a, b) =>
        Number(sources.has(b.id)) - Number(sources.has(a.id)) ||
        byIncoming(a, b)
    );
  if (junctions[0]) {
    return junctions[0];
  }
  const consumers = region.members
    .filter((file) => sources.has(file.id))
    .sort(byIncoming);
  return consumers[0];
}

function springOf(
  region: BelongingRegion,
  targets: ReadonlySet<string>,
  mouth: SpyglassFile
): SpyglassFile | undefined {
  const byDistance = (a: SpyglassFile, b: SpyglassFile) =>
    distance(a, mouth) - distance(b, mouth) || a.id.localeCompare(b.id);
  const suppliers = region.members
    .filter((file) => targets.has(file.id))
    .sort(byDistance);
  return suppliers[0];
}

function streams(
  regions: readonly BelongingRegion[],
  evidence: NaturalEvidence,
  coast: Polygon[]
) {
  const byId = new Map(regions.map((region) => [region.id, region]));
  const route = createLandRouter(coast);
  const strongest = Math.max(
    1,
    ...evidence.relationships.map((link) => link.moduleEdges)
  );
  const result: Stream[] = [];
  const barriers = riverBarriers();
  const omitted: NaturalFeatures["omitted"] = [];
  const links = [...evidence.relationships].sort(
    (a, b) =>
      b.moduleEdges - a.moduleEdges ||
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to)
  );
  for (const link of links) {
    const consumer = byId.get(link.from),
      supplier = byId.get(link.to);
    if (link.moduleEdges <= 0) {
      continue;
    }
    if (!(consumer && supplier)) {
      omitted.push({ ...link, reason: "endpoints" });
      continue;
    }
    const ids = (modules: readonly string[]) =>
      new Set(modules.flatMap((module) => evidence.fileIds[module] ?? []));
    const mouth = mouthOf(
      consumer,
      ids(link.sourceModules),
      evidence.fileRoles
    );
    const spring = mouth && springOf(supplier, ids(link.targetModules), mouth);
    if (!(mouth && spring) || spring.id === mouth.id) {
      omitted.push({ ...link, reason: "endpoints" });
      continue;
    }
    const points = joinRiver(
      spring,
      mouth,
      result.filter((stream) => stream.mouth.id === mouth.id),
      (a, b, downstream) =>
        route(a, b, (c, d) => barriers.clear(c, d, [a, b]), downstream)
    );

    const direct = route(spring, mouth);
    const length = (path: FeaturePoint[]) =>
      path.reduce(
        (sum, point, i) =>
          sum + (i ? distance(path[i - 1] ?? point, point) : 0),
        0
      );
    if (!points || (direct && length(points) > length(direct) * 1.7)) {
      omitted.push({
        ...link,
        reason: direct ? "crossing" : "land",
      });
      continue;
    }
    barriers.add(points);
    result.push({
      consumerLabel: consumer.label,
      from: link.from,
      moduleEdges: link.moduleEdges,
      mouth,
      points,
      spring,
      supplierLabel: supplier.label,
      symbols: link.dominantSymbols ?? [],
      to: link.to,
      width: streamWidth(link.moduleEdges, strongest),
    });
  }
  return {
    omitted,
    streams: result.sort(
      (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)
    ),
    unrouted: omitted.length,
  };
}

function confluences(runs: RiverRun[]): Confluence[] {
  const ends = new Map<
    string,
    { point: FeaturePoint; incoming: number; streams: number }
  >();
  const starts = new Set(
    runs.flatMap((run) =>
      run.points[0] ? [`${run.points[0].x},${run.points[0].y}`] : []
    )
  );
  for (const run of runs) {
    const point = run.points.at(-1);
    if (!point) {
      continue;
    }
    const id = `${point.x},${point.y}`;
    const item = ends.get(id) ?? { incoming: 0, point, streams: 0 };
    item.incoming += 1;
    item.streams += run.streams.length;
    ends.set(id, item);
  }
  return [...ends]
    .filter(([id, item]) => item.incoming > 1 && starts.has(id))
    .map(([, item]) => ({ ...item.point, streams: item.streams }));
}

/**
 * Natural features inside one island, from evidence the map already holds:
 * shared commons become landmarks, unresolved belonging becomes marsh with drains
 * toward its candidate districts, district relationships become streams over
 * the land, and joined tributaries form confluences. Coordinates
 * are island-local, like the files and regions they come from. Nothing here
 * moves a file or changes a coastline.
 */
export function naturalFeatures(
  territory: Territory,
  regions: readonly BelongingRegion[],
  evidence: NaturalEvidence,
  streamsEnabled = true
): NaturalFeatures {
  const flows = streamsEnabled
    ? streams(regions, evidence, territory.coast)
    : { omitted: [], streams: [], unrouted: 0 };
  const rivers = riverRuns(flows.streams);
  return {
    changeNote: changeNote(evidence),
    confluences: confluences(rivers),
    landmarks: buildLandmarks(territory, regions, evidence),
    marshes: marshes(regions, evidence, createLandRouter(territory.coast)),
    omitted: flows.omitted,
    rivers,
    streams: flows.streams,
    streamsEnabled,
    unrouted: flows.unrouted,
  };
}

/** A 0–1 share as an English ordinal percentile: 0.92 is "92nd". */
export function percentileOrdinal(share: number): string {
  const n = Math.round(share * 100);
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? "th" : (["th", "st", "nd", "rd"][n % 10] ?? "th");
  return `${n}${suffix}`;
}

/** The frequent-change gate in words, from the values the lens applied. */
function frequentChangeRule(gate: FrequentChangeGate): string {
  return `${gate.eligibleKinds.join(", ")} files at or above the ${percentileOrdinal(gate.minCommitPercentile)} commit percentile among workspace files of the same kind`;
}

function changeNote(evidence: NaturalEvidence): string | undefined {
  const change = evidence.frequentChange;
  if (!change) {
    return;
  }
  if (!change.available) {
    return change.reason === "not-saved"
      ? "Run spyglass scan again to include recorded change."
      : "Recorded change unavailable for this survey.";
  }
  const { history } = change;
  const window = history.since
    ? `${history.since.slice(0, 10)} to ${history.analyzedAt.slice(0, 10)}`
    : `Full recorded history through ${history.analyzedAt.slice(0, 10)}`;
  return `${window}. ${history.historyComplete ? "Complete Git history" : "Partial Git history"}. Frequent change marks ${frequentChangeRule(change.gate)}, the hotspot commit gate. Counts describe recorded change, not defects or live activity.`;
}
