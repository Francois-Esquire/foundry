import type { SpyglassData, SpyglassRoute, Territory } from "../data/types";

type Point = [number, number];

/** Clearance between a dependency line's ends and each coast. */
const linkClearance = 7;
/** Sideways bow of a dependency curve, as a fraction of its length. */
const linkBow = 0.12;

/** A gentle curve over the sea, in world units: a quadratic from `start` through `control` to `end`. */
export interface SeaCurve {
  control: Point;
  end: Point;
  start: Point;
}

export interface DependencyLink extends SeaCurve {
  /** True when the selected package imports from the other; false for a dependent. */
  outgoing: boolean;
  route: SpyglassRoute;
}

/** An island's outer coast points, in world units. */
function outline(territory: Territory): Point[] {
  return territory.coast.flatMap((polygon) =>
    (polygon[0] ?? []).map(
      ([x, y]): Point => [territory.x + x, territory.y + y]
    )
  );
}

/** The point of `territory`'s coast nearest `point`; its centre when it has no coast. */
export function nearestCoast(point: Point, territory: Territory): Point {
  let best: Point = [territory.x, territory.y];
  let distance = Number.POSITIVE_INFINITY;
  for (const q of outline(territory)) {
    const d = (point[0] - q[0]) ** 2 + (point[1] - q[1]) ** 2;
    if (d < distance) {
      distance = d;
      best = q;
    }
  }
  return best;
}

/**
 * The curve from `a` to `b`, each end held back by its clearance and the
 * middle bowed sideways by a share of its length, as selection lines bow.
 */
export function seaCurve(
  a: Point,
  b: Point,
  clearance: { end: number; start: number }
): SeaCurve {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const ux = (b[0] - a[0]) / length;
  const uy = (b[1] - a[1]) / length;
  const start: Point = [
    a[0] + ux * clearance.start,
    a[1] + uy * clearance.start,
  ];
  const end: Point = [b[0] - ux * clearance.end, b[1] - uy * clearance.end];
  const bow = linkBow * Math.max(0, length - clearance.start - clearance.end);
  return {
    control: [
      (start[0] + end[0]) / 2 - uy * bow,
      (start[1] + end[1]) / 2 + ux * bow,
    ],
    end,
    start,
  };
}

/** The nearest pair of points on two islands' coasts, the first on `a`; their centres when either has no coast. */
export function nearestCoasts(a: Territory, b: Territory): [Point, Point] {
  const from = outline(a);
  const to = outline(b);
  let best: [Point, Point] = [
    [a.x, a.y],
    [b.x, b.y],
  ];
  let distance = Number.POSITIVE_INFINITY;
  for (const p of from) {
    for (const q of to) {
      const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2;
      if (d < distance) {
        distance = d;
        best = [p, q];
      }
    }
  }
  return best;
}

const links = new WeakMap<SpyglassData, Map<string, DependencyLink[]>>();

/** Gentle curves between nearest shores; built once per selected package. */
export function dependencyLinks(
  data: SpyglassData,
  selected: string
): DependencyLink[] {
  const cache = links.get(data) ?? new Map<string, DependencyLink[]>();
  links.set(data, cache);
  const cached = cache.get(selected);
  if (cached) {
    return cached;
  }
  const territories = new Map(data.territories.map((t) => [t.id, t]));
  const origin = territories.get(selected);
  const result: DependencyLink[] = [];
  for (const route of data.routes) {
    const outgoing = route.from === selected;
    const other = territories.get(outgoing ? route.to : route.from);
    if (!(origin && other && (outgoing || route.to === selected))) {
      continue;
    }
    const [a, b] = nearestCoasts(origin, other);
    result.push({
      ...seaCurve(a, b, { end: linkClearance, start: linkClearance }),
      outgoing,
      route,
    });
  }
  cache.set(selected, result);
  return result;
}
