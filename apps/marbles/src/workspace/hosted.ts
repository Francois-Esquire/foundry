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

export interface WorkspaceRegistration {
  readonly config: string | null;
  readonly cwd?: string;
  readonly root: string;
}

export interface QualifiedName {
  readonly name: string;
  readonly workspace: string;
}

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
  readonly artifacts: string;
  readonly dry?: boolean;
  readonly env?: "require" | "warn";
  readonly print?: (root: string, line: string) => void;
  readonly state: string;
}

export class HostedWorkspaces {
  readonly #database: MarblesDatabase | undefined;
  readonly #hosts = new Map<string, WorkspaceHost>();
  readonly #pending = new Map<string, Promise<WorkspaceHost>>();
  readonly #unregistering = new Map<string, Promise<boolean>>();
  readonly #options: HostedWorkspacesOptions;
  readonly #inFlight = new Set<Promise<unknown>>();
  #phase: "open" | "closed" = "open";
  #closing: Promise<void> | undefined;

  private constructor(
    options: HostedWorkspacesOptions,
    database: MarblesDatabase | undefined
  ) {
    this.#options = options;
    this.#database = database;
  }

  static async open(
    options: HostedWorkspacesOptions
  ): Promise<HostedWorkspaces> {
    const database = options.dry
      ? undefined
      : await openHostDatabase(options.state);
    refuseUnnamedWork();
    return new HostedWorkspaces(options, database);
  }

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
      found = findWorkspace(args);
      if (registration.config !== null && found.config === null) {
        throw new Error(
          `its registered source ${found.configPath} is gone; restore it, or unregister the workspace`
        );
      }
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
    const registering = this.#afterUnregister(id)
      .then(() => this.#host(registration, found, args))
      .finally(() => {
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
      host = await hostWorkspace({
        artifacts: args.artifacts,
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

  async loadRegistered(): Promise<readonly WorkspaceLoad[]> {
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
    return await this.load(records.filter((record) => record.hosted));
  }

  unregister(id: string): Promise<boolean> {
    if (this.#phase === "closed") {
      return Promise.reject(new Error("these hosted workspaces are closed"));
    }
    const underway = this.#unregistering.get(id);
    if (underway !== undefined && !this.#pending.has(id)) {
      return underway;
    }
    const unregistering = this.#track(this.#unregister(id));
    this.#unregistering.set(id, unregistering);
    const forget = () => {
      if (this.#unregistering.get(id) === unregistering) {
        this.#unregistering.delete(id);
      }
    };
    unregistering.then(forget, forget);
    return unregistering;
  }

  async #afterUnregister(id: string): Promise<void> {
    await this.#unregistering.get(id)?.catch(() => undefined);
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

  #track<T>(work: Promise<T>): Promise<T> {
    this.#inFlight.add(work);
    const settled = () => {
      this.#inFlight.delete(work);
    };
    work.then(settled, settled);
    return work;
  }

  get(id: string): WorkspaceHost {
    const host = this.#hosts.get(id);
    if (host === undefined) {
      throw new Error(`no workspace "${id}" is hosted here`);
    }
    return host;
  }

  list(): readonly WorkspaceHost[] {
    return [...this.#hosts.values()];
  }

  definitions(): readonly QualifiedName[] {
    return this.list().flatMap((host) =>
      host.engine
        .definitions()
        .map(({ name }) => ({ name, workspace: host.id }))
    );
  }

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

  roll(target: QualifiedName, input?: unknown): Promise<RollResult> {
    return this.get(target.workspace).roll(target.name, input);
  }

  run<O = unknown>(target: QualifiedName, input?: unknown): Promise<O> {
    return this.get(target.workspace).engine.run<O>(target.name, input);
  }

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
