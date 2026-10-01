import { compositionInsideLand } from "./composition-placement";
import { segmentIntersection } from "./feature-geometry";
import type { FeaturePoint } from "./natural-features";
import { directSeaLane, roundSeaLane, smoothSeaLane } from "./sea-lane";
import type { Polygon } from "./types";

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

const distance = (a: FeaturePoint, b: FeaturePoint) =>
  Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Routes over one island's land: a single arc when the land allows it,
 * otherwise a grid path around the coast, smoothed into a continuous stream.
 */
export function createLandRouter(coast: Polygon[]) {
  const shores = coast.flatMap((polygon) =>
    polygon.flatMap((ring) =>
      ring.flatMap((point, i) => {
        const next = ring[(i + 1) % ring.length];
        return next
          ? [
              [
                { x: point[0], y: point[1] },
                { x: next[0], y: next[1] },
              ] as const,
            ]
          : [];
      })
    )
  );
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
    return !shores.some(([c, d]) => segmentIntersection(a, b, c, d));
  };
  const grid = () => {
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
    const landEdges = new Map<number, boolean>();
    const edgeOnLand = (a: number, b: number) => {
      const key = Math.min(a, b) * land.length + Math.max(a, b);
      const known = landEdges.get(key);
      if (known !== undefined) {
        return known;
      }
      const safe = onLand(centre(a), centre(b));
      landEdges.set(key, safe);
      return safe;
    };
    /** Breadth-first over land cells from start until end is reached. */
    const search = (
      start: number,
      end: number,
      clear: (a: FeaturePoint, b: FeaturePoint) => boolean
    ) => {
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
          !land[next] ||
          !edgeOnLand(cell, next) ||
          !clear(centre(cell), centre(next))
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
    const gridPath = (
      from: FeaturePoint,
      to: FeaturePoint,
      clear: (a: FeaturePoint, b: FeaturePoint) => boolean
    ) => {
      const start = cellOf(from),
        end = cellOf(to);
      if (start < 0 || end < 0) {
        return;
      }
      const previous = search(start, end, clear);
      if (previous[end] === -1) {
        return;
      }
      const cells: number[] = [];
      for (let cell = end; cell !== start; cell = previous[cell] ?? start) {
        cells.push(cell);
      }
      return [from, centre(start), ...cells.reverse().map(centre), to];
    };
    return gridPath;
  };
  let gridPath: ReturnType<typeof grid> | undefined;
  return (
    from: FeaturePoint,
    to: FeaturePoint,
    unobstructed: (a: FeaturePoint, b: FeaturePoint) => boolean = () => true,
    downstream?: FeaturePoint
  ) => {
    if (
      distance(from, to) < 0.000_01 ||
      !onLand(from, from) ||
      !onLand(to, to)
    ) {
      return;
    }
    const clear = (a: FeaturePoint, b: FeaturePoint) =>
      unobstructed(a, b) && onLand(a, b);
    const direct =
      (downstream && joiningCurve(from, to, downstream, clear)) ||
      directSeaLane(from, to, clear);
    if (direct) {
      return direct;
    }
    gridPath ??= grid();
    const path = gridPath(from, to, unobstructed);
    if (
      !path?.every((point, i) => i === 0 || clear(path[i - 1] ?? point, point))
    ) {
      return;
    }
    return roundSeaLane(smoothSeaLane(path, clear), clear);
  };
}

/** A tributary approaches in the trunk's direction, making a fork instead of an elbow. */
function joiningCurve(
  from: FeaturePoint,
  to: FeaturePoint,
  downstream: FeaturePoint,
  clear: (a: FeaturePoint, b: FeaturePoint) => boolean
) {
  const length = distance(from, to);
  const tangent = Math.max(0.001, distance(to, downstream));
  for (const bend of [0.4, 0.25, 0.12]) {
    const control = {
      x: to.x - ((downstream.x - to.x) * length * bend) / tangent,
      y: to.y - ((downstream.y - to.y) * length * bend) / tangent,
    };
    const points = Array.from({ length: 33 }, (_, i) => {
      const t = i / 32,
        u = 1 - t;
      return {
        x: u * u * from.x + 2 * u * t * control.x + t * t * to.x,
        y: u * u * from.y + 2 * u * t * control.y + t * t * to.y,
      };
    });
    if (
      points.every(
        (point, i) => i === 0 || clear(points[i - 1] ?? point, point)
      )
    ) {
      return points;
    }
  }
}
