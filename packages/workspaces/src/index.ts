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
  DirectoryCapabilities,
  DirectoryOptions,
  DirectoryRef,
} from "./directory";
export { directory, directorySource } from "./directory";
export {
  InvalidWorkspaceInputError,
  WorkspaceError,
  WorkspaceFileNotFoundError,
  WorkspaceNotFoundError,
  WorkspacePersistenceError,
  WorkspaceSourceUnavailableError,
  WorkspaceSourceUnsupportedError,
} from "./errors";
export { Workspace } from "./instance";
export { polling } from "./observation";
export { scanDirectory } from "./scanner";
export type { WorkspaceStore, WorkspaceStoreWrite } from "./store";
export type {
  AnyWorkspaceExtension,
  CapabilitiesOf,
  CreateFileCommand,
  FileContentResult,
  FileTextSnapshot,
  GitPathStatus,
  GitSnapshot,
  ObservedFacts,
  RefOf,
  ResolvedSource,
  SaveFileCommand,
  SaveFileResult,
  SourceCapabilitiesFor,
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
export type { WorkspacesOptions } from "./workspaces";
export { Workspaces } from "./workspaces";
