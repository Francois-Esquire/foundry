import { ownedEvents } from "@foundry/lib/plain-json";
import { and, asc, eq, gt, gte, inArray, lt, lte, min, sql } from "drizzle-orm";
import { asBusy } from "~/database/busy";
import type { StoreDatabase } from "~/database/open";
import { readDatabase } from "~/database/open";
import {
  marblesChangeLogs,
  marblesChanges,
  marblesObservers,
} from "~/database/tables";
import { stateDatabase } from "~/layout";
import type {
  ChangeLog,
  ChangeQuery,
  CompactionBound,
  DeclaredObserver,
  LoggedChange,
  ObserverFailure,
  ObserverKey,
  ObserverMove,
  ObserverState,
} from "~/lib/events/log";
import { CHANGE_BATCH } from "~/lib/events/log";
import { causingRun, EmitListeners } from "~/lib/events/records";
import type { Fact } from "~/lib/events/source";

/**
 * A workspace's change log in the Marbles database: every change fact its
 * stores commit (`marbles_changes`), each at the next position of the
 * workspace's counter (`marbles_change_logs`), and each observer's place
 * (`marbles_observers`).
 *
 * Facts are written by `ChangeRecorder.record`, which each store's
 * `onCommit` hook calls on the transaction it is handed, so a change and
 * its facts commit or roll back together, and positions are taken in the
 * order commits land. The positions come from the counter, never from the
 * facts that survive, so none is given twice, after compaction too.
 */

/** Whatever transaction a package store hands its `onCommit` hook. */
type CommitTransaction = Pick<StoreDatabase, "insert">;

/**
 * The one way a workspace's stores record their change facts: shared by
 * every store of the workspace in this process, so a commit through any
 * of them wakes delivery here at once (`watch`).
 *
 * The run a write's facts were made by is read when the store is handed
 * the write, or the transaction it is written in (`causing`), while the
 * caller's code is on the stack, and kept by each fact's id until the
 * commit's hook records it, since a store may run the commit later,
 * behind others, in another async context.
 */
export class ChangeRecorder {
  readonly scope: string;
  readonly #causes = new Map<string, string>();
  readonly #listeners = new EmitListeners();
  #waking = false;

  constructor(scope: string) {
    this.scope = scope;
  }

  /**
   * `store`, each write handed to it noting the run calling as its facts'
   * cause; a transaction notes the run calling `transaction`, for every
   * write through its view. Every other property is the store's own.
   */
  causing<S extends object>(store: S): S {
    return this.#noting(store, causingRun);
  }

  /**
   * Record `events`, the facts of `source` one commit carries, in its own
   * `transaction`: never through a store, which would wait on the commit
   * that is running this. Each takes the next position of the counter.
   */
  async record(
    transaction: CommitTransaction,
    source: string,
    events: readonly Fact[] | undefined
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
    await transaction.insert(marblesChanges).values(
      events.map((fact, index) => ({
        id: fact.id,
        payload: fact,
        position: last - events.length + index + 1,
        recordedAt,
        runId: this.#causes.get(fact.id) ?? null,
        scope: this.scope,
        source,
        type: fact.type,
      }))
    );
    this.#wake();
  }

  /** Call `listener` soon after a commit here recorded a fact. */
  watch(listener: () => void): () => void {
    return this.#listeners.add(listener);
  }

  /** `store`, each write it is handed noted as made by the run `runOf` reads, then. */
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

  /**
   * Commit `write` through `commit`, its facts noted as made by
   * `runId`. The write's events are taken once, here, by the rule every
   * store takes them by (`ownedEvents`), and the store is handed that same
   * copy in their place, so the facts noted are the facts it stores; a
   * write whose events break the rule is refused before the store sees
   * it. Everything else in the write reaches the store as the caller
   * handed it, for the store to take by its own rules.
   */
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

  /**
   * Wake the watchers once the commit running now has settled: on the next
   * turn of the event loop, by which time a read this process makes waits
   * behind the commit's transaction, so it sees what it recorded. A commit
   * rolled back meanwhile only costs a look that finds nothing new.
   */
  #wake(): void {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Biome narrows the field to its initial value; a wake under way sets it.
    if (this.#waking) {
      return;
    }
    this.#waking = true;
    setImmediate(() => {
      this.#waking = false;
      this.#listeners.emit();
    });
  }
}

/**
 * `write` taken once, as the store is to be handed it: each of its own
 * properties read once, in a plain object, and `events` as the copy
 * already taken, so the store reads that and never the caller's getter
 * again. The values are not copied: the store takes them by its own rules.
 */
function withEvents(
  write: object,
  events: readonly Fact[] | undefined
): object {
  const taken: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(write)) {
    if (typeof key !== "string" || key === "events") {
      continue;
    }
    const value: unknown = Reflect.get(write, key);
    if (value !== undefined) {
      // Defined, not assigned, so a `__proto__` key stays an own property.
      Object.defineProperty(taken, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    }
  }
  if (events !== undefined) {
    taken.events = events;
  }
  return taken;
}

/** The change log of the workspace `scope` over `database`. */
export class DatabaseChangeLog implements ChangeLog {
  readonly #database: StoreDatabase;
  readonly #scope: string;

  constructor(database: StoreDatabase, scope: string) {
    this.#database = database;
    this.#scope = scope;
  }

  /**
   * One transaction: the floor is the lowest place of an observer seen
   * since `seenSince`, else the counter; what goes is every fact up to the
   * floor and up to the last that committed before `before`.
   */
  compact(bound: CompactionBound): Promise<number> {
    return this.#database.transaction(async (transaction) => {
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
      const [aged] = await transaction
        .select({
          position: sql<number | null>`max(${marblesChanges.position})`,
        })
        .from(marblesChanges)
        .where(
          and(
            eq(marblesChanges.scope, this.#scope),
            lte(marblesChanges.position, floor),
            lt(marblesChanges.recordedAt, bound.before)
          )
        );
      const through = aged?.position ?? 0;
      if (through <= head.compacted) {
        return 0;
      }
      const removed = await transaction
        .delete(marblesChanges)
        .where(
          and(
            eq(marblesChanges.scope, this.#scope),
            lte(marblesChanges.position, through)
          )
        )
        .returning({ position: marblesChanges.position });
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
      return removed.length;
    });
  }

  declare(key: ObserverKey, now: number): Promise<DeclaredObserver> {
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
      if (row.position >= head.compacted) {
        return { ...stateOf(row), fellBehind: false };
      }
      // Fell behind what compaction removed: say so, then go on after it.
      const behind = {
        missedFrom: row.position + 1,
        missedThrough: head.compacted,
        position: head.compacted,
      };
      await transaction
        .update(marblesObservers)
        .set(behind)
        .where(this.#where(key));
      return { ...stateOf({ ...row, ...behind }), fellBehind: true };
    });
  }

  async fail(key: ObserverKey, failure: ObserverFailure): Promise<void> {
    await this.#database
      .update(marblesObservers)
      .set({
        failures: sql`${marblesObservers.failures} + 1`,
        lastError: failure.error,
        retryAt: failure.retryAt,
        seenAt: failure.now,
      })
      .where(this.#where(key));
  }

  async head(): Promise<number> {
    return (await counterOf(this.#database, this.#scope)).position;
  }

  async move(key: ObserverKey, move: ObserverMove): Promise<boolean> {
    const moved = await this.#database
      .update(marblesObservers)
      .set({
        failures: 0,
        lastError: null,
        position: move.to,
        retryAt: null,
        seenAt: move.now,
      })
      .where(and(this.#where(key), eq(marblesObservers.position, move.from)))
      .returning({ position: marblesObservers.position });
    return moved.length > 0;
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

/**
 * The query `read` runs: one statement, walking the workspace's facts of
 * one source by position from `query.after`
 * (`marbles_changes_scope_source_position`), so its work is what is left
 * for the observer, not the whole log.
 */
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
          : inArray(marblesChanges.type, [...query.types])
      )
    )
    .orderBy(asc(marblesChanges.position))
    .limit(query.limit ?? CHANGE_BATCH);
}

/** The workspace's counter: the last position given, and the last compacted. */
async function counterOf(
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

/** Every observer of the workspace `scope`, by source, then name. */
async function readObservers(
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

/**
 * The observers of the workspace `scope` under the state root `state`, and
 * the position of its newest fact, for `marbles status`: read only, with
 * nothing when there is no database yet.
 */
export async function readStoredObservers(
  state: string,
  scope: string
): Promise<{
  readonly head: number;
  readonly observers: readonly ObserverState[];
}> {
  const read = await asBusy(() =>
    readDatabase(stateDatabase(state), async (database) => ({
      head: (await counterOf(database, scope)).position,
      observers: await readObservers(database, scope),
    }))
  );
  return read ?? { head: 0, observers: [] };
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
  };
}
