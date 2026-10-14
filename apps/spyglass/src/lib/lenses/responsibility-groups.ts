import { createHash } from "node:crypto";
import type {
  ResponsibilityRegion,
  ResponsibilityRelationship,
} from "../internal-responsibility-types";
import type { InternalModuleNode } from "../internal-topology-types";
import { byId } from "../workspace-projection";
import type { Lens } from "./lens-types";
import { readPackageInternals, rootRelative } from "./package-internals";
import type {
  ResponsibilityGroup,
  ResponsibilityGroupsPackage,
} from "./responsibility-groups-types";
import { RESPONSIBILITY_GROUPS_SCHEMA_VERSION } from "./responsibility-groups-types";

/** The responsibilities and relationships the merge reads. */
interface ResponsibilityEvidence {
  regions: readonly Pick<ResponsibilityRegion, "id" | "label">[];
  relationships: readonly Pick<
    ResponsibilityRelationship,
    "from" | "to" | "moduleEdges" | "symbolFlow"
  >[];
}

/** One package's fields the lens reads; module ids are the package's own. */
interface ResponsibilityGroupsSourcePackage {
  id: string;
  responsibilities: {
    regions: readonly Pick<ResponsibilityRegion, "id" | "label" | "modules">[];
    relationships: ResponsibilityEvidence["relationships"];
  };
  root: string;
  topology: { modules: readonly Pick<InternalModuleNode, "id" | "fanIn">[] };
}

/** Every dataset field the lens reads. */
export interface ResponsibilityGroupsSource {
  missing: string[];
  packages: ResponsibilityGroupsSourcePackage[];
}

/** How strongly two responsibilities belong together: dampened import edges plus dampened symbol flow. */
export function responsibilityAffinity(
  moduleEdges: number,
  symbolFlow: number
) {
  return Math.log1p(moduleEdges) + Math.log1p(symbolFlow);
}

type Merged = Map<number, { members: number[]; strength: number }>;

/** A group's id from its sorted member ids, made as a responsibility's id is. */
function groupId(responsibilities: readonly string[]): string {
  const hash = createHash("sha256")
    .update(responsibilities.join("\n"))
    .digest("hex");
  return `responsibility-group:${hash.slice(0, 12)}`;
}

/**
 * Greedy modularity merge: joins the pair of groups with the largest gain
 * until no join gains, and names each group of two or more after its anchor,
 * the member with the most affinity to the others (ties by id).
 */
export function groupResponsibilities(evidence: ResponsibilityEvidence): {
  groups: Omit<ResponsibilityGroup, "anchorModule" | "modules">[];
  independent: string[];
} {
  const regions = [...evidence.regions].sort((a, b) =>
    a.id.localeCompare(b.id)
  );
  const count = regions.length;
  const indices = new Map(regions.map((region, index) => [region.id, index]));
  const weights = new Float64Array(count * count);
  const merged: Merged = new Map(
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
    const weight = responsibilityAffinity(edge.moduleEdges, edge.symbolFlow);
    weights[from * count + to] = (weights[from * count + to] ?? 0) + weight;
    weights[to * count + from] = (weights[to * count + from] ?? 0) + weight;
    const source = merged.get(from);
    const target = merged.get(to);
    if (source) {
      source.strength += weight;
    }
    if (target) {
      target.strength += weight;
    }
    total += weight;
  }
  const originalWeights = weights.slice();
  mergeWhileGaining(total, merged, weights, count);
  const groups: Omit<ResponsibilityGroup, "anchorModule" | "modules">[] = [];
  const independent: string[] = [];
  for (const group of merged.values()) {
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
    groups.push({
      anchor: anchor.region.id,
      anchorWeight: anchor.weight,
      id: groupId(ids),
      label: anchor.region.label,
      responsibilities: ids,
    });
  }
  return { groups, independent: independent.sort() };
}

function mergeWhileGaining(
  total: number,
  merged: Merged,
  weights: Float64Array<ArrayBuffer>,
  count: number
) {
  while (total > 0) {
    const best = bestJoin(merged, weights, count, total);
    if (!best) {
      break;
    }
    const [a, b] = best;
    const left = merged.get(a);
    const right = merged.get(b);
    if (!(left && right)) {
      break;
    }
    left.members.push(...right.members);
    left.strength += right.strength;
    merged.delete(b);
    for (const key of merged.keys()) {
      const weight =
        (weights[a * count + key] ?? 0) + (weights[b * count + key] ?? 0);
      weights[a * count + key] = weight;
      weights[key * count + a] = weight;
    }
  }
}

/** The pair whose join gains most, above a floor that keeps rounding from joining anything. */
function bestJoin(
  merged: Merged,
  weights: Float64Array<ArrayBuffer>,
  count: number,
  total: number
): [number, number] | undefined {
  let best: [number, number] | undefined;
  let bestGain = 1e-12;
  for (const [a, left] of merged) {
    for (const [b, right] of merged) {
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
  return best;
}

function derivePackage(
  pkg: ResponsibilityGroupsSourcePackage
): ResponsibilityGroupsPackage {
  const fanIn = new Map(
    pkg.topology.modules.map((module) => [module.id, module.fanIn])
  );
  const modules = new Map(
    pkg.responsibilities.regions.map((region) => [region.id, region.modules])
  );
  const { groups, independent } = groupResponsibilities(pkg.responsibilities);
  return {
    groups: groups.map((group) => {
      const [anchorModule] = [...(modules.get(group.anchor) ?? [])].sort(
        (a, b) => (fanIn.get(b) ?? 0) - (fanIn.get(a) ?? 0) || byId(a, b)
      );
      const members = [
        ...new Set(
          group.responsibilities.flatMap((id) =>
            (modules.get(id) ?? []).map((module) =>
              rootRelative(pkg.root, module)
            )
          )
        ),
      ].sort(byId);
      return anchorModule === undefined
        ? { ...group, modules: members }
        : {
            ...group,
            anchorModule: rootRelative(pkg.root, anchorModule),
            modules: members,
          };
    }),
    id: pkg.id,
    independent,
  };
}

/**
 * Each package's responsibilities grouped by the greedy modularity merge,
 * each group anchored on its most connected member and, within that, on its
 * module with the highest internal fan-in.
 */
export const responsibilityGroupsLens: Lens<
  "responsibility-groups",
  ResponsibilityGroupsSource
> = {
  derive: ({ missing, packages }) => ({
    missing,
    packages: packages.map(derivePackage).sort((a, b) => byId(a.id, b.id)),
  }),
  id: "responsibility-groups",
  read: async (reader) => {
    const { missing, packages } = await readPackageInternals(reader);
    return {
      missing,
      packages: packages.map(({ id, internals, root }) => ({
        id,
        responsibilities: internals.responsibilities,
        root,
        topology: internals.topology,
      })),
    };
  },
  schemaVersion: RESPONSIBILITY_GROUPS_SCHEMA_VERSION,
  settings: [],
};
