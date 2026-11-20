const GIB = 1024 * 1024 * 1024;

const SANDBOX_CEILINGS = {
  memoryBytes: 8 * GIB,
  sandboxes: 4,
} as const;

export interface SandboxReservation {
  readonly memoryBytes: number;
  release(): void;
}

interface Waiter {
  readonly memoryBytes: number;
  readonly resolve: (reservation: SandboxReservation) => void;
}

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

  acquire(
    memoryBytes: number,
    options: {
      readonly signal?: AbortSignal;
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
