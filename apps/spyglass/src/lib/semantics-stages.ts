import { createHash } from "node:crypto";

import { PACKAGE_ARCHITECTURE_REVIEW_SCHEMA_VERSION } from "./architecture-review-types";
import {
  ANALYSIS_POLICY_VERSION,
  WORKSPACE_INTELLIGENCE_POLICY_VERSION,
} from "./config";
import { INTERNAL_RESPONSIBILITY_SCHEMA_VERSION } from "./internal-responsibility-types";
import { INTERNAL_REWIRING_SCHEMA_VERSION } from "./internal-rewiring-types";
import { INTERNAL_PACKAGE_TOPOLOGY_SCHEMA_VERSION } from "./internal-topology-types";
import type { LensId } from "./lenses/lens-types";
import { LENS_SCHEMA_VERSIONS } from "./lenses/lens-types";
import { PACKAGE_LOCAL_REPORT_SCHEMA_VERSION } from "./package-local-types";
import { PRIMITIVE_CONVENTION_SCHEMA_VERSION } from "./primitive-convention-types";
import { HISTORY_SCHEMA_VERSION } from "./semantics-history-types";
import { DATASET_SCHEMA_VERSION } from "./semantics-types";
import { SYMBOL_LOCALITY_SCHEMA_VERSION } from "./symbol-locality-types";
import { WORKSPACE_SURFACE_DERIVATION_SCHEMA_VERSION } from "./workspace-derive-types";
import { WORKSPACE_PROJECTION_SCHEMA_VERSION } from "./workspace-projection-types";
import {
  SUPPORTED_PACKAGE_SCHEMAS,
  WORKSPACE_SCHEMA_VERSION,
} from "./workspace-types";

export type SemanticStage =
  | "packageLocalAnalysis"
  | "internalPackageTopology"
  | "symbolLocality"
  | "internalResponsibilities"
  | "primitiveConventions"
  | "internalRewiring"
  | "packageArchitectureReview"
  | "workspaceDerivation"
  | "packageAnalysis"
  | "workspaceIngestion"
  | "workspaceIntelligence"
  | "workspaceProjection"
  | "materialization"
  | "historySnapshot"
  | LensStage;

export type LensStage = `lens:${LensId}`;

export function lensStage(id: LensId): LensStage {
  return `lens:${id}`;
}

export interface SemanticStageVersions {
  policyVersion?: number;
  schemaVersion: number;
}

export const SEMANTIC_STAGE_VERSIONS: Record<
  SemanticStage,
  SemanticStageVersions
> = {
  historySnapshot: { schemaVersion: HISTORY_SCHEMA_VERSION },
  internalPackageTopology: {
    schemaVersion: INTERNAL_PACKAGE_TOPOLOGY_SCHEMA_VERSION,
  },
  internalResponsibilities: {
    schemaVersion: INTERNAL_RESPONSIBILITY_SCHEMA_VERSION,
  },
  internalRewiring: { schemaVersion: INTERNAL_REWIRING_SCHEMA_VERSION },
  "lens:domains": { schemaVersion: LENS_SCHEMA_VERSIONS.domains },
  "lens:file-roles": { schemaVersion: LENS_SCHEMA_VERSIONS["file-roles"] },
  "lens:frequent-change": {
    schemaVersion: LENS_SCHEMA_VERSIONS["frequent-change"],
  },
  "lens:import-traffic": {
    schemaVersion: LENS_SCHEMA_VERSIONS["import-traffic"],
  },
  "lens:nesting": { schemaVersion: LENS_SCHEMA_VERSIONS.nesting },
  "lens:package-sizes": {
    schemaVersion: LENS_SCHEMA_VERSIONS["package-sizes"],
  },
  "lens:placement": { schemaVersion: LENS_SCHEMA_VERSIONS.placement },
  "lens:proximity": { schemaVersion: LENS_SCHEMA_VERSIONS.proximity },
  "lens:responsibility-groups": {
    schemaVersion: LENS_SCHEMA_VERSIONS["responsibility-groups"],
  },
  "lens:rules": { schemaVersion: LENS_SCHEMA_VERSIONS.rules },
  materialization: { schemaVersion: DATASET_SCHEMA_VERSION },
  packageAnalysis: {
    policyVersion: ANALYSIS_POLICY_VERSION,
    schemaVersion: Math.max(...SUPPORTED_PACKAGE_SCHEMAS),
  },
  packageArchitectureReview: {
    schemaVersion: PACKAGE_ARCHITECTURE_REVIEW_SCHEMA_VERSION,
  },
  packageLocalAnalysis: {
    policyVersion: ANALYSIS_POLICY_VERSION,
    schemaVersion: PACKAGE_LOCAL_REPORT_SCHEMA_VERSION,
  },
  primitiveConventions: { schemaVersion: PRIMITIVE_CONVENTION_SCHEMA_VERSION },
  symbolLocality: { schemaVersion: SYMBOL_LOCALITY_SCHEMA_VERSION },
  workspaceDerivation: {
    policyVersion: ANALYSIS_POLICY_VERSION,
    schemaVersion: WORKSPACE_SURFACE_DERIVATION_SCHEMA_VERSION,
  },
  workspaceIngestion: { schemaVersion: WORKSPACE_SCHEMA_VERSION },
  workspaceIntelligence: {
    policyVersion: WORKSPACE_INTELLIGENCE_POLICY_VERSION,
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
  },
  workspaceProjection: { schemaVersion: WORKSPACE_PROJECTION_SCHEMA_VERSION },
};

const SEMANTIC_STAGE_DEPENDENCIES: Record<
  SemanticStage,
  readonly SemanticStage[]
> = {
  historySnapshot: ["packageAnalysis", "workspaceIntelligence"],
  internalPackageTopology: ["packageLocalAnalysis"],
  internalResponsibilities: [
    "packageLocalAnalysis",
    "internalPackageTopology",
    "symbolLocality",
  ],
  internalRewiring: [
    "packageLocalAnalysis",
    "internalPackageTopology",
    "symbolLocality",
    "internalResponsibilities",
    "primitiveConventions",
  ],
  "lens:domains": ["materialization", "lens:placement"],
  "lens:file-roles": ["materialization"],
  "lens:frequent-change": ["materialization"],
  "lens:import-traffic": ["materialization"],
  "lens:nesting": ["materialization"],
  "lens:package-sizes": ["materialization"],
  "lens:placement": ["materialization"],
  "lens:proximity": ["materialization"],
  "lens:responsibility-groups": ["materialization"],
  "lens:rules": ["materialization"],
  materialization: [
    "workspaceIntelligence",
    "workspaceProjection",
    "packageArchitectureReview",
  ],
  packageAnalysis: ["packageLocalAnalysis", "workspaceDerivation"],
  packageArchitectureReview: ["internalRewiring"],
  packageLocalAnalysis: [],
  primitiveConventions: [
    "packageLocalAnalysis",
    "internalPackageTopology",
    "symbolLocality",
    "internalResponsibilities",
  ],
  symbolLocality: ["packageLocalAnalysis", "internalPackageTopology"],
  workspaceDerivation: ["packageLocalAnalysis"],
  workspaceIngestion: ["packageAnalysis"],
  workspaceIntelligence: ["workspaceIngestion"],
  workspaceProjection: ["workspaceIntelligence"],
};

export function stageClosure(stage: SemanticStage): SemanticStage[] {
  const seen = new Set<SemanticStage>();
  const visit = (current: SemanticStage): void => {
    if (seen.has(current)) {
      return;
    }
    for (const dependency of SEMANTIC_STAGE_DEPENDENCIES[current]) {
      visit(dependency);
    }
    seen.add(current);
  };
  visit(stage);
  return [...seen].sort();
}

export function sha1(material: string): string {
  return createHash("sha1").update(material).digest("hex");
}

export function stageFingerprint(stage: SemanticStage): string {
  return sha1(
    JSON.stringify(
      stageClosure(stage).map((name) => [name, SEMANTIC_STAGE_VERSIONS[name]])
    )
  ).slice(0, 16);
}
