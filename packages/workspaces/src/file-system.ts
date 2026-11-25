import type {
  AtomicStorageWriter,
  StorageFileCreator,
  StorageObserver,
  StorageReader,
  StorageTree,
} from "@foundry/core/storage";

export interface ResolvedSource {
  readonly name?: string;
  readonly path: string;
  readonly sourceId?: string;
}

export interface WorkspaceFileSystem<
  Ref extends object = { readonly path: string },
> extends StorageReader,
    AtomicStorageWriter,
    Partial<StorageObserver>,
    Partial<StorageFileCreator> {
  readonly reference?: keyof Ref & string;
  resolve?(ref: Ref): Promise<ResolvedSource>;
  tree?(root: string): Promise<StorageTree>;
}
