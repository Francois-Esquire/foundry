import { shoreDistances } from "./distance-field";
import { unit } from "./geography";
import { landmassFootprint, oceanAccess } from "./landmass-footprint";
import { landmassHull } from "./landmass-hull";
import type { AtlasData, AtlasRoute, Territory } from "./types";

export { landmassHull } from "./landmass-hull";

export type HullPoint = [number, number];

export const defaultLandmassSettings = {
  coastalBuffer: 32,
  islandClearance: 45,
};
export type LandmassSettings = typeof defaultLandmassSettings;

export function packageGroups(
  territories: Territory[],
  routes: AtlasRoute[],
  declared: AtlasData["declaredDependencies"] = []
): Territory[][] {
  const byId = new Map(territories.map((p) => [p.id, p]));
  const neighbors = new Map(territories.map((p) => [p.id, new Set<string>()]));
  for (const route of [...routes.filter((r) => r.weight > 0), ...declared]) {
    if (
      route.from === route.to ||
      !byId.has(route.from) ||
      !byId.has(route.to)
    ) {
      continue;
    }
    neighbors.get(route.from)?.add(route.to);
    neighbors.get(route.to)?.add(route.from);
  }
  const seen = new Set<string>();
  return [...territories]
    .sort((a, b) => a.id.localeCompare(b.id))
    .flatMap((p) => {
      if (seen.has(p.id)) {
        return [];
      }
      const queue = [p.id];
      seen.add(p.id);
      for (const current of queue) {
        for (const next of [...(neighbors.get(current) ?? [])].sort()) {
          if (!seen.has(next)) {
            seen.add(next);
            queue.push(next);
          }
        }
      }
      return [queue.flatMap((id) => byId.get(id) ?? [])];
    });
}

export function hullSeparation(
  a: HullPoint[],
  b: HullPoint[],
  gap = 0
): HullPoint | undefined {
  let best: HullPoint | undefined,
    magnitude = Number.POSITIVE_INFINITY;
  for (const polygon of [a, b]) {
    for (const [i, start] of polygon.entries()) {
      const end = polygon[(i + 1) % polygon.length];
      if (!end) {
        continue;
      }
      const dx = end[0] - start[0],
        dy = end[1] - start[1];
      const length = Math.hypot(dx, dy);
      if (!length) {
        continue;
      }
      const nx = -dy / length,
        ny = dx / length;
      const aa = a.map(([x, y]) => x * nx + y * ny),
        bb = b.map(([x, y]) => x * nx + y * ny);
      const positive = Math.max(...aa) - Math.min(...bb) + gap;
      const negative = Math.max(...bb) - Math.min(...aa) + gap;
      if (positive <= 0 || negative <= 0) {
        return undefined;
      }
      const distance = positive < negative ? positive : -negative;
      if (Math.abs(distance) < magnitude) {
        magnitude = Math.abs(distance);
        best = [nx * distance, ny * distance];
      }
    }
  }
  return best;
}

export function settleLandmasses(
  territories: Territory[],
  routes: AtlasRoute[],
  declared: AtlasData["declaredDependencies"] = [],
  settings: LandmassSettings = defaultLandmassSettings
): void {
  const groups = packageGroups(territories, routes, declared)
    .map((members) => ({
      hull: landmassHull(members),
      mass: members.reduce((sum, p) => sum + p.radius * p.radius, 0),
      members,
    }))
    .sort(
      (a, b) =>
        b.mass - a.mass ||
        (a.members[0]?.id ?? "").localeCompare(b.members[0]?.id ?? "")
    );
  const move = (group: (typeof groups)[number], x: number, y: number) => {
    for (const p of group.members) {
      p.x += x;
      p.y += y;
    }
    for (const p of group.hull) {
      p[0] += x;
      p[1] += y;
    }
  };
  const main = groups[0];
  if (!main) {
    return;
  }
  for (const group of groups) {
    const xs = group.hull.map(([x]) => x),
      ys = group.hull.map(([, y]) => y);
    move(
      group,
      -(Math.min(...xs) + Math.max(...xs)) / 2,
      -(Math.min(...ys) + Math.max(...ys)) / 2
    );
  }
  groups.slice(1).forEach((group, i) => {
    const angle =
      unit(main.members[0]?.id ?? "") * Math.PI * 2 +
      (i * Math.PI * 2) / (groups.length - 1);
    const x = Math.cos(angle),
      y = Math.sin(angle);
    const distance =
      Math.max(...main.hull.map(([xx, yy]) => xx * x + yy * y)) -
      Math.min(...group.hull.map(([xx, yy]) => xx * x + yy * y)) +
      90;
    move(group, x * distance, y * distance);
  });
  for (let pass = 0; pass < 120; pass++) {
    let largest = 0;
    for (const [i, a] of groups.entries()) {
      for (const b of groups.slice(i + 1)) {
        const separation = hullSeparation(
          a.hull,
          b.hull,
          settings.islandClearance
        );
        if (!separation) {
          continue;
        }
        const [x, y] = separation;
        largest = Math.max(largest, Math.hypot(x, y));
        const share = a === main ? 1 : a.mass / (a.mass + b.mass || 1);
        move(a, -x * (1 - share), -y * (1 - share));
        move(b, x * share, y * share);
      }
    }
    if (largest < 0.01) {
      break;
    }
  }
  if (main.members.length < 2 || groups.length < 2) {
    return;
  }
  const footprint = landmassFootprint(main.members, settings.coastalBuffer);
  if (!footprint.pockets.some(Boolean)) {
    return;
  }
  const pocketDistance = shoreDistances(
    footprint.pockets,
    footprint.width,
    footprint.height
  );
  for (const group of groups.slice(1)) {
    if (group.members.length !== 1) {
      continue;
    }
    const p = group.members[0];
    if (!p) {
      continue;
    }
    const radius = Math.max(
      ...group.hull.map(([x, y]) => Math.hypot(x - p.x, y - p.y))
    );
    const accessible = oceanAccess(
      Uint8Array.from(footprint.clearance, (d) =>
        d * footprint.step >=
        radius + settings.islandClearance + footprint.step * 2
          ? 1
          : 0
      ),
      footprint.width,
      footprint.height
    );
    const candidates = Array.from(footprint.pockets.keys())
      .filter(
        (i) =>
          accessible[i] &&
          (pocketDistance[i] ?? Number.POSITIVE_INFINITY) * footprint.step <=
            radius + 120
      )
      .map((i) => ({
        ...footprint.point(i),
        distance: pocketDistance[i] ?? Number.POSITIVE_INFINITY,
      }))
      .sort(
        (a, b) =>
          a.distance - b.distance ||
          Math.hypot(a.x, a.y) - Math.hypot(b.x, b.y) ||
          a.y - b.y ||
          a.x - b.x
      );
    for (const candidate of candidates) {
      const x = candidate.x - p.x,
        y = candidate.y - p.y;
      const moved = group.hull.map(([xx, yy]): HullPoint => [xx + x, yy + y]);
      if (
        groups.some(
          (other) =>
            other !== main &&
            other !== group &&
            hullSeparation(other.hull, moved, settings.islandClearance)
        )
      ) {
        continue;
      }
      move(group, x, y);
      break;
    }
  }
}

export function relayoutAtlas(
  data: AtlasData,
  settings: LandmassSettings
): AtlasData {
  const territories = data.territories.map((p) => ({ ...p }));
  settleLandmasses(
    territories,
    data.routes,
    data.declaredDependencies,
    settings
  );
  return {
    ...data,
    height:
      2 * (Math.max(...territories.map((p) => Math.abs(p.y) + p.radius)) + 120),
    territories,
    width:
      2 * (Math.max(...territories.map((p) => Math.abs(p.x) + p.radius)) + 120),
  };
}
