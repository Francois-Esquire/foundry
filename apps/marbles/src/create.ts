import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SessionStore } from "@foundry/agents/session";
import { InMemorySessionStore } from "@foundry/agents/session";
import type { Artifacts } from "@foundry/artifacts";
import { ArtifactManager, InMemoryArtifactStore } from "@foundry/artifacts";
import { blobFiles, JsonArtifactStore } from "@foundry/artifacts/node";
import type { ModelManager, Provider } from "@foundry/models";
import type { Containers } from "@foundry/sandbox/container/containers";
import { createContainers } from "@foundry/sandbox/container/containers";
import { createMemoryContainerStore } from "@foundry/sandbox/container/store";
import { createFakeContainerRuntime } from "@foundry/sandbox/testing";
import type { GitRun } from "@foundry/workspaces/git";
import type { Catalog } from "~/authoring/catalog";
import { configuredMonitorUrl } from "~/lib/automation/configured";
import { AutomationService } from "~/lib/automation/service";
import { Engine } from "~/lib/engine";
import {
  allowedExecutors,
  detectHarnesses,
  harnessModels,
  selectedHarnesses,
} from "~/lib/harnesses";
import { allowedMountRoots } from "~/lib/managers/sandboxes";
import { echoModels } from "~/lib/models/echo";
import { Registry } from "~/lib/registry";
import { JsonSessionStore } from "~/lib/sessions/json-store";
import { InMemoryStateStore, JsonStateStore } from "~/lib/state/store";

/**
 * The engine as Marbles runs it. The machine is inspected and the flags are
 * read here, each instance the engine takes is built with the Marbles
 * default, and what the config declared is copied in. `--dry-run` is decided
 * here too: echo models, echoed git, a fake container runtime, and nothing
 * persisted.
 */

export interface CreateEngineOptions {
  /** The artifact store's directory, shared by every workspace. Omit for in-memory, which `--dry-run` always is. */
  readonly artifacts?: string;
  readonly askable?: boolean;
  /** What the config declared; copied into the engine. */
  readonly catalog: Catalog;
  readonly dry: boolean;
  /** The user's home; defaults to the OS home. */
  readonly home?: string;
  /** Harness ids to keep; empty keeps every detected one. */
  readonly only: readonly string[];
  readonly print: (line: string) => void;
  /** Explicit host-configured network providers, including OpenAI-compatible gateways. */
  readonly providers?: readonly Provider[];
  /** The workspace root: the config's directory, or the cwd without one. */
  readonly root: string;
  /**
   * This workspace's state dir. Under `dry` the engine gets none, so nothing
   * is written there; omit it for an engine that persists nothing either way.
   */
  readonly stateDir?: string;
  /** Identity of this workspace's state; part of a declared artifact's id. */
  readonly workspaceId: string;
}

/** The one place `--dry-run` reaches the state dir: a dry engine persists nothing. */
function persisted(dry: boolean, stateDir: string | undefined) {
  return dry ? undefined : stateDir;
}

/** What `define`, `schedule` and `monitor` are called on: an engine, or a bare registry. */
type Declarable = Pick<Engine, "define" | "monitor" | "schedule">;

/** Tell `target` everything the config declared, definitions first. */
export function declareCatalog(target: Declarable, catalog: Catalog): void {
  for (const definition of catalog.definitions.values()) {
    target.define(definition);
  }
  for (const record of catalog.schedules.values()) {
    target.schedule(record);
  }
  for (const record of catalog.monitors.values()) {
    target.monitor(record);
  }
}

/** What an engine would trigger: the config's declarations and what agents created. */
export interface Triggers {
  /** The triggers agents created, read from the state dir. */
  readonly automations: AutomationService;
  /** What the config declared, and the step agent-created monitors share. */
  readonly registry: Registry;
}

/**
 * The triggers an engine created with these options would have, read
 * without building one. For commands that only list.
 */
export function readTriggers(
  catalog: Catalog,
  { dry, stateDir }: Pick<CreateEngineOptions, "dry" | "stateDir">
): Triggers {
  const registry = new Registry();
  declareCatalog(registry, catalog);
  const state = persisted(dry, stateDir);
  const automations = new AutomationService({
    allowHttp: configuredMonitorUrl(registry),
    registry,
    store:
      state === undefined
        ? new InMemoryStateStore()
        : new JsonStateStore(state),
  });
  return { automations, registry };
}

/** The shared artifact system: JSON records and blob files under `dir`, or memory. */
function artifactsAt(dir: string | undefined): Artifacts {
  return dir === undefined
    ? new ArtifactManager({ store: new InMemoryArtifactStore() })
    : new ArtifactManager({
        files: blobFiles(join(dir, "blobs")),
        store: new JsonArtifactStore({ path: join(dir, "records.json") }),
      });
}

/** The models agents route to: the detected harnesses, or echoes of every allowed one. */
function modelsFor({
  dry,
  only,
  print,
  providers,
}: CreateEngineOptions): ModelManager {
  // `--dry-run` echoes every allowed harness, so it works with none installed.
  const models = dry
    ? echoModels(allowedExecutors(only), print)
    : harnessModels(selectedHarnesses(detectHarnesses(), only));
  for (const provider of providers ?? []) {
    models.register(provider);
  }
  return models;
}

function sessionsFor(
  state: string | undefined,
  print: (line: string) => void
): SessionStore {
  return state === undefined
    ? new InMemorySessionStore()
    : new JsonSessionStore(join(state, "sessions"), { warn: print });
}

/** Started at the first sandbox: the runtime is optional and slow to start. */
function containersFor(
  { catalog, dry, print, root, workspaceId }: CreateEngineOptions,
  worktreeHome: string
): () => Promise<Containers> {
  // `--dry-run` echoes every command a sandbox would run, like git and the
  // models, so a config with sandboxes runs end to end with nothing installed.
  const runtime = () =>
    dry
      ? Promise.resolve(createFakeContainerRuntime({ exec: echoExec(print) }))
      : import("@foundry/sandbox/container/microsandbox-runtime").then(
          ({ createMicrosandboxRuntime }) => createMicrosandboxRuntime()
        );
  return async () => {
    // Worktrees are cut there so a sandbox opened inside one may mount it.
    mkdirSync(worktreeHome, { recursive: true });
    const declared = [...catalog.workspaces].map((path) => resolve(root, path));
    return createContainers({
      allowedMountRoots: allowedMountRoots([root, worktreeHome, ...declared]),
      instanceLabel: `marbles-${workspaceId}`,
      runtime: await runtime(),
      store: createMemoryContainerStore(),
    });
  };
}

/** Build each instance, hand them to a new engine, and declare the config to it. Not yet started. */
export function createEngine(options: CreateEngineOptions): Engine {
  const { catalog, dry, print, root, workspaceId } = options;
  const home = options.home ?? homedir();
  const state = persisted(dry, options.stateDir);
  // Its sandboxes may mount what is cut there; see `containersFor`.
  const worktrees = Engine.worktreesFor(state);
  const engine = new Engine({
    artifacts: artifactsAt(dry ? undefined : options.artifacts),
    askable: options.askable,
    containers: containersFor(options, worktrees),
    dry,
    // The engine's workspace system and its root workspace both run git so.
    git: dry ? { run: echoGit(print) } : {},
    home,
    models: modelsFor(options),
    print,
    root,
    sessions: sessionsFor(state, print),
    state,
    workspaceId,
    worktrees,
  });
  declareCatalog(engine, catalog);
  return engine;
}

/** Prints the command a sandbox would run and returns a clean exit. */
function echoExec(print: (line: string) => void): (
  command: readonly string[]
) => {
  exitCode: number;
  stderr: string;
  stdout: string;
} {
  return (command) => {
    print(`[sandbox] ${command.join(" ")}`);
    return { exitCode: 0, stderr: "", stdout: "" };
  };
}

/** Prints the git it would run and runs nothing. */
export function echoGit(print: (line: string) => void): GitRun {
  return (cwd, args) => {
    print(`[git] ${cwd}: git ${args.join(" ")}`);
    return Promise.resolve("");
  };
}
