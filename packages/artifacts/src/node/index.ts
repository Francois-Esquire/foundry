// biome-ignore lint/performance/noBarrelFile: Public Node entry point keeps filesystem code out of portable imports.
export { blobFiles } from "./blobs";
export {
  ARTIFACT_CONFLICTS_DIRECTORY,
  type ArtifactDiskConflict,
} from "./conflicts";
export {
  type ArtifactFileMutation,
  type ArtifactFileStamp,
  type ArtifactFileSystem,
  type ArtifactFileSystemOptions,
  artifactFileSystem,
} from "./filesystem";
export { JsonArtifactStore, type JsonArtifactStoreOptions } from "./json-store";
export {
  type ContentProjection,
  projectionMatches,
  stageProjection,
} from "./projection";
