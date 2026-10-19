import { fileFootprint } from "../file-placement";
import { deriveFoundations, positionFoundations } from "./foundations";
import { chartSize, settlePackages } from "./geography";
import { prepareFoundationGroups } from "./groups";
import { landContours } from "./island-geometry";
import {
  defaultVisualizationSettings,
  type IslandGeometry,
  maximumFoundationInfluence,
  type PreparedVisualization,
  type VisualizationInput,
  type VisualizationSettings,
} from "./types";

/** Object property insertion order is not content; array order may affect the solver. */
function canonicalProperties(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalProperties);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const object = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(object)
      .sort()
      .map((key) => [key, canonicalProperties(object[key])])
  );
}

/** Content identity only: this is a cache key, never a security or authorization hash. */
export function visualizationInputKey(input: VisualizationInput): string {
  const value = {
    ...input,
    // The terrain pass also sorts unique module IDs within each package.
    modules: [...input.modules].sort((a, b) => a.id.localeCompare(b.id)),
  };
  const json = JSON.stringify(canonicalProperties(value));
  let first = 2_166_136_261;
  let second = 2_246_822_507;
  for (let index = 0; index < json.length; index += 1) {
    const code = json.charCodeAt(index);
    // biome-ignore lint/suspicious/noBitwiseOperators: Two deterministic 32-bit hashes identify cached visualization inputs.
    first = Math.imul(first ^ code, 16_777_619) >>> 0;
    // biome-ignore lint/suspicious/noBitwiseOperators: Independent seed and multiplier reduce accidental cache collisions.
    second = Math.imul(second ^ code, 3_266_489_909) >>> 0;
  }
  return `${json.length}:${first.toString(16)}:${second.toString(16)}`;
}

/** Pure preparation shared by scans, old datasets, and deliberate layout adjustments. */
export function prepareVisualization(
  input: VisualizationInput,
  settings: VisualizationSettings = defaultVisualizationSettings,
  previous?: PreparedVisualization
): PreparedVisualization {
  const normalized = {
    foundationInfluence: Number.isFinite(settings.foundationInfluence)
      ? Math.max(
          0,
          Math.min(maximumFoundationInfluence, settings.foundationInfluence)
        )
      : 0,
    islandClearance: Number.isFinite(settings.islandClearance)
      ? Math.max(0, settings.islandClearance)
      : defaultVisualizationSettings.islandClearance,
  };
  const inputKey = visualizationInputKey(input);
  if (
    previous?.schemaVersion === 1 &&
    previous.policyVersion === 5 &&
    previous.inputKey === inputKey &&
    previous.settings.islandClearance === normalized.islandClearance &&
    previous.settings.foundationInfluence === normalized.foundationInfluence
  ) {
    return previous;
  }
  const byPackage = new Map<string, VisualizationInput["modules"]>();
  for (const module of input.modules) {
    const files = byPackage.get(module.package) ?? [];
    files.push(module);
    byPackage.set(module.package, files);
  }
  const islands: IslandGeometry[] = input.packages.map((pkg) => {
    const radius = fileFootprint(pkg.size);
    const files = [...(byPackage.get(pkg.id) ?? [])].sort((a, b) =>
      a.id.localeCompare(b.id)
    );
    const [shallows = [], coast = [], hills = []] = landContours(files, radius);
    return { coast, hills, id: pkg.id, radius, shallows, x: 0, y: 0 };
  });
  const foundations = input.inventory
    ? deriveFoundations(
        input.inventory,
        islands.map((island) => island.id)
      )
    : [];
  const layers = Object.fromEntries(
    input.packages.map((pkg) => [pkg.id, pkg.layer])
  );
  settlePackages(
    islands,
    layers,
    normalized.islandClearance,
    input.routes,
    foundations,
    normalized.foundationInfluence
  );
  const positioned = positionFoundations(foundations, islands);
  return {
    foundations: positioned,
    groups: prepareFoundationGroups(positioned, islands),
    inputKey,
    islands,
    policyVersion: 5,
    schemaVersion: 1,
    settings: normalized,
    ...chartSize(islands),
  };
}
