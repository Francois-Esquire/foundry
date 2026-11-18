import { constants, createReadStream } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { createInterface } from "node:readline";

export type Env = Readonly<Record<string, string | undefined>>;

const READ_CONCURRENCY = 8;

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

const missing =
  <T>(fallback: T) =>
  (error: unknown): T => {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return fallback;
    }
    throw error;
  };

const walk = async (dir: string, found: string[]): Promise<void> => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(
    missing([])
  );
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path, found);
    } else if (entry.name.endsWith(".jsonl")) {
      found.push(path);
    }
  }
};

export const historyFiles = async (
  roots: readonly string[],
  since: Date
): Promise<string[]> => {
  const candidates: string[] = [];
  for (const root of roots) {
    await walk(root, candidates);
  }
  const fresh = await mapLimit(candidates, async (path) => {
    const info = await stat(path).catch(missing(undefined));
    return info && info.mtimeMs >= since.getTime() ? path : undefined;
  });
  return fresh.filter((path) => path !== undefined).sort();
};

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
      // biome-ignore lint/complexity/noUselessContinue: Skip this rejected line within the generator.
      continue;
    }
  }
}
