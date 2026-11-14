import { AsyncLocalStorage } from "node:async_hooks";
import type { Page } from "@foundry/core/pagination";
import type { CommitEffects } from "@foundry/core/storage";
import { runAfterCommit } from "@foundry/core/storage";

import type { BlobFiles } from "./blob";
import { readBlob, requireBlob } from "./blob-repository";
import { abandonStaging, BlobStaging, StagingTurns } from "./blob-staging";
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
  EntryInputs,
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
 * Blob bytes never wait on the commit. `create`, `write` and `revise` take
 * their bytes in before the change takes the store's exclusion; inside it,
 * the change only resolves dedup and promotes the staged files it keeps.
 * Changes this manager makes to one Artifact commit in call order. A
 * stream that never ends holds back later changes to its own Artifact
 * through this manager for as long as it is pending; there is no timeout,
 * and the caller ends it by ending or erroring the source.
 * Inline bytes travel inside the blob record. Bytes for `files` wait as
 * staged files, or are published inside the change when it cannot stage
 * them (a stream given inside `transaction`, or a `BlobFiles` without
 * `staging`), to a fresh immutable file no committed record names; the
 * commit then names it. A change whose
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
  readonly #stagingTurns = new StagingTurns();
  /** Content-named changes still looking up their Artifact, in call order. */
  #lookups = 0;
  /** Settles once every Content-named change called so far has taken its place. */
  #looked: Promise<void> = Promise.resolve();
  /** Per Artifact, the latest change whose place in call order is not yet secured. */
  readonly #ordered = new Map<ArtifactId, Promise<void>>();

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
   * even when applying them to disk failed. A commit whose store rejected it
   * after its write landed (a failed sync of the replaced file) tells no one:
   * the change rejects, and `recover` reapplies and tells with cause
   * `recovery`, the same committed state, not another change.
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
    return this.#change(operation, this.#staging());
  }

  /**
   * One change: `prepare` runs in this manager's turn, before the store's
   * exclusion, then `operation` builds the change inside it over the bytes
   * `staging` holds. Whatever `staging` still holds is discarded once the
   * change settles. `settled` is told once the commit or the rollback is
   * complete, before bindings, observers and after-commit callbacks run, so
   * one of them may start the next change to the same Artifact.
   */
  async #change<T>(
    operation: (
      artifacts: ArtifactTransaction,
      effects: CommitEffects
    ) => Promise<T>,
    staging: BlobStaging,
    prepare: () => Promise<void> = () => Promise.resolve(),
    settled: () => void = () => undefined
  ): Promise<T> {
    const effects = operationEffects();
    const callbacks: (() => Promise<void>)[] = [() => this.#settle(effects)];
    let attempted: ArtifactStoreWrite | undefined;
    let result: T;
    try {
      try {
        result = await this.#exclusive(async (store) => {
          const change = new ArtifactChange(store, {});
          try {
            const transaction = new ArtifactTransaction(
              change,
              effects,
              this.#limits,
              staging
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
              throw new TransactionRolledBackError({
                cause: scope.failed.error,
              });
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
        }, prepare);
      } catch (error) {
        // Published files go only once the store shows the write absent. A
        // commit can fail after its write landed (syncing the replaced file);
        // its records then name the files, and `recover` reapplies them.
        if (!(await this.#mayHaveLanded(attempted))) {
          await this.#removeFiles(effects.published);
        }
        throw error;
      } finally {
        await staging.discard();
      }
    } finally {
      settled();
    }
    // Outside the change, so a callback (a binding) may start the next one.
    await runAfterCommit(callbacks);
    return result;
  }

  create(input: CreateArtifactInput): Promise<ArtifactResolved> {
    return this.#staged(
      input.id,
      input.entries,
      (artifacts) => artifacts.checkCreate(input),
      (artifacts) => artifacts.create(input)
    );
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
    return this.#inOrder(id, false, () =>
      this.transaction((artifacts) => artifacts.rename(id, name))
    );
  }

  patchArtifactMetadata(
    id: ArtifactId,
    patch: Readonly<Record<string, unknown>>
  ): Promise<Artifact> {
    return this.#inOrder(id, false, () =>
      this.transaction((artifacts) =>
        artifacts.patchArtifactMetadata(id, patch)
      )
    );
  }

  archive(id: ArtifactId): Promise<Artifact> {
    return this.#inOrder(id, false, () =>
      this.transaction((artifacts) => artifacts.archive(id))
    );
  }

  unarchive(id: ArtifactId): Promise<Artifact> {
    return this.#inOrder(id, false, () =>
      this.transaction((artifacts) => artifacts.unarchive(id))
    );
  }

  clearFailedContent(input: {
    readonly artifactId: ArtifactId;
    readonly expectedContentId: ContentId;
  }): Promise<ArtifactResolved> {
    return this.#inOrder(input.artifactId, false, () =>
      this.transaction((artifacts) => artifacts.clearFailedContent(input))
    );
  }

  delete(id: ArtifactId): Promise<boolean> {
    return this.#inOrder(id, false, () =>
      this.transaction((artifacts) => artifacts.delete(id))
    );
  }

  write(input: WriteInput): Promise<ContentResolved> {
    return this.#staged(
      input.artifactId,
      input.changes.put,
      (artifacts) => artifacts.checkWrite(input),
      (artifacts) => artifacts.write(input)
    );
  }

  revise(input: ReviseInput): Promise<ContentResolved> {
    return this.#staged(
      input.artifactId,
      input.changes?.put,
      (artifacts) => artifacts.checkRevise(input),
      (artifacts) => artifacts.revise(input)
    );
  }

  freeze(
    id: ContentId,
    option?: FreezeOption & { readonly expectedUpdatedAt?: Date }
  ): Promise<Content> {
    return this.#inOrderOfContent(id, () =>
      this.transaction((artifacts) => artifacts.freeze(id, option))
    );
  }

  select(input: {
    readonly artifactId: ArtifactId;
    readonly contentId: ContentId;
    readonly expectedContentId?: ContentId | null;
  }): Promise<ArtifactResolved> {
    return this.#inOrder(input.artifactId, false, () =>
      this.transaction((artifacts) => artifacts.select(input))
    );
  }

  fork(input: {
    readonly id?: ArtifactId;
    readonly contentId: ContentId;
    readonly name?: string;
  }): Promise<ArtifactResolved> {
    // Ordered by the source's Artifact: a fork freezes a ready source.
    return this.#inOrderOfContent(input.contentId, () =>
      this.transaction((artifacts) => artifacts.fork(input))
    );
  }

  tag(id: ContentId, tag: string | null): Promise<Content> {
    return this.#inOrderOfContent(id, () =>
      this.transaction((artifacts) => artifacts.tag(id, tag))
    );
  }

  setMetadata(
    id: ContentId,
    patch: Readonly<Record<string, unknown>>
  ): Promise<Content> {
    return this.#inOrderOfContent(id, () =>
      this.transaction((artifacts) => artifacts.setMetadata(id, patch))
    );
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
    return this.#inOrderOfContent(input.contentId, () =>
      this.transaction((artifacts) => artifacts.deleteContent(input))
    );
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
      // Staging whose owner is gone; live owners' bytes stay where they wait.
      await abandonStaging(files);
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
          new ArtifactTransaction(
            change,
            operationEffects(),
            this.#limits,
            this.#staging()
          )
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
   * A change whose bytes are taken in first. Inside a `transaction` it joins
   * that transaction and takes them in there.
   *
   * A change carrying a stream stages every input before its change takes a
   * turn, so a stalled source holds neither this manager's queue nor the
   * store. Its check takes a turn of its own first, so it sees every change
   * queued before it. Any other change takes its turn at once, and checks
   * and stages in that turn, before the store's exclusion. Either way the
   * check reads one consistent view, refuses what the change would refuse
   * before reading a byte, and records what the change will confirm inside
   * the store's exclusion (the ownership of objects it may rewrite).
   *
   * Changes on one Artifact commit in call order (see `#inOrder`); changes
   * on other Artifacts, reads, and other managers are not held back.
   */
  #staged<T>(
    id: ArtifactId | undefined,
    entries: EntryInputs | undefined,
    check: (artifacts: ArtifactTransaction) => Promise<unknown>,
    operation: (artifacts: ArtifactTransaction) => Promise<T>
  ): Promise<T> {
    const joined = this.#joined();
    if (joined) {
      return this.transaction(() => operation(joined));
    }
    const staging = this.#staging();
    const streaming = staging.streamsAhead(entries);
    return this.#inOrder(id, streaming, (settled) =>
      streaming
        ? this.#streamed(entries, check, operation, staging, settled)
        : this.#change(operation, staging, async () => {
            await this.#check(check, staging);
            await staging.stageAll(entries);
          })
    );
  }

  async #streamed<T>(
    entries: EntryInputs | undefined,
    check: (artifacts: ArtifactTransaction) => Promise<unknown>,
    operation: (artifacts: ArtifactTransaction) => Promise<T>,
    staging: BlobStaging,
    settled: () => void
  ): Promise<T> {
    try {
      await this.#exclusive((store) => this.#checkOver(store, check, staging));
      await staging.stageAll(entries);
    } catch (error) {
      await staging.discard();
      throw error;
    }
    return this.#change(operation, staging, undefined, settled);
  }

  /**
   * Call order for the changes this manager makes to Artifact `id`. A change
   * that `streams` takes its turn only once its bytes are staged, so a later
   * change to `id` starts only after it has committed or rolled back (it
   * calls the `settled` it is given then, before its bindings run, or it
   * rejects); until then the later change waits outside the queue. A change
   * with no such stream ahead of it starts at once, and the queue keeps its
   * order. Changes with no `id`, and calls joined to an open transaction,
   * are not held.
   */
  #inOrder<T>(
    id: ArtifactId | undefined,
    streams: boolean,
    start: (settled: () => void) => Promise<T>
  ): Promise<T> {
    if (this.#lookups === 0 || this.#joined()) {
      return this.#register(id, streams, start);
    }
    // Behind every Content-named change called earlier, once each has
    // taken its place in its Artifact's order.
    return this.#looked.then(() => this.#register(id, streams, start));
  }

  /** `#inOrder` once no earlier Content-named change is still looking up its Artifact. */
  #register<T>(
    id: ArtifactId | undefined,
    streams: boolean,
    start: (settled: () => void) => Promise<T>
  ): Promise<T> {
    const unheld = () => undefined;
    if (id === undefined || this.#joined()) {
      return start(unheld);
    }
    const before = this.#ordered.get(id);
    if (before === undefined && !streams) {
      return start(unheld);
    }
    let secured!: () => void;
    const mine = new Promise<void>((resolve) => {
      secured = resolve;
    });
    this.#ordered.set(id, mine);
    mine.then(() => {
      if (this.#ordered.get(id) === mine) {
        this.#ordered.delete(id);
      }
    });
    const begin = () => {
      const result = start(secured);
      // A stream secures its place once it commits or rolls back, or once it
      // rejects before reaching its change; any other change once queued.
      (streams ? result : Promise.resolve()).then(secured, secured);
      return result;
    };
    return before === undefined ? begin() : before.then(begin);
  }

  /**
   * `#inOrder` for a change named by Content. With no stream change pending
   * and no lookup under way, it starts at once and reads nothing. Otherwise
   * it reserves its place at call time: changes called after it, of any
   * kind, wait (outside the queue) until it has read its Content's Artifact
   * from the store and taken its place in that Artifact's order. A lookup
   * that fails, or finds no Content, gives the place up, and the change
   * rejects as it would have. A Content's Artifact never changes, so one
   * read suffices.
   */
  #inOrderOfContent<T>(id: ContentId, start: () => Promise<T>): Promise<T> {
    if (this.#joined() || (this.#ordered.size === 0 && this.#lookups === 0)) {
      return start();
    }
    const earlier = this.#looked;
    let placed!: () => void;
    const place = new Promise<void>((resolve) => {
      placed = resolve;
    });
    this.#lookups += 1;
    this.#looked = earlier.then(() => place);
    const release = () => {
      this.#lookups -= 1;
      placed();
    };
    return earlier
      .then(() => this.#store.getContent(id))
      .then(
        (content) => {
          // Registered before the place is released, so changes waiting on
          // it find this change ahead of them.
          const result = this.#register(content?.artifactId, false, start);
          release();
          return result;
        },
        (error: unknown) => {
          release();
          throw error;
        }
      );
  }

  /** `check` in this manager's turn, over one consistent view of the store. */
  #check(
    check: (artifacts: ArtifactTransaction) => Promise<unknown>,
    staging: BlobStaging
  ): Promise<void> {
    const store = this.#store;
    return store.transaction === undefined
      ? this.#checkOver(store, check, staging)
      : store.transaction((view) => this.#checkOver(view, check, staging));
  }

  /**
   * `check` over `store`. The change runs its checks again inside the
   * store's exclusion, over `staging`, where this first check records what
   * it saw; it also spares staging the bytes of a refused change.
   */
  async #checkOver(
    store: ArtifactStore,
    check: (artifacts: ArtifactTransaction) => Promise<unknown>,
    staging: BlobStaging
  ): Promise<void> {
    const change = new ArtifactChange(store, { readOnly: true });
    try {
      await check(
        new ArtifactTransaction(
          change,
          operationEffects(),
          this.#limits,
          staging
        )
      );
    } finally {
      change.settle();
    }
  }

  #staging(): BlobStaging {
    return new BlobStaging(this.#limits, this.#stagingTurns);
  }

  /**
   * One read-modify-write, or one read of several steps: serialized in this
   * manager, and exclusive in the store when it offers transactions.
   * `prepare` runs in this manager's turn, before the store's exclusion.
   */
  #exclusive<T>(
    work: (store: ArtifactStore) => Promise<T>,
    prepare: () => Promise<void> = () => Promise.resolve()
  ): Promise<T> {
    return this.#serialized(async () => {
      await prepare();
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
