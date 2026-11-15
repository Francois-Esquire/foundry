import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { ResourceKind } from "~/lib/resources";
import type { Workspace } from "~/lib/state/workspace";
import { workspaceState } from "~/lib/state/workspace";

/**
 * Where Marbles keeps things on this machine, decided once, all of it
 * under one Foundry home: `$FOUNDRY_HOME`, else `~/.foundry`. It holds the
 * Marbles state root (`marbles/`: the Marbles database, the process's
 * socket and claim, settings, and one directory per workspace for its run
 * output and worktrees) and the artifact store (`artifacts/`), whose blob
 * files every workspace's artifacts keep. Moving the home moves
 * everything; nothing moves on its own.
 */

export interface LayoutOptions {
  /** Read for `FOUNDRY_HOME`; `process.env` when omitted. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The Foundry home; `$FOUNDRY_HOME`, else `~/.foundry`. */
  readonly home?: string;
}

export interface Layout {
  /** The shared artifact store: records, blobs, and the feed. */
  readonly artifacts: string;
  /** The Marbles database, one file for every workspace under the state root. */
  readonly database: string;
  /** The Foundry home the defaults hang off. */
  readonly home: string;
  /** The Unix socket the Marbles process listens on. */
  readonly socket: string;
  /**
   * Where the Marbles process records what its workspaces start
   * (`MARBLES_SPAWN_RECOVERY`), so an engine's next start stops what one
   * that is gone left running.
   */
  readonly spawned: string;
  /** The Marbles state root: process files, and one directory per workspace. */
  readonly state: string;
  /** The state of the workspace rooted at `root`, under this state root. */
  workspace(root: string): Workspace;
}

const HOME_DIR = ".foundry";
const STATE_DIR = "marbles";
const ARTIFACTS_DIR = "artifacts";
const DATABASE_FILE = "marbles.db";
const SPAWNED_DIR = "spawned";
/** Short on purpose: a Unix socket path has about a hundred bytes to work with. */
const SOCKET_FILE = "marbles.sock";

export function layout(options: LayoutOptions = {}): Layout {
  const env = options.env ?? process.env;
  const home = resolve(
    options.home ?? env.FOUNDRY_HOME ?? join(homedir(), HOME_DIR)
  );
  const state = join(home, STATE_DIR);
  const artifacts = join(home, ARTIFACTS_DIR);
  return {
    artifacts,
    database: stateDatabase(state),
    home,
    socket: join(state, SOCKET_FILE),
    spawned: join(state, SPAWNED_DIR),
    state,
    workspace: (root) => workspaceState(state, root),
  };
}

/**
 * The Marbles database under the state root `state`, beside the process
 * claim and socket.
 */
export function stateDatabase(state: string): string {
  return join(resolve(state), DATABASE_FILE);
}

const LINKS_DIR = ".marbles";

/**
 * Where a workspace rooted at `root` keeps links to the resources it shows,
 * `<root>/.marbles`: nothing there is truth, and all of it can be made
 * again from the Marbles database (`marbles relink`).
 */
export function workspaceLinks(root: string): string {
  return join(resolve(root), LINKS_DIR);
}

/** The links of one kind of resource in the workspace rooted at `root`: `<root>/.marbles/<kind>s`. */
export function resourceLinks(root: string, kind: ResourceKind): string {
  return join(workspaceLinks(root), `${kind}s`);
}
