import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { hasErrorCode, writeFileAtomic } from "@foundry/lib/atomic-file";
import { base64ToBytes, bytesToBase64 } from "@foundry/lib/encoding";
import { acquireFileLock } from "@foundry/lib/file-lock";
import { Turns } from "@foundry/lib/turns";

import type { ArtifactId, BlobId, ContentId } from "../ref";
import type { Artifact, ArtifactRecords, Blob, Content } from "../schema";
import type {
  ArtifactListing,
  ArtifactListQuery,
  ArtifactStore,
  ArtifactStoreWrite,
  BlobListing,
  BlobReferences,
} from "../store";
import { InMemoryArtifactStore } from "../store/memory";

const FORMAT_VERSION = 1;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
/** Why a call from inside the store's own transaction is refused. */
const REENTRY =
  "JsonArtifactStore was called from inside its own transaction; use the view passed to the transaction's work instead";

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
 * never commits against stale records. Reads outside a transaction reload
 * when the file changed.
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
  readonly #turns = new Turns(REENTRY);

  constructor(options: JsonArtifactStoreOptions) {
    this.#path = options.path;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  commit(write: ArtifactStoreWrite): Promise<void> {
    return this.transaction((view) => view.commit(write));
  }

  /**
   * `work` runs holding the lock, over the records as they are then. Its
   * commits stage in memory, read back through `view`, and are saved as one
   * file replacement once `work` succeeds.
   */
  transaction<T>(work: (view: ArtifactStore) => Promise<T>): Promise<T> {
    return this.#locked(async () => {
      const base = await this.#current();
      /**
       * The staged copy every commit applies to, made once: created before
       * the first commit yields, so concurrent commits share it.
       */
      let staged: Promise<InMemoryArtifactStore> | undefined;
      let open = true;
      /** The records the view reads, rejecting once the transaction settled. */
      const read = <R>(
        take: (records: InMemoryArtifactStore) => Promise<R>
      ): Promise<R> =>
        open
          ? (staged ?? Promise.resolve(base)).then(take)
          : Promise.reject(new Error("Artifact store transaction has settled"));
      const view: ArtifactStore = {
        commit: (write) => {
          if (open) {
            staged ??= base
              .records()
              .then((records) => new InMemoryArtifactStore({ records }));
          }
          return read((records) => records.commit(write));
        },
        findBlobs: (digest) => read((records) => records.findBlobs(digest)),
        findReferences: (id) => read((records) => records.findReferences(id)),
        getArtifact: (id) => read((records) => records.getArtifact(id)),
        getBlob: (id) => read((records) => records.getBlob(id)),
        getContent: (id) => read((records) => records.getContent(id)),
        listArtifacts: (query) =>
          read((records) => records.listArtifacts(query)),
        listBlobs: () => read((records) => records.listBlobs()),
        listContents: (artifactId) =>
          read((records) => records.listContents(artifactId)),
      };
      try {
        const result = await work(view);
        // Settled before saving, so a late commit cannot slip into the save.
        open = false;
        if (staged) {
          await this.#save(await staged);
        }
        return result;
      } finally {
        open = false;
      }
    });
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

  async listArtifacts(query: ArtifactListQuery): Promise<ArtifactListing> {
    return (await this.#current()).listArtifacts(query);
  }

  async listBlobs(): Promise<readonly BlobListing[]> {
    return (await this.#current()).listBlobs();
  }

  async listContents(artifactId?: ArtifactId): Promise<readonly Content[]> {
    return (await this.#current()).listContents(artifactId);
  }

  /**
   * One writer at a time: in this process by turns, across processes by the
   * lock file. A call from inside the running turn is refused at once.
   */
  #locked<T>(work: () => Promise<T>): Promise<T> {
    return this.#turns.run(async () => {
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
  }

  /**
   * Replaces the records file with `next`; held under the lock. The write
   * lands at the rename. A failure after it (syncing the directory) still
   * rejects, and the next read reloads the file it left.
   */
  async #save(next: InMemoryArtifactStore): Promise<void> {
    await writeFileAtomic(this.#path, encodeRecords(await next.records()), {
      fsync: true,
      mode: 0o600,
    });
    // Unknown, the next read compares against the file and reloads it.
    const version = await fileVersion(this.#path).catch(() => undefined);
    // Set together, after the await, so a reload running meanwhile cannot
    // pair its older records with this version.
    this.#memory = next;
    this.#version = version;
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
