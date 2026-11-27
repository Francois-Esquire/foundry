import { basename } from "node:path";
import { asBusy } from "~/database/busy";
import type { StoreDatabase } from "~/database/open";
import { ALL_WORKSPACES, ResourceView } from "~/database/resources";
import type { ScheduleSnapshot } from "~/database/triggers";
import { storedSchedules } from "~/database/triggers";
import { WorkspaceRegistry } from "~/database/workspaces";
import { NODE_OWNER_LIVENESS } from "~/lib/node-host-liveness";
import { insideState } from "~/lib/state/workspace";
import type {
  OwnerWorkspace,
  RunSnapshot,
  TriggerSnapshot,
} from "~/model/dashboard";
import type { OtherWorkspaces } from "./snapshot";
import { storedRunSnapshot } from "./snapshot";

const RUNS = 100;
const REFRESH_MS = 2000;

export interface OtherWorkspacesOptions {
  readonly database: StoreDatabase;
  readonly state: string;
  readonly workspace: string;
}

export function otherWorkspaces(
  options: OtherWorkspacesOptions
): (now: number) => Promise<OtherWorkspaces> {
  const { database, state, workspace } = options;
  const registry = new WorkspaceRegistry({
    acceptWorkspace: (workspaceId) => insideState(state, workspaceId),
    database,
  });
  const view = new ResourceView({
    acceptWorkspace: (workspaceId) => insideState(state, workspaceId),
    database,
    scope: ALL_WORKSPACES,
  });
  let last: { readonly at: number; readonly read: OtherWorkspaces } | undefined;

  async function read(now: number): Promise<OtherWorkspaces> {
    const owners = new Map(
      (await registry.list()).map((record): [string, OwnerWorkspace] => [
        record.id,
        { id: record.id, name: basename(record.root) },
      ])
    );
    const ownerOf = (id: string): OwnerWorkspace =>
      owners.get(id) ?? { id, name: id };
    const runs = (await view.runs(RUNS))
      .filter(({ ref }) => ref.owner !== workspace)
      .map(({ ref, value }) =>
        ownedElsewhere(storedRunSnapshot(value.record, now), ownerOf(ref.owner))
      );
    const triggers: TriggerSnapshot[] = [];
    for (const owner of owners.values()) {
      if (owner.id !== workspace) {
        for (const stored of await storedSchedules(
          database,
          owner.id,
          NODE_OWNER_LIVENESS
        )) {
          triggers.push(triggerSnapshot(stored, owner));
        }
      }
    }
    return { runs, triggers };
  }

  return async (now) => {
    if (last === undefined || now - last.at >= REFRESH_MS) {
      try {
        last = { at: now, read: await asBusy(() => read(now)) };
      } catch {
        last = { at: now, read: { runs: [], triggers: [] } };
      }
    }
    return last.read;
  };
}

function ownedElsewhere(run: RunSnapshot, owner: OwnerWorkspace): RunSnapshot {
  return {
    ...run,
    ...(run.logs === undefined
      ? {}
      : {
          logs: run.logs.map((entry) => ({
            ...entry,
            id: JSON.stringify([owner.id, entry.id]),
          })),
        }),
    name: `${run.name} · ${owner.name}`,
    workspace: owner,
  };
}

function triggerSnapshot(
  stored: ScheduleSnapshot,
  owner: OwnerWorkspace
): TriggerSnapshot {
  const { key, kind, label, lastStatus, nextDue, pending, running } = stored;
  let status: TriggerSnapshot["status"] =
    kind === "monitor" ? "watching" : "waiting";
  if (lastStatus === "failed") {
    status = "failed";
  }
  if (running !== null) {
    status = "running";
  }
  return {
    description: `${kind} in ${owner.name}${pending === undefined ? "" : ` · a launch of ${pending} waits`}`,
    id: key,
    kind,
    name: `${label} · ${owner.name}`,
    ...(nextDue === undefined
      ? {}
      : { next: new Date(nextDue).toLocaleString() }),
    status,
    targetId: pending ?? key,
    workspace: owner,
  };
}
