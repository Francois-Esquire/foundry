import { districtAffinity } from "./codex/bindings";
import type { AtlasInternals } from "./internals";

type Report = AtlasInternals["responsibilities"];
interface HierarchyEvidence {
  regions: readonly Pick<Report["regions"][number], "id" | "label">[];
  relationships: readonly Pick<
    Report["relationships"][number],
    "from" | "to" | "moduleEdges" | "symbolFlow"
  >[];
}

interface CompositeDistrict {
  anchor: string;
  anchorWeight: number;
  id: string;
  label: string;
  regions: string[];
}

export function deriveHierarchy(evidence: HierarchyEvidence) {
  const regions = [...evidence.regions].sort((a, b) =>
    a.id.localeCompare(b.id)
  );
  const count = regions.length;
  const indices = new Map(regions.map((region, index) => [region.id, index]));
  const weights = new Float64Array(count * count);
  const groups = new Map(
    regions.map((_, index) => [index, { members: [index], strength: 0 }])
  );
  let total = 0;
  const relationships = [...evidence.relationships].sort(
    (a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to)
  );
  for (const edge of relationships) {
    const from = indices.get(edge.from);
    const to = indices.get(edge.to);
    if (from === undefined || to === undefined || from === to) {
      continue;
    }
    const weight = districtAffinity(edge.moduleEdges, edge.symbolFlow);
    weights[from * count + to] = (weights[from * count + to] ?? 0) + weight;
    weights[to * count + from] = (weights[to * count + from] ?? 0) + weight;
    const source = groups.get(from);
    const target = groups.get(to);
    if (source) {
      source.strength += weight;
    }
    if (target) {
      target.strength += weight;
    }
    total += weight;
  }
  const originalWeights = weights.slice();
  deriveHierarchyEntries(total, groups, weights, count);
  const composites: CompositeDistrict[] = [];
  const independent: string[] = [];
  for (const group of groups.values()) {
    const members = group.members.flatMap((index) => regions[index] ?? []);
    members.sort((a, b) => a.id.localeCompare(b.id));
    if (members.length === 1) {
      independent.push(members[0]?.id ?? "");
      continue;
    }
    const ranked = group.members
      .map((index) => ({
        region: regions[index],
        weight: group.members.reduce(
          (sum, other) => sum + (originalWeights[index * count + other] ?? 0),
          0
        ),
      }))
      .sort(
        (a, b) =>
          b.weight - a.weight ||
          (a.region?.id ?? "").localeCompare(b.region?.id ?? "")
      );
    const [anchor] = ranked;
    if (!anchor?.region) {
      continue;
    }
    const ids = members.map((region) => region.id);
    composites.push({
      anchor: anchor.region.id,
      anchorWeight: anchor.weight,
      id: `composite:${JSON.stringify(ids)}`,
      label: anchor.region.label,
      regions: ids,
    });
  }
  return { composites, independent: independent.sort() };
}

function deriveHierarchyEntries(
  total: number,
  groups: Map<number, { members: number[]; strength: number }>,
  weights: Float64Array<ArrayBuffer>,
  count: number
) {
  while (total > 0) {
    const { best } = deriveHierarchyEntriesEntries(
      groups,
      weights,
      count,
      total,
      1e-12,
      undefined
    );
    if (!best) {
      break;
    }
    const [a, b] = best;
    const left = groups.get(a);
    const right = groups.get(b);
    if (!(left && right)) {
      break;
    }
    left.members.push(...right.members);
    left.strength += right.strength;
    groups.delete(b);
    for (const key of groups.keys()) {
      const weight =
        (weights[a * count + key] ?? 0) + (weights[b * count + key] ?? 0);
      weights[a * count + key] = weight;
      weights[key * count + a] = weight;
    }
  }
}

function deriveHierarchyEntriesEntries(
  groups: Map<number, { members: number[]; strength: number }>,
  weights: Float64Array<ArrayBuffer>,
  count: number,
  total: number,
  initialBestGain: number,
  initialBest: [number, number] | undefined
): { bestGain: number; best: [number, number] | undefined } {
  let best = initialBest;
  let bestGain = initialBestGain;
  for (const [a, left] of groups) {
    for (const [b, right] of groups) {
      if (b <= a) {
        continue;
      }
      const crossing = weights[a * count + b] ?? 0;
      if (!crossing) {
        continue;
      }
      const gain =
        crossing / total - (left.strength * right.strength) / (2 * total ** 2);
      if (gain > bestGain) {
        bestGain = gain;
        best = [a, b];
      }
    }
  }
  return { best, bestGain };
}
