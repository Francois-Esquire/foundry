import { createHmac, randomBytes } from "node:crypto";
import type {
  ModelKind,
  Models,
  Provider,
  ProviderModelDefinition,
} from "@foundry/models";
import {
  accountPatterns,
  ambientProblem,
  identityMaterial,
  refusingWhenChanged,
} from "~/lib/providers/account";
import type { Drafts } from "~/lib/providers/instances";
import { ProviderInstances } from "~/lib/providers/instances";
import type {
  Execution,
  ProviderInstance,
  ProviderPlugin,
  ProviderScope,
  ProviderWorkspace,
} from "~/lib/providers/plugins";
import type {
  ProviderConfigurations,
  ProviderEntryRecord,
  ProviderStore,
  ProvidersFile,
  ProviderWrites,
} from "~/lib/providers/store";
import {
  ConfigurationError,
  describeIssues,
  empty,
  InvalidStoredConfiguration,
  keptConfigurations,
  MemoryProviderStore,
  readOnlyProviders,
} from "~/lib/providers/store";
import type {
  ReadEvent,
  StoreRead,
  StoreReads,
} from "~/lib/providers/store-reads";
import {
  ALL_FINE,
  moveReads,
  RECOVERED,
  retriedOn,
} from "~/lib/providers/store-reads";

type Edit = (current: ProvidersFile | undefined) => ProvidersFile | undefined;

interface Scope {
  readonly kind: ProviderScope;
  read(): ProvidersFile | undefined;
  update(edit: Edit): Promise<ProviderConfigurations>;
}

export interface ProviderEntry extends ProviderEntryRecord {
  readonly position?: number;
  readonly problem?: string;
  readonly scope: ProviderScope;
  readonly state: "excluded" | "ready" | "unavailable" | "unloadable";
}

export type ScopedRecord = ProviderEntryRecord & {
  readonly scope: ProviderScope;
};

export type Proposal = ScopedRecord & { readonly taken?: string };

export interface ProviderConfigurationOptions {
  readonly echo?: (instance: Provider) => Provider;
  readonly environment: Readonly<Record<string, string>>;
  readonly fixed?: readonly Provider[];
  readonly models: Models;
  readonly plugins: readonly ProviderPlugin[];
  readonly readOnly?: boolean;
  readonly store?: ProviderStore;
  readonly workspace?: ProviderWorkspace;
}

const ID = /^[a-z0-9][a-z0-9-]*$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const POLL_MS = 500;
const LIST_TIMEOUT_MS = 5000;

type Listing =
  | {
      readonly models: readonly ProviderModelDefinition[];
      readonly problem?: undefined;
    }
  | { readonly models?: undefined; readonly problem: string };

type Built =
  | { readonly entry: ProviderEntry; readonly instance?: undefined }
  | {
      readonly entry: ProviderEntry;
      readonly identity: unknown;
      readonly instance: ProviderInstance;
      readonly key: string;
    };

export class ProviderConfiguration {
  readonly #options: ProviderConfigurationOptions;
  readonly #store: ProviderStore;
  readonly #machine: Scope;
  readonly #workspace: Scope | undefined;
  #kept: ProviderConfigurations = keptConfigurations(new Map(), 0);
  #revision: number | undefined;
  #unloaded = false;
  #reads: StoreReads = ALL_FINE;
  #heard: string[] | undefined;
  readonly #owed: string[] = [];
  readonly #accounted = new WeakSet<object>();
  #editing: ProviderConfigurations | undefined;
  readonly #plugins: ReadonlyMap<string, ProviderPlugin>;
  #built: readonly Built[] = [];
  #instances = new Map<string, ProviderInstance>();
  #identities = new Map<string, { digest?: string; material: unknown }>();
  #key: Buffer | undefined;
  readonly #owned = new ProviderInstances();
  readonly #listings = new Map<string, Listing>();
  readonly #listed = new Map<string, number>();
  readonly #lists = new AbortController();

  constructor(options: ProviderConfigurationOptions) {
    this.#options = options;
    this.#plugins = new Map(
      options.plugins.map((plugin) => [plugin.id, plugin])
    );
    const store =
      options.fixed === undefined && options.store !== undefined
        ? options.store
        : new MemoryProviderStore();
    this.#store = options.readOnly ? readOnlyProviders(store) : store;
    this.#machine = {
      kind: "machine",
      read: () => this.#view().machine,
      update: (edit) =>
        this.#write((current) => {
          const next = edit(current.machine);
          return next === undefined ? {} : { machine: next };
        }),
    };
    const id = options.workspace?.id;
    this.#workspace =
      id === undefined
        ? undefined
        : {
            kind: "workspace",
            read: () => this.#view().workspace(id),
            update: (edit) =>
              this.#write((current) => {
                const next = edit(current.workspace(id));
                return next === undefined ? {} : { workspace: next };
              }),
          };
  }

  #view(): ProviderConfigurations {
    return this.#editing ?? this.#kept;
  }

  async #write(
    edit: (current: ProviderConfigurations) => ProviderWrites
  ): Promise<ProviderConfigurations> {
    const landed = await this.#store.update(
      this.#options.workspace?.id,
      (current) => {
        this.#editing = current;
        try {
          return edit(current);
        } finally {
          this.#editing = undefined;
        }
      }
    );
    this.#adopt(landed);
    await this.#keyed(landed);
    return landed;
  }

  #adopt(kept: ProviderConfigurations): boolean {
    if (this.#revision !== undefined && kept.revision < this.#revision) {
      return false;
    }
    this.#kept = kept;
    this.#revision = kept.revision;
    return true;
  }

  async #keyed(kept: ProviderConfigurations): Promise<void> {
    if (this.#key !== undefined) {
      return;
    }
    let configured: boolean;
    try {
      configured = this.#configuredIn(kept);
    } catch (error) {
      this.#move("identity key", { kind: "not needed" });
      throw this.#invalidContent("configuration", error, kept.revision);
    }
    if (!configured) {
      this.#move("identity key", { kind: "not needed" });
      return;
    }
    const key = await this.#reaching(
      "identity key",
      () => this.#store.identityKey(true),
      kept.revision
    );
    this.#key ??= key;
  }

  async #reaching<T>(
    read: StoreRead,
    call: () => Promise<T>,
    revision?: number
  ): Promise<T> {
    let result: T;
    try {
      result = await call();
    } catch (error) {
      if (error instanceof InvalidStoredConfiguration) {
        throw this.#invalidContent(read, error, revision);
      }
      this.#move(read, { kind: "unreachable", message: messageOf(error) });
      if (error instanceof Object) {
        this.#accounted.add(error);
      }
      throw error;
    }
    this.#move(read, { kind: "succeeded" });
    return result;
  }

  #invalidContent(
    read: StoreRead,
    error: unknown,
    revision: number | undefined
  ): unknown {
    if (error instanceof InvalidStoredConfiguration) {
      this.#move(read, { kind: "invalid", message: error.message, revision });
      this.#accounted.add(error);
    }
    return error;
  }

  #move(read: StoreRead, event: ReadEvent): void {
    const { reads, reports } = moveReads(this.#reads, read, event);
    this.#reads = reads;
    for (const report of reports) {
      if (this.#heard !== undefined) {
        this.#heard.push(report);
      } else if (report === RECOVERED) {
        this.#owed.push(report);
      }
    }
  }

  #together(edits: readonly [Scope, Edit][]): Promise<ProviderConfigurations> {
    return this.#write(() => {
      const writes: { machine?: ProvidersFile; workspace?: ProvidersFile } = {};
      for (const [scope, edit] of edits) {
        const next = edit(scope.read());
        if (next !== undefined) {
          writes[scope.kind] = next;
        }
      }
      return writes;
    });
  }

  async read(): Promise<void> {
    if (this.#options.fixed !== undefined) {
      return;
    }
    const kept = await this.#reaching("configuration", () =>
      this.#store.read()
    );
    if (this.#adopt(kept)) {
      this.#unloaded = true;
    }
    await this.#keyed(kept);
  }

  get configured(): boolean {
    return (
      this.#options.fixed !== undefined || this.#configuredIn(this.#view())
    );
  }

  #configuredIn(kept: ProviderConfigurations): boolean {
    const id = this.#options.workspace?.id;
    return (
      kept.machine !== undefined ||
      (id !== undefined && kept.workspace(id) !== undefined)
    );
  }

  require(): void {
    if (this.configured) {
      return;
    }
    throw new ConfigurationError(
      "PROVIDERS_NOT_CONFIGURED",
      `No model providers are configured. Run marbles${this.#options.readOnly ? " without --dry-run" : ""} in a terminal to set them up.`
    );
  }

  load(): void {
    this.#load(new Map());
  }

  #load(drafts: Drafts, kept: ProviderConfigurations = this.#view()): void {
    const id = this.#options.workspace?.id;
    const { machine } = kept;
    const workspace = id === undefined ? undefined : kept.workspace(id);
    const { built, cache } = this.#effective(machine, workspace, drafts);
    const fixed = this.#options.fixed ?? [];
    const used = built
      .filter(
        (each): each is Built & { instance: ProviderInstance } =>
          each.instance !== undefined && each.entry.position !== undefined
      )
      .sort((a, b) => (a.entry.position ?? 0) - (b.entry.position ?? 0));
    const instances = new Map<string, ProviderInstance>([
      ...fixed.map((provider) => [provider.id, { provider }] as const),
      ...used.map((each) => [each.entry.id, each.instance] as const),
    ]);
    const identities = new Map<string, { material: unknown }>([
      ...fixed.map(
        (provider) =>
          [provider.id, { material: ["host", provider.id] }] as const
      ),
      ...used.map(
        (each) => [each.entry.id, { material: each.identity }] as const
      ),
    ]);
    try {
      this.#options.models.setProviders([
        ...fixed,
        ...used.map((each) => each.instance.provider),
      ]);
    } catch (error) {
      this.#owned.discard(cache.values());
      throw error;
    }
    this.#owned.adopt(
      cache,
      used.map((each) => each.instance)
    );
    if (kept === this.#kept) {
      this.#unloaded = false;
    }
    this.#built = built;
    this.#instances = instances;
    this.#identities = identities;
  }

  async refresh(): Promise<readonly string[]> {
    await this.read();
    try {
      if (!this.configured) {
        return [];
      }
      const problems = await this.#listAll();
      if (this.#lists.signal.aborted) {
        return problems;
      }
      this.load();
      return [...problems, ...this.#undefinedProviders()];
    } catch (error) {
      throw this.#invalidContent("configuration", error, this.#revision);
    }
  }

  undefinedProvider(id: string): string | undefined {
    const entry = this.#built.find(
      (built) =>
        built.entry.id === id &&
        built.entry.enabled &&
        !this.#plugins.has(built.entry.plugin)
    )?.entry;
    return entry === undefined ? undefined : undefinedProvider(entry.plugin);
  }

  #undefinedProviders(): readonly string[] {
    const id = this.#options.workspace?.id;
    const view = this.#view();
    const order = effectiveOrder(
      view.machine,
      id === undefined ? undefined : view.workspace(id)
    );
    const named = new Set(
      this.#built.flatMap(({ entry }) =>
        entry.enabled &&
        order.includes(entry.id) &&
        !this.#plugins.has(entry.plugin)
          ? [entry.plugin]
          : []
      )
    );
    return [...named].map(undefinedProvider);
  }

  dispose(): Promise<void> {
    this.#lists.abort();
    return this.#owned.dispose();
  }

  async #commit(
    write: (drafts: Drafts) => Promise<ProviderConfigurations | false>
  ): Promise<void> {
    const drafts: Drafts = new Map();
    try {
      const landed = await write(drafts);
      if (landed !== false) {
        await this.#listAll();
        if (this.#lists.signal.aborted) {
          return;
        }
        if (landed.revision >= (this.#revision ?? 0)) {
          this.#load(drafts, landed);
          // biome-ignore lint/suspicious/noUnnecessaryConditions: Biome narrows the field to its initial value; a read sets it.
        } else if (this.#unloaded) {
          this.#load(drafts);
        }
      }
    } finally {
      this.#owned.discard(drafts.values());
    }
  }

  list(): readonly ProviderEntry[] {
    const fixed = (this.#options.fixed ?? []).map(
      (provider, position): ProviderEntry => ({
        enabled: true,
        id: provider.id,
        plugin: "host",
        position,
        scope: "machine",
        state: "ready",
      })
    );
    const entries = this.#built.map((built) => ({
      ...built.entry,
      ...(built.entry.settings
        ? { settings: this.#redacted(built.entry) }
        : {}),
    }));
    return [
      ...fixed,
      ...entries
        .filter((entry) => entry.position !== undefined)
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
      ...entries.filter((entry) => entry.position === undefined),
    ];
  }

  instance(id: string): ProviderInstance | undefined {
    return this.#instances.get(id);
  }

  identityOf(id: string): string | undefined {
    const identity = this.#identities.get(id);
    if (identity) {
      identity.digest ??= this.#digest(identity.material);
    }
    return identity?.digest;
  }

  executionOf(id: string): Execution | null | undefined {
    if (this.#options.fixed !== undefined) {
      return undefined;
    }
    return this.#instances.get(id)?.execution ?? null;
  }

  propose(): readonly Proposal[] {
    const env = this.#options.environment;
    return [...this.#plugins.values()].flatMap((plugin) => {
      const settings = plugin.detect?.({ env });
      if (settings === undefined || settings === null) {
        return [];
      }
      const scope: ProviderScope =
        plugin.binding === "workspace" ? "workspace" : "machine";
      const usedBy =
        scope === "machine" ? this.#takenAt(plugin.id, {}) : undefined;
      return [
        {
          enabled: true,
          id: plugin.id,
          plugin: plugin.id,
          scope,
          ...(usedBy === undefined ? {} : { taken: usedBy }),
          ...(Object.keys(settings as object).length > 0
            ? { settings: settings as Record<string, unknown> }
            : {}),
        },
      ];
    });
  }

  async add(
    record: Omit<ProviderEntryRecord, "enabled"> & {
      readonly enabled?: boolean;
    },
    at: { readonly index?: number; readonly scope: ProviderScope }
  ): Promise<void> {
    const entry: ProviderEntryRecord = { enabled: true, ...record };
    this.#check(entry, at.scope);
    await this.#commit((drafts) =>
      this.#scope(at.scope).update((current) => {
        const file = current ?? empty();
        if (file.providers.some((existing) => existing.id === entry.id)) {
          throw taken(
            `"${entry.id}" is already configured at ${at.scope} scope`
          );
        }
        if (entry.enabled) {
          this.#refuseTaken(entry.id, at.scope);
        }
        this.#ready(entry, at.scope, drafts);
        const providers = insert(file.providers, entry, at.index);
        const order =
          at.scope === "workspace" && file.order
            ? insert(file.order, entry.id, at.index)
            : file.order;
        return { ...file, providers, ...(order ? { order } : {}) };
      })
    );
  }

  async update(
    id: string,
    patch: Partial<Pick<ProviderEntryRecord, "defaults" | "settings">>
  ): Promise<void> {
    await this.#edit(id, (entry) => ({ ...entry, ...patch }));
  }

  enable(id: string): Promise<void> {
    return this.#edit(id, (entry) => ({ ...entry, enabled: true }));
  }

  disable(id: string): Promise<void> {
    return this.#edit(id, (entry) => ({ ...entry, enabled: false }), false);
  }

  async remove(id: string): Promise<void> {
    await this.#commit(() =>
      this.#write(() => {
        const scope = this.#scopeOf(id);
        const file = this.#scope(scope).read() ?? empty();
        const order = file.order?.filter((each) => each !== id);
        return {
          [scope]: {
            ...file,
            providers: file.providers.filter((entry) => entry.id !== id),
            ...(order ? { order } : {}),
          },
        };
      })
    );
  }

  async move(id: string, index: number, scope: ProviderScope): Promise<void> {
    if (scope === "machine") {
      await this.#commit(() =>
        this.#machine.update((current) => {
          const file = current ?? empty();
          const entry = file.providers.find((each) => each.id === id);
          if (!entry) {
            throw invalid(`"${id}" is not configured at machine scope`);
          }
          const rest = file.providers.filter((each) => each.id !== id);
          return { ...file, providers: insert(rest, entry, index) };
        })
      );
    } else {
      const current = this.list()
        .filter((entry) => entry.position !== undefined)
        .map((entry) => entry.id);
      await this.#commit(() =>
        this.#workspaceStore().update((file) => {
          const base = file?.order ?? current;
          const rest = base.filter((each) => each !== id);
          return { ...(file ?? empty()), order: insert(rest, id, index) };
        })
      );
    }
  }

  async setOrder(ids: readonly string[] | undefined): Promise<void> {
    await this.#commit(() =>
      this.#workspaceStore().update((file) => {
        const { order: _, ...rest } = file ?? empty();
        return ids === undefined ? rest : { ...rest, order: [...ids] };
      })
    );
  }

  async replace(entries: readonly ScopedRecord[]): Promise<void> {
    const ids = entries.map((entry) => entry.id);
    const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
    if (repeated !== undefined) {
      throw taken(`"${repeated}" is listed more than once`);
    }
    if (entries.some((entry) => entry.scope === "workspace")) {
      this.#workspaceStore();
    }
    await this.#commit(async (drafts) => {
      for (const { scope, ...entry } of entries) {
        this.#ready(entry, scope, drafts);
      }
      const of = (scope: ProviderScope) =>
        entries
          .filter((entry) => entry.scope === scope)
          .map(({ scope: _, ...entry }) => entry);
      const edits: [Scope, Edit][] = [
        [
          this.#machine,
          () => {
            for (const entry of of("machine")) {
              if (entry.enabled) {
                this.#refuseTaken(entry.id, "machine", { replacing: true });
              }
            }
            return { providers: of("machine"), version: 1 };
          },
        ],
      ];
      if (this.#workspace) {
        const providers = of("workspace");
        edits.push([this.#workspace, () => ({ providers, version: 1 })]);
      }
      return await this.#together(edits);
    });
  }

  async initialize(entries: readonly ProviderEntryRecord[]): Promise<boolean> {
    let written = false;
    await this.#commit(async (drafts) => {
      for (const entry of entries) {
        this.#ready(entry, "machine", drafts);
      }
      const landed = await this.#machine.update((current) => {
        if (current !== undefined) {
          return;
        }
        for (const entry of entries) {
          this.#refuseTaken(entry.id, "machine");
        }
        written = true;
        return { providers: [...entries], version: 1 };
      });
      return written ? landed : false;
    });
    return written;
  }

  watch(report: (problem: string) => void): () => void {
    if (this.#options.fixed !== undefined) {
      return () => undefined;
    }
    let polling = false;
    let polls = 0;
    const poll = async (number: number) => {
      const retry =
        retriedOn("configuration", this.#reads.configuration, number) ||
        retriedOn("identity key", this.#reads["identity key"], number);
      if (!retry) {
        const seen = this.#revision;
        if (seen === undefined) {
          return;
        }
        const revision = await this.#reaching("revision", () =>
          this.#store.revision()
        );
        if (revision === seen) {
          return;
        }
      }
      for (const problem of await this.refresh()) {
        report(problem);
      }
    };
    const timer = setInterval(() => {
      if (polling) {
        return;
      }
      polling = true;
      polls += 1;
      const heard = this.#owed.splice(0);
      this.#heard = heard;
      poll(polls)
        .catch((error: unknown) => {
          if (!(error instanceof Object && this.#accounted.has(error))) {
            heard.push(messageOf(error));
          }
        })
        .finally(() => {
          this.#heard = undefined;
          for (const problem of heard) {
            report(problem);
          }
          polling = false;
        });
    }, POLL_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  #scope(scope: ProviderScope): Scope {
    return scope === "machine" ? this.#machine : this.#workspaceStore();
  }

  #workspaceStore(): Scope {
    if (!this.#workspace) {
      throw invalid(
        "this engine hosts no workspace, so it has no workspace scope"
      );
    }
    return this.#workspace;
  }

  #scopeOf(id: string): ProviderScope {
    if (this.#workspace?.read()?.providers.some((entry) => entry.id === id)) {
      return "workspace";
    }
    if (this.#machine.read()?.providers.some((entry) => entry.id === id)) {
      return "machine";
    }
    throw invalid(`"${id}" is not configured`);
  }

  async #edit(
    id: string,
    change: (
      entry: ProviderEntryRecord,
      scope: ProviderScope
    ) => ProviderEntryRecord,
    validate = true
  ): Promise<void> {
    await this.#commit((drafts) =>
      this.#write(() => {
        const scope = this.#scopeOf(id);
        const file = this.#scope(scope).read() ?? empty();
        return {
          [scope]: {
            ...file,
            providers: file.providers.map((entry) => {
              if (entry.id !== id) {
                return entry;
              }
              const next = change(entry, scope);
              if (validate) {
                this.#ready(next, scope, drafts);
                if (next.enabled) {
                  this.#refuseTaken(next.id, scope);
                }
              }
              return next;
            }),
          },
        };
      })
    );
  }

  #refuseTaken(
    id: string,
    scope: ProviderScope,
    options: { readonly replacing?: boolean } = {}
  ): void {
    if (this.#options.fixed?.some((provider) => provider.id === id)) {
      throw taken(`"${id}" is the id of a provider the host supplied`);
    }
    if (scope === "workspace") {
      if (
        this.#machine
          .read()
          ?.providers.some((entry) => entry.id === id && entry.enabled)
      ) {
        throw taken(`"${id}" is already configured for the whole machine`);
      }
      return;
    }
    const workspace = this.#takenAt(id, options);
    if (workspace !== undefined) {
      throw taken(`"${id}" is already configured for workspace ${workspace}`);
    }
  }

  #takenAt(
    id: string,
    options: { readonly replacing?: boolean }
  ): string | undefined {
    if (this.#options.fixed !== undefined) {
      return undefined;
    }
    const view = this.#view();
    const own = options.replacing ? this.#options.workspace?.id : undefined;
    return view.workspaces.find(
      (workspace) =>
        workspace !== own &&
        (view
          .workspace(workspace)
          ?.providers.some((entry) => entry.id === id && entry.enabled) ??
          false)
    );
  }

  #check(entry: ProviderEntryRecord, scope: ProviderScope): void {
    const problem = this.#problem(entry, scope);
    if (problem) {
      throw invalid(problem);
    }
  }

  #ready(entry: ProviderEntryRecord, scope: ProviderScope, drafts: Drafts) {
    this.#check(entry, scope);
    if (!entry.enabled) {
      return;
    }
    const built = this.#build(
      entry,
      scope,
      (state, problem) => ({
        entry: { ...entry, scope, state, ...(problem ? { problem } : {}) },
      }),
      drafts
    );
    if (built.entry.state === "unloadable") {
      throw invalid(built.entry.problem ?? `"${entry.id}" cannot be built`);
    }
    if (built.instance && built.instance !== this.#owned.get(built.key)) {
      drafts.set(built.key, built.instance);
    }
  }

  #problem(
    entry: ProviderEntryRecord,
    scope: ProviderScope
  ): string | undefined {
    if (!ID.test(entry.id)) {
      return `"${entry.id}" is not a valid provider id`;
    }
    const plugin = this.#plugins.get(entry.plugin);
    if (!plugin) {
      return undefinedProvider(entry.plugin);
    }
    if (plugin.binding === "workspace" && scope === "machine") {
      return `"${entry.plugin}" must be configured for a workspace`;
    }
    const parsed = plugin.settings.safeParse(entry.settings ?? {});
    if (!parsed.success) {
      return `settings do not fit "${entry.plugin}": ${describeIssues(parsed.error)}`;
    }
    for (const key of plugin.secrets ?? []) {
      const value = entry.settings?.[key];
      if (
        value !== undefined &&
        !(typeof value === "string" && ENV_NAME.test(value))
      ) {
        return `"${key}" must name an environment variable, not hold a value`;
      }
    }
    let catalog: ReturnType<ProviderPlugin["catalog"]>;
    try {
      const listed = this.#listingOf(plugin, parsed.data);
      if (plugin.list && !listed?.models) {
        return undefined;
      }
      catalog = listed?.models ?? plugin.catalog(parsed.data);
    } catch (error) {
      return `"${entry.plugin}" could not list its catalog: ${messageOf(error)}`;
    }
    for (const [kind, model] of Object.entries(entry.defaults ?? {})) {
      if (!catalog.some((row) => row.id === model && row.kind === kind)) {
        return `the default ${kind} model "${model}" is not in the catalog`;
      }
    }
    return undefined;
  }

  #effective(
    machine: ProvidersFile | undefined,
    workspace: ProvidersFile | undefined,
    drafts: Drafts
  ): {
    readonly built: readonly Built[];
    readonly cache: Map<string, ProviderInstance>;
  } {
    const fixedIds = new Set((this.#options.fixed ?? []).map((p) => p.id));
    const scoped = [
      ...(workspace?.providers ?? []).map((entry) => ({
        entry,
        scope: "workspace" as const,
      })),
      ...(machine?.providers ?? []).map((entry) => ({
        entry,
        scope: "machine" as const,
      })),
    ];
    const count = new Map<string, number>();
    for (const { entry } of scoped) {
      if (entry.enabled) {
        count.set(entry.id, (count.get(entry.id) ?? 0) + 1);
      }
    }
    const order = effectiveOrder(machine, workspace);
    const keep = new Map<Built, Built>();
    const cache = new Map<string, ProviderInstance>();
    const results = scoped.map(({ entry, scope }): Built => {
      const report = (state: ProviderEntry["state"], why?: string): Built => ({
        entry: { ...entry, scope, state, ...(why ? { problem: why } : {}) },
      });
      if (fixedIds.has(entry.id)) {
        return report(
          "unloadable",
          `"${entry.id}" is the id of a provider the host supplied`
        );
      }
      if (entry.enabled && (count.get(entry.id) ?? 0) > 1) {
        return report(
          "unloadable",
          `"${entry.id}" is configured more than once`
        );
      }
      const problem = this.#problem(entry, scope);
      if (problem) {
        return report("unloadable", problem);
      }
      if (!entry.enabled) {
        return report("excluded", "disabled");
      }
      if (!order.includes(entry.id)) {
        return report("excluded", "not in this workspace's order");
      }
      const built = this.#build(entry, scope, report, drafts);
      if (built.instance) {
        cache.set(built.key, built.instance);
      }
      return built;
    });
    let position = 0;
    for (const id of order) {
      const built = results.find(
        (result) => result.entry.id === id && result.entry.state === "ready"
      );
      if (built) {
        keep.set(built, { ...built, entry: { ...built.entry, position } });
        position += 1;
      }
    }
    return {
      built: results.map((result) => keep.get(result) ?? result),
      cache,
    };
  }

  #build(
    entry: ProviderEntryRecord,
    scope: ProviderScope,
    report: (state: ProviderEntry["state"], problem?: string) => Built,
    drafts: Drafts
  ): Built {
    const plugin = this.#plugins.get(entry.plugin) as ProviderPlugin;
    const settings = plugin.settings.parse(entry.settings ?? {});
    const env = this.#options.environment;
    const patterns = accountPatterns(plugin, settings);
    const ambient = plugin.ambient ? ambientProblem(patterns, env) : undefined;
    if (ambient) {
      return report("unavailable", ambient);
    }
    const listed = this.#listingOf(plugin, settings);
    if (plugin.list && !listed?.models) {
      return report(
        "unavailable",
        listed?.problem ?? "its models have not been listed yet"
      );
    }
    const models = listed?.models ?? plugin.catalog(settings);
    const key = JSON.stringify([scope, entry, env, listed?.models ?? null]);
    const instance =
      this.#owned.get(key) ??
      take(drafts, key) ??
      this.#instantiate(plugin, entry, {
        env,
        models,
        patterns,
        scope,
        settings,
      });
    if (typeof instance === "string") {
      return report("unloadable", instance);
    }
    return {
      entry: {
        ...entry,
        scope,
        state: instance.provider.available ? "ready" : "unavailable",
        ...(instance.provider.available
          ? {}
          : { problem: "not available on this machine" }),
      },
      identity: identityMaterial({
        entry,
        env,
        patterns,
        scope,
        settings,
        workspace:
          scope === "workspace" ? (this.#options.workspace?.id ?? null) : null,
      }),
      instance,
      key,
    };
  }

  #instantiate(
    plugin: ProviderPlugin,
    entry: ProviderEntryRecord,
    built: {
      readonly env: Readonly<Record<string, string>>;
      readonly models: readonly ProviderModelDefinition[];
      readonly patterns: readonly string[];
      readonly scope: ProviderScope;
      readonly settings: unknown;
    }
  ): ProviderInstance | string {
    const { env, patterns } = built;
    let created: ProviderInstance;
    try {
      created = this.#create(plugin, entry, built);
    } catch (error) {
      return `"${entry.plugin}" could not build it: ${messageOf(error)}`;
    }
    if (created.provider.id !== entry.id) {
      this.#owned.discard([created]);
      return `"${entry.plugin}" built an instance named "${created.provider.id}"`;
    }
    const served = plugin.ambient
      ? refusingWhenChanged(created.provider, patterns, env)
      : created.provider;
    return {
      ...created,
      provider: this.#options.echo ? this.#options.echo(served) : served,
    };
  }

  #create(
    plugin: ProviderPlugin,
    entry: ProviderEntryRecord,
    {
      env,
      models,
      scope,
      settings,
    }: {
      readonly env: Readonly<Record<string, string>>;
      readonly models: readonly ProviderModelDefinition[];
      readonly scope: ProviderScope;
      readonly settings: unknown;
    }
  ): ProviderInstance {
    return plugin.create({
      ...(entry.defaults
        ? { defaults: entry.defaults as Partial<Record<ModelKind, string>> }
        : {}),
      env,
      id: entry.id,
      models,
      scope,
      settings,
      ...(scope === "workspace" && this.#options.workspace
        ? { workspace: this.#options.workspace }
        : {}),
    });
  }

  #digest(material: unknown): string {
    if (this.#key === undefined) {
      if (this.#options.fixed === undefined && !this.#options.readOnly) {
        throw new ConfigurationError(
          "CONFIGURATION_UNREADABLE",
          "an instance identity was asked for before the stored identity key was read"
        );
      }
      this.#key = randomBytes(32);
    }
    return createHmac("sha256", this.#key)
      .update(JSON.stringify(material))
      .digest("hex")
      .slice(0, 32);
  }

  #listingOf(plugin: ProviderPlugin, settings: unknown): Listing | undefined {
    return plugin.list
      ? this.#listings.get(
          listingKey(plugin, settings, this.#options.environment)
        )
      : undefined;
  }

  async #listAll(): Promise<readonly string[]> {
    if (this.#lists.signal.aborted || this.#options.fixed !== undefined) {
      return [];
    }
    let files: (ProvidersFile | undefined)[];
    try {
      files = [this.#workspace?.read(), this.#machine.read()];
    } catch {
      return [];
    }
    const [workspace, machine] = files;
    const enabled = [
      ...(workspace?.providers ?? []),
      ...(machine?.providers ?? []),
    ].filter((entry) => entry.enabled);
    const order = effectiveOrder(machine, workspace);
    const eligible = (id: string) =>
      order.includes(id) &&
      enabled.filter((entry) => entry.id === id).length === 1;
    const asked = files.flatMap((file) =>
      (file?.providers ?? []).flatMap((entry) => {
        const plugin = this.#plugins.get(entry.plugin);
        const parsed = plugin?.settings.safeParse(entry.settings ?? {});
        if (
          !(
            entry.enabled &&
            plugin?.list &&
            parsed?.success &&
            eligible(entry.id)
          )
        ) {
          return [];
        }
        return [
          this.#list(entry.id, plugin, parsed.data, this.#options.environment),
        ];
      })
    );
    const problems = await Promise.all(asked);
    return problems.filter((problem) => problem !== undefined);
  }

  async #list(
    id: string,
    plugin: ProviderPlugin,
    settings: unknown,
    env: Readonly<Record<string, string>>
  ): Promise<string | undefined> {
    const key = listingKey(plugin, settings, env);
    const started = (this.#listed.get(key) ?? 0) + 1;
    this.#listed.set(key, started);
    const ended = this.#lists.signal;
    const signal = AbortSignal.any([
      ended,
      AbortSignal.timeout(LIST_TIMEOUT_MS),
    ]);
    let listing: Listing;
    try {
      const models = await untilAborted(
        Promise.resolve(plugin.list?.({ env, settings, signal })),
        signal
      );
      listing = { models: models ?? [] };
    } catch (error) {
      listing = { problem: `its models could not be listed: ${reason(error)}` };
    }
    if (ended.aborted || this.#listed.get(key) !== started) {
      return undefined;
    }
    if (listing.problem === undefined) {
      this.#listings.set(key, listing);
      return undefined;
    }
    if (this.#listings.get(key)?.models) {
      return `"${id}" kept its last model list; ${listing.problem}`;
    }
    this.#listings.set(key, listing);
    return `"${id}" has no models; ${listing.problem}`;
  }

  #redacted(entry: ProviderEntryRecord): Record<string, unknown> {
    const plugin = this.#plugins.get(entry.plugin);
    return Object.fromEntries(
      Object.entries(entry.settings ?? {}).map(([key, value]) => {
        if (!plugin?.secrets?.includes(key)) {
          return [key, value];
        }
        return [
          key,
          typeof value === "string" && ENV_NAME.test(value)
            ? `$${value}`
            : "<redacted>",
        ];
      })
    );
  }
}

function insert<T>(items: readonly T[], item: T, index?: number): T[] {
  const at =
    index === undefined
      ? items.length
      : Math.max(0, Math.min(index, items.length));
  return [...items.slice(0, at), item, ...items.slice(at)];
}

function taken(message: string): ConfigurationError {
  return new ConfigurationError("PROVIDER_ID_TAKEN", message);
}

function invalid(message: string): ConfigurationError {
  return new ConfigurationError("PROVIDER_ENTRY_INVALID", message);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reason(error: unknown): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return `no answer within ${LIST_TIMEOUT_MS / 1000} s`;
  }
  return messageOf(error);
}

const OPT_IN: Readonly<Record<string, string>> = {
  "claude-code": "claudeCode",
  codex: "codex",
  gateway: "gateway",
  pi: "pi",
  vercel: "vercel",
};

function undefinedProvider(plugin: string): string {
  const name = OPT_IN[plugin];
  const fix =
    name === undefined
      ? 'pass its provider object to defineProvider, imported from "@foundry.sh/marbles/providers", and export it from the workspace\'s source'
      : `add to the workspace's source: import { defineProvider } from "@foundry.sh/marbles/providers"; import { ${name} } from "@foundry.sh/marbles/providers/${plugin}"; export const ${name}Provider = defineProvider(${name});`;
  return `provider "${plugin}" is unavailable: this workspace does not define it; to use it, ${fix}`;
}

function effectiveOrder(
  machine: ProvidersFile | undefined,
  workspace: ProvidersFile | undefined
): readonly string[] {
  const ids = [
    ...(workspace?.providers ?? []),
    ...(machine?.providers ?? []),
  ].map((entry) => entry.id);
  return [...new Set(workspace?.order ?? ids)];
}

function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
    if (signal.aborted) {
      abort();
    } else {
      signal.addEventListener("abort", abort, { once: true });
    }
  });
}

function listingKey(
  plugin: ProviderPlugin,
  settings: unknown,
  env: Readonly<Record<string, string>>
): string {
  return JSON.stringify([plugin.id, settings, env]);
}

function take(drafts: Drafts, key: string): ProviderInstance | undefined {
  const draft = drafts.get(key);
  drafts.delete(key);
  return draft;
}
