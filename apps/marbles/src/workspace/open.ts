import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Tasks } from "@foundry/tasks";
import { plugin } from "bun";
import { catalog } from "~/authoring/catalog";
import { expectHost, setHost } from "~/authoring/runtime";
import { initializeUsage } from "~/authoring/usage";
import type { Triggers } from "~/create";
import { createEngine, readTriggers } from "~/create";
import type { Engine } from "~/lib/engine";
import type { LogLevel, LogOrigin } from "~/lib/log";
import type { Workspace } from "~/lib/state/workspace";
import { workspaceState } from "~/lib/state/workspace";
import { loadEnvironment } from "~/workspace/env";
import { resolveSource, sourceFiles, sourceRoot } from "~/workspace/source";

/**
 * Marbles as a host of the engine: find the authoring source, load it, place
 * the workspace under the state root, and build the engine or read its
 * triggers. The CLI and the dashboard both start here, so each of those is
 * decided once.
 */

export interface HostOptions {
  readonly artifacts: string;
  readonly config: string;
  readonly dry: boolean;
  readonly only: readonly string[];
  readonly state: string;
}

export interface OpenedWorkspace {
  /**
   * The source that defines this workspace, or null without one; the
   * workspace is then the cwd.
   */
  readonly config: string | null;
  /** Where the authoring source is, or would be created. */
  readonly configPath: string;
  readonly workspace: Workspace;
}

/**
 * Import every authoring module under `configPath`, so the catalog holds what
 * they declare. False when nothing is there.
 */
export async function loadSource(
  configPath: string,
  print: (line: string) => void
): Promise<boolean> {
  // From here the builtin `tasks` wait for this workspace's engine, rather
  // than take a write the workspace would never see.
  expectHost();
  const files = sourceFiles(configPath);
  if (files === undefined) {
    return false;
  }

  // Authoring modules use this installation even outside a project with
  // node_modules. Both entry points must share the same registry instance.
  // The paths are relative to this file: `src/workspace/` in source, and
  // `dist/` (this file's chunk sits beside the entries) once built.
  const libraryPath = fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts") ? "../authoring/index.ts" : "./index.js",
      import.meta.url
    )
  );
  const library = await import(libraryPath);
  const prebuilt = await import(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "../authoring/prebuilt.ts"
        : "./prebuilt.js",
      import.meta.url
    ).href
  );
  plugin({
    name: "marbles-source-library",
    setup(builder) {
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
  for (const file of files) {
    await import(pathToFileURL(file).href);
  }
  print(`[source] ${configPath}`);
  return true;
}

function opened(
  args: HostOptions,
  configPath: string,
  found: boolean
): OpenedWorkspace {
  const config = found ? configPath : null;
  return {
    config,
    configPath,
    workspace: workspaceState(
      resolve(args.state),
      config === null ? process.cwd() : sourceRoot(config)
    ),
  };
}

/** The workspace the source names, found without executing anything. */
export function findWorkspace(args: HostOptions): OpenedWorkspace {
  const configPath = resolveSource(args.config);
  return opened(args, configPath, sourceFiles(configPath) !== undefined);
}

export interface OpenWorkspaceOptions {
  /**
   * What a workspace `.env.schema` that does not resolve does: fail, for
   * work about to run, or print and go on. `warn` when omitted.
   */
  readonly env?: "require" | "warn";
  /**
   * Nothing is at the source: offer to create it. Resolves true once
   * something was created and loaded there.
   */
  readonly onMissing?: (configPath: string) => Promise<boolean>;
  readonly print: (line: string) => void;
}

/**
 * Load the workspace's environment, then the source into the catalog, and
 * place the workspace it defines. The environment comes first so a module
 * reading `process.env` at load sees it.
 */
export async function openWorkspace(
  args: HostOptions,
  { env = "warn", onMissing, print }: OpenWorkspaceOptions
): Promise<OpenedWorkspace> {
  const configPath = resolveSource(args.config);
  loadEnvironment(
    sourceFiles(configPath) === undefined
      ? process.cwd()
      : sourceRoot(configPath),
    env,
    print
  );
  const found =
    (await loadSource(configPath, print)) ||
    (onMissing !== undefined && (await onMissing(configPath)));
  return opened(args, configPath, found);
}

interface WorkspaceEngineOptions {
  readonly askable?: boolean;
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
  setHost(engine);
  return engine;
}

/**
 * The engine over a workspace, as the flags ask for it, and nothing more:
 * no usage accounts and no host for definitions called outside a run. It
 * keeps the workspace's state, its tasks among it, under `--dry-run` in
 * memory only.
 */
export function workspaceEngine(
  args: HostOptions,
  { workspace }: OpenedWorkspace,
  options: WorkspaceEngineOptions
): Engine {
  return createEngine({
    artifacts: resolve(args.artifacts),
    askable: options.askable,
    catalog,
    dry: args.dry,
    ...(options.log ? { log: options.log } : {}),
    only: args.only,
    print: options.print,
    root: workspace.root,
    stateDir: workspace.dir,
    workspaceId: workspace.id,
  });
}

/** What an engine over this workspace would trigger, read without building one. */
export function hostTriggers(
  args: HostOptions,
  { workspace }: OpenedWorkspace
): Triggers {
  return readTriggers(catalog, { dry: args.dry, stateDir: workspace.dir });
}

/**
 * Record that this workspace ran, for `status`. Only an engine that persists
 * writes it: a listing, and anything under `--dry-run`, leaves the state root
 * as it found it.
 */
export function touchWorkspace(
  engine: Engine,
  { config, workspace }: OpenedWorkspace
): void {
  if (engine.state !== undefined) {
    workspace.touch(config);
  }
}

/**
 * The tasks of the engine's workspace, for the CLI and the MCP tools: its
 * own store, which the builtin `tasks` also reaches while the engine is the
 * host. Each commit stores its change in the same write. The engine owns
 * the store until `dispose`; after that, reads and writes are refused,
 * never answered from somewhere else.
 */
export function hostTasks(engine: Engine): Tasks {
  return new Tasks({ store: engine.taskStore });
}
