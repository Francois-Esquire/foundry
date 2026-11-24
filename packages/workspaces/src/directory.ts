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
  ResolvedSource,
  WorkspaceExtension,
  WorkspaceFile,
  WorkspaceFileSystem,
  WorkspaceSourceAdapter,
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

export interface DirectoryRef {
  readonly path: string;
}

export function directorySource<Ref extends object = DirectoryRef>(
  root: string,
  options: DirectoryOptions<Ref>
): WorkspaceSourceAdapter {
  const { filesystem } = options;
  const watcher = options.observer ?? filesystem;

  return {
    async insertFile(path: string, bytes: Uint8Array): Promise<WriteOutcome> {
      if (!isStoragePath(path)) {
        return { kind: "failed", reason: "Invalid relative storage path" };
      }
      if (!filesystem.createFile) {
        return {
          kind: "failed",
          reason: "This storage does not support file creation",
        };
      }
      const slash = path.lastIndexOf("/");
      const parentPath = slash < 0 ? "" : path.slice(0, slash);
      const located = await locateConfined(filesystem, root, parentPath, {
        expectedType: "directory",
        missingReason: "Parent directory does not exist",
        nonMatchingReason: "Parent must be an existing regular directory",
      });
      if (located.kind === "failure") {
        return { kind: "failed", reason: located.reason };
      }
      const destination = joinFilesystemPath(
        located.resolved,
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
    },

    async readFile(file: WorkspaceFile): Promise<FileContentResult> {
      const read = await resolveFileBytes(filesystem, root, file);
      if (read.kind === "failure") {
        return { kind: contentKindFor(read.issue), reason: read.reason };
      }
      const text = decodeFileBytes(file, read.bytes);
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
    },

    scan: () => scanSource(filesystem, root),

    ...(watcher.watch
      ? {
          watch: (changed: () => void, failed: (error: unknown) => void) =>
            watcher.watch?.(root, changed, failed) ??
            Promise.resolve(undefined),
        }
      : {}),

    async writeFile(
      file: WorkspaceFile,
      bytes: Uint8Array,
      expectedDigest: string
    ): Promise<WriteOutcome> {
      const read = await resolveFileBytes(filesystem, root, file);
      if (read.kind === "failure") {
        return { kind: saveKindFor(read.issue), reason: read.reason };
      }

      const currentText = decodeFileBytes(file, read.bytes);
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
    },
  };
}

export function directory<Ref extends object = DirectoryRef>(
  options: DirectoryOptions<Ref>
): WorkspaceExtension<Ref, DirectoryCapable> {
  const { filesystem } = options;
  const kind = options.source ?? DIRECTORY_SOURCE;
  return {
    applies: (registration) => registration.source.kind === kind,
    attach: (workspace) => ({ capabilities: { root: workspace.source.path } }),
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
    source: (registration) =>
      directorySource(registration.source.path, options),
  };
}

function decodeFileBytes(
  file: WorkspaceFile,
  bytes: Uint8Array
): string | null {
  return isTextMime(file.mime) ? decodeUtf8(bytes) : decodeText(bytes);
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

function failure(
  issue: ResolveFailure["issue"],
  reason: string
): ResolveFailure {
  return { issue, kind: "failure", reason };
}

async function locateConfined(
  filesystem: Pick<
    StorageReader,
    "lstat" | "readDirectory" | "realpath" | "separator"
  >,
  root: string,
  relativePath: string,
  expect: {
    readonly expectedType: "directory" | "file";
    readonly missingReason: string;
    readonly nonMatchingReason: string;
  }
): Promise<
  { readonly kind: "ok"; readonly resolved: string } | ResolveFailure
> {
  if (relativePath !== "" && !isStoragePath(relativePath)) {
    return failure(
      "escape",
      `Refusing a File path that escapes its Workspace root: ${relativePath}`
    );
  }

  try {
    await verifyRoot(filesystem, root);
  } catch (error) {
    if (!(error instanceof WorkspaceSourceUnavailableError)) {
      throw error;
    }
    return failure(
      error.issue === "unavailable" ? "root-unavailable" : "root-unreadable",
      error.message
    );
  }

  const absolute =
    relativePath === ""
      ? root
      : await resolveStoredPath(filesystem, root, relativePath);
  if (absolute === null) {
    return failure("missing", expect.missingReason);
  }

  let stats: EntryStats;
  try {
    stats = await filesystem.lstat(absolute);
  } catch {
    return failure("missing", expect.missingReason);
  }
  if (stats.type === "symlink") {
    return failure(
      "symlink",
      expect.expectedType === "file"
        ? `Refusing to follow a symlink at ${relativePath}`
        : expect.nonMatchingReason
    );
  }
  if (stats.type !== expect.expectedType) {
    return failure("not-regular", expect.nonMatchingReason);
  }

  let resolved: string;
  try {
    resolved = await filesystem.realpath(absolute);
  } catch {
    return failure("missing", expect.missingReason);
  }
  if (!isFilesystemPathWithin(root, resolved, filesystem.separator)) {
    return failure(
      "escape",
      `Refusing a File that resolves outside its Workspace root: ${relativePath}`
    );
  }
  return { kind: "ok", resolved };
}

async function resolveFileBytes(
  filesystem: StorageReader,
  root: string,
  file: WorkspaceFile
): Promise<
  | {
      readonly bytes: Uint8Array;
      readonly kind: "bytes";
      readonly resolved: string;
    }
  | ResolveFailure
> {
  const located = await locateConfined(filesystem, root, file.path, {
    expectedType: "file",
    missingReason: `${file.path} is no longer present in the Workspace source`,
    nonMatchingReason: `${file.path} is no longer a regular file`,
  });
  if (located.kind === "failure") {
    return located;
  }
  try {
    return {
      bytes: await filesystem.readFile(located.resolved),
      kind: "bytes",
      resolved: located.resolved,
    };
  } catch (error) {
    return failure(
      "read-error",
      `Could not read ${file.path} (${errorCode(error)})`
    );
  }
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
