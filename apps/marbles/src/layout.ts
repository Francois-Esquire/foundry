import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { ResourceKind } from "~/lib/resources";
import type { Workspace } from "~/lib/state/workspace";
import { workspaceState } from "~/lib/state/workspace";

export interface LayoutOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly home?: string;
}

export interface Layout {
  readonly artifacts: string;
  readonly database: string;
  readonly home: string;
  readonly socket: string;
  readonly spawned: string;
  readonly state: string;
  workspace(root: string): Workspace;
}

const HOME_DIR = ".foundry";
const STATE_DIR = "marbles";
const ARTIFACTS_DIR = "artifacts";
const DATABASE_FILE = "marbles.db";
const SPAWNED_DIR = "spawned";
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

const LINKS_DIR = ".marbles";

export function workspaceLinks(root: string): string {
  return join(resolve(root), LINKS_DIR);
}

export function resourceLinks(root: string, kind: ResourceKind): string {
  return join(workspaceLinks(root), `${kind}s`);
}
