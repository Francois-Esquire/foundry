import type { Page } from "@foundry/core/pagination";
import { StorageApplicationError } from "@foundry/core/storage";
import { byCodeUnit } from "@foundry/lib/ordering";
import { pageFromRows, pageLimit } from "@foundry/lib/pagination";

import type { Blob } from "./blob";
import { validateBlob } from "./blob";
import type { ArtifactCursor } from "./pagination";
import { artifactCursor, normalizeArtifactQuery } from "./pagination";
import type { ArtifactId, BlobId, ContentId } from "./ref";
import type { ArtifactStore } from "./store";
import type {
  Artifact,
  Content,
  ListArtifactsInput,
  ListContentsInput,
} from "./substrate";

interface Records {
  artifacts: Map<ArtifactId, Artifact>;
  blobs: Map<BlobId, Blob>;
  contents: Map<ContentId, Content>;
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

interface Transaction {
  active: boolean;
  readonly callbacks: (() => Promise<void>)[];
  readonly readOnly: boolean;
}

export class InMemoryArtifactStore implements ArtifactStore {
  #records: Records = {
    artifacts: new Map(),
    blobs: new Map(),
    contents: new Map(),
  };
  #pending: Promise<void> = Promise.resolve();
  readonly #commit: InMemoryArtifactStoreOptions["commit"];
  // biome-ignore lint/style/useReadonlyClassProperties: Transaction setup assigns this field on a scoped instance.
  #transaction: Transaction | undefined;

  constructor(options: InMemoryArtifactStoreOptions = {}) {
    this.#commit = options.commit;
    if (options.records) {
      const { artifacts, blobs, contents } = structuredClone(options.records);
      this.#records = {
        artifacts: new Map(artifacts.map((row) => [row.id, row])),
        blobs: new Map(blobs.map((row) => [row.id, row])),
        contents: new Map(contents.map((row) => [row.id, row])),
      };
    }
  }

  /** A clone of every record, outside any transaction. */
  async records(): Promise<ArtifactRecords> {
    await this.#ready();
    return recordsOf(this.#records);
  }

  async transaction<T>(
    operation: (store: ArtifactStore) => Promise<T>,
    options?: { readonly readOnly?: boolean }
  ): Promise<T> {
    if (this.#transaction) {
      this.#assertActive();
      return operation(this);
    }
    const previous = this.#pending;
    let release!: () => void;
    this.#pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const scoped = new InMemoryArtifactStore();
    scoped.#records = {
      artifacts: new Map(this.#records.artifacts),
      blobs: new Map(this.#records.blobs),
      contents: new Map(this.#records.contents),
    };
    const transaction: Transaction = {
      active: true,
      callbacks: [],
      readOnly: options?.readOnly ?? false,
    };
    scoped.#transaction = transaction;
    let result: T;
    try {
      result = await operation(scoped);
      if (this.#commit && !transaction.readOnly) {
        await this.#commit(recordsOf(scoped.#records));
      }
      this.#records = scoped.#records;
    } finally {
      transaction.active = false;
      release();
    }
    const failures: unknown[] = [];
    for (const callback of transaction.callbacks) {
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
    return result;
  }

  afterCommit(operation: () => Promise<void>): void {
    const transaction = this.#assertWritable();
    transaction.callbacks.push(operation);
  }

  async getArtifact(id: ArtifactId): Promise<Artifact | null> {
    await this.#ready();
    return structuredClone(this.#records.artifacts.get(id) ?? null);
  }

  async listArtifacts(
    input: ListArtifactsInput
  ): Promise<Page<Artifact, ArtifactCursor>> {
    await this.#ready();
    const query = normalizeArtifactQuery(input.query)?.toLowerCase();
    const matches = [...this.#records.artifacts.values()]
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
    await this.#ready();
    this.#assertWritable();
    if (
      artifact.contentId !== null &&
      this.#records.contents.get(artifact.contentId)?.artifactId !== artifact.id
    ) {
      throw new Error("Artifact pointer must name its own Content");
    }
    this.#records.artifacts.set(artifact.id, structuredClone(artifact));
  }

  async deleteArtifact(id: ArtifactId): Promise<void> {
    await this.#ready();
    this.#assertWritable();
    this.#records.artifacts.delete(id);
    for (const content of this.#records.contents.values()) {
      if (content.artifactId === id) {
        this.#records.contents.delete(content.id);
      }
    }
  }

  async getContent(id: ContentId): Promise<Content | null> {
    await this.#ready();
    return structuredClone(this.#records.contents.get(id) ?? null);
  }

  async listContents(
    artifactId?: ArtifactId,
    input: ListContentsInput = {}
  ): Promise<readonly Content[]> {
    await this.#ready();
    const states =
      typeof input.state === "string" ? [input.state] : input.state;
    return structuredClone(
      [...this.#records.contents.values()]
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
    await this.#ready();
    this.#assertWritable();
    if (!this.#records.artifacts.has(content.artifactId)) {
      throw new Error("Content requires an Artifact");
    }
    this.#records.contents.set(content.id, structuredClone(content));
  }

  async deleteContent(id: ContentId): Promise<void> {
    await this.#ready();
    this.#assertWritable();
    if (
      [...this.#records.artifacts.values()].some(
        (artifact) => artifact.contentId === id
      )
    ) {
      throw new Error("Cannot delete active Content");
    }
    this.#records.contents.delete(id);
  }

  async getBlob(id: BlobId): Promise<Blob | null> {
    await this.#ready();
    return structuredClone(this.#records.blobs.get(id) ?? null);
  }

  async findBlob(digest: string): Promise<Blob | null> {
    await this.#ready();
    return structuredClone(
      [...this.#records.blobs.values()].find(
        (blob) => blob.digest === digest
      ) ?? null
    );
  }

  async listBlobs(): Promise<readonly Pick<Blob, "id" | "path">[]> {
    await this.#ready();
    return [...this.#records.blobs.values()].map((blob) => ({
      id: blob.id,
      ...(blob.path ? { path: blob.path } : {}),
    }));
  }

  async putBlob(blob: Blob): Promise<void> {
    await this.#ready();
    this.#assertWritable();
    validateBlob(blob);
    if (
      blob.path !== undefined &&
      [...this.#records.blobs.values()].some(
        (other) => other.id !== blob.id && other.path === blob.path
      )
    ) {
      throw new Error("Blob backing path already belongs to another blob");
    }
    this.#records.blobs.set(blob.id, structuredClone(blob));
  }

  async deleteBlob(id: BlobId): Promise<void> {
    await this.#ready();
    this.#assertWritable();
    this.#records.blobs.delete(id);
  }

  async isBlobReferenced(
    id: BlobId,
    except?: { readonly contentId: ContentId; readonly path: string }
  ): Promise<boolean> {
    await this.#ready();
    for (const content of this.#records.contents.values()) {
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
    return [...this.#records.blobs.values()].some((blob) =>
      blob.chunks?.includes(id)
    );
  }

  async #ready(): Promise<void> {
    if (this.#transaction) {
      this.#assertActive();
    } else {
      await this.#pending;
    }
  }

  #assertActive(): void {
    if (!this.#transaction?.active) {
      throw new Error("Artifact transaction has settled");
    }
  }

  #assertWritable(): Transaction {
    const transaction = this.#transaction;
    if (!transaction?.active) {
      throw new Error("Artifact transaction has settled");
    }
    if (transaction.readOnly) {
      throw new Error("Artifact transaction is read-only");
    }
    return transaction;
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
