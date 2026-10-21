import type { IslandGeometry } from "./types";

type Point = [number, number];
interface Shape {
  axes: Point[];
  bounds: [number, number, number, number];
  points: Point[];
}

function cross(a: Point, b: Point, c: Point): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

/** Each land component keeps its own convex envelope, not an island-wide circle. */
function hull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = (ordered: Point[]) => {
    const result: Point[] = [];
    for (const point of ordered) {
      while (result.length >= 2) {
        const a = result.at(-2);
        const b = result.at(-1);
        if (!(a && b) || cross(a, b, point) > 0) {
          break;
        }
        result.pop();
      }
      result.push(point);
    }
    return result.slice(0, -1);
  };
  return [...half(sorted), ...half([...sorted].reverse())];
}

function shape(points: Point[]): Shape {
  const axes: Point[] = points.map((a, index) => {
    const b = points[(index + 1) % points.length] ?? a;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy) || 1;
    return [-dy / length, dx / length];
  });
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return {
    axes,
    bounds: [
      Math.min(...xs),
      Math.min(...ys),
      Math.max(...xs),
      Math.max(...ys),
    ],
    points,
  };
}

function shapes(island: IslandGeometry): Shape[] {
  const coasts = island.coast
    .map((polygon) => hull(polygon[0] ?? []))
    .filter((points) => points.length >= 3);
  if (coasts.length) {
    return coasts.map(shape);
  }
  // A circumscribed fallback preserves the radius when coastline data is absent.
  const radius = island.radius / Math.cos(Math.PI / 24);
  return [
    shape(
      Array.from({ length: 24 }, (_, i): Point => {
        const angle = (i * Math.PI) / 12;
        return [Math.cos(angle) * radius, Math.sin(angle) * radius];
      })
    ),
  ];
}

function projection(points: Point[], axis: Point): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const [x, y] of points) {
    const value = x * axis[0] + y * axis[1];
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return [min, max];
}

/** Minimum separating translation for two land envelopes, including a water gap. */
function separation(
  a: Shape,
  b: Shape,
  dx: number,
  dy: number,
  gap: number
): Point | undefined {
  if (
    a.bounds[2] + gap <= b.bounds[0] + dx ||
    b.bounds[2] + dx + gap <= a.bounds[0] ||
    a.bounds[3] + gap <= b.bounds[1] + dy ||
    b.bounds[3] + dy + gap <= a.bounds[1]
  ) {
    return undefined;
  }
  let minimum = Number.POSITIVE_INFINITY;
  let direction: Point = [0, 0];
  for (const axis of [...a.axes, ...b.axes]) {
    const [aMin, aMax] = projection(a.points, axis);
    const [bMin, bMax] = projection(b.points, axis);
    const offset = dx * axis[0] + dy * axis[1];
    const positive = aMax - bMin - offset + gap;
    const negative = bMax + offset - aMin + gap;
    if (positive <= 0 || negative <= 0) {
      return undefined;
    }
    const amount = Math.min(positive, negative);
    if (amount < minimum) {
      minimum = amount;
      const sign = positive <= negative ? 1 : -1;
      direction = [axis[0] * sign, axis[1] * sign];
    }
  }
  return [direction[0] * minimum, direction[1] * minimum];
}

/** Shelves can overlap freely; only land components participate in collisions. */
export function createCoastSeparation(
  islands: readonly IslandGeometry[],
  gap: number
): () => number {
  const prepared = islands.map((island) => ({
    island,
    shapes: shapes(island),
  }));
  return () => {
    let maximum = 0;
    for (const [index, a] of prepared.entries()) {
      for (const b of prepared.slice(index + 1)) {
        for (const first of a.shapes) {
          for (const second of b.shapes) {
            const shift = separation(
              first,
              second,
              b.island.x - a.island.x,
              b.island.y - a.island.y,
              gap
            );
            if (!shift) {
              continue;
            }
            maximum = Math.max(maximum, Math.hypot(...shift));
            a.island.x -= shift[0] * 0.5;
            a.island.y -= shift[1] * 0.5;
            b.island.x += shift[0] * 0.5;
            b.island.y += shift[1] * 0.5;
          }
        }
      }
    }
    return maximum;
  };
}
