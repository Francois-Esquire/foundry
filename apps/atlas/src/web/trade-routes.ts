import { createChannelGraph } from "./channel-graph";
import { compositionInsideLand } from "./composition-placement";
import { shoreDistances } from "./ocean";
import type { AtlasData, AtlasRoute, Territory } from "./types";

export interface TradePoint {
  x: number;
  y: number;
}

export interface TradePort {
  coast: TradePoint;
  files: string[];
  territory: string;
  water: TradePoint;
}

export interface TradeRoute {
  consumer: TradePort;
  dependency: AtlasRoute;
  points: TradePoint[];
  supplier: TradePort;
}

export function leadingTrades(data: AtlasData, selected?: string | null) {
  const ids = new Set(data.territories.map((p) => p.id));
  const routes = data.routes
    .filter(
      (r) => r.weight > 0 && r.from !== r.to && ids.has(r.from) && ids.has(r.to)
    )
    .sort(
      (a, b) =>
        b.weight - a.weight ||
        a.from.localeCompare(b.from) ||
        a.to.localeCompare(b.to)
    );
  if (selected) {
    return routes
      .filter((r) => r.from === selected || r.to === selected)
      .slice(0, 6);
  }
  const consumers = new Map<string, number>();
  for (const r of routes) {
    consumers.set(r.from, (consumers.get(r.from) ?? 0) + r.weight);
  }
  return [...consumers]
    .sort(([a, aw], [b, bw]) => bw - aw || a.localeCompare(b))
    .slice(0, 6)
    .flatMap(([id]) => routes.find((r) => r.from === id) ?? []);
}

export function createTradeNavigation(data: AtlasData) {
  const step = Math.max(5, Math.max(data.width, data.height) / 320);
  const width = Math.ceil(data.width / step),
    height = Math.ceil(data.height / step);
  const point = (i: number): TradePoint => ({
    x: ((i % width) + 0.5) * step - data.width / 2,
    y: (Math.floor(i / width) + 0.5) * step - data.height / 2,
  });
  const cell = (p: TradePoint) => {
    const x = Math.floor((p.x + data.width / 2) / step);
    const y = Math.floor((p.y + data.height / 2) / step);
    return x < 0 || y < 0 || x >= width || y >= height ? -1 : y * width + x;
  };
  const land = new Uint8Array(width * height);
  const owners = new Int32Array(land.length).fill(-1);
  const nearest = new Float32Array(land.length).fill(Number.POSITIVE_INFINITY);
  for (const [owner, p] of [...data.territories]
    .sort((a, b) => a.id.localeCompare(b.id))
    .entries()) {
    const island = new Uint8Array(land.length);
    const vertices = p.coast.flat(2);
    if (!vertices.length) {
      continue;
    }
    const xs = vertices.map(([x]) => x + p.x),
      ys = vertices.map(([, y]) => y + p.y);
    const left = Math.max(
      0,
      Math.floor((Math.min(...xs) + data.width / 2) / step)
    );
    const right = Math.min(
      width - 1,
      Math.ceil((Math.max(...xs) + data.width / 2) / step)
    );
    const top = Math.max(
      0,
      Math.floor((Math.min(...ys) + data.height / 2) / step)
    );
    const bottom = Math.min(
      height - 1,
      Math.ceil((Math.max(...ys) + data.height / 2) / step)
    );
    for (let y = top; y <= bottom; y++) {
      for (let x = left; x <= right; x++) {
        const i = y * width + x,
          q = point(i);
        if (compositionInsideLand(q.x - p.x, q.y - p.y, p.coast)) {
          island[i] = land[i] = 1;
        }
      }
    }
    for (const polygon of p.coast) {
      for (const ring of polygon) {
        ring.forEach(([x, y], i) => {
          const next = ring[(i + 1) % ring.length];
          if (!next) {
            return;
          }
          const count = Math.ceil(
            Math.hypot(next[0] - x, next[1] - y) / (step / 3)
          );
          for (let n = 0; n <= count; n++) {
            const t = n / Math.max(1, count);
            const index = cell({
              x: p.x + x + (next[0] - x) * t,
              y: p.y + y + (next[1] - y) * t,
            });
            if (index >= 0) {
              island[index] = land[index] = 1;
            }
          }
        });
      }
    }
    shoreDistances(island, width, height).forEach((distance, i) => {
      if (distance < (nearest[i] ?? Number.POSITIVE_INFINITY)) {
        nearest[i] = distance;
        owners[i] = owner;
      }
    });
  }
  for (let i = 0; i < owners.length; i++) {
    const x = i % width,
      y = Math.floor(i / width);
    const border = Math.min(
      x + 0.5,
      y + 0.5,
      width - x - 0.5,
      height - y - 0.5
    );
    if (border < (nearest[i] ?? Number.POSITIVE_INFINITY)) {
      owners[i] = -2;
    }
  }
  const distance = shoreDistances(land, width, height);
  const clearCell = (i: number) =>
    i >= 0 && i < land.length && (distance[i] ?? 0) > 1.5;
  const ocean = new Uint8Array(land.length);
  const flood = new Int32Array(land.length);
  let head = 0,
    tail = 0;
  const visit = (i: number) => {
    if (!clearCell(i) || ocean[i]) {
      return;
    }
    ocean[i] = 1;
    flood[tail++] = i;
  };
  for (let x = 0; x < width; x++) {
    visit(x);
    visit((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    visit(y * width);
    visit(y * width + width - 1);
  }
  while (head < tail) {
    const i = flood[head++] ?? 0;
    visit(i - width);
    visit(i + width);
    if (i % width) {
      visit(i - 1);
    }
    if (i % width < width - 1) {
      visit(i + 1);
    }
  }
  const open = (i: number) => i >= 0 && ocean[i] === 1;
  const clear = (a: TradePoint, b: TradePoint) => {
    const count = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (step / 4));
    for (let n = 0; n <= count; n++) {
      const t = n / Math.max(1, count);
      if (!open(cell({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }))) {
        return false;
      }
    }
    return true;
  };
  const port = (
    p: Territory,
    other: Territory,
    files: string[]
  ): TradePort | undefined => {
    const members = p.files.filter((f) => files.includes(f.id));
    const anchor = {
      x:
        p.x +
        members.reduce((sum, f) => sum + f.x, 0) / Math.max(1, members.length),
      y:
        p.y +
        members.reduce((sum, f) => sum + f.y, 0) / Math.max(1, members.length),
    };
    let best: TradePort | undefined,
      score = Number.POSITIVE_INFINITY;
    for (const polygon of p.coast) {
      const ring = polygon[0] ?? [];
      for (
        let i = 0;
        i < ring.length;
        i += Math.max(1, Math.floor(ring.length / 80))
      ) {
        const a = ring[i],
          b = ring[(i + 1) % ring.length];
        if (!(a && b)) {
          continue;
        }
        const coast = {
          x: p.x + (a[0] + b[0]) / 2,
          y: p.y + (a[1] + b[1]) / 2,
        };
        const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
        for (const side of [-1, 1]) {
          const index = cell({
            x: coast.x + ((b[1] - a[1]) / length) * step * 3.5 * side,
            y: coast.y - ((b[0] - a[0]) / length) * step * 3.5 * side,
          });
          if (!open(index)) {
            continue;
          }
          const water = point(index);
          let approach = true;
          for (let n = 1; n <= 16; n++) {
            const x = coast.x + ((water.x - coast.x) * n) / 16;
            const y = coast.y + ((water.y - coast.y) * n) / 16;
            if (
              data.territories.some((island) =>
                compositionInsideLand(x - island.x, y - island.y, island.coast)
              )
            ) {
              approach = false;
              break;
            }
          }
          if (!approach) {
            continue;
          }
          const value =
            Math.hypot(coast.x - anchor.x, coast.y - anchor.y) +
            Math.hypot(water.x - other.x, water.y - other.y) * 0.2;
          if (value >= score) {
            continue;
          }
          score = value;
          best = { coast, files, territory: p.id, water };
        }
      }
    }
    return best;
  };
  const sail = createChannelGraph(
    owners,
    width,
    height,
    (x, y) => ({
      x: x * step - data.width / 2,
      y: y * step - data.height / 2,
    }),
    clear
  );
  const cache = new Map<string, TradeRoute | null>();
  return (selected?: string | null): TradeRoute[] =>
    leadingTrades(data, selected).flatMap((dependency) => {
      const key = JSON.stringify([dependency.from, dependency.to]);
      if (!cache.has(key)) {
        const a = data.territories.find((p) => p.id === dependency.from);
        const b = data.territories.find((p) => p.id === dependency.to);
        if (!(a && b)) {
          return [];
        }
        const sources = new Set(a.files.map((f) => f.id)),
          targets = new Set(b.files.map((f) => f.id));
        const edges = data.fileEdges.filter(
          (e) => sources.has(e.source) && targets.has(e.target)
        );
        const consumer = port(
          a,
          b,
          [...new Set(edges.map((e) => e.source))].sort()
        );
        const supplier = port(
          b,
          a,
          [...new Set(edges.map((e) => e.target))].sort()
        );
        const points =
          consumer && supplier ? sail(consumer.water, supplier.water) : [];
        cache.set(
          key,
          consumer && supplier && points.length
            ? { consumer, dependency, points, supplier }
            : null
        );
      }
      return cache.get(key) ?? [];
    });
}
