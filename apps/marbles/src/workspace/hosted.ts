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

export interface StagedWorkspaces {
  abandon(): Promise<void>;
  readonly loads: readonly WorkspaceLoad[];
  start(): Promise<readonly WorkspaceLoad[]>;
}

export interface HostedWorkspacesOptions {
  readonly artifacts: string;
  readonly askable?: boolean;
  readonly dry?: boolean;
  readonly env?: "require" | "warn";
  readonly prepare?: (engine: Engine) => void;
  readonly print?: (root: string, line: string) => void;
  readonly read?: (root: string, file: string) => void;
  readonly spawned?: string;
  readonly state: string;
}

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
      const found = findWorkspace(args);
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

  async #stage(
    registration: WorkspaceRegistration,
    { args, found, root }: Found
  ): Promise<StagedWorkspace> {
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
      return await stageWorkspace({
        artifacts: args.artifacts,
        ...(this.#options.askable === undefined
          ? {}
          : { askable: this.#options.askable }),
        ...(registration.cwd === undefined ? {} : { cwd: registration.cwd }),
        ...(this.#database === undefined ? {} : { database: this.#database }),
        ...(this.#options.env === undefined ? {} : { env: this.#options.env }),
        directory: root,
        dry: args.dry,
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
    } catch (error) {
      throw new WorkspaceLoadError(root, { cause: error });
    }
  }

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
    if (this.#closed()) {
      await host.close();
      throw new WorkspaceLoadError(root, {
        cause: new Error("these hosted workspaces closed while it loaded"),
      });
    }
    this.#hosts.set(host.id, host);
    return host;
  }

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

  async #registered(): Promise<readonly WorkspaceRegistration[]> {
    const database = this.#database;
    if (database === undefined) {
      return [];
    }
    const records = await new WorkspaceRegistry({
      database: database.database,
      state: this.#options.state,
    }).list();
    return records.filter((record) => record.hosted);
  }

  #closed(): boolean {
    return this.#phase === "closed";
  }

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

  async loadRegistered(): Promise<readonly WorkspaceLoad[]> {
    return await this.load(await this.#registered());
  }

  async unregister(id: string): Promise<boolean> {
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
