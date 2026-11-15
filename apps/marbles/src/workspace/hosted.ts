import { join, resolve } from "node:path";
import { inspect } from "node:util";

import { refuseUnnamedWork } from "~/authoring/runtime";
import type { MarblesDatabase } from "~/database/open";
import { openHostDatabase, WorkspaceRegistry } from "~/database/workspaces";
import type { RollResult } from "~/model/connection";
import type { WorkspaceHost } from "~/workspace/host";
import { hostWorkspace } from "~/workspace/host";
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
 * The Marbles process still hosts each workspace in a worker of its own;
 * this is what one process holding all of them is built on.
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

export interface HostedWorkspacesOptions {
  /** The shared artifact store. */
  readonly artifacts: string;
  /** Echo every model turn and git mutation, and persist nothing. */
  readonly dry?: boolean;
  /** What a `.env.schema` that does not resolve does; `warn` when omitted. */
  readonly env?: "require" | "warn";
  /** Each workspace's status lines, with the root it was registered at. */
  readonly print?: (root: string, line: string) => void;
  /** The Marbles state root. */
  readonly state: string;
}

export class HostedWorkspaces {
  readonly #database: MarblesDatabase | undefined;
  readonly #hosts = new Map<string, WorkspaceHost>();
  /** Registrations under way, by workspace id: a second one for the same workspace shares the first. */
  readonly #pending = new Map<string, Promise<WorkspaceHost>>();
  readonly #options: HostedWorkspacesOptions;
  #phase: "open" | "closed" = "open";

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
    const root = resolve(registration.root);
    const source = registration.config ?? join(root, DEFAULT_SOURCE);
    const args = {
      artifacts: this.#options.artifacts,
      config: source,
      directory: root,
      dry: this.#options.dry ?? false,
      state: this.#options.state,
    };
    let found: ReturnType<typeof findWorkspace>;
    try {
      if (this.#phase === "closed") {
        throw new Error("these hosted workspaces are closed");
      }
      // Placed before anything is awaited: a second load of a workspace
      // hosted here would take its catalog and its tasks from the first.
      found = findWorkspace(args);
    } catch (error) {
      return Promise.reject(new WorkspaceLoadError(root, { cause: error }));
    }
    const { id } = found.workspace;
    const hosting = this.#hosts.get(id);
    if (hosting !== undefined) {
      return Promise.resolve(hosting);
    }
    const pending = this.#pending.get(id);
    if (pending !== undefined) {
      return pending;
    }
    const registering = this.#host(registration, found, args).finally(() => {
      this.#pending.delete(id);
    });
    this.#pending.set(id, registering);
    return registering;
  }

  async #host(
    registration: WorkspaceRegistration,
    found: ReturnType<typeof findWorkspace>,
    args: {
      readonly artifacts: string;
      readonly directory: string;
      readonly dry: boolean;
      readonly state: string;
    }
  ): Promise<WorkspaceHost> {
    const root = args.directory;
    let host: WorkspaceHost;
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
      host = await hostWorkspace({
        artifacts: args.artifacts,
        ...(registration.cwd === undefined ? {} : { cwd: registration.cwd }),
        ...(this.#database === undefined ? {} : { database: this.#database }),
        ...(this.#options.env === undefined ? {} : { env: this.#options.env }),
        directory: root,
        dry: args.dry,
        print: (line) => this.#options.print?.(root, line),
        source: found.configPath,
        state: args.state,
      });
    } catch (error) {
      throw new WorkspaceLoadError(root, { cause: error });
    }
    if (this.#phase === "closed") {
      await host.close();
      throw new WorkspaceLoadError(root, {
        cause: new Error("these hosted workspaces closed while it loaded"),
      });
    }
    this.#hosts.set(host.id, host);
    return host;
  }

  /** Load each registration in turn; each is reported, loaded or not. */
  async load(
    registrations: readonly WorkspaceRegistration[]
  ): Promise<readonly WorkspaceLoad[]> {
    const loads: WorkspaceLoad[] = [];
    for (const registration of registrations) {
      try {
        const { id, root } = await this.register(registration);
        loads.push({ id, loaded: true, root });
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
    const database = this.#database;
    if (database === undefined) {
      return [];
    }
    const records = await new WorkspaceRegistry({
      database: database.database,
      state: this.#options.state,
    }).list();
    return await this.load(records.filter((record) => record.hosted));
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
   * registration still under way is closed as soon as it loads.
   */
  async close(): Promise<void> {
    this.#phase = "closed";
    await Promise.allSettled([...this.#pending.values()]);
    const hosts = this.list();
    this.#hosts.clear();
    try {
      await Promise.all(hosts.map((host) => host.close()));
    } finally {
      this.#database?.close();
    }
  }
}
