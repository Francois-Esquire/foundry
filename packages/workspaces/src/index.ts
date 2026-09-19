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

export type { DirectoryEntry, EntryStats } from "@foundry/core/storage";

// biome-ignore lint/performance/noBarrelFile: This is a declared package entry point; preserve its public exports.
export { CLASSIFICATION_VERSION, classifyFile } from "./classification";

// `Git` itself is opt-in on `@foundry/workspaces/git`; only its result types
// travel with the root.
export type { GitPathStatus, GitSnapshot } from "./git";
export { InMemoryWorkspaceStore } from "./in-memory-workspace-store";
export { nextWorkspaceObservation } from "./observation";
export { canonicalizeRoot, scanDirectory } from "./scanner";
export { decodeUtf8 } from "./text";
export {
  BASELINE_IGNORE_PATTERNS,
  BASELINE_IGNORE_VERSION,
  baselineIgnoreScope,
  gitignoreScope,
  isIgnored,
  walkEntries,
} from "./traverse";
export {
  FILE_KINDS,
  workspaceEntryIdSchema,
  workspaceIdSchema,
  workspaceSummary,
} from "./workspace";

// Reconciliation is deliberately unpublished. `diffCatalog` takes an identity
// allocator, and handing that out invites a second owner of File identity
// alongside WorkspaceSystem. Its cases are proven from inside the package.

export type {
  DirectoryCapable,
  DirectoryOptions,
  DirectoryRef,
} from "./directory";
export { DIRECTORY_SOURCE, directory, WithDirectory } from "./directory";

export {
  InvalidWorkspaceInputError,
  WorkspaceFileNotFoundError,
  WorkspaceNotFoundError,
  WorkspacePersistenceError,
  WorkspaceSourceUnavailableError,
  WorkspaceSourceUnsupportedError,
  WorkspaceSystemError,
} from "./errors";

export { Workspace } from "./instance";
export type {
  AnyWorkspaceExtension,
  CapOf,
  CommitCreateResult,
  CommitFileObservationResult,
  CommitReconcileResult,
  FileClassification,
  FileContentResult,
  FileKind,
  FileTextSnapshot,
  FloorFor,
  IgnoreScope,
  ObservedFacts,
  RefOf,
  RemoveWorkspaceResult,
  SaveFileCommand,
  SaveFileResult,
  StoredWorkspaceRecord,
  WalkedEntry,
  WorkspaceCatalogChange,
  WorkspaceChange,
  WorkspaceContext,
  WorkspaceCtor,
  WorkspaceEntry,
  WorkspaceEntryId,
  WorkspaceExtension,
  WorkspaceFile,
  WorkspaceFileSystem,
  WorkspaceId,
  WorkspaceIdentity,
  WorkspaceRegistration,
  WorkspaceSource,
  WorkspaceSourceIssue,
  WorkspaceSourceStatus,
  WorkspaceStore,
  WorkspaceSummary,
  WorkspaceSystemOptions,
  WorkspaceView,
  WriteOutcome,
} from "./types";
export { WorkspaceSystem } from "./workspace-system";
