import type { Polygon, Territory } from "./types";

export interface MapPoint {
  x: number;
  y: number;
}

/** Even-odd containment across every ring, so holes and detached islands count. */
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

/** The island whose coast holds a map point, if any. */
export function islandAt(
  point: MapPoint,
  territories: Territory[]
): Territory | undefined {
  return territories.find((p) =>
    insidePolygons({ x: point.x - p.x, y: point.y - p.y }, p.coast)
  );
}
