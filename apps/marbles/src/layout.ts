import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  FOUNDRY_ROOT_DIR,
  FOUNDRY_ROOT_ENV,
  resolveFoundryPaths,
} from "@foundry/core/paths";

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

const DATABASE_FILE = "marbles.db";
const SOCKET_FILE = "marbles.sock";

export function layout(options: LayoutOptions = {}): Layout {
  const env = options.env ?? process.env;
  const home = resolve(
    options.home ?? (env[FOUNDRY_ROOT_ENV] || join(homedir(), FOUNDRY_ROOT_DIR))
  );
  const {
    artifacts,
    marbles: state,
    processes,
  } = resolveFoundryPaths(home, sep);
  return {
    artifacts,
    database: stateDatabase(state),
    home,
    socket: join(state, SOCKET_FILE),
    spawned: processes,
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
