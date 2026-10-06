import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { base64ToBytes, bytesToBase64 } from "@foundry/lib/encoding";

import type { ArtifactRecords } from "../memory";
import { InMemoryArtifactStore } from "../memory";
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

  transaction<T>(
    operation: (store: ArtifactStoreTransaction) => Promise<T>,
    options?: { readonly readOnly?: boolean }
  ): Promise<T> {
    if (options?.readOnly) {
      return this.#current().then((memory) =>
        memory.transaction(operation, options)
      );
    }
    const run = this.#writes.then(async () => {
      const release = await lock(`${this.#path}.lock`, this.#lockTimeoutMs);
      try {
        const memory = await this.#current();
        return await memory.transaction(operation, options);
      } finally {
        await release();
      }
    });
    this.#writes = run.catch(() => undefined);
    return run;
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
// JSON has no Date or byte type; tag them so metadata keeps its shape.

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
    return { $date: value.toISOString() };
  }
  if (value instanceof Uint8Array) {
    return { $bytes: bytesToBase64(value) };
  }
  if (Array.isArray(value)) {
    return value.map(encodeValue);
  }
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, encodeValue(entry)])
    );
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
  if (entries.length === 1 && first && typeof first[1] === "string") {
    if (first[0] === "$date") {
      return new Date(first[1]);
    }
    if (first[0] === "$bytes") {
      return base64ToBytes(first[1]);
    }
  }
  return Object.fromEntries(
    entries.map(([key, entry]) => [key, decodeValue(entry)])
  );
}
