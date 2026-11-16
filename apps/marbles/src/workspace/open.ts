import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Tasks } from "@foundry/tasks";
import { plugin } from "bun";
import { libraryOfLoad, prebuiltOfLoad } from "~/authoring/bound";
import { Catalog } from "~/authoring/catalog";
import { expectHost, loadInto, setHost } from "~/authoring/runtime";
import { initializeUsage } from "~/authoring/usage";
import type { Triggers } from "~/create";
import { createEngine, readTriggers } from "~/create";
import type { MarblesDatabase } from "~/database/open";
import { readDatabase } from "~/database/open";
import { WorkspaceRegistry } from "~/database/workspaces";
import { stateDatabase } from "~/layout";
import type { Engine } from "~/lib/engine";
import { environmentSnapshot } from "~/lib/environment";
import type { LogLevel, LogOrigin } from "~/lib/log";
import type { Workspace } from "~/lib/state/workspace";
import { workspaceAt, workspaceState } from "~/lib/state/workspace";
import {
  copyModules,
  filesRead,
  importLoad,
  linkLibrary,
  onRead,
} from "~/workspace/copies";
import type { WorkspaceEnvironment } from "~/workspace/env";
import { loadEnvironment } from "~/workspace/env";
import {
  DEFAULT_SOURCE,
  resolveSource,
  sourceFiles,
  sourceRoot,
} from "~/workspace/source";

/**
 * Marbles as a host of the engine: find the authoring source, load it, place
 * the workspace under the state root, and build the engine or read its
 * triggers. The CLI and the dashboard both start here, so each of those is
 * decided once.
 */

export interface HostOptions {
  readonly artifacts: string;
  readonly config: string;
  readonly directory?: string;
  readonly dry: boolean;
  readonly spawned?: string;
  readonly state: string;
}

export interface OpenedWorkspace {
  readonly catalog: Catalog;
  readonly config: string | null;
  /** Where the authoring source is, or would be created. */
  readonly configPath: string;
  readonly cwd: string;
  readonly environment: WorkspaceEnvironment;
  readonly files: readonly string[];
  readonly workspace: Workspace;
}

const libraryUrl = (name: "index" | "prebuilt"): string =>
  new URL(
    import.meta.url.endsWith(".ts")
      ? `../authoring/${name}.ts`
      : `./${name}.js`,
    import.meta.url
  ).href;

let sourceLibrary: Promise<void> | undefined;

function linkSourceLibrary(): Promise<void> {
  sourceLibrary ??= (async () => {
    // The paths are relative to this file: `src/workspace/` in source, and
    // `dist/` (this file's chunk sits beside the entries) once built.
    const library = await import(fileURLToPath(libraryUrl("index")));
    const prebuilt = await import(libraryUrl("prebuilt"));
    plugin({
      name: "marbles-source-library",
      setup(builder) {
        copyModules(builder);
        builder.module("@foundry.sh/marbles/prebuilt", () => ({
          exports: prebuilt,
          loader: "object",
        }));
        builder.module("@foundry.sh/marbles", () => ({
          exports: library,
          loader: "object",
        }));
      },
      target: "bun",
    });
    linkLibrary("@foundry.sh/marbles", (load) => libraryOfLoad(library, load));
    linkLibrary("@foundry.sh/marbles/prebuilt", (load) =>
      prebuiltOfLoad(prebuilt, load)
    );
  })();
  return sourceLibrary;
}

async function loadSource(
  configPath: string,
  {
    catalog,
    dry,
    read,
    workspaceId,
  }: {
    catalog: Catalog;
    dry: boolean;
    read?: (file: string) => void;
    workspaceId: string;
  },
  print: (line: string) => void
): Promise<readonly string[] | false> {
  // From here the builtin `tasks` wait for this workspace's engine, rather
  // than take a write the workspace would never see.
  expectHost();
  const files = sourceFiles(configPath);
  if (files === undefined) {
    return false;
  }
  await linkSourceLibrary();
  let loaded: readonly string[] = [];
  await loadInto(
    workspaceId,
    catalog,
    async (load) => {
      const reading = read === undefined ? undefined : onRead(load, read);
      try {
        await importLoad(sourceRoot(configPath), files, load);
      } catch (error) {
        reading?.forget();
        throw error;
      } finally {
        loaded = filesRead(load);
      }
    },
    { dry }
  );
  print(`[source] ${configPath}`);
  return loaded;
}

function placed(args: HostOptions): {
  readonly configPath: string;
  readonly found: boolean;
  readonly root: string;
} {
  const { config, directory } = args;
  if (directory === undefined && !isAbsolute(config)) {
    throw new Error(
      `the source "${config}" is relative; give the directory it is relative to`
    );
  }
  const configPath = resolveSource(config, directory ?? dirname(config));
  const found = sourceFiles(configPath) !== undefined;
  const root = found ? sourceRoot(configPath) : directory;
  if (root === undefined) {
    throw new Error(
      `nothing is at ${configPath}; give the directory to register as the workspace's root instead`
    );
  }
  return { configPath, found, root };
}

function opened(
  args: HostOptions,
  { configPath, found, root }: ReturnType<typeof placed>,
  environment: WorkspaceEnvironment,
  {
    catalog = new Catalog(),
    cwd,
    files = [],
  }: {
    catalog?: Catalog;
    cwd?: string;
    files?: readonly string[];
  } = {}
): OpenedWorkspace {
  const workspace = workspaceState(resolve(args.state), root);
  return {
    catalog,
    config: found ? configPath : null,
    configPath,
    cwd: cwd ?? workspace.root,
    environment,
    files,
    workspace,
  };
}

/** The workspace the source names, found without executing anything. */
export function findWorkspace(args: HostOptions): OpenedWorkspace {
  return opened(args, placed(args), {
    machine: environmentSnapshot(),
    workspace: {},
  });
}

export async function recordedWorkspace(
  args: Pick<HostOptions, "state">,
  id: string
): Promise<OpenedWorkspace | undefined> {
  const state = resolve(args.state);
  const record = await readDatabase(stateDatabase(state), (database) =>
    new WorkspaceRegistry({ database, state }).read(id)
  );
  if (record === undefined) {
    return;
  }
  const workspace = workspaceAt(state, id, record.root);
  return {
    catalog: new Catalog(),
    config: record.config,
    configPath: record.config ?? resolve(workspace.root, DEFAULT_SOURCE),
    cwd: record.cwd,
    environment: { machine: environmentSnapshot(), workspace: {} },
    files: [],
    workspace,
  };
}

export interface OpenWorkspaceOptions {
  readonly cwd?: string;
  /**
   * What a workspace `.env.schema` that does not resolve does: fail, for
   * work about to run, or print and go on. `warn` when omitted.
   */
  readonly env?: "require" | "warn";
  readonly onMissing?: (configPath: string) => Promise<boolean>;
  readonly print: (line: string) => void;
  readonly read?: (file: string) => void;
}

class StarterLoadError extends Error {
  override readonly name = "StarterLoadError";
}

export async function openWorkspace(
  args: HostOptions,
  { cwd, env = "warn", onMissing, print, read }: OpenWorkspaceOptions
): Promise<OpenedWorkspace> {
  const before = placed(args);
  const environment = loadEnvironment(before.root, env, print);
  const catalog = new Catalog();
  const load = (at: ReturnType<typeof placed>) =>
    loadSource(
      at.configPath,
      {
        catalog,
        dry: args.dry,
        ...(read === undefined ? {} : { read }),
        workspaceId: workspaceState(resolve(args.state), at.root).id,
      },
      print
    );
  const files = await load(before);
  if (files !== false) {
    return opened(args, before, environment, { catalog, cwd, files });
  }
  if (
    args.dry ||
    onMissing === undefined ||
    !(await onMissing(before.configPath))
  ) {
    return opened(args, before, environment, { catalog, cwd });
  }
  const created = placed(args);
  let createdFiles: readonly string[] | false;
  try {
    createdFiles = await load(created);
  } catch (error) {
    throw new StarterLoadError(
      `Starter was created but could not load: ${String(error)}. Fix it and restart Marbles.`,
      { cause: error }
    );
  }
  return opened(args, created, environment, {
    catalog,
    cwd,
    files: createdFiles === false ? [] : createdFiles,
  });
}

interface WorkspaceEngineOptions {
  readonly askable?: boolean;
  readonly database?: MarblesDatabase;
  /** Definitions' own `log(...)` lines; to `print` when omitted. */
  readonly log?: (level: LogLevel, message: string, origin: LogOrigin) => void;
  readonly print: (line: string) => void;
}

/**
 * The engine for an opened workspace, as the flags ask for it. Not yet
 * started, but `usage` has its default accounts, so no step it runs sees
 * them missing.
 */
export async function hostEngine(
  args: HostOptions,
  workspace: OpenedWorkspace,
  options: WorkspaceEngineOptions
): Promise<Engine> {
  await initializeUsage(options.print);
  const engine = workspaceEngine(args, workspace, options);
  // Definitions called outside a run use the host's models, stores, and
  // dry-run echo; disposing the engine clears it.
  setHost(engine, workspace.catalog);
  return engine;
}

function workspaceEngine(
  args: HostOptions,
  { catalog, cwd, environment, workspace }: OpenedWorkspace,
  options: WorkspaceEngineOptions
): Engine {
  const { database } = options;
  return createEngine({
    artifacts: resolve(args.artifacts),
    askable: options.askable,
    catalog,
    cwd,
    dry: args.dry,
    environment,
    ...(options.log ? { log: options.log } : {}),
    print: options.print,
    ...(database === undefined
      ? {}
      : { database: database.database, databaseFile: database.file }),
    root: workspace.root,
    ...(args.spawned === undefined ? {} : { spawned: args.spawned }),
    stateDir: workspace.dir,
    stateRoot: resolve(args.state),
    workspaceId: workspace.id,
  });
}

/** What an engine over this workspace would trigger, read without building one. */
export function hostTriggers(
  args: HostOptions,
  { catalog, workspace }: OpenedWorkspace
): Triggers {
  return readTriggers(catalog, {
    dry: args.dry,
    stateRoot: resolve(args.state),
    workspaceId: workspace.id,
  });
}

export async function touchWorkspace(
  database: MarblesDatabase | undefined,
  args: Pick<HostOptions, "state">,
  { config, workspace }: OpenedWorkspace,
  registers: { readonly cwd?: string } = {}
): Promise<void> {
  if (database !== undefined) {
    await new WorkspaceRegistry({
      database: database.database,
      state: args.state,
    }).touch(workspace, config, registers);
  }
}

export async function asRegistered(
  database: MarblesDatabase | undefined,
  args: Pick<HostOptions, "state">,
  workspace: OpenedWorkspace,
  cwd: string | undefined
): Promise<OpenedWorkspace> {
  if (cwd !== undefined || database === undefined) {
    return workspace;
  }
  const record = await new WorkspaceRegistry({
    database: database.database,
    state: args.state,
  }).read(workspace.workspace.id);
  return record === undefined ? workspace : { ...workspace, cwd: record.cwd };
}

export function hostTasks(engine: Engine): Tasks {
  return new Tasks({ store: engine.taskStore });
}
