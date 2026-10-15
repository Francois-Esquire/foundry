import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import type { InternalResponsibilityReport } from "./internal-responsibility-types";
import type {
  CompositionEvidence,
  InternalRewiringReport,
  InternalRewiringScenario,
  InternalRewiringScenarioKind,
  ScenarioFamily,
} from "./internal-rewiring-types";
import { INTERNAL_REWIRING_SCHEMA_VERSION } from "./internal-rewiring-types";
import type { InternalPackageTopology } from "./internal-topology-types";
import type { PackageLocalReport } from "./package-local-types";
import type { PrimitiveConventionReport } from "./primitive-convention-types";
import {
  COMPOSITION_ROLE_DEFINITIONS,
  COMPOSITION_ROLES,
  ELIGIBILITY,
  KIND_DEFINITIONS,
  KINDS,
  PRESERVING_KINDS,
  summarize,
} from "./rewiring/common";
import { createScenarioCollection } from "./rewiring/construction";
import { createRewiringFacts } from "./rewiring/facts";
import { collectModules } from "./rewiring/modules";
import { createMovementAnalysis } from "./rewiring/movement";
import { collectRelationships } from "./rewiring/relationships";
import { collectSymbols } from "./rewiring/symbols";
import type { SymbolLocalityReport } from "./symbol-locality-types";
export function analyzeInternalRewiring(
  local: PackageLocalReport,
  topology: InternalPackageTopology,
  locality: SymbolLocalityReport,
  responsibilities: InternalResponsibilityReport,
  primitives: PrimitiveConventionReport,
  config: AnalysisConfig = ANALYSIS_CONFIG
): InternalRewiringReport {
  const facts = createRewiringFacts(
    local,
    topology,
    locality,
    responsibilities,
    primitives,
    config
  );
  const movement = createMovementAnalysis(facts);
  const collection = createScenarioCollection(facts, movement);
  collectSymbols(facts, movement, collection);
  collectModules(facts, movement, collection);
  for (const convention of primitives.conventions) {
    collection.visitConvention(convention);
  }
  collectRelationships(facts, movement, collection);
  // Order and summarize.
  const kindIndex = (kind: InternalRewiringScenarioKind) => KINDS.indexOf(kind);
  collection.scenarios.sort(
    (a, b) =>
      a.subject.key.localeCompare(b.subject.key) ||
      kindIndex(a.kind) - kindIndex(b.kind) ||
      a.id.localeCompare(b.id)
  );
  collection.candidates.sort(
    (a, b) =>
      a.subject.key.localeCompare(b.subject.key) ||
      kindIndex(a.kind) - kindIndex(b.kind)
  );
  const scenarioById = new Map(collection.scenarios.map((s) => [s.id, s]));
  const families: ScenarioFamily[] = [...collection.familyByKey.values()]
    .map((family) => {
      const ids = family.ids
        .map((id) => scenarioById.get(id))
        .filter((s): s is InternalRewiringScenario => s !== undefined)
        .sort(
          (a, b) =>
            kindIndex(a.kind) - kindIndex(b.kind) || a.id.localeCompare(b.id)
        )
        .map((s) => s.id);
      return {
        preservationOnly: ids.every((id) =>
          PRESERVING_KINDS.includes(
            scenarioById.get(id)?.kind ?? "preserve-current"
          )
        ),
        scenarioIds: ids,
        subject: family.subject,
      };
    })
    .sort((a, b) => a.subject.key.localeCompare(b.subject.key));
  const composition = [...facts.compositionByModule.values()].sort((a, b) =>
    a.module.localeCompare(b.module)
  );
  const summary = summarize(
    collection.scenarios,
    collection.candidates,
    families,
    composition,
    responsibilities
  );
  return {
    candidates: collection.candidates,
    composition,
    families,
    limitations: [
      "no internal anchor model: an intentional boundary cannot be told from an incidental one, so every movement scenario carries that uncertainty",
      "movement closure reads declaration-level relationships (annotations, typeof queries, callees, concept relationships); references inside function bodies are not measured",
      "a package-public symbol's external consumers are outside the package boundary; their impact is not evaluated",
      "composition evidence is syntactic: how internal import bindings are used, not what the calls do",
      "package anchors protect the package boundary, not internal placement, and are not used here",
      "effects are simulated over the affected subgraph from canonical topology; no source is read or written",
    ],
    package: responsibilities.package,
    policy: {
      alignment: facts.policy.alignment,
      candidateModules: facts.policy.candidateModules,
      closure: facts.policy.closure,
      compositionRoleDefinitions: COMPOSITION_ROLE_DEFINITIONS,
      compositionRoles: COMPOSITION_ROLES,
      compositionRoot: facts.policy.compositionRoot,
      contract: facts.policy.contract,
      eligibility: ELIGIBILITY,
      identity:
        "sha256 over the kind, the sorted subject ids, and the proposed target",
      indirection: facts.policy.indirection,
      kindDefinitions: KIND_DEFINITIONS,
      kinds: KINDS,
      orchestration: facts.policy.orchestration,
      order: "subject key, then kind order with preserve-current first",
      ranking: "none",
      split: facts.policy.split,
      surface: facts.policy.surface,
      targets:
        "architectural scope and existing candidate modules; exact paths deferred",
    },
    scenarios: collection.scenarios,
    schemaVersion: INTERNAL_REWIRING_SCHEMA_VERSION,
    summary,
  };
}
export function getRewiringScenario(
  report: InternalRewiringReport,
  id: string
): InternalRewiringScenario | undefined {
  return report.scenarios.find((scenario) => scenario.id === id);
}
export function getScenariosForSymbol(
  report: InternalRewiringReport,
  symbolId: string
): InternalRewiringScenario[] {
  return report.scenarios.filter((scenario) =>
    scenario.subject.symbolIds?.includes(symbolId)
  );
}
export function getScenariosForModule(
  report: InternalRewiringReport,
  module: string
): InternalRewiringScenario[] {
  return report.scenarios.filter(
    (scenario) =>
      scenario.subject.module === module ||
      scenario.subject.edges?.some(
        (edge) => edge.source === module || edge.target === module
      )
  );
}
export function getScenariosForResponsibility(
  report: InternalRewiringReport,
  responsibility: string
): InternalRewiringScenario[] {
  return report.scenarios.filter(
    (scenario) =>
      scenario.current.responsibility === responsibility ||
      scenario.proposed.responsibility === responsibility ||
      scenario.subject.relationship?.from === responsibility ||
      scenario.subject.relationship?.to === responsibility ||
      scenario.effects.responsibilityBoundaries.responsibilitiesTouched.includes(
        responsibility
      )
  );
}
export function getScenariosByKind(
  report: InternalRewiringReport,
  kind: InternalRewiringScenarioKind
): InternalRewiringScenario[] {
  return report.scenarios.filter((scenario) => scenario.kind === kind);
}
export function getCompositionEvidence(
  report: InternalRewiringReport,
  module: string
): CompositionEvidence | undefined {
  return report.composition.find((entry) => entry.module === module);
}
