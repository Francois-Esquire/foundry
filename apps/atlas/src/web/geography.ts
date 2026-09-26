import { contours } from "d3-contour";

import type { AtlasFile, Polygon, Territory } from "./types";

export function unit(id: string): number {
  let h = 2_166_136_261;
  for (const c of id) {
    h = Math.imul(h ^ c.charCodeAt(0), 16_777_619);
  }
  return (h >>> 0) / 4_294_967_296;
}

export function settlePackages(
  regions: Territory[],
  layers: Map<string, number>,
  routes: { from: string; to: string; weight: number }[]
): void {
  const byId = new Map(regions.map((p) => [p.id, p]));
  for (let step = 0; step < 450; step++) {
    for (const a of regions) {
      a.y += ((layers.get(a.id) ?? 0) * -220 - a.y) * 0.018;
      a.x *= 0.999;
    }
    for (const edge of routes) {
      const a = byId.get(edge.from);
      const b = byId.get(edge.to);
      if (!(a && b)) {
        continue;
      }
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const pull =
        ((d - a.radius - b.radius - 75) / d) *
        0.003 *
        Math.log2(2 + edge.weight);
      a.x += dx * pull;
      a.y += dy * pull;
      b.x -= dx * pull;
      b.y -= dy * pull;
    }
    for (const [i, a] of regions.entries()) {
      for (const b of regions.slice(i + 1)) {
        const dx = b.x - a.x || 0.01;
        const dy = b.y - a.y || 0.01;
        const d = Math.hypot(dx, dy);
        const overlap = a.radius + b.radius + 55 - d;
        if (overlap <= 0) {
          continue;
        }
        const push = (overlap / d) * 0.48;
        a.x -= dx * push;
        a.y -= dy * push;
        b.x += dx * push;
        b.y += dy * push;
      }
    }
  }
}

export function settleFiles(
  files: AtlasFile[],
  radius: number,
  edges: { source: string; target: string }[]
): void {
  const byId = new Map(files.map((f) => [f.id, f]));
  const links = edges.flatMap((e) => {
    const a = byId.get(e.source);
    const b = byId.get(e.target);
    return a && b ? [[a, b] as const] : [];
  });
  const anchors = files.map((f) => {
    const angle = unit(f.directory) * Math.PI * 2;
    const distance = Math.sqrt(unit(f.directory + ":distance")) * radius * 0.62;
    return { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance };
  });
  files.forEach((f, i) => {
    const a = anchors[i];
    if (!a) {
      return;
    }
    const angle = unit(f.id) * Math.PI * 2;
    const distance = Math.sqrt(unit(f.id + ":distance")) * radius * 0.24;
    f.x = a.x + Math.cos(angle) * distance;
    f.y = a.y + Math.sin(angle) * distance;
  });
  for (let step = 0; step < 100; step++) {
    for (const [a, b] of links) {
      const dx = (b.x - a.x) * 0.012;
      const dy = (b.y - a.y) * 0.012;
      a.x += dx;
      a.y += dy;
      b.x -= dx;
      b.y -= dy;
    }
    const grid = new Map<string, AtlasFile[]>();
    files.forEach((f, i) => {
      const a = anchors[i];
      if (!a) {
        return;
      }
      f.x += (a.x - f.x) * 0.025;
      f.y += (a.y - f.y) * 0.025;
      const gx = Math.floor(f.x / 6);
      const gy = Math.floor(f.y / 6);
      for (let x = gx - 1; x <= gx + 1; x++) {
        for (let y = gy - 1; y <= gy + 1; y++) {
          for (const other of grid.get(`${x},${y}`) ?? []) {
            const dx = f.x - other.x || 0.01;
            const dy = f.y - other.y || 0.01;
            const d = Math.hypot(dx, dy);
            if (d >= 5) {
              continue;
            }
            const push = ((5 - d) / d) * 0.5;
            f.x += dx * push;
            f.y += dy * push;
            other.x -= dx * push;
            other.y -= dy * push;
          }
        }
      }
      const key = `${gx},${gy}`;
      const bucket = grid.get(key) ?? [];
      bucket.push(f);
      grid.set(key, bucket);
    });
  }
}

export function landContours(files: AtlasFile[], radius: number): Polygon[][] {
  if (!files.length) {
    return [[], [], []];
  }
  const size = 112;
  const span = radius * 2.5;
  const cell = span / size;
  const sigma = Math.max(
    4,
    Math.min(10, (radius / Math.sqrt(files.length)) * 0.65)
  );
  const field = new Array<number>(size * size).fill(0);
  for (const f of files) {
    const cx = (f.x + span / 2) / cell;
    const cy = (f.y + span / 2) / cell;
    const reach = Math.ceil((sigma * 3) / cell);
    for (
      let y = Math.max(0, Math.floor(cy - reach));
      y < Math.min(size, cy + reach);
      y++
    ) {
      for (
        let x = Math.max(0, Math.floor(cx - reach));
        x < Math.min(size, cx + reach);
        x++
      ) {
        const d2 = ((x - cx) ** 2 + (y - cy) ** 2) * cell ** 2;
        field[y * size + x] =
          (field[y * size + x] ?? 0) + Math.exp(-d2 / (2 * sigma ** 2));
      }
    }
  }
  return contours()
    .size([size, size])
    .thresholds([0.18, 0.5, 1.8])(field)
    .map((c) =>
      c.coordinates.map((polygon) =>
        polygon.map((ring) =>
          ring.map(([x = 0, y = 0]): [number, number] => [
            x * cell - span / 2,
            y * cell - span / 2,
          ])
        )
      )
    );
}

export function territoryLabelY(territory: Territory): number {
  return (
    Math.min(
      0,
      ...territory.coast.flatMap((p) => p[0]?.map((point) => point[1]) ?? [])
    ) - 17
  );
}
