// biome-ignore lint/suspicious/noExplicitAny: Preserve EventEmitter compatibility for custom listener signatures.
export type EventListener<Args extends any[] = any[]> = (
  this: unknown,
  ...args: Args
) => void;

interface Registration {
  fired: boolean;
  readonly listener: EventListener;
  readonly once: boolean;
}

export class ListenerMap {
  readonly #events = new Map<string, Registration[]>();

  on(event: string, listener: EventListener, once = false): void {
    let entries = this.#events.get(event);
    if (!entries) {
      entries = [];
      this.#events.set(event, entries);
    }
    entries.push({ fired: false, listener, once });
  }

  off(event: string, listener: EventListener): void {
    const entries = this.#events.get(event);
    if (!entries) {
      return;
    }
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (entries[i]?.listener === listener) {
        entries.splice(i, 1);
        break;
      }
    }
    if (entries.length === 0) {
      this.#events.delete(event);
    }
  }

  removeAll(event?: string): void {
    if (event === undefined) {
      this.#events.clear();
    } else {
      this.#events.delete(event);
    }
  }

  count(event: string): number {
    return this.#events.get(event)?.length ?? 0;
  }

  emit(event: string, receiver: unknown, args: readonly unknown[]): boolean {
    const entries = this.#events.get(event);
    if (!entries || entries.length === 0) {
      return false;
    }
    for (const entry of [...entries]) {
      if (entry.once) {
        if (entry.fired) {
          continue;
        }
        entry.fired = true;
        const current = this.#events.get(event);
        if (current) {
          const idx = current.indexOf(entry);
          if (idx !== -1) {
            current.splice(idx, 1);
          }
          if (current.length === 0) {
            this.#events.delete(event);
          }
        }
      }
      entry.listener.apply(receiver, args as unknown[]);
    }
    return true;
  }
}
