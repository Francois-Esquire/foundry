import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SessionStore } from "@foundry/agents/session";
import { InMemorySessionStore } from "@foundry/agents/session";
import type { Artifacts } from "@foundry/artifacts";
import { ArtifactSystem, InMemoryArtifactStore } from "@foundry/artifacts";
import { blobFiles, JsonArtifactStore } from "@foundry/artifacts/node";
import type { ModelManager, Provider } from "@foundry/models";
import type { Containers } from "@foundry/sandbox/container/containers";
import { createContainers } from "@foundry/sandbox/container/containers";
import { createMemoryContainerStore } from "@foundry/sandbox/container/store";
import { createFakeContainerRuntime } from "@foundry/sandbox/testing";
import { WorkspaceSystem } from "@foundry/workspaces";
import type { GitRun } from "@foundry/workspaces/git";
import { git } from "@foundry/workspaces/git";
import { directory } from "@foundry/workspaces/node";
import { nodeObserver } from "@foundry/workspaces/node/watch";
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

/**
 * The engine as Quirks runs it. The machine is inspected and the flags are
 * read here, each instance the engine takes is built with the Quirks
 * default, and what the config declared is copied in. `--dry` is decided
 * here too: echo models, echoed git, a fake container runtime, and nothing
 * persisted.
 */

export interface CreateEngineOptions {
  /** The artifact store's directory, shared by every workspace. Omit for in-memory, which `--dry` always is. */
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
  /** Workspace state dir; the CLI omits it under `--dry`, so nothing is written. */
  readonly state?: string;
  /** Identity of this workspace's state; part of a declared artifact's id. */
  readonly workspaceId: string;
}

/** What `define`, `schedule` and `monitor` are called on: an engine, or a bare registry. */
type Declarable = Pick<Engine, "define" | "monitor" | "schedule">;

/** Tell `target` everything the config declared, definitions first. */
export function declareCatalog(target: Declarable, catalog: Catalog): void {
  for (const definition of catalog.definitions.values()) {
    target.define(definition);
  }
  for (const record of catalog.schedules.values()) {
    const watched = catalog.monitors.get(record.key);
    if (watched) {
      target.monitor(record.key, watched, record);
    } else {
      target.schedule(record);
    }
  }
}

/**
 * The triggers an engine over this state dir would have, read without
 * building one: what the config declared plus what agents created. For
 * commands that only list.
 */
export function readTriggers(
  catalog: Catalog,
  state: string | undefined
): AutomationService {
  const registry = new Registry();
  declareCatalog(registry, catalog);
  return new AutomationService({
    allowHttp: configuredMonitorUrl(registry),
    registry,
    state,
  });
}

/** The shared artifact system: JSON records and blob files under `dir`, or memory. */
function artifactsAt(dir: string | undefined): Artifacts {
  return dir === undefined
    ? new ArtifactSystem({ store: new InMemoryArtifactStore() })
    : new ArtifactSystem({
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
  // `--dry` echoes every allowed harness, so it works with none installed.
  const models = dry
    ? echoModels(allowedExecutors(only), print)
    : harnessModels(selectedHarnesses(detectHarnesses(), only));
  for (const provider of providers ?? []) {
    models.register(provider);
  }
  return models;
}

function sessionsFor({ dry, state }: CreateEngineOptions): SessionStore {
  return state === undefined || dry
    ? new InMemorySessionStore()
    : new JsonSessionStore(join(state, "sessions"));
}

/** Resolved at the first sandbox, once the engine knows where worktrees are cut. */
function containersFor(
  { catalog, dry, print, root, workspaceId }: CreateEngineOptions,
  home: string,
  worktrees: () => string
): () => Promise<Containers> {
  // `--dry` echoes every command a sandbox would run, like git and the
  // models, so a config with sandboxes runs end to end with nothing installed.
  const runtime = () =>
    dry
      ? Promise.resolve(createFakeContainerRuntime({ exec: echoExec(print) }))
      : import("@foundry/sandbox/container/microsandbox-runtime").then(
          ({ createMicrosandboxRuntime }) => createMicrosandboxRuntime()
        );
  return async () => {
    // Worktrees are cut there so a sandbox opened inside one may mount it.
    const worktreeHome = worktrees();
    mkdirSync(worktreeHome, { recursive: true });
    const declared = [...catalog.workspaces].map((path) => resolve(root, path));
    return createContainers({
      allowedMountRoots: allowedMountRoots(
        [root, worktreeHome, ...declared],
        home
      ),
      instanceLabel: `quirks-${workspaceId}`,
      runtime: (await runtime()) as never,
      store: createMemoryContainerStore(),
    });
  };
}

/** Build each instance, hand them to a new engine, and declare the config to it. Not yet started. */
export function createEngine(options: CreateEngineOptions): Engine {
  const { catalog, dry, print, root, workspaceId } = options;
  const home = options.home ?? homedir();
  const gitOptions = dry ? { run: echoGit(print) } : {};
  const engine: Engine = new Engine({
    artifacts: artifactsAt(dry ? undefined : options.artifacts),
    askable: options.askable,
    containers: containersFor(options, home, () => engine.worktrees),
    dry,
    git: gitOptions,
    home,
    models: modelsFor(options),
    print,
    root,
    sessions: sessionsFor(options),
    state: options.state,
    workspaceId,
    workspaces: new WorkspaceSystem().extend(
      directory({ observer: nodeObserver }),
      git(gitOptions)
    ),
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
