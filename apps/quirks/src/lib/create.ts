import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAgentAuthorizer,
  createInMemoryAgentAuthorizer,
} from "@foundry/agents/authorization";
import type { SessionStore } from "@foundry/agents/session";
import { InMemorySessionStore } from "@foundry/agents/session";
import type { Artifacts } from "@foundry/artifacts";
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
import { configuredMonitorUrl } from "~/lib/automation/configured";
import { AutomationService } from "~/lib/automation/service";
import type { Managers } from "~/lib/bindings";
import type { Catalog } from "~/lib/catalog";
import { Engine } from "~/lib/engine";
import type { FeedPublisher } from "~/lib/feed/publish";
import {
  allowedExecutors,
  availableExecutors,
  detectHarnesses,
  harnessModels,
  selectExecutor,
  selectedHarnesses,
} from "~/lib/harnesses";
import { AgentsManager } from "~/lib/managers/agents";
import { ArtifactsManager } from "~/lib/managers/artifacts";
import { allowedMountRoots, SandboxesManager } from "~/lib/managers/sandboxes";
import { globalSkillsDir, skillResolver } from "~/lib/managers/skills";
import { WorkspacesManager } from "~/lib/managers/workspaces";
import { echoModels } from "~/lib/models/echo";
import { HarnessActivities } from "~/lib/sandbox/activities";
import { JsonAgentGrantRepository } from "~/lib/sandbox/grants";
import { HarnessInteractions } from "~/lib/sandbox/interactions";
import { JsonSessionStore } from "~/lib/sessions/json-store";

/**
 * The assembly Quirks uses: the machine has been inspected and the flags
 * read, so every instance the engine takes can be built with its default
 * and handed over. A host that wants a different piece builds that piece
 * itself and constructs the `Engine` directly.
 */

export interface CreateEngineOptions {
  /** Permit agent-created HTTP monitors. Defaults to origins of configured HTTP monitors. */
  readonly allowMonitorUrl?: (url: URL) => boolean;
  /** The shared artifact store; declared artifacts and feed entries live in it. */
  readonly artifacts: Pick<Artifacts, "create" | "get" | "revise">;
  readonly askable?: boolean;
  /** What the host registered; its declared workspaces may be mounted into sandboxes. */
  readonly catalog: Catalog;
  readonly dry: boolean;
  readonly feed?: FeedPublisher;
  /** The user's home; defaults to the OS home. */
  readonly home?: string;
  /**
   * Instances to use in place of the defaults: each is built outside and
   * handed in, and anything left out is built here. The engine closes what
   * it ends up holding, whoever built it.
   */
  readonly instances?: Managers & {
    readonly models?: ModelManager;
    readonly sessions?: SessionStore;
  };
  /** Harness ids to keep; empty keeps every detected one. */
  readonly only: readonly string[];
  readonly print: (line: string) => void;
  /** Explicit host-configured network providers, including OpenAI-compatible gateways. */
  readonly providers?: readonly Provider[];
  /** The workspace root: the config's directory, or the cwd without one. */
  readonly root: string;
  /** Workspace state dir; sessions go under it. Omit for in-memory, which `--dry` always is. */
  readonly state?: string;
  /** Identity of this workspace's state; part of a declared artifact's id. */
  readonly workspaceId: string;
}

type Wired =
  | "activities"
  | "agents"
  | "artifacts"
  | "automations"
  | "sandboxes"
  | "workspaces";

/** An engine with every manager present, as `createEngine` builds it. */
export type WiredEngine = Engine & {
  readonly [K in Wired]: NonNullable<Engine[K]>;
};

/** The models agents route to, and the executors they stand for. */
function modelsFor(options: CreateEngineOptions) {
  const { dry, only, print } = options;
  const harnesses = selectedHarnesses(detectHarnesses(), only);
  // `--dry` echoes every allowed harness, so it works with none installed.
  const executors = dry
    ? allowedExecutors(only)
    : availableExecutors(harnesses);
  const models: ModelManager =
    options.instances?.models ??
    (dry ? echoModels(executors, print) : harnessModels(harnesses));
  for (const provider of options.providers ?? []) {
    models.register(provider);
  }
  return { executors, models };
}

function sessionsFor({
  dry,
  instances,
  state,
}: CreateEngineOptions): SessionStore {
  if (instances?.sessions) {
    return instances.sessions;
  }
  return state === undefined || dry
    ? new InMemorySessionStore()
    : new JsonSessionStore(join(state, "sessions"));
}

/** Approvals and questions from agents, answered through the feed; none without one. */
function interactionsFor(
  { askable, dry, feed, state }: CreateEngineOptions,
  sessions: SessionStore
): HarnessInteractions | undefined {
  if (!feed) {
    return undefined;
  }
  const persistent = state && !dry ? state : undefined;
  return new HarnessInteractions({
    askable: askable ?? false,
    feed,
    policy: persistent
      ? createAgentAuthorizer({
          grants: new JsonAgentGrantRepository(
            join(persistent, "agent-grants.json")
          ),
        })
      : createInMemoryAgentAuthorizer().authorizer,
    sessions,
    ...(persistent
      ? { pendingPath: join(persistent, "agent-approvals.json") }
      : {}),
  });
}

/** Resolved at first use, after the config has declared its workspaces. */
function containersFor(
  { catalog, dry, print, root, workspaceId }: CreateEngineOptions,
  home: string,
  worktreeHome: string
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

/** Build every instance the host did not hand in and give them to a new, not yet started, engine. */
export function createEngine(options: CreateEngineOptions): WiredEngine {
  const { catalog, dry, state, root, print, workspaceId } = options;
  const given = options.instances ?? {};
  const home = options.home ?? homedir();
  const { executors, models } = modelsFor(options);
  const sessions = sessionsFor(options);
  const interactions = interactionsFor(options, sessions);
  const gitOptions = dry ? { run: echoGit(print) } : {};
  // Worktrees are cut here so a sandbox opened inside one may mount it.
  const worktreeHome = join(state ?? join(tmpdir(), "quirks"), "worktrees");
  const persistentState = dry ? undefined : state;
  const activities = new HarnessActivities({
    feed: options.feed,
    state: persistentState,
  });
  const automations = new AutomationService({
    allowHttp: options.allowMonitorUrl ?? configuredMonitorUrl(catalog),
    catalog,
    state: persistentState,
  });

  // Every key in `Wired` is set below.
  return new Engine({
    activities,
    agents:
      given.agents ??
      new AgentsManager({
        activities,
        automations,
        defaultExecutor: () => selectExecutor(models),
        dry,
        interactions,
        models,
        sessions,
        skills: skillResolver({
          global: globalSkillsDir(home),
          workspace: root,
        }),
        warn: (message) => print(`[agents] ${message}`),
      }),
    artifacts:
      given.artifacts ??
      new ArtifactsManager({ artifacts: options.artifacts, workspaceId }),
    askable: options.askable,
    automations,
    catalog,
    feed: options.feed,
    harnesses: executors.map((executor) => executor.harness),
    interactions,
    print,
    root,
    sandboxes:
      given.sandboxes ??
      new SandboxesManager({
        containers: containersFor(options, home, worktreeHome),
        home,
        root,
      }),
    state,
    workspaces:
      given.workspaces ??
      new WorkspacesManager({
        catalogue: new WorkspaceSystem().extend(
          directory({ observer: nodeObserver }),
          git(gitOptions)
        ),
        gitOptions,
        root,
        worktreeHome,
      }),
  }) as WiredEngine;
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
