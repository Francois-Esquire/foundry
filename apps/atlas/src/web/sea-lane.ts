import type { TradePoint } from "./trade-routes";

export function roundSeaLane(
  points: TradePoint[],
  clear: (a: TradePoint, b: TradePoint) => boolean
) {
  const [first] = points;
  if (!first) {
    return [];
  }
  const result = [first];
  for (let i = 1; i < points.length - 1; i += 1) {
    const a = points[i - 1],
      b = points[i],
      c = points[i + 1];
    if (!(a && b && c)) {
      continue;
    }
    const incoming = Math.hypot(b.x - a.x, b.y - a.y);
    const outgoing = Math.hypot(c.x - b.x, c.y - b.y);
    if (
      incoming * outgoing === 0 ||
      Math.abs((b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)) /
        (incoming * outgoing) <
        0.08
    ) {
      result.push(b);
      continue;
    }
    let bend = Math.min(45, incoming * 0.4, outgoing * 0.4);
    let arc = [b];
    while (bend > 0.1) {
      const start = {
        x: b.x + ((a.x - b.x) * bend) / incoming,
        y: b.y + ((a.y - b.y) * bend) / incoming,
      };
      const end = {
        x: b.x + ((c.x - b.x) * bend) / outgoing,
        y: b.y + ((c.y - b.y) * bend) / outgoing,
      };
      const candidate = Array.from({ length: 17 }, (_, n) => {
        const t = n / 16,
          s = 1 - t;
        return {
          x: s * s * start.x + 2 * s * t * b.x + t * t * end.x,
          y: s * s * start.y + 2 * s * t * b.y + t * t * end.y,
        };
      });
      if (
        candidate.every((p, n) => n === 0 || clear(candidate[n - 1] ?? p, p))
      ) {
        arc = candidate;
        break;
      }
      bend /= 2;
    }
    result.push(...arc);
  }
  const last = points.at(-1);
  if (last && points.length > 1) {
    result.push(last);
  }
  return result;
}
