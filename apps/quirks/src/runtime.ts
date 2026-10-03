import { mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createAgentAuthorizer,
  createInMemoryAgentAuthorizer,
} from "@foundry/agents/authorization";
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
import { configuredMonitorUrl } from "~/automation/configured";
import { AutomationService } from "~/automation/service";
import type { FeedPublisher } from "~/feed/publish";
import {
  allowedExecutors,
  availableExecutors,
  detectHarnesses,
  harnessModels,
  selectExecutor,
  selectedHarnesses,
} from "~/harnesses";
import type { Bindings } from "~/lib/bindings";
import { catalog } from "~/lib/catalog";
import { createLog } from "~/lib/log";
import { agentsManager } from "~/lib/managers/agents";
import { artifactsManager } from "~/lib/managers/artifacts";
import { allowedMountRoots, sandboxesManager } from "~/lib/managers/sandboxes";
import { globalSkillsDir, skillResolver } from "~/lib/managers/skills";
import { workspacesManager } from "~/lib/managers/workspaces";
import { echoModels } from "~/models/echo";
import { HarnessActivities } from "~/sandbox/activities";
import { JsonAgentGrantRepository } from "~/sandbox/grants";
import { HarnessInteractions } from "~/sandbox/interactions";
import { JsonSessionStore } from "~/sessions/json-store";

/**
 * Phase two of the config lifecycle: the machine has been inspected and the
 * flags read, so the bindings every step body will see can be built and
 * bound to the catalog.
 */

export interface RuntimeOptions {
  /** Permit agent-created HTTP monitors. Defaults to origins of configured HTTP monitors. */
  readonly allowMonitorUrl?: (url: URL) => boolean;
  /** The shared artifact store; declared artifacts and feed entries live in it. */
  readonly artifacts: Pick<Artifacts, "create" | "get" | "revise">;
  readonly askable?: boolean;
  readonly dry: boolean;
  readonly feed?: FeedPublisher;
  /** The user's home; defaults to the OS home. */
  readonly home?: string;
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

export interface Runtime {
  readonly activities: HarnessActivities;
  readonly automations: AutomationService;
  readonly bindings: Bindings;
  dispose(): Promise<void>;
  /** Detected harness ids, in preference order. */
  readonly harnesses: readonly string[];
  readonly interactions?: HarnessInteractions;
}

export function bindRuntime(options: RuntimeOptions): Runtime {
  const { dry, only, state, root, print, workspaceId } = options;
  const home = options.home ?? homedir();
  const harnesses = selectedHarnesses(detectHarnesses(), only);
  // `--dry` echoes every allowed harness, so it works with none installed.
  const executors = dry
    ? allowedExecutors(only)
    : availableExecutors(harnesses);
  const models: ModelManager = dry
    ? echoModels(executors, print)
    : harnessModels(harnesses);
  for (const provider of options.providers ?? []) {
    models.register(provider);
  }
  const sessions =
    state === undefined || dry
      ? new InMemorySessionStore()
      : new JsonSessionStore(join(state, "sessions"));
  const policy =
    state && !dry
      ? createAgentAuthorizer({
          grants: new JsonAgentGrantRepository(
            join(state, "agent-grants.json")
          ),
        })
      : createInMemoryAgentAuthorizer().authorizer;
  const interactions = options.feed
    ? new HarnessInteractions({
        askable: options.askable ?? false,
        feed: options.feed,
        policy,
        sessions,
        ...(state && !dry
          ? { pendingPath: join(state, "agent-approvals.json") }
          : {}),
      })
    : undefined;
  const catalogue = new WorkspaceSystem().extend(
    directory({ observer: nodeObserver }),
    git(dry ? { run: echoGit(print) } : {})
  );
  let containers: Promise<Containers> | undefined;
  // `--dry` echoes every command a sandbox would run, like git and the
  // models, so a config with sandboxes runs end to end with nothing installed.
  const runtime = () =>
    dry
      ? Promise.resolve(createFakeContainerRuntime({ exec: echoExec(print) }))
      : import("@foundry/sandbox/container/microsandbox-runtime").then(
          ({ createMicrosandboxRuntime }) => createMicrosandboxRuntime()
        );
  // Worktrees are cut here so a sandbox opened inside one may mount it.
  const worktreeHome = join(state ?? join(tmpdir(), "quirks"), "worktrees");
  // Resolved at first use, after the config has declared its workspaces.
  const openContainers = () => {
    mkdirSync(worktreeHome, { recursive: true });
    const declared = [...catalog.workspaces].map((path) => resolve(root, path));
    containers ??= runtime().then((backend) =>
      createContainers({
        allowedMountRoots: allowedMountRoots(
          [root, worktreeHome, ...declared],
          home
        ),
        instanceLabel: `quirks-${workspaceId}`,
        runtime: backend as never,
        store: createMemoryContainerStore(),
      })
    );
    return containers;
  };

  const persistentState = dry ? undefined : state;
  const activities = new HarnessActivities({
    feed: options.feed,
    state: persistentState,
  });
  const automations = new AutomationService({
    allowHttp: options.allowMonitorUrl ?? configuredMonitorUrl,
    state: persistentState,
  });

  const bindings: Bindings = {
    agents: agentsManager({
      activities,
      automations,
      defaultExecutor: () => selectExecutor(models),
      dry,
      interactions,
      models,
      sessions,
      skills: skillResolver({ global: globalSkillsDir(home), workspace: root }),
      warn: (message) => print(`[agents] ${message}`),
    }),
    artifacts: artifactsManager({ artifacts: options.artifacts, workspaceId }),
    host: { catalogue, ...(state === undefined ? {} : { state }) },
    log: createLog((_level, message) => print(message)),
    root,
    sandboxes: sandboxesManager({ containers: openContainers, home, root }),
    workspaces: workspacesManager({
      catalogue,
      ...(dry ? { gitOptions: { run: echoGit(print) } } : {}),
      root,
      worktreeHome,
    }),
  };
  catalog.bind(bindings);

  return {
    activities,
    automations,
    bindings,
    // The Codex provider holds a `codex app-server` child; without this the
    // process never exits.
    async dispose() {
      try {
        await interactions?.close();
        await catalogue.closeAll();
        await containers
          ?.then((open) => open.shutdown())
          .catch(() => undefined);
      } finally {
        await models.dispose();
      }
    },
    harnesses: executors.map((executor) => executor.harness),
    interactions,
  };
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
