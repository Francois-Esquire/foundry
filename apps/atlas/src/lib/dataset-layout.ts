// Where each file of a dataset lives, relative to its output directory. The
// writers name files through these, and the manifest records the result; the
// reader needs only the manifest's own path and history's names from here,
// and finds everything else through what the manifest records.

import type { LensId } from "./lenses/lens-types";

const PACKAGE_FILE_SEPARATOR = /\//g;

/** The dataset's fixed files; the manifest records this object as `files`. */
export const DATASET_FILES = {
  conceptIndex: "concepts/index.json",
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
  workspace: "workspace.json",
} as const;

/** The directory under the output that holds history, when a scan asks for it. */
export const HISTORY_DIRECTORY = "history";

/** History's fixed files, relative to `HISTORY_DIRECTORY`. */
export const HISTORY_FILES = {
  entities: "entities.json",
  manifest: "manifest.json",
  timeline: "timeline.json",
} as const;

/** `@foundry/db` → `@foundry__db`; reversible because npm names never contain `__`. */
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

/** Relative to `HISTORY_DIRECTORY`. */
export function historySnapshotFile(commit: string): string {
  return `snapshots/${commit}.json`;
}

/** Relative to `HISTORY_DIRECTORY`. */
export function historyDeltaFile(from: string, to: string): string {
  return `deltas/${from}__${to}.json`;
}
