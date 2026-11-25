import { realpathSync } from "node:fs";
import { DEFAULT_POOL } from "@foundry/queue";
import type { Output } from "ai";
import type { AnyDefinition, NamedDefinition } from "~/lib/definition";
import { isNamed, quoteOrigin } from "~/lib/definition";
import type { Handler, Source } from "~/lib/events/source";
import { sourceKey } from "~/lib/events/source";
import { DEFAULT_PROVIDERS } from "~/lib/providers/defaults";
import type { ProviderPlugin } from "~/lib/providers/plugins";
import type { MonitorRecord } from "~/lib/registry";
import type { Schedule } from "~/lib/triggers";
import type { AgentLike } from "~/lib/types";
import type { PoolConfig } from "./config";
import { configOf } from "./config";

const ORIGIN_LINE = /:\d+$/;

function normalized(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}

export interface DeclaredObserver {
  readonly handler: Handler<unknown>;
  readonly name: string;
  readonly source: Source;
  readonly timeout?: number;
  readonly types?: readonly string[];
}

export class Catalog {
  readonly pools = new Map<
    string,
    {
      readonly config: PoolConfig;
      readonly file: string;
      readonly source: object;
    }
  >();
  readonly filePools = new Map<string, string>();

  configure(file: string, value: unknown): void {
    const config = configOf(file, value);
    if (config === undefined) {
      return;
    }
    const source = value as object;
    for (const [name, pool] of Object.entries(config.pools ?? {})) {
      const previous = this.pools.get(name);
      if (
        previous !== undefined &&
        previous.source !== source &&
        normalized(previous.file) !== normalized(file)
      ) {
        throw new Error(
          `pool "${name}" declared in both ${previous.file} and ${file}`
        );
      }
      this.pools.set(name, { config: pool, file, source });
    }
    if (config.pool !== undefined) {
      this.filePools.set(normalized(file), config.pool);
    }
  }

  validateConfig(): void {
    for (const [file, pool] of this.filePools) {
      if (pool !== DEFAULT_POOL && !this.pools.has(pool)) {
        throw new Error(`${file}: unknown pool "${pool}"`);
      }
    }
  }

  poolRecords(): Readonly<Record<string, PoolConfig>> {
    return Object.fromEntries(
      [...this.pools].map(([name, entry]) => [name, entry.config])
    );
  }

  poolFor(origin: string | undefined): string | undefined {
    return origin === undefined
      ? undefined
      : this.filePools.get(normalized(origin.replace(ORIGIN_LINE, "")));
  }

  readonly agents = new Map<string, AgentLike<Output.Output>>();
  readonly definitions = new Map<string, NamedDefinition>();
  readonly monitors = new Map<string, MonitorRecord>();
  readonly observers: DeclaredObserver[] = [];
  readonly providers = new Map<string, ProviderPlugin>();
  readonly schedules = new Map<string, Schedule>();
  readonly workspaces = new Set<string>();
  readonly #counters = new Map<string, number>();
  readonly #inferred = new Set<string>();
  readonly #providerOrigins = new Map<string, string | undefined>();
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

  provide(provider: ProviderPlugin, origin: string | undefined): void {
    const { id } = provider;
    const standing = DEFAULT_PROVIDERS.find((each) => each.id === id);
    if (standing === provider) {
      return;
    }
    if (standing !== undefined) {
      throw new Error(
        `provider "${id}" is one Marbles provides by default; define your own under another id${quoteOrigin(origin)}`
      );
    }
    if (this.providers.has(id)) {
      throw new Error(
        `provider "${id}" already defined${quoteOrigin(this.#providerOrigins.get(id))}; second definition${quoteOrigin(origin)}`
      );
    }
    this.providers.set(id, provider);
    this.#providerOrigins.set(id, origin);
  }

  schedule(record: Schedule): void {
    if (this.#keyTaken(record.key)) {
      throw new Error(`schedule "${record.key}" already registered`);
    }
    this.schedules.set(record.key, record);
  }

  monitor(record: MonitorRecord): void {
    if (this.#keyTaken(record.key)) {
      throw new Error(
        `monitor "${record.key}": a schedule or monitor of that name is already registered; give each its own name`
      );
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

  observerEntries(): readonly {
    readonly name: string;
    readonly source: string;
    readonly types?: readonly string[];
  }[] {
    return this.observers.map(({ name, source, types }) => ({
      name,
      source: sourceKey(source) ?? String(source.description),
      ...(types === undefined ? {} : { types: [...types] }),
    }));
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
    this.pools.clear();
    this.filePools.clear();
    this.agents.clear();
    this.definitions.clear();
    this.schedules.clear();
    this.monitors.clear();
    this.observers.length = 0;
    this.providers.clear();
    this.#providerOrigins.clear();
    this.workspaces.clear();
    this.#counters.clear();
    this.#inferred.clear();
    this.#agents.clear();
  }
}

export const catalog = new Catalog();
