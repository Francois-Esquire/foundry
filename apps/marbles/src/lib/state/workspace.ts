import { createHash } from "node:crypto";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { isRecord, readJson, writeJson } from "~/lib/state/json";

/**
 * State is scoped per workspace: the directory the config lives in, or the
 * cwd without one. Each gets `<state>/<id>/` where `id` hashes the canonical
 * root, so listing the state dir's subdirectories is the registry of every
 * workspace this machine has run — no index file to keep consistent.
 * `workspace.json` says which of them the Marbles process hosts.
 */

export interface Workspace {
  /** `<state>/<id>`: runs, schedules, locks and sessions all live under it. */
  readonly dir: string;
  readonly id: string;
  readonly root: string;
  /** Upsert `workspace.json`: first sight sets `firstSeen`, every sight bumps `lastSeen`. */
  touch(config: string | null, options?: TouchOptions): void;
}

interface TouchOptions {
  /** Whether the Marbles process hosts this workspace; kept as it was when omitted. */
  readonly hosted?: boolean;
}

/** `workspace.json`, as recorded. */
export interface WorkspaceRecord {
  readonly config: string | null;
  readonly firstSeen: string | null;
  /** The Marbles process starts a worker for it. */
  readonly hosted: boolean;
  readonly id: string;
  readonly lastSeen: string | null;
  readonly root: string;
}

const FILE = "workspace.json";

export function workspaceState(state: string, root: string): Workspace {
  const canonical = realpathSync(root);
  const id = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  const dir = join(state, id);
  const path = join(dir, FILE);
  return {
    dir,
    id,
    root: canonical,
    touch(config, options = {}) {
      const now = new Date().toISOString();
      const before = readRecord(path);
      writeJson(path, {
        config,
        firstSeen: before?.firstSeen ?? now,
        hosted: options.hosted ?? before?.hosted ?? false,
        id,
        lastSeen: now,
        root: canonical,
        version: 1,
      });
    },
  };
}

/** The record under `dir`, or `undefined` when there is none it can read. */
export function readWorkspace(dir: string): WorkspaceRecord | undefined {
  return readRecord(join(dir, FILE));
}

/** Every workspace recorded under the state root, by id order. */
export function listWorkspaces(state: string): readonly WorkspaceRecord[] {
  if (!existsSync(state)) {
    return [];
  }
  return readdirSync(state, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readWorkspace(join(state, entry.name)))
    .filter((record) => record !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id));
}

function readRecord(path: string): WorkspaceRecord | undefined {
  const parsed = readJson(path);
  if (
    !isRecord(parsed) ||
    typeof parsed.id !== "string" ||
    typeof parsed.root !== "string"
  ) {
    return undefined;
  }
  return {
    config: typeof parsed.config === "string" ? parsed.config : null,
    firstSeen: typeof parsed.firstSeen === "string" ? parsed.firstSeen : null,
    hosted: parsed.hosted === true,
    id: parsed.id,
    lastSeen: typeof parsed.lastSeen === "string" ? parsed.lastSeen : null,
    root: parsed.root,
  };
}
