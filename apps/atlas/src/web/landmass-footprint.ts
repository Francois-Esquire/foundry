import { contours } from "d3-contour";
import { insidePolygons } from "./atmosphere";
import { shoreDistances } from "./distance-field";
import { landmassHull } from "./landmass-hull";
import type { Territory } from "./types";

export function oceanAccess(open: Uint8Array, width: number, height: number) {
  const reached = new Uint8Array(open.length);
  const queue: number[] = [];
  const visit = (i: number) => {
    if (open[i] && !reached[i]) {
      reached[i] = 1;
      queue.push(i);
    }
  };
  for (let x = 0; x < width; x++) {
    visit(x);
    visit((height - 1) * width + x);
  }
  for (let y = 0; y < height; y++) {
    visit(y * width);
    visit(y * width + width - 1);
  }
  for (const i of queue) {
    const x = i % width;
    if (x > 0) {
      visit(i - 1);
    }
    if (x + 1 < width) {
      visit(i + 1);
    }
    if (i >= width) {
      visit(i - width);
    }
    if (i + width < open.length) {
      visit(i + width);
    }
  }
  return reached;
}

export function landmassFootprint(members: Territory[], coastalBuffer = 32) {
  const hull = landmassHull(members);
  const step = 4;
  const reach = 120;
  const margin = reach * 2;
  const xs = hull.map(([x]) => x),
    ys = hull.map(([, y]) => y);
  const left = Math.min(...xs) - margin,
    top = Math.min(...ys) - margin;
  const width = Math.ceil((Math.max(...xs) - left + margin) / step);
  const height = Math.ceil((Math.max(...ys) - top + margin) / step);
  const point = (i: number) => ({
    x: left + ((i % width) + 0.5) * step,
    y: top + (Math.floor(i / width) + 0.5) * step,
  });
  const land = new Uint8Array(width * height);
  const raster = (ring: [number, number][]) => {
    const yy = ring.map(([, y]) => y);
    const y0 = Math.max(0, Math.floor((Math.min(...yy) - top) / step));
    const y1 = Math.min(height - 1, Math.ceil((Math.max(...yy) - top) / step));
    for (let y = y0; y <= y1; y++) {
      const line = top + (y + 0.5) * step;
      const crossings: number[] = [];
      for (const [i, a] of ring.entries()) {
        const b = ring[(i + 1) % ring.length];
        if (b && a[1] > line !== b[1] > line) {
          crossings.push(
            a[0] + ((line - a[1]) * (b[0] - a[0])) / (b[1] - a[1])
          );
        }
      }
      crossings.sort((a, b) => a - b);
      for (let i = 0; i + 1 < crossings.length; i += 2) {
        const x0 = Math.max(
          0,
          Math.ceil(((crossings[i] ?? left) - left) / step - 0.5)
        );
        const x1 = Math.min(
          width,
          Math.ceil(((crossings[i + 1] ?? left) - left) / step - 0.5)
        );
        land.fill(1, y * width + x0, y * width + x1);
      }
    }
  };
  const ordered = [...members].sort((a, b) => a.id.localeCompare(b.id));
  for (const p of ordered) {
    if (!p.coast.length) {
      raster(landmassHull([p], 0));
    }
    for (const polygon of p.coast) {
      const ring = polygon[0];
      if (ring) {
        raster(ring.map(([x, y]) => [x + p.x, y + p.y]));
      }
    }
  }
  const settlementDistance = shoreDistances(land, width, height);
  const joined = ordered.slice(0, 1),
    remaining = ordered.slice(1);
  while (remaining.length) {
    let shortest = Number.POSITIVE_INFINITY,
      source = joined[0],
      destination = 0;
    for (const a of joined) {
      for (const [i, b] of remaining.entries()) {
        const distance = Math.hypot(b.x - a.x, b.y - a.y);
        if (distance < shortest) {
          shortest = distance;
          source = a;
          destination = i;
        }
      }
    }
    const target = remaining.splice(destination, 1)[0];
    if (!(source && target)) {
      break;
    }
    const dx = target.x - source.x,
      dy = target.y - source.y;
    const length = Math.hypot(dx, dy) || 1;
    const nx = (-dy / length) * 12,
      ny = (dx / length) * 12;
    raster([
      [source.x + nx, source.y + ny],
      [target.x + nx, target.y + ny],
      [target.x - nx, target.y - ny],
      [source.x - nx, source.y - ny],
    ]);
    joined.push(target);
  }
  const distance = shoreDistances(land, width, height);
  const dilationExterior = Uint8Array.from(distance, (d) =>
    d * step > reach ? 1 : 0
  );
  const inward = shoreDistances(dilationExterior, width, height);
  const exterior = oceanAccess(
    Uint8Array.from(inward, (d) => (d * step < reach - coastalBuffer ? 1 : 0)),
    width,
    height
  );
  const filled = Uint8Array.from(exterior, (v) => 1 - v);
  const clearance = shoreDistances(filled, width, height);
  const pockets = Uint8Array.from(exterior, (v, i) =>
    v && insidePolygons(point(i), [[hull]]) ? 1 : 0
  );
  const rings = (mask: Uint8Array) =>
    contours()
      .size([width, height])
      .thresholds([0.5])(Array.from(mask))
      .flatMap((c) =>
        c.coordinates.flatMap((polygon) =>
          polygon.map((ring) =>
            ring.map(([x = 0, y = 0]): [number, number] => [
              left + x * step,
              top + y * step,
            ])
          )
        )
      );
  return {
    clearance,
    filled,
    height,
    hull,
    inland: shoreDistances(exterior, width, height),
    outline: rings(filled),
    pocketRings: rings(pockets),
    pockets,
    point,
    settlementDistance,
    step,
    width,
  };
}
