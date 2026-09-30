import { currentStrength } from "../codex/bindings";
import type { AtlasData } from "../types";

interface Connection {
  dx: number;
  dy: number;
  length: number;
  reach: number;
  weight: number;
  x: number;
  y: number;
}

export function dependencyCurrent(data: AtlasData) {
  const owners = new Map(
    data.territories.flatMap((p) => p.files.map((f) => [f.id, p] as const))
  );
  const counts = new Map<string, Map<string, number>>();
  for (const edge of data.fileEdges) {
    const a = owners.get(edge.source),
      b = owners.get(edge.target);
    if (!(a && b) || a.id === b.id) {
      continue;
    }
    const targets = counts.get(a.id) ?? new Map<string, number>();
    targets.set(b.id, (targets.get(b.id) ?? 0) + 1);
    counts.set(a.id, targets);
  }
  const connections: Connection[] = [];
  const territories = [...data.territories].sort((a, b) =>
    a.id.localeCompare(b.id)
  );
  for (const a of territories) {
    for (const b of territories) {
      const count = counts.get(a.id)?.get(b.id) ?? 0;
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (!(count && length)) {
        continue;
      }
      connections.push({
        dx: (b.x - a.x) / length,
        dy: (b.y - a.y) / length,
        length,
        reach: Math.max(85, (a.radius + b.radius) * 0.55),
        weight: currentStrength(count),
        x: a.x,
        y: a.y,
      });
    }
  }
  let gx = 0,
    gy = 0;
  for (const c of connections) {
    gx += c.dx * c.weight;
    gy += c.dy * c.weight;
  }
  if (Math.hypot(gx, gy) < 0.000_001) {
    const [strongest] = [...connections].sort((a, b) => b.weight - a.weight);
    gx = strongest?.dx ?? 0;
    gy = strongest?.dy ?? 0;
  }
  const length = Math.hypot(gx, gy) || 1;
  const prevailing = { x: gx / length, y: gy / length };
  return {
    prevailing,
    sample(x: number, y: number) {
      let vx = 0,
        vy = 0,
        influence = 0;
      for (const c of connections) {
        const t = Math.max(
          0,
          Math.min(c.length, (x - c.x) * c.dx + (y - c.y) * c.dy)
        );
        const distance = Math.hypot(x - c.x - c.dx * t, y - c.y - c.dy * t);
        const weight =
          c.weight * Math.exp(-(distance * distance) / (2 * c.reach * c.reach));
        vx += c.dx * weight;
        vy += c.dy * weight;
        influence += weight;
      }
      const activity = 1 - Math.exp(-influence / 4);
      vx = prevailing.x * 0.4 + (vx / Math.max(1, influence)) * activity * 0.6;
      vy = prevailing.y * 0.4 + (vy / Math.max(1, influence)) * activity * 0.6;
      return {
        strength: connections.length ? 0.3 + activity * 0.7 : 0,
        x: vx,
        y: vy,
      };
    },
  };
}
