import type { LensId } from "./lenses/lens-types";

const PACKAGE_FILE_SEPARATOR = /\//g;

export const DATASET_FILES = {
  conceptIndex: "concepts/index.json",
  dependencyInventory: "dependencies/inventory.json",
  manifest: "manifest.json",
  moduleIndex: "modules/index.json",
  projections: {
    behaviorFlow: "projections/behavior-flow.json",
    boundaries: "projections/boundaries.json",
    dependencyGraph: "projections/dependency-graph.json",
    directions: "projections/directions.json",
    implementationFlow: "projections/implementation-flow.json",
    manifest: "projections/manifest.json",
    overview: "projections/overview.json",
    packageRoles: "projections/package-roles.json",
    patterns: "projections/patterns.json",
  },
  visualization: "visualization/map.json",
  workspace: "workspace.json",
} as const;

export const COLLECTION_MANIFEST = "collection-manifest.json";

export function collectionDataset(workspace: string): string {
  return `${workspace}/`;
}

export const DATASET_ANALYSIS_FILE = "analysis/metadata.json";

export const HISTORY_DIRECTORY = "history";

export const HISTORY_FILES = {
  entities: "entities.json",
  manifest: "manifest.json",
  timeline: "timeline.json",
} as const;

export function encodePackageFile(id: string): string {
  return id.replace(PACKAGE_FILE_SEPARATOR, "__");
}

export function packageReportFile(id: string): string {
  return `packages/${encodePackageFile(id)}.json`;
}

export function packageProjectionFile(id: string): string {
  return `packages/${encodePackageFile(id)}.projection.json`;
}

export function moduleShardFile(id: string): string {
  return `modules/${encodePackageFile(id)}.json`;
}

export function moduleEdgeShardFile(id: string): string {
  return `modules/edges/${encodePackageFile(id)}.json`;
}

export function lensFile(id: LensId): string {
  return `lenses/${id}.json`;
}

export function internalsFile(id: string): string {
  return `internals/${encodePackageFile(id)}.json`;
}

export function historySnapshotFile(commit: string): string {
  return `snapshots/${commit}.json`;
}

export function historyDeltaFile(from: string, to: string): string {
  return `deltas/${from}__${to}.json`;
}
