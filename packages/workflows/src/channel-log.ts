/**
 * Every message a run has published, in order, fanned out to any number of
 * subscribers. A subscriber first receives the history, then live messages,
 * with no gap: copying the history and registering happen in one tick, and
 * publishing is synchronous.
 *
 * The history lives as long as the run's Channels, so a subscriber that
 * attaches after the run settled still sees the whole run and then EOF.
 */
export class MessageLog<M> {
  readonly #history: M[] = [];
  readonly #subscribers = new Set<ReadableStreamDefaultController<M>>();
  // Widened: the checker would otherwise read the initializer as the only value.
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
        // The reader cancelled between its last read and this publish.
        this.#subscribers.delete(controller);
      }
    }
  }

  /** No more messages: every open subscription reaches EOF. */
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

  /** A fresh stream: the history so far, then live messages until close. */
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
