import { contours } from "d3-contour";
import { attraction, latitude } from "../data/bindings";
import {
  islandsByFrame,
  type Polygon,
  type SpyglassData,
  type SpyglassFile,
  type SpyglassFoundation,
  type Territory,
} from "../data/types";
import { archipelagoHull } from "./archipelago";
import { createFoundationAttraction, positionFoundations } from "./foundations";

export function unit(id: string): number {
  let h = 2_166_136_261;
  for (const c of id) {
    // biome-ignore lint/suspicious/noBitwiseOperators: Preserve the deterministic 32-bit hash used for map placement and colors.
    h = Math.imul(h ^ c.charCodeAt(0), 16_777_619);
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: Preserve the deterministic 32-bit hash used for map placement and colors.
  return (h >>> 0) / 4_294_967_296;
}

/** The padding an island keeps around its coast when islands are spaced, as `landmassHull` pads it. */
const shorePadding = 32;
/** Open sea kept beyond the outermost islands when the chart's extent is measured. */
const chartMargin = 120;
/**
 * Further sea below the southernmost islands keeps the composition clear of
 * the legend in the lower right.
 */
const footSea = 160;

/** How far an island's padded coast reaches from its centre; its footprint radius before it has a coast. */
function reach(territory: Territory): number {
  const points = territory.coast.flatMap((polygon) => polygon[0] ?? []);
  const farthest = points.length
    ? Math.max(...points.map(([x = 0, y = 0]) => Math.hypot(x, y)))
    : territory.radius;
  return farthest + shorePadding;
}

/** Original dependency-pulled geography, with soft layer anchors and two-dimensional separation. */
export function settlePackages(
  regions: Territory[],
  layers: Readonly<Record<string, number | null>>,
  clearance: number,
  routes: { from: string; to: string; weight: number }[] = [],
  foundations: readonly SpyglassFoundation[] = [],
  foundationInfluence = 1
): void {
  for (const region of regions) {
    region.x =
      (unit(region.id.slice(region.id.lastIndexOf(":") + 1)) - 0.5) * 1400;
    region.y = latitude(layers[region.id] ?? 0);
  }
  const ids = new Set(regions.map((region) => region.id));
  const connected = new Set(
    routes.flatMap((route) =>
      route.weight > 0 &&
      route.from !== route.to &&
      ids.has(route.from) &&
      ids.has(route.to)
        ? [route.from, route.to]
        : []
    )
  );
  const field = createFoundationAttraction(
    foundations,
    regions,
    foundationInfluence
  );
  for (const id of field.connected) {
    connected.add(id);
  }
  const active = regions.filter((region) => connected.has(region.id));
  if (field.connected.size) {
    active.sort((a, b) => a.id.localeCompare(b.id));
  }
  const edges = field.connected.size
    ? [...routes].sort(
        (a, b) =>
          a.from.localeCompare(b.from) ||
          a.to.localeCompare(b.to) ||
          a.weight - b.weight
      )
    : routes;
  const byId = new Map(active.map((p) => [p.id, p]));
  for (let step = 0; step < 450; step += 1) {
    for (const a of active) {
      a.y += (latitude(layers[a.id] ?? 0) - a.y) * 0.018;
      a.x *= 0.999;
    }
    for (const edge of edges) {
      const a = byId.get(edge.from);
      const b = byId.get(edge.to);
      if (!(a && b)) {
        continue;
      }
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.hypot(dx, dy) || 1;
      const pull =
        ((d - a.radius - b.radius - 75) / d) * 0.003 * attraction(edge.weight);
      a.x += dx * pull;
      a.y += dy * pull;
      b.x -= dx * pull;
      b.y -= dy * pull;
    }
    field.apply();
    settlePackagesEntries(active, clearance);
  }
  placeOffshoreIslands(regions, connected, clearance);
  if (field.connected.size) {
    separateFoundationCoasts(
      [...regions].sort((a, b) => a.id.localeCompare(b.id)),
      clearance
    );
  }
  // Translation preserves the original composition while fitting the current viewport.
  if (regions.length) {
    const [x, y] = middleOf(regions, reach);
    for (const region of regions) {
      region.x -= x;
      region.y -= y;
    }
  }
}

/** Unconnected islands follow an irregular orbit outside the connected islands' coasts. */
function placeOffshoreIslands(
  regions: Territory[],
  connected: ReadonlySet<string>,
  clearance: number
): void {
  const placed = regions.filter((region) => connected.has(region.id));
  const offshore = regions.filter((region) => !connected.has(region.id));
  const cx = placed.length
    ? (Math.min(...placed.map((region) => region.x - reach(region))) +
        Math.max(...placed.map((region) => region.x + reach(region)))) /
      2
    : 0;
  const cy = placed.length
    ? (Math.min(...placed.map((region) => region.y - reach(region))) +
        Math.max(...placed.map((region) => region.y + reach(region)))) /
      2
    : 0;
  const angles: number[] = [];
  const turn = Math.PI * (3 - Math.sqrt(5));
  const angularGap = Math.min(
    Math.PI / 4,
    (Math.PI * 1.3) / (offshore.length + 1)
  );
  for (const region of offshore.sort((a, b) => a.id.localeCompare(b.id))) {
    const id = region.id.slice(region.id.lastIndexOf(":") + 1);
    let angle = unit(`${id}:offshore-angle`) * Math.PI * 2;
    for (let attempt = 0; attempt <= offshore.length * 2; attempt += 1) {
      if (
        angles.every(
          (other) =>
            Math.abs(
              Math.atan2(Math.sin(angle - other), Math.cos(angle - other))
            ) >= angularGap
        )
      ) {
        break;
      }
      angle = (angle + turn) % (Math.PI * 2);
    }
    angles.push(angle);
    const ux = Math.cos(angle);
    const uy = Math.sin(angle);
    const gap = clearance + 10;
    let distance = reach(region) + gap;
    for (const other of placed) {
      const dx = other.x - cx;
      const dy = other.y - cy;
      const along = dx * ux + dy * uy;
      const across = dx * uy - dy * ux;
      const separation = reach(region) + reach(other) + gap;
      if (Math.abs(across) < separation) {
        distance = Math.max(
          distance,
          along + Math.sqrt(separation ** 2 - across ** 2)
        );
      }
    }
    // Seeded extra water breaks a perfect ring without changing on each load.
    distance += 18 + unit(`${id}:offshore-distance`) * 42;
    region.x = cx + ux * distance;
    region.y = cy + uy * distance;
    placed.push(region);
  }
}

function settlePackagesEntries(regions: Territory[], clearance: number) {
  for (const [i, a] of regions.entries()) {
    for (const b of regions.slice(i + 1)) {
      const dx = b.x - a.x || 0.01;
      const dy = b.y - a.y || 0.01;
      const d = Math.hypot(dx, dy);
      const overlap = a.radius + b.radius + clearance + 10 - d;
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

/** Attraction stops before this final pass, so coast clearance wins over every field. */
function separateFoundationCoasts(
  regions: Territory[],
  clearance: number
): void {
  const radii = new Map(
    regions.map((region) => [
      region.id,
      Math.max(region.radius + shorePadding, reach(region)),
    ])
  );
  for (let step = 0; step < 250; step += 1) {
    let maximum = 0;
    for (const [index, a] of regions.entries()) {
      for (const b of regions.slice(index + 1)) {
        const dx = b.x - a.x || 0.01;
        const dy = b.y - a.y || 0.01;
        const distance = Math.hypot(dx, dy);
        const overlap =
          (radii.get(a.id) ?? a.radius) +
          (radii.get(b.id) ?? b.radius) +
          clearance +
          10 -
          distance;
        if (overlap <= 0) {
          continue;
        }
        maximum = Math.max(maximum, overlap);
        const push = ((overlap + 0.001) / distance) * 0.5;
        a.x -= dx * push;
        a.y -= dy * push;
        b.x += dx * push;
        b.y += dy * push;
      }
    }
    if (maximum < 0.001) {
      break;
    }
  }
}

/**
 * The middle of the islands' padded extent, with `footSea` below it: the
 * offset that centres them on the origin, as the chart is.
 */
function middleOf(
  territories: readonly Territory[],
  reachOf: (territory: Territory) => number
): [number, number] {
  const west = Math.min(...territories.map((p) => p.x - reachOf(p)));
  const east = Math.max(...territories.map((p) => p.x + reachOf(p)));
  const north = Math.min(...territories.map((p) => p.y - reachOf(p)));
  const south = Math.max(...territories.map((p) => p.y + reachOf(p))) + footSea;
  return [(west + east) / 2, (north + south) / 2];
}

/** The chart's extent: symmetric about the origin, with open sea beyond the outermost islands. */
export function chartSize(territories: readonly Territory[]) {
  return {
    height:
      2 *
      (Math.max(0, ...territories.map((p) => Math.abs(p.y) + p.radius)) +
        chartMargin),
    width:
      2 *
      (Math.max(0, ...territories.map((p) => Math.abs(p.x) + p.radius)) +
        chartMargin),
  };
}

/** Open water kept between one frame's rim and the next, in map units. */
export const frameSea = 120;

/** How far a frame's islands move, all together, to take their place in a collection. */
export interface FrameOffset {
  dx: number;
  dy: number;
}

/**
 * A collection's frames side by side. Each frame's islands are laid out as
 * their workspace's alone would be (`settlePackages`) and moved whole, so
 * its own layout is kept. The frames run west to east in the collection's
 * order, with `frameSea` of open water between one frame's rim
 * (`archipelagoHull`) and the next. Each frame retains its original
 * two-dimensional dependency geography. One offset centres the collection.
 * Each frame's offset, in order.
 */
export function sideBySide(
  frames: readonly (readonly Territory[])[]
): FrameOffset[] {
  // The east edge of the rims placed so far; none before the first.
  let east: number | undefined;
  const columns = frames.map((islands) => {
    const xs = archipelagoHull({ territories: [...islands] }).map(
      ([west]) => west
    );
    if (!xs.length) {
      return 0;
    }
    const dx =
      east === undefined ? -Math.min(...xs) : east + frameSea - Math.min(...xs);
    east = dx + Math.max(...xs);
    return dx;
  });
  const placed = frames.flatMap((islands, i) =>
    islands.map((p) => ({
      ...p,
      x: p.x + (columns[i] ?? 0),
      y: p.y,
    }))
  );
  const [x, y] = placed.length ? middleOf(placed, reach) : [0, 0];
  return frames.map((_, i) => ({
    dx: (columns[i] ?? 0) - x,
    dy: -y,
  }));
}

/**
 * The spyglass with its islands placed again at another clearance; coasts and
 * file positions are unchanged. A collection's frames are placed again one
 * by one and set side by side
 * again (`sideBySide`); their former packages move with them.
 */
export function relayoutSpyglass(
  data: SpyglassData,
  clearance: number,
  foundationInfluence = data.foundationInfluence ?? 1
): SpyglassData {
  const influence = Number.isFinite(foundationInfluence)
    ? Math.max(0, Math.min(1, foundationInfluence))
    : 0;
  if (data.frames.length <= 1) {
    const territories = data.territories.map((p) => ({ ...p }));
    settlePackages(
      territories,
      data.packageLayers,
      clearance,
      data.routes,
      data.foundations,
      influence
    );
    return {
      ...data,
      ...chartSize(territories),
      foundationInfluence: influence,
      ...(data.foundations && {
        foundations: positionFoundations(data.foundations, territories),
      }),
      territories,
    };
  }
  const before = islandsByFrame(data);
  const alone = before.map((islands) => {
    const copies = islands.map((p) => ({ ...p }));
    settlePackages(
      copies,
      data.packageLayers,
      clearance,
      data.routes,
      data.foundations,
      influence
    );
    return copies;
  });
  const offsets = sideBySide(alone);
  const after = alone.map((islands, i) => {
    const { dx = 0, dy = 0 } = offsets[i] ?? {};
    return islands.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy }));
  });
  const territories = after.flat();
  // A former package moves as far as its frame's middle does.
  const moved = (id: string): [number, number] => {
    const at = data.frames.findIndex((frame) => id.startsWith(`${frame.id}:`));
    if (at < 0) {
      return [0, 0];
    }
    const [x0, y0] = frameMiddle(before[at] ?? []);
    const [x1, y1] = frameMiddle(after[at] ?? []);
    return [x1 - x0, y1 - y0];
  };
  return {
    ...data,
    ...chartSize(territories),
    foundationInfluence: influence,
    ...(data.foundations && {
      foundations: positionFoundations(data.foundations, territories),
    }),
    ...(data.formerPackages && {
      formerPackages: data.formerPackages.map((former) => {
        const [dx, dy] = moved(former.id);
        return { ...former, x: former.x + dx, y: former.y + dy };
      }),
    }),
    territories,
  };
}

/** Where a frame's islands sit now: the middle of their extent. */
function frameMiddle(islands: readonly Territory[]): [number, number] {
  if (!islands.length) {
    return [0, 0];
  }
  const middle = (low: number[], high: number[]) =>
    (Math.min(...low) + Math.max(...high)) / 2;
  return [
    middle(
      islands.map((p) => p.x - p.radius),
      islands.map((p) => p.x + p.radius)
    ),
    middle(
      islands.map((p) => p.y - p.radius),
      islands.map((p) => p.y + p.radius)
    ),
  ];
}

/**
 * The spread of each file's influence on its island's land: wider for a
 * sparse island, between 4 and 10 units.
 */
export function contourSigma(radius: number, files: number) {
  return Math.max(4, Math.min(10, (radius / Math.sqrt(files)) * 0.65));
}

export function landContours(
  files: SpyglassFile[],
  radius: number
): Polygon[][] {
  if (!files.length) {
    return [[], [], []];
  }
  const size = 112;
  const span = radius * 2.5;
  const cell = span / size;
  const sigma = contourSigma(radius, files.length);
  const field = new Array<number>(size * size).fill(0);
  for (const f of files) {
    const cx = (f.x + span / 2) / cell;
    const cy = (f.y + span / 2) / cell;
    const extent = Math.ceil((sigma * 3) / cell);
    for (
      let y = Math.max(0, Math.floor(cy - extent));
      y < Math.min(size, cy + extent);
      y += 1
    ) {
      for (
        let x = Math.max(0, Math.floor(cx - extent));
        x < Math.min(size, cx + extent);
        x += 1
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
