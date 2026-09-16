export type McpListener<T> = (payload: T) => void;

/**
 * The smallest typed emitter the MCP classes need. Listeners are called
 * synchronously and never awaited; a listener that throws does not stop the
 * others.
 */
export class McpEmitter<Events> {
  readonly #listeners = new Map<keyof Events, Set<McpListener<never>>>();

  /** Subscribe; returns the unsubscribe. */
  on<K extends keyof Events>(
    event: K,
    listener: McpListener<Events[K]>
  ): () => void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  protected emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.#listeners.get(event);
    if (!set) {
      return;
    }
    for (const listener of [...set]) {
      try {
        (listener as McpListener<Events[K]>)(payload);
      } catch {
        // A listener's failure is its own; the emitter keeps delivering.
      }
    }
  }
}
