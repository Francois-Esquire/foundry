import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { base64ToBytes, bytesToBase64 } from "@foundry/lib/encoding";

import type { ArtifactRecords } from "../memory";
import { commitTransaction, InMemoryArtifactStore } from "../memory";
import type { ArtifactStore, ArtifactStoreTransaction } from "../store";
import { hasErrorCode, writeAtomically } from "./fs";

const FORMAT_VERSION = 1;
const LOCK_RETRY_MS = 25;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;

export interface JsonArtifactStoreOptions {
  /** How long a write waits for another process's lock before failing. */
  readonly lockTimeoutMs?: number;
  /** The records file; `<path>.lock` guards writes across processes. */
  readonly path: string;
}

/**
 * An `ArtifactStore` kept in one JSON file: the in-memory store's semantics,
 * saved before each write transaction commits.
 *
 * Several processes may share the file. A write transaction holds
 * `<path>.lock`, reloads the file, and replaces it by temp-and-rename, so it
 * never commits against stale records. Reads reload when the file changed.
 * The whole file is rewritten per commit, which suits a local feed's scale
 * rather than a large catalogue.
 *
 * An unreadable records file fails loudly: silently starting empty would let
 * the next commit discard every Artifact.
 */
export class JsonArtifactStore implements ArtifactStore {
  readonly #path: string;
  readonly #lockTimeoutMs: number;
  #memory: InMemoryArtifactStore | undefined;
  #version: string | undefined;
  #writes: Promise<unknown> = Promise.resolve();

  constructor(options: JsonArtifactStoreOptions) {
    this.#path = options.path;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  async transaction<T>(
    operation: (store: ArtifactStoreTransaction) => Promise<T>,
    options?: { readonly readOnly?: boolean }
  ): Promise<T> {
    if (options?.readOnly) {
      const memory = await this.#current();
      return memory.transaction(operation, options);
    }
    // Post-commit work runs after the lock and the write slot are released:
    // a callback that writes to this store again (the filesystem binding
    // does) would otherwise wait behind the transaction waiting for it.
    const run = this.#writes.then(async () => {
      const release = await lock(`${this.#path}.lock`, this.#lockTimeoutMs);
      try {
        const memory = await this.#current();
        return await memory[commitTransaction](operation, options);
      } finally {
        await release();
      }
    });
    this.#writes = run.catch(() => undefined);
    // After-commit work (such as applying the commit to disk) runs once the
    // lock is free, so it may open the next write transaction itself.
    return run.then(async ({ afterCommit, result }) => {
      await afterCommit();
      return result;
    });
  }

  /** The in-memory records, reloaded when another writer replaced the file. */
  async #current(): Promise<InMemoryArtifactStore> {
    const version = await fileVersion(this.#path);
    if (this.#memory && version === this.#version) {
      return this.#memory;
    }
    const text =
      version === undefined ? undefined : await readFile(this.#path, "utf8");
    this.#memory = new InMemoryArtifactStore({
      commit: (records) => this.#save(records),
      ...(text === undefined ? {} : { records: decodeRecords(text) }),
    });
    this.#version = version;
    return this.#memory;
  }

  async #save(records: ArtifactRecords): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true });
    await writeAtomically(
      this.#path,
      `${this.#path}.${crypto.randomUUID()}.tmp`,
      encodeRecords(records)
    );
    this.#version = await fileVersion(this.#path);
  }
}

async function fileVersion(path: string): Promise<string | undefined> {
  try {
    const stats = await stat(path);
    return `${stats.ino}:${stats.mtimeMs}:${stats.size}`;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
}

/**
 * An exclusive `wx` lock file holding the owner's pid. A lock whose pid is
 * dead is stale and replaced; a live one is waited on until the timeout.
 */
async function lock(
  path: string,
  timeoutMs: number
): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(String(process.pid));
      } finally {
        await file.close();
      }
      return () => unlink(path).catch(() => undefined);
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
    }
    const holder = await lockHolder(path);
    if (holder !== undefined && !alive(holder)) {
      await unlink(path).catch(() => undefined);
      continue;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for artifact store lock ${path}`);
    }
    await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
  }
}

async function lockHolder(path: string): Promise<number | undefined> {
  // An empty read means the lock was released after the failed open.
  const pid = Number(await readFile(path, "utf8").catch(() => ""));
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

/** `EPERM` counts as alive: the pid exists but belongs to another user. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return hasErrorCode(error, "EPERM");
  }
}

// ── Encoding ──
// JSON has no Date or byte type; tag them so metadata keeps its shape. A
// stored object that already looks like a tag is wrapped in `$object`, so
// metadata such as `{ "$date": "…" }` reloads as written.

const DATE_TAG = "$date";
const BYTES_TAG = "$bytes";
const OBJECT_TAG = "$object";
const TAGS: ReadonlySet<string> = new Set([BYTES_TAG, DATE_TAG, OBJECT_TAG]);

interface StoredRecords extends ArtifactRecords {
  readonly version: number;
}

function encodeRecords(records: ArtifactRecords): string {
  return JSON.stringify(
    encodeValue({ version: FORMAT_VERSION, ...records }),
    null,
    2
  );
}

function decodeRecords(text: string): ArtifactRecords {
  const parsed = decodeValue(JSON.parse(text)) as Partial<StoredRecords>;
  if (
    parsed.version !== FORMAT_VERSION ||
    !Array.isArray(parsed.artifacts) ||
    !Array.isArray(parsed.blobs) ||
    !Array.isArray(parsed.contents)
  ) {
    throw new Error("Unrecognized artifact records file");
  }
  return {
    artifacts: parsed.artifacts,
    blobs: parsed.blobs,
    contents: parsed.contents,
  };
}

function encodeValue(value: unknown): unknown {
  if (value instanceof Date) {
    return { [DATE_TAG]: value.toISOString() };
  }
  if (value instanceof Uint8Array) {
    return { [BYTES_TAG]: bytesToBase64(value) };
  }
  if (Array.isArray(value)) {
    return value.map(encodeValue);
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value);
    const encoded = Object.fromEntries(
      entries.map(([key, entry]) => [key, encodeValue(entry)])
    );
    const [first] = entries;
    return entries.length === 1 && first && TAGS.has(first[0])
      ? { [OBJECT_TAG]: encoded }
      : encoded;
  }
  return value;
}

function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(decodeValue);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const entries = Object.entries(value);
  const [first] = entries;
  if (entries.length === 1 && first) {
    const [tag, inner] = first;
    if (tag === OBJECT_TAG && isPlainObject(inner)) {
      return decodeEntries(Object.entries(inner));
    }
    if (tag === DATE_TAG && typeof inner === "string") {
      return new Date(inner);
    }
    if (tag === BYTES_TAG && typeof inner === "string") {
      return base64ToBytes(inner);
    }
  }
  return decodeEntries(entries);
}

function decodeEntries(entries: [string, unknown][]): Record<string, unknown> {
  return Object.fromEntries(
    entries.map(([key, entry]) => [key, decodeValue(entry)])
  );
}

function isPlainObject(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
