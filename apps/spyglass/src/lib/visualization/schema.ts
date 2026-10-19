import { z } from "zod";
import {
  maximumFoundationInfluence,
  type PreparedVisualization,
  visualizationPolicyVersion,
} from "./types";

const finite = z.number().finite();
const point = z.tuple([finite, finite]);
const polygon = z.array(z.array(point).min(3)).min(1);
const usage = z.object({
  importingFiles: z.array(z.string()),
  runtimeFiles: z.array(z.string()),
  typeOnlyFiles: z.array(z.string()),
});
const preparedSchema = z.object({
  foundations: z.array(
    z.object({
      id: z.string(),
      lobes: z.array(
        z.object({
          radius: finite.positive(),
          territoryId: z.string(),
          weight: finite.nonnegative(),
          x: finite,
          y: finite,
        })
      ),
      members: z.array(
        z.object({
          direct: z.boolean(),
          distance: z.number().int().positive(),
          territoryId: z.string(),
          usage: usage.optional(),
          weight: finite.nonnegative(),
        })
      ),
      name: z.string(),
      prominence: z.number().int().nonnegative(),
      versions: z.array(z.string()),
      x: finite,
      y: finite,
    })
  ),
  groups: z.array(
    z.object({
      dependencyIds: z.array(z.string()),
      id: z.string(),
      memberIds: z.array(z.string()),
    })
  ),
  height: finite.positive(),
  inputKey: z.string().min(1),
  internalFoundations: z.array(
    z.object({
      id: z.string(),
      members: z
        .array(
          z.object({
            direct: z.boolean(),
            distance: z.number().int().positive(),
            territoryId: z.string(),
            weight: finite.nonnegative(),
          })
        )
        .min(1),
      prominence: z.number().int().positive(),
      supplierId: z.string(),
    })
  ),
  islands: z.array(
    z.object({
      coast: z.array(polygon),
      hills: z.array(polygon),
      id: z.string(),
      radius: finite.nonnegative(),
      shallows: z.array(polygon),
      x: finite,
      y: finite,
    })
  ),
  policyVersion: z.literal(visualizationPolicyVersion),
  schemaVersion: z.literal(1),
  settings: z.object({
    foundationInfluence: finite.min(0).max(maximumFoundationInfluence),
    islandClearance: finite.nonnegative(),
  }),
  width: finite.positive(),
});
function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}
function membershipKey(values: readonly string[]): string {
  return JSON.stringify([...values].sort());
}

function validGroups(prepared: PreparedVisualization): boolean {
  const memberships = new Map(
    prepared.foundations.map((foundation) => [
      foundation.id,
      membershipKey(foundation.members.map((member) => member.territoryId)),
    ])
  );
  const grouped = new Set<string>();
  const groupMemberships = new Set<string>();
  for (const group of prepared.groups) {
    const key = membershipKey(group.memberIds);
    if (
      group.memberIds.length < 2 ||
      group.dependencyIds.length === 0 ||
      !unique(group.memberIds) ||
      groupMemberships.has(key)
    ) {
      return false;
    }
    groupMemberships.add(key);
    for (const id of group.dependencyIds) {
      if (grouped.has(id) || memberships.get(id) !== key) {
        return false;
      }
      grouped.add(id);
    }
  }
  return grouped.size === memberships.size;
}

/** A supplier and its dependents are islands; a supplier never depends on itself. */
function validInternalFoundations(
  prepared: PreparedVisualization,
  islands: ReadonlySet<string>
): boolean {
  return prepared.internalFoundations.every((foundation) => {
    const members = foundation.members.map((member) => member.territoryId);
    return (
      foundation.id === `workspace:${foundation.supplierId}` &&
      islands.has(foundation.supplierId) &&
      foundation.prominence === members.length &&
      unique(members) &&
      members.every((id) => islands.has(id) && id !== foundation.supplierId)
    );
  });
}

/** Other geometry policies fall back to local preparation; current malformed files fail visibly. */
export function readPreparedVisualization(
  value: unknown
): PreparedVisualization | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    "policyVersion" in value
  ) {
    const schema = value.schemaVersion;
    const policy = value.policyVersion;
    if (
      (typeof schema === "number" && Number.isInteger(schema) && schema > 1) ||
      (typeof policy === "number" &&
        Number.isInteger(policy) &&
        policy > 0 &&
        policy !== visualizationPolicyVersion)
    ) {
      return;
    }
  }
  const parsed = preparedSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      "The prepared visualization is malformed. Run spyglass scan again."
    );
  }
  const prepared = parsed.data;
  const islands = new Set(prepared.islands.map((island) => island.id));
  const foundations = new Set(
    prepared.foundations.map((foundation) => foundation.id)
  );
  const invalidReferences =
    prepared.foundations.some((foundation) => {
      const members = foundation.members.map((member) => member.territoryId);
      const lobes = foundation.lobes.map((lobe) => lobe.territoryId);
      return (
        members.length < 2 ||
        foundation.prominence !== members.length ||
        !(unique(members) && unique(lobes)) ||
        members.some((id) => !islands.has(id)) ||
        membershipKey(lobes) !== membershipKey(members)
      );
    }) ||
    !validGroups(prepared) ||
    !validInternalFoundations(prepared, islands);
  if (
    islands.size !== prepared.islands.length ||
    foundations.size !== prepared.foundations.length ||
    !unique(prepared.groups.map((group) => group.id)) ||
    !unique(prepared.internalFoundations.map((foundation) => foundation.id)) ||
    invalidReferences
  ) {
    throw new Error(
      "The prepared visualization has invalid or duplicate references. Run spyglass scan again."
    );
  }
  // Validation must not reorder keys: unchanged artifacts are reused byte-for-byte.
  return value as PreparedVisualization;
}
