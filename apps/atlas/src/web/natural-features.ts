import type { ChurnReport } from "../lib/types";
import type { BelongingRegion } from "./belonging";
import { streamWidth } from "./codex/bindings";
import { compositionInsideLand } from "./composition-placement";
import { unit } from "./geography";
import { createLandRouter } from "./inland-routing";
import { buildLandmarks, type Landmark } from "./landmarks";
import {
  joinRiver,
  type RiverRun,
  riverBarriers,
  riverRuns,
} from "./river-network";
import type { AtlasFile, Polygon, Territory } from "./types";

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
  mouth: AtlasFile;
  points: FeaturePoint[];
  spring: AtlasFile;
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
  /** Measured relationships omitted from this bounded, crossing-free drawing. */
  unrouted: number;
}

export interface NaturalEvidence {
  churn?:
    | Pick<
        Extract<ChurnReport, { available: true }>,
        "available" | "files" | "history"
      >
    | Extract<ChurnReport, { available: false }>;
  fileIds: Record<string, string>;
  recordedChange?: boolean;
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

function centroid(members: readonly AtlasFile[]): FeaturePoint | undefined {
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
  members: readonly AtlasFile[]
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
  sources: ReadonlySet<string>
): AtlasFile | undefined {
  const byIncoming = (a: AtlasFile, b: AtlasFile) =>
    b.incoming - a.incoming || a.id.localeCompare(b.id);
  const junctions = region.members
    .filter((file) => file.architectureKind === "junction")
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
  mouth: AtlasFile
): AtlasFile | undefined {
  const byDistance = (a: AtlasFile, b: AtlasFile) =>
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
    const mouth = mouthOf(consumer, ids(link.sourceModules));
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
  evidence: NaturalEvidence
): NaturalFeatures {
  const flows = streams(regions, evidence, territory.coast);
  const rivers = riverRuns(flows.streams);
  return {
    changeNote: changeNote(evidence),
    confluences: confluences(rivers),
    landmarks: buildLandmarks(territory, regions, evidence),
    marshes: marshes(regions, evidence, createLandRouter(territory.coast)),
    omitted: flows.omitted,
    rivers,
    streams: flows.streams,
    unrouted: flows.unrouted,
  };
}

function changeNote(evidence: NaturalEvidence): string | undefined {
  if (!evidence.recordedChange) {
    return;
  }
  if (!evidence.churn?.available) {
    return "Recorded change unavailable for this survey; no craters inferred.";
  }
  const { history } = evidence.churn;
  const window = history.since
    ? `${history.since.slice(0, 10)} to ${history.analyzedAt.slice(0, 10)}`
    : `Full recorded history through ${history.analyzedAt.slice(0, 10)}`;
  return `${window}. ${history.historyComplete ? "Complete Git history" : "Partial Git history"}. Craters require at least 3 commits and a commit percentile of 80% or higher among repository files of the same kind. Marks describe change, not defects or live activity.`;
}
