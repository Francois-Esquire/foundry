import { homedir } from "node:os";
import { join } from "node:path";
import { InMemorySessionStore } from "@foundry/agents/session";
import type { Artifacts } from "@foundry/artifacts";
import type { ModelManager } from "@foundry/models";
import type { Containers } from "@foundry/sandbox/container/containers";
import { createContainers } from "@foundry/sandbox/container/containers";
import { createMemoryContainerStore } from "@foundry/sandbox/container/store";
import { WorkspaceSystem } from "@foundry/workspaces";
import type { GitRun } from "@foundry/workspaces/git";
import { git } from "@foundry/workspaces/git";
import { directory } from "@foundry/workspaces/node";
import { nodeObserver } from "@foundry/workspaces/node/watch";

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
import { JsonSessionStore } from "~/sessions/json-store";

/**
 * Phase two of the config lifecycle: the machine has been inspected and the
 * flags read, so the bindings every step body will see can be built and
 * bound to the catalog.
 */

export interface RuntimeOptions {
  /** The shared artifact store; declared artifacts and feed entries live in it. */
  readonly artifacts: Pick<Artifacts, "create" | "get" | "revise">;
  readonly dry: boolean;
  /** The user's home; defaults to the OS home. */
  readonly home?: string;
  /** Harness ids to keep; empty keeps every detected one. */
  readonly only: readonly string[];
  readonly print: (line: string) => void;
  /** The workspace root: the config's directory, or the cwd without one. */
  readonly root: string;
  /** Workspace state dir; sessions go under it. Omit for in-memory, which `--dry` always is. */
  readonly state?: string;
  /** Identity of this workspace's state; part of a declared artifact's id. */
  readonly workspaceId: string;
}

export interface Runtime {
  readonly bindings: Bindings;
  dispose(): Promise<void>;
  /** Detected harness ids, in preference order. */
  readonly harnesses: readonly string[];
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
  const sessions =
    state === undefined || dry
      ? new InMemorySessionStore()
      : new JsonSessionStore(join(state, "sessions"));
  const catalogue = new WorkspaceSystem().extend(
    directory({ observer: nodeObserver }),
    git(dry ? { run: echoGit(print) } : {})
  );
  let containers: Promise<Containers> | undefined;
  const openContainers = () => {
    if (dry) {
      return Promise.reject(
        new Error("sandboxes do not run under --dry; drop the flag to use one")
      );
    }
    containers ??= import(
      "@foundry/sandbox/container/microsandbox-runtime"
    ).then(({ createMicrosandboxRuntime }) =>
      createContainers({
        allowedMountRoots: allowedMountRoots([root], home),
        instanceLabel: `quirks-${workspaceId}`,
        runtime: createMicrosandboxRuntime(),
        store: createMemoryContainerStore(),
      })
    );
    return containers;
  };

  const bindings: Bindings = {
    agents: agentsManager({
      defaultExecutor: () => selectExecutor(models),
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
    }),
  };
  catalog.bind(bindings);

  return {
    bindings,
    // The Codex provider holds a `codex app-server` child; without this the
    // process never exits.
    async dispose() {
      try {
        await catalogue.closeAll();
        await containers
          ?.then((open) => open.shutdown())
          .catch(() => undefined);
      } finally {
        await models.dispose();
      }
    },
    harnesses: executors.map((executor) => executor.harness),
  };
}

/** Prints the git it would run and runs nothing. */
export function echoGit(print: (line: string) => void): GitRun {
  return (cwd, args) => {
    print(`[git] ${cwd}: git ${args.join(" ")}`);
    return Promise.resolve("");
  };
}
