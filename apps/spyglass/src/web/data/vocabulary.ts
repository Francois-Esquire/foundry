import type {
  DomainMatch,
  DomainPlacement,
} from "../../lib/lenses/domains-types";
import type { FileRolesPackage } from "../../lib/lenses/file-roles-types";
import type { Nesting } from "../../lib/lenses/nesting-types";
import type {
  PlacementLabel,
  PlacementLevel,
} from "../../lib/lenses/placement-types";
import type { Proximity } from "../../lib/lenses/proximity-types";
import type { PackageResponsibilityGroups } from "../../lib/lenses/responsibility-groups-types";
import type { SemanticsDeclaredDependencyKind } from "../../lib/semantics-types";

type FileKind = "source" | "test" | "story" | "config" | "other" | "unknown";

interface CodexWorkspace {
  coverage: "complete" | "partial";
  surveyedAt: string;
}

interface CodexPackage {
  analyzed: boolean;
  fileRoles: Pick<FileRolesPackage, "modules"> | undefined;
  highFanInCutoff: number;
  id: string;
  label: string;
  layer: number | null;
  path: string;
  responsibilityGroups: PackageResponsibilityGroups | undefined;
  size: number;
}

interface CodexModule {
  dependencies: number;
  dependents: number;
  directory: string;
  fileKind: FileKind;
  highFanIn: boolean;
  id: string;
  internalFanIn: number;
  mapPosition?: { x: number; y: number };
  package: string;
  path: string;
}

export interface CodexDependency {
  consumerFiles: readonly string[];
  from: string;
  sharedConcepts: number;
  strength: number;
  supplierFiles: readonly string[];
  to: string;
}

interface CodexDeclaredDependency {
  from: string;
  kind: SemanticsDeclaredDependencyKind;
  to: string;
}

export interface CodexPlacement {
  away: { modules: number; package: string }[];
  home: number;
  label: PlacementLabel;
  level: PlacementLevel;
  package: string;
  place: string;
  share: number;
  toward?: string;
  unindexed: number;
}

export interface CodexProximity {
  apart: Proximity["apart"];
  close: Proximity["close"];
  labelled: string[];
}

export type CodexNesting = Pick<Nesting, "folders" | "pathRegions" | "seams">;

export interface CodexDomains {
  declared: DomainMatch[];
  placements: Record<string, DomainPlacement>;
}

export interface LateCodex {
  nesting: CodexNesting;
  proximity: CodexProximity;
}

export interface CodexRetiredPackage {
  id: string;
  label: string;
  lastSeen: string;
}

export interface Codex {
  declaredDependencies: CodexDeclaredDependency[];
  dependencies: CodexDependency[];
  domains: CodexDomains;
  modules: CodexModule[];
  packages: CodexPackage[];
  placement: {
    dominantShare: number;
    labelled: string[];
    places: CodexPlacement[];
  };
  retiredPackages?: CodexRetiredPackage[];
  workspace: CodexWorkspace;
}
