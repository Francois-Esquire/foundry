import type { ChurnFileKind } from "../types";

export const FREQUENT_CHANGE_SCHEMA_VERSION = 1;

export interface FrequentChangeGate {
  eligibleKinds: ChurnFileKind[];
  minCommitPercentile: number;
}

interface FrequentChangeFile {
  commitPercentile: number;
  commits: number;
  file: string;
  linesChanged: number;
}

interface FrequentChangeHistory {
  analyzedAt: string;
  historyComplete: boolean;
  since?: string;
}

export interface FrequentChangePackage {
  files: FrequentChangeFile[];
  history: FrequentChangeHistory;
  id: string;
}

export interface FrequentChange {
  gate: FrequentChangeGate;
  missing: string[];
  packages: FrequentChangePackage[];
}
