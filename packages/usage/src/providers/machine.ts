import { constants, createReadStream } from "node:fs";
import { access, readdir, stat } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { mapWithConcurrency } from "../usage";

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

const isEnoent = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

const missing =
  <T>(fallback: T) =>
  (error: unknown): T => {
    if (isEnoent(error)) {
      return fallback;
    }
    throw error;
  };

const walk = async (
  dir: string,
  found: string[],
  signal?: AbortSignal
): Promise<void> => {
  signal?.throwIfAborted();
  const entries = await readdir(dir, { withFileTypes: true }).catch(
    missing([])
  );
  signal?.throwIfAborted();
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(path, found, signal);
    } else if (entry.name.endsWith(".jsonl")) {
      found.push(path);
    }
  }
};

export const historyFiles = async (
  roots: readonly string[],
  since: Date,
  signal?: AbortSignal
): Promise<string[]> => {
  signal?.throwIfAborted();
  const candidates: string[] = [];
  for (const root of roots) {
    await walk(root, candidates, signal);
  }
  const fresh = await mapLimit(candidates, async (path) => {
    signal?.throwIfAborted();
    const info = await stat(path).catch(missing(undefined));
    return info && info.mtimeMs >= since.getTime() ? path : undefined;
  });
  return fresh.filter((path) => path !== undefined).sort();
};

export const mapLimit = <T, R>(
  items: readonly T[],
  map: (item: T) => Promise<R>
): Promise<R[]> => mapWithConcurrency(items, READ_CONCURRENCY, map);

export async function* jsonLines(
  path: string,
  markers: readonly string[],
  signal?: AbortSignal
): AsyncGenerator<unknown> {
  signal?.throwIfAborted();
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({
    crlfDelay: Number.POSITIVE_INFINITY,
    input: stream,
  });
  try {
    for await (const line of lines) {
      signal?.throwIfAborted();
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
  } catch (error) {
    if (isEnoent(error)) {
      return;
    }
    throw error;
  } finally {
    lines.close();
    stream.destroy();
  }
}

export const within = async <T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  signal?: AbortSignal
): Promise<T> => {
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    if (signal) {
      onAbort = () =>
        reject(signal.reason ?? new Error("The operation was aborted."));
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  promise.catch(() => undefined);
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
};
