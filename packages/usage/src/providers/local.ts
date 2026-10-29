import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { createInterface } from "node:readline";

/** This machine as a provider reads it: files, the environment, and PATH. */

export type Env = Readonly<Record<string, string | undefined>>;

const FINGERPRINT_LENGTH = 16;
const READ_CONCURRENCY = 8;

/** `~` and `~/…` from `home`, then made absolute. */
export const expandHome = (dir: string, home: string): string => {
  if (dir === "~") {
    return home;
  }
  return resolve(dir.startsWith("~/") ? join(home, dir.slice(2)) : dir);
};

export const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false
  );

/** An API key's stable id: a short hash of it, never the key. */
export const fingerprint = (key: string): string =>
  `api-key:${createHash("sha256").update(key).digest("hex").slice(0, FINGERPRINT_LENGTH)}`;

/** A spawned client's environment: the host's, without `drop`, with `set` over it. */
export const childEnv = (
  env: Env,
  drop: readonly string[],
  set: Readonly<Record<string, string>> = {}
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && !drop.includes(key)) {
      result[key] = value;
    }
  }
  return { ...result, ...set };
};

/** The first executable named `name` on the environment's PATH. */
export const which = async (
  name: string,
  env: Env
): Promise<string | undefined> => {
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const path = join(dir, name);
    const found = await access(path, constants.X_OK).then(
      () => true,
      () => false
    );
    if (found) {
      return path;
    }
  }
};

const walk = async (dir: string, found: string[]): Promise<void> => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path, found);
    } else if (entry.name.endsWith(".jsonl")) {
      found.push(path);
    }
  }
};

/**
 * Every `.jsonl` file under `roots` last written at or after `since`, by path. History
 * is only appended, so an older file holds nothing in the span. A missing root
 * has no files.
 */
export const historyFiles = async (
  roots: readonly string[],
  since: Date
): Promise<string[]> => {
  const candidates: string[] = [];
  for (const root of roots) {
    await walk(root, candidates);
  }
  const fresh = await mapLimit(candidates, async (path) => {
    const info = await stat(path).catch(() => undefined);
    return info && info.mtimeMs >= since.getTime() ? path : undefined;
  });
  // Sorted, so which copy of repeated work counts first is the same each read.
  return fresh.filter((path) => path !== undefined).sort();
};

/** `map` over `items`, a few at a time, in order. */
export const mapLimit = async <T, R>(
  items: readonly T[],
  map: (item: T) => Promise<R>
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await map(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: READ_CONCURRENCY }, worker));
  return results;
};

/**
 * Each line of a file that contains one of `markers`, parsed as JSON. Other
 * lines, most of any transcript, are never parsed; unparsable ones are skipped.
 */
export async function* jsonLines(
  path: string,
  markers: readonly string[]
): AsyncGenerator<unknown> {
  const lines = createInterface({
    crlfDelay: Number.POSITIVE_INFINITY,
    input: createReadStream(path, { encoding: "utf8" }),
  });
  for await (const line of lines) {
    if (!markers.some((marker) => line.includes(marker))) {
      continue;
    }
    try {
      yield JSON.parse(line);
    } catch {
      // A line cut short by a write in progress.
    }
  }
}
