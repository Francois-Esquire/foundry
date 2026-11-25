import type { JsonValue } from "@foundry/lib/json";
import { RecordsGate } from "~/lib/events/records";
import { storableJson } from "~/lib/state/json";
import type {
  ExecutionObservation,
  RetentionGap,
  StoredAnnex,
} from "./execution-record";

export interface ExecutionStore {
  close(): Promise<void>;
  gaps(): Promise<readonly RetentionGap[]>;
  get(id: string): Promise<StoredAnnex | undefined>;
  list(): Promise<readonly StoredAnnex[]>;
  observe(
    id: string,
    observation: ExecutionObservation,
    updatedAt: string
  ): Promise<void>;
  progress(id: string, progress: JsonValue, updatedAt: string): Promise<void>;
  remove(
    ids: readonly string[],
    removals: readonly Removal[],
    updatedAt: string
  ): Promise<readonly RetentionGap[]>;
}

export interface Removal {
  readonly scope: string;
  readonly through: string;
}

export function withRemovals(
  gaps: ReadonlyMap<string, RetentionGap>,
  removals: readonly Removal[],
  updatedAt: string
): Map<string, RetentionGap> {
  const next = new Map(gaps);
  for (const { scope, through } of removals) {
    const gap = next.get(scope);
    next.set(scope, {
      removed: (gap?.removed ?? 0) + 1,
      scope,
      through: gap && gap.through > through ? gap.through : through,
      updatedAt,
    });
  }
  return next;
}

export function storedObservation(
  runId: string,
  observation: ExecutionObservation
): ExecutionObservation {
  return storableJson(
    `execution run ${JSON.stringify(runId)} observation ${JSON.stringify(observation.id)}`,
    observation
  ) as unknown as ExecutionObservation;
}

export function storedProgress(runId: string, progress: JsonValue): JsonValue {
  return storableJson(
    `execution run ${JSON.stringify(runId)} progress`,
    progress
  );
}

export function storedRetentionGap(gap: RetentionGap): RetentionGap {
  return storableJson(
    `retention gap ${JSON.stringify(gap.scope)}`,
    gap
  ) as unknown as RetentionGap;
}

interface Kept {
  readonly observations: Map<string, ExecutionObservation>;
  progress?: JsonValue;
  revision: number;
  updatedAt?: string;
}

export class MemoryExecutionStore implements ExecutionStore {
  readonly #gate = new RecordsGate("the execution store is closed");
  readonly #annexes = new Map<string, Kept>();
  readonly #gaps = new Map<string, RetentionGap>();

  close(): Promise<void> {
    return this.#gate.close();
  }

  gaps(): Promise<readonly RetentionGap[]> {
    return this.#gate.run(() =>
      Promise.resolve(structuredClone([...this.#gaps.values()]))
    );
  }

  get(id: string): Promise<StoredAnnex | undefined> {
    return this.#gate.run(() => {
      const kept = this.#annexes.get(id);
      return Promise.resolve(kept && storedOf(id, kept));
    });
  }

  list(): Promise<readonly StoredAnnex[]> {
    return this.#gate.run(() =>
      Promise.resolve(
        [...this.#annexes].map(([id, kept]) => storedOf(id, kept))
      )
    );
  }

  observe(
    id: string,
    observation: ExecutionObservation,
    updatedAt: string
  ): Promise<void> {
    return this.#gate.run(async () => {
      const stored = storedObservation(id, observation);
      const kept = this.#kept(id);
      kept.observations.delete(stored.id);
      kept.observations.set(stored.id, stored);
      kept.revision += 1;
      kept.updatedAt = updatedAt;
    });
  }

  progress(id: string, progress: JsonValue, updatedAt: string): Promise<void> {
    return this.#gate.run(async () => {
      const stored = storedProgress(id, progress);
      const kept = this.#kept(id);
      kept.progress = stored;
      kept.revision += 1;
      kept.updatedAt = updatedAt;
    });
  }

  remove(
    ids: readonly string[],
    removals: readonly Removal[],
    updatedAt: string
  ): Promise<readonly RetentionGap[]> {
    return this.#gate.run(async () => {
      const gaps = withRemovals(this.#gaps, removals, updatedAt);
      const stored = [...gaps.values()].map(storedRetentionGap);
      for (const id of ids) {
        this.#annexes.delete(id);
      }
      for (const gap of stored) {
        this.#gaps.set(gap.scope, gap);
      }
      return structuredClone(stored);
    });
  }

  #kept(id: string): Kept {
    let kept = this.#annexes.get(id);
    if (kept === undefined) {
      kept = { observations: new Map(), revision: 0 };
      this.#annexes.set(id, kept);
    }
    return kept;
  }
}

function storedOf(id: string, kept: Kept): StoredAnnex {
  return {
    id,
    observations: structuredClone([...kept.observations.values()]),
    ...(kept.progress === undefined
      ? {}
      : { progress: structuredClone(kept.progress) }),
    revision: kept.revision,
    ...(kept.updatedAt === undefined ? {} : { updatedAt: kept.updatedAt }),
  };
}
