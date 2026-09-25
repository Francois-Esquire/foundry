import type { SessionStore } from "@foundry/agents/session";
import { InMemorySessionStore } from "@foundry/agents/session";
import type { TurnExecutorRef } from "@foundry/models";
import { WorkspaceSystem } from "@foundry/workspaces";
import { git } from "@foundry/workspaces/git";
import { directory } from "@foundry/workspaces/node";
import { nodeObserver } from "@foundry/workspaces/node/watch";

import { CLAUDE_CODE, CODEX } from "~/harnesses";
import type { Bindings } from "~/lib/bindings";
import { unbound } from "~/lib/bindings";
import { catalog } from "~/lib/catalog";
import { createLog } from "~/lib/log";
import { agentsManager } from "~/lib/managers/agents";
import { workspacesManager } from "~/lib/managers/workspaces";
import type { Reply } from "~/models/echo";
import { mockModels } from "~/models/echo";
import { echoGit } from "~/runtime";

export interface MockBindingOptions {
  /** Executors the mock models answer for; the first is the default. */
  readonly executors?: readonly TurnExecutorRef[];
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
  readonly sessions: SessionStore;
  readonly warnings: string[];
}

/**
 * Bind the catalog to mock models with a scripted reply, an in-memory (or
 * given) session store, and a real workspace catalogue. Sandboxes and
 * artifacts stay unbound. Call `dispose` when the test is done.
 */
export function bindMock(
  reply: Reply,
  options: MockBindingOptions = {}
): MockBindings {
  const executors = options.executors ?? [CLAUDE_CODE, CODEX];
  const [first = CLAUDE_CODE] = executors;
  const models = mockModels(executors, reply);
  const sessions = options.sessions ?? new InMemorySessionStore();
  const root = options.root ?? process.cwd();
  const gitOptions = options.live ? {} : { run: echoGit(() => undefined) };
  const catalogue = new WorkspaceSystem().extend(
    directory({ observer: nodeObserver }),
    git(gitOptions)
  );
  const warnings: string[] = [];
  const bindings: Bindings = {
    agents: agentsManager({
      defaultExecutor: () => first,
      models,
      sessions,
      skills: () => Promise.resolve([]),
      warn: (message) => {
        warnings.push(message);
      },
    }),
    artifacts: () => unbound("artifacts"),
    host: {
      catalogue,
      ...(options.state === undefined ? {} : { state: options.state }),
    },
    log: createLog((_level, message) => options.log?.(message)),
    root,
    sandboxes: () => unbound("sandboxes"),
    workspaces: workspacesManager({ catalogue, gitOptions, root }),
  };
  catalog.bind(bindings);
  return {
    bindings,
    async dispose() {
      await catalogue.closeAll();
      await models.dispose();
    },
    sessions,
    warnings,
  };
}
