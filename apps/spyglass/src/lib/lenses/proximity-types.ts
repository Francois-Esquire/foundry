import type { StaticPathRelation } from "../types";
import type { WorkspaceCouplingPair } from "../workspace-types";

export const PROXIMITY_SCHEMA_VERSION = 1;

interface ProximityGroup {
  apart: string[];
  files: string[];
  responsibilities: string[];
}

export interface ProximityFolder {
  folder: string;
  groups: ProximityGroup[];
  package: string;
  unresolved: number;
}

export interface ProximityFile {
  distance: number;
  file: string;
  folder: string;
  package: string;
  responsibility: string;
  responsibilityFolder: string;
}

export interface ProximityCoChange {
  coChangeCommits: number;
  distance: number;
  id: string;
  jaccard: number;
  left: string;
  right: string;
  scope: WorkspaceCouplingPair["scope"];
  staticPath: StaticPathRelation;
}

interface ProximityPackage {
  id: string;
  unresolved: number;
}

export interface Proximity {
  apart: { coChanges: ProximityCoChange[]; files: ProximityFile[] };
  close: ProximityFolder[];
  missing: string[];
  packages: ProximityPackage[];
}
