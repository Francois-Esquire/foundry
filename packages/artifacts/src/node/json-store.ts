import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { hasErrorCode, writeFileAtomic } from "@foundry/lib/atomic-file";
import { base64ToBytes, bytesToBase64 } from "@foundry/lib/encoding";
import { acquireFileLock } from "@foundry/lib/file-lock";

import type { ArtifactId, BlobId, ContentId } from "../ref";
import type { Artifact, ArtifactRecords, Blob, Content } from "../schema";
import type {
  ArtifactStore,
  ArtifactStoreWrite,
  BlobListing,
  BlobReferences,
} from "../store";
import { InMemoryArtifactStore } from "../store/memory";

const FORMAT_VERSION = 1;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;

export interface JsonArtifactStoreOptions {
  /** How long a write waits for another process's lock before failing. */
  readonly lockTimeoutMs?: number;
  /** The records file; `<path>.lock` guards writes across processes. */
  readonly path: string;
}

/**
 * An `ArtifactStore` kept in one JSON file: the in-memory store's records,
 * saved by each commit before it takes effect. Interim: it goes when the
 * SQLite store lands.
 *
 * Several processes may share the file. A commit or transaction holds
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

  commit(write: ArtifactStoreWrite): Promise<void> {
    return this.#locked(() => this.#commit(write));
  }

  /** `work` runs holding the lock; its view reads and commits without taking it again. */
  transaction<T>(work: (view: ArtifactStore) => Promise<T>): Promise<T> {
    return this.#locked(() =>
      work({
        commit: (write) => this.#commit(write),
        findBlobs: (digest) => this.findBlobs(digest),
        findReferences: (id) => this.findReferences(id),
        getArtifact: (id) => this.getArtifact(id),
        getBlob: (id) => this.getBlob(id),
        getContent: (id) => this.getContent(id),
        listArtifacts: () => this.listArtifacts(),
        listBlobs: () => this.listBlobs(),
        listContents: (artifactId) => this.listContents(artifactId),
      })
    );
  }

  async findBlobs(digest: string): Promise<readonly Blob[]> {
    return (await this.#current()).findBlobs(digest);
  }

  async findReferences(id: BlobId): Promise<BlobReferences> {
    return (await this.#current()).findReferences(id);
  }

  async getArtifact(id: ArtifactId): Promise<Artifact | null> {
    return (await this.#current()).getArtifact(id);
  }

  async getBlob(id: BlobId): Promise<Blob | null> {
    return (await this.#current()).getBlob(id);
  }

  async getContent(id: ContentId): Promise<Content | null> {
    return (await this.#current()).getContent(id);
  }

  async listArtifacts(): Promise<readonly Artifact[]> {
    return (await this.#current()).listArtifacts();
  }

  async listBlobs(): Promise<readonly BlobListing[]> {
    return (await this.#current()).listBlobs();
  }

  async listContents(artifactId?: ArtifactId): Promise<readonly Content[]> {
    return (await this.#current()).listContents(artifactId);
  }

  /** One writer at a time: in this process by turns, across processes by the lock file. */
  #locked<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#writes.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      const release = await acquireFileLock(`${this.#path}.lock`, {
        breakStale: true,
        waitMs: this.#lockTimeoutMs,
      });
      try {
        return await work();
      } finally {
        await release();
      }
    });
    this.#writes = run.catch(() => undefined);
    return run;
  }

  /** Applies `write` to the current records and saves them; held under the lock. */
  async #commit(write: ArtifactStoreWrite): Promise<void> {
    const next = new InMemoryArtifactStore({
      records: await (await this.#current()).records(),
    });
    await next.commit(write);
    await writeFileAtomic(this.#path, encodeRecords(await next.records()), {
      fsync: true,
      mode: 0o600,
    });
    this.#memory = next;
    this.#version = await fileVersion(this.#path);
  }

  /** The in-memory records, reloaded when another writer replaced the file. */
  async #current(): Promise<InMemoryArtifactStore> {
    const version = await fileVersion(this.#path);
    if (this.#memory && version === this.#version) {
      return this.#memory;
    }
    const text =
      version === undefined ? undefined : await readFile(this.#path, "utf8");
    this.#memory = new InMemoryArtifactStore(
      text === undefined ? {} : { records: decodeRecords(text) }
    );
    this.#version = version;
    return this.#memory;
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
