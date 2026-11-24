import {
  type ProcessIdentity,
  sameProcess,
} from "@foundry/lib/process-identity";
import type { Fiber } from "effect";
import type {
  ConcurrencyPool,
  PoolName,
  PoolStats,
  Run,
  RunId,
} from "./domain";

interface Slot {
  readonly fiber: Fiber.RuntimeFiber<void>;
  readonly pool: PoolName;
}

interface Admission {
  paused: boolean;
  retiring: boolean;
}

export class Capacity {
  readonly admission: Admission = { paused: false, retiring: false };
  readonly pools = new Map<PoolName, ConcurrencyPool>();
  readonly slots = new Map<RunId, Slot>();
  readonly waiting = new Map<PoolName, number>();
  readonly #defaultLimit: number;
  readonly #self: ProcessIdentity;

  constructor(defaultLimit: number, self: ProcessIdentity) {
    this.#defaultLimit = defaultLimit;
    this.#self = self;
  }

  poolOf(name: PoolName): ConcurrencyPool {
    return (
      this.pools.get(name) ?? {
        limit: this.#defaultLimit,
        name,
        state: "active",
      }
    );
  }

  activeIn(name: PoolName): number {
    return [...this.slots.values()].filter((slot) => slot.pool === name).length;
  }

  hasRoom(name: PoolName): boolean {
    const pool = this.poolOf(name);
    return (
      !this.admission.paused &&
      pool.state === "active" &&
      this.activeIn(pool.name) < pool.limit
    );
  }

  owns(run: Run): boolean {
    return (
      run.state.kind === "queued" &&
      (run.state.owner === undefined ||
        sameProcess(run.state.owner, this.#self))
    );
  }

  stats(): readonly PoolStats[] {
    return [
      ...new Set([
        ...this.pools.keys(),
        ...this.waiting.keys(),
        ...[...this.slots.values()].map((slot) => slot.pool),
      ]),
    ].map((name) => ({
      ...this.poolOf(name),
      active: this.activeIn(name),
      waiting: this.waiting.get(name) ?? 0,
    }));
  }
}
