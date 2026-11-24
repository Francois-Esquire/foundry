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
export { directory, directorySource } from "./directory";
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
  WorkspaceAttachContext,
  WorkspaceAttachment,
  WorkspaceCatalogChange,
  WorkspaceChange,
  WorkspaceContext,
  WorkspaceEntry,
  WorkspaceEntryId,
  WorkspaceEvent,
  WorkspaceExtension,
  WorkspaceFile,
  WorkspaceFileSystem,
  WorkspaceId,
  WorkspaceIdentity,
  WorkspaceLifecycle,
  WorkspaceRegistration,
  WorkspaceSource,
  WorkspaceSourceAdapter,
  WorkspaceSourceIssue,
  WorkspaceSourceStatus,
  WorkspaceSummary,
  WorkspaceView,
  WriteOutcome,
} from "./types";
export type { WorkspaceSystemOptions } from "./workspace-system";
export { WorkspaceSystem } from "./workspace-system";
