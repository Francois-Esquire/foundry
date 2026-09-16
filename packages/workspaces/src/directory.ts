const PATH_SEPARATORS_PATTERN = /[/\\]/;
const DRIVE_PREFIX_PATTERN = /^[a-zA-Z]:/;

import { WorkspaceSourceUnavailableError } from "./errors";
import type { WorkspaceExtension } from "./extension";
import type { WorkspaceFileSystem } from "./filesystem";
import { isBeneath, nodeFileSystem, sha256Hex } from "./filesystem";
import type { WorkspaceCtor } from "./instance";
import type { FileCandidate } from "./scanner";
import {
  canonicalizeRoot,
  resolveStoredPath,
  scanDirectory,
  verifyRoot,
} from "./scanner";
import { decodeUtf8, errorCode } from "./text";
import type { FileContentResult, WriteOutcome } from "./workspace";
import type { StoredFileRecord } from "./workspace-store";

/** The stored `source` value a directory Workspace carries. */
export const DIRECTORY_SOURCE = "host";

export interface DirectoryOptions {
  readonly filesystem?: WorkspaceFileSystem;
}

/**
 * The layer over a directory on this machine. Answers the three source
 * primitives from `source.path`, which is the canonical absolute root.
 *
 * Every read and write re-runs the confinement chain immediately before
 * touching bytes: lexical escape, root availability, stored-path resolution,
 * final lstat, symlink refusal, regular-file check, realpath, beneath-root
 * confinement. Replacement is atomic (sibling temp + same-directory rename).
 */
export interface DirectoryCapable {
  /** The canonical absolute root. Never leaves the trust boundary. */
  readonly root: string;
}

export function WithDirectory<B extends WorkspaceCtor>(
  Base: B,
  options: DirectoryOptions = {}
): B & WorkspaceCtor<DirectoryCapable> {
  const filesystem = options.filesystem ?? nodeFileSystem;

  return class extends Base implements DirectoryCapable {
    get root(): string {
      return this.source.path;
    }

    scan(): Promise<readonly FileCandidate[]> {
      return scanDirectory(filesystem, this.root);
    }

    protected async readFile(
      file: StoredFileRecord
    ): Promise<FileContentResult> {
      const read = await this.resolveBytes(file);
      if (read.kind === "failure") {
        return { kind: contentKindFor(read.issue), reason: read.reason };
      }
      const text = decodeUtf8(read.bytes);
      const checksum = sha256Hex(read.bytes);
      return text === null
        ? {
            checksum,
            kind: "binary",
            mimeType: file.mimeType,
            size: read.bytes.byteLength,
          }
        : {
            checksum,
            kind: "text",
            mimeType: file.mimeType,
            size: read.bytes.byteLength,
            text,
          };
    }

    protected async writeFile(
      file: StoredFileRecord,
      bytes: Uint8Array,
      expectedChecksum: string
    ): Promise<WriteOutcome> {
      const read = await this.resolveBytes(file);
      if (read.kind === "failure") {
        return { kind: saveKindFor(read.issue), reason: read.reason };
      }

      const currentText = decodeUtf8(read.bytes);
      if (currentText === null) {
        return {
          kind: "stale",
          reason: `${file.path} is no longer UTF-8 text`,
        };
      }

      const currentChecksum = sha256Hex(read.bytes);
      if (currentChecksum !== expectedChecksum) {
        return {
          current: {
            checksum: currentChecksum,
            size: read.bytes.byteLength,
            text: currentText,
          },
          kind: "conflict",
        };
      }

      try {
        await filesystem.replaceFile(read.resolved, bytes);
      } catch (error) {
        // `replaceFile` guarantees a throw left the original bytes unchanged.
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
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep confinement checks and their ordered failure classifications together.
    private async resolveBytes(
      file: StoredFileRecord
    ): Promise<ResolvedBytes | ResolveFailure> {
      if (escapesRoot(file.path)) {
        return {
          issue: "escape",
          kind: "failure",
          reason: `Refusing a File path that escapes its Workspace root: ${file.path}`,
        };
      }

      // Asked before the File itself, so an unplugged source reads as one
      // unavailable Workspace rather than as every File having gone stale.
      try {
        await verifyRoot(filesystem, this.root);
      } catch (error) {
        if (!(error instanceof WorkspaceSourceUnavailableError)) {
          throw error;
        }
        return {
          issue:
            error.issue === "unavailable"
              ? "root-unavailable"
              : "root-unreadable",
          kind: "failure",
          reason: error.message,
        };
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
        return {
          issue: "missing",
          kind: "failure",
          reason: `${file.path} is no longer present in the Workspace source`,
        };
      }

      let stats: Awaited<ReturnType<typeof filesystem.lstat>>;
      try {
        stats = await filesystem.lstat(absolute);
      } catch {
        return {
          issue: "missing",
          kind: "failure",
          reason: `${file.path} is no longer present in the Workspace source`,
        };
      }
      if (stats.isSymbolicLink) {
        return {
          issue: "symlink",
          kind: "failure",
          reason: `Refusing to follow a symlink at ${file.path}`,
        };
      }
      if (!stats.isFile) {
        return {
          issue: "not-regular",
          kind: "failure",
          reason: `${file.path} is no longer a regular file`,
        };
      }

      // The lexical check above and the lstat only cover the final component.
      // A directory component swapped for a symlink after the scan would still
      // resolve outside the root, so the resolved path — not the joined one —
      // is what has to be confined.
      let resolved: string;
      try {
        resolved = await filesystem.realpath(absolute);
      } catch {
        return {
          issue: "missing",
          kind: "failure",
          reason: `${file.path} is no longer present in the Workspace source`,
        };
      }
      if (!isBeneath(this.root, resolved)) {
        return {
          issue: "escape",
          kind: "failure",
          reason: `Refusing a File that resolves outside its Workspace root: ${file.path}`,
        };
      }

      let bytes: Uint8Array;
      try {
        bytes = await filesystem.readFile(resolved);
      } catch (error) {
        // The error's own message embeds the absolute path Node was opening,
        // and this reason crosses to the renderer. Only the relative path and
        // a code.
        return {
          issue: "read-error",
          kind: "failure",
          reason: `Could not read ${file.path} (${errorCode(error)})`,
        };
      }

      return { bytes, kind: "bytes", resolved };
    }
  };
}

/** What `add` takes for a directory: the path as selected, canonicalized here. */
export interface DirectoryRef {
  readonly path: string;
}

/**
 * The directory layer as an extension: claims every `"host"` record and
 * turns `{ path }` into an identity.
 *
 * A duplicate canonical root — including a different spelling of the same
 * directory, and including a concurrent add that wins the race — resolves
 * to the Workspace that already exists.
 */
export function directory(
  options: DirectoryOptions = {}
): WorkspaceExtension<DirectoryRef, DirectoryCapable> {
  const filesystem = options.filesystem ?? nodeFileSystem;
  return {
    applies: (record) => record.source === DIRECTORY_SOURCE,
    async identify({ path }) {
      const root = await canonicalizeRoot(filesystem, path);
      return {
        name: basenameOf(root),
        path: root,
        source: DIRECTORY_SOURCE,
        sourceId: null,
      };
    },
    name: "directory",
    ref: "path",
    wrap: (Base) => WithDirectory(Base, options),
  };
}

function basenameOf(root: string): string {
  const segments = root.split(PATH_SEPARATORS_PATTERN).filter(Boolean);
  return segments.at(-1) ?? root;
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

/** How `readFile` reports each confinement/read failure — the pre-save shape. */
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
