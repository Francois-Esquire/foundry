import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";

import { isRecord, readJson, writeJson } from "~/state/json";

/**
 * State is scoped per workspace: the directory the config lives in, or the
 * cwd without one. Each gets `<state>/<id>/` where `id` hashes the canonical
 * root, so listing the state dir's subdirectories is the registry of every
 * workspace this machine has run — no index file to keep consistent.
 */

export interface Workspace {
  /** `<state>/<id>`: runs, schedules, locks and sessions all live under it. */
  readonly dir: string;
  readonly id: string;
  readonly root: string;
  /** Upsert `workspace.json`: first sight sets `firstSeen`, every sight bumps `lastSeen`. */
  touch(config: string | null): void;
}

export function workspaceState(state: string, root: string): Workspace {
  const canonical = realpathSync(root);
  const id = createHash("sha256").update(canonical).digest("hex").slice(0, 12);
  const dir = join(state, id);
  const path = join(dir, "workspace.json");
  return {
    dir,
    id,
    root: canonical,
    touch(config) {
      const now = new Date().toISOString();
      writeJson(path, {
        config,
        firstSeen: firstSeen(path) ?? now,
        id,
        lastSeen: now,
        root: canonical,
        version: 1,
      });
    },
  };
}

function firstSeen(path: string): string | undefined {
  const parsed = readJson(path);
  return isRecord(parsed) && typeof parsed.firstSeen === "string"
    ? parsed.firstSeen
    : undefined;
}
