/**
 * The library entry, `@foundry/atlas`: `scan` and `serve` (with
 * `scan.collection` and `serve.collection` for several workspaces), the
 * types of what they return and take, the two dataset errors, and the three
 * schema versions.
 * Every name is listed here; nothing else in `src/lib` is public, so the
 * analyses, the reader, and `serve`'s helpers (`viewerRoot`, `DEFAULT_PORT`,
 * `checkPort`) stay internal.
 *
 * Public names are the glossary's words (`apps/atlas/CONTEXT.md`): dataset,
 * history, package, workspace. A name takes an `Atlas` prefix only where the
 * bare word would collide with a platform name (`Server`) or say nothing in
 * a consumer's file (`Config`). Types nested inside these are not exported
 * and keep their internal names, which editors show on hover; reach them by
 * indexed access, such as `DatasetManifest["packages"][number]`.
 * `PackageReport` is the analysis's `SurfaceReport` under its glossary name.
 */

export type { AtlasConfig } from "./atlas-config";
export type { CollectionManifest } from "./collection-types";
// biome-ignore lint/performance/noBarrelFile: This is the public package entry point.
export { COLLECTION_SCHEMA_VERSION } from "./collection-types";
export type { PackageReport } from "./dataset";
export { DatasetNotFoundError, DatasetReplacedError } from "./dataset";
export type { PackageInternals } from "./internal-analysis-types";
export type {
  CollectionProgressEvent,
  CollectionScan,
  CollectionScanOptions,
  Scan,
  ScanOptions,
  ScanProgressEvent,
  WorkspaceScan,
} from "./scan";
export { scan } from "./scan";
export type { HistoryManifest } from "./semantics-history-types";
export { HISTORY_SCHEMA_VERSION } from "./semantics-history-types";
export type { DatasetManifest } from "./semantics-types";
export { DATASET_SCHEMA_VERSION } from "./semantics-types";
export type { AtlasServer, CollectionServer, ServeOptions } from "./serve";
export { serve } from "./serve";
export type { WorkspaceReport } from "./workspace-types";
