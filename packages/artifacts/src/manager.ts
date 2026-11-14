import { AsyncLocalStorage } from "node:async_hooks";
import type { Page } from "@foundry/core/pagination";
import type { CommitEffects } from "@foundry/core/storage";
import { runAfterCommit } from "@foundry/core/storage";

import type { BlobFiles } from "./blob";
import { readBlob, requireBlob } from "./blob-repository";
import { ArtifactChange } from "./change";
import { MAX_FILE_BYTES, MAX_TREE_BYTES } from "./constants";
import { ArtifactApplicationError, TransactionRolledBackError } from "./errors";
import type { ArtifactCursor } from "./listing";
import type { ArtifactId, BlobId, ContentId } from "./ref";
import type { ArtifactStore, ArtifactStoreWrite } from "./store";
import { InMemoryArtifactStore } from "./store/memory";
import type {
  Artifact,
  ArtifactChangeCause,
  ArtifactObserver,
  ArtifactOperations,
  ArtifactResolved,
  Artifacts,
  Content,
  ContentResolved,
  ContentSummary,
  CreateArtifactInput,
  FileRangeResolved,
  FileResolved,
  FreezeOption,
  ListArtifactsInput,
  ListContentsInput,
  ReviseInput,
  WriteInput,
} from "./substrate";
import type { OperationEffects, TransactionLimits } from "./transaction";
import {
  ArtifactTransaction,
  fileRange,
  operationEffects,
} from "./transaction";

export interface ArtifactManagerOptions {
  readonly files?: BlobFiles;
  readonly maxFileBytes?: number;
  readonly maxTreeBytes?: number;
  /** Persistence. Defaults to an in-memory store. */
  readonly store?: ArtifactStore;
}

/**
 * The transaction a call runs inside, if any. `open` turns false once its
 * operation returns: work it scheduled to outlive it (a timer, a poll)
 * inherits the async context but must start transactions of its own.
 */
interface TransactionScope {
  readonly effects: CommitEffects;
  /**
   * A call that joined it failed. Whatever that call wrote before failing
   * is part of the transaction, and a joined call has no savepoint to undo
   * it, so the transaction rolls back even if the failure was caught.
   */
  failed?: { readonly error: unknown };
  open: boolean;
  readonly transaction: ArtifactTransaction;
}

/**
 * The root of the Artifact substrate. It holds every rule; the store only
 * keeps records. Each operation builds one change and commits it as one
 * store write; `transaction` groups several. Changes run one at a time per
 * manager, and inside the store's transaction when it offers one, so no
 * other manager over the store writes between a change's reads and its
 * commit. A read of several records runs the same way, so it sees one
 * state. After a commit the
 * manager awaits bound application, notifies observers, and removes retired
 * backing files.
 *
 * Blob bytes never wait on the commit. Inline bytes travel inside the blob
 * record. Bytes for `files` are published first, to a fresh immutable file
 * no committed record names; the commit then names it. A change whose
 * write the store does not hold removes the files it published; one that
 * failed after its write landed keeps them. A commit retires the files it
 * stopped naming once it lands, and `recover` removes any file left behind
 * by a crash in between.
 *
 * Inside a `transaction` operation, every call on the manager joins that
 * transaction: a read sees its uncommitted writes and a nested `transaction`
 * commits with it. Stores serialize transactions, so the alternative is a
 * call that waits on the transaction it runs in. A joined call is not a
 * savepoint: when one that writes fails, the whole transaction rolls back
 * with {@link TransactionRolledBackError}, even if the operation caught the
 * failure and went on.
 */
export class ArtifactManager implements Artifacts {
  readonly #store: ArtifactStore;
  readonly #limits: TransactionLimits;
  readonly #bindings = new Set<(id: ArtifactId) => Promise<void>>();
  readonly #observers = new Set<ArtifactObserver>();
  readonly #scope = new AsyncLocalStorage<TransactionScope>();
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: ArtifactManagerOptions = {}) {
    this.#store = options.store ?? new InMemoryArtifactStore();
    this.#limits = {
      ...(options.files ? { files: options.files } : {}),
      maxFileBytes: options.maxFileBytes ?? MAX_FILE_BYTES,
      maxTreeBytes: options.maxTreeBytes ?? MAX_TREE_BYTES,
    };
  }

  bind(apply: (id: ArtifactId) => Promise<void>): () => void {
    this.#bindings.add(apply);
    return () => {
      this.#bindings.delete(apply);
    };
  }

  /**
   * Told of each Artifact a commit changed, once its records are committed,
   * even when applying them to disk failed. `recover` tells again with
   * cause `recovery`: the same committed state, not another change.
   */
  observe(changed: ArtifactObserver): () => void {
    this.#observers.add(changed);
    return () => {
      this.#observers.delete(changed);
    };
  }

  async transaction<T>(
    operation: (
      artifacts: ArtifactOperations,
      effects: CommitEffects
    ) => Promise<T>
  ): Promise<T> {
    const joined = this.#joinedScope();
    if (joined) {
      try {
        return await operation(joined.transaction, joined.effects);
      } catch (error) {
        joined.failed ??= { error };
        throw error;
      }
    }
    const effects = operationEffects();
    const callbacks: (() => Promise<void>)[] = [() => this.#settle(effects)];
    let attempted: ArtifactStoreWrite | undefined;
    let result: T;
    try {
      result = await this.#exclusive(async (store) => {
        const change = new ArtifactChange(store, {});
        try {
          const transaction = new ArtifactTransaction(
            change,
            effects,
            this.#limits
          );
          const scope: TransactionScope = {
            effects: {
              afterCommit: (callback) => {
                change.assertWritable();
                callbacks.push(callback);
              },
            },
            open: true,
            transaction,
          };
          let value: T;
          try {
            value = await this.#scope.run(scope, () =>
              operation(transaction, scope.effects)
            );
          } finally {
            scope.open = false;
          }
          if (scope.failed) {
            throw new TransactionRolledBackError({ cause: scope.failed.error });
          }
          await transaction.reclaim();
          attempted = change.write();
          if (attempted) {
            await store.commit(attempted);
          }
          return value;
        } finally {
          change.settle();
        }
      });
    } catch (error) {
      // Published files go only once the store shows the write absent. A
      // commit can fail after its write landed (syncing the replaced file);
      // its records then name the files, and `recover` reapplies them.
      if (!(await this.#mayHaveLanded(attempted))) {
        await this.#removeFiles(effects.published);
      }
      throw error;
    }
    // Outside the change, so a callback (a binding) may start the next one.
    await runAfterCommit(callbacks);
    return result;
  }

  create(input: CreateArtifactInput): Promise<ArtifactResolved> {
    return this.transaction((artifacts) => artifacts.create(input));
  }

  get(id: ArtifactId): Promise<ArtifactResolved | null> {
    return this.#read((artifacts) => artifacts.get(id));
  }

  list(
    input: ListArtifactsInput = {}
  ): Promise<Page<ArtifactResolved, ArtifactCursor>> {
    return this.#read((artifacts) => artifacts.list(input));
  }

  rename(id: ArtifactId, name: string): Promise<Artifact> {
    return this.transaction((artifacts) => artifacts.rename(id, name));
  }

  patchArtifactMetadata(
    id: ArtifactId,
    patch: Readonly<Record<string, unknown>>
  ): Promise<Artifact> {
    return this.transaction((artifacts) =>
      artifacts.patchArtifactMetadata(id, patch)
    );
  }

  archive(id: ArtifactId): Promise<Artifact> {
    return this.transaction((artifacts) => artifacts.archive(id));
  }

  unarchive(id: ArtifactId): Promise<Artifact> {
    return this.transaction((artifacts) => artifacts.unarchive(id));
  }

  clearFailedContent(input: {
    readonly artifactId: ArtifactId;
    readonly expectedContentId: ContentId;
  }): Promise<ArtifactResolved> {
    return this.transaction((artifacts) => artifacts.clearFailedContent(input));
  }

  delete(id: ArtifactId): Promise<boolean> {
    return this.transaction((artifacts) => artifacts.delete(id));
  }

  write(input: WriteInput): Promise<ContentResolved> {
    return this.transaction((artifacts) => artifacts.write(input));
  }

  revise(input: ReviseInput): Promise<ContentResolved> {
    return this.transaction((artifacts) => artifacts.revise(input));
  }

  freeze(
    id: ContentId,
    option?: FreezeOption & { readonly expectedUpdatedAt?: Date }
  ): Promise<Content> {
    return this.transaction((artifacts) => artifacts.freeze(id, option));
  }

  select(input: {
    readonly artifactId: ArtifactId;
    readonly contentId: ContentId;
    readonly expectedContentId?: ContentId | null;
  }): Promise<ArtifactResolved> {
    return this.transaction((artifacts) => artifacts.select(input));
  }

  fork(input: {
    readonly id?: ArtifactId;
    readonly contentId: ContentId;
    readonly name?: string;
  }): Promise<ArtifactResolved> {
    return this.transaction((artifacts) => artifacts.fork(input));
  }

  tag(id: ContentId, tag: string | null): Promise<Content> {
    return this.transaction((artifacts) => artifacts.tag(id, tag));
  }

  setMetadata(
    id: ContentId,
    patch: Readonly<Record<string, unknown>>
  ): Promise<Content> {
    return this.transaction((artifacts) => artifacts.setMetadata(id, patch));
  }

  getContent(id: ContentId): Promise<ContentResolved | null> {
    return this.#read((artifacts) => artifacts.getContent(id));
  }

  listContents(
    id: ArtifactId,
    input?: ListContentsInput
  ): Promise<readonly ContentSummary[]> {
    return this.#read((artifacts) => artifacts.listContents(id, input));
  }

  findContent(
    id: ArtifactId,
    by: { readonly sessionId: string; readonly messageId: string }
  ): Promise<Content | null> {
    return this.#read((artifacts) => artifacts.findContent(id, by));
  }

  deleteContent(input: {
    readonly contentId: ContentId;
    readonly replacementContentId?: ContentId;
  }): Promise<void> {
    return this.transaction((artifacts) => artifacts.deleteContent(input));
  }

  readFile(id: ContentId, path: string): Promise<FileResolved | null> {
    return this.#read((artifacts) => artifacts.readFile(id, path));
  }

  /**
   * Locates the file in one read. The body then streams after it settles,
   * loading each chunk in its own read as the consumer pulls. A commit that
   * rewrites or reclaims the object meanwhile can end the stream.
   */
  async readFileRange(
    id: ContentId,
    path: string,
    range: { readonly start: number; readonly end?: number }
  ): Promise<FileRangeResolved | null> {
    const joined = this.#joined();
    if (joined) {
      return joined.readFileRange(id, path, range);
    }
    const located = await this.#read((artifacts) =>
      artifacts.locateFile(id, path)
    );
    if (!located) {
      return null;
    }
    // Each chunk is one record, read as the consumer pulls it.
    const reader = {
      files: this.#limits.files,
      require: (blobId: BlobId) => requireBlob(this.#store, blobId),
    };
    return fileRange(located, range, (blob, start, end) =>
      readBlob(blob, start, end, reader)
    );
  }

  readRoot(id: ContentId): Promise<FileResolved | null> {
    return this.#read((artifacts) => artifacts.readRoot(id));
  }

  readNamedRoot(id: ContentId, name: string): Promise<FileResolved | null> {
    return this.#read((artifacts) => artifacts.readNamedRoot(id, name));
  }

  readThumbnail(id: ContentId): Promise<FileResolved | null> {
    return this.#read((artifacts) => artifacts.readThumbnail(id));
  }

  sweep(input: {
    readonly olderThan: Date;
  }): Promise<{ readonly contents: number; readonly blobs: number }> {
    return this.transaction((artifacts) => artifacts.sweep(input));
  }

  async recover(): Promise<void> {
    const { files } = this.#limits;
    if (files) {
      // Exclusive like a change, so a concurrent publish never lands mid-sweep.
      await this.#exclusive(async (store) => {
        const retained = new Set(
          (await store.listBlobs()).flatMap((blob) =>
            blob.path ? [blob.path] : []
          )
        );
        for await (const path of files.list()) {
          if (!retained.has(path)) {
            await files.remove(path);
          }
        }
      });
    }
    let cursor: ListArtifactsInput["cursor"];
    do {
      const page = await this.list({ cursor, includeArchived: true });
      for (const artifact of page.items) {
        for (const apply of this.#bindings) {
          await apply(artifact.id);
        }
      }
      this.#notify(
        page.items.map((artifact) => artifact.id),
        "recovery"
      );
      cursor = page.nextCursor;
    } while (cursor);
  }

  /** The open transaction this call runs inside, if any. */
  #joinedScope(): TransactionScope | undefined {
    const scope = this.#scope.getStore();
    return scope?.open ? scope : undefined;
  }

  #joined(): ArtifactTransaction | undefined {
    return this.#joinedScope()?.transaction;
  }

  #read<T>(
    operation: (artifacts: ArtifactTransaction) => Promise<T>
  ): Promise<T> {
    const joined = this.#joined();
    if (joined) {
      return operation(joined);
    }
    // One consistent state for every record the read takes.
    return this.#exclusive(async (store) => {
      const change = new ArtifactChange(store, { readOnly: true });
      try {
        return await operation(
          new ArtifactTransaction(change, operationEffects(), this.#limits)
        );
      } finally {
        change.settle();
      }
    });
  }

  /**
   * Whether the store may hold `write`: it shows a blob the write puts with
   * a backing file, or cannot be read. A write without one published file
   * has nothing to keep.
   */
  async #mayHaveLanded(
    write: ArtifactStoreWrite | undefined
  ): Promise<boolean> {
    const backed = (write?.putBlobs ?? []).filter(
      (blob) => blob.path !== undefined
    );
    try {
      for (const blob of backed) {
        if ((await this.#store.getBlob(blob.id))?.path === blob.path) {
          return true;
        }
      }
      return false;
    } catch {
      return true;
    }
  }

  /**
   * One read-modify-write, or one read of several steps: serialized in this
   * manager, and exclusive in the store when it offers transactions.
   */
  #exclusive<T>(work: (store: ArtifactStore) => Promise<T>): Promise<T> {
    return this.#serialized(() => {
      const store = this.#store;
      return store.transaction === undefined
        ? work(store)
        : store.transaction(work);
    });
  }

  #serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(work, work);
    this.#tail = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async #settle(effects: OperationEffects): Promise<void> {
    let failure: ArtifactApplicationError | undefined;
    try {
      for (const id of effects.changed) {
        for (const apply of this.#bindings) {
          await apply(id);
        }
      }
    } catch (cause) {
      failure = new ArtifactApplicationError([...effects.changed], { cause });
    }
    // The records committed either way; observers see them, and `recover`
    // later reapplies what failed (and prunes retired files).
    this.#notify(effects.changed, "commit");
    if (failure) {
      throw failure;
    }
    await this.#removeFiles(effects.retired);
  }

  #notify(ids: Iterable<ArtifactId>, cause: ArtifactChangeCause): void {
    for (const id of ids) {
      for (const changed of this.#observers) {
        try {
          changed(id, cause);
        } catch (error) {
          console.error(`Artifact ${id} observer failed`, error);
        }
      }
    }
  }

  async #removeFiles(paths: ReadonlySet<string>): Promise<void> {
    const { files } = this.#limits;
    if (!files) {
      return;
    }
    for (const path of paths) {
      try {
        await files.remove(path);
      } catch (error) {
        console.error("Artifact file cleanup requires retry", error);
      }
    }
  }
}
