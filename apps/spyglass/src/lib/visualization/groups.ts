import type { DependencyFoundation, FoundationGroup } from "./types";

/** Group identity follows membership, never geometry, focus, or input order. */
export function foundationGroupId(memberIds: readonly string[]): string {
  return `foundation-group:${JSON.stringify([...new Set(memberIds)].sort())}`;
}

/**
 * Exact membership sets coalesce; partial overlaps retain separate
 * identities. A group is membership only: its shape is the structural
 * terrain's, from the settled layout.
 */
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
      const memberIds = JSON.parse(key) as string[];
      return {
        dependencyIds: dependencies.map((dependency) => dependency.id).sort(),
        id: foundationGroupId(memberIds),
        memberIds,
      };
    });
}
