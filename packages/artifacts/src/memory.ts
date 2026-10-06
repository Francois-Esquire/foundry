import type { Page } from "@foundry/core/pagination";
import { StorageApplicationError } from "@foundry/core/storage";
import { byCodeUnit } from "@foundry/lib/ordering";
import { pageFromRows, pageLimit } from "@foundry/lib/pagination";

import type { Blob } from "./blob";
import { validateBlob } from "./blob";
import type { ArtifactCursor } from "./listing";
import { artifactCursor, normalizeArtifactQuery } from "./listing";
import type { ArtifactId, BlobId, ContentId } from "./ref";
import type { ArtifactStore, ArtifactStoreTransaction } from "./store";
import type {
  Artifact,
  Content,
  ListArtifactsInput,
  ListContentsInput,
} from "./substrate";

interface Records {
  readonly artifacts: Map<ArtifactId, Artifact>;
  readonly blobs: Map<BlobId, Blob>;
  readonly contents: Map<ContentId, Content>;
}

/** A store's records as plain arrays: what a persistent host loads and saves. */
export interface ArtifactRecords {
  readonly artifacts: readonly Artifact[];
  readonly blobs: readonly Blob[];
  readonly contents: readonly Content[];
}

export interface InMemoryArtifactStoreOptions {
  /**
   * Awaited with the complete records before a write transaction's changes
   * become visible. A rejection fails the transaction and keeps the previous
   * records, so a host can make persistence part of the commit.
   */
  readonly commit?: (records: ArtifactRecords) => Promise<void>;
  /** Starting records; cloned, so the caller keeps ownership. */
  readonly records?: ArtifactRecords;
}

/** Serialized transactions over copy-on-write maps of cloned records. */
export class InMemoryArtifactStore implements ArtifactStore {
  #records: Records;
  #pending: Promise<void> = Promise.resolve();
  readonly #commit: InMemoryArtifactStoreOptions["commit"];

  constructor(options: InMemoryArtifactStoreOptions = {}) {
    this.#commit = options.commit;
    const { artifacts, blobs, contents } = structuredClone(
      options.records ?? { artifacts: [], blobs: [], contents: [] }
    );
    this.#records = {
      artifacts: new Map(artifacts.map((row) => [row.id, row])),
      blobs: new Map(blobs.map((row) => [row.id, row])),
      contents: new Map(contents.map((row) => [row.id, row])),
    };
  }

  /** A clone of every committed record. */
  async records(): Promise<ArtifactRecords> {
    await this.#pending;
    return recordsOf(this.#records);
  }

  async transaction<T>(
    operation: (store: ArtifactStoreTransaction) => Promise<T>,
    options?: { readonly readOnly?: boolean }
  ): Promise<T> {
    const previous = this.#pending;
    let release!: () => void;
    this.#pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const transaction = new InMemoryTransaction(
      {
        artifacts: new Map(this.#records.artifacts),
        blobs: new Map(this.#records.blobs),
        contents: new Map(this.#records.contents),
      },
      options?.readOnly ?? false
    );
    let result: T;
    try {
      result = await operation(transaction);
      if (this.#commit && !transaction.readOnly) {
        await this.#commit(recordsOf(transaction.records));
      }
      this.#records = transaction.records;
    } finally {
      transaction.settle();
      release();
    }
    await runAfterCommit(transaction.callbacks);
    return result;
  }
}

class InMemoryTransaction implements ArtifactStoreTransaction {
  readonly records: Records;
  readonly readOnly: boolean;
  readonly callbacks: (() => Promise<void>)[] = [];
  #active: boolean;

  constructor(records: Records, readOnly: boolean) {
    this.records = records;
    this.readOnly = readOnly;
    this.#active = true;
  }

  settle(): void {
    this.#active = false;
  }

  afterCommit(operation: () => Promise<void>): void {
    this.#assertWritable();
    this.callbacks.push(operation);
  }

  async getArtifact(id: ArtifactId): Promise<Artifact | null> {
    this.#assertActive();
    return structuredClone(this.records.artifacts.get(id) ?? null);
  }

  async listArtifacts(
    input: ListArtifactsInput
  ): Promise<Page<Artifact, ArtifactCursor>> {
    this.#assertActive();
    const query = normalizeArtifactQuery(input.query)?.toLowerCase();
    const matches = [...this.records.artifacts.values()]
      .filter(
        (row) =>
          ((input.includeArchived ?? false) || row.status !== "archived") &&
          (input.type === undefined || row.type === input.type) &&
          (query === undefined ||
            [row.name, row.type, row.id].some((value) =>
              value.toLowerCase().includes(query)
            ))
      )
      .sort(compareCreated);
    const rows = matches
      .filter(
        (row) =>
          input.cursor === undefined ||
          row.createdAt.getTime() > input.cursor.createdAt.getTime() ||
          (row.createdAt.getTime() === input.cursor.createdAt.getTime() &&
            row.id > input.cursor.id)
      )
      .slice(0, pageLimit(input.limit) + 1);
    return structuredClone(
      pageFromRows(rows, pageLimit(input.limit), matches.length, artifactCursor)
    );
  }

  async putArtifact(artifact: Artifact): Promise<void> {
    this.#assertWritable();
    if (
      artifact.contentId !== null &&
      this.records.contents.get(artifact.contentId)?.artifactId !== artifact.id
    ) {
      throw new Error("Artifact pointer must name its own Content");
    }
    this.records.artifacts.set(artifact.id, structuredClone(artifact));
  }

  async deleteArtifact(id: ArtifactId): Promise<void> {
    this.#assertWritable();
    this.records.artifacts.delete(id);
    for (const content of this.records.contents.values()) {
      if (content.artifactId === id) {
        this.records.contents.delete(content.id);
      }
    }
  }

  async getContent(id: ContentId): Promise<Content | null> {
    this.#assertActive();
    return structuredClone(this.records.contents.get(id) ?? null);
  }

  async listContents(
    artifactId?: ArtifactId,
    input: ListContentsInput = {}
  ): Promise<readonly Content[]> {
    this.#assertActive();
    const states =
      typeof input.state === "string" ? [input.state] : input.state;
    return structuredClone(
      [...this.records.contents.values()]
        .filter(
          (row) =>
            (artifactId === undefined || row.artifactId === artifactId) &&
            (states === undefined || states.includes(row.state)) &&
            (input.tagged === undefined || (row.tag !== null) === input.tagged)
        )
        .sort(compareCreated)
    );
  }

  async putContent(content: Content): Promise<void> {
    this.#assertWritable();
    if (!this.records.artifacts.has(content.artifactId)) {
      throw new Error("Content requires an Artifact");
    }
    this.records.contents.set(content.id, structuredClone(content));
  }

  async deleteContent(id: ContentId): Promise<void> {
    this.#assertWritable();
    if (
      [...this.records.artifacts.values()].some(
        (artifact) => artifact.contentId === id
      )
    ) {
      throw new Error("Cannot delete active Content");
    }
    this.records.contents.delete(id);
  }

  async getBlob(id: BlobId): Promise<Blob | null> {
    this.#assertActive();
    return structuredClone(this.records.blobs.get(id) ?? null);
  }

  async findBlob(digest: string): Promise<Blob | null> {
    this.#assertActive();
    return structuredClone(
      [...this.records.blobs.values()].find((blob) => blob.digest === digest) ??
        null
    );
  }

  async listBlobs(): Promise<readonly Pick<Blob, "id" | "path">[]> {
    this.#assertActive();
    return [...this.records.blobs.values()].map((blob) => ({
      id: blob.id,
      ...(blob.path ? { path: blob.path } : {}),
    }));
  }

  async putBlob(blob: Blob): Promise<void> {
    this.#assertWritable();
    validateBlob(blob);
    if (
      blob.path !== undefined &&
      [...this.records.blobs.values()].some(
        (other) => other.id !== blob.id && other.path === blob.path
      )
    ) {
      throw new Error("Blob backing path already belongs to another blob");
    }
    this.records.blobs.set(blob.id, structuredClone(blob));
  }

  async deleteBlob(id: BlobId): Promise<void> {
    this.#assertWritable();
    this.records.blobs.delete(id);
  }

  async isBlobReferenced(
    id: BlobId,
    except?: { readonly contentId: ContentId; readonly path: string }
  ): Promise<boolean> {
    this.#assertActive();
    for (const content of this.records.contents.values()) {
      for (const [path, node] of Object.entries(content.tree)) {
        if (
          node.type === "file" &&
          node.blobId === id &&
          !(except?.contentId === content.id && except.path === path)
        ) {
          return true;
        }
      }
    }
    return [...this.records.blobs.values()].some((blob) =>
      blob.chunks?.includes(id)
    );
  }

  #assertActive(): void {
    if (!this.#active) {
      throw new Error("Artifact transaction has settled");
    }
  }

  #assertWritable(): void {
    this.#assertActive();
    if (this.readOnly) {
      throw new Error("Artifact transaction is read-only");
    }
  }
}

/** Run every callback; one failure rethrows as-is, several aggregate. */
async function runAfterCommit(
  callbacks: readonly (() => Promise<void>)[]
): Promise<void> {
  const failures: unknown[] = [];
  for (const callback of callbacks) {
    try {
      await callback();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new StorageApplicationError(
      "Committed transaction application failed",
      {
        cause: new AggregateError(
          failures,
          "Artifact after-commit callbacks failed"
        ),
      }
    );
  }
}

function recordsOf(records: Records): ArtifactRecords {
  return structuredClone({
    artifacts: [...records.artifacts.values()],
    blobs: [...records.blobs.values()],
    contents: [...records.contents.values()],
  });
}

const compareIds = byCodeUnit((value: { id: string }) => value.id);

function compareCreated(
  a: { createdAt: Date; id: string },
  b: { createdAt: Date; id: string }
): number {
  return a.createdAt.getTime() - b.createdAt.getTime() || compareIds(a, b);
}
