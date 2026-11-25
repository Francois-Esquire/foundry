export type {
  CatalogChangeInput,
  CommitChangeResult,
  CommitCreateResult,
  RemoveWorkspaceResult,
  WorkspaceCatalogChange,
  WorkspaceChange,
} from "./catalog";
// biome-ignore lint/performance/noBarrelFile: This is a declared package entry point; preserve its public exports.
export { WorkspaceCatalog } from "./catalog";
export type {
  DirectoryCapabilities,
  DirectoryOptions,
  DirectoryRef,
} from "./directory";
export { DIRECTORY_SOURCE, directory, directorySource } from "./directory";
export {
  InvalidWorkspaceInputError,
  WorkspaceError,
  WorkspaceFileNotFoundError,
  WorkspaceNotFoundError,
  WorkspacePersistenceError,
  WorkspaceSourceUnavailableError,
  WorkspaceSourceUnsupportedError,
} from "./errors";
export type {
  AnyWorkspaceExtension,
  CapabilitiesOf,
  RefOf,
  SourceCapabilitiesFor,
  WorkspaceAttachContext,
  WorkspaceAttachment,
  WorkspaceExtension,
  WorkspaceIdentity,
  WorkspaceLifecycle,
} from "./extension";
export type { ResolvedSource, WorkspaceFileSystem } from "./file-system";
export { polling } from "./observation";
export { scanDirectory } from "./scanner";
export type {
  WorkspaceEntry,
  WorkspaceEntryId,
  WorkspaceEvent,
  WorkspaceFile,
  WorkspaceId,
  WorkspaceRegistration,
  WorkspaceSource,
} from "./schema";
export type {
  FileContentResult,
  FileTextSnapshot,
  GitPathStatus,
  GitSnapshot,
  ObservedFacts,
  SaveFileResult,
  WorkspaceSourceAdapter,
  WorkspaceSourceIssue,
  WorkspaceSourceStatus,
  WriteOutcome,
} from "./source-adapter";
export type { WorkspaceStore, WorkspaceStoreWrite } from "./store";
export type {
  CreateFileCommand,
  SaveFileCommand,
  WorkspaceContext,
  WorkspaceSummary,
  WorkspaceView,
} from "./workspace";
export { Workspace } from "./workspace";
export type { WorkspacesOptions } from "./workspaces";
export { Workspaces } from "./workspaces";
