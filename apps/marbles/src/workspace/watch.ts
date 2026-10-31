import { createHash } from "node:crypto";
import { statSync } from "node:fs";

import { sourceFiles } from "~/workspace/source";

/**
 * Whether the authoring source changed, decided by polling: a digest of
 * every module under it (helpers included, since an entry imports them)
 * with its size and modification time, taken on a cadence and compared
 * with the last. Globs elsewhere in Marbles are polled the same way, and a
 * poll holds no watcher handle a process has to close.
 */

/** How often the source is looked at. */
const SOURCE_POLL_MS = 1000;

/** A digest of the source as it is now; `undefined` when nothing is there. */
export function sourceDigest(configPath: string): string | undefined {
  const files = sourceFiles(configPath, { helpers: true });
  if (files === undefined) {
    return undefined;
  }
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file);
    hash.update("\0");
    try {
      const stat = statSync(file);
      hash.update(`${String(stat.size)}:${String(stat.mtimeMs)}`);
    } catch {
      hash.update("missing");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

interface WatchSourceOptions {
  readonly intervalMs?: number;
  /** Called once per change with the new digest; `undefined` when the source is gone. */
  readonly onChange: (digest: string | undefined) => void;
  readonly signal: AbortSignal;
}

/**
 * Poll the source until `signal` aborts and report each change. The first
 * poll sets the baseline: nothing is reported for the state the watcher
 * started in.
 */
export function watchSource(
  configPath: string,
  { intervalMs = SOURCE_POLL_MS, onChange, signal }: WatchSourceOptions
): void {
  if (signal.aborted) {
    return;
  }
  let last = sourceDigest(configPath);
  const timer = setInterval(() => {
    const next = sourceDigest(configPath);
    if (next !== last) {
      last = next;
      onChange(next);
    }
  }, intervalMs);
  // A poll must not keep a process alive by itself.
  timer.unref();
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
}
