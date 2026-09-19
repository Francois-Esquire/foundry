import type {
  EntryStats,
  StorageObserver,
  StorageReader,
} from "@foundry/core/storage";
import {
  StorageApplicationError,
  StorageConflictError,
} from "@foundry/core/storage";
import { sha256Hex } from "@foundry/lib/digest";
import { decodeText, decodeUtf8 } from "@foundry/lib/encoding";
import { classifyFile } from "@foundry/lib/file-classification";
import { isTextMime } from "@foundry/lib/mime";
import { isFilesystemPathWithin } from "@foundry/lib/paths";
import { DIRECTORY_SOURCE } from "./constants";
import { errorCode, WorkspaceSourceUnavailableError } from "./errors";
import {
  canonicalizeRoot,
  resolveStoredPath,
  scanDirectory,
  verifyRoot,
} from "./scanner";
import type {
  FileContentResult,
  ObservedFacts,
  WorkspaceCtor,
  WorkspaceExtension,
  WorkspaceFile,
  WorkspaceFileSystem,
  WriteOutcome,
} from "./types";

const DRIVE_PREFIX_PATTERN = /^[a-zA-Z]:/;

export interface DirectoryOptions<Ref extends object = DirectoryRef> {
  readonly filesystem: WorkspaceFileSystem<Ref>;
  readonly observer?: StorageObserver;
  readonly source?: string;
}

/**
 * The layer over a directory in the supplied storage. Answers the three source
 * primitives from `source.path`, which is the canonical absolute root.
 *
 * Every read and write re-runs the confinement chain immediately before
 * touching bytes: lexical escape, root availability, stored-path resolution,
 * final lstat, symlink refusal, regular-file check, realpath, beneath-root
 * confinement. The storage adapter owns atomic replacement.
 */
export interface DirectoryCapable {
  /** The canonical absolute root. Never leaves the trust boundary. */
  readonly root: string;
}

export function WithDirectory<
  B extends WorkspaceCtor,
  Ref extends object = DirectoryRef,
>(
  Base: B,
  options: DirectoryOptions<Ref>
): B & WorkspaceCtor<DirectoryCapable> {
  const { filesystem } = options;

  return class extends Base implements DirectoryCapable {
    get root(): string {
      return this.source.path;
    }

    async scan(): Promise<readonly ObservedFacts[]> {
      if (filesystem.tree) {
        try {
          return Object.entries(await filesystem.tree(this.root)).map(
            ([path, node]) => {
              if (node.type !== "file") {
                return {
                  ...node,
                  name: path.slice(path.lastIndexOf("/") + 1),
                  path,
                };
              }
              const classification = classifyFile(path);
              return {
                ...classification,
                bytes: node.bytes,
                digest: node.digest,
                mime: node.mime ?? classification.mime,
                path,
                type: node.type,
              };
            }
          );
        } catch (cause) {
          if (cause instanceof WorkspaceSourceUnavailableError) {
            throw cause;
          }
          throw new WorkspaceSourceUnavailableError(
            "Could not read the Workspace tree",
            {
              cause,
              issue: "scan-failed",
            }
          );
        }
      }
      return scanDirectory(filesystem, this.root);
    }

    protected watch(changed: () => void, failed: (error: unknown) => void) {
      return (
        (options.observer ?? filesystem).watch?.(this.root, changed, failed) ??
        super.watch(changed, failed)
      );
    }

    protected async readFile(file: WorkspaceFile): Promise<FileContentResult> {
      const read = await this.resolveBytes(file);
      if (read.kind === "failure") {
        return { kind: contentKindFor(read.issue), reason: read.reason };
      }
      const text = isTextMime(file.mime)
        ? decodeUtf8(read.bytes)
        : decodeText(read.bytes);
      const digest = await sha256Hex(read.bytes);
      return text === null
        ? {
            bytes: read.bytes.byteLength,
            digest,
            kind: "binary",
            mime: file.mime,
            type: "file",
          }
        : {
            bytes: read.bytes.byteLength,
            digest,
            kind: "text",
            mime: file.mime,
            text,
            type: "file",
          };
    }

    protected async writeFile(
      file: WorkspaceFile,
      bytes: Uint8Array,
      expectedDigest: string
    ): Promise<WriteOutcome> {
      const read = await this.resolveBytes(file);
      if (read.kind === "failure") {
        return { kind: saveKindFor(read.issue), reason: read.reason };
      }

      const currentText = isTextMime(file.mime)
        ? decodeUtf8(read.bytes)
        : decodeText(read.bytes);
      if (currentText === null) {
        return {
          kind: "stale",
          reason: `${file.path} is no longer UTF-8 text`,
        };
      }

      const currentDigest = await sha256Hex(read.bytes);
      if (currentDigest !== expectedDigest) {
        return {
          current: {
            bytes: read.bytes.byteLength,
            digest: currentDigest,
            text: currentText,
          },
          kind: "conflict",
        };
      }

      try {
        await filesystem.replaceFile(read.resolved, bytes, expectedDigest);
      } catch (error) {
        if (error instanceof StorageApplicationError) {
          return { application: "pending", kind: "written" };
        }
        if (error instanceof StorageConflictError) {
          const text = decodeText(error.current);
          if (text === null) {
            return { kind: "stale", reason: "File is no longer UTF-8 text" };
          }
          return {
            current: {
              bytes: error.current.byteLength,
              digest: await sha256Hex(error.current),
              text,
            },
            kind: "conflict",
          };
        }
        return {
          kind: "failed",
          reason: `Could not save ${file.path} (${errorCode(error)})`,
        };
      }
      return { kind: "written" };
    }

    /**
     * The one confinement-and-read chain both `readFile` and `writeFile` run.
     * A failure names its issue so each consumer maps it to its own result
     * vocabulary without re-deciding policy.
     */
    private async resolveBytes(
      file: WorkspaceFile
    ): Promise<ResolvedBytes | ResolveFailure> {
      if (escapesRoot(file.path)) {
        return escapePathFailure(file.path);
      }

      const rootFailure = await verifyWorkspaceRoot(filesystem, this.root);
      if (rootFailure !== undefined) {
        return rootFailure;
      }

      // The stored path is normalized; the source's own spelling may not be,
      // so the File is looked up rather than assumed to answer to its
      // composed name.
      const absolute = await resolveStoredPath(
        filesystem,
        this.root,
        file.path
      );
      if (absolute === null) {
        return missingFileFailure(file.path);
      }

      const stats = await storedFileStats(filesystem, absolute, file.path);
      if ("kind" in stats) {
        return stats;
      }
      if (stats.type === "symlink") {
        return symlinkFailure(file.path);
      }
      if (stats.type !== "file") {
        return nonRegularFileFailure(file.path);
      }

      // The lexical check above and the lstat only cover the final component.
      // A directory component swapped for a symlink after the scan would still
      // resolve outside the root, so the resolved path — not the joined one —
      // is what has to be confined.
      const resolved = await resolveConfinedPath(
        filesystem,
        this.root,
        absolute,
        file.path
      );
      if (typeof resolved !== "string") {
        return resolved;
      }

      const bytes = await readStoredFile(filesystem, resolved, file.path);
      if ("kind" in bytes) {
        return bytes;
      }
      return { bytes, kind: "bytes", resolved };
    }
  };
}

/** The selected directory path, canonicalized when loaded. */
export interface DirectoryRef {
  readonly path: string;
}

/**
 * The directory layer as an extension: claims every `"host"` record and
 * turns `{ path }` into an identity.
 *
 * A duplicate canonical root — including a different spelling of the same
 * directory, and including a concurrent load that wins the race — resolves
 * to the Workspace that already exists.
 */
export function directory<Ref extends object = DirectoryRef>(
  options: DirectoryOptions<Ref>
): WorkspaceExtension<Ref, DirectoryCapable> {
  const { filesystem } = options;
  return {
    applies: (record) => record.source === (options.source ?? DIRECTORY_SOURCE),
    async identify(ref) {
      const resolved = filesystem.resolve ? await filesystem.resolve(ref) : ref;
      if (!("path" in resolved) || typeof resolved.path !== "string") {
        throw new Error("Directory reference requires a path resolver");
      }
      const root = await canonicalizeRoot(filesystem, resolved.path);
      return {
        name:
          "name" in resolved && typeof resolved.name === "string"
            ? resolved.name
            : basenameOf(root, filesystem.separator),
        path: root,
        source: options.source ?? DIRECTORY_SOURCE,
        sourceId:
          "sourceId" in resolved && typeof resolved.sourceId === "string"
            ? resolved.sourceId
            : null,
      };
    },
    name: "directory",
    ref: filesystem.reference ?? "path",
    wrap: (Base) => WithDirectory(Base, options),
  };
}

function basenameOf(root: string, separator: string): string {
  const segments = root.split(separator).filter(Boolean);
  return segments.at(-1) ?? root;
}

function failure(
  issue: ResolveFailure["issue"],
  reason: string
): ResolveFailure {
  return { issue, kind: "failure", reason };
}

function missingFileFailure(path: string): ResolveFailure {
  return failure(
    "missing",
    `${path} is no longer present in the Workspace source`
  );
}

function escapePathFailure(path: string): ResolveFailure {
  return failure(
    "escape",
    `Refusing a File path that escapes its Workspace root: ${path}`
  );
}

function symlinkFailure(path: string): ResolveFailure {
  return failure("symlink", `Refusing to follow a symlink at ${path}`);
}

function nonRegularFileFailure(path: string): ResolveFailure {
  return failure("not-regular", `${path} is no longer a regular file`);
}

async function verifyWorkspaceRoot(
  filesystem: Pick<StorageReader, "lstat" | "realpath">,
  root: string
): Promise<ResolveFailure | undefined> {
  // Asked before the File itself, so an unplugged source reads as one
  // unavailable Workspace rather than as every File having gone stale.
  try {
    await verifyRoot(filesystem, root);
    return undefined;
  } catch (error) {
    if (!(error instanceof WorkspaceSourceUnavailableError)) {
      throw error;
    }
    return failure(
      error.issue === "unavailable" ? "root-unavailable" : "root-unreadable",
      error.message
    );
  }
}

async function storedFileStats(
  filesystem: Pick<StorageReader, "lstat">,
  absolute: string,
  path: string
): Promise<EntryStats | ResolveFailure> {
  try {
    return await filesystem.lstat(absolute);
  } catch {
    return missingFileFailure(path);
  }
}

async function resolveConfinedPath(
  filesystem: Pick<StorageReader, "realpath" | "separator">,
  root: string,
  absolute: string,
  path: string
): Promise<string | ResolveFailure> {
  let resolved: string;
  try {
    resolved = await filesystem.realpath(absolute);
  } catch {
    return missingFileFailure(path);
  }
  if (!isFilesystemPathWithin(root, resolved, filesystem.separator)) {
    return failure(
      "escape",
      `Refusing a File that resolves outside its Workspace root: ${path}`
    );
  }
  return resolved;
}

async function readStoredFile(
  filesystem: Pick<StorageReader, "readFile">,
  resolved: string,
  path: string
): Promise<Uint8Array | ResolveFailure> {
  try {
    return await filesystem.readFile(resolved);
  } catch (error) {
    // The error's own message embeds the absolute path Node was opening,
    // and this reason crosses to the renderer. Only the relative path and
    // a code.
    return failure(
      "read-error",
      `Could not read ${path} (${errorCode(error)})`
    );
  }
}

interface ResolvedBytes {
  readonly bytes: Uint8Array;
  readonly kind: "bytes";
  /** The confined, resolved absolute path. Never leaves this module. */
  readonly resolved: string;
}

interface ResolveFailure {
  readonly issue:
    | "escape"
    | "root-unavailable"
    | "root-unreadable"
    | "missing"
    | "symlink"
    | "not-regular"
    | "read-error";
  readonly kind: "failure";
  readonly reason: string;
}

function contentKindFor(
  issue: ResolveFailure["issue"]
): "stale" | "unavailable" | "unreadable" {
  // biome-ignore lint/style/useDefaultSwitchClause: All members of the discriminated union are handled; keep TypeScript exhaustiveness checking.
  switch (issue) {
    case "missing":
    case "not-regular":
      return "stale";
    case "root-unavailable":
      return "unavailable";
    case "escape":
    case "root-unreadable":
    case "symlink":
    case "read-error":
      return "unreadable";
  }
}

/**
 * How `writeFile` reports the same failures. A path now missing or occupied
 * by a directory or symlink is no longer representable as writable text →
 * `stale`; refusals and read errors left the bytes unchanged → `failed`.
 */
function saveKindFor(issue: ResolveFailure["issue"]): "stale" | "failed" {
  // biome-ignore lint/style/useDefaultSwitchClause: All members of the discriminated union are handled; keep TypeScript exhaustiveness checking.
  switch (issue) {
    case "missing":
    case "not-regular":
    case "symlink":
      return "stale";
    case "escape":
    case "root-unavailable":
    case "root-unreadable":
    case "read-error":
      return "failed";
  }
}

function escapesRoot(relativePath: string): boolean {
  if (relativePath.startsWith("/") || DRIVE_PREFIX_PATTERN.test(relativePath)) {
    return true;
  }
  return relativePath.split("/").includes("..");
}
