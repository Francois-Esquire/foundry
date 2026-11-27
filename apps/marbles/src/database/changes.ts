import { ownedEvents } from "@foundry/lib/plain-json";
import { and, asc, eq, gt, gte, lte, min, sql } from "drizzle-orm";
import { batches, inList } from "~/database/lists";
import {
  marblesChangeLogs,
  marblesChanges,
  marblesDeliveryClaims,
  marblesObservers,
} from "~/database/tables";
import type { StoreDatabase } from "~/database/types";
import type {
  ChangeLog,
  ChangeQuery,
  CompactionBound,
  CompactionStep,
  LoggedChange,
  MoveOutcome,
  ObserverFailure,
  ObserverKey,
  ObserverMove,
  ObserverState,
} from "~/lib/events/log";
import { CHANGE_BATCH, COMPACTION_STEP } from "~/lib/events/log";
import { EmitListeners } from "~/lib/events/records-gate";
import type { Fact } from "~/lib/events/source";

type CommitTransaction = Pick<StoreDatabase, "insert">;

export class ChangeRecorder {
  readonly scope: string;
  readonly #causingRun: (() => string | undefined) | undefined;
  readonly #causes = new Map<string, string>();
  readonly #listeners = new EmitListeners();
  #waking = false;

  constructor(
    scope: string,
    options: { causingRun?: () => string | undefined } = {}
  ) {
    this.#causingRun = options.causingRun;
    this.scope = scope;
  }

  cause(): string | null {
    return this.#causingRun?.() ?? null;
  }

  causing<S extends object>(store: S): S {
    return this.#noting(store, () => this.#causingRun?.() ?? null);
  }

  async record(
    transaction: CommitTransaction,
    source: string,
    events: readonly Fact[] | undefined,
    cause: string | null = null
  ): Promise<void> {
    if (events === undefined || events.length === 0) {
      return;
    }
    const [counter] = await transaction
      .insert(marblesChangeLogs)
      .values({ position: events.length, scope: this.scope })
      .onConflictDoUpdate({
        set: {
          position: sql`${marblesChangeLogs.position} + ${events.length}`,
        },
        target: marblesChangeLogs.scope,
      })
      .returning({ position: marblesChangeLogs.position });
    const last = counter?.position ?? events.length;
    const recordedAt = Date.now();
    const rows = events.map((fact, index) => ({
      id: fact.id,
      payload: fact,
      position: last - events.length + index + 1,
      recordedAt,
      runId: this.#causes.get(fact.id) ?? cause,
      scope: this.scope,
      source,
      type: fact.type,
    }));
    for (const batch of batches(rows)) {
      await transaction.insert(marblesChanges).values(batch);
    }
    this.#wake();
  }

  watch(listener: () => void): () => void {
    return this.#listeners.add(listener);
  }

  #noting<S extends object>(store: S, runOf: () => string | null): S {
    return new Proxy(store, {
      get: (target, property) => {
        const value: unknown = Reflect.get(target, property, target);
        if (typeof value !== "function") {
          return value;
        }
        if (property === "commit") {
          return (write: object) =>
            this.#caused(write, runOf(), (taken) =>
              Reflect.apply(value, target, [taken])
            );
        }
        if (property === "transaction") {
          return (work: (view: object) => Promise<unknown>) => {
            const runId = runOf();
            return Reflect.apply(value, target, [
              (view: object) => work(this.#noting(view, () => runId)),
            ]);
          };
        }
        return value.bind(target);
      },
    });
  }

  async #caused(
    write: object,
    runId: string | null,
    commit: (taken: object) => unknown
  ): Promise<void> {
    const events = ownedEvents<Fact>(Reflect.get(write, "events"));
    const noted: string[] = [];
    if (runId !== null) {
      for (const { id } of events ?? []) {
        if (!this.#causes.has(id)) {
          this.#causes.set(id, runId);
          noted.push(id);
        }
      }
    }
    try {
      await commit(withEvents(write, events));
    } finally {
      for (const id of noted) {
        this.#causes.delete(id);
      }
    }
  }

  #wake(): void {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Biome narrows the field to its initial value; a wake under way sets it.
    if (this.#waking) {
      return;
    }
    this.#waking = true;
    setTimeout(() => {
      this.#waking = false;
      this.#listeners.emit();
    }, 0);
  }
}

function withEvents(
  write: object,
  events: readonly Fact[] | undefined
): object {
  const own = Reflect.getOwnPropertyDescriptor(write, "events");
  if (own !== undefined && !own.configurable && own.writable === false) {
    return write;
  }
  return new Proxy(write, {
    get: (target, property, receiver) =>
      property === "events" ? events : Reflect.get(target, property, receiver),
  });
}

export class DatabaseChangeLog implements ChangeLog {
  readonly #database: StoreDatabase;
  readonly #scope: string;
  readonly #owner: string;

  constructor(database: StoreDatabase, scope: string, owner: string) {
    this.#database = database;
    this.#scope = scope;
    this.#owner = owner;
  }

  compact(bound: CompactionBound): Promise<CompactionStep> {
    return this.#database.transaction(async (transaction) => {
      for (const key of bound.registered) {
        await transaction
          .update(marblesObservers)
          .set({ seenAt: bound.now })
          .where(this.#where(key));
      }
      const head = await counterOf(transaction, this.#scope);
      const [lowest] = await transaction
        .select({ position: min(marblesObservers.position) })
        .from(marblesObservers)
        .where(
          and(
            eq(marblesObservers.scope, this.#scope),
            gte(marblesObservers.seenAt, bound.seenSince)
          )
        );
      const floor = Math.min(head.position, lowest?.position ?? head.position);
      const window = Math.min(
        floor,
        head.compacted + (bound.limit ?? COMPACTION_STEP)
      );
      const [young] = await transaction
        .select({ position: min(marblesChanges.position) })
        .from(marblesChanges)
        .where(
          and(
            eq(marblesChanges.scope, this.#scope),
            gt(marblesChanges.position, head.compacted),
            lte(marblesChanges.position, window),
            gte(marblesChanges.recordedAt, bound.before)
          )
        );
      const youngest = young?.position ?? null;
      const through = youngest === null ? window : youngest - 1;
      if (through <= head.compacted) {
        return { done: true, removed: 0 };
      }
      const removed = await transaction
        .delete(marblesChanges)
        .where(
          and(
            eq(marblesChanges.scope, this.#scope),
            gt(marblesChanges.position, head.compacted),
            lte(marblesChanges.position, through)
          )
        );
      await transaction
        .insert(marblesChangeLogs)
        .values({
          compacted: through,
          position: head.position,
          scope: this.#scope,
        })
        .onConflictDoUpdate({
          set: { compacted: through },
          target: marblesChangeLogs.scope,
        });
      return {
        done: through < window || window === floor,
        removed: (removed as { readonly rowsAffected: number }).rowsAffected,
      };
    });
  }

  declare(key: ObserverKey, now: number): Promise<ObserverState> {
    return this.#database.transaction(async (transaction) => {
      const head = await counterOf(transaction, this.#scope);
      await transaction
        .insert(marblesObservers)
        .values({ ...this.#key(key), position: head.position, seenAt: now })
        .onConflictDoUpdate({
          set: { seenAt: now },
          target: [
            marblesObservers.scope,
            marblesObservers.source,
            marblesObservers.name,
          ],
        });
      const [row] = await transaction
        .select()
        .from(marblesObservers)
        .where(this.#where(key));
      if (row === undefined) {
        throw new Error(`observer ${key.name} was not filed`);
      }
      return stateOf(row);
    });
  }

  async fail(key: ObserverKey, failure: ObserverFailure): Promise<boolean> {
    const written = await this.#database
      .update(marblesObservers)
      .set({
        failures: sql`${marblesObservers.failures} + 1`,
        lastError: failure.error,
        retryAt: failure.retryAt,
        seenAt: failure.now,
        stuckSince: failure.stuckSince,
      })
      .where(and(this.#where(key), this.#holds()))
      .returning({ name: marblesObservers.name });
    return written.length > 0;
  }

  async unstick(key: ObserverKey): Promise<boolean> {
    const written = await this.#database
      .update(marblesObservers)
      .set({ stuckSince: null })
      .where(and(this.#where(key), this.#holds()))
      .returning({ name: marblesObservers.name });
    return written.length > 0;
  }

  async head(): Promise<number> {
    return (await counterOf(this.#database, this.#scope)).position;
  }

  async move(key: ObserverKey, move: ObserverMove): Promise<MoveOutcome> {
    const compacted = sql<number>`coalesce((select ${marblesChangeLogs.compacted} from ${marblesChangeLogs} where ${marblesChangeLogs.scope} = ${this.#scope}), 0)`;
    const last = move.handed ? move.to - 1 : move.to;
    const through = sql<number>`min(${compacted}, ${last})`;
    const passesGap = sql`${through} > ${move.from}`;
    const [moved] = await this.#database
      .update(marblesObservers)
      .set({
        failures: 0,
        lastError: null,
        missedFrom: sql`case when ${passesGap} then ${move.from + 1} else ${marblesObservers.missedFrom} end`,
        missedThrough: sql`case when ${passesGap} then ${through} else ${marblesObservers.missedThrough} end`,
        position: move.to,
        retryAt: null,
        seenAt: move.now,
      })
      .where(
        and(
          this.#where(key),
          eq(marblesObservers.position, move.from),
          this.#holds()
        )
      )
      .returning({
        gap: sql<number>`${passesGap}`,
        missedFrom: marblesObservers.missedFrom,
        missedThrough: marblesObservers.missedThrough,
      });
    if (moved === undefined) {
      return (await this.#holding(this.#database))
        ? { kind: "elsewhere" }
        : { kind: "unclaimed" };
    }
    return {
      kind: "moved",
      missed:
        moved.gap && moved.missedFrom !== null && moved.missedThrough !== null
          ? { from: moved.missedFrom, through: moved.missedThrough }
          : null,
    };
  }

  observers(): Promise<readonly ObserverState[]> {
    return readObservers(this.#database, this.#scope);
  }

  async read(query: ChangeQuery): Promise<readonly LoggedChange[]> {
    const rows = await changesAfter(this.#database, this.#scope, query);
    return rows.map((row) => ({
      fact: row.payload as Fact,
      position: row.position,
      runId: row.runId,
      source: row.source,
    }));
  }

  #holds() {
    return sql`exists (select 1 from ${marblesDeliveryClaims} where ${marblesDeliveryClaims.scope} = ${this.#scope} and ${marblesDeliveryClaims.ownerId} = ${this.#owner})`;
  }

  async #holding(database: Pick<StoreDatabase, "select">): Promise<boolean> {
    const [row] = await database
      .select({ ownerId: marblesDeliveryClaims.ownerId })
      .from(marblesDeliveryClaims)
      .where(eq(marblesDeliveryClaims.scope, this.#scope));
    return row?.ownerId === this.#owner;
  }

  #key(key: ObserverKey) {
    return { name: key.name, scope: this.#scope, source: key.source };
  }

  #where(key: ObserverKey) {
    return and(
      eq(marblesObservers.scope, this.#scope),
      eq(marblesObservers.source, key.source),
      eq(marblesObservers.name, key.name)
    );
  }
}

export function changesAfter(
  database: Pick<StoreDatabase, "select">,
  scope: string,
  query: ChangeQuery
) {
  return database
    .select({
      payload: marblesChanges.payload,
      position: marblesChanges.position,
      runId: marblesChanges.runId,
      source: marblesChanges.source,
    })
    .from(marblesChanges)
    .where(
      and(
        eq(marblesChanges.scope, scope),
        eq(marblesChanges.source, query.source),
        gt(marblesChanges.position, query.after),
        query.types === undefined
          ? undefined
          : inList(marblesChanges.type, query.types)
      )
    )
    .orderBy(asc(marblesChanges.position))
    .limit(query.limit ?? CHANGE_BATCH);
}

export async function counterOf(
  database: Pick<StoreDatabase, "select">,
  scope: string
): Promise<{ readonly compacted: number; readonly position: number }> {
  const [row] = await database
    .select({
      compacted: marblesChangeLogs.compacted,
      position: marblesChangeLogs.position,
    })
    .from(marblesChangeLogs)
    .where(eq(marblesChangeLogs.scope, scope));
  return row ?? { compacted: 0, position: 0 };
}

export async function readObservers(
  database: Pick<StoreDatabase, "select">,
  scope: string
): Promise<readonly ObserverState[]> {
  const rows = await database
    .select()
    .from(marblesObservers)
    .where(eq(marblesObservers.scope, scope))
    .orderBy(asc(marblesObservers.source), asc(marblesObservers.name));
  return rows.map(stateOf);
}

function stateOf(row: typeof marblesObservers.$inferSelect): ObserverState {
  return {
    failures: row.failures,
    lastError: row.lastError,
    missed:
      row.missedFrom === null || row.missedThrough === null
        ? null
        : { from: row.missedFrom, through: row.missedThrough },
    name: row.name,
    position: row.position,
    retryAt: row.retryAt,
    source: row.source,
    stuckSince: row.stuckSince,
  };
}
