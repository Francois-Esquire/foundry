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
   * Remove the facts that committed before `before` and that every
   * observer still holding them back has completed, oldest first, as one
   * prefix of the log: how many went. An observer holds facts back while
   * the deliverer has it registered (`registered`, whose `seenAt` this
   * makes now, whatever it is doing: idle, in backoff, or stuck in a
   * call), or while it was seen since `seenSince`; one no engine has
   * registered for that long does not, and is told what it missed when it
   * next moves. Only the deliverer compacts: 0, and nothing removed, when
   * these records do not hold the claim.
   */
  compact(bound: CompactionBound): Promise<number>;
  /**
   * The observer `key`'s place, filed at the counter (from now) when it is
   * new, and seen at `now`. Nothing about its place changes here.
   */
  declare(key: ObserverKey, now: number): Promise<ObserverState>;
  /**
   * Record that `key` failed at `now` and is tried again at `retryAt`:
   * one more failure, with `error`, its place kept. Whether it was
   * written: only while these records hold the claim.
   */
  fail(key: ObserverKey, failure: ObserverFailure): Promise<boolean>;
  /** The position of the newest fact recorded, 0 before the first: a cheap read. */
  head(): Promise<number>;
  /**
   * Move `key` from `from` to `to`, at `now`, clearing its failures, in
   * one conditional write: only while it is still at `from` (so a move
   * another deliverer made first is never undone) and these records hold
   * the claim. When the positions it passes over include some compaction
   * removed, the same write records them as missed (`missed`), so no move
   * passes a gap in silence.
   */
  move(key: ObserverKey, move: ObserverMove): Promise<MoveOutcome>;
  /** Every observer filed in the workspace, by source, then name. */
  observers(): Promise<readonly ObserverState[]>;
  /** The facts of one source after a position, oldest first, detached. */
  read(query: ChangeQuery): Promise<readonly LoggedChange[]>;
  /**
   * Record that `key` is no longer stuck in a call: it settled, or its
   * deliverer is gone. Whether it was written: only while these records
   * hold the claim.
   */
  unstick(key: ObserverKey): Promise<boolean>;
}

/** What a `move` did. */
export type MoveOutcome =
  /** Moved; `missed` the positions compaction removed before it was handed them, if any. */
  | { readonly kind: "moved"; readonly missed: MissedRange | null }
  /** Not at `from` any more: another deliverer moved it. */
  | { readonly kind: "elsewhere" }
  /** These records no longer hold the claim: nothing written. */
  | { readonly kind: "unclaimed" };

/** Positions an observer passed over that compaction had removed. */
export interface MissedRange {
  readonly from: number;
  readonly through: number;
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
  /** The facts it last missed, removed before it received them; `null` when it missed none. */
  readonly missed: MissedRange | null;
  /** The last position it completed or passed over. */
  readonly position: number;
  /** When it is tried again, in epoch ms; `null` while it is well. */
  readonly retryAt: number | null;
  /**
   * When the call it is stuck in began, in epoch ms: a call that passed its
   * time limit and has not settled, so it is handed nothing until it does.
   * `null` while it is in no such call.
   */
  readonly stuckSince: number | null;
}

export interface ObserverFailure {
  readonly error: string;
  readonly now: number;
  readonly retryAt: number;
  /** When the call that failed began, if it passed its limit and has not settled; else `null`. */
  readonly stuckSince: number | null;
}

export interface ObserverMove {
  readonly from: number;
  /** Whether the fact at `to` was handed to the observer, so it is not one it missed. */
  readonly handed: boolean;
  readonly now: number;
  readonly to: number;
}

export interface CompactionBound {
  /** Only facts committed before this, in epoch ms. */
  readonly before: number;
  /** Now, in epoch ms: when the registered observers are seen. */
  readonly now: number;
  /** The observers the deliverer has registered: each holds facts back, and is seen now. */
  readonly registered: readonly ObserverKey[];
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
  stuckSince: number | null;
}

const KEY = (key: ObserverKey) => `${key.source}\0${key.name}`;

/**
 * The change log in this process's memory, for an engine with no
 * database: what `record` was handed, lasting as long as the engine. Its
 * records grant every claim, so it holds one for every write.
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
    for (const key of bound.registered) {
      const observer = this.#observers.get(KEY(key));
      if (observer !== undefined) {
        observer.seenAt = bound.now;
      }
    }
    const floor = Math.min(
      this.#position,
      ...[...this.#observers.values()]
        .filter((observer) => observer.seenAt >= bound.seenSince)
        .map((observer) => observer.position)
    );
    let aged = 0;
    for (const change of this.#changes) {
      if (change.recordedAt >= bound.before) {
        break;
      }
      aged = change.position;
    }
    const through = Math.min(floor, aged);
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
        stuckSince: null,
      };
      this.#observers.set(KEY(key), observer);
    }
    observer.seenAt = now;
    return Promise.resolve(stateOf(observer.key, observer));
  }

  fail(key: ObserverKey, failure: ObserverFailure): Promise<boolean> {
    const observer = this.#observers.get(KEY(key));
    if (observer !== undefined) {
      observer.failures += 1;
      observer.lastError = failure.error;
      observer.retryAt = failure.retryAt;
      observer.seenAt = failure.now;
      observer.stuckSince = failure.stuckSince;
    }
    return Promise.resolve(true);
  }

  head(): Promise<number> {
    return Promise.resolve(this.#position);
  }

  move(key: ObserverKey, move: ObserverMove): Promise<MoveOutcome> {
    const observer = this.#observers.get(KEY(key));
    if (observer === undefined || observer.position !== move.from) {
      return Promise.resolve({ kind: "elsewhere" });
    }
    const missed = missedBy(move, this.#compacted);
    observer.position = move.to;
    observer.failures = 0;
    observer.lastError = null;
    observer.retryAt = null;
    observer.seenAt = move.now;
    if (missed !== null) {
      observer.missed = missed;
    }
    return Promise.resolve({ kind: "moved", missed });
  }

  observers(): Promise<readonly ObserverState[]> {
    return Promise.resolve(
      [...this.#observers.values()]
        .map((observer) => stateOf(observer.key, observer))
        .sort(byKey)
    );
  }

  unstick(key: ObserverKey): Promise<boolean> {
    const observer = this.#observers.get(KEY(key));
    if (observer !== undefined) {
      observer.stuckSince = null;
    }
    return Promise.resolve(true);
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
 * The positions `move` passes over that compaction removed: those after
 * its `from` up to the compacted prefix's end (`compacted`) and its `to`,
 * or the one before `to` when the fact there was handed.
 * Facts there of other sources or types it would have passed over anyway,
 * so a range may name some it would never have been handed.
 */
export function missedBy(
  move: ObserverMove,
  compacted: number
): MissedRange | null {
  const through = Math.min(compacted, move.handed ? move.to - 1 : move.to);
  return through > move.from ? { from: move.from + 1, through } : null;
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
    stuckSince: observer.stuckSince,
  };
}

/** Observers by source, then name. */
function byKey(left: ObserverKey, right: ObserverKey): number {
  return (
    left.source.localeCompare(right.source) ||
    left.name.localeCompare(right.name)
  );
}
