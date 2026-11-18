import type { ProviderInstance } from "~/lib/providers/plugins";

export type Drafts = Map<string, ProviderInstance>;

export class ProviderInstances {
  #current = new Map<string, ProviderInstance>();
  readonly #given = new WeakSet<ProviderInstance>();

  get(key: string): ProviderInstance | undefined {
    return this.#current.get(key);
  }

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

  discard(instances: Iterable<ProviderInstance>): void {
    const current = new Set(this.#current.values());
    for (const instance of new Set(instances)) {
      if (!(this.#given.has(instance) || current.has(instance))) {
        disposeOf(instance).catch(() => undefined);
      }
    }
  }

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
