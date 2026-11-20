import { basename } from "node:path";
import { asBusy } from "~/database/busy";
import type { StoreDatabase } from "~/database/open";
import { ALL_WORKSPACES, ResourceView } from "~/database/resources";
import type { StoredTick } from "~/database/triggers";
import { isMonitorTick, storedTicks } from "~/database/triggers";
import { WorkspaceRegistry } from "~/database/workspaces";
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
  const registry = new WorkspaceRegistry({ database, state });
  const view = new ResourceView({ database, scope: ALL_WORKSPACES, state });
  const here = new ResourceView({
    database,
    scope: { workspace },
    state,
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
    const shared = await here.sharedRuns();
    const seen = new Set(
      shared.map(({ ref }) => `${ref.owner}\u0000${ref.id}`)
    );
    const others = (await view.runs(RUNS)).filter(
      ({ ref }) =>
        ref.owner !== workspace && !seen.has(`${ref.owner}\u0000${ref.id}`)
    );
    const runs = [...shared, ...others]
      .sort(
        (a, b) =>
          b.value.record.timestamps.createdAt -
          a.value.record.timestamps.createdAt
      )
      .map(({ ref, value, workspaces }) =>
        ownedElsewhere(
          storedRunSnapshot(value.record, now),
          ownerOf(ref.owner),
          workspaces
        )
      );
    const triggers: TriggerSnapshot[] = [];
    for (const owner of owners.values()) {
      if (owner.id !== workspace) {
        for (const tick of await storedTicks(database, owner.id)) {
          triggers.push(triggerSnapshot(tick, owner));
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

function ownedElsewhere(
  run: RunSnapshot,
  owner: OwnerWorkspace,
  workspaces: readonly string[]
): RunSnapshot {
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
    ...(workspaces.length > 1 ? { workspaces } : {}),
  };
}

function triggerSnapshot(
  tick: StoredTick,
  owner: OwnerWorkspace
): TriggerSnapshot {
  const { key, last, pending, running } = tick;
  const kind = isMonitorTick(tick) ? "monitor" : "schedule";
  let status: TriggerSnapshot["status"] =
    kind === "monitor" ? "watching" : "waiting";
  if (last?.lastStatus === "failed") {
    status = "failed";
  }
  if (running !== null) {
    status = "running";
  }
  return {
    description: `${kind} in ${owner.name}${pending === undefined ? "" : ` · a launch of ${pending} waits`}`,
    id: key,
    kind,
    name: `${last?.label ?? key} · ${owner.name}`,
    ...(last === undefined
      ? {}
      : { next: new Date(last.nextDue).toLocaleString() }),
    status,
    targetId: pending ?? key,
    workspace: owner,
  };
}
