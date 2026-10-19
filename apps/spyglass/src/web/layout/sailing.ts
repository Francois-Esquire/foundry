import type { Polygon, SpyglassData } from "../data/types";
import { insidePolygons, type MapPoint } from "./polygons";

export interface BoatPose extends MapPoint {
  /** Clockwise radians from east in the chart's x-right, y-south coordinates. */
  heading: number;
}

/** Encloses the hull at every heading, so turning never clips the shore. */
export const boatRadius = 6;
export const sailingSpeed = 24;
const maximumStepSeconds = 0.05;

interface Segment {
  a: MapPoint;
  b: MapPoint;
}

function pointDistance(point: MapPoint, { a, b }: Segment): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(
    0,
    Math.min(
      1,
      ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy || 1)
    )
  );
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
}

function cross(a: MapPoint, b: MapPoint, c: MapPoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/** Capsule/edge collision catches shores crossed between safe endpoints. */
function segmentDistance(first: Segment, second: Segment): number {
  const firstA = cross(first.a, first.b, second.a);
  const firstB = cross(first.a, first.b, second.b);
  const secondA = cross(second.a, second.b, first.a);
  const secondB = cross(second.a, second.b, first.b);
  if (firstA * firstB < 0 && secondA * secondB < 0) {
    return 0;
  }
  return Math.min(
    pointDistance(first.a, second),
    pointDistance(first.b, second),
    pointDistance(second.a, first),
    pointDistance(second.b, first)
  );
}

function obstacle(polygon: Polygon) {
  const segments: Segment[] = [];
  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const ring of polygon) {
    for (let index = 0; index < ring.length; index += 1) {
      const a = ring[index];
      const b = ring[(index + 1) % ring.length];
      if (!(a && b)) {
        continue;
      }
      left = Math.min(left, a[0]);
      right = Math.max(right, a[0]);
      top = Math.min(top, a[1]);
      bottom = Math.max(bottom, a[1]);
      segments.push({ a: { x: a[0], y: a[1] }, b: { x: b[0], y: b[1] } });
    }
  }
  return { bottom, left, polygon, right, segments, top };
}

function* spawnCandidates(
  center: MapPoint,
  reach: number,
  xLimit: number,
  yLimit: number
): Generator<MapPoint> {
  yield center;
  // Expanding rings find nearby water without tying spawn to island order.
  for (let radius = boatRadius * 2; radius < reach; radius *= 1.3) {
    const samples = Math.min(
      128,
      Math.ceil((Math.PI * 2 * radius) / boatRadius)
    );
    for (let index = 0; index < samples; index += 1) {
      const angle = (Math.PI * 2 * index) / samples - Math.PI / 2;
      yield {
        x: center.x + Math.cos(angle) * radius,
        y: center.y + Math.sin(angle) * radius,
      };
    }
  }
  // A packed map may leave only the sea margin; check its corners and edges.
  for (const x of [-xLimit, 0, xLimit]) {
    for (const y of [-yLimit, 0, yLimit]) {
      yield { x, y };
    }
  }
}

/** Coast data is fixed for a sailing session; visibility never changes collision geography. */
export function createSailing(
  data: Pick<SpyglassData, "territories">,
  bounds: { width: number; height: number },
  additionalLand: readonly Polygon[] = []
) {
  const obstacles = [
    ...data.territories.flatMap((territory) =>
      territory.coast.map((polygon) =>
        polygon.map((ring) =>
          ring.map(([x, y]): [number, number] => [
            x + territory.x,
            y + territory.y,
          ])
        )
      )
    ),
    ...additionalLand,
  ].map(obstacle);
  const xLimit = bounds.width / 2 - boatRadius;
  const yLimit = bounds.height / 2 - boatRadius;
  const insideSea = (point: MapPoint) =>
    Math.abs(point.x) <= xLimit && Math.abs(point.y) <= yLimit;
  const clearPassage = (from: MapPoint, to: MapPoint): boolean => {
    if (!(insideSea(from) && insideSea(to))) {
      return false;
    }
    for (const land of obstacles) {
      if (
        Math.max(from.x, to.x) + boatRadius < land.left ||
        Math.min(from.x, to.x) - boatRadius > land.right ||
        Math.max(from.y, to.y) + boatRadius < land.top ||
        Math.min(from.y, to.y) - boatRadius > land.bottom
      ) {
        continue;
      }
      if (
        insidePolygons(from, [land.polygon]) ||
        insidePolygons(to, [land.polygon]) ||
        land.segments.some(
          (edge) => segmentDistance({ a: from, b: to }, edge) < boatRadius
        )
      ) {
        return false;
      }
    }
    return true;
  };
  const canSail = (point: MapPoint) => clearPassage(point, point);
  return {
    advance(pose: BoatPose, input: MapPoint, seconds: number): BoatPose {
      const magnitude = Math.hypot(input.x, input.y);
      if (
        !(Number.isFinite(magnitude) && Number.isFinite(seconds)) ||
        magnitude === 0 ||
        seconds <= 0
      ) {
        return pose;
      }
      const distance = sailingSpeed * Math.min(seconds, maximumStepSeconds);
      const next = {
        heading: Math.atan2(input.y, input.x),
        x: pose.x + (input.x / magnitude) * distance,
        y: pose.y + (input.y / magnitude) * distance,
      };
      return clearPassage(pose, next) ? next : pose;
    },
    canSail,
    spawn(near: MapPoint): BoatPose | null {
      if (xLimit < 0 || yLimit < 0) {
        return null;
      }
      const center = {
        x: Math.max(-xLimit, Math.min(xLimit, near.x)),
        y: Math.max(-yLimit, Math.min(yLimit, near.y)),
      };
      const reach = Math.hypot(bounds.width, bounds.height);
      for (const point of spawnCandidates(center, reach, xLimit, yLimit)) {
        if (canSail(point)) {
          return { ...point, heading: -Math.PI / 2 };
        }
      }
      return null;
    },
  };
}
