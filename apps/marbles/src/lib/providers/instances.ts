import type { ProviderInstance } from "~/lib/providers/plugins";

/**
 * Instances one write built before it was written, keyed like
 * {@link ProviderInstances}. The write owns them until a load takes one
 * out; whatever is left when the write settles, it discards.
 */
export type Drafts = Map<string, ProviderInstance>;

/**
 * The instances a configuration built, keyed by the entry, scope, and
 * environment that built them. Each is owned here until the manager takes
 * it, and the manager disposes it from then on; one owned here that is
 * replaced or left out is disposed here, once.
 */
export class ProviderInstances {
  #current = new Map<string, ProviderInstance>();
  readonly #given = new WeakSet<ProviderInstance>();

  /** The instance the last load kept for `key`. */
  get(key: string): ProviderInstance | undefined {
    return this.#current.get(key);
  }

  /**
   * Make `next` current once the manager took `serving`. One the manager
   * let go of is dropped, so it is built afresh when needed; one owned here
   * and left out is disposed.
   */
  adopt(
    next: ReadonlyMap<string, ProviderInstance>,
    serving: readonly ProviderInstance[]
  ): void {
    const taken = new Set(serving);
    for (const instance of taken) {
      this.#given.add(instance);
    }
    const previous = this.#current;
    this.#current = new Map(
      [...next].filter(
        ([, instance]) => taken.has(instance) || !this.#given.has(instance)
      )
    );
    this.discard(previous.values());
  }

  /** Dispose, in the background, each of `instances` owned here and not current. */
  discard(instances: Iterable<ProviderInstance>): void {
    const current = new Set(this.#current.values());
    for (const instance of new Set(instances)) {
      if (!(this.#given.has(instance) || current.has(instance))) {
        disposeOf(instance).catch(() => undefined);
      }
    }
  }

  /** Dispose every current instance the manager never took. */
  async dispose(): Promise<void> {
    const owned = [...this.#current.values()].filter(
      (instance) => !this.#given.has(instance)
    );
    this.#current.clear();
    const failed = (await Promise.allSettled(owned.map(disposeOf))).flatMap(
      (result) => (result.status === "rejected" ? [result.reason] : [])
    );
    if (failed.length > 0) {
      throw new AggregateError(failed, "Failed to dispose provider instances");
    }
  }
}

async function disposeOf(instance: ProviderInstance): Promise<void> {
  await instance.provider.dispose?.();
}
