import { dirname, isAbsolute, resolve } from "node:path";
import { Tasks } from "@foundry/tasks";
import { Catalog, type ModuleSource } from "~/authoring/catalog";
import {
  isAgent,
  isDefinition,
  isMonitorRecord,
  isObserver,
  isSchedule,
  moduleSource,
  taggedProvider,
} from "~/authoring/declarations";
import { runLoadScope, setHost } from "~/authoring/runtime";
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
import {
  insideState,
  workspaceAt,
  workspaceState,
} from "~/lib/state/workspace";
import { openLoadSession, realPathOf } from "~/workspace/loader";
import { initializeUsage } from "~/workspace/node-usage";
import {
  DEFAULT_SOURCE,
  resolveSource,
  sourceFiles,
  sourceRoot,
} from "~/workspace/source";

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
  readonly configPath: string;
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly files: readonly string[];
  readonly workspace: Workspace;
}

function describeUnexported(item: object): string | undefined {
  if (isDefinition(item)) {
    return item.name === undefined ? item.kind : `${item.kind} "${item.name}"`;
  }
  if (isSchedule(item)) {
    return item.workflow ? `schedule "${item.workflow}"` : "schedule";
  }
  if (isMonitorRecord(item)) {
    return `monitor "${item.key}"`;
  }
  if (isObserver(item)) {
    return item.name ? `observer "${item.name}"` : "observer";
  }
  const provider = taggedProvider(item);
  if (provider !== undefined) {
    return `provider "${provider.id}"`;
  }
  if (isAgent(item)) {
    return `agent "${item.id}"`;
  }
  return undefined;
}

function warnUnexported(
  configPath: string,
  catalog: Catalog,
  created: ReadonlySet<object>,
  locked: ReadonlySet<object>,
  print: (line: string) => void
): void {
  const catalogEmpty =
    catalog.definitions.size === 0 &&
    catalog.agents.size === 0 &&
    catalog.schedules.size === 0 &&
    catalog.monitors.size === 0 &&
    catalog.observers.length === 0 &&
    catalog.providers.size === 0;
  const labels: string[] = [];
  for (const item of created) {
    if (catalog.hasCollected(item) || locked.has(item)) {
      continue;
    }
    if ((isAgent(item) || isDefinition(item)) && !catalogEmpty) {
      continue;
    }
    const label = describeUnexported(item);
    if (label !== undefined) {
      labels.push(label);
    }
  }
  if (labels.length === 0) {
    return;
  }
  const noun = labels.length === 1 ? "declaration" : "declarations";
  const pronoun = labels.length === 1 ? "it" : "them";
  print(
    `[source] warning: ${String(labels.length)} unexported ${noun} (${labels.join(", ")}) in ${configPath} will not be registered; add \`export const ...\` to register ${pronoun}`
  );
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
  const files = sourceFiles(configPath);
  if (files === undefined) {
    return false;
  }
  const session = await openLoadSession(read === undefined ? {} : { read });
  try {
    const {
      created,
      locked,
      value: modules,
    } = await runLoadScope({ dry, workspaceId }, async () => {
      const loaded: ModuleSource[] = [];
      for (const file of files) {
        const real = realPathOf(file);
        const imported = await session.importModule(real);
        loaded.push(moduleSource(imported, real));
      }
      return loaded;
    });
    catalog.collect(modules);
    catalog.validate();
    warnUnexported(configPath, catalog, created, locked, print);
  } catch (error) {
    catalog.reset();
    throw error;
  } finally {
    session.dispose();
  }
  print(`[source] ${configPath}`);
  return [...session.files].sort();
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
  environment: Readonly<Record<string, string>>,
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

export function findWorkspace(args: HostOptions): OpenedWorkspace {
  return opened(args, placed(args), environmentSnapshot());
}

export async function recordedWorkspace(
  args: Pick<HostOptions, "state">,
  id: string
): Promise<OpenedWorkspace | undefined> {
  const state = resolve(args.state);
  const record = await readDatabase(stateDatabase(state), (database) =>
    new WorkspaceRegistry({
      acceptWorkspace: (workspaceId) => insideState(state, workspaceId),
      database,
    }).read(id)
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
    environment: environmentSnapshot(),
    files: [],
    workspace,
  };
}

export interface OpenWorkspaceOptions {
  readonly cwd?: string;
  readonly onMissing?: (configPath: string) => Promise<boolean>;
  readonly print: (line: string) => void;
  readonly read?: (file: string) => void;
}

class StarterLoadError extends Error {
  override readonly name = "StarterLoadError";
}

export async function openWorkspace(
  args: HostOptions,
  { cwd, onMissing, print, read }: OpenWorkspaceOptions
): Promise<OpenedWorkspace> {
  const before = placed(args);
  const environment = environmentSnapshot();
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
  readonly log?: (level: LogLevel, message: string, origin: LogOrigin) => void;
  readonly print: (line: string) => void;
}

export async function hostEngine(
  args: HostOptions,
  workspace: OpenedWorkspace,
  options: WorkspaceEngineOptions
): Promise<Engine> {
  await initializeUsage(options.print);
  const engine = workspaceEngine(args, workspace, options);
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
      acceptWorkspace: (workspaceId) => insideState(args.state, workspaceId),
      database: database.database,
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
    acceptWorkspace: (workspaceId) => insideState(args.state, workspaceId),
    database: database.database,
  }).read(workspace.workspace.id);
  return record === undefined ? workspace : { ...workspace, cwd: record.cwd };
}

export function hostTasks(engine: Engine): Tasks {
  return new Tasks({ store: engine.taskStore });
}
