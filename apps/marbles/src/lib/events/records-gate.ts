const CLOSED = "workspace records are closed";

export class RecordsGate {
  readonly #running = new Set<Promise<unknown>>();
  readonly #refusal: string;
  #phase: "open" | "closed" = "open";

  constructor(refusal = CLOSED) {
    this.#refusal = refusal;
  }

  run<T>(call: () => Promise<T>): Promise<T> {
    if (this.#phase === "closed") {
      return Promise.reject(new Error(this.#refusal));
    }
    const running = call();
    const settled = running.then(
      () => undefined,
      () => undefined
    );
    this.#running.add(settled);
    settled.finally(() => this.#running.delete(settled));
    return running;
  }

  async close(): Promise<void> {
    this.#phase = "closed";
    await Promise.all(this.#running);
  }
}

export class EmitListeners {
  readonly #listeners = new Set<() => void>();

  add(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
