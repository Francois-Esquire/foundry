const GIB = 1024 * 1024 * 1024;

/**
 * Machine-wide sandbox ceilings: fixed code defaults in phase one, counting
 * authoring/build and released app sandboxes together. Recommended starting
 * values from the spec, to be tuned by measurement.
 */
const SANDBOX_CEILINGS = {
  /** Reserved guest memory across every live sandbox. */
  memoryBytes: 8 * GIB,
  /** Live sandboxes at once. */
  sandboxes: 4,
} as const;

/** One live sandbox's share of the ceilings, held until it is released. */
export interface SandboxReservation {
  readonly memoryBytes: number;
  /** Give the share back. Idempotent. */
  release(): void;
}

interface Waiter {
  readonly memoryBytes: number;
  readonly resolve: (reservation: SandboxReservation) => void;
}

/**
 * Admission to the machine ceilings. A request that does not fit waits its
 * turn, first come first served, and is never refused for capacity; only
 * one that could never fit, even on an idle machine, is an error.
 */
export class SandboxCapacity {
  readonly #limits: {
    readonly memoryBytes: number;
    readonly sandboxes: number;
  };
  readonly #waiting: Waiter[] = [];
  #memoryBytes = 0;
  #sandboxes = 0;

  constructor(
    limits: {
      readonly memoryBytes: number;
      readonly sandboxes: number;
    } = SANDBOX_CEILINGS
  ) {
    this.#limits = limits;
  }

  /** Reserve one sandbox and its memory, waiting while the machine is full. */
  acquire(
    memoryBytes: number,
    options: {
      readonly signal?: AbortSignal;
      /** Told once if the request cannot be admitted at once. */
      readonly waiting?: () => void;
    } = {}
  ): Promise<SandboxReservation> {
    const { signal } = options;
    if (memoryBytes > this.#limits.memoryBytes) {
      return Promise.reject(
        new Error(
          `A sandbox needs ${memoryBytes} bytes of memory, more than the ${this.#limits.memoryBytes} bytes all sandboxes may reserve`
        )
      );
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason);
    }
    const { promise, resolve, reject } =
      Promise.withResolvers<SandboxReservation>();
    const abort = () => {
      const index = this.#waiting.indexOf(waiter);
      if (index !== -1) {
        this.#waiting.splice(index, 1);
        reject(signal?.reason);
        // The head may have been what held later requests back.
        this.#pump();
      }
    };
    const waiter: Waiter = {
      memoryBytes,
      resolve: (reservation) => {
        signal?.removeEventListener("abort", abort);
        resolve(reservation);
      },
    };
    signal?.addEventListener("abort", abort, { once: true });
    this.#waiting.push(waiter);
    this.#pump();
    if (this.#waiting.includes(waiter)) {
      options.waiting?.();
    }
    return promise;
  }

  /** What is reserved now and how many requests wait. */
  usage(): { memoryBytes: number; sandboxes: number; waiting: number } {
    return {
      memoryBytes: this.#memoryBytes,
      sandboxes: this.#sandboxes,
      waiting: this.#waiting.length,
    };
  }

  #pump() {
    for (;;) {
      const [next] = this.#waiting;
      if (
        !next ||
        this.#sandboxes >= this.#limits.sandboxes ||
        this.#memoryBytes + next.memoryBytes > this.#limits.memoryBytes
      ) {
        return;
      }
      this.#waiting.shift();
      this.#sandboxes += 1;
      this.#memoryBytes += next.memoryBytes;
      let held = true;
      next.resolve({
        memoryBytes: next.memoryBytes,
        release: () => {
          if (!held) {
            return;
          }
          held = false;
          this.#sandboxes -= 1;
          this.#memoryBytes -= next.memoryBytes;
          this.#pump();
        },
      });
    }
  }
}
