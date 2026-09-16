/**
 * `@foundry/workspaces` — the Workspace system.
 *
 * A Workspace is durable identity over one authoritative source; a File is one
 * included file within it. The source owns current bytes, this package owns
 * identity, inclusion, and the last successfully reconciled inventory.
 *
 * The root `Workspace` knows nothing about where bytes come from. A layer
 * (`WithDirectory` here, the Artifact one in the artifacts package) answers
 * that, and further layers (`WithGit` on the git subpath) add capability.
 * `WorkspaceSystem` composes them at open and owns the instance lifecycle.
 *
 * The dependency runs one way: `@foundry/db` supplies the durable store and
 * depends on this package, never the reverse.
 */

export type { FileClassification } from "./classification";
// biome-ignore lint/performance/noBarrelFile: This is a declared package entry point; preserve its public exports.
export { CLASSIFICATION_VERSION, classifyFile } from "./classification";
export type {
  DirectoryEntry,
  EntryStats,
  WorkspaceFileSystem,
} from "./filesystem";
export { nodeFileSystem, sha256Hex } from "./filesystem";
// `Git` itself is opt-in on `@foundry/workspaces/git`; only its result types
// travel with the root.
export type { GitPathStatus, GitSnapshot } from "./git";
export { InMemoryWorkspaceStore } from "./in-memory-workspace-store";
export type { FileCandidate } from "./scanner";
export { canonicalizeRoot, scanDirectory } from "./scanner";
export { decodeUtf8 } from "./text";

export type { IgnoreScope, WalkedFile } from "./traverse";
export {
  BASELINE_IGNORE_PATTERNS,
  BASELINE_IGNORE_VERSION,
  baselineIgnoreScope,
  gitignoreScope,
  isIgnored,
  normalizeRelativePath,
  walkFiles,
} from "./traverse";
export type {
  FileContentResult,
  FileKind,
  FileTextSnapshot,
  SaveFileCommand,
  SaveFileResult,
  WorkspaceFile,
  WorkspaceFileId,
  WorkspaceId,
  WorkspaceRegistration,
  WorkspaceSource,
  WorkspaceSourceStatus,
  WorkspaceSummary,
  WorkspaceView,
  WriteOutcome,
} from "./workspace";
export {
  FILE_KINDS,
  workspaceFileIdSchema,
  workspaceIdSchema,
  workspaceSummary,
} from "./workspace";
export type {
  CommitCreateResult,
  CommitFileObservationResult,
  CommitReconcileResult,
  ObservedFacts,
  RemoveWorkspaceResult,
  StoredFileRecord,
  StoredWorkspaceRecord,
  WorkspaceCatalogChange,
  WorkspaceStore,
} from "./workspace-store";
export { nextWorkspaceObservation } from "./workspace-store";

// Reconciliation is deliberately unpublished. `diffCatalog` takes an identity
// allocator, and handing that out invites a second owner of File identity
// alongside WorkspaceSystem. Its cases are proven from inside the package.

export type {
  DirectoryCapable,
  DirectoryOptions,
  DirectoryRef,
} from "./directory";
export { DIRECTORY_SOURCE, directory, WithDirectory } from "./directory";
export type { WorkspaceSourceIssue } from "./errors";
export {
  InvalidWorkspaceInputError,
  WorkspaceFileNotFoundError,
  WorkspaceNotFoundError,
  WorkspacePersistenceError,
  WorkspaceSourceUnavailableError,
  WorkspaceSourceUnsupportedError,
  WorkspaceSystemError,
} from "./errors";
export type {
  AnyWorkspaceExtension,
  CapOf,
  FloorFor,
  RefOf,
  WorkspaceExtension,
  WorkspaceIdentity,
} from "./extension";
export type { WorkspaceContext, WorkspaceCtor } from "./instance";
export { Workspace } from "./instance";
export type { WorkspaceSystemOptions } from "./workspace-system";
export { WorkspaceSystem } from "./workspace-system";
