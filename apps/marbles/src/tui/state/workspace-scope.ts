import type { DashboardSnapshot } from "./dashboard-model";

interface Owned {
  readonly workspace?: { readonly id: string };
  readonly workspaces?: readonly string[];
}

export function workspaceScoped(
  snapshot: DashboardSnapshot,
  everywhere: boolean
): DashboardSnapshot {
  if (everywhere) {
    return snapshot;
  }
  const here = (item: Owned): boolean =>
    item.workspace === undefined ||
    (snapshot.workspaceId !== undefined &&
      (item.workspaces ?? []).includes(snapshot.workspaceId));
  return {
    ...snapshot,
    runs: snapshot.runs.filter(here),
    triggers: snapshot.triggers.filter(here),
  };
}

export function showsOthers(snapshot: DashboardSnapshot): boolean {
  return (
    snapshot.runs.some(ownedElsewhere) || snapshot.triggers.some(ownedElsewhere)
  );
}

export function ownedElsewhere(item: Owned): boolean {
  return item.workspace !== undefined;
}
