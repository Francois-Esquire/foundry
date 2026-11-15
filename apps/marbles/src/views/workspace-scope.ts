import type { DashboardSnapshot } from "./dashboard-model";

/**
 * Which workspaces the dashboard's run and trigger lists show: this
 * workspace's view, what it owns and what is shared with it, or every
 * workspace's. Another workspace's run or trigger carries its owner
 * (`workspace`) and is shown, never controlled, here.
 */

interface Owned {
  readonly workspace?: { readonly id: string };
  readonly workspaces?: readonly string[];
}

/** `snapshot` with its runs and triggers narrowed to this workspace's view, unless `everywhere`. */
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

/** Whether the snapshot holds a run or trigger another workspace owns. */
export function showsOthers(snapshot: DashboardSnapshot): boolean {
  return (
    snapshot.runs.some(ownedElsewhere) || snapshot.triggers.some(ownedElsewhere)
  );
}

/** Another workspace owns it: its controls are that workspace's. */
export function ownedElsewhere(item: Owned): boolean {
  return item.workspace !== undefined;
}
