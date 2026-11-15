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
import { copyModules, importLoad, linkLibrary } from "~/workspace/copies";
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
  /**
   * The directory the command runs in: a relative `config` resolves from
   * it, and it is the workspace root when nothing is at the source. Needed
   * for either; without it `config` must be absolute and there.
   */
  readonly directory?: string;
  readonly dry: boolean;
  readonly state: string;
}

export interface OpenedWorkspace {
  /**
   * What the workspace's source declared, its own: empty until the source
   * is loaded, and never shared with another workspace in this process.
   */
  readonly catalog: Catalog;
  /**
   * The source that defines this workspace, or null without one; the
   * workspace is then its root alone.
   */
  readonly config: string | null;
  /** Where the authoring source is, or would be created. */
  readonly configPath: string;
  /** Where its runs start and its commands run: its registration's. */
  readonly cwd: string;
  readonly environment: WorkspaceEnvironment;
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

/**
 * Authoring modules use this installation even outside a project with
 * node_modules, and every workspace's modules share it, so its registry
 * and slots are one instance per process. Registered once.
 */
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
    // A load's own modules get the library bound to that load.
    linkLibrary("@foundry.sh/marbles", (load) => libraryOfLoad(library, load));
    linkLibrary("@foundry.sh/marbles/prebuilt", (load) =>
      prebuiltOfLoad(prebuilt, load)
    );
  })();
  return sourceLibrary;
}

/**
 * Import every authoring module under `configPath` into `catalog`, the
 * catalog of workspace `workspaceId`, so it holds what they declare and no
 * other workspace's does. False when nothing is there. One that throws
 * leaves `catalog` empty. Each load imports copies of its own of the
 * workspace's modules (`importLoad`), so a load after an edit, or after one
 * that threw, evaluates them again.
 */
async function loadSource(
  configPath: string,
  { catalog, workspaceId }: { catalog: Catalog; workspaceId: string },
  print: (line: string) => void
): Promise<boolean> {
  // From here the builtin `tasks` wait for this workspace's engine, rather
  // than take a write the workspace would never see.
  expectHost();
  const files = sourceFiles(configPath);
  if (files === undefined) {
    return false;
  }
  await linkSourceLibrary();
  await loadInto(workspaceId, catalog, (load) =>
    importLoad(sourceRoot(configPath), files, load)
  );
  print(`[source] ${configPath}`);
  return true;
}

/** Where `args` places its workspace: its source, if any, and its root. */
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
  { catalog = new Catalog(), cwd }: { catalog?: Catalog; cwd?: string } = {}
): OpenedWorkspace {
  const workspace = workspaceState(resolve(args.state), root);
  return {
    catalog,
    config: found ? configPath : null,
    configPath,
    cwd: cwd ?? workspace.root,
    environment,
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

/**
 * A workspace recorded under the state root, by its id, found without
 * executing anything. Its checkout need not exist: stored state is all a
 * task command reads. Undefined when nothing has that id, or when
 * `<state>/<id>` is a link; a state root without a database is left
 * without one.
 */
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
    workspace,
  };
}

export interface OpenWorkspaceOptions {
  /** Where the workspace's work starts, as it was registered; its root when omitted. */
  readonly cwd?: string;
  /**
   * What a workspace `.env.schema` that does not resolve does: fail, for
   * work about to run, or print and go on. `warn` when omitted.
   */
  readonly env?: "require" | "warn";
  /**
   * Nothing is at the source: offer to create it. Resolves true once
   * something was created there, which is then loaded.
   */
  readonly onMissing?: (configPath: string) => Promise<boolean>;
  readonly print: (line: string) => void;
}

/** A source that was just created and did not load. */
class StarterLoadError extends Error {
  override readonly name = "StarterLoadError";
}

/**
 * Load the workspace's environment, then its source into a catalog of its
 * own, and place the workspace it defines. The environment is resolved
 * first and kept for the engine: nothing is written to this process's
 * `process.env`, which another workspace here shares.
 */
export async function openWorkspace(
  args: HostOptions,
  { cwd, env = "warn", onMissing, print }: OpenWorkspaceOptions
): Promise<OpenedWorkspace> {
  const before = placed(args);
  const environment = loadEnvironment(before.root, env, print);
  const catalog = new Catalog();
  const load = (at: ReturnType<typeof placed>) =>
    loadSource(
      at.configPath,
      {
        catalog,
        workspaceId: workspaceState(resolve(args.state), at.root).id,
      },
      print
    );
  if (await load(before)) {
    return opened(args, before, environment, { catalog, cwd });
  }
  if (onMissing === undefined || !(await onMissing(before.configPath))) {
    return opened(args, before, environment, { catalog, cwd });
  }
  const created = placed(args);
  try {
    await load(created);
  } catch (error) {
    throw new StarterLoadError(
      `Starter was created but could not load: ${String(error)}. Fix it and restart Marbles.`,
      { cause: error }
    );
  }
  return opened(args, created, environment, { catalog, cwd });
}

interface WorkspaceEngineOptions {
  readonly askable?: boolean;
  /**
   * The Marbles database this process hosts the workspace over, which
   * keeps its tasks and agent sessions; without one (`--dry-run`), they are
   * in memory.
   */
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

/**
 * The engine over a workspace, as the flags ask for it, and nothing more:
 * no usage accounts and no host for definitions called outside a run. It
 * keeps the workspace's state, and its tasks and sessions in `database`, under
 * `--dry-run` in memory only.
 */
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
    ...(database === undefined ? {} : { database: database.database }),
    root: workspace.root,
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

/**
 * Record that this workspace ran, for `status`, and register it as it
 * opened: its root and its source, and where its work starts when
 * `registers` names it (kept as it was otherwise), in the database the
 * host opened. Without one (`--dry-run`) nothing is written.
 */
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

/**
 * `workspace` working where its registration says: where it was registered to
 * start, unless the host named somewhere itself, else its root.
 */
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

/**
 * The tasks of the engine's workspace, for the CLI and the MCP tools: its
 * own store, which the builtin `tasks` also reaches while the engine is the
 * host. Each commit records its change in the same write. After the engine
 * is disposed, reads and writes are refused, never answered from
 * somewhere else.
 */
export function hostTasks(engine: Engine): Tasks {
  return new Tasks({ store: engine.taskStore });
}
