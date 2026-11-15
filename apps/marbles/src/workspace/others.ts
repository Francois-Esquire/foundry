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

/**
 * What a hosted workspace's dashboard shows of the other workspaces, read
 * from the Marbles database: every run another workspace shares with this
 * one, read through this workspace's shares, and each other workspace's
 * newest runs, at most `RUNS` of each, each run with its steps as its
 * detail; and each trigger's last tick and pending launch
 * (`marbles_schedule_ticks`, `marbles_monitor_states`). A run shared with
 * this workspace names it among its `workspaces`, so the dashboard shows
 * it in this workspace's lists too, however many newer runs its owner
 * has.
 *
 * Everything here is read only: a control acts through this workspace's
 * engine, which holds only its own runs and triggers. Each run and
 * trigger keeps its own id, workflow and trigger, and carries its owner
 * (`workspace`); the dashboard tells items apart by owner and id together,
 * so two workspaces' runs or triggers of one id stay two. Names end with
 * the owner's. It is read again at most every `REFRESH_MS`; this
 * workspace's own runs and triggers stay live, from its engine.
 */

/** The most runs of each other workspace a dashboard shows, beside every one shared with this one. */
const RUNS = 100;
const REFRESH_MS = 2000;

export interface OtherWorkspacesOptions {
  readonly database: StoreDatabase;
  /** The Marbles state root. */
  readonly state: string;
  /** This workspace's id. */
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
        // Other workspaces are extra: this one's lists still show.
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
    // A log line's id is kept unique beside this workspace's own lines.
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
