import type { Polygon, Territory } from "../data/types";

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

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const coastBoxes = new WeakMap<Territory, Box>();

/** The box round an island's coast, in island units, kept per island. */
function coastBox(territory: Territory): Box {
  let box = coastBoxes.get(territory);
  if (!box) {
    box = {
      x0: Number.POSITIVE_INFINITY,
      x1: Number.NEGATIVE_INFINITY,
      y0: Number.POSITIVE_INFINITY,
      y1: Number.NEGATIVE_INFINITY,
    };
    for (const polygon of territory.coast) {
      for (const [x, y] of polygon[0] ?? []) {
        box.x0 = Math.min(box.x0, x);
        box.x1 = Math.max(box.x1, x);
        box.y0 = Math.min(box.y0, y);
        box.y1 = Math.max(box.y1, y);
      }
    }
    coastBoxes.set(territory, box);
  }
  return box;
}

/** The island whose coast holds a map point, if any; the box round a coast rules it out before the coast is walked. */
export function islandAt(
  point: MapPoint,
  territories: readonly Territory[]
): Territory | undefined {
  return territories.find((p) => {
    const x = point.x - p.x;
    const y = point.y - p.y;
    const box = coastBox(p);
    return (
      x >= box.x0 &&
      x <= box.x1 &&
      y >= box.y0 &&
      y <= box.y1 &&
      insidePolygons({ x, y }, p.coast)
    );
  });
}
