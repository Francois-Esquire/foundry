/** Classification of the entry itself, without following a symbolic link. */
export interface EntryStats {
  readonly isDirectory: boolean;
  readonly isFile: boolean;
  readonly isSymbolicLink: boolean;
}

export interface DirectoryEntry extends EntryStats {
  /** One entry name, not a path. */
  readonly name: string;
}

/**
 * All operations share the adapter's path namespace. This contract does not
 * grant access or enforce confinement.
 */
export interface StorageReader {
  /** Inspects the entry without following its final symbolic link. */
  lstat(path: string): Promise<EntryStats>;
  /**
   * Lists immediate children without following symbolic links. Rejects on
   * incomplete or failed enumeration; an empty list means an empty directory.
   */
  readDirectory(path: string): Promise<readonly DirectoryEntry[]>;
  /** Reads detached bytes without text decoding. Rejects when the file cannot be read. */
  readFile(path: string): Promise<Uint8Array>;
  /** Resolves an existing path to its canonical location, following links. */
  realpath(path: string): Promise<string>;
  /** Separator in this storage's path namespace, independent of the caller's OS. */
  readonly separator: "/" | "\\";
}

export interface StorageWriter {
  /**
   * Writes owned bytes or UTF-8 text, creating missing parent directories.
   * Does not imply atomic replacement.
   */
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
}

export interface AtomicStorageWriter {
  /**
   * Replaces an existing regular file. Failure leaves the original bytes
   * unchanged. Does not promise compare-and-swap or crash durability.
   */
  replaceFile(path: string, bytes: Uint8Array): Promise<void>;
}

export interface Storage
  extends StorageReader,
    StorageWriter,
    AtomicStorageWriter {}
