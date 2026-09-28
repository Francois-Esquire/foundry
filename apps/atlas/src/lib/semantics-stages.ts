import { createHash } from "node:crypto";

import { PACKAGE_ARCHITECTURE_REVIEW_SCHEMA_VERSION } from "./architecture-review-types";
import {
  ANALYSIS_POLICY_VERSION,
  WORKSPACE_INTELLIGENCE_POLICY_VERSION,
} from "./config";
import { INTERNAL_RESPONSIBILITY_SCHEMA_VERSION } from "./internal-responsibility-types";
import { INTERNAL_REWIRING_SCHEMA_VERSION } from "./internal-rewiring-types";
import { INTERNAL_PACKAGE_TOPOLOGY_SCHEMA_VERSION } from "./internal-topology-types";
import { PACKAGE_LOCAL_REPORT_SCHEMA_VERSION } from "./package-local-types";
import { PRIMITIVE_CONVENTION_SCHEMA_VERSION } from "./primitive-convention-types";
import { SEMANTICS_HISTORY_SCHEMA_VERSION } from "./semantics-history-types";
import { SEMANTICS_DATASET_SCHEMA_VERSION } from "./semantics-types";
import { SYMBOL_LOCALITY_SCHEMA_VERSION } from "./symbol-locality-types";
import { WORKSPACE_SURFACE_DERIVATION_SCHEMA_VERSION } from "./workspace-derive-types";
import { WORKSPACE_PROJECTION_SCHEMA_VERSION } from "./workspace-projection-types";
import {
  SUPPORTED_PACKAGE_SCHEMAS,
  WORKSPACE_SCHEMA_VERSION,
} from "./workspace-types";

// V12.5 semantic stage graph. Every cached or materialized artifact names the
// stage that produced it; a stage's fingerprint covers its own versions and,
// transitively, those of the stages it consumes. Bumping a version therefore
// invalidates exactly the artifacts downstream of the change: a projection
// schema bump leaves package reports and history snapshots reusable, a
// package policy bump invalidates everything.

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
  | "historySnapshot";

export interface SemanticStageVersions {
  policyVersion?: number;
  schemaVersion: number;
}

export const SEMANTIC_STAGE_VERSIONS: Record<
  SemanticStage,
  SemanticStageVersions
> = {
  historySnapshot: { schemaVersion: SEMANTICS_HISTORY_SCHEMA_VERSION },
  /** V13.0: pure derivation from one local report; no workspace stage consumes it. */
  internalPackageTopology: {
    schemaVersion: INTERNAL_PACKAGE_TOPOLOGY_SCHEMA_VERSION,
  },
  /** V13.2: pure derivation from the local report, its topology, and its locality. */
  internalResponsibilities: {
    schemaVersion: INTERNAL_RESPONSIBILITY_SCHEMA_VERSION,
  },
  /** V13.4: pure derivation from the five package-intelligence reports above. */
  internalRewiring: { schemaVersion: INTERNAL_REWIRING_SCHEMA_VERSION },
  materialization: { schemaVersion: SEMANTICS_DATASET_SCHEMA_VERSION },
  /** The assembled `SurfaceReport`: local analysis joined with derivation. */
  packageAnalysis: {
    policyVersion: ANALYSIS_POLICY_VERSION,
    schemaVersion: Math.max(...SUPPORTED_PACKAGE_SCHEMAS),
  },
  /** V13.5: pure derivation from the rewiring report alone. */
  packageArchitectureReview: {
    schemaVersion: PACKAGE_ARCHITECTURE_REVIEW_SCHEMA_VERSION,
  },
  packageLocalAnalysis: {
    policyVersion: ANALYSIS_POLICY_VERSION,
    schemaVersion: PACKAGE_LOCAL_REPORT_SCHEMA_VERSION,
  },
  /** V13.3: pure derivation from the local report, topology, locality, and responsibilities. */
  primitiveConventions: { schemaVersion: PRIMITIVE_CONVENTION_SCHEMA_VERSION },
  /** V13.1: pure derivation from one local report and its topology. */
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

/** Direct inputs of each stage; the analyzer's real data flow, nothing implied. */
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
  materialization: ["workspaceIntelligence", "workspaceProjection"],
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

/** The stage and everything it transitively consumes, in a stable order. */
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

/** Versions of the stage closure, hashed; equal whenever the semantics they govern are. */
export function stageFingerprint(stage: SemanticStage): string {
  return sha1(
    JSON.stringify(
      stageClosure(stage).map((name) => [name, SEMANTIC_STAGE_VERSIONS[name]])
    )
  ).slice(0, 16);
}
