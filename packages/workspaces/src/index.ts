/**
 * `@foundry/workspaces` — the Workspace system.
 *
 * A Workspace is durable identity over one authoritative source; an entry is
 * one included path within it. The source owns current bytes, this package
 * owns identity, inclusion, and the last successfully reconciled inventory.
 *
 * The root `Workspace` knows nothing about where bytes come from. A layer
 * (`WithDirectory` with a supplied filesystem) answers that, and further layers
 * (`WithGit` on the git subpath) add capability. `WorkspaceSystem` composes
 * them at open, owns the instance lifecycle, and drives the catalog over a
 * `WorkspaceStore` — `MemoryWorkspaceStore` unless another is supplied.
 */

export type {
  CatalogChangeInput,
  CommitChangeResult,
  CommitCreateResult,
  RemoveWorkspaceResult,
} from "./catalog";
// biome-ignore lint/performance/noBarrelFile: This is a declared package entry point; preserve its public exports.
export { WorkspaceCatalog } from "./catalog";
export { DIRECTORY_SOURCE } from "./constants";
export type {
  DirectoryCapable,
  DirectoryOptions,
  DirectoryRef,
} from "./directory";
export { directory, WithDirectory } from "./directory";
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
export { MemoryWorkspaceStore } from "./memory-store";
// `Git` itself is opt-in on `@foundry/workspaces/git`; only its result types
// travel with the root.
export type { GitPathStatus, GitSnapshot } from "./node/git";
export { polling } from "./observation";
export { scanDirectory } from "./scanner";
export type { WorkspaceStore, WorkspaceStoreWrite } from "./store";
export type {
  AnyWorkspaceExtension,
  CapOf,
  CreateFileCommand,
  FileContentResult,
  FileTextSnapshot,
  FloorFor,
  ObservedFacts,
  RefOf,
  ResolvedSource,
  SaveFileCommand,
  SaveFileResult,
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
  WorkspaceSummary,
  WorkspaceView,
  WriteOutcome,
} from "./types";
export type { WorkspaceSystemOptions } from "./workspace-system";
export { WorkspaceSystem } from "./workspace-system";
