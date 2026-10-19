import { contours } from "d3-contour";
import type { DependencyFoundation, FoundationGroup, Polygon } from "./types";

type Lobe = DependencyFoundation["lobes"][number];

/** Group identity follows membership, never geometry, focus, or input order. */
export function foundationGroupId(memberIds: readonly string[]): string {
  return `foundation-group:${JSON.stringify([...new Set(memberIds)].sort())}`;
}

/** Exact membership sets coalesce; partial overlaps retain separate identities. */
export function prepareFoundationGroups(
  foundations: readonly DependencyFoundation[]
): FoundationGroup[] {
  const memberships = new Map<string, DependencyFoundation[]>();
  for (const foundation of foundations) {
    const members = [
      ...new Set(foundation.members.map((member) => member.territoryId)),
    ].sort();
    if (members.length < 2) {
      continue;
    }
    const key = JSON.stringify(members);
    const group = memberships.get(key) ?? [];
    group.push(foundation);
    memberships.set(key, group);
  }
  return [...memberships]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, dependencies]) => {
      const lobes = new Map<string, Lobe>();
      for (const dependency of dependencies) {
        for (const lobe of dependency.lobes) {
          const previous = lobes.get(lobe.territoryId);
          if (!previous || lobe.radius > previous.radius) {
            lobes.set(lobe.territoryId, lobe);
          }
        }
      }
      return {
        dependencyIds: dependencies.map((dependency) => dependency.id).sort(),
        footprint: groupFootprint(
          [...lobes.values()].sort((a, b) =>
            a.territoryId.localeCompare(b.territoryId)
          )
        ),
        id: foundationGroupId(JSON.parse(key) as string[]),
        memberIds: JSON.parse(key) as string[],
      };
    });
}

/** Minimal connecting tree avoids a shared central hub pulling every outline together. */
function connections(lobes: readonly Lobe[]): [Lobe, Lobe][] {
  const [first] = lobes;
  if (!first) {
    return [];
  }
  const connected = new Set([first]);
  const links: [Lobe, Lobe][] = [];
  while (connected.size < lobes.length) {
    let best: [Lobe, Lobe] | undefined;
    let nearest = Number.POSITIVE_INFINITY;
    for (const a of connected) {
      for (const b of lobes) {
        if (connected.has(b)) {
          continue;
        }
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (distance < nearest) {
          nearest = distance;
          best = [a, b];
        }
      }
    }
    if (!best) {
      break;
    }
    links.push(best);
    connected.add(best[1]);
  }
  return links;
}

function bridgeDistance(x: number, y: number, a: Lobe, b: Lobe): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const t = Math.max(
    0,
    Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1))
  );
  return (
    Math.hypot(x - a.x - t * dx, y - a.y - t * dy) -
    (a.radius + (b.radius - a.radius) * t) * 0.7
  );
}

/** Bake a fixed organic outline. The renderer controls opacity, not the geometry. */
function groupFootprint(lobes: readonly Lobe[]): Polygon[] {
  if (lobes.length < 2) {
    return [];
  }
  const margin = 20;
  const left = Math.min(...lobes.map((lobe) => lobe.x - lobe.radius)) - margin;
  const top = Math.min(...lobes.map((lobe) => lobe.y - lobe.radius)) - margin;
  const spanX =
    Math.max(...lobes.map((lobe) => lobe.x + lobe.radius)) + margin - left;
  const spanY =
    Math.max(...lobes.map((lobe) => lobe.y + lobe.radius)) + margin - top;
  const scale = 256 / Math.max(spanX, spanY, 1);
  const width = Math.max(2, Math.ceil(spanX * scale));
  const height = Math.max(2, Math.ceil(spanY * scale));
  const links = connections(lobes);
  const values = new Array<number>(width * height);
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const worldX = left + ((col + 0.5) / width) * spanX;
      const worldY = top + ((row + 0.5) / height) * spanY;
      const x =
        worldX + 5 * Math.sin(worldY * 0.019) + 3 * Math.sin(worldX * 0.037);
      const y =
        worldY + 5 * Math.sin(worldX * 0.017) + 3 * Math.sin(worldY * 0.041);
      let distance = Number.POSITIVE_INFINITY;
      for (const lobe of lobes) {
        distance = Math.min(
          distance,
          Math.hypot(x - lobe.x, y - lobe.y) - lobe.radius
        );
      }
      for (const [a, b] of links) {
        distance = Math.min(distance, bridgeDistance(x, y, a, b));
      }
      values[row * width + col] = -distance;
    }
  }
  return (
    contours().size([width, height]).thresholds([0])(values)[0]?.coordinates ??
    []
  ).map((polygon) =>
    polygon.map((ring) =>
      ring.map(([x = 0, y = 0]): [number, number] => [
        left + (x / width) * spanX,
        top + (y / height) * spanY,
      ])
    )
  );
}
