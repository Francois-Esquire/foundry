import type { MapLabel } from "./exploration";
import type { AtlasData, Polygon, Territory } from "./types";

export interface MapPoint {
  x: number;
  y: number;
}

export function atmosphereStrength(scale: number): number {
  const t = Math.max(0, Math.min(1, (scale - 0.8) / 2));
  return 1 - t * t * (3 - 2 * t);
}

export function insidePolygons(point: MapPoint, polygons: Polygon[]): boolean {
  return polygons.some((polygon) => {
    let inside = false;
    for (const ring of polygon) {
      for (let i = 0; i < ring.length; i += 1) {
        const j = (i + ring.length - 1) % ring.length;
        const a = ring[i],
          b = ring[j];
        if (!(a && b)) {
          continue;
        }
        if (
          a[1] > point.y !== b[1] > point.y &&
          point.x < ((b[0] - a[0]) * (point.y - a[1])) / (b[1] - a[1]) + a[0]
        ) {
          inside = !inside;
        }
      }
    }
    return inside;
  });
}

export function islandAt(
  point: MapPoint,
  territories: Territory[]
): Territory | undefined {
  return territories.find((p) =>
    insidePolygons({ x: point.x - p.x, y: point.y - p.y }, p.coast)
  );
}

export function windPath(origin: MapPoint, scale: number): MapPoint[] {
  return Array.from({ length: 41 }, (_, i) => {
    const t = i / 40;
    return {
      x: origin.x + ((t - 0.5) * 100) / scale,
      y: origin.y + (Math.sin(t * Math.PI * 2) * 8) / scale,
    };
  });
}

function segmentDistance(point: MapPoint, a: MapPoint, b: MapPoint): number {
  const dx = b.x - a.x,
    dy = b.y - a.y;
  const length = dx * dx + dy * dy;
  const t = length
    ? Math.max(
        0,
        Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / length)
      )
    : 0;
  return Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy);
}

export function clearWind(
  path: MapPoint[],
  data: AtlasData,
  labels: MapLabel[],
  clearance: number
): boolean {
  const regions = new Map(data.territories.map((p) => [p.id, p]));
  for (const point of path) {
    if (
      Math.abs(point.x) + clearance > data.width / 2 ||
      Math.abs(point.y) + clearance > data.height / 2
    ) {
      return false;
    }
    if (
      Math.abs(point.x - (data.width / 2 - 88)) < 40 + clearance &&
      Math.abs(point.y - (-data.height / 2 + 94)) < 50 + clearance
    ) {
      return false;
    }
    if (point.y > data.height / 2 - 60 - clearance) {
      return false;
    }
    for (const p of data.territories) {
      if (!clearTerritory(point, p, clearance)) {
        return false;
      }
    }
    if (
      labels.some(
        (l) =>
          Math.abs(point.x - l.x) < l.width / 2 + clearance &&
          point.y > l.y - l.height - clearance &&
          point.y < l.y + clearance
      )
    ) {
      return false;
    }
    if (!clearRoutes(point, data, regions, clearance)) {
      return false;
    }
  }
  return true;
}

function clearTerritory(
  point: MapPoint,
  territory: Territory,
  clearance: number
): boolean {
  const local = { x: point.x - territory.x, y: point.y - territory.y };
  if (
    insidePolygons(local, territory.shallows) ||
    insidePolygons(local, territory.coast)
  ) {
    return false;
  }
  for (const polygon of territory.shallows) {
    for (const ring of polygon) {
      for (let i = 0; i < ring.length; i += 1) {
        const a = ring[i];
        const b = ring[(i + 1) % ring.length];
        if (
          a &&
          b &&
          segmentDistance(local, { x: a[0], y: a[1] }, { x: b[0], y: b[1] }) <
            clearance
        ) {
          return false;
        }
      }
    }
  }
  return true;
}

function clearRoutes(
  point: MapPoint,
  data: AtlasData,
  regions: Map<string, Territory>,
  clearance: number
): boolean {
  for (const route of data.routes) {
    const a = regions.get(route.from);
    const b = regions.get(route.to);
    if (!(a && b)) {
      continue;
    }
    const cx = (a.x + b.x) / 2 + (b.y - a.y) * 0.12;
    const cy = (a.y + b.y) / 2 - (b.x - a.x) * 0.12;
    let previous: MapPoint = a;
    for (let i = 1; i <= 40; i += 1) {
      const t = i / 40;
      const next = {
        x: (1 - t) ** 2 * a.x + 2 * (1 - t) * t * cx + t * t * b.x,
        y: (1 - t) ** 2 * a.y + 2 * (1 - t) * t * cy + t * t * b.y,
      };
      if (segmentDistance(point, previous, next) < clearance) {
        return false;
      }
      previous = next;
    }
  }
  return true;
}
