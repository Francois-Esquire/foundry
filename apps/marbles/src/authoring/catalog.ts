import type { AnyDefinition } from "~/lib/definition";
import { quoteOrigin } from "~/lib/definition";
import { Registry } from "~/lib/registry";

/**
 * What authoring modules declared, collected as they are imported. The
 * authoring words write here and nothing in the lib reads it: the CLI copies
 * it into the engine it builds. It also keeps what only authoring has, the
 * declared workspace paths and the ids of nameless resources.
 */
export class Catalog extends Registry {
  /** Paths of declared workspaces, as written; sandboxes may mount them. */
  readonly workspaces = new Set<string>();
  readonly #counters = new Map<string, number>();
  /** Names that came from a `const`; a collision on one says how to fix it. */
  readonly #inferred = new Set<string>();
  /** Each agent id claimed so far: a digest of what the agent is, and where. */
  readonly #agents = new Map<
    string,
    { readonly digest: string; readonly origin: string | undefined }
  >();

  /**
   * The registry's check, with authoring's advice when a name was inferred:
   * two `const`s with one name in different files collide, and the fix is
   * in the source.
   */
  override define(definition: AnyDefinition, inferred = false): void {
    const { name } = definition;
    const taken = name === undefined ? undefined : this.definitions.get(name);
    if (taken && (inferred || this.#inferred.has(taken.name))) {
      throw new Error(
        `"${taken.name}" already registered${quoteOrigin(taken.origin)}; the name comes from a const${quoteOrigin(definition.origin)}; rename one or name it explicitly`
      );
    }
    super.define(definition);
    if (name !== undefined && inferred) {
      this.#inferred.add(name);
    }
  }

  /**
   * An agent id is what approvals and agent-made triggers are kept under,
   * so one id is one agent: two different agents under one name (two
   * `const`s in different files, or a name given twice) would share them.
   * The same agent declared again (a prebuilt reused, a module re-imported)
   * is the same subject.
   */
  claimAgent(id: string, digest: string, origin: string | undefined): void {
    const claimed = this.#agents.get(id);
    if (claimed && claimed.digest !== digest) {
      throw new Error(
        `agent "${id}" already declared${quoteOrigin(claimed.origin)} with a different prompt or route${quoteOrigin(origin)}; rename one or name it explicitly`
      );
    }
    this.#agents.set(id, claimed ?? { digest, origin });
  }

  /** Registration-order ids for nameless resources, e.g. `sandbox#2`; nothing durable is keyed by them. */
  claimId(kind: string): string {
    const next = (this.#counters.get(kind) ?? 0) + 1;
    this.#counters.set(kind, next);
    return `${kind}#${next}`;
  }

  /** Tests and a failed source load: forget everything declared so far. */
  reset(): void {
    this.definitions.clear();
    this.schedules.clear();
    this.monitors.clear();
    this.detectors.clear();
    this.workspaces.clear();
    this.#counters.clear();
    this.#inferred.clear();
    this.#agents.clear();
  }
}

export const catalog = new Catalog();
