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

export interface DatabaseTriggerStoreOptions {
  readonly database: StoreDatabase;
  readonly scope: string;
}

export class DatabaseTriggerStore implements TriggerStore {
  readonly #database: StoreDatabase;
  readonly #scope: string;
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

type MonitorRow = Pick<
  typeof marblesMonitorStates.$inferSelect,
  "observed" | "pending"
>;

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

export interface StoredTick {
  readonly key: string;
  readonly last?: ScheduleHistory;
  readonly pending?: string;
  readonly running: number | null;
}

export function isMonitorTick(
  tick: Pick<StoredTick, "last" | "pending">
): boolean {
  const named = tick.last?.kind;
  return named === undefined ? tick.pending !== undefined : named === "monitor";
}

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
    const launch = last?.kind === "schedule" ? undefined : pending.get(row.key);
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
