import type { BelongingRegion } from "./belonging";
import { lakeRadius, streamWidth } from "./codex/bindings";
import { clearOfCoast, compositionInsideLand } from "./composition-placement";
import { directSeaLane, smoothSeaLane } from "./sea-lane";
import type { AtlasFile, Polygon, Territory } from "./types";

export interface FeaturePoint {
  x: number;
  y: number;
}

/** A shared commons module: every district draws on it. */
export interface Lake {
  file: AtlasFile;
  radius: number;
}

/** A module whose belonging is unresolved, with the districts it could join. */
export interface Marsh {
  /** Points on the way toward each candidate district, nearest first. */
  drains: FeaturePoint[];
  region: BelongingRegion;
  /** Tuft positions inside the marsh, laid out once. */
  tufts: FeaturePoint[];
}

/** Imports from one district into another, drawn on the land between them. */
export interface Stream {
  from: string;
  moduleEdges: number;
  /** The consumer file the stream reaches. */
  mouth: AtlasFile;
  points: FeaturePoint[];
  to: string;
  width: number;
}

/** A file where streams meet: a composition junction or a shared mouth. */
interface Confluence {
  file: AtlasFile;
  streams: number;
}

export interface NaturalFeatures {
  confluences: Confluence[];
  lakes: Lake[];
  marshes: Marsh[];
  streams: Stream[];
  /** District relationships with no land route between their files. */
  unrouted: number;
}

export interface NaturalEvidence {
  fileIds: Record<string, string>;
  relationships: readonly {
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

/** Smallest lake that still reads as water. */
const lakeFloor = 1.6;
const lakeShore = 1;
const tuftSpacing = 2.4;
/** Tufts stay this close to the unresolved file, so a marsh reads as a patch. */
const marshReach = 4;
/** Fraction of the way a marsh drain runs toward its candidate district. */
const drainReach = 0.55;
const drainCandidates = 2;
const streamStep = 2;
/** Land grid cell for stream routing, in map units. */
const routeStep = 3;
const neighbours = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
] as const;

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

function lakes(regions: readonly BelongingRegion[], coast: Polygon[]): Lake[] {
  const seen = new Set<string>();
  const result: Lake[] = [];
  for (const region of regions) {
    for (const file of region.members) {
      if (file.architectureKind !== "commons" || seen.has(file.id)) {
        continue;
      }
      seen.add(file.id);
      let radius = lakeRadius(file.incoming);
      while (
        radius >= lakeFloor &&
        !clearOfCoast(file.x, file.y, coast, radius + lakeShore)
      ) {
        radius -= 0.4;
      }
      if (radius >= lakeFloor) {
        result.push({ file, radius });
      }
    }
  }
  return result.sort((a, b) => a.file.id.localeCompare(b.file.id));
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
      const x = column * tuftSpacing + offset,
        y = row * tuftSpacing;
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
  evidence: NaturalEvidence
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
          return origin && target
            ? [
                {
                  x: origin.x + (target.x - origin.x) * drainReach,
                  y: origin.y + (target.y - origin.y) * drainReach,
                },
              ]
            : [];
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
  return consumers[0] ?? [...region.members].sort(byIncoming)[0];
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
  return suppliers[0] ?? [...region.members].sort(byDistance)[0];
}

/**
 * Routes over one island's land: a single arc when the land allows it,
 * otherwise a grid path around the coast, smoothed into a continuous stream.
 */
function createLandRouter(coast: Polygon[]) {
  const onLand = (a: FeaturePoint, b: FeaturePoint) => {
    const count = Math.ceil(distance(a, b) / streamStep);
    for (let n = 0; n <= count; n += 1) {
      const t = n / Math.max(1, count);
      if (
        !compositionInsideLand(
          a.x + (b.x - a.x) * t,
          a.y + (b.y - a.y) * t,
          coast
        )
      ) {
        return false;
      }
    }
    return true;
  };
  const vertices = coast.flat(2);
  const left = Math.min(...vertices.map(([x]) => x)) - routeStep;
  const top = Math.min(...vertices.map(([, y]) => y)) - routeStep;
  const width = Math.max(
    1,
    Math.ceil((Math.max(...vertices.map(([x]) => x)) - left) / routeStep) + 1
  );
  const height = Math.max(
    1,
    Math.ceil((Math.max(...vertices.map(([, y]) => y)) - top) / routeStep) + 1
  );
  const centre = (cell: number): FeaturePoint => ({
    x: left + ((cell % width) + 0.5) * routeStep,
    y: top + (Math.floor(cell / width) + 0.5) * routeStep,
  });
  const cellOf = (p: FeaturePoint) => {
    const x = Math.floor((p.x - left) / routeStep),
      y = Math.floor((p.y - top) / routeStep);
    return x < 0 || y < 0 || x >= width || y >= height ? -1 : y * width + x;
  };
  const land = new Uint8Array(width * height);
  for (let cell = 0; cell < land.length; cell += 1) {
    const { x, y } = centre(cell);
    land[cell] = compositionInsideLand(x, y, coast) ? 1 : 0;
  }
  /** Breadth-first over land cells from start until end is reached. */
  const search = (start: number, end: number) => {
    const previous = new Int32Array(land.length).fill(-1);
    previous[start] = start;
    const queue = [start];
    const visit = (cell: number, x: number, y: number) => {
      const next = y * width + x;
      if (
        x < 0 ||
        y < 0 ||
        x >= width ||
        y >= height ||
        previous[next] !== -1 ||
        !(land[next] || next === end)
      ) {
        return;
      }
      previous[next] = cell;
      queue.push(next);
    };
    for (let n = 0; n < queue.length && previous[end] === -1; n += 1) {
      const cell = queue[n] ?? start;
      for (const [dx, dy] of neighbours) {
        visit(cell, (cell % width) + dx, Math.floor(cell / width) + dy);
      }
    }
    return previous;
  };
  const gridPath = (from: FeaturePoint, to: FeaturePoint) => {
    const start = cellOf(from),
      end = cellOf(to);
    if (start < 0 || end < 0) {
      return;
    }
    const previous = search(start, end);
    if (previous[end] === -1) {
      return;
    }
    const cells: number[] = [];
    for (let cell = end; cell !== start; cell = previous[cell] ?? start) {
      cells.push(cell);
    }
    return [from, ...cells.reverse().slice(0, -1).map(centre), to];
  };
  return (from: FeaturePoint, to: FeaturePoint) => {
    const direct = directSeaLane(from, to, onLand);
    if (direct) {
      return direct;
    }
    const path = gridPath(from, to);
    return path ? smoothSeaLane(path, onLand) : undefined;
  };
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
  let unrouted = 0;
  const links = [...evidence.relationships].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)
  );
  for (const link of links) {
    const consumer = byId.get(link.from),
      supplier = byId.get(link.to);
    if (!(consumer && supplier) || link.moduleEdges <= 0) {
      continue;
    }
    const ids = (modules: readonly string[]) =>
      new Set(modules.flatMap((module) => evidence.fileIds[module] ?? []));
    const mouth = mouthOf(consumer, ids(link.sourceModules));
    const spring = mouth && springOf(supplier, ids(link.targetModules), mouth);
    if (!(mouth && spring) || spring.id === mouth.id) {
      continue;
    }
    const points = route(spring, mouth);
    if (!points) {
      unrouted += 1;
      continue;
    }
    result.push({
      from: link.from,
      moduleEdges: link.moduleEdges,
      mouth,
      points,
      to: link.to,
      width: streamWidth(link.moduleEdges, strongest),
    });
  }
  return { streams: result, unrouted };
}

function confluences(
  regions: readonly BelongingRegion[],
  flows: readonly Stream[]
): Confluence[] {
  const counts = new Map<string, Confluence>();
  for (const stream of flows) {
    const existing = counts.get(stream.mouth.id);
    if (existing) {
      existing.streams += 1;
    } else {
      counts.set(stream.mouth.id, { file: stream.mouth, streams: 1 });
    }
  }
  for (const region of regions) {
    for (const file of region.members) {
      if (file.architectureKind === "junction" && !counts.has(file.id)) {
        counts.set(file.id, { file, streams: 0 });
      }
    }
  }
  return [...counts.values()]
    .filter(
      (item) => item.streams > 1 || item.file.architectureKind === "junction"
    )
    .sort((a, b) => a.file.id.localeCompare(b.file.id));
}

/**
 * Natural features inside one island, from evidence the map already holds:
 * shared commons become lakes, unresolved belonging becomes marsh with drains
 * toward its candidate districts, district relationships become streams over
 * the land, and junctions or shared mouths become confluences. Coordinates
 * are island-local, like the files and regions they come from. Nothing here
 * moves a file or changes a coastline.
 */
export function naturalFeatures(
  territory: Territory,
  regions: readonly BelongingRegion[],
  evidence: NaturalEvidence
): NaturalFeatures {
  const flows = streams(regions, evidence, territory.coast);
  return {
    confluences: confluences(regions, flows.streams),
    lakes: lakes(regions, territory.coast),
    marshes: marshes(regions, evidence),
    streams: flows.streams,
    unrouted: flows.unrouted,
  };
}
