import type {
  AtomicStorageWriter,
  StorageReader,
} from "@foundry/core/filesystem";

export type { DirectoryEntry, EntryStats } from "@foundry/core/filesystem";

export interface WorkspaceFileSystem
  extends StorageReader,
    AtomicStorageWriter {}
