import { Registry } from "~/lib/registry";

/**
 * What a `marbles.config.ts` declared, collected as it is imported. The
 * authoring words write here and nothing in the lib reads it: the CLI copies
 * it into the engine it builds. It also keeps what only a config has, the
 * declared workspace paths and the ids of nameless resources.
 */
export class Catalog extends Registry {
  /** Paths of declared workspaces, as written; sandboxes may mount them. */
  readonly workspaces = new Set<string>();
  readonly #counters = new Map<string, number>();

  /** Registration-order ids for nameless resources, e.g. `agent#2`. */
  claimId(kind: string): string {
    const next = (this.#counters.get(kind) ?? 0) + 1;
    this.#counters.set(kind, next);
    return `${kind}#${next}`;
  }

  /** Tests and a failed config load: forget everything declared so far. */
  reset(): void {
    this.definitions.clear();
    this.schedules.clear();
    this.monitors.clear();
    this.workspaces.clear();
    this.#counters.clear();
  }
}

export const catalog = new Catalog();
