import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { plugin } from "bun";
import type { Flags } from "~/args";
import { catalog } from "~/authoring/catalog";
import type { Triggers } from "~/create";
import { createEngine, readTriggers } from "~/create";
import type { Engine } from "~/lib/engine";
import type { Workspace } from "~/lib/state/workspace";
import { workspaceState } from "~/lib/state/workspace";
import { resolveSource, sourceFiles, sourceRoot } from "~/source";

/**
 * Marbles as a host of the engine: find the authoring source, load it, place
 * the workspace under the state root, and build the engine or read its
 * triggers. The CLI and the dashboard both start here, so each of those is
 * decided once.
 */

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
  const files = sourceFiles(configPath);
  if (files === undefined) {
    return false;
  }

  // Authoring modules use this installation even outside a project with
  // node_modules. Both entry points must share the same registry instance.
  // The paths are relative to this file: `src/` in source, and `dist/` (this
  // file's chunk sits beside the entries) once built.
  const libraryPath = fileURLToPath(
    new URL(
      import.meta.url.endsWith(".ts") ? "./authoring/index.ts" : "./index.js",
      import.meta.url
    )
  );
  const library = await import(libraryPath);
  const prebuilt = await import(
    new URL(
      import.meta.url.endsWith(".ts")
        ? "./authoring/prebuilt.ts"
        : "./prebuilt.js",
      import.meta.url
    ).href
  );
  plugin({
    name: "marbles-source-library",
    setup(builder) {
      builder.module("@foundry/marbles/prebuilt", () => ({
        exports: prebuilt,
        loader: "object",
      }));
      builder.module("@foundry/marbles", () => ({
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
  args: Flags,
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
export function findWorkspace(args: Flags): OpenedWorkspace {
  const configPath = resolveSource(args.config);
  return opened(args, configPath, sourceFiles(configPath) !== undefined);
}

export interface OpenWorkspaceOptions {
  /**
   * Nothing is at the source: offer to create it. Resolves true once
   * something was created and loaded there.
   */
  readonly onMissing?: (configPath: string) => Promise<boolean>;
  readonly print: (line: string) => void;
}

/** Load the source into the catalog and place the workspace it defines. */
export async function openWorkspace(
  args: Flags,
  { onMissing, print }: OpenWorkspaceOptions
): Promise<OpenedWorkspace> {
  const configPath = resolveSource(args.config);
  const found =
    (await loadSource(configPath, print)) ||
    (onMissing !== undefined && (await onMissing(configPath)));
  return opened(args, configPath, found);
}

/** The engine for an opened workspace, as the flags ask for it. Not yet started. */
export function hostEngine(
  args: Flags,
  { workspace }: OpenedWorkspace,
  options: {
    readonly askable?: boolean;
    readonly print: (line: string) => void;
  }
): Engine {
  return createEngine({
    artifacts: resolve(args.artifacts),
    askable: options.askable,
    catalog,
    dry: args.dry,
    only: args.only,
    print: options.print,
    root: workspace.root,
    stateDir: workspace.dir,
    workspaceId: workspace.id,
  });
}

/** What an engine over this workspace would trigger, read without building one. */
export function hostTriggers(
  args: Flags,
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
