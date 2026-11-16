import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { Workspace } from "~/lib/state/workspace";
import { workspaceState } from "~/lib/state/workspace";

export interface LayoutOptions {
  /** Read for `FOUNDRY_HOME`; `process.env` when omitted. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The Foundry home; `$FOUNDRY_HOME`, else `~/.foundry`. */
  readonly home?: string;
}

export interface Layout {
  /** The shared artifact store: records, blobs, and the feed. */
  readonly artifacts: string;
  readonly database: string;
  /** The Foundry home the defaults hang off. */
  readonly home: string;
  /** The Unix socket the Marbles process listens on. */
  readonly socket: string;
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

export function stateDatabase(state: string): string {
  return join(resolve(state), DATABASE_FILE);
}
