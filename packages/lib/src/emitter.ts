// biome-ignore lint/suspicious/noExplicitAny: Preserve EventEmitter compatibility for untyped default event maps and custom listener signatures.
export type DefaultEventMap = Record<string, any[]>;

// biome-ignore lint/suspicious/noExplicitAny: Preserve EventEmitter compatibility for custom listener signatures.
type AnyListener = (this: unknown, ...args: any[]) => void;

interface Registration {
  fired: boolean;
  readonly listener: AnyListener;
  readonly once: boolean;
}

export class TypedEmitter<
  Events extends { [K in keyof Events]: unknown[] } = DefaultEventMap,
> {
  readonly #events = new Map<string, Registration[]>();

  on<K extends keyof Events & string>(
    event: K,
    listener: (...args: Events[K]) => void
  ): this {
    return this.#register(event, {
      fired: false,
      listener: listener as AnyListener,
      once: false,
    });
  }

  addListener<K extends keyof Events & string>(
    event: K,
    listener: (...args: Events[K]) => void
  ): this {
    return this.on(event, listener);
  }

  once<K extends keyof Events & string>(
    event: K,
    listener: (...args: Events[K]) => void
  ): this {
    return this.#register(event, {
      fired: false,
      listener: listener as AnyListener,
      once: true,
    });
  }

  off<K extends keyof Events & string>(
    event: K,
    listener: (...args: Events[K]) => void
  ): this {
    const entries = this.#events.get(event);
    if (!entries) {
      return this;
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
    return this;
  }

  removeListener<K extends keyof Events & string>(
    event: K,
    listener: (...args: Events[K]) => void
  ): this {
    return this.off(event, listener);
  }

  removeAllListeners<K extends keyof Events & string>(event?: K): this {
    if (event === undefined) {
      this.#events.clear();
    } else {
      this.#events.delete(event);
    }
    return this;
  }

  listenerCount<K extends keyof Events & string>(event: K): number {
    return this.#events.get(event)?.length ?? 0;
  }

  emit<K extends keyof Events & string>(event: K, ...args: Events[K]): boolean {
    const entries = this.#events.get(event);
    if (!entries || entries.length === 0) {
      if (event === "error") {
        const [err] = args;
        throw err instanceof Error
          ? err
          : new Error(args.length > 0 ? String(err) : "Unhandled error.");
      }
      return false;
    }
    for (const entry of [...entries]) {
      if (entry.once) {
        if (entry.fired) {
          continue;
        }
        entry.fired = true;
        this.#removeEntry(event, entry);
      }
      entry.listener.apply(this, args);
    }
    return true;
  }

  #register(event: string, entry: Registration): this {
    let entries = this.#events.get(event);
    if (!entries) {
      entries = [];
      this.#events.set(event, entries);
    }
    entries.push(entry);
    return this;
  }

  #removeEntry(event: string, entry: Registration): void {
    const current = this.#events.get(event);
    if (!current) {
      return;
    }
    const idx = current.indexOf(entry);
    if (idx !== -1) {
      current.splice(idx, 1);
    }
    if (current.length === 0) {
      this.#events.delete(event);
    }
  }
}
