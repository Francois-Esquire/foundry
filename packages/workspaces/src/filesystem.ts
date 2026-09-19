import type {
  AtomicStorageWriter,
  StorageObserver,
  StorageReader,
} from "@foundry/core/storage";

export type { DirectoryEntry, EntryStats } from "@foundry/core/storage";

export interface WorkspaceFileSystem
  extends StorageReader,
    AtomicStorageWriter,
    Partial<StorageObserver> {}
