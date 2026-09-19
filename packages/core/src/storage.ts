export interface FileNode {
  /** Length in bytes. */
  readonly bytes: number;
  /** SHA-256 hex digest of the observed bytes. */
  readonly digest: string;
  readonly mime: string | null;
  readonly type: "file";
}

export interface FileRepresentation extends FileNode {
  /** Root-relative POSIX path without empty, `.` or `..` segments. */
  readonly path: string;
}

export type StorageNode =
  | FileNode
  | { readonly type: "directory" }
  | { readonly type: "symlink"; readonly target: string }
  | { readonly type: "socket" }
  | { readonly type: "device" }
  | { readonly type: "pipe" };

export type StorageEntry = StorageNode & { readonly path: string };

/** Keys use the same root-relative paths as StorageEntry.path. */
export type StorageTree = Readonly<Record<string, StorageNode>>;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function isStoragePath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.includes("\0") &&
    !path.includes("\\") &&
    path
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}

export function validateStorageTree(tree: StorageTree): void {
  for (const [path, node] of Object.entries(tree)) {
    if (!isStoragePath(path)) {
      throw new Error(`Invalid storage path: ${path}`);
    }
    validateStorageNode(node, path);
    const slash = path.lastIndexOf("/");
    if (slash !== -1) {
      const parent = path.slice(0, slash);
      if (!Object.hasOwn(tree, parent) || tree[parent]?.type !== "directory") {
        throw new Error(`Missing directory ${parent} for ${path}`);
      }
    }
  }
}

function validateStorageNode(node: StorageNode, path: string): void {
  if (!node || typeof node !== "object") {
    throw new Error(`Invalid storage node: ${path}`);
  }
  if (
    node.type !== "file" &&
    ("digest" in node || "bytes" in node || "mime" in node)
  ) {
    throw new Error(`Content metadata on a non-file entry: ${path}`);
  }
  if (node.type !== "symlink" && "target" in node) {
    throw new Error(`Link target on a non-link entry: ${path}`);
  }
  switch (node.type) {
    case "file":
      if (
        !(
          SHA256_PATTERN.test(node.digest) && Number.isSafeInteger(node.bytes)
        ) ||
        node.bytes < 0 ||
        (node.mime !== null && typeof node.mime !== "string")
      ) {
        throw new Error(`Invalid file descriptor: ${path}`);
      }
      break;
    case "symlink":
      if (
        typeof node.target !== "string" ||
        node.target.length === 0 ||
        node.target.includes("\0")
      ) {
        throw new Error(`Invalid symlink target: ${path}`);
      }
      break;
    case "directory":
    case "socket":
    case "device":
    case "pipe":
      break;
    default:
      throw new Error(`Unsupported storage entry: ${path}`);
  }
}

export function withParentDirectories(tree: StorageTree): StorageTree {
  const result: Record<string, StorageNode> = { ...tree };
  for (const path of Object.keys(tree)) {
    let slash = path.lastIndexOf("/");
    while (slash !== -1) {
      const parent = path.slice(0, slash);
      if (!Object.hasOwn(result, parent)) {
        Object.defineProperty(result, parent, {
          configurable: true,
          enumerable: true,
          value: { type: "directory" },
          writable: true,
        });
      }
      slash = parent.lastIndexOf("/");
    }
  }
  validateStorageTree(result);
  return result;
}

export function storageTree(entries: Iterable<StorageEntry>): StorageTree {
  const pairs: [string, StorageNode][] = [];
  const paths = new Set<string>();
  for (const entry of entries) {
    if (paths.has(entry.path)) {
      throw new Error(`Duplicate storage path: ${entry.path}`);
    }
    paths.add(entry.path);
    let node: StorageNode;
    if (entry.type === "file") {
      node = {
        bytes: entry.bytes,
        digest: entry.digest,
        mime: entry.mime,
        type: "file",
      };
    } else if (entry.type === "symlink") {
      node = { target: entry.target, type: "symlink" };
    } else {
      node = { type: entry.type };
    }
    pairs.push([entry.path, node]);
  }
  const tree = Object.fromEntries(pairs);
  validateStorageTree(tree);
  return tree;
}

/** Classification of the entry itself, without following a symbolic link. */
export interface EntryStats {
  readonly type: StorageNode["type"] | "unknown";
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
  /** Reads the stored target without resolving it, including dangling links. */
  readLink(path: string): Promise<string>;
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

export interface StorageSubscription {
  /** Stops notifications and releases the source subscription. */
  close(): Promise<void>;
}

/** Signals invalidate an inventory; they are not committed entry changes. */
export interface StorageObserver {
  /** Resolves when subscribed. Callers must scan afterwards to close the startup gap. */
  watch(
    root: string,
    changed: () => void,
    failed: (error: unknown) => void
  ): Promise<StorageSubscription>;
}
