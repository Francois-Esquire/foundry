import { join, resolve } from "node:path";
import { inspect } from "node:util";

import { refuseUnnamedWork } from "~/authoring/runtime";
import type { MarblesDatabase } from "~/database/open";
import { openHostDatabase, WorkspaceRegistry } from "~/database/workspaces";
import type { Engine } from "~/lib/engine";
import type { RollResult } from "~/model/connection";
import type { StagedWorkspace, WorkspaceHost } from "~/workspace/host";
import { stageWorkspace } from "~/workspace/host";
import { findWorkspace } from "~/workspace/open";
import { DEFAULT_SOURCE } from "~/workspace/source";

/**
 * Every workspace one process hosts, side by side: each registered with
 * its root, its source and where its work starts, loaded into a catalog
 * and an engine of its own, with its own environment, and all of them
 * over one handle on the Marbles database. What each declares is
 * addressed by its workspace and its local name, so two workspaces may
 * use the same one. A workspace that fails to load is reported on its
 * own, and leaves every other one as it was.
 *
 * An engine generation of the Marbles process is one of these: it loads
 * every registered workspace up to engines not yet started
 * (`stageRegistered`), and starts them all once it is to take over.
 */

/** What a workspace registers: enough, with nothing else, to load it again. */
export interface WorkspaceRegistration {
  /** The authoring source; null when the workspace is its root alone. */
  readonly config: string | null;
  /** Where its runs start and its commands run; its root when omitted. */
  readonly cwd?: string;
  /** The checkout the workspace is. */
  readonly root: string;
}

/** A name a workspace declared, with the workspace that declared it. */
export interface QualifiedName {
  readonly name: string;
  /** The workspace's id. */
  readonly workspace: string;
}

/** How one registration's load went. */
export type WorkspaceLoad =
  | {
      /** Every file its source's load read. */
      readonly files: readonly string[];
      readonly id: string;
      readonly loaded: true;
      readonly root: string;
    }
  | {
      readonly error: WorkspaceLoadError;
      readonly loaded: false;
      readonly root: string;
    };

/** A registered workspace that did not load, named by its root. */
export class WorkspaceLoadError extends Error {
  override readonly name = "WorkspaceLoadError";
  readonly root: string;

  constructor(root: string, { cause }: { readonly cause: unknown }) {
    super(
      `the workspace at ${root} did not load: ${cause instanceof Error ? cause.message : inspect(cause)}`,
      { cause }
    );
    this.root = root;
  }
}

/**
 * Every registered workspace loaded up to an engine not yet started, and
 * how each load went. `start` starts them all and hosts them; `abandon`
 * drops them unstarted. Either, once.
 */
export interface StagedWorkspaces {
  abandon(): Promise<void>;
  readonly loads: readonly WorkspaceLoad[];
  /** Start every staged engine; each is reported, hosted or with why its start failed. */
  start(): Promise<readonly WorkspaceLoad[]>;
}

export interface HostedWorkspacesOptions {
  /** The shared artifact store. */
  readonly artifacts: string;
  /** Whether something here can answer `ask`, so parked runs are taken on. */
  readonly askable?: boolean;
  /** Echo every model turn and git mutation, and persist nothing. */
  readonly dry?: boolean;
  /** What a `.env.schema` that does not resolve does; `warn` when omitted. */
  readonly env?: "require" | "warn";
  /** Runs on each built engine before it starts: host steps beside its source. */
  readonly prepare?: (engine: Engine) => void;
  /** Each workspace's status lines, with the root it was registered at. */
  readonly print?: (root: string, line: string) => void;
  /** Each file a workspace's load reads, as it loads and as its runs import more, with its root. */
  readonly read?: (root: string, file: string) => void;
  /**
   * Where this process's children are recorded for recovery
   * (`MARBLES_SPAWN_RECOVERY`), shared by every workspace hosted here:
   * each engine's start stops what a process that is gone left running,
   * never what one of the others, alive in this process, started.
   */
  readonly spawned?: string;
  /** The Marbles state root. */
  readonly state: string;
}

/** A registration found on disk, with the arguments its load takes. */
interface Found {
  readonly args: {
    readonly artifacts: string;
    readonly config: string;
    readonly directory: string;
    readonly dry: boolean;
    readonly state: string;
  };
  readonly found: ReturnType<typeof findWorkspace>;
  readonly root: string;
}

export class HostedWorkspaces {
  readonly #database: MarblesDatabase | undefined;
  readonly #hosts = new Map<string, WorkspaceHost>();
  /** Registrations under way, by workspace id: a second one for the same workspace shares the first. */
  readonly #pending = new Map<string, Promise<WorkspaceHost>>();
  readonly #options: HostedWorkspacesOptions;
  /**
   * Work under way that still writes through the shared handle once its
   * host has left `#hosts`: a host closing, and an unregister finishing.
   * The database closes only after every one of them has settled.
   */
  readonly #inFlight = new Set<Promise<unknown>>();
  #phase: "open" | "closed" = "open";
  /** The one shutdown every `close` shares. */
  #closing: Promise<void> | undefined;

  private constructor(
    options: HostedWorkspacesOptions,
    database: MarblesDatabase | undefined
  ) {
    this.#options = options;
    this.#database = database;
  }

  /** One host for many workspaces, over one handle on the database; none under `dry`. */
  static async open(
    options: HostedWorkspacesOptions
  ): Promise<HostedWorkspaces> {
    const database = options.dry
      ? undefined
      : await openHostDatabase(options.state);
    // With several workspaces here, work that names none is refused: the
    // last one left must never answer for one that closed.
    refuseUnnamedWork();
    return new HostedWorkspaces(options, database);
  }

  /**
   * Register `registration` with the Marbles process (`hosted` in the
   * registry, so `loadRegistered` loads it again), load it and host it:
   * the host already holding its workspace, or the registration already
   * under way for it, when there is one. Throws `WorkspaceLoadError` when it
   * does not load, and then nothing it declared is kept; it stays
   * registered, so the next `loadRegistered` reports it again.
   */
  register(registration: WorkspaceRegistration): Promise<WorkspaceHost> {
    let found: Found;
    try {
      found = this.#find(registration);
    } catch (error) {
      return Promise.reject(error);
    }
    const { id } = found.found.workspace;
    const hosting = this.#hosts.get(id);
    if (hosting !== undefined) {
      return Promise.resolve(hosting);
    }
    const pending = this.#pending.get(id);
    if (pending !== undefined) {
      return pending;
    }
    const registering = this.#stage(registration, found)
      .then((staged) => this.#start(staged, found.root))
      .finally(() => {
        this.#pending.delete(id);
      });
    this.#pending.set(id, registering);
    return registering;
  }

  /** Where `registration` is and what it is, or the `WorkspaceLoadError` it fails with. */
  #find(registration: WorkspaceRegistration): Found {
    const root = resolve(registration.root);
    const source = registration.config ?? join(root, DEFAULT_SOURCE);
    const args = {
      artifacts: this.#options.artifacts,
      config: source,
      directory: root,
      dry: this.#options.dry ?? false,
      state: this.#options.state,
    };
    try {
      if (this.#phase === "closed") {
        throw new Error("these hosted workspaces are closed");
      }
      // Placed before anything is awaited: a second load of a workspace
      // hosted here would take its catalog and its tasks from the first.
      const found = findWorkspace(args);
      // Only a registration made without a source is its root alone: one
      // whose source is gone does not load.
      if (registration.config !== null && found.config === null) {
        throw new Error(
          `its registered source ${found.configPath} is gone; restore it, or unregister the workspace`
        );
      }
      return { args, found, root };
    } catch (error) {
      throw new WorkspaceLoadError(root, { cause: error });
    }
  }

  /** Record the registration and load it up to an engine not yet started. */
  async #stage(
    registration: WorkspaceRegistration,
    { args, found, root }: Found
  ): Promise<StagedWorkspace> {
    let host: WorkspaceHost | undefined;
    try {
      if (this.#database !== undefined) {
        await new WorkspaceRegistry({
          database: this.#database.database,
          state: args.state,
        }).touch(found.workspace, found.config, {
          ...(registration.cwd === undefined ? {} : { cwd: registration.cwd }),
          hosted: true,
        });
      }
      const staged = await stageWorkspace({
        artifacts: args.artifacts,
        ...(this.#options.askable === undefined
          ? {}
          : { askable: this.#options.askable }),
        ...(registration.cwd === undefined ? {} : { cwd: registration.cwd }),
        ...(this.#database === undefined ? {} : { database: this.#database }),
        ...(this.#options.env === undefined ? {} : { env: this.#options.env }),
        directory: root,
        dry: args.dry,
        onClose: (closing) => {
          if (host !== undefined && this.#hosts.get(host.id) === host) {
            this.#hosts.delete(host.id);
          }
          this.#track(closing);
        },
        ...(this.#options.prepare === undefined
          ? {}
          : { prepare: this.#options.prepare }),
        print: (line) => this.#options.print?.(root, line),
        read: (file) => this.#options.read?.(root, file),
        source: found.configPath,
        ...(this.#options.spawned === undefined
          ? {}
          : { spawned: this.#options.spawned }),
        state: args.state,
      });
      return {
        ...staged,
        start: async () => {
          host = await staged.start();
          return host;
        },
      };
    } catch (error) {
      throw new WorkspaceLoadError(root, { cause: error });
    }
  }

  /** Start a staged workspace and host it here. */
  async #start(staged: StagedWorkspace, root: string): Promise<WorkspaceHost> {
    if (this.#phase === "closed") {
      await staged.abandon();
      throw new WorkspaceLoadError(root, {
        cause: new Error("these hosted workspaces closed while it loaded"),
      });
    }
    let host: WorkspaceHost;
    try {
      host = await staged.start();
    } catch (error) {
      throw new WorkspaceLoadError(root, { cause: error });
    }
    // A close may have begun while the engine started.
    if (this.#closed()) {
      await host.close();
      throw new WorkspaceLoadError(root, {
        cause: new Error("these hosted workspaces closed while it loaded"),
      });
    }
    this.#hosts.set(host.id, host);
    return host;
  }

  /**
   * Load every workspace registered with the Marbles process, as
   * `loadRegistered` does, but stop short of starting their engines: a
   * workspace taken on here takes over its parked and queued work only
   * once `start` runs. Under `dry` nothing is read, and none is staged.
   */
  async stageRegistered(): Promise<StagedWorkspaces> {
    const staged: {
      readonly root: string;
      readonly staged: StagedWorkspace;
    }[] = [];
    const loads: WorkspaceLoad[] = [];
    for (const registration of await this.#registered()) {
      try {
        const found = this.#find(registration);
        const workspace = await this.#stage(registration, found);
        staged.push({ root: found.root, staged: workspace });
        loads.push({
          files: workspace.files,
          id: workspace.id,
          loaded: true,
          root: found.root,
        });
      } catch (error) {
        if (!(error instanceof WorkspaceLoadError)) {
          await Promise.allSettled(staged.map((each) => each.staged.abandon()));
          throw error;
        }
        loads.push({ error, loaded: false, root: error.root });
      }
    }
    let used = false;
    const once = (): void => {
      if (used) {
        throw new Error(
          "these staged workspaces were started or abandoned already"
        );
      }
      used = true;
    };
    return {
      abandon: async () => {
        once();
        await Promise.allSettled(staged.map((each) => each.staged.abandon()));
      },
      loads,
      start: async () => {
        once();
        const started: WorkspaceLoad[] = [];
        for (const each of staged) {
          try {
            const host = await this.#start(each.staged, each.root);
            started.push({
              files: host.files,
              id: host.id,
              loaded: true,
              root: host.root,
            });
          } catch (error) {
            if (!(error instanceof WorkspaceLoadError)) {
              throw error;
            }
            started.push({ error, loaded: false, root: error.root });
          }
        }
        return started;
      },
    };
  }

  /** Every registration the registry says is hosted; none under `dry`. */
  async #registered(): Promise<readonly WorkspaceRegistration[]> {
    const database = this.#database;
    if (database === undefined) {
      return [];
    }
    if (this.#phase === "closed") {
      throw new Error("these hosted workspaces are closed");
    }
    const records = await this.#track(
      new WorkspaceRegistry({
        database: database.database,
        state: this.#options.state,
      }).list()
    );
    return records.filter((record) => record.hosted);
  }

  #closed(): boolean {
    return this.#phase === "closed";
  }

  /** Load each registration in turn; each is reported, loaded or not. */
  async load(
    registrations: readonly WorkspaceRegistration[]
  ): Promise<readonly WorkspaceLoad[]> {
    const loads: WorkspaceLoad[] = [];
    for (const registration of registrations) {
      try {
        const { files, id, root } = await this.register(registration);
        loads.push({ files, id, loaded: true, root });
      } catch (error) {
        if (!(error instanceof WorkspaceLoadError)) {
          throw error;
        }
        loads.push({ error, loaded: false, root: error.root });
      }
    }
    return loads;
  }

  /**
   * Load every workspace registered with the Marbles process (`hosted` in
   * the registry: registered here or attached, and not detached since),
   * and report each one, loaded or with the `WorkspaceLoadError` it failed
   * with. Under `dry` nothing is read, and none is.
   */
  async loadRegistered(): Promise<readonly WorkspaceLoad[]> {
    return await this.load(await this.#registered());
  }

  /**
   * Drop workspace `id`'s registration with the Marbles process, so no
   * later `loadRegistered` loads it, and stop it here if it is hosted. Its
   * stored state stays. Whether it was registered.
   */
  unregister(id: string): Promise<boolean> {
    if (this.#phase === "closed") {
      return Promise.reject(new Error("these hosted workspaces are closed"));
    }
    return this.#track(this.#unregister(id));
  }

  async #unregister(id: string): Promise<boolean> {
    const pending = this.#pending.get(id);
    if (pending !== undefined) {
      await pending.catch(() => undefined);
    }
    const host = this.#hosts.get(id);
    this.#hosts.delete(id);
    await host?.close();
    if (this.#database === undefined) {
      return host !== undefined;
    }
    return await new WorkspaceRegistry({
      database: this.#database.database,
      state: this.#options.state,
    }).unhost(id);
  }

  /** `work`, kept in flight until it settles, so the database outlives it. */
  #track<T>(work: Promise<T>): Promise<T> {
    this.#inFlight.add(work);
    const settled = () => {
      this.#inFlight.delete(work);
    };
    work.then(settled, settled);
    return work;
  }

  /** The host of workspace `id`; throws when none here holds it. */
  get(id: string): WorkspaceHost {
    const host = this.#hosts.get(id);
    if (host === undefined) {
      throw new Error(`no workspace "${id}" is hosted here`);
    }
    return host;
  }

  /** Every workspace hosted here, in the order each was registered. */
  list(): readonly WorkspaceHost[] {
    return [...this.#hosts.values()];
  }

  /** Every definition each workspace declared, by its workspace and name. */
  definitions(): readonly QualifiedName[] {
    return this.list().flatMap((host) =>
      host.engine
        .definitions()
        .map(({ name }) => ({ name, workspace: host.id }))
    );
  }

  /**
   * Every trigger each workspace has, declared or agent-made, by its
   * workspace and key: each schedule, and each monitor's tick.
   */
  async triggers(): Promise<readonly QualifiedName[]> {
    const triggers = await Promise.all(
      this.list().map(async (host) =>
        (await host.engine.schedules()).map(({ key }) => ({
          name: key,
          workspace: host.id,
        }))
      )
    );
    return triggers.flat();
  }

  /**
   * Fire `target` in its workspace as `marbles roll` does: a schedule or
   * monitor by its key, ticked once with the input it carries unless one is
   * given, else a definition by its name. Resolves with what it returned
   * and the lines it printed.
   */
  roll(target: QualifiedName, input?: unknown): Promise<RollResult> {
    return this.get(target.workspace).roll(target.name, input);
  }

  /** Run `target`'s definition in its workspace, and wait for its result. */
  run<O = unknown>(target: QualifiedName, input?: unknown): Promise<O> {
    return this.get(target.workspace).engine.run<O>(target.name, input);
  }

  /**
   * Stop every workspace, cancelling live runs, then close the database: a
   * registration still under way is closed as soon as it loads. Every
   * workspace finishes closing, its last writes through the shared handle
   * included, before the database closes, whichever of them failed, and
   * so does every host an unregister was closing; then each failure,
   * the database's own included, is reported together. Closing again, or
   * meanwhile, shares that one shutdown.
   */
  close(): Promise<void> {
    this.#closing ??= this.#shutDown();
    return this.#closing;
  }

  async #shutDown(): Promise<void> {
    this.#phase = "closed";
    await Promise.allSettled([...this.#pending.values()]);
    const hosts = this.list();
    this.#hosts.clear();
    const closed = await Promise.allSettled(hosts.map((host) => host.close()));
    // An unregister reports its own failure; here it is only waited for.
    while (this.#inFlight.size > 0) {
      await Promise.allSettled([...this.#inFlight]);
    }
    const errors = closed.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    try {
      this.#database?.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to close every workspace");
    }
  }
}
