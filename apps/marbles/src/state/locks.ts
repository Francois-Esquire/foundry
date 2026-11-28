import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { FileLockHolder } from "@foundry/lib/node/file-lock";
import { tryFileLock } from "@foundry/lib/node/file-lock";
import { isGone } from "@foundry/lib/node/process-identity";

export const PROCESS_LOCK = "process";

export interface Lock {
  release(): void;
}

export interface HeldLock {
  readonly holder: string;
}

export function acquireLock(dir: string, name: string): Lock | HeldLock {
  mkdirSync(join(dir, "locks"), { recursive: true });
  const path = join(dir, "locks", name);
  const attempt = tryFileLock(path, { breakStale: true });
  return "release" in attempt
    ? attempt
    : { holder: describeHolder(path, attempt) };
}

function describeHolder(
  path: string,
  { empty, holder, owner }: FileLockHolder
): string {
  if (empty) {
    return "a process that is taking it now; retry";
  }
  if (holder === undefined) {
    return `an unknown process (if none is running, remove ${path})`;
  }
  if (!isGone(owner ?? { pid: holder, started: null })) {
    return `pid ${String(holder)}`;
  }
  return `pid ${String(holder)}, which has exited (if no process is taking the lock over, remove ${path}.break)`;
}
