import type { TradePoint } from "./trade-routes";

export function relaxRoad(
  original: TradePoint[],
  clear: (a: TradePoint, b: TradePoint) => boolean,
  elevation: (p: TradePoint) => number
) {
  let points = original.map((p) => ({ ...p }));
  const corridor = (p: TradePoint) =>
    original.slice(1).some((b, i) => {
      const a = original[i];
      if (!a) {
        return false;
      }
      const dx = b.x - a.x,
        dy = b.y - a.y;
      const t = Math.max(
        0,
        Math.min(
          1,
          ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)
        )
      );
      return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy) <= 36;
    });
  for (let pass = 0; pass < 64; pass += 1) {
    const next = points.map((p, i) => {
      const a = points[i - 1],
        b = points[i + 1];
      if (!(a && b)) {
        return p;
      }
      const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const candidate = {
        x: p.x + (midpoint.x - p.x) * 0.65,
        y: p.y + (midpoint.y - p.y) * 0.65,
      };
      if (
        !(corridor(candidate) && clear(a, candidate) && clear(candidate, b))
      ) {
        return p;
      }
      const grade = (q: TradePoint) =>
        Math.abs(elevation(a) - elevation(q)) +
        Math.abs(elevation(b) - elevation(q));
      if (grade(candidate) > grade(p) + 0.12) {
        return p;
      }
      return candidate;
    });
    if (next.every((p, i) => !i || clear(next[i - 1] ?? p, p))) {
      points = next;
    }
  }
  for (let pass = 0; pass < 3; pass += 1) {
    const [first] = points,
      last = points.at(-1);
    if (!(first && last)) {
      return points;
    }
    const next = [first];
    for (let i = 0; i < points.length - 1; i += 1) {
      const a = points[i],
        b = points[i + 1];
      if (!(a && b)) {
        continue;
      }
      next.push(
        { x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 },
        { x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 }
      );
    }
    next.push(last);
    if (
      next.every((p, i) => corridor(p) && (!i || clear(next[i - 1] ?? p, p)))
    ) {
      points = next;
    }
  }
  return points;
}
