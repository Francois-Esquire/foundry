import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { hasCode } from "~/state/json";

/**
 * `<workspace>/locks/<schedule>` holds the pid of the tick running it, so a
 * launchd tick that lands while the previous one is still going skips rather
 * than doubles up. Created with `wx` so two ticks cannot both win; a lock
 * whose pid is dead is stale and gets replaced.
 */

export interface Lock {
  release(): void;
}

/** The lock, or the pid of the live process holding it. */
export function acquireLock(dir: string, name: string): Lock | number {
  const path = join(dir, "locks", name);
  mkdirSync(join(dir, "locks"), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, String(process.pid), { flag: "wx" });
      return {
        release: () => {
          rmSync(path, { force: true });
        },
      };
    } catch (error) {
      if (!hasCode(error, "EEXIST")) {
        throw error;
      }
    }
    const holder = holderPid(path);
    if (holder !== undefined && alive(holder)) {
      return holder;
    }
    rmSync(path, { force: true });
  }
  throw new Error(`quirks: lock ${name} keeps changing hands`);
}

export function holderPid(path: string): number | undefined {
  try {
    const pid = Number(readFileSync(path, "utf8"));
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** `EPERM` counts as alive: the pid exists but belongs to another user. */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasCode(error, "EPERM");
  }
}
