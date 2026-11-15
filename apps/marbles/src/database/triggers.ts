import { randomUUID } from "node:crypto";
import { processAlive } from "@foundry/lib/process-identity";
import { and, asc, eq } from "drizzle-orm";
import { asBusy } from "~/database/busy";
import type { StoreDatabase } from "~/database/open";
import { readDatabase } from "~/database/open";
import { marblesMonitorStates, marblesScheduleTicks } from "~/database/tables";
import { stateDatabase } from "~/layout";
import { RecordsGate } from "~/lib/events/records";
import type {
  MonitorState,
  ScheduleHistory,
  TickClaim,
  TriggerStore,
} from "~/lib/trigger-store";
import {
  monitorStateSchema,
  scheduleHistorySchema,
  storedMonitorState,
} from "~/lib/trigger-store";

/**
 * A workspace's trigger state in the Marbles database, scoped by the
 * workspace id: each schedule's tick (`marbles_schedule_ticks`), and each
 * monitor's state (`marbles_monitor_states`), both by the trigger's key. A
 * claim on a tick is a transaction that reads the row's owner and takes
 * it, so two engines, in this process or another, never tick one trigger
 * at once; an owner whose process has exited holds nothing. Every call
 * surfaces a lock waited on too long as a `DatabaseBusyError`.
 */

export interface DatabaseTriggerStoreOptions {
  /** The database the host keeps open. */
  readonly database: StoreDatabase;
  /** The workspace id. */
  readonly scope: string;
}

export class DatabaseTriggerStore implements TriggerStore {
  readonly #database: StoreDatabase;
  readonly #scope: string;
  /** This store's identity as a tick's owner: one per engine. */
  readonly #owner = randomUUID();
  readonly #gate = new RecordsGate("the trigger store is closed");

  constructor(options: DatabaseTriggerStoreOptions) {
    this.#database = options.database;
    this.#scope = options.scope;
  }

  claimTick(key: string): Promise<TickClaim> {
    return this.#call(() =>
      this.#database.transaction(async (transaction) => {
        const [row] = await transaction
          .select({ ownerPid: marblesScheduleTicks.ownerPid })
          .from(marblesScheduleTicks)
          .where(this.#key(key));
        const holder = row?.ownerPid ?? null;
        if (holder !== null && processAlive(holder)) {
          return {
            claimed: false,
            holder:
              holder === process.pid ? "this process" : `pid ${String(holder)}`,
          } as const;
        }
        const owner = { ownerId: this.#owner, ownerPid: process.pid };
        await transaction
          .insert(marblesScheduleTicks)
          .values({ ...owner, key, scope: this.#scope })
          .onConflictDoUpdate({
            set: owner,
            target: [marblesScheduleTicks.scope, marblesScheduleTicks.key],
          });
        return { claimed: true } as const;
      })
    );
  }

  clearPendingLaunch(key: string): Promise<void> {
    return this.#call(async () => {
      await this.#database
        .update(marblesMonitorStates)
        .set({ pending: null })
        .where(
          and(
            eq(marblesMonitorStates.scope, this.#scope),
            eq(marblesMonitorStates.key, key)
          )
        );
    });
  }

  /**
   * Refuse every call from now on, once those under way have settled, then
   * give up every tick this store still holds: one cut short by a stop is
   * claimed by the next engine at once, not once this process exits.
   */
  async close(): Promise<void> {
    await this.#gate.close();
    await asBusy(() =>
      this.#database
        .update(marblesScheduleTicks)
        .set({ ownerId: null, ownerPid: null })
        .where(
          and(
            eq(marblesScheduleTicks.scope, this.#scope),
            eq(marblesScheduleTicks.ownerId, this.#owner)
          )
        )
    );
  }

  finishTick(key: string, tick?: ScheduleHistory): Promise<void> {
    return this.#call(async () => {
      const recorded =
        tick === undefined ? {} : scheduleHistorySchema.parse(tick);
      await this.#database
        .update(marblesScheduleTicks)
        .set({
          ...recorded,
          ...(tick === undefined
            ? {}
            : { kind: tick.kind ?? null, label: tick.label ?? null }),
          ownerId: null,
          ownerPid: null,
        })
        .where(
          and(this.#key(key), eq(marblesScheduleTicks.ownerId, this.#owner))
        );
    });
  }

  lastTick(key: string): Promise<ScheduleHistory | undefined> {
    return this.#call(async () => {
      const [row] = await this.#database
        .select()
        .from(marblesScheduleTicks)
        .where(this.#key(key));
      return row === undefined ? undefined : tickOf(row);
    });
  }

  monitorState(key: string): Promise<MonitorState | undefined> {
    return this.#call(async () => {
      const [row] = await this.#database
        .select({
          observed: marblesMonitorStates.observed,
          pending: marblesMonitorStates.pending,
        })
        .from(marblesMonitorStates)
        .where(
          and(
            eq(marblesMonitorStates.scope, this.#scope),
            eq(marblesMonitorStates.key, key)
          )
        );
      if (row === undefined) {
        return;
      }
      const { observed, pending } = monitorStateSchema.parse({
        observed: row.observed,
        ...(row.pending === null ? {} : { pending: row.pending }),
      });
      return pending === undefined
        ? { observed }
        : {
            observed,
            pending: { input: pending.input, workflow: pending.workflow },
          };
    });
  }

  saveMonitorState(key: string, state: MonitorState): Promise<void> {
    return this.#call(async () => {
      const { observed, pending } = storedMonitorState(key, state);
      const values = {
        observed,
        pending:
          pending === undefined
            ? null
            : { input: pending.input, workflow: pending.workflow },
      };
      await this.#database
        .insert(marblesMonitorStates)
        .values({ ...values, key, scope: this.#scope })
        .onConflictDoUpdate({
          set: values,
          target: [marblesMonitorStates.scope, marblesMonitorStates.key],
        });
    });
  }

  #key(key: string) {
    return and(
      eq(marblesScheduleTicks.scope, this.#scope),
      eq(marblesScheduleTicks.key, key)
    );
  }

  #call<T>(call: () => Promise<T>): Promise<T> {
    return this.#gate.run(() => asBusy(call));
  }
}

type TickRow = typeof marblesScheduleTicks.$inferSelect;

/** A row's last tick; `undefined` while it holds only a claim. */
function tickOf(row: TickRow): ScheduleHistory | undefined {
  if (
    row.lastFinish === null ||
    row.lastStart === null ||
    row.lastStatus === null ||
    row.nextDue === null
  ) {
    return undefined;
  }
  return scheduleHistorySchema.parse({
    ...(row.kind === null ? {} : { kind: row.kind }),
    ...(row.label === null ? {} : { label: row.label }),
    lastFinish: row.lastFinish,
    lastStart: row.lastStart,
    lastStatus: row.lastStatus,
    nextDue: row.nextDue,
  });
}

/** A trigger as `status` lists it. */
export interface StoredTick {
  readonly key: string;
  /** Its last tick; `undefined` before its first. */
  readonly last?: ScheduleHistory;
  /** The process whose tick of it is under way, if one is. */
  readonly running: number | null;
}

/**
 * Every trigger the workspace `scope` has ticked, or is ticking now, in
 * the Marbles database at the state root `state`, by key, read only.
 * Empty with no database, or nothing migrated into it. A tick it cannot
 * read is listed as none.
 */
export async function readStoredTicks(
  state: string,
  scope: string
): Promise<readonly StoredTick[]> {
  const rows = await asBusy(() =>
    readDatabase(stateDatabase(state), (database) =>
      database
        .select()
        .from(marblesScheduleTicks)
        .where(eq(marblesScheduleTicks.scope, scope))
        .orderBy(asc(marblesScheduleTicks.key))
    )
  );
  return (rows ?? []).flatMap((row): StoredTick[] => {
    let last: ScheduleHistory | undefined;
    try {
      last = tickOf(row);
    } catch {
      last = undefined;
    }
    const running =
      row.ownerPid !== null && processAlive(row.ownerPid) ? row.ownerPid : null;
    // A claim its dead owner left, on a trigger that never ticked, is nothing.
    if (last === undefined && running === null) {
      return [];
    }
    return [{ key: row.key, ...(last === undefined ? {} : { last }), running }];
  });
}
