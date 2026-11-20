import type { Output } from "ai";
import type { AnyDefinition, NamedDefinition } from "~/lib/definition";
import { isNamed, quoteOrigin } from "~/lib/definition";
import type { Handler, Source } from "~/lib/events/source";
import { sourceKey } from "~/lib/events/source";
import type { MonitorRecord } from "~/lib/registry";
import type { Schedule } from "~/lib/triggers";
import type { AgentLike } from "~/lib/types";

export interface DeclaredObserver {
  readonly handler: Handler<unknown>;
  readonly name: string;
  readonly source: Source;
  readonly timeout?: number;
  readonly types?: readonly string[];
}

export class Catalog {
  readonly agents = new Map<string, AgentLike<Output.Output>>();
  readonly definitions = new Map<string, NamedDefinition>();
  readonly monitors = new Map<string, MonitorRecord>();
  readonly observers: DeclaredObserver[] = [];
  readonly schedules = new Map<string, Schedule>();
  readonly workspaces = new Set<string>();
  readonly #counters = new Map<string, number>();
  readonly #inferred = new Set<string>();
  readonly #agents = new Map<
    string,
    {
      readonly define?: object;
      readonly digest: string;
      readonly origin: string | undefined;
    }
  >();

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

  observe(observer: DeclaredObserver): void {
    if (
      this.observers.some(
        (other) =>
          other.source === observer.source && other.name === observer.name
      )
    ) {
      throw new Error(
        `observe: an observer of ${String(sourceKey(observer.source))} named "${observer.name}" is already declared; give each its own name`
      );
    }
    this.observers.push(observer);
  }

  #keyTaken(key: string): boolean {
    return this.schedules.has(key) || this.monitors.has(key);
  }

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

  claimId(kind: string): string {
    const next = (this.#counters.get(kind) ?? 0) + 1;
    this.#counters.set(kind, next);
    return `${kind}#${next}`;
  }

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
