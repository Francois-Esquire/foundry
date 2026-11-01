import type { Output } from "ai";
import type { AnyDefinition, NamedDefinition } from "~/lib/definition";
import { isNamed, quoteOrigin } from "~/lib/definition";
import type { Handler } from "~/lib/events/source";
import type { MonitorRecord } from "~/lib/registry";
import type { Schedule } from "~/lib/triggers";
import type { AgentLike } from "~/lib/types";

/**
 * What authoring modules declared, collected as they are imported. The
 * authoring words write here and nothing in the lib reads it: the CLI copies
 * it into the engine it builds, which turns each monitor into its step and
 * schedule. It also keeps what only authoring has, the declared workspace
 * paths and the ids of nameless resources.
 */
export class Catalog {
  /** Declared agents by id; one declared with a function is built when a session opens. */
  readonly agents = new Map<string, AgentLike<Output.Output>>();
  /** Named definitions, by name; a nameless one is internal and not kept. */
  readonly definitions = new Map<string, NamedDefinition>();
  /** Declared monitors, by key. */
  readonly monitors = new Map<string, MonitorRecord>();
  /** Declared observers, in the order `observe` was called. */
  readonly observers: {
    readonly handler: Handler<unknown>;
    readonly source: symbol;
  }[] = [];
  /** Declared schedules, by key. */
  readonly schedules = new Map<string, Schedule>();
  /** Paths of declared workspaces, as written; sandboxes may mount them. */
  readonly workspaces = new Set<string>();
  readonly #counters = new Map<string, number>();
  /** Names that came from a `const`; a collision on one says how to fix it. */
  readonly #inferred = new Set<string>();
  /**
   * Each agent id claimed so far: a digest of what the agent is, where, and
   * for an agent declared with a function, that function.
   */
  readonly #agents = new Map<
    string,
    {
      readonly define?: object;
      readonly digest: string;
      readonly origin: string | undefined;
    }
  >();

  /**
   * A name is taken once, checked as the module is imported so the error
   * names both places. When a name was inferred, the advice is authoring's:
   * two `const`s with one name in different files collide, and the fix is
   * in the source.
   */
  define(definition: AnyDefinition, inferred = false): void {
    if (!isNamed(definition)) {
      return;
    }
    const { name } = definition;
    const taken = this.definitions.get(name);
    if (taken && (inferred || this.#inferred.has(name))) {
      throw new Error(
        `"${name}" already registered${quoteOrigin(taken.origin)}; the name comes from a const${quoteOrigin(definition.origin)}; rename one or name it explicitly`
      );
    }
    if (taken) {
      throw new Error(
        `"${name}" already registered${quoteOrigin(taken.origin)}; second registration${quoteOrigin(definition.origin)}`
      );
    }
    this.definitions.set(name, definition);
    if (inferred) {
      this.#inferred.add(name);
    }
  }

  schedule(record: Schedule): void {
    if (this.#keyTaken(record.key)) {
      throw new Error(`schedule "${record.key}" already registered`);
    }
    this.schedules.set(record.key, record);
  }

  monitor(record: MonitorRecord): void {
    if (this.#keyTaken(record.key)) {
      throw new Error(`schedule "${record.key}" already registered`);
    }
    this.monitors.set(record.key, record);
  }

  observe(source: symbol, handler: Handler<unknown>): void {
    this.observers.push({ handler, source });
  }

  /** Schedules and monitors share one key space: each names a trigger. */
  #keyTaken(key: string): boolean {
    return this.schedules.has(key) || this.monitors.has(key);
  }

  /** A trigger key not yet taken: `base`, else `base-2`, `base-3`, … in registration order. */
  uniqueKey(base: string): string {
    if (!this.#keyTaken(base)) {
      return base;
    }
    for (let n = 2; ; n += 1) {
      const candidate = `${base}-${String(n)}`;
      if (!this.#keyTaken(candidate)) {
        return candidate;
      }
    }
  }

  /**
   * An agent id is what approvals and agent-made triggers are kept under,
   * so one id is one agent: two different agents under one name (two
   * `const`s in different files, or a name given twice) would share them.
   * The same agent declared again (a prebuilt reused, a module re-imported)
   * is the same subject, on whatever route; an extension copies the id and
   * claims nothing.
   *
   * An agent declared with a function is the same subject only as that
   * same function. Its digest is the function's source, which leaves out
   * the values it closes over: one helper making an agent per team writes
   * the same source each time, and those agents must not share approvals.
   */
  claimAgent(
    id: string,
    digest: string,
    origin: string | undefined,
    define?: object
  ): void {
    const claimed = this.#agents.get(id);
    if (claimed && claimed.digest !== digest) {
      throw new Error(
        `agent "${id}" already declared${quoteOrigin(claimed.origin)} with a different prompt or definition function${quoteOrigin(origin)}; rename one or name it explicitly`
      );
    }
    if (claimed?.define && claimed.define !== define) {
      throw new Error(
        `agent "${id}" already declared by another function${quoteOrigin(claimed.origin)}${quoteOrigin(origin)}; an agent declared with a function is identified by its const or its source, not by the values it closes over, so these two would share approvals and triggers. Declare each with its own top-level const`
      );
    }
    this.#agents.set(id, claimed ?? { define, digest, origin });
  }

  /** Registration-order ids for nameless resources, e.g. `sandbox#2`; nothing durable is keyed by them. */
  claimId(kind: string): string {
    const next = (this.#counters.get(kind) ?? 0) + 1;
    this.#counters.set(kind, next);
    return `${kind}#${next}`;
  }

  /** Tests and a failed source load: forget everything declared so far. */
  reset(): void {
    this.agents.clear();
    this.definitions.clear();
    this.schedules.clear();
    this.monitors.clear();
    this.observers.length = 0;
    this.workspaces.clear();
    this.#counters.clear();
    this.#inferred.clear();
    this.#agents.clear();
  }
}

export const catalog = new Catalog();
