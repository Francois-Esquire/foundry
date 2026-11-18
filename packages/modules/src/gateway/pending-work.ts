export class PendingGatewayWork {
  readonly #pending = new Map<Promise<void>, string>();

  track(id: string, work: Promise<unknown>): void {
    const observed = work.then(
      () => undefined,
      () => undefined
    );
    this.#pending.set(observed, id);
    observed.then(() => this.#pending.delete(observed));
  }

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
