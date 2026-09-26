import { unit } from "./geography";
import type { AtlasData, FormerPackage } from "./types";

interface HistoryManifest {
  snapshots: { commit: string; timestamp: string; status: string }[];
}

interface HistoryEntities {
  packages: { id: string; checkpoints: string[] }[];
}

export function formerPackages(
  data: AtlasData,
  manifest: HistoryManifest,
  entities: HistoryEntities
): FormerPackage[] {
  const current = new Set(data.territories.map((territory) => territory.id));
  const snapshots = new Map(
    manifest.snapshots
      .filter((snapshot) => snapshot.status === "complete")
      .map((snapshot) => [snapshot.commit, snapshot.timestamp])
  );
  const placed: FormerPackage[] = [];
  for (const pkg of [...entities.packages].sort((a, b) =>
    a.id.localeCompare(b.id)
  )) {
    if (current.has(pkg.id)) {
      continue;
    }
    const lastObserved = pkg.checkpoints
      .map((commit) => snapshots.get(commit))
      .filter((time): time is string => !!time)
      .sort()
      .at(-1);
    if (!lastObserved) {
      continue;
    }
    const label = pkg.id.split("/").at(-1) ?? pkg.id;
    for (let attempt = 0; attempt < 256; attempt++) {
      const x =
        (unit(`${pkg.id}:wreck:x:${attempt}`) - 0.5) * (data.width - 80);
      const y =
        (unit(`${pkg.id}:wreck:y:${attempt}`) - 0.5) * (data.height - 80);
      const clearance = Math.min(
        ...data.territories.map(
          (territory) =>
            Math.hypot(x - territory.x, y - territory.y) - territory.radius
        )
      );
      if (clearance < 28 || clearance > 160) {
        continue;
      }
      if (placed.some((wreck) => Math.hypot(x - wreck.x, y - wreck.y) < 42)) {
        continue;
      }
      placed.push({ id: pkg.id, label, lastObserved, x, y });
      break;
    }
  }
  return placed;
}
