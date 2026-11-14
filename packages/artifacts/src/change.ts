import type { Page } from "@foundry/core/pagination";
import { pageFromRows, pageLimit } from "@foundry/lib/pagination";

import type { Blob } from "./blob";
import { validateBlob } from "./blob";
import type { ArtifactCursor, ArtifactFilter } from "./listing";
import {
  artifactCursor,
  compareCreated,
  isAfterCursor,
  matchesArtifactFilter,
  normalizeArtifactQuery,
} from "./listing";
import type { ArtifactId, BlobId, ContentId } from "./ref";
import type { ArtifactStore, ArtifactStoreWrite, BlobListing } from "./store";
import type {
  Artifact,
  Content,
  ListArtifactsInput,
  ListContentsInput,
} from "./substrate";

/** A record's final state in a change: the record, or `null` once deleted. */
type Pending<Id, Row> = Map<Id, Row | null>;

/**
 * One change to the records, built over a store and committed as one write.
 * Reads see the store with this change applied; writes stay here until
 * `write()` hands them over. The rules that span records hold here, so a
 * change that breaks one never reaches the store:
 *
 * - An Artifact's `contentId` names one of its own Contents.
 * - A Content's Artifact exists.
 * - Deleting an Artifact deletes its Contents.
 * - The Artifact's active Content cannot be deleted.
 * - A blob passes `validateBlob`, and no two blobs share a backing `path`.
 *
 * The change expires when its transaction settles; later calls reject. A
 * read-only change rejects writes.
 */
export class ArtifactChange {
  readonly readOnly: boolean;
  readonly #store: ArtifactStore;
  readonly #artifacts: Pending<ArtifactId, Artifact> = new Map();
  readonly #blobs: Pending<BlobId, Blob> = new Map();
  readonly #contents: Pending<ContentId, Content> = new Map();
  #active: boolean;

  constructor(store: ArtifactStore, options: { readonly readOnly?: boolean }) {
    this.#store = store;
    this.readOnly = options.readOnly ?? false;
    this.#active = true;
  }

  settle(): void {
    this.#active = false;
  }

  /** Throws unless the change still accepts writes. */
  assertWritable(): void {
    this.#assertActive();
    if (this.readOnly) {
      throw new Error("Artifact transaction is read-only");
    }
  }

  /** Every record this change puts or deletes; `undefined` when it changes nothing. */
  write(): ArtifactStoreWrite | undefined {
    if (
      this.#artifacts.size === 0 &&
      this.#blobs.size === 0 &&
      this.#contents.size === 0
    ) {
      return;
    }
    return {
      deleteArtifacts: deleted(this.#artifacts),
      deleteBlobs: deleted(this.#blobs),
      deleteContents: deleted(this.#contents),
      putArtifacts: kept(this.#artifacts),
      putBlobs: kept(this.#blobs),
      putContents: kept(this.#contents),
    };
  }

  // ── Artifacts ──

  getArtifact(id: ArtifactId): Promise<Artifact | null> {
    return this.#get(this.#artifacts, id, () => this.#store.getArtifact(id));
  }

  /**
   * The store's page with this change laid over it. The store is asked for
   * as many more rows as this change touches, so the page stays full after
   * the touched rows give way to their pending versions.
   */
  async listArtifacts(
    input: ListArtifactsInput
  ): Promise<Page<Artifact, ArtifactCursor>> {
    this.#assertActive();
    const limit = pageLimit(input.limit);
    const text = normalizeArtifactQuery(input.query);
    const filter: ArtifactFilter = {
      ...(input.includeArchived === undefined
        ? {}
        : { includeArchived: input.includeArchived }),
      ...(text === undefined ? {} : { text }),
      ...(input.type === undefined ? {} : { type: input.type }),
    };
    const touched = [...this.#artifacts.keys()];
    const stored = await this.#store.listArtifacts({
      ...filter,
      ...(input.cursor === undefined ? {} : { after: input.cursor }),
      limit: limit + 1 + touched.length,
    });
    if (touched.length === 0) {
      return pageFromRows(
        stored.artifacts,
        limit,
        stored.total,
        artifactCursor
      );
    }
    const pending = kept(this.#artifacts).filter((artifact) =>
      matchesArtifactFilter(artifact, filter)
    );
    let total = stored.total + pending.length;
    for (const id of touched) {
      const before = await this.#store.getArtifact(id);
      if (before && matchesArtifactFilter(before, filter)) {
        total -= 1;
      }
    }
    const rows = [
      ...stored.artifacts.filter(
        (artifact) => !this.#artifacts.has(artifact.id)
      ),
      ...pending
        .filter((artifact) => isAfterCursor(artifact, input.cursor))
        .map((artifact) => structuredClone(artifact)),
    ]
      .sort(compareCreated)
      .slice(0, limit + 1);
    return pageFromRows(rows, limit, total, artifactCursor);
  }

  async putArtifact(artifact: Artifact): Promise<void> {
    this.assertWritable();
    if (
      artifact.contentId !== null &&
      (await this.getContent(artifact.contentId))?.artifactId !== artifact.id
    ) {
      throw new Error("Artifact pointer must name its own Content");
    }
    this.#artifacts.set(artifact.id, structuredClone(artifact));
  }

  async deleteArtifact(id: ArtifactId): Promise<void> {
    this.assertWritable();
    for (const content of await this.listContents(id)) {
      this.#contents.set(content.id, null);
    }
    this.#artifacts.set(id, null);
  }

  // ── Contents ──

  getContent(id: ContentId): Promise<Content | null> {
    return this.#get(this.#contents, id, () => this.#store.getContent(id));
  }

  async listContents(
    artifactId?: ArtifactId,
    input: ListContentsInput = {}
  ): Promise<readonly Content[]> {
    this.#assertActive();
    const states =
      typeof input.state === "string" ? [input.state] : input.state;
    return merged(await this.#store.listContents(artifactId), this.#contents)
      .filter(
        (row) =>
          (artifactId === undefined || row.artifactId === artifactId) &&
          (states === undefined || states.includes(row.state)) &&
          (input.tagged === undefined || (row.tag !== null) === input.tagged)
      )
      .sort(compareCreated);
  }

  async putContent(content: Content): Promise<void> {
    this.assertWritable();
    if (!(await this.getArtifact(content.artifactId))) {
      throw new Error("Content requires an Artifact");
    }
    this.#contents.set(content.id, structuredClone(content));
  }

  async deleteContent(id: ContentId): Promise<void> {
    this.assertWritable();
    const content = await this.getContent(id);
    if (
      content &&
      (await this.getArtifact(content.artifactId))?.contentId === id
    ) {
      throw new Error("Cannot delete active Content");
    }
    this.#contents.set(id, null);
  }

  // ── Blobs ──

  getBlob(id: BlobId): Promise<Blob | null> {
    return this.#get(this.#blobs, id, () => this.#store.getBlob(id));
  }

  /** Any blob currently holding bytes with this digest. */
  async findBlob(digest: string): Promise<Blob | null> {
    this.#assertActive();
    const stored = (await this.#store.findBlobs(digest)).find(
      (blob) => !this.#blobs.has(blob.id)
    );
    if (stored) {
      return stored;
    }
    const pending = [...this.#blobs.values()].find(
      (blob) => blob?.digest === digest
    );
    return pending ? structuredClone(pending) : null;
  }

  async listBlobs(): Promise<readonly BlobListing[]> {
    this.#assertActive();
    const listed: BlobListing[] = (await this.#store.listBlobs()).filter(
      (blob) => !this.#blobs.has(blob.id)
    );
    for (const blob of this.#blobs.values()) {
      if (blob) {
        listed.push({
          id: blob.id,
          ...(blob.path === undefined ? {} : { path: blob.path }),
        });
      }
    }
    return listed;
  }

  /**
   * Whether a Content tree or a chunked blob references the blob. `except`
   * skips one file entry, to ask whether that entry owns the blob alone.
   */
  async isBlobReferenced(
    id: BlobId,
    except?: { readonly contentId: ContentId; readonly path: string }
  ): Promise<boolean> {
    this.#assertActive();
    const skipped = (contentId: ContentId) =>
      except?.contentId === contentId ? except.path : undefined;
    const stored = await this.#store.findReferences(id);
    if (stored.blobIds.some((blobId) => !this.#blobs.has(blobId))) {
      return true;
    }
    for (const contentId of stored.contentIds) {
      if (this.#contents.has(contentId)) {
        continue;
      }
      if (skipped(contentId) === undefined) {
        return true;
      }
      const content = await this.#store.getContent(contentId);
      if (content && namesBlob(content, id, skipped(contentId))) {
        return true;
      }
    }
    for (const content of this.#contents.values()) {
      if (content && namesBlob(content, id, skipped(content.id))) {
        return true;
      }
    }
    return [...this.#blobs.values()].some((blob) => blob?.chunks?.includes(id));
  }

  async putBlob(blob: Blob): Promise<void> {
    this.assertWritable();
    validateBlob(blob);
    if (
      blob.path !== undefined &&
      (await this.listBlobs()).some(
        (other) => other.id !== blob.id && other.path === blob.path
      )
    ) {
      throw new Error("Blob backing path already belongs to another blob");
    }
    this.#blobs.set(blob.id, structuredClone(blob));
  }

  deleteBlob(id: BlobId): Promise<void> {
    this.assertWritable();
    this.#blobs.set(id, null);
    return Promise.resolve();
  }

  async #get<Id, Row>(
    pending: Pending<Id, Row>,
    id: Id,
    stored: () => Promise<Row | null>
  ): Promise<Row | null> {
    this.#assertActive();
    if (!pending.has(id)) {
      return stored();
    }
    return structuredClone(pending.get(id) ?? null);
  }

  #assertActive(): void {
    if (!this.#active) {
      throw new Error("Artifact transaction has settled");
    }
  }
}

/** The stored rows this change has not touched, then the rows it puts, detached. */
function merged<Id, Row extends { readonly id: Id }>(
  stored: readonly Row[],
  pending: Pending<Id, Row>
): Row[] {
  return [
    ...stored.filter((row) => !pending.has(row.id)),
    ...kept(pending).map((row) => structuredClone(row)),
  ];
}

function kept<Id, Row>(pending: Pending<Id, Row>): Row[] {
  return [...pending.values()].filter((row) => row !== null);
}

function deleted<Id, Row>(pending: Pending<Id, Row>): Id[] {
  return [...pending].flatMap(([id, row]) => (row === null ? [id] : []));
}

/** Whether a file entry of `content`, other than the one at `skip`, holds the blob. */
function namesBlob(content: Content, id: BlobId, skip?: string): boolean {
  return Object.entries(content.tree).some(
    ([path, node]) =>
      node.type === "file" && node.blobId === id && path !== skip
  );
}
