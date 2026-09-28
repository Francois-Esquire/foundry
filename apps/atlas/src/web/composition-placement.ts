import type { CompositionMark } from "./composition-layout";
import type { AtlasFile, Polygon, Territory } from "./types";

function insideRing(x: number, y: number, ring: Polygon[number]) {
  let inside = false;
  for (let i = 0; i < ring.length; i += 1) {
    const j = (i + ring.length - 1) % ring.length;
    const a = ring[i],
      b = ring[j];
    if (!(a && b)) {
      continue;
    }
    if (
      a[1] > y !== b[1] > y &&
      x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]
    ) {
      inside = !inside;
    }
  }
  return inside;
}

export function compositionInsideLand(x: number, y: number, coast: Polygon[]) {
  return coast.some((polygon) => {
    const [outer] = polygon;
    return (
      outer &&
      insideRing(x, y, outer) &&
      !polygon.slice(1).some((hole) => insideRing(x, y, hole))
    );
  });
}

export function clearOfCoast(
  x: number,
  y: number,
  coast: Polygon[],
  clearance = 1.2
) {
  for (const polygon of coast) {
    for (const ring of polygon) {
      for (let i = 0; i < ring.length; i += 1) {
        const a = ring[i],
          b = ring[(i + 1) % ring.length];
        if (!(a && b)) {
          continue;
        }
        const dx = b[0] - a[0],
          dy = b[1] - a[1];
        const t = Math.max(
          0,
          Math.min(
            1,
            ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy || 1)
          )
        );
        if (Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy) < clearance) {
          return false;
        }
      }
    }
  }
  return true;
}

export function fitComposition(
  marks: readonly CompositionMark[],
  territory: Pick<Territory, "coast" | "files">,
  anchor: AtlasFile,
  reserved: readonly { x: number; y: number }[] = []
) {
  if (!marks.length) {
    return { marks: [], unplaced: [] };
  }
  const sites: { x: number; y: number }[] = [];
  for (let row = -18; row <= 18; row += 1) {
    for (let column = -18; column <= 18; column += 1) {
      const x = column * 1.8,
        y = row * 1.8;
      if (
        !(
          compositionInsideLand(anchor.x + x, anchor.y + y, territory.coast) &&
          clearOfCoast(anchor.x + x, anchor.y + y, territory.coast)
        )
      ) {
        continue;
      }
      if (
        reserved.some(
          (point) =>
            Math.hypot(point.x - anchor.x - x, point.y - anchor.y - y) < 1.7
        )
      ) {
        continue;
      }
      if (
        territory.files.some(
          (file) =>
            file.id !== anchor.id &&
            Math.hypot(file.x - anchor.x - x, file.y - anchor.y - y) < 2.4
        )
      ) {
        continue;
      }
      sites.push({ x, y });
    }
  }
  const placed: CompositionMark[] = [];
  const unplaced: string[] = [];
  for (const mark of [...marks].sort(
    (a, b) => a.group.localeCompare(b.group) || a.id.localeCompare(b.id)
  )) {
    let best = -1,
      distance = Number.POSITIVE_INFINITY;
    sites.forEach((currentSite, index) => {
      const next =
        (currentSite.x - mark.x) ** 2 + (currentSite.y - mark.y) ** 2;
      if (next < distance) {
        best = index;
        distance = next;
      }
    });
    const site = sites[best];
    if (!site) {
      unplaced.push(mark.id);
      continue;
    }
    placed.push({ ...mark, ...site });
    sites.splice(best, 1);
  }
  return { marks: placed, unplaced };
}
