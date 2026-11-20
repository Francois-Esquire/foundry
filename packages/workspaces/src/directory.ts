import type {
  EntryStats,
  StorageObserver,
  StorageReader,
} from "@foundry/core/storage";
import {
  isStoragePath,
  StorageApplicationError,
  StorageConflictError,
} from "@foundry/core/storage";
import { sha256Hex } from "@foundry/lib/digest";
import { decodeText, decodeUtf8 } from "@foundry/lib/encoding";
import { isTextMime } from "@foundry/lib/mime";
import {
  isFilesystemPathWithin,
  joinFilesystemPath,
  lastPathSegment,
} from "@foundry/lib/paths";
import { DIRECTORY_SOURCE } from "./constants";
import {
  errorCode,
  InvalidWorkspaceInputError,
  WorkspaceSourceUnavailableError,
} from "./errors";
import {
  canonicalizeRoot,
  resolveStoredPath,
  scanSource,
  verifyRoot,
} from "./scanner";
import type {
  FileContentResult,
  ObservedFacts,
  ResolvedSource,
  WorkspaceCtor,
  WorkspaceExtension,
  WorkspaceFile,
  WorkspaceFileSystem,
  WriteOutcome,
} from "./types";

export interface DirectoryOptions<Ref extends object = DirectoryRef> {
  readonly filesystem: WorkspaceFileSystem<Ref>;
  readonly observer?: StorageObserver;
  readonly source?: string;
}

export interface DirectoryCapable {
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

    scan(): Promise<readonly ObservedFacts[]> {
      return scanSource(filesystem, this.root);
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

    protected async insertFile(
      path: string,
      bytes: Uint8Array
    ): Promise<WriteOutcome> {
      if (!filesystem.createFile) {
        return {
          kind: "failed",
          reason: "This storage does not support file creation",
        };
      }
      const rootFailure = await verifyWorkspaceRoot(filesystem, this.root);
      if (rootFailure) {
        return { kind: "failed", reason: rootFailure.reason };
      }
      const slash = path.lastIndexOf("/");
      const parent =
        slash < 0
          ? this.root
          : await resolveStoredPath(
              filesystem,
              this.root,
              path.slice(0, slash)
            );
      if (!parent) {
        return { kind: "failed", reason: "Parent directory does not exist" };
      }
      const stats = await storedFileStats(filesystem, parent, path);
      if ("kind" in stats || stats.type !== "directory") {
        return {
          kind: "failed",
          reason: "Parent must be an existing regular directory",
        };
      }
      const resolved = await resolveConfinedPath(
        filesystem,
        this.root,
        parent,
        path
      );
      if (typeof resolved !== "string") {
        return { kind: "failed", reason: resolved.reason };
      }
      const destination = joinFilesystemPath(
        resolved,
        path.slice(slash + 1),
        filesystem.separator
      );
      try {
        await filesystem.createFile(destination, bytes);
      } catch (error) {
        if (error instanceof StorageApplicationError) {
          return { application: "pending", kind: "written" };
        }
        return {
          kind: "failed",
          reason: `Could not create ${path} (${errorCode(error)})`,
        };
      }
      return { kind: "written" };
    }

    private async resolveBytes(
      file: WorkspaceFile
    ): Promise<ResolvedBytes | ResolveFailure> {
      if (!isStoragePath(file.path)) {
        return escapePathFailure(file.path);
      }

      const rootFailure = await verifyWorkspaceRoot(filesystem, this.root);
      if (rootFailure !== undefined) {
        return rootFailure;
      }

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

export interface DirectoryRef {
  readonly path: string;
}

export function directory<Ref extends object = DirectoryRef>(
  options: DirectoryOptions<Ref>
): WorkspaceExtension<Ref, DirectoryCapable> {
  const { filesystem } = options;
  const kind = options.source ?? DIRECTORY_SOURCE;
  return {
    applies: (registration) => registration.source.kind === kind,
    async identify(ref) {
      const resolved = await resolveSource(filesystem, ref);
      const root = await canonicalizeRoot(filesystem, resolved.path);
      return {
        name: resolved.name ?? lastPathSegment(root, filesystem.separator),
        source: { kind, path: root, sourceId: resolved.sourceId ?? null },
      };
    },
    name: "directory",
    ref: filesystem.reference ?? "path",
    wrap: (Base) => WithDirectory(Base, options),
  };
}

function resolveSource<Ref extends object>(
  filesystem: WorkspaceFileSystem<Ref>,
  ref: Ref
): Promise<ResolvedSource> | ResolvedSource {
  if (filesystem.resolve) {
    return filesystem.resolve(ref);
  }
  if ("path" in ref && typeof ref.path === "string") {
    return { path: ref.path };
  }
  throw new InvalidWorkspaceInputError(
    "A directory ref needs a path or a filesystem resolver"
  );
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
    return failure(
      "read-error",
      `Could not read ${path} (${errorCode(error)})`
    );
  }
}

interface ResolvedBytes {
  readonly bytes: Uint8Array;
  readonly kind: "bytes";
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
