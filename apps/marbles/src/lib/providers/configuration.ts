import { createHmac } from "node:crypto";
import { existsSync, readdirSync, unwatchFile, watchFile } from "node:fs";
import { join } from "node:path";
import type { ModelKind, ModelManager, Provider } from "@foundry/models";
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
  ProviderScope,
  ProviderWorkspace,
  RegisteredPlugin,
} from "~/lib/providers/plugins";
import type {
  Edit,
  ProviderEntryRecord,
  ProvidersFile,
  Store,
} from "~/lib/providers/store";
import {
  ConfigurationError,
  describeIssues,
  empty,
  fileStore,
  identityKey,
  memoryStore,
  readProvidersFile,
  together,
} from "~/lib/providers/store";

/** An entry as `list()` reports it, with where it applies and why it does not. */
export interface ProviderEntry extends ProviderEntryRecord {
  /** Position in this workspace's effective set, when used here. */
  readonly position?: number;
  readonly problem?: string;
  readonly scope: ProviderScope;
  readonly state: "excluded" | "ready" | "unavailable" | "unloadable";
}

export type ScopedRecord = ProviderEntryRecord & {
  readonly scope: ProviderScope;
};

/** A machine-scope proposal, with the workspace that already uses its id. */
export type Proposal = ScopedRecord & { readonly taken?: string };

export interface ProviderConfigurationOptions {
  /** Build a stand-in for each instance instead, for a dry run. */
  readonly echo?: (instance: Provider) => Provider;
  /** The machine environment and the workspace's Varlock values. */
  readonly environment: {
    readonly machine: Readonly<Record<string, string>>;
    readonly workspace: Readonly<Record<string, string>>;
  };
  /** A programmatic host's complete set: no file is read or written. */
  readonly fixed?: readonly Provider[];
  readonly models: ModelManager;
  readonly plugins: readonly RegisteredPlugin[];
  /** Edits change this engine's set only and write no file: a dry run. */
  readonly readOnly?: boolean;
  /** The Marbles state root, holding the machine file and each workspace's dir. */
  readonly state?: string;
  readonly workspace?: Omit<ProviderWorkspace, "env">;
}

const ID = /^[a-z0-9][a-z0-9-]*$/;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const FILE = "providers.json";
const POLL_MS = 500;

type Built =
  | { readonly entry: ProviderEntry; readonly instance?: undefined }
  | {
      readonly entry: ProviderEntry;
      /** What the instance's identity digests; keyed only when asked for. */
      readonly identity: unknown;
      readonly instance: ProviderInstance;
      readonly key: string;
    };

/**
 * The providers one workspace uses, from the machine file and the
 * workspace's own file, kept in the manager's set. Every edit re-reads its
 * file under its lock, validates, builds, writes, and then replaces the set;
 * an instance whose entry did not change is kept, so its sessions are not
 * disturbed.
 */
export class ProviderConfiguration {
  readonly #options: ProviderConfigurationOptions;
  readonly #machine: Store;
  readonly #workspace: Store | undefined;
  readonly #plugins: ReadonlyMap<string, RegisteredPlugin>;
  #built: readonly Built[] = [];
  #instances = new Map<string, ProviderInstance>();
  #identities = new Map<string, { digest?: string; material: unknown }>();
  #key: Buffer | undefined;
  readonly #owned = new ProviderInstances();

  constructor(options: ProviderConfigurationOptions) {
    this.#options = options;
    this.#plugins = new Map(
      options.plugins.map((plugin) => [plugin.id, plugin])
    );
    const files = options.fixed === undefined && options.state !== undefined;
    this.#machine = files
      ? fileStore(
          join(options.state as string, FILE),
          options.state as string,
          options.readOnly
        )
      : memoryStore();
    this.#workspace = this.#workspaceStoreFor(options, files);
  }

  #workspaceStoreFor(
    options: ProviderConfigurationOptions,
    files: boolean
  ): Store | undefined {
    if (options.workspace === undefined) {
      return undefined;
    }
    return files
      ? fileStore(
          join(options.workspace.dir, FILE),
          options.workspace.dir,
          options.readOnly
        )
      : memoryStore();
  }

  /** Whether any configuration exists: a file at either scope, or a programmatic set. */
  get configured(): boolean {
    return (
      this.#options.fixed !== undefined ||
      this.#machine.read() !== undefined ||
      this.#workspace?.read() !== undefined
    );
  }

  /** Throws `PROVIDERS_NOT_CONFIGURED`, with where to configure, when nothing is configured. */
  require(): void {
    if (this.configured) {
      return;
    }
    const where = this.#machine.watched;
    throw new ConfigurationError(
      "PROVIDERS_NOT_CONFIGURED",
      `No model providers are configured. Run marbles${this.#options.readOnly ? " without --dry-run" : ""} in a terminal to set them up${where ? `, or write ${where}` : ""}.`
    );
  }

  /** Read both scopes and replace the manager's set. An unreadable file throws. */
  load(): void {
    this.#load(new Map());
  }

  /** {@link load}, taking out of `drafts` each instance it keeps. */
  #load(drafts: Drafts): void {
    const machine = this.#machine.read();
    const workspace = this.#workspace?.read();
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
    // Only once the manager took the set, so a refused set changes nothing.
    this.#built = built;
    this.#instances = instances;
    this.#identities = identities;
  }

  /** Dispose the instances this configuration built that the manager never took. */
  dispose(): Promise<void> {
    return this.#owned.dispose();
  }

  /**
   * Run one write with its own drafts, then load what it wrote. The load
   * takes the drafts it keeps; the rest are discarded, so overlapping
   * writes never dispose or reuse each other's.
   */
  async #commit(write: (drafts: Drafts) => Promise<boolean>): Promise<void> {
    const drafts: Drafts = new Map();
    try {
      if (await write(drafts)) {
        this.#load(drafts);
      }
    } finally {
      this.#owned.discard(drafts.values());
    }
  }

  /** The effective set first, then the rest, each with its scope and state. */
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

  /** The live instance for `id`, with its execution facet. */
  instance(id: string): ProviderInstance | undefined {
    return this.#instances.get(id);
  }

  /**
   * The identity of the instance `id` names now, which a pinned session
   * must find again: a keyed digest of its scope, its workspace for
   * workspace scope, its plugin, id, and parsed settings, and the values of
   * the environment its plugin declares in `accountEnv`. Enabling,
   * disabling, reordering, and new defaults keep it; a scope move, a
   * settings change, or any change to that environment does not. A
   * programmatic host's provider is identified by its id.
   */
  identityOf(id: string): string | undefined {
    // Keyed on demand, so work that opens no session creates no key.
    const identity = this.#identities.get(id);
    if (identity) {
      identity.digest ??= this.#digest(identity.material);
    }
    return identity?.digest;
  }

  /**
   * How `id` runs in a sandbox guest: its execution, `null` for a
   * configured instance that runs none, or undefined when a programmatic
   * host supplied the set, so no configuration describes it.
   */
  executionOf(id: string): Execution | null | undefined {
    if (this.#options.fixed !== undefined) {
      return undefined;
    }
    return this.#instances.get(id)?.execution ?? null;
  }

  /**
   * Setup: what each plugin detects, at the scope it would be written to,
   * each machine entry with the workspace already using its id. Writes
   * nothing.
   */
  propose(): readonly Proposal[] {
    const env = this.#options.environment.machine;
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
    await this.#commit(async (drafts) => {
      await this.#store(at.scope).update((current) => {
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
      });
      return true;
    });
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

  /** Disabling is never refused, so an entry that cannot load can be set aside. */
  disable(id: string): Promise<void> {
    return this.#edit(id, (entry) => ({ ...entry, enabled: false }), false);
  }

  async remove(id: string): Promise<void> {
    const scope = this.#scopeOf(id);
    await this.#store(scope).update((current) => {
      const file = current ?? empty();
      const order = file.order?.filter((each) => each !== id);
      return {
        ...file,
        providers: file.providers.filter((entry) => entry.id !== id),
        ...(order ? { order } : {}),
      };
    });
    this.load();
  }

  /**
   * Machine scope reorders the machine file. Workspace scope edits `order`,
   * creating it from the current effective order when absent, which makes
   * the workspace use only what it lists from then on.
   */
  async move(id: string, index: number, scope: ProviderScope): Promise<void> {
    if (scope === "machine") {
      await this.#machine.update((current) => {
        const file = current ?? empty();
        const entry = file.providers.find((each) => each.id === id);
        if (!entry) {
          throw invalid(`"${id}" is not configured at machine scope`);
        }
        const rest = file.providers.filter((each) => each.id !== id);
        return { ...file, providers: insert(rest, entry, index) };
      });
    } else {
      const current = this.list()
        .filter((entry) => entry.position !== undefined)
        .map((entry) => entry.id);
      await this.#workspaceStore().update((file) => {
        const base = file?.order ?? current;
        const rest = base.filter((each) => each !== id);
        return { ...(file ?? empty()), order: insert(rest, id, index) };
      });
    }
    this.load();
  }

  /** Set the workspace's `order`, or clear it with undefined. */
  async setOrder(ids: readonly string[] | undefined): Promise<void> {
    await this.#workspaceStore().update((file) => {
      const { order: _, ...rest } = file ?? empty();
      return ids === undefined ? rest : { ...rest, order: [...ids] };
    });
    this.load();
  }

  /** Write both scopes from `entries`, in their order: first setup. */
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
      // Everything is validated and built before either file is touched.
      for (const { scope, ...entry } of entries) {
        this.#ready(entry, scope, drafts);
      }
      const of = (scope: ProviderScope) =>
        entries
          .filter((entry) => entry.scope === scope)
          .map(({ scope: _, ...entry }) => entry);
      const edits: [Store, Edit][] = [
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
        // The entries' order replaces any `order` the workspace had.
        const providers = of("workspace");
        edits.push([this.#workspace, () => ({ providers, version: 1 })]);
      }
      await together(edits);
      return true;
    });
  }

  /**
   * First setup: write `entries` as the machine file only if there still is
   * none, checked under its lock, so a file written meanwhile is never
   * replaced. Resolves false when one appeared.
   */
  async initialize(entries: readonly ProviderEntryRecord[]): Promise<boolean> {
    let written = false;
    await this.#commit(async (drafts) => {
      for (const entry of entries) {
        this.#ready(entry, "machine", drafts);
      }
      await this.#machine.update((current) => {
        if (current !== undefined) {
          return;
        }
        for (const entry of entries) {
          this.#refuseTaken(entry.id, "machine");
        }
        written = true;
        return { providers: [...entries], version: 1 };
      });
      return written;
    });
    return written;
  }

  /**
   * Reload whenever either file changes, from this or any other process. A
   * file that cannot be read keeps the last good set and is reported.
   */
  watch(report: (problem: string) => void): () => void {
    const paths = [this.#machine.watched, this.#workspace?.watched].filter(
      (path): path is string => path !== undefined
    );
    const reload = () => {
      try {
        this.load();
      } catch (error) {
        report(error instanceof Error ? error.message : String(error));
      }
    };
    // Polled, not evented: platform file events miss or coalesce changes,
    // and a poll also sees a file replaced by rename.
    for (const path of paths) {
      watchFile(path, { interval: POLL_MS, persistent: false }, reload);
    }
    return () => {
      for (const path of paths) {
        unwatchFile(path, reload);
      }
    };
  }

  #store(scope: ProviderScope): Store {
    return scope === "machine" ? this.#machine : this.#workspaceStore();
  }

  #workspaceStore(): Store {
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
    const scope = this.#scopeOf(id);
    await this.#commit(async (drafts) => {
      await this.#store(scope).update((current) => {
        const file = current ?? empty();
        return {
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
        };
      });
      return true;
    });
  }

  /**
   * Refuse a write that would reuse an id at the other scope, anywhere under
   * the state root. Run under the written file's lock; the other scope's
   * files are read, not locked, and a collision a race still makes leaves
   * both entries unloadable. An unreadable workspace file refuses the write.
   */
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

  /** The workspace under the state root whose own file uses `id`, if any. */
  #takenAt(
    id: string,
    options: { readonly replacing?: boolean }
  ): string | undefined {
    const { state } = this.#options;
    if (
      state === undefined ||
      this.#options.fixed !== undefined ||
      !existsSync(state)
    ) {
      return undefined;
    }
    // `replace` rewrites this workspace's own file too.
    const own = options.replacing ? this.#options.workspace?.dir : undefined;
    for (const dir of readdirSync(state, { withFileTypes: true })) {
      if (!dir.isDirectory() || join(state, dir.name) === own) {
        continue;
      }
      const file = readProvidersFile(join(state, dir.name, FILE));
      if (file?.providers.some((entry) => entry.id === id && entry.enabled)) {
        return dir.name;
      }
    }
    return undefined;
  }

  /** Validate an entry for a write; a failure refuses the write. */
  #check(entry: ProviderEntryRecord, scope: ProviderScope): void {
    const problem = this.#problem(entry, scope);
    if (problem) {
      throw invalid(problem);
    }
  }

  /**
   * Validate an entry for a write, and build an enabled one: one that cannot
   * be built refuses the write. A new instance joins the write's drafts.
   */
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

  /** Why an entry cannot be loaded at `scope`, or undefined. */
  #problem(
    entry: ProviderEntryRecord,
    scope: ProviderScope
  ): string | undefined {
    if (!ID.test(entry.id)) {
      return `"${entry.id}" is not a valid provider id`;
    }
    const plugin = this.#plugins.get(entry.plugin);
    if (!plugin) {
      return `no plugin "${entry.plugin}" is registered`;
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
    let catalog: ReturnType<RegisteredPlugin["catalog"]>;
    try {
      catalog = plugin.catalog(parsed.data);
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

  /** Every entry of both scopes, in effective order where used, built when usable. */
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
    // Only enabled entries claim an id, so disabling one resolves a clash.
    const count = new Map<string, number>();
    for (const { entry } of scoped) {
      if (entry.enabled) {
        count.set(entry.id, (count.get(entry.id) ?? 0) + 1);
      }
    }
    const ids = scoped.map(({ entry }) => entry.id);
    // Once each: a disabled entry repeats its id, and a later copy would move it.
    const order = [...new Set(workspace?.order ?? ids)];
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

  /**
   * The entry's state, and its instance when it can serve: the current one
   * for its key, else one taken out of `drafts`, else one built now.
   */
  #build(
    entry: ProviderEntryRecord,
    scope: ProviderScope,
    report: (state: ProviderEntry["state"], problem?: string) => Built,
    drafts: Drafts
  ): Built {
    const plugin = this.#plugins.get(entry.plugin) as RegisteredPlugin;
    const settings = plugin.settings.parse(entry.settings ?? {});
    const env = this.#envFor(scope);
    const patterns = accountPatterns(plugin, settings);
    const ambient = plugin.ambient
      ? ambientProblem(this.#options.environment, patterns, env)
      : undefined;
    if (ambient) {
      return report("unavailable", ambient);
    }
    const key = JSON.stringify([scope, entry, env]);
    const instance =
      this.#owned.get(key) ??
      take(drafts, key) ??
      this.#instantiate(plugin, entry, scope, settings, env, patterns);
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

  /** A new instance as the manager will serve it, or why the plugin could not build one. */
  #instantiate(
    plugin: RegisteredPlugin,
    entry: ProviderEntryRecord,
    scope: ProviderScope,
    settings: unknown,
    env: Readonly<Record<string, string>>,
    patterns: readonly string[]
  ): ProviderInstance | string {
    let created: ProviderInstance;
    try {
      created = this.#create(plugin, entry, scope, settings, env);
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
    plugin: RegisteredPlugin,
    entry: ProviderEntryRecord,
    scope: ProviderScope,
    settings: unknown,
    env: Readonly<Record<string, string>>
  ): ProviderInstance {
    const models = plugin.catalog(settings);
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
        ? {
            workspace: {
              ...this.#options.workspace,
              env: this.#options.environment.workspace,
            },
          }
        : {}),
    });
  }

  /**
   * A keyed digest: it identifies without revealing, or letting anyone test
   * a guess at, what went in. The key is the state root's; without one (a
   * programmatic host with no state root), or read-only with none yet, it
   * lasts as long as this configuration, so its identities match nothing
   * stored and pinned sessions from elsewhere fail closed.
   */
  #digest(material: unknown): string {
    this.#key ??= identityKey(this.#options.state, this.#options.readOnly);
    return createHmac("sha256", this.#key)
      .update(JSON.stringify(material))
      .digest("hex")
      .slice(0, 32);
  }

  /** Machine scope sees the machine environment; workspace scope, it overlaid by the workspace's values. */
  #envFor(scope: ProviderScope): Readonly<Record<string, string>> {
    const { machine, workspace } = this.#options.environment;
    return scope === "machine" ? machine : { ...machine, ...workspace };
  }

  /** A secret field shows the variable it names, or `<redacted>` when it holds anything else. */
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

/** The draft for `key`, taken out of `drafts` so only one owner keeps it. */
function take(drafts: Drafts, key: string): ProviderInstance | undefined {
  const draft = drafts.get(key);
  drafts.delete(key);
  return draft;
}
