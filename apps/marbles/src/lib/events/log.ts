import type { Fact } from "~/lib/events/source";

export interface ChangeLog {
  compact(bound: CompactionBound): Promise<CompactionStep>;
  declare(key: ObserverKey, now: number): Promise<ObserverState>;
  fail(key: ObserverKey, failure: ObserverFailure): Promise<boolean>;
  head(): Promise<number>;
  move(key: ObserverKey, move: ObserverMove): Promise<MoveOutcome>;
  observers(): Promise<readonly ObserverState[]>;
  read(query: ChangeQuery): Promise<readonly LoggedChange[]>;
  unstick(key: ObserverKey): Promise<boolean>;
}

export type MoveOutcome =
  | { readonly kind: "moved"; readonly missed: MissedRange | null }
  | { readonly kind: "elsewhere" }
  | { readonly kind: "unclaimed" };

export interface MissedRange {
  readonly from: number;
  readonly through: number;
}

export interface ObserverKey {
  readonly name: string;
  readonly source: string;
}

export interface ObserverState extends ObserverKey {
  readonly failures: number;
  readonly lastError: string | null;
  readonly missed: MissedRange | null;
  readonly position: number;
  readonly retryAt: number | null;
  readonly stuckSince: number | null;
}

export interface ObserverFailure {
  readonly error: string;
  readonly now: number;
  readonly retryAt: number;
  readonly stuckSince: number | null;
}

export interface ObserverMove {
  readonly from: number;
  readonly handed: boolean;
  readonly now: number;
  readonly to: number;
}

export interface CompactionStep {
  readonly done: boolean;
  readonly removed: number;
}

export const COMPACTION_STEP = 5000;

export interface CompactionBound {
  readonly before: number;
  readonly limit?: number;
  readonly now: number;
  readonly registered: readonly ObserverKey[];
  readonly seenSince: number;
}

export interface ChangeQuery {
  readonly after: number;
  readonly limit?: number;
  readonly source: string;
  readonly types?: readonly string[];
}

export const CHANGE_BATCH = 100;

export interface LoggedChange {
  readonly fact: Fact;
  readonly position: number;
  readonly runId: string | null;
  readonly source: string;
}

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

export class MemoryChangeLog implements ChangeLog {
  readonly #changes: (RecordedFact & { readonly position: number })[] = [];
  readonly #observers = new Map<
    string,
    MemoryObserver & { readonly key: ObserverKey }
  >();
  #position = 0;
  #compacted = 0;

  record(facts: readonly RecordedFact[]): void {
    for (const fact of facts) {
      this.#position += 1;
      this.#changes.push({
        ...structuredClone(fact),
        position: this.#position,
      });
    }
  }

  compact(bound: CompactionBound): Promise<CompactionStep> {
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
    const window = Math.min(
      floor,
      this.#compacted + (bound.limit ?? COMPACTION_STEP)
    );
    const young = this.#changes.find(
      (change) =>
        change.position > this.#compacted &&
        change.position <= window &&
        change.recordedAt >= bound.before
    );
    const through = young === undefined ? window : young.position - 1;
    if (through <= this.#compacted) {
      return Promise.resolve({ done: true, removed: 0 });
    }
    const first = this.#changes.findIndex(
      (change) => change.position > through
    );
    const removed = first === -1 ? this.#changes.length : first;
    this.#changes.splice(0, removed);
    this.#compacted = through;
    return Promise.resolve({
      done: through < window || window === floor,
      removed,
    });
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

function missedBy(move: ObserverMove, compacted: number): MissedRange | null {
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

function byKey(left: ObserverKey, right: ObserverKey): number {
  return (
    left.source.localeCompare(right.source) ||
    left.name.localeCompare(right.name)
  );
}
