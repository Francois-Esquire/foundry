import type { CodexRetiredPackage } from "./codex/vocabulary";
import { unit } from "./geography";
import type { AtlasData, FormerPackage } from "./types";

export function formerPackages(
  data: AtlasData,
  retired: readonly CodexRetiredPackage[]
): FormerPackage[] {
  const placed: FormerPackage[] = [];
  for (const pkg of [...retired].sort((a, b) => a.id.localeCompare(b.id))) {
    for (let attempt = 0; attempt < 256; attempt += 1) {
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
      placed.push({
        id: pkg.id,
        label: pkg.label,
        lastObserved: pkg.lastSeen,
        x,
        y,
      });
      break;
    }
  }
  return placed;
}
