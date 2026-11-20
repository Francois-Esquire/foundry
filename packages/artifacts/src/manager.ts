import { AsyncLocalStorage } from "node:async_hooks";
import type { Page } from "@foundry/core/pagination";
import type { CommitEffects } from "@foundry/core/storage";
import { runAfterCommit } from "@foundry/core/storage";
import { ReentrantCallError } from "@foundry/lib/turns";

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
  readonly store?: ArtifactStore;
}

interface TransactionScope {
  readonly effects: CommitEffects;
  failed?: { readonly error: unknown };
  open: boolean;
  readonly transaction: ArtifactTransaction;
}

interface StoreTurn {
  held: boolean;
  readonly outer: StoreTurn | undefined;
  readonly store: ArtifactStore;
}

const storeTurns = new AsyncLocalStorage<StoreTurn>();

const REENTRY =
  "[artifacts] The Artifact store was called from inside its own transaction, through another manager over it; use the operations passed to that transaction's work instead";

export class ArtifactManager implements Artifacts {
  readonly #store: ArtifactStore;
  readonly #held: boolean;
  readonly #limits: TransactionLimits;
  readonly #bindings = new Set<(id: ArtifactId) => Promise<void>>();
  readonly #observers = new Set<ArtifactObserver>();
  readonly #scope = new AsyncLocalStorage<TransactionScope>();
  #tail: Promise<unknown> = Promise.resolve();
  readonly #stagingTurns = new StagingTurns();
  #lookups = 0;
  #looked: Promise<void> = Promise.resolve();
  readonly #ordered = new Map<ArtifactId, Promise<void>>();

  constructor(options: ArtifactManagerOptions = {}) {
    this.#store = options.store ?? new InMemoryArtifactStore();
    this.#held = this.#store.durability === "host";
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
    const refused = this.#reentry();
    if (refused) {
      throw refused;
    }
    return this.#change(operation, this.#staging());
  }

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
            const failed = scope.failed ?? change.failure;
            if (failed) {
              throw new TransactionRolledBackError({ cause: failed.error });
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
    return this.#inOrderOfContent(
      input.contentId,
      () => this.transaction((artifacts) => artifacts.fork(input)),
      input.id
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
    if (this.#held) {
      throw new Error(
        'ArtifactManager cannot recover over a store whose commits a host transaction may roll back (durability "host"): files its records stop naming may be named again. Run recover from a manager over the durable store, outside the host\'s transaction.'
      );
    }
    const refused = this.#reentry();
    if (refused) {
      throw refused;
    }
    const { files } = this.#limits;
    if (files) {
      await abandonStaging(files);
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
    const refused = this.#reentry();
    if (refused) {
      return Promise.reject(refused);
    }
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
    const refused = this.#reentry();
    if (refused) {
      return Promise.reject(refused);
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

  #inOrder<T>(
    id: ArtifactId | undefined,
    streams: boolean,
    start: (settled: () => void) => Promise<T>
  ): Promise<T> {
    const refused = this.#reentry();
    if (refused) {
      return Promise.reject(refused);
    }
    if (this.#lookups === 0 || this.#joined()) {
      return this.#register([id], streams, start);
    }
    return this.#looked.then(() => this.#register([id], streams, start));
  }

  #register<T>(
    ids: readonly (ArtifactId | undefined)[],
    streams: boolean,
    start: (settled: () => void) => Promise<T>
  ): Promise<T> {
    const unheld = () => undefined;
    const held = [
      ...new Set(ids.filter((id): id is ArtifactId => id !== undefined)),
    ];
    if (held.length === 0 || this.#joined()) {
      return start(unheld);
    }
    const before = held.flatMap((id) => {
      const earlier = this.#ordered.get(id);
      return earlier === undefined ? [] : [earlier];
    });
    if (before.length === 0 && !streams) {
      return start(unheld);
    }
    let secured!: () => void;
    const mine = new Promise<void>((resolve) => {
      secured = resolve;
    });
    for (const id of held) {
      this.#ordered.set(id, mine);
    }
    mine.then(() => {
      for (const id of held) {
        if (this.#ordered.get(id) === mine) {
          this.#ordered.delete(id);
        }
      }
    });
    const begin = () => {
      const result = start(secured);
      (streams ? result : Promise.resolve()).then(secured, secured);
      return result;
    };
    return before.length === 0 ? begin() : Promise.all(before).then(begin);
  }

  #inOrderOfContent<T>(
    id: ContentId,
    start: () => Promise<T>,
    also?: ArtifactId
  ): Promise<T> {
    const refused = this.#reentry();
    if (refused) {
      return Promise.reject(refused);
    }
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
          const result = this.#register(
            [content?.artifactId, also],
            false,
            start
          );
          release();
          return result;
        },
        (error: unknown) => {
          release();
          throw error;
        }
      );
  }

  #check(
    check: (artifacts: ArtifactTransaction) => Promise<unknown>,
    staging: BlobStaging
  ): Promise<void> {
    const store = this.#store;
    return store.transaction === undefined
      ? this.#checkOver(store, check, staging)
      : this.#inStoreTurn((view) => this.#checkOver(view, check, staging));
  }

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

  #exclusive<T>(
    work: (store: ArtifactStore) => Promise<T>,
    prepare: () => Promise<void> = () => Promise.resolve()
  ): Promise<T> {
    return this.#serialized(async () => {
      await prepare();
      const store = this.#store;
      return store.transaction === undefined
        ? work(store)
        : this.#inStoreTurn(work);
    });
  }

  #inStoreTurn<T>(work: (view: ArtifactStore) => Promise<T>): Promise<T> {
    const store = this.#store;
    if (store.transaction === undefined) {
      throw new Error("The Artifact store offers no transaction");
    }
    return store.transaction(async (view) => {
      const turn: StoreTurn = {
        held: true,
        outer: storeTurns.getStore(),
        store,
      };
      try {
        return await storeTurns.run(turn, () => work(view));
      } finally {
        turn.held = false;
      }
    });
  }

  #reentry(): ReentrantCallError | undefined {
    if (this.#scope.getStore() !== undefined) {
      return;
    }
    for (let turn = storeTurns.getStore(); turn; turn = turn.outer) {
      if (turn.held && turn.store === this.#store) {
        return new ReentrantCallError(REENTRY);
      }
    }
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
    this.#notify(effects.changed, "commit");
    if (failure) {
      throw failure;
    }
    if (!this.#held) {
      await this.#removeFiles(effects.retired);
    }
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
