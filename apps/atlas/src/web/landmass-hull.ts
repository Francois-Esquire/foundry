import type { Territory } from "./types";

export type HullPoint = [number, number];

function convexHull(points: HullPoint[]): HullPoint[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const half = (ordered: HullPoint[]) => {
    const hull: HullPoint[] = [];
    for (const p of ordered) {
      while (hull.length > 1) {
        const a = hull[hull.length - 2],
          b = hull[hull.length - 1];
        if (
          !(a && b) ||
          (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) > 0
        ) {
          break;
        }
        hull.pop();
      }
      hull.push(p);
    }
    hull.pop();
    return hull;
  };
  if (sorted.length < 3) {
    return sorted;
  }
  return [...half(sorted), ...half([...sorted].reverse())];
}

export function landmassHull(members: Territory[], padding = 32): HullPoint[] {
  const points = members.flatMap((p) => {
    const coast = p.coast.flatMap((polygon) => polygon[0] ?? []);
    return (
      coast.length
        ? coast
        : [
            [-p.radius, -p.radius],
            [p.radius, -p.radius],
            [p.radius, p.radius],
            [-p.radius, p.radius],
          ]
    ).map(([x = 0, y = 0]): HullPoint => [p.x + x, p.y + y]);
  });
  const hull = convexHull(points);
  return convexHull(
    hull.flatMap(([x, y]) =>
      Array.from({ length: 16 }, (_, i): HullPoint => {
        const angle = (i * Math.PI) / 8;
        return [x + padding * Math.cos(angle), y + padding * Math.sin(angle)];
      })
    )
  );
}
