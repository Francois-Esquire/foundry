import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { Page } from "@foundry/core/pagination";
import { base64ToBytes, bytesToBase64 } from "@foundry/lib/encoding";
import { hasErrorCode, writeFileAtomic } from "@foundry/lib/node/atomic-file";
import { acquireFileLock } from "@foundry/lib/node/file-lock";
import { Turns } from "@foundry/lib/turns";
import type { ArtifactId, BlobId, ContentId } from "../ids";
import {
  ownedBlobPageQuery,
  ownedContentPageQuery,
  ownedListQuery,
} from "../listing";
import type { Artifact, ArtifactRecords, Blob, Content } from "../schema";
import type {
  ArtifactListing,
  ArtifactListQuery,
  ArtifactStore,
  ArtifactStoreWrite,
  BlobListing,
  BlobPageQuery,
  BlobReferences,
  ContentLookup,
  ContentPageQuery,
} from "../store";
import { MemoryArtifactStore } from "../store/memory";
import { ownedWrite } from "../store/owned";

const FORMAT_VERSION = 1;
const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const REENTRY =
  "JsonArtifactStore was called from inside its own transaction; use the view passed to the transaction's work instead";

export interface JsonArtifactStoreOptions {
  readonly lockTimeoutMs?: number;
  readonly path: string;
}

export class JsonArtifactStore implements ArtifactStore {
  readonly #path: string;
  readonly #lockTimeoutMs: number;
  #memory: MemoryArtifactStore | undefined;
  #version: string | undefined;
  readonly #turns = new Turns(REENTRY);

  constructor(options: JsonArtifactStoreOptions) {
    this.#path = options.path;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  }

  commit(write: ArtifactStoreWrite): Promise<void> {
    let copy: ArtifactStoreWrite;
    try {
      copy = ownedWrite(write);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.transaction((view) => view.commit(copy));
  }

  transaction<T>(work: (view: ArtifactStore) => Promise<T>): Promise<T> {
    return this.#locked(async () => {
      const base = await this.#current();
      let staged: Promise<MemoryArtifactStore> | undefined;
      let open = true;
      const read = <R>(
        take: (records: MemoryArtifactStore) => Promise<R>
      ): Promise<R> =>
        open
          ? (staged ?? Promise.resolve(base)).then(take)
          : Promise.reject(new Error("Artifact store transaction has settled"));
      const view: ArtifactStore = {
        commit: (write) => {
          let copy: ArtifactStoreWrite;
          try {
            copy = ownedWrite(write);
          } catch (error) {
            return Promise.reject(error);
          }
          if (open) {
            staged ??= base
              .records()
              .then((records) => new MemoryArtifactStore({ records }));
          }
          return read((records) => records.commit(copy));
        },
        durability: "host",
        findBlobByPath: (path) =>
          read((records) => records.findBlobByPath(path)),
        findBlobs: (digest) => read((records) => records.findBlobs(digest)),
        findContent: (artifactId, by) => {
          let owned: ContentLookup;
          try {
            owned = ownedContentLookup(by);
          } catch (error) {
            return Promise.reject(error);
          }
          return read((records) => records.findContent(artifactId, owned));
        },
        findContentByTag: (artifactId, tag) =>
          read((records) => records.findContentByTag(artifactId, tag)),
        findReferences: (id) => read((records) => records.findReferences(id)),
        getArtifact: (id) => read((records) => records.getArtifact(id)),
        getBlob: (id) => read((records) => records.getBlob(id)),
        getContent: (id) => read((records) => records.getContent(id)),
        listArtifacts: (query) => {
          let owned: ArtifactListQuery;
          try {
            owned = ownedListQuery(query);
          } catch (error) {
            return Promise.reject(error);
          }
          return read((records) => records.listArtifacts(owned));
        },
        listBlobs: () => read((records) => records.listBlobs()),
        listBlobsPage: (query) => {
          let owned: BlobPageQuery;
          try {
            owned = ownedBlobPageQuery(query);
          } catch (error) {
            return Promise.reject(error);
          }
          return read((records) => records.listBlobsPage(owned));
        },
        listContents: (artifactId) =>
          read((records) => records.listContents(artifactId)),
        listContentsPage: (query) => {
          let owned: ContentPageQuery;
          try {
            owned = ownedContentPageInput(query);
          } catch (error) {
            return Promise.reject(error);
          }
          return read((records) => records.listContentsPage(owned));
        },
      };
      try {
        const result = await work(view);
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

  async findBlobByPath(path: string): Promise<Blob | null> {
    return (await this.#current()).findBlobByPath(path);
  }

  async findBlobs(digest: string): Promise<readonly Blob[]> {
    return (await this.#current()).findBlobs(digest);
  }

  async findContent(
    artifactId: ArtifactId,
    by: ContentLookup
  ): Promise<Content | null> {
    const owned = ownedContentLookup(by);
    return (await this.#current()).findContent(artifactId, owned);
  }

  async findContentByTag(
    artifactId: ArtifactId,
    tag: string
  ): Promise<Content | null> {
    return (await this.#current()).findContentByTag(artifactId, tag);
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
    const owned = ownedListQuery(query);
    return (await this.#current()).listArtifacts(owned);
  }

  async listBlobs(): Promise<readonly BlobListing[]> {
    return (await this.#current()).listBlobs();
  }

  async listBlobsPage(
    query?: BlobPageQuery
  ): Promise<Page<BlobListing, BlobId>> {
    const owned = ownedBlobPageQuery(query);
    return (await this.#current()).listBlobsPage(owned);
  }

  async listContents(artifactId?: ArtifactId): Promise<readonly Content[]> {
    return (await this.#current()).listContents(artifactId);
  }

  async listContentsPage(
    query?: ContentPageQuery
  ): Promise<Page<Content, ContentId>> {
    const owned = ownedContentPageInput(query);
    return (await this.#current()).listContentsPage(owned);
  }

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

  async #save(next: MemoryArtifactStore): Promise<void> {
    await writeFileAtomic(this.#path, encodeRecords(await next.records()), {
      fsync: true,
      mode: 0o600,
    });
    const version = await fileVersion(this.#path).catch(() => undefined);
    this.#memory = next;
    this.#version = version;
  }

  async #current(): Promise<MemoryArtifactStore> {
    const version = await fileVersion(this.#path);
    if (this.#memory && version === this.#version) {
      return this.#memory;
    }
    const text =
      version === undefined ? undefined : await readFile(this.#path, "utf8");
    this.#memory = new MemoryArtifactStore(
      text === undefined ? {} : { records: decodeRecords(text) }
    );
    this.#version = version;
    return this.#memory;
  }
}

function ownedContentLookup(by: ContentLookup): ContentLookup {
  return { messageId: by.messageId, sessionId: by.sessionId };
}

function ownedContentPageInput(
  query: ContentPageQuery | undefined
): ContentPageQuery {
  const owned = ownedContentPageQuery(query);
  return {
    ...(owned.artifactId === undefined ? {} : { artifactId: owned.artifactId }),
    ...(owned.cursor === undefined ? {} : { cursor: owned.cursor }),
    limit: owned.limit,
    ...(owned.states === undefined ? {} : { state: [...owned.states] }),
    ...(owned.tagged === undefined ? {} : { tagged: owned.tagged }),
  };
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
    if (tag === OBJECT_TAG && isRecord(inner)) {
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

function isRecord(value: unknown): value is object {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
