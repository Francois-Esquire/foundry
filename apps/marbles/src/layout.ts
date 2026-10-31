import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { Workspace } from "~/lib/state/workspace";
import { workspaceState } from "~/lib/state/workspace";

/**
 * Where Marbles keeps things on this machine, decided once. The opinionated
 * default is one Foundry home, `~/.foundry`, holding the Marbles state root
 * (`marbles/`, one directory per workspace plus the process files) and the
 * artifact store (`artifacts/`) that every workspace shares. Each location
 * can be set on its own; the others follow from it, so a custom state root
 * keeps its artifacts beside it rather than in the user's home.
 *
 * `FOUNDRY_HOME` moves the whole home. Flags (`--state`, `--artifacts`)
 * move one location and win over it.
 */

export interface LayoutOptions {
  /** The artifact store; `<home>/artifacts`, or beside a custom state root. */
  readonly artifacts?: string;
  /** Read for `FOUNDRY_HOME`; `process.env` when omitted. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The Foundry home; `$FOUNDRY_HOME`, else `~/.foundry`. */
  readonly home?: string;
  /** The Marbles state root; `<home>/marbles`. */
  readonly state?: string;
}

export interface Layout {
  /** The shared artifact store: records, blobs, and the feed. */
  readonly artifacts: string;
  /** The Foundry home the defaults hang off. */
  readonly home: string;
  /** The Unix socket the Marbles process listens on. */
  readonly socket: string;
  /** The Marbles state root: process files, and one directory per workspace. */
  readonly state: string;
  /** The state of the workspace rooted at `root`, under this state root. */
  workspace(root: string): Workspace;
}

const HOME_DIR = ".foundry";
const STATE_DIR = "marbles";
const ARTIFACTS_DIR = "artifacts";
/** Short on purpose: a Unix socket path has about a hundred bytes to work with. */
const SOCKET_FILE = "marbles.sock";

export function layout(options: LayoutOptions = {}): Layout {
  const env = options.env ?? process.env;
  const home = resolve(
    options.home ?? env.FOUNDRY_HOME ?? join(homedir(), HOME_DIR)
  );
  const state = resolve(options.state ?? join(home, STATE_DIR));
  const artifacts = resolve(
    options.artifacts ??
      (options.state === undefined
        ? join(home, ARTIFACTS_DIR)
        : join(dirname(state), ARTIFACTS_DIR))
  );
  return {
    artifacts,
    home,
    socket: join(state, SOCKET_FILE),
    state,
    workspace: (root) => workspaceState(state, root),
  };
}
