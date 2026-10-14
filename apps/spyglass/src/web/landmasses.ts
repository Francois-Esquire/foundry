import type { SpyglassData, SpyglassRoute, Territory } from "./types";

export const defaultLandmassSettings = {
  coastalBuffer: 32,
  islandClearance: 45,
};
export type LandmassSettings = typeof defaultLandmassSettings;

export function packageGroups(
  territories: Territory[],
  routes: SpyglassRoute[],
  declared: SpyglassData["declaredDependencies"] = []
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
