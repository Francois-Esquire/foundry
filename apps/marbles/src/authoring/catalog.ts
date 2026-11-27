import { canonicalizeJson } from "@foundry/lib/json";
import type { Output } from "ai";
import type { AnyDefinition, LockedNode } from "~/lib/definition";
import { quoteOrigin } from "~/lib/definition";
import { sourceKey } from "~/lib/events/source";
import {
  AGENT_META,
  DEFAULT_PROVIDER,
  EXPLICIT_NAME,
  MONITOR_META,
  OBSERVER_META,
  SCHEDULE_META,
  STATIC_TREE,
} from "~/lib/handles";
import { sha256HexSync } from "~/lib/hash";
import type { ProviderPlugin } from "~/lib/providers/plugins";
import type { MonitorRecord } from "~/lib/registry";
import type { Schedule } from "~/lib/triggers";
import type {
  AgentLike,
  ArtifactDefinition,
  SandboxDefinition,
} from "~/lib/types";
import type { PendingBatch } from "./collect";
import { collectBatch, normalizedPath, walkStaticTree } from "./collect";
import type { PoolConfig } from "./config";
import { configOf } from "./config";
import type { CollectInput, DeclaredObserver } from "./declarations";
import { isWorkspaceDefinition } from "./declarations";
import type { AgentMeta } from "./instances";
import type { ObserverMeta } from "./observe";
import type { MonitorMeta, ScheduleMeta } from "./triggers";
import { scheduleKeyBase } from "./triggers";

export type {
  CollectInput,
  DeclaredObserver,
  ModuleSource,
  WorkspaceDeclaration,
  WorkspaceDeclarationItem,
  WorkspaceInput,
  WorkspaceModule,
} from "./declarations";

const DEFAULT_POOL = "default";
const ORIGIN_LINE = /:\d+$/;
const DEFAULT_PROVIDER_IDS = new Set(["claude-code", "codex", "pi"]);

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
  readonly agents = new Map<string, AgentLike<Output.Output>>();
  readonly artifacts = new Map<string, ArtifactDefinition>();
  readonly definitions = new Map<string, AnyDefinition>();
  readonly monitors = new Map<string, MonitorRecord>();
  readonly observers: DeclaredObserver[] = [];
  readonly providers = new Map<string, ProviderPlugin>();
  readonly sandboxes = new Map<string, SandboxDefinition>();
  readonly schedules = new Map<string, Schedule>();
  readonly workspaces = new Set<string>();

  readonly #counters = new Map<string, number>();
  #syntheticScope = 0;
  readonly #inferred = new Set<string>();
  readonly #providerOrigins = new Map<string, string | undefined>();
  readonly #definitionNames = new Map<AnyDefinition, string>();
  readonly #definitionOrigins = new Map<string, string | undefined>();
  readonly #nestedDefinitions = new Set<AnyDefinition>();
  readonly #structuralIdentities = new Map<AnyDefinition, string>();
  readonly #agentIds = new Map<object, string>();
  readonly #seenMonitors = new Set<object>();
  readonly #seenObservers = new Set<object>();
  readonly #seenProviders = new Set<object>();
  readonly #seenSchedules = new Set<object>();
  readonly #scheduleTargets = new Set<AnyDefinition>();
  readonly #agents = new Map<
    string,
    {
      readonly define?: object;
      readonly digest: string;
      readonly origin: string | undefined;
    }
  >();

  static collect(input: CollectInput): Catalog {
    const into = new Catalog();
    into.collect(input);
    into.validate();
    return into;
  }

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
        normalizedPath(previous.file) !== normalizedPath(file)
      ) {
        throw new Error(
          `pool "${name}" declared in both ${previous.file} and ${file}`
        );
      }
      this.pools.set(name, { config: pool, file, source });
    }
    if (config.pool !== undefined) {
      this.filePools.set(normalizedPath(file), config.pool);
    }
  }

  validateConfig(): void {
    for (const [file, pool] of this.filePools) {
      if (pool !== DEFAULT_POOL && !this.pools.has(pool)) {
        throw new Error(`${file}: unknown pool "${pool}"`);
      }
    }
  }

  validateSchedules(): void {
    for (const record of this.schedules.values()) {
      if (!this.definitions.has(record.workflow)) {
        throw new Error(
          `schedule "${record.key}": target "${record.workflow}" is not registered in this workspace; export it or include it in the workspace declarations`
        );
      }
    }
  }

  validate(): void {
    this.validateConfig();
    this.validateSchedules();
  }

  poolRecords(): Readonly<Record<string, PoolConfig>> {
    return Object.fromEntries(
      [...this.pools].map(([name, entry]) => [name, entry.config])
    );
  }

  poolFor(origin: string | undefined): string | undefined {
    return origin === undefined
      ? undefined
      : this.filePools.get(normalizedPath(origin.replace(ORIGIN_LINE, "")));
  }

  definitionNameOf(definition: AnyDefinition): string | undefined {
    return this.#definitionNames.get(definition) ?? definition.name;
  }

  originOf(target: string | AnyDefinition): string | undefined {
    if (typeof target === "string") {
      return (
        this.#definitionOrigins.get(target) ??
        this.definitions.get(target)?.origin
      );
    }
    const name = this.#definitionNames.get(target);
    if (name !== undefined) {
      return this.#definitionOrigins.get(name) ?? target.origin;
    }
    return target.origin;
  }

  poolForDefinition(target: string | AnyDefinition): string | undefined {
    return this.poolFor(this.originOf(target));
  }

  structuralIdentityOf(definition: AnyDefinition): string | undefined {
    return this.#structuralIdentities.get(definition);
  }

  agentIdOf(agent: AgentLike<Output.Output>): string | undefined {
    const direct = this.#agentIds.get(agent);
    if (direct !== undefined) {
      return direct;
    }
    const meta = (agent as { [AGENT_META]?: AgentMeta })[AGENT_META];
    return meta?.root === undefined ? undefined : this.#agentIds.get(meta.root);
  }

  hasCollected(declaration: object): boolean {
    if (
      this.#definitionNames.has(declaration as AnyDefinition) ||
      this.#nestedDefinitions.has(declaration as AnyDefinition) ||
      this.#scheduleTargets.has(declaration as AnyDefinition) ||
      this.#agentIds.has(declaration) ||
      this.#seenSchedules.has(declaration) ||
      this.#seenMonitors.has(declaration) ||
      this.#seenObservers.has(declaration) ||
      this.#seenProviders.has(declaration)
    ) {
      return true;
    }
    const meta = (declaration as { [AGENT_META]?: AgentMeta })[AGENT_META];
    return meta?.root !== undefined && this.#agentIds.has(meta.root);
  }

  collect(input: CollectInput): this {
    const batch = collectBatch(input, (prefix) => {
      this.#syntheticScope += 1;
      return `\0synthetic:${prefix}#${String(this.#syntheticScope)}`;
    });

    for (const entry of batch.configs) {
      this.configure(entry.file, entry.value);
    }

    this.#registerDefinitions(batch.definitions);
    this.#registerAgents(batch.agents);
    this.#registerResources(batch);
    this.#registerObservers(batch.observers);
    this.#registerSchedules(batch.schedules);
    this.#registerMonitors(batch.monitors);

    return this;
  }

  #registerDefinitions(entries: PendingBatch["definitions"]): void {
    for (const entry of entries) {
      this.#registerDefinitionEntry(entry);
    }
  }

  #registerDefinitionEntry(entry: PendingBatch["definitions"][number]): void {
    const { exportKey, file, value } = entry;
    const explicit = EXPLICIT_NAME in value || value.name !== undefined;
    const inferredKey =
      exportKey !== undefined && exportKey !== "default"
        ? exportKey
        : undefined;
    const resolvedName = explicit ? value.name : inferredKey;
    if (resolvedName === undefined) {
      return;
    }
    const origin = value.origin ?? file;
    const priorName = this.#definitionNames.get(value);
    if (priorName !== undefined) {
      if (priorName !== resolvedName) {
        const priorOrigin = this.#definitionOrigins.get(priorName);
        throw new Error(
          `definition already registered as "${priorName}"${quoteOrigin(priorOrigin)}; cannot also register it as "${resolvedName}"${quoteOrigin(origin)}; name it explicitly or export it under one name`
        );
      }
      this.#preservePoolOrigin(resolvedName, origin);
      return;
    }
    const staticTree = (value as { [STATIC_TREE]?: LockedNode })[STATIC_TREE];
    if (value.kind === "workflow" && staticTree !== undefined) {
      walkStaticTree(
        staticTree,
        resolvedName,
        [],
        this.workspaces,
        this.#structuralIdentities,
        this.#nestedDefinitions
      );
    }
    this.define(value, !explicit, { name: resolvedName, origin });
    this.#definitionNames.set(value, resolvedName);
  }

  #preservePoolOrigin(name: string, candidateOrigin: string | undefined): void {
    if (candidateOrigin === undefined) {
      return;
    }
    const existingOrigin = this.#definitionOrigins.get(name);
    if (
      this.poolFor(existingOrigin) === undefined &&
      this.poolFor(candidateOrigin) !== undefined
    ) {
      this.#definitionOrigins.set(name, candidateOrigin);
    } else if (existingOrigin === undefined) {
      this.#definitionOrigins.set(name, candidateOrigin);
    }
  }

  #registerAgents(entries: PendingBatch["agents"]): void {
    const isExtension = (agent: AgentLike<Output.Output>): boolean => {
      const meta = (agent as { [AGENT_META]?: AgentMeta })[AGENT_META];
      return meta?.root !== undefined && meta.root !== agent;
    };
    const ordered = [
      ...entries.filter((entry) => !isExtension(entry.value)),
      ...entries.filter((entry) => isExtension(entry.value)),
    ];
    for (const entry of ordered) {
      this.#registerAgentEntry(entry);
    }
  }

  #checkExistingAgent(
    value: AgentLike<Output.Output>,
    root: object,
    id: string,
    explicit: boolean,
    file: string | undefined
  ): boolean {
    const ownPriorId = this.#agentIds.get(value);
    if (ownPriorId !== undefined) {
      if (
        ownPriorId !== id &&
        (explicit || this.agents.get(ownPriorId) === value)
      ) {
        throw new Error(
          `agent already registered as "${ownPriorId}"; cannot also register it as "${id}"${quoteOrigin(file)}; name it explicitly or export it under one name`
        );
      }
      return true;
    }
    const rootPriorId = this.#agentIds.get(root);
    if (rootPriorId === undefined) {
      return false;
    }
    if (root !== value) {
      this.#agentIds.set(value, rootPriorId);
      return true;
    }
    if (
      rootPriorId !== id &&
      (explicit || this.agents.get(rootPriorId) === value)
    ) {
      throw new Error(
        `agent already registered as "${rootPriorId}"; cannot also register it as "${id}"${quoteOrigin(file)}; name it explicitly or export it under one name`
      );
    }
    return true;
  }

  #registerAgentEntry(entry: PendingBatch["agents"][number]): void {
    const { exportKey, file, value } = entry;
    const meta = (value as { [AGENT_META]?: AgentMeta })[AGENT_META];
    const explicit = meta === undefined ? true : meta.explicit;
    const id =
      explicit || exportKey === undefined || exportKey === "default"
        ? value.id
        : exportKey;
    const root = meta?.root ?? value;
    if (this.#checkExistingAgent(value, root, id, explicit, file)) {
      return;
    }
    const digest =
      meta?.digest ??
      sha256HexSync(
        canonicalizeJson([
          "agent",
          id,
          "prompt" in value && typeof value.prompt === "string"
            ? value.prompt
            : "",
        ])
      );
    this.claimAgent(id, digest, file, meta?.define);
    if (!this.agents.has(id)) {
      this.agents.set(id, value);
    }
    this.#agentIds.set(value, id);
    this.#agentIds.set(root, id);
  }

  #registerResources(batch: PendingBatch): void {
    for (const entry of batch.workspaces) {
      this.workspaces.add(entry.value.path);
    }
    for (const entry of batch.sandboxes) {
      this.sandboxes.set(entry.value.id, entry.value);
      if ("mount" in entry.value && isWorkspaceDefinition(entry.value.mount)) {
        this.workspaces.add(entry.value.mount.path);
      }
    }
    for (const entry of batch.artifacts) {
      this.artifacts.set(entry.value.id, entry.value);
    }
    for (const entry of batch.providers) {
      if (this.#seenProviders.has(entry.value.declaration)) {
        continue;
      }
      this.#seenProviders.add(entry.value.declaration);
      this.provide(entry.value.plugin, entry.file);
    }
  }

  #registerObservers(entries: PendingBatch["observers"]): void {
    for (const entry of entries) {
      if (this.#seenObservers.has(entry.value)) {
        continue;
      }
      this.#seenObservers.add(entry.value);
      const meta = (
        entry.value as unknown as { [OBSERVER_META]: ObserverMeta }
      )[OBSERVER_META];
      const inferredKey =
        entry.exportKey !== undefined && entry.exportKey !== "default"
          ? entry.exportKey
          : undefined;
      const name = meta.explicitName
        ? entry.value.name
        : (inferredKey ?? entry.value.name);
      if (name.trim() === "") {
        throw new TypeError(
          "observe: name this observer: pass `{ name }`, export it as a named constant, or give the handler a function name"
        );
      }
      this.observe({
        handler: meta.handler,
        name: name.trim(),
        source: meta.source,
        ...(meta.timeout === undefined ? {} : { timeout: meta.timeout }),
        ...(meta.types === undefined ? {} : { types: meta.types }),
      });
    }
  }

  #registerSchedules(entries: PendingBatch["schedules"]): void {
    for (const entry of entries) {
      this.#registerScheduleEntry(entry);
    }
  }

  #registerScheduleEntry(entry: PendingBatch["schedules"][number]): void {
    if (this.#seenSchedules.has(entry.value)) {
      return;
    }
    this.#seenSchedules.add(entry.value);
    const meta = (entry.value as { [SCHEDULE_META]?: ScheduleMeta })[
      SCHEDULE_META
    ];
    const workflow = this.#resolveScheduleTarget(entry.value.workflow, meta);
    const inputData = entry.value.input;
    const key = this.uniqueKey(scheduleKeyBase(workflow, inputData));
    const label =
      inputData === null
        ? workflow
        : `${workflow} ${JSON.stringify(inputData)}`;
    this.schedule({
      input: inputData,
      key,
      kind: "schedule",
      label,
      ...(entry.value.registeredAt === undefined
        ? {}
        : { registeredAt: entry.value.registeredAt }),
      trigger: entry.value.trigger,
      workflow,
    });
  }

  #resolveScheduleTarget(
    workflow: string,
    meta: ScheduleMeta | undefined
  ): string {
    if (meta !== undefined) {
      this.#scheduleTargets.add(meta.target);
    }
    const resolved =
      workflow === "" && meta !== undefined
        ? (this.#definitionNames.get(meta.target) ?? "")
        : workflow;
    if (resolved !== "") {
      return resolved;
    }
    const kind = meta?.target.kind ?? "step";
    const hint =
      meta?.target.nameHint ??
      `give it one: ${kind}("name") or export it as a named constant`;
    throw new Error(`schedule(): this ${kind} has no name; ${hint}`);
  }

  #registerMonitors(entries: PendingBatch["monitors"]): void {
    for (const entry of entries) {
      if (this.#seenMonitors.has(entry.value)) {
        continue;
      }
      this.#seenMonitors.add(entry.value);
      const meta = (entry.value as { [MONITOR_META]?: MonitorMeta })[
        MONITOR_META
      ];
      const key =
        meta?.explicitKey === false
          ? this.uniqueKey(entry.value.key)
          : entry.value.key;
      this.monitor({
        ...entry.value,
        key,
      });
    }
  }

  define(
    definition: AnyDefinition,
    inferred = false,
    registration?: { readonly name?: string; readonly origin?: string }
  ): void {
    const name = registration?.name ?? definition.name;
    if (name === undefined) {
      return;
    }
    const origin = registration?.origin ?? definition.origin;
    const taken = this.definitions.get(name);
    const takenOrigin = this.#definitionOrigins.get(name) ?? taken?.origin;
    if (taken && (inferred || this.#inferred.has(name))) {
      throw new Error(
        `"${name}" already registered${quoteOrigin(takenOrigin)}; the name comes from an export${quoteOrigin(origin)}; rename one or name it explicitly`
      );
    }
    if (taken) {
      throw new Error(
        `"${name}" already registered${quoteOrigin(takenOrigin)}; second registration${quoteOrigin(origin)}`
      );
    }
    this.definitions.set(name, definition);
    this.#definitionNames.set(definition, name);
    if (origin !== undefined) {
      this.#definitionOrigins.set(name, origin);
    }
    if (inferred) {
      this.#inferred.add(name);
    }
  }

  provide(provider: ProviderPlugin, origin: string | undefined): void {
    const { id } = provider;
    if (DEFAULT_PROVIDER_IDS.has(id)) {
      if (DEFAULT_PROVIDER in provider) {
        return;
      }
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
        `agent "${id}" already declared by another function${quoteOrigin(claimed.origin)}${quoteOrigin(origin)}; an agent declared with a function is identified by its export or its source, not by the values it closes over, so these two would share approvals and triggers. Export each with its own name`
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
    this.artifacts.clear();
    this.definitions.clear();
    this.schedules.clear();
    this.monitors.clear();
    this.observers.length = 0;
    this.providers.clear();
    this.sandboxes.clear();
    this.#providerOrigins.clear();
    this.workspaces.clear();
    this.#counters.clear();
    this.#inferred.clear();
    this.#definitionNames.clear();
    this.#definitionOrigins.clear();
    this.#nestedDefinitions.clear();
    this.#structuralIdentities.clear();
    this.#agentIds.clear();
    this.#seenMonitors.clear();
    this.#seenObservers.clear();
    this.#seenProviders.clear();
    this.#seenSchedules.clear();
    this.#scheduleTargets.clear();
    this.#agents.clear();
  }
}

export function collectCatalog(input: CollectInput): Catalog {
  return Catalog.collect(input);
}
