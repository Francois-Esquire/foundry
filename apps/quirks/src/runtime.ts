import { join } from "node:path";
import { InMemorySessionStore } from "@foundry/agents/session";
import type { ModelManager } from "@foundry/models";
import { WorkspaceSystem } from "@foundry/workspaces";
import type { GitRun } from "@foundry/workspaces/git";
import { Git, git } from "@foundry/workspaces/git";
import { directory } from "@foundry/workspaces/node";
import { nodeObserver } from "@foundry/workspaces/node/watch";
import { bindAgents } from "~/agents";
import { unboundFeed } from "~/feed/entry";
import {
  availableExecutors,
  detectHarnesses,
  harnessModels,
} from "~/harnesses";
import { createLog } from "~/lib/log";
import type { Primitives } from "~/lib/registry";
import { registry } from "~/lib/registry";
import { echoModels } from "~/models/echo";
import { JsonSessionStore } from "~/sessions/json-store";
import { skillsNamed } from "~/skills";

/**
 * Phase two of the config lifecycle: the machine has been inspected and the
 * flags read, so the primitives every registered step body will see can be
 * built and bound.
 */

export interface RuntimeOptions {
  readonly dry: boolean;
  /** Harness ids to keep; empty keeps every detected one. */
  readonly only: readonly string[];
  readonly print: (line: string) => void;
  /** The workspace root: the config's directory, or the cwd without one. */
  readonly root: string;
  /** Workspace state dir; sessions go under it. Omit for in-memory, which `--dry` always is. */
  readonly state?: string;
}

export interface Runtime {
  dispose(): Promise<void>;
  readonly primitives: Primitives;
}

export function bindRuntime(options: RuntimeOptions): Runtime {
  const { dry, only, state, root, print } = options;
  const harnesses = detectHarnesses();
  const detected = availableExecutors(harnesses);
  const executors =
    only.length === 0
      ? detected
      : detected.filter((executor) => only.includes(executor.harness));

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
  const primitives: Primitives = {
    agents: bindAgents({
      executors,
      models,
      sessions,
      skills: (names) => skillsNamed(names, join(root, "skills")),
    }),
    executors,
    feed: unboundFeed,
    log: createLog((_level, message) => print(message)),
    models,
    sessions,
    state,
    workspace: { root },
    workspaces: {
      git: (_root) => Git.at(_root, dry ? { run: echoGit(print) } : {}),
      load: (ref) => catalogue.load(ref),
      on: (event, listener) => catalogue.on(event, listener),
    },
  };
  registry.bind(primitives);

  return {
    // The Codex provider holds a `codex app-server` child; without this the
    // process never exits.
    async dispose() {
      try {
        await catalogue.closeAll();
      } finally {
        await models.dispose();
      }
    },
    primitives,
  };
}

/** Prints the git it would run and runs nothing. */
export function echoGit(print: (line: string) => void): GitRun {
  return (cwd, args) => {
    print(`[git] ${cwd}: git ${args.join(" ")}`);
    return Promise.resolve("");
  };
}
