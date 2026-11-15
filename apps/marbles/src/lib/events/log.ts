import type { Fact } from "~/lib/events/source";

/**
 * A workspace's change log, as delivery reads and moves through it: every
 * change fact the workspace's stores committed, each at a position taken
 * from the workspace's counter, so positions follow commit order and are
 * never given twice, compaction or not; and each observer's place in it.
 *
 * An observer is known by its key, its source and its name, within the
 * workspace: a handler's code is no part of it, so editing a handler keeps
 * its place and renaming it starts a new observer. A new observer starts
 * from now, at the counter, never from the beginning of the log.
 *
 * Marbles keeps it in the Marbles database (`database/changes.ts`); an
 * engine with no database keeps its tasks' facts in memory
 * (`MemoryChangeLog`).
 */
export interface ChangeLog {
  /**
   * Remove the facts every observer seen since `seenSince` (epoch ms) has
   * completed and that committed before `before`, oldest first, as one
   * prefix of the log: how many went. An observer not seen since then does
   * not hold them back; once declared again it is told what it missed.
   */
  compact(bound: CompactionBound): Promise<number>;
  /**
   * The observer `key`'s place, filed at the counter (from now) when it is
   * new, and seen at `now`: one that fell behind the compacted prefix is
   * moved past it, and what it missed is recorded on it (`missed`).
   */
  declare(key: ObserverKey, now: number): Promise<ObserverState>;
  /**
   * Record that `key` failed at `now` and is tried again at `retryAt`:
   * one more failure, with `error`, its place kept.
   */
  fail(key: ObserverKey, failure: ObserverFailure): Promise<void>;
  /** The position of the newest fact recorded, 0 before the first: a cheap read. */
  head(): Promise<number>;
  /**
   * Move `key` from `from` to `to`, at `now`, only while it is still at
   * `from`, clearing its failures: whether it moved. A move another
   * deliverer made first is never undone.
   */
  move(key: ObserverKey, move: ObserverMove): Promise<boolean>;
  /** Every observer filed in the workspace, by source, then name. */
  observers(): Promise<readonly ObserverState[]>;
  /** The facts of one source after a position, oldest first, detached. */
  read(query: ChangeQuery): Promise<readonly LoggedChange[]>;
}

/** An observer's identity within its workspace. */
export interface ObserverKey {
  readonly name: string;
  /** The source's key (`sourceKey`). */
  readonly source: string;
}

/** An observer's place in the log, and how it is faring. */
export interface ObserverState extends ObserverKey {
  /** Failures since its last success; 0 while it is well. */
  readonly failures: number;
  /** What its last failure said; `null` while it is well. */
  readonly lastError: string | null;
  /** The facts it missed, removed before it received them; `null` when it missed none. */
  readonly missed: { readonly from: number; readonly through: number } | null;
  /** The last position it completed or passed over. */
  readonly position: number;
  /** When it is tried again, in epoch ms; `null` while it is well. */
  readonly retryAt: number | null;
}

export interface ObserverFailure {
  readonly error: string;
  readonly now: number;
  readonly retryAt: number;
}

export interface ObserverMove {
  readonly from: number;
  readonly now: number;
  readonly to: number;
}

export interface CompactionBound {
  /** Only facts committed before this, in epoch ms. */
  readonly before: number;
  /** Only observers seen since this, in epoch ms, hold facts back. */
  readonly seenSince: number;
}

/** Which facts `read` returns. */
export interface ChangeQuery {
  /** Only facts after this position. */
  readonly after: number;
  /** At most this many; `CHANGE_BATCH` when omitted. */
  readonly limit?: number;
  /** The source's key. */
  readonly source: string;
  /** Only facts of these types; every type when omitted. */
  readonly types?: readonly string[];
}

/** How many facts one `read` returns by default. */
export const CHANGE_BATCH = 100;

/** A fact as the log holds it. */
export interface LoggedChange {
  readonly fact: Fact;
  readonly position: number;
  /** The run whose work made the change; `null` when none did. */
  readonly runId: string | null;
  readonly source: string;
}

/** A fact as a store hands it to the log, with what made it. */
export interface RecordedFact {
  readonly fact: Fact;
  readonly recordedAt: number;
  readonly runId: string | null;
  readonly source: string;
}

interface MemoryObserver {
  failures: number;
  lastError: string | null;
  missed: { readonly from: number; readonly through: number } | null;
  position: number;
  retryAt: number | null;
  seenAt: number;
}

const KEY = (key: ObserverKey) => `${key.source}\0${key.name}`;

/**
 * The change log in this process's memory, for an engine with no
 * database: what `record` was handed, lasting as long as the engine.
 */
export class MemoryChangeLog implements ChangeLog {
  readonly #changes: (RecordedFact & { readonly position: number })[] = [];
  readonly #observers = new Map<
    string,
    MemoryObserver & { readonly key: ObserverKey }
  >();
  #position = 0;
  #compacted = 0;

  /** Append `facts`, each at the next position. */
  record(facts: readonly RecordedFact[]): void {
    for (const fact of facts) {
      this.#position += 1;
      this.#changes.push({
        ...structuredClone(fact),
        position: this.#position,
      });
    }
  }

  compact(bound: CompactionBound): Promise<number> {
    const through = compactionPoint(
      [...this.#observers.values()],
      bound,
      this.#position,
      this.#changes
    );
    const kept = this.#changes.filter((change) => change.position > through);
    const removed = this.#changes.length - kept.length;
    this.#changes.splice(0, this.#changes.length, ...kept);
    this.#compacted = Math.max(this.#compacted, through);
    return Promise.resolve(removed);
  }

  declare(key: ObserverKey, now: number): Promise<ObserverState> {
    let observer = this.#observers.get(KEY(key));
    if (observer === undefined) {
      observer = {
        failures: 0,
        key,
        lastError: null,
        missed: null,
        position: this.#position,
        retryAt: null,
        seenAt: now,
      };
      this.#observers.set(KEY(key), observer);
    }
    observer.seenAt = now;
    if (observer.position < this.#compacted) {
      observer.missed = {
        from: observer.position + 1,
        through: this.#compacted,
      };
      observer.position = this.#compacted;
    }
    return Promise.resolve(stateOf(observer.key, observer));
  }

  fail(key: ObserverKey, failure: ObserverFailure): Promise<void> {
    const observer = this.#observers.get(KEY(key));
    if (observer !== undefined) {
      observer.failures += 1;
      observer.lastError = failure.error;
      observer.retryAt = failure.retryAt;
      observer.seenAt = failure.now;
    }
    return Promise.resolve();
  }

  head(): Promise<number> {
    return Promise.resolve(this.#position);
  }

  move(key: ObserverKey, move: ObserverMove): Promise<boolean> {
    const observer = this.#observers.get(KEY(key));
    if (observer === undefined || observer.position !== move.from) {
      return Promise.resolve(false);
    }
    observer.position = move.to;
    observer.failures = 0;
    observer.lastError = null;
    observer.retryAt = null;
    observer.seenAt = move.now;
    return Promise.resolve(true);
  }

  observers(): Promise<readonly ObserverState[]> {
    return Promise.resolve(
      [...this.#observers.values()]
        .map((observer) => stateOf(observer.key, observer))
        .sort(byKey)
    );
  }

  read(query: ChangeQuery): Promise<readonly LoggedChange[]> {
    return Promise.resolve(
      this.#changes
        .filter(
          (change) =>
            change.position > query.after &&
            change.source === query.source &&
            (query.types === undefined ||
              query.types.includes(change.fact.type))
        )
        .slice(0, query.limit ?? CHANGE_BATCH)
        .map((change) => ({
          fact: structuredClone(change.fact),
          position: change.position,
          runId: change.runId,
          source: change.source,
        }))
    );
  }
}

/**
 * The last position compaction may remove through: below every observer
 * seen since `bound.seenSince`, and no later than the last fact committed
 * before `bound.before`, so what goes is one prefix of the log.
 */
function compactionPoint(
  observers: readonly MemoryObserver[],
  bound: CompactionBound,
  head: number,
  changes: readonly (RecordedFact & { readonly position: number })[]
): number {
  const floor = Math.min(
    head,
    ...observers
      .filter((observer) => observer.seenAt >= bound.seenSince)
      .map((observer) => observer.position)
  );
  let aged = 0;
  for (const change of changes) {
    if (change.recordedAt >= bound.before) {
      break;
    }
    aged = change.position;
  }
  return Math.min(floor, aged);
}

function stateOf(key: ObserverKey, observer: MemoryObserver): ObserverState {
  return {
    failures: observer.failures,
    lastError: observer.lastError,
    missed: observer.missed,
    name: key.name,
    position: observer.position,
    retryAt: observer.retryAt,
    source: key.source,
  };
}

/** Observers by source, then name. */
function byKey(left: ObserverKey, right: ObserverKey): number {
  return (
    left.source.localeCompare(right.source) ||
    left.name.localeCompare(right.name)
  );
}
