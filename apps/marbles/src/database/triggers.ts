import { randomUUID } from "node:crypto";
import { sameProcess, thisProcess } from "@foundry/lib/process-identity";
import { and, asc, eq, isNull } from "drizzle-orm";
import { asBusy } from "~/database/busy";
import type { StoreDatabase } from "~/database/open";
import { readDatabase } from "~/database/open";
import {
  CHANGED,
  claimJudged,
  heldBy,
  NO_OWNER,
  ownedHere,
  sameOwnerColumns,
} from "~/database/owner";
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
    const look = (database: StoreDatabase) =>
      database
        .select({
          ownerId: marblesScheduleTicks.ownerId,
          ownerPid: marblesScheduleTicks.ownerPid,
          ownerStarted: marblesScheduleTicks.ownerStarted,
        })
        .from(marblesScheduleTicks)
        .where(this.#key(key))
        .then(([row]) => row);
    const refused = {
      claimed: false,
      holder: "an owner that kept changing",
    } as const;
    return this.#call(() =>
      claimJudged(
        () => look(this.#database),
        // Asked outside the transaction: no process is asked under its lock.
        (seen) => (seen === undefined ? null : heldBy(seen)),
        (seen, holder) =>
          this.#database.transaction(
            async (transaction): Promise<TickClaim | typeof CHANGED> => {
              if (!sameOwnerColumns(await look(transaction), seen)) {
                return CHANGED;
              }
              if (holder !== null) {
                return {
                  claimed: false,
                  holder: sameProcess(holder, thisProcess())
                    ? "this process"
                    : `pid ${String(holder.pid)}`,
                } as const;
              }
              const owner = ownedHere(this.#owner);
              await transaction
                .insert(marblesScheduleTicks)
                .values({ ...owner, key, scope: this.#scope })
                .onConflictDoUpdate({
                  set: owner,
                  target: [
                    marblesScheduleTicks.scope,
                    marblesScheduleTicks.key,
                  ],
                });
              return { claimed: true } as const;
            }
          ),
        refused
      )
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
        .set(NO_OWNER)
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
      await this.#database.transaction(async (transaction) => {
        const finished = await transaction
          .update(marblesScheduleTicks)
          .set({
            ...recorded,
            ...(tick === undefined
              ? {}
              : { kind: tick.kind ?? null, label: tick.label ?? null }),
            ...NO_OWNER,
          })
          .where(
            and(this.#key(key), eq(marblesScheduleTicks.ownerId, this.#owner))
          )
          .returning({ key: marblesScheduleTicks.key });
        // A schedule's tick, recorded: nothing a monitor left under the key
        // is its, nor will be a later monitor's there.
        if (finished.length > 0 && tick?.kind === "schedule") {
          await transaction
            .delete(marblesMonitorStates)
            .where(
              and(
                eq(marblesMonitorStates.scope, this.#scope),
                eq(marblesMonitorStates.key, key)
              )
            );
        }
      });
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
      const row = await this.#monitorRow(this.#database, key);
      if (row === undefined) {
        return;
      }
      if ((await this.#lastKind(this.#database, key)) !== "schedule") {
        return monitorStateOf(row);
      }
      // What a monitor left under a key a schedule ticked last (as an older
      // Marbles left it) is no monitor's now: dropped here, never handed
      // out. Looked at again in the write: a monitor that kept its state
      // there meanwhile gets back what it kept.
      const kept = await this.#database.transaction(async (transaction) => {
        if ((await this.#lastKind(transaction, key)) === "schedule") {
          await transaction
            .delete(marblesMonitorStates)
            .where(this.#monitorKey(key));
          return;
        }
        return this.#monitorRow(transaction, key);
      });
      return kept === undefined ? undefined : monitorStateOf(kept);
    });
  }

  /** The monitor `key`'s row as `database` holds it. */
  async #monitorRow(
    database: StoreDatabase,
    key: string
  ): Promise<MonitorRow | undefined> {
    const [row] = await database
      .select({
        observed: marblesMonitorStates.observed,
        pending: marblesMonitorStates.pending,
      })
      .from(marblesMonitorStates)
      .where(this.#monitorKey(key));
    return row;
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
      await this.#database.transaction(async (transaction) => {
        await transaction
          .insert(marblesMonitorStates)
          .values({ ...values, key, scope: this.#scope })
          .onConflictDoUpdate({
            set: values,
            target: [marblesMonitorStates.scope, marblesMonitorStates.key],
          });
        // A monitor keeps its state under the key: the key is a monitor's
        // from now, before its tick is recorded, so a stop in between
        // keeps what it saw and the launch it handed over. A schedule's
        // history there is none of the monitor's: no label or time of it
        // stays. History that names no kind may be the monitor's own.
        await transaction
          .update(marblesScheduleTicks)
          .set({
            kind: "monitor",
            label: null,
            lastFinish: null,
            lastStart: null,
            lastStatus: null,
            nextDue: null,
          })
          .where(
            and(this.#key(key), eq(marblesScheduleTicks.kind, "schedule"))
          );
        await transaction
          .update(marblesScheduleTicks)
          .set({ kind: "monitor" })
          .where(and(this.#key(key), isNull(marblesScheduleTicks.kind)));
      });
    });
  }

  /** The kind the key's last recorded tick names, if any. */
  async #lastKind(
    database: StoreDatabase,
    key: string
  ): Promise<string | null | undefined> {
    const [tick] = await database
      .select({ kind: marblesScheduleTicks.kind })
      .from(marblesScheduleTicks)
      .where(this.#key(key));
    return tick?.kind;
  }

  #monitorKey(key: string) {
    return and(
      eq(marblesMonitorStates.scope, this.#scope),
      eq(marblesMonitorStates.key, key)
    );
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
type MonitorRow = Pick<
  typeof marblesMonitorStates.$inferSelect,
  "observed" | "pending"
>;

/** A monitor's row as the state it keeps. */
function monitorStateOf(row: MonitorRow): MonitorState {
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
}

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

/** A trigger as `status` and the dashboard list it. */
export interface StoredTick {
  readonly key: string;
  /** Its last tick; `undefined` before its first. */
  readonly last?: ScheduleHistory;
  /**
   * The workflow a monitor handed a launch to that no tick has started
   * yet; never set for a trigger whose history says it is a schedule.
   */
  readonly pending?: string;
  /** The process whose tick of it is under way, if one is. */
  readonly running: number | null;
}

/**
 * Whether a stored trigger is a monitor: its history decides when it names
 * a kind; else a launch it handed over says so, which only a monitor does.
 * The one rule every reader of stored ticks shows a trigger's kind by.
 */
export function isMonitorTick(
  tick: Pick<StoredTick, "last" | "pending">
): boolean {
  const named = tick.last?.kind;
  return named === undefined ? tick.pending !== undefined : named === "monitor";
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
  return (
    (await asBusy(() =>
      readDatabase(stateDatabase(state), (database) =>
        storedTicks(database, scope)
      )
    )) ?? []
  );
}

/** Every trigger the workspace `scope` has ticked or is ticking, in `database`, by key. */
export async function storedTicks(
  database: StoreDatabase,
  scope: string
): Promise<readonly StoredTick[]> {
  const [rows, monitors] = await asBusy(async () => [
    await database
      .select()
      .from(marblesScheduleTicks)
      .where(eq(marblesScheduleTicks.scope, scope))
      .orderBy(asc(marblesScheduleTicks.key)),
    await database
      .select({
        key: marblesMonitorStates.key,
        pending: marblesMonitorStates.pending,
      })
      .from(marblesMonitorStates)
      .where(eq(marblesMonitorStates.scope, scope)),
  ]);
  const pending = new Map(
    monitors.flatMap((row) =>
      row.pending === null ? [] : [[row.key, row.pending.workflow] as const]
    )
  );
  return rows.flatMap((row): StoredTick[] => {
    let last: ScheduleHistory | undefined;
    try {
      last = tickOf(row);
    } catch {
      last = undefined;
    }
    const running = heldBy(row)?.pid ?? null;
    // A launch a monitor left is none of a trigger whose history says it
    // is a schedule (a database from before a schedule's tick dropped it).
    const launch = last?.kind === "schedule" ? undefined : pending.get(row.key);
    // A claim its dead owner left, on a trigger that never ticked and has no
    // launch waiting, is nothing.
    if (last === undefined && running === null && launch === undefined) {
      return [];
    }
    return [
      {
        key: row.key,
        ...(last === undefined ? {} : { last }),
        ...(launch === undefined ? {} : { pending: launch }),
        running,
      },
    ];
  });
}
