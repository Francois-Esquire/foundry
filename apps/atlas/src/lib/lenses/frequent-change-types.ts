import type { ChurnFileKind } from "../types";

/** Bumped when `FrequentChange` changes shape or meaning. */
export const FREQUENT_CHANGE_SCHEMA_VERSION = 1;

/**
 * The hotspot commit gate, as `lib`'s hotspots apply it: a file of an
 * eligible kind whose commit count ranks at or above the percentile among
 * the workspace files of the same kind, in the churn window. There is no
 * commit floor.
 */
export interface FrequentChangeGate {
  eligibleKinds: ChurnFileKind[];
  minCommitPercentile: number;
}

/** A file that changes frequently. */
export interface FrequentChangeFile {
  /** The share of the workspace files of the same kind with fewer commits, 0–1. */
  commitPercentile: number;
  /** Its commits in the churn window. */
  commits: number;
  /** Workspace-relative path, the module index's id. */
  file: string;
  /** Lines added and deleted in the churn window. */
  linesChanged: number;
}

/** The Git history a package's churn was read from; each package's own, since a reused report can be older. */
export interface FrequentChangeHistory {
  analyzedAt: string;
  historyComplete: boolean;
  /** Where the churn window starts; absent when it covers the full history. */
  since?: string;
}

/** One package whose churn the dataset holds, by its manifest id. */
export interface FrequentChangePackage {
  /** Sorted by path. */
  files: FrequentChangeFile[];
  history: FrequentChangeHistory;
  id: string;
}

/**
 * The `frequent-change` lens: the gate it applied; every package whose
 * report holds churn, sorted by id; and `missing`, the complete packages
 * whose churn is unavailable (no Git, or not collected), sorted, so that no
 * history never reads as no frequent change. A package that failed is in
 * neither.
 */
export interface FrequentChange {
  gate: FrequentChangeGate;
  missing: string[];
  packages: FrequentChangePackage[];
}
