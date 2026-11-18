export class MessageLog<M> {
  readonly #history: M[] = [];
  readonly #subscribers = new Set<ReadableStreamDefaultController<M>>();
  #closed = false as boolean;

  record(message: M): void {
    if (this.#closed) {
      return;
    }
    this.#history.push(message);
    for (const controller of this.#subscribers) {
      try {
        controller.enqueue(message);
      } catch {
        this.#subscribers.delete(controller);
      }
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    for (const controller of this.#subscribers) {
      try {
        controller.close();
      } catch {
        // Already closed or cancelled.
      }
    }
    this.#subscribers.clear();
  }

  subscribe(signal?: AbortSignal): ReadableStream<M> {
    let subscribed: ReadableStreamDefaultController<M> | undefined;
    const release = () => {
      if (!subscribed) {
        return;
      }
      this.#subscribers.delete(subscribed);
      try {
        subscribed.close();
      } catch {
        // Already closed or cancelled.
      }
      subscribed = undefined;
    };
    return new ReadableStream<M>({
      cancel: () => {
        if (subscribed) {
          this.#subscribers.delete(subscribed);
          subscribed = undefined;
        }
        signal?.removeEventListener("abort", release);
      },
      start: (controller) => {
        for (const message of this.#history) {
          controller.enqueue(message);
        }
        if (this.#closed || signal?.aborted) {
          controller.close();
          return;
        }
        subscribed = controller;
        this.#subscribers.add(controller);
        signal?.addEventListener("abort", release, { once: true });
      },
    });
  }
}
