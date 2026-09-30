import { streamWidth } from "./codex/bindings";
import { segmentIntersection } from "./feature-geometry";
import type { FeaturePoint, Stream } from "./natural-features";

export interface RiverRun {
  moduleEdges: number;
  points: FeaturePoint[];
  streams: Stream[];
  width: number;
}

const distance = (a: FeaturePoint, b: FeaturePoint) =>
  Math.hypot(a.x - b.x, a.y - b.y);
const key = (p: FeaturePoint) => `${p.x},${p.y}`;

/** A shared run is drawn once, carrying precisely its contributing evidence. */
function riverEdges(streams: Stream[]) {
  const edges = new Map<string, RiverRun>();
  for (const stream of streams) {
    for (let i = 1; i < stream.points.length; i += 1) {
      const a = stream.points[i - 1];
      const b = stream.points[i];
      if (!(a && b) || distance(a, b) < 0.000_01) {
        continue;
      }
      const id = `${key(a)}>${key(b)}`;
      const edge = edges.get(id) ?? {
        moduleEdges: 0,
        points: [a, b],
        streams: [],
        width: 0,
      };
      edge.moduleEdges += stream.moduleEdges;
      edge.streams.push(stream);
      edges.set(id, edge);
    }
  }
  return edges;
}

export function riverRuns(streams: Stream[]): RiverRun[] {
  const edges = riverEdges(streams);
  const strongest = Math.max(
    1,
    ...[...edges.values()].map((edge) => edge.moduleEdges)
  );
  const starts = new Map<string, RiverRun[]>();
  const ends = new Map<string, number>();
  for (const edge of edges.values()) {
    const [a, b] = edge.points;
    if (!(a && b)) {
      continue;
    }
    const group = starts.get(key(a)) ?? [];
    group.push(edge);
    starts.set(key(a), group);
    ends.set(key(b), (ends.get(key(b)) ?? 0) + 1);
    edge.width = streamWidth(edge.moduleEdges, strongest);
  }
  const used = new Set<RiverRun>();
  const runs: RiverRun[] = [];
  for (const edge of edges.values()) {
    if (used.has(edge)) {
      continue;
    }
    used.add(edge);
    const points = [...edge.points];
    let end = points.at(-1);
    while (
      end &&
      ends.get(key(end)) === 1 &&
      starts.get(key(end))?.length === 1
    ) {
      const next = starts.get(key(end))?.[0];
      if (!next || used.has(next) || next.moduleEdges !== edge.moduleEdges) {
        break;
      }
      used.add(next);
      points.push(...next.points.slice(1));
      end = points.at(-1);
    }
    runs.push({ ...edge, points });
  }
  return runs;
}

/** Join a tributary to an existing mouth's route, sharing its exact downstream points. */
export function joinRiver(
  spring: FeaturePoint,
  mouth: FeaturePoint,
  existing: Stream[],
  route: (
    a: FeaturePoint,
    b: FeaturePoint,
    downstream?: FeaturePoint
  ) => FeaturePoint[] | undefined
) {
  const options: { cost: number; suffix: FeaturePoint[] }[] = [];
  for (const stream of existing) {
    let downstream = 0;
    for (let i = stream.points.length - 2; i > 0; i -= 1) {
      const point = stream.points[i];
      const next = stream.points[i + 1];
      if (!(point && next)) {
        continue;
      }
      downstream += distance(point, next);
      // Keep a real downstream trunk, not a fan of lines at the mouth.
      if (downstream < distance(spring, mouth) * 0.18 || i % 3 !== 0) {
        continue;
      }
      options.push({
        cost: distance(spring, point) + downstream * 0.45,
        suffix: stream.points.slice(i),
      });
    }
  }
  options.sort((a, b) => a.cost - b.cost);
  for (const option of options.slice(0, 8)) {
    const [join] = option.suffix;
    if (!join) {
      continue;
    }
    const branch = route(spring, join, option.suffix[1]);
    if (branch) {
      return [...branch.slice(0, -1), ...option.suffix];
    }
  }
  return route(spring, mouth);
}

/** Spatial buckets keep river collision checks local during land searches. */
export function riverBarriers() {
  const size = 8;
  const buckets = new Map<string, [FeaturePoint, FeaturePoint][]>();
  const cells = (a: FeaturePoint, b: FeaturePoint) => {
    const result: string[] = [];
    for (
      let x = Math.floor(Math.min(a.x, b.x) / size);
      x <= Math.floor(Math.max(a.x, b.x) / size);
      x += 1
    ) {
      for (
        let y = Math.floor(Math.min(a.y, b.y) / size);
        y <= Math.floor(Math.max(a.y, b.y) / size);
        y += 1
      ) {
        result.push(`${x},${y}`);
      }
    }
    return result;
  };
  return {
    add(points: FeaturePoint[]) {
      for (let i = 1; i < points.length; i += 1) {
        const a = points[i - 1],
          b = points[i];
        if (!(a && b)) {
          continue;
        }
        for (const cell of cells(a, b)) {
          const entries = buckets.get(cell) ?? [];
          entries.push([a, b]);
          buckets.set(cell, entries);
        }
      }
    },
    clear(a: FeaturePoint, b: FeaturePoint, terminals: FeaturePoint[]) {
      for (const cell of cells(a, b)) {
        for (const [c, d] of buckets.get(cell) ?? []) {
          const intersection = segmentIntersection(a, b, c, d);
          if (
            intersection &&
            !terminals.some(
              (terminal) => distance(terminal, intersection) < 0.000_01
            )
          ) {
            return false;
          }
        }
      }
      return true;
    },
  };
}
