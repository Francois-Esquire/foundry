import type { SessionStore } from "@foundry/agents/session";
import { InMemorySessionStore } from "@foundry/agents/session";
import type { TurnExecutorRef } from "@foundry/models";
import { WorkspaceSystem } from "@foundry/workspaces";
import { git } from "@foundry/workspaces/git";
import { directory } from "@foundry/workspaces/node";
import { nodeObserver } from "@foundry/workspaces/node/watch";
import type { Bindings, Managers } from "~/lib/bindings";
import { bindManagers } from "~/lib/bindings";
import { echoGit } from "~/lib/create";
import { CLAUDE_CODE, CODEX } from "~/lib/harnesses";
import { createLog } from "~/lib/log";
import { AgentsManager } from "~/lib/managers/agents";
import { WorkspacesManager } from "~/lib/managers/workspaces";
import type { MockOptions, Reply } from "~/lib/models/echo";
import { mockModels } from "~/lib/models/echo";
import { bindLaunch } from "./launch";

export interface MockBindingOptions {
  /** Executors the mock models answer for; the first is the default. */
  readonly executors?: readonly TurnExecutorRef[];
  /** Turns to hold open until their signal fires; see `MockOptions`. */
  readonly hold?: MockOptions["hold"];
  /** Run git for real; the default echoes every mutation. */
  readonly live?: boolean;
  readonly log?: (line: string) => void;
  /** The config's directory; defaults to the cwd. */
  readonly root?: string;
  readonly sessions?: SessionStore;
  /** A workspace state dir for monitors; omit for in-memory. */
  readonly state?: string;
}

export interface MockBindings {
  readonly bindings: Bindings;
  dispose(): Promise<void>;
  /** Spread into `new Engine({ ... })` or `startEngine({ ... })`. */
  readonly managers: Required<Pick<Managers, "agents" | "workspaces">>;
  readonly sessions: SessionStore;
  readonly warnings: string[];
}

/**
 * Managers over mock models with a scripted reply, an in-memory (or given)
 * session store, and a real workspace catalogue. Sandboxes and artifacts
 * stay unwired. `launch` runs against them at once; an engine takes
 * `managers`. Call `dispose` when the test is done.
 */
export function bindMock(
  reply: Reply,
  options: MockBindingOptions = {}
): MockBindings {
  const executors = options.executors ?? [CLAUDE_CODE, CODEX];
  const [first = CLAUDE_CODE] = executors;
  const models = mockModels(
    executors,
    reply,
    options.hold === undefined ? {} : { hold: options.hold }
  );
  const sessions = options.sessions ?? new InMemorySessionStore();
  const root = options.root ?? process.cwd();
  const gitOptions = options.live ? {} : { run: echoGit(() => undefined) };
  const catalogue = new WorkspaceSystem().extend(
    directory({ observer: nodeObserver }),
    git(gitOptions)
  );
  const warnings: string[] = [];
  const managers = {
    agents: new AgentsManager({
      defaultExecutor: () => first,
      models,
      sessions,
      skills: () => Promise.resolve([]),
      warn: (message) => {
        warnings.push(message);
      },
    }),
    workspaces: new WorkspacesManager({ catalogue, gitOptions, root }),
  };
  const bindings = bindManagers({
    ...managers,
    log: createLog((_level, message) => options.log?.(message)),
    root,
    ...(options.state === undefined ? {} : { state: options.state }),
  });
  bindLaunch(bindings);
  return {
    bindings,
    async dispose() {
      await managers.workspaces.close();
      await managers.agents.close();
    },
    managers,
    sessions,
    warnings,
  };
}
