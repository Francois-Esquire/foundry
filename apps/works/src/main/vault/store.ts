import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** The storage surface the vault drives. One per tier. */
export interface KeyValueStore {
  delete(key: string): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

/** Process-local store for tests and for a vault that must not touch disk. */
export class MemoryStore implements KeyValueStore {
  readonly #entries = new Map<string, string>();

  delete(key: string): Promise<void> {
    this.#entries.delete(key);
    return Promise.resolve();
  }

  get(key: string): Promise<string | null> {
    return Promise.resolve(this.#entries.get(key) ?? null);
  }

  set(key: string, value: string): Promise<void> {
    this.#entries.set(key, value);
    return Promise.resolve();
  }
}

/**
 * A flat string map persisted as one JSON document. Reads load the file once;
 * writes replace it atomically (write beside, then rename) so a crash cannot
 * leave a half-written file behind.
 */
export class JsonFileStore implements KeyValueStore {
  readonly #filePath: string;
  #entries: Map<string, string> | undefined;
  #loading: Promise<Map<string, string>> | undefined;
  #queue: Promise<void> = Promise.resolve();

  constructor(filePath: string) {
    this.#filePath = filePath;
  }

  delete(key: string): Promise<void> {
    return this.#write((entries) => entries.delete(key));
  }

  async get(key: string): Promise<string | null> {
    const entries = await this.#load();
    return entries.get(key) ?? null;
  }

  set(key: string, value: string): Promise<void> {
    return this.#write((entries) => {
      entries.set(key, value);
      return true;
    });
  }

  /** One read for all callers, so concurrent first calls share a map. */
  #load(): Promise<Map<string, string>> {
    if (this.#entries) {
      return Promise.resolve(this.#entries);
    }
    this.#loading ??= readEntries(this.#filePath).then((entries) => {
      this.#entries = entries;
      return entries;
    });
    return this.#loading;
  }

  #write(update: (entries: Map<string, string>) => boolean): Promise<void> {
    // Queue the whole mutation and publish its map only after disk succeeds.
    const write = this.#queue.then(async () => {
      const entries = new Map(await this.#load());
      if (!update(entries)) {
        return;
      }
      const snapshot = JSON.stringify(Object.fromEntries(entries), null, 2);
      await writeAtomically(this.#filePath, snapshot);
      this.#entries = entries;
    });
    this.#queue = write.catch(() => undefined);
    return write;
  }
}

async function readEntries(filePath: string): Promise<Map<string, string>> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return new Map();
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${filePath} is not a JSON object`);
  }
  const entries = new Map<string, string>();
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") {
      entries.set(key, value);
    }
  }
  return entries;
}

async function writeAtomically(
  filePath: string,
  content: string
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.${process.pid}.tmp`;
  await writeFile(temp, content, { encoding: "utf8", mode: 0o600 });
  await rename(temp, filePath);
}
