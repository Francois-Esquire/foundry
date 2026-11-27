import type { ProcessIdentity } from "@foundry/lib/process-identity";
import type { JobOutcome, Occurrence } from "@foundry/scheduling";
import type { ScheduleStoreService } from "@foundry/scheduling/store";
import { makeSqliteScheduleStore } from "@foundry/scheduling/store/sqlite";
import { and, eq } from "drizzle-orm";
import { asBusy } from "~/database/busy";
import { readExecution } from "~/database/executions";
import { readDatabase } from "~/database/open";
import { marblesMonitorStates } from "~/database/tables";
import type { StoreDatabase } from "~/database/types";
import { stateDatabase } from "~/layout";
import { RecordsGate } from "~/lib/events/records";
import { NODE_OWNER_LIVENESS } from "~/lib/node-host-liveness";
import type { OwnerLiveness } from "~/lib/owner-liveness";
import { outcomeOf, scheduledTarget } from "~/lib/schedule";
import { refusedAt } from "~/lib/schedule-dispatch";
import type { MonitorState, TriggerStore } from "~/lib/trigger-store";
import {
  gatedScheduleStore,
  monitorStateSchema,
  storedMonitorState,
} from "~/lib/trigger-store";
import { runStoreEffect } from "~/lib/workflow-runs";

export interface DatabaseTriggerStoreOptions {
  readonly database: StoreDatabase;
  readonly scope: string;
}

export class DatabaseTriggerStore implements TriggerStore {
  readonly #database: StoreDatabase;
  readonly #scope: string;
  readonly #gate = new RecordsGate("the trigger store is closed");
  readonly #schedules: ScheduleStoreService;

  constructor(options: DatabaseTriggerStoreOptions) {
    this.#database = options.database;
    this.#scope = options.scope;
    this.#schedules = gatedScheduleStore(
      makeSqliteScheduleStore({
        database: options.database,
        scope: options.scope,
      }),
      (call) => this.#call(call)
    );
  }

  clearPendingLaunch(key: string): Promise<void> {
    return this.#call(async () => {
      await this.#database
        .update(marblesMonitorStates)
        .set({ pending: null })
        .where(this.#monitorKey(key));
    });
  }

  close(): Promise<void> {
    return this.#gate.close();
  }

  forgetMonitor(key: string): Promise<void> {
    return this.#call(async () => {
      await this.#database
        .delete(marblesMonitorStates)
        .where(this.#monitorKey(key));
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
        .where(this.#monitorKey(key));
      return row === undefined ? undefined : monitorStateOf(row);
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

  schedules(): Promise<ScheduleStoreService> {
    return this.#call(() => Promise.resolve(this.#schedules));
  }

  #monitorKey(key: string) {
    return and(
      eq(marblesMonitorStates.scope, this.#scope),
      eq(marblesMonitorStates.key, key)
    );
  }

  #call<T>(call: () => Promise<T>): Promise<T> {
    return this.#gate.run(() => asBusy(call));
  }
}

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

export interface ScheduleSnapshot {
  readonly key: string;
  readonly kind: "schedule" | "monitor";
  readonly label: string;
  readonly lastSettledAt?: string;
  readonly lastStatus?: JobOutcome;
  readonly nextDue?: string;
  readonly pending?: string;
  readonly running: number | null;
}

interface LatestOutcome {
  readonly lastSettledAt?: string;
  readonly lastStatus?: JobOutcome;
  readonly running: number | null;
}

const isoOf = (at: number) => new Date(at).toISOString();

const liveOwner = (
  owner: ProcessIdentity | undefined,
  liveness: OwnerLiveness
): number | null =>
  owner === undefined || liveness.isGone(owner) ? null : owner.pid;

async function latestOutcomeOf(
  database: StoreDatabase,
  scope: string,
  occurrence: Occurrence | undefined,
  liveness: OwnerLiveness
): Promise<LatestOutcome> {
  if (occurrence === undefined) {
    return { running: null };
  }
  const { state } = occurrence;
  if (state.kind === "settled") {
    return {
      lastSettledAt: isoOf(state.settledAt),
      lastStatus: state.outcome,
      running: null,
    };
  }
  if (state.kind === "claimed") {
    return { running: liveOwner(state.lease.owner, liveness) };
  }
  if (state.kind !== "dispatched") {
    return { running: null };
  }
  const refused = refusedAt(state.jobId);
  if (refused !== undefined) {
    return {
      lastSettledAt: isoOf(refused),
      lastStatus: "failed",
      running: null,
    };
  }
  const run = await readExecution(database, scope, state.jobId);
  if (run === null) {
    return { lastStatus: "cancelled", running: null };
  }
  const outcome = outcomeOf(run.status);
  return outcome === undefined
    ? { running: liveOwner(run.owner, liveness) }
    : {
        lastSettledAt: run.timestamps.settledAt ?? run.timestamps.updatedAt,
        lastStatus: outcome,
        running: null,
      };
}

export async function readStoredSchedules(
  state: string,
  scope: string,
  liveness: OwnerLiveness = NODE_OWNER_LIVENESS
): Promise<readonly ScheduleSnapshot[]> {
  return (
    (await asBusy(() =>
      readDatabase(stateDatabase(state), (database) =>
        storedSchedules(database, scope, liveness)
      )
    )) ?? []
  );
}

export function storedSchedules(
  database: StoreDatabase,
  scope: string,
  liveness: OwnerLiveness = NODE_OWNER_LIVENESS
): Promise<readonly ScheduleSnapshot[]> {
  return asBusy(async () => {
    const store = makeSqliteScheduleStore({ database, scope });
    const schedules = [...(await runStoreEffect(store.listSchedules))].sort(
      (a, b) => a.id.localeCompare(b.id)
    );
    const monitors = await database
      .select({
        key: marblesMonitorStates.key,
        pending: marblesMonitorStates.pending,
      })
      .from(marblesMonitorStates)
      .where(eq(marblesMonitorStates.scope, scope));
    const pending = new Map(
      monitors.flatMap((row) =>
        row.pending === null ? [] : [[row.key, row.pending.workflow] as const]
      )
    );
    const stored: ScheduleSnapshot[] = [];
    for (const schedule of schedules) {
      const target = scheduledTarget(schedule.target);
      const kind = target?.kind ?? "schedule";
      const cursor = await runStoreEffect(store.getCursor(schedule.id));
      const occurrences = await runStoreEffect(
        store.listOccurrences({ scheduleId: schedule.id })
      );
      const latest = await latestOutcomeOf(
        database,
        scope,
        occurrences.filter((each) => each.state.kind !== "skipped").at(-1),
        liveness
      );
      const settled = cursor?.lastSettledAt;
      const nextDueAt = cursor?.nextDueAt ?? null;
      const launch = kind === "monitor" ? pending.get(schedule.id) : undefined;
      stored.push({
        key: schedule.id,
        kind,
        label: target?.label ?? schedule.id,
        ...(settled === undefined ? {} : { lastSettledAt: isoOf(settled) }),
        ...latest,
        ...(nextDueAt === null ? {} : { nextDue: isoOf(nextDueAt) }),
        ...(launch === undefined ? {} : { pending: launch }),
      });
    }
    return stored;
  });
}
