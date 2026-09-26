import type {
  StructuralActionDefinition,
  StructuralActionKind,
} from "./operator-decomposition-types";
import type {
  ArchitecturalOperatorKind,
  OperatorDefinition,
  ScenarioOperatorMapping,
} from "./operator-types";
import type { RecenteringScenarioKind } from "./types";

// Operator definitions are data: what an operation type means, which
// subjects it accepts, and what must later be proven. No apply/verify here;
// V12 binds mutators. The legacy internalize-export path stays where it is
// (operators.ts) and is reachable through `legacyOperatorId`.

const DEFINITIONS: Record<ArchitecturalOperatorKind, OperatorDefinition> = {
  internalize: {
    decomposition: "supported",
    executable: true,
    kind: "internalize",
    legacyOperatorId: "internalize-export",
    requiredFields: ["subject", "placement.current"],
    summary:
      "A package-public symbol ceases to be part of the package's public surface.",
    supportedSubjects: ["symbol"],
    verificationKinds: ["public-surface", "typecheck", "tests"],
  },
  move: {
    decomposition: "unsupported",
    executable: false,
    kind: "move",
    requiredFields: ["subject", "placement.current", "placement.target"],
    summary:
      "A semantic or behavioral unit changes package placement; generic, not yet decomposed.",
    supportedSubjects: ["symbol", "concept"],
    verificationKinds: [
      "typecheck",
      "tests",
      "dependency-edge",
      "anchor-preserved",
    ],
  },
  "preserve-boundary": {
    decomposition: "supported",
    executable: false,
    kind: "preserve-boundary",
    requiredFields: ["subject", "intent.reason"],
    summary:
      "A package boundary is intentional and must survive other operations.",
    supportedSubjects: ["package"],
    verificationKinds: ["anchor-preserved", "dependency-edge"],
  },
  "redirect-dependency": {
    decomposition: "partial",
    executable: false,
    kind: "redirect-dependency",
    requiredFields: ["subject", "placement.current", "placement.target"],
    summary:
      "A consumer's dependency on one package targets another package instead.",
    supportedSubjects: ["boundary"],
    verificationKinds: [
      "dependency-edge",
      "boundary-interaction",
      "typecheck",
      "tests",
      "anchor-preserved",
    ],
  },
  "rehome-behavior": {
    decomposition: "partial",
    executable: false,
    kind: "rehome-behavior",
    requiredFields: ["subject", "placement.current", "placement.target"],
    summary:
      "The semantic center stays; governing behavior outside it consolidates toward the target package.",
    supportedSubjects: ["behavior"],
    verificationKinds: [
      "behavior-location",
      "concept-center",
      "boundary-interaction",
      "typecheck",
      "tests",
      "anchor-preserved",
    ],
  },
  "rehome-concept": {
    decomposition: "partial",
    executable: false,
    kind: "rehome-concept",
    requiredFields: ["subject", "placement.current", "placement.target"],
    summary:
      "The semantic center of a concept becomes the target package instead of the current one.",
    supportedSubjects: ["concept"],
    verificationKinds: [
      "concept-center",
      "public-surface",
      "typecheck",
      "tests",
      "anchor-preserved",
    ],
  },
};

export const OPERATOR_KINDS: ArchitecturalOperatorKind[] = [
  "internalize",
  "move",
  "rehome-concept",
  "rehome-behavior",
  "redirect-dependency",
  "preserve-boundary",
];

export function getOperatorDefinition(
  kind: ArchitecturalOperatorKind
): OperatorDefinition {
  return DEFINITIONS[kind];
}

export function listOperatorDefinitions(): OperatorDefinition[] {
  return OPERATOR_KINDS.map((kind) => DEFINITIONS[kind]);
}

/**
 * Which V8.2 scenario kinds an operator kind can express. `preserve-current`
 * is the baseline and describes no change, so it yields no instance;
 * representation formalization and responsibility splits have no operator
 * yet and are reported as catalog gaps rather than forced into `move`.
 */
export const SCENARIO_OPERATOR_MAPPINGS: ScenarioOperatorMapping[] = [
  { operatorKind: "rehome-concept", scenarioKind: "rehome-semantic-center" },
  { operatorKind: "rehome-behavior", scenarioKind: "rehome-behavior" },
  { operatorKind: "rehome-behavior", scenarioKind: "consolidate-behavior" },
  {
    gap: "baseline scenario describes no change; use preserve-boundary to record intent explicitly",
    operatorKind: null,
    scenarioKind: "preserve-current",
  },
  {
    gap: "scenario requires an operator not yet in the catalog (formalize representation boundary)",
    operatorKind: null,
    scenarioKind: "formalize-representation-boundary",
  },
  {
    gap: "scenario requires an operator not yet in the catalog (split responsibility)",
    operatorKind: null,
    scenarioKind: "split-responsibility",
  },
];

export function scenarioOperatorMapping(
  kind: RecenteringScenarioKind
): ScenarioOperatorMapping {
  const mapping = SCENARIO_OPERATOR_MAPPINGS.find(
    (entry) => entry.scenarioKind === kind
  );
  if (mapping === undefined) {
    return {
      gap: `scenario kind ${kind} has no operator mapping`,
      operatorKind: null,
      scenarioKind: kind,
    };
  }
  return mapping;
}

// V11.1 structural actions: the vocabulary decompositions may use. Data
// only; the rules that emit them live in operator-decomposition.ts.

const ACTIONS: Record<StructuralActionKind, StructuralActionDefinition> = {
  "establish-target-exposure": {
    executable: false,
    group: "surface",
    kind: "establish-target-exposure",
    requiresTarget: false,
    supportedSubjects: ["exposure"],
  },
  "internalize-old-exposure": {
    executable: false,
    group: "surface",
    kind: "internalize-old-exposure",
    requiresTarget: false,
    supportedSubjects: ["exposure"],
  },
  "preserve-anchor-boundary": {
    executable: false,
    group: "preservation",
    kind: "preserve-anchor-boundary",
    requiresTarget: false,
    supportedSubjects: ["package"],
  },
  "preserve-implementation-split": {
    executable: false,
    group: "preservation",
    kind: "preserve-implementation-split",
    requiresTarget: false,
    supportedSubjects: ["behavior"],
  },
  "preserve-public-exposure": {
    executable: false,
    group: "surface",
    kind: "preserve-public-exposure",
    requiresTarget: false,
    supportedSubjects: ["exposure"],
  },
  "preserve-representation-boundary": {
    executable: false,
    group: "preservation",
    kind: "preserve-representation-boundary",
    requiresTarget: false,
    supportedSubjects: ["concept"],
  },
  "redirect-concept-dependency": {
    executable: false,
    group: "dependency",
    kind: "redirect-concept-dependency",
    requiresTarget: true,
    supportedSubjects: ["dependency"],
  },
  "relocate-behavior-responsibility": {
    executable: false,
    group: "placement",
    kind: "relocate-behavior-responsibility",
    requiresTarget: true,
    supportedSubjects: ["behavior"],
  },
  "relocate-semantic-declaration": {
    executable: false,
    group: "placement",
    kind: "relocate-semantic-declaration",
    requiresTarget: true,
    supportedSubjects: ["concept"],
  },
  "remove-boundary-participation": {
    executable: false,
    group: "dependency",
    kind: "remove-boundary-participation",
    requiresTarget: false,
    supportedSubjects: ["boundary"],
  },
};

export const STRUCTURAL_ACTION_KINDS: StructuralActionKind[] = [
  "relocate-semantic-declaration",
  "relocate-behavior-responsibility",
  "redirect-concept-dependency",
  "establish-target-exposure",
  "preserve-public-exposure",
  "internalize-old-exposure",
  "preserve-representation-boundary",
  "preserve-implementation-split",
  "remove-boundary-participation",
  "preserve-anchor-boundary",
];

export function getStructuralActionDefinition(
  kind: StructuralActionKind
): StructuralActionDefinition {
  return ACTIONS[kind];
}

export function listStructuralActionDefinitions(): StructuralActionDefinition[] {
  return STRUCTURAL_ACTION_KINDS.map((kind) => ACTIONS[kind]);
}
