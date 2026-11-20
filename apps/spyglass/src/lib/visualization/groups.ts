import type { DependencyFoundation, FoundationGroup } from "./types";

function foundationGroupId(memberIds: readonly string[]): string {
  return `foundation-group:${JSON.stringify([...new Set(memberIds)].sort())}`;
}

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
