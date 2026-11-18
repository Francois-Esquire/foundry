import { createHash } from "node:crypto";
import { statSync } from "node:fs";

import { sourceFiles } from "~/workspace/source";

const SOURCE_POLL_MS = 1000;

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
  readonly onChange: (digest: string | undefined) => void;
  readonly signal: AbortSignal;
}

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
  timer.unref();
  signal.addEventListener("abort", () => clearInterval(timer), { once: true });
}
