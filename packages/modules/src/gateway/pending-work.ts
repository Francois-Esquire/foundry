/** Tracks provider work independently of a request's cancellation response. */
export class PendingGatewayWork {
  readonly #pending = new Map<Promise<void>, string>();

  track(id: string, work: Promise<unknown>): void {
    // Observe late failures even after the shutdown grace has expired.
    const observed = work.then(
      () => undefined,
      () => undefined
    );
    this.#pending.set(observed, id);
    observed.then(() => this.#pending.delete(observed));
  }

  /** One grace period for all work, including work registered while draining. */
  async drain(graceMs: number): Promise<readonly string[]> {
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        expired = true;
        resolve();
      }, graceMs);
    });
    try {
      while (this.#pending.size > 0 && !expired) {
        await Promise.race([Promise.all(this.#pending.keys()), deadline]);
      }
      return Object.freeze([...new Set(this.#pending.values())]);
    } finally {
      clearTimeout(timer);
    }
  }
}
