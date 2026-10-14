import { join } from "node:path";
import type { ClassMemberTypes, Project } from "ts-morph";

import { Node } from "ts-morph";

import type { Boundary } from "./boundary";
import { ownerBoundary } from "./boundary";
import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import { classifyFile } from "./file-kind";
import type {
  ChurnFileKind,
  ConceptBehaviorDistribution,
  ConceptBehaviorParticipant,
  ConceptEvolutionCoupling,
  ConceptEvolutionEvidence,
  ConceptFamily,
  ConceptIdentity,
  ConceptOwnershipAnalysis,
  ConceptOwnershipCandidate,
  ConceptOwnershipCenter,
  ConceptOwnershipOverlapContext,
  ConceptOwnershipReport,
  ConceptOwnershipTension,
  ConceptPackagePresence,
  ConceptRepresentation,
  ConceptRepresentationKinds,
  CouplingContext,
  FileChangeCouplingPair,
  OwnershipAlignment,
  OwnershipCaution,
  OwnershipDimension,
  OwnershipEvidence,
  OwnershipRole,
  SurfaceReport,
} from "./types";

export interface ConceptOwnershipSource
  extends Pick<
    SurfaceReport,
    | "conceptInventory"
    | "conceptOverlap"
    | "churn"
    | "hotspots"
    | "changeCoupling"
    | "dependencyGravity"
    | "architecturalProfile"
  > {
  anchor?: SurfaceReport["anchor"];
  boundary: Boundary;
  project: Project;
}

/** Per-package facts for one family. The gate below reads nothing else. */
export interface OwnershipFacts {
  anchor?: { reason?: string };
  /** Target profile signals; the seed package is always the target. */
  architectureSignals: string[];
  behavior: ConceptBehaviorDistribution;
  concept: ConceptIdentity;
  /** Interface seed with at least one method member: implementations are expected. */
  contractLike: boolean;
  conversions: { package: string; count: number }[];
  /** Absent when history is unavailable. */
  evolution?: ConceptEvolutionEvidence[];
  overlap: ConceptOwnershipOverlapContext[];
  /** V7.1 presence rows: seed, representations, implementations, references. */
  packages: ConceptPackagePresence[];
  referenceTotal: number;
  /** The same representations by declaring-file kind; sums to the presence rows. */
  representationKinds: ConceptRepresentationKinds[];
  representationTotal: number;
}

const DIMENSION_ORDER: OwnershipDimension[] = [
  "declaration",
  "representation",
  "implementation",
  "reference",
  "behavior",
  "conversion",
  "evolution",
  "architecture",
  "intent",
];

const ROLE_ORDER: OwnershipRole[] = [
  "semantic-center",
  "implementation-center",
  "usage-center",
  "representation-center",
  "behavior-center",
  "evolution-center",
];

const BEHAVIOR_KINDS = new Set(["parameter-type", "return-type", "constructs"]);

function share(part: number, total: number): number {
  return total === 0 ? 0 : part / total;
}

/** Largest by `value`; ties go to `prefer` when present, else lexically first. */
function leader<T extends { package: string }>(
  rows: T[],
  value: (row: T) => number,
  prefer?: string
): T | undefined {
  let best: T | undefined;
  for (const row of rows) {
    if (value(row) === 0) {
      continue;
    }
    if (best === undefined || value(row) > value(best)) {
      best = row;
    } else if (value(row) === value(best)) {
      if (row.package === prefer) {
        best = row;
      } else if (best.package !== prefer && row.package < best.package) {
        best = row;
      }
    }
  }
  return best;
}

/**
 * Centers, tensions, and alignment from per-package facts. Each role has
 * its own gate; nothing is combined into a score. Insufficient families
 * get candidates and evidence but no centers.
 */
export function assessOwnership(
  facts: OwnershipFacts,
  config: AnalysisConfig = ANALYSIS_CONFIG
): ConceptOwnershipAnalysis {
  const policy = config.conceptOwnership;
  const seed = facts.concept.package;
  const behaviorByPackage = new Map(
    facts.behavior.byPackage.map((row) => [row.package, row])
  );
  const representationKinds = new Map(
    facts.representationKinds.map((row) => [row.package, row.kinds])
  );
  const conversionsByPackage = new Map(
    facts.conversions.map((row) => [row.package, row.count])
  );
  const evolutionByPackage = new Map(
    (facts.evolution ?? []).map((row) => [row.package, row])
  );

  const names = new Set<string>([
    seed,
    ...facts.packages.map((row) => row.package),
    ...facts.behavior.byPackage.map((row) => row.package),
    ...facts.conversions.map((row) => row.package),
  ]);
  // Centers read only the configured file kinds (source by default), so a
  // test helper or story-only type never moves one; every kind stays in
  // the raw counts and participation.
  const sum = (
    counts: Partial<Record<ChurnFileKind, number>>,
    kinds: ChurnFileKind[]
  ) => kinds.reduce((total, kind) => total + (counts[kind] ?? 0), 0);
  const rows = [...names].map((name) => {
    const presence = facts.packages.find((row) => row.package === name);
    const behavior = behaviorByPackage.get(name);
    const contractByKind = Object.fromEntries(
      Object.entries(behavior?.kinds ?? {}).map(([kind, counts]) => [
        kind,
        counts.contract,
      ])
    ) as Partial<Record<ChurnFileKind, number>>;
    return {
      behaviors:
        behavior === undefined
          ? 0
          : behavior.contract + behavior.implementation,
      contract: behavior?.contract ?? 0,
      conversions: conversionsByPackage.get(name) ?? 0,
      evolution: evolutionByPackage.get(name),
      implementations: presence?.implementations ?? 0,
      package: name,
      references: presence?.references ?? 0,
      representations: presence?.representations ?? 0,
      seed: name === seed,
      sourceContract: sum(contractByKind, policy.behaviorCenter.fileKinds),
      sourceRepresentations: sum(
        representationKinds.get(name) ?? {},
        policy.representationCenter.fileKinds
      ),
    };
  });
  const sourceRepresentationTotal = rows.reduce(
    (total, row) => total + row.sourceRepresentations,
    0
  );
  const sourceContractTotal = rows.reduce(
    (total, row) => total + row.sourceContract,
    0
  );
  const participating = rows.filter(
    (row) =>
      row.seed ||
      row.implementations > 0 ||
      row.representations >= policy.candidates.minRepresentations ||
      row.behaviors >= policy.candidates.minBehaviors ||
      share(row.references, facts.referenceTotal) >=
        policy.candidates.minReferenceShare
  );

  const insufficient =
    facts.referenceTotal < policy.support.minReferences &&
    facts.behavior.total < policy.support.minBehaviors;

  const center: ConceptOwnershipCenter = { implementations: [] };
  const tensions: ConceptOwnershipTension[] = [];
  assessOwnershipEntries3(
    insufficient,
    center,
    seed,
    rows,
    sourceRepresentationTotal,
    policy,
    facts,
    sourceContractTotal,
    tensions
  );

  const divergent = tensions.some((tension) =>
    tension.kind.startsWith("seed-vs-")
  );
  let alignment: OwnershipAlignment;
  if (insufficient) {
    alignment = "insufficient-evidence";
  } else if (divergent) {
    alignment = "divergent";
  } else if (
    [
      center.representation,
      center.usage,
      center.behavior,
      center.evolution,
    ].every((name) => name === undefined || name === seed) &&
    center.implementations.every((name) => name === seed)
  ) {
    alignment = "aligned";
  } else {
    alignment = "distributed";
  }

  const candidates: ConceptOwnershipCandidate[] = participating.map((row) => {
    const evidence: OwnershipEvidence[] = [];
    const push = (
      dimension: OwnershipDimension,
      metric: string,
      value: number | string | boolean
    ) => evidence.push({ dimension, metric, package: row.package, value });
    if (row.seed) {
      push("declaration", "seed", true);
    }
    if (row.representations > 0) {
      push("representation", "count", row.representations);
      push(
        "representation",
        "share",
        share(row.representations, facts.representationTotal)
      );
      if (row.sourceRepresentations > 0) {
        push("representation", "sourceCount", row.sourceRepresentations);
        push(
          "representation",
          "sourceShare",
          share(row.sourceRepresentations, sourceRepresentationTotal)
        );
      }
    }
    if (row.implementations > 0) {
      push("implementation", "count", row.implementations);
    }
    if (row.references > 0) {
      push("reference", "count", row.references);
      push("reference", "share", share(row.references, facts.referenceTotal));
    }
    assessOwnershipEntries(row, push, facts, sourceContractTotal);
    if (row.conversions > 0) {
      push("conversion", "count", row.conversions);
    }
    assessOwnershipEntries2(row, push);
    if (row.seed && facts.architectureSignals.length > 0) {
      push("architecture", "profile", facts.architectureSignals.join(", "));
    }
    if (row.seed && facts.anchor !== undefined) {
      push("intent", "anchored", true);
    }
    const roles = ROLE_ORDER.filter((role) => {
      switch (role) {
        case "semantic-center":
          return center.semantic === row.package;
        case "implementation-center":
          return center.implementations.includes(row.package);
        case "usage-center":
          return center.usage === row.package;
        case "representation-center":
          return center.representation === row.package;
        case "behavior-center":
          return center.behavior === row.package;
        case "evolution-center":
          return center.evolution === row.package;
        default:
          throw new Error("Unexpected role.");
      }
    });
    return {
      dimensions: DIMENSION_ORDER.filter((dimension) =>
        evidence.some((item) => item.dimension === dimension)
      ),
      evidence,
      package: row.package,
      participation: {
        behaviors: row.behaviors,
        conversions: row.conversions,
        implementations: row.implementations,
        references: row.references,
        representations: row.representations,
      },
      roles,
    };
  });
  candidates.sort(
    (a, b) =>
      b.dimensions.length - a.dimensions.length ||
      b.participation.representations - a.participation.representations ||
      b.participation.references - a.participation.references ||
      b.participation.behaviors - a.participation.behaviors ||
      a.package.localeCompare(b.package)
  );

  const cautions: OwnershipCaution[] = [];
  if (facts.evolution === undefined) {
    cautions.push({ detail: "history unavailable", kind: "sparse-history" });
  } else if (
    !insufficient &&
    Math.max(0, ...facts.evolution.map((row) => row.support)) <
      policy.evolutionCenter.minHistoricalSupport
  ) {
    cautions.push({
      detail: `no package reaches historical support ${policy.evolutionCenter.minHistoricalSupport}`,
      kind: "sparse-history",
    });
  }
  if (facts.anchor !== undefined) {
    cautions.push({
      detail: facts.anchor.reason ?? "seed package is anchored",
      kind: "anchored-seed",
    });
  }
  if (
    !insufficient &&
    facts.contractLike &&
    center.implementations.length === 0
  ) {
    cautions.push({
      detail:
        "explicit `implements` only; structural (object-literal, factory) conformance is not analyzed, so implementations may exist unseen",
      kind: "no-implementation-evidence",
    });
  }

  return {
    alignment,
    behavior: facts.behavior,
    candidates,
    cautions,
    center,
    concept: facts.concept,
    representationKinds: facts.representationKinds,
    tensions,
    ...(facts.evolution !== undefined && { evolution: facts.evolution }),
    overlap: facts.overlap,
  };
}

type TopLevelIndex = Map<string, Node>;

function assessOwnershipEntries3(
  insufficient: boolean,
  center: ConceptOwnershipCenter,
  seed: string,
  rows: {
    behaviors: number;
    contract: number;
    conversions: number;
    evolution: ConceptEvolutionEvidence | undefined;
    implementations: number;
    package: string;
    references: number;
    representations: number;
    seed: boolean;
    sourceContract: number;
    sourceRepresentations: number;
  }[],
  sourceRepresentationTotal: number,
  policy: {
    candidates: {
      minReferenceShare: number;
      minRepresentations: number;
      minBehaviors: number;
    };
    support: { minReferences: number; minBehaviors: number };
    representationCenter: {
      minShare: number;
      minRepresentations: number;
      fileKinds: ChurnFileKind[];
    };
    usageCenter: { minShare: number; minReferences: number };
    behaviorCenter: {
      minShare: number;
      minBehaviors: number;
      fileKinds: ChurnFileKind[];
    };
    evolutionCenter: {
      minHistoricalSupport: number;
      couplingContexts: CouplingContext[];
    };
    tensions: {
      minShare: number;
      minRepresentations: number;
      minBehaviors: number;
      anchorMinConvergingDimensions: number;
    };
    report: { topConcepts: number };
  },
  facts: OwnershipFacts,
  sourceContractTotal: number,
  tensions: ConceptOwnershipTension[]
) {
  if (!insufficient) {
    center.semantic = seed;
    center.implementations = rows
      .filter((row) => row.implementations > 0)
      .map((row) => row.package)
      .sort();
    const representation = leader(
      rows,
      (row) => row.sourceRepresentations,
      seed
    );
    if (
      representation !== undefined &&
      sourceRepresentationTotal >=
        policy.representationCenter.minRepresentations &&
      share(representation.sourceRepresentations, sourceRepresentationTotal) >=
        policy.representationCenter.minShare
    ) {
      center.representation = representation.package;
    }
    const usage = leader(rows, (row) => row.references, seed);
    if (
      usage !== undefined &&
      facts.referenceTotal >= policy.usageCenter.minReferences &&
      share(usage.references, facts.referenceTotal) >=
        policy.usageCenter.minShare
    ) {
      center.usage = usage.package;
    }
    const behavior = leader(rows, (row) => row.sourceContract, seed);
    if (
      behavior !== undefined &&
      sourceContractTotal >= policy.behaviorCenter.minBehaviors &&
      share(behavior.sourceContract, sourceContractTotal) >=
        policy.behaviorCenter.minShare
    ) {
      center.behavior = behavior.package;
    }
    const evolution = leader(rows, (row) => row.evolution?.support ?? 0, seed);
    if (
      evolution?.evolution !== undefined &&
      evolution.evolution.support >= policy.evolutionCenter.minHistoricalSupport
    ) {
      center.evolution = evolution.package;
    }

    assessOwnershipEntries3Entries2(
      representation,
      center,
      seed,
      sourceRepresentationTotal,
      policy,
      tensions
    );
    assessOwnershipEntries3Entries3(
      behavior,
      center,
      seed,
      sourceContractTotal,
      policy,
      tensions
    );
    if (
      evolution?.evolution !== undefined &&
      center.evolution !== undefined &&
      center.evolution !== seed
    ) {
      tensions.push({
        kind: "seed-vs-evolution",
        observedPackage: evolution.package,
        seedPackage: seed,
        value: evolution.evolution.support,
      });
    }
    if (
      usage !== undefined &&
      center.usage !== undefined &&
      center.usage !== seed
    ) {
      tensions.push({
        kind: "usage-vs-semantic-center",
        observedPackage: usage.package,
        seedPackage: seed,
        value: share(usage.references, facts.referenceTotal),
      });
    }
    // The anchor is intent; questioning it takes several dimensions
    // converging on one other package, not one tension.
    assessOwnershipEntries3Entries(facts, tensions, policy, seed);
  }
}

function assessOwnershipEntries3Entries3(
  behavior:
    | {
        behaviors: number;
        contract: number;
        conversions: number;
        evolution: ConceptEvolutionEvidence | undefined;
        implementations: number;
        package: string;
        references: number;
        representations: number;
        seed: boolean;
        sourceContract: number;
        sourceRepresentations: number;
      }
    | undefined,
  center: ConceptOwnershipCenter,
  seed: string,
  sourceContractTotal: number,
  policy: {
    candidates: {
      minReferenceShare: number;
      minRepresentations: number;
      minBehaviors: number;
    };
    support: { minReferences: number; minBehaviors: number };
    representationCenter: {
      minShare: number;
      minRepresentations: number;
      fileKinds: ChurnFileKind[];
    };
    usageCenter: { minShare: number; minReferences: number };
    behaviorCenter: {
      minShare: number;
      minBehaviors: number;
      fileKinds: ChurnFileKind[];
    };
    evolutionCenter: {
      minHistoricalSupport: number;
      couplingContexts: CouplingContext[];
    };
    tensions: {
      minShare: number;
      minRepresentations: number;
      minBehaviors: number;
      anchorMinConvergingDimensions: number;
    };
    report: { topConcepts: number };
  },
  tensions: ConceptOwnershipTension[]
) {
  if (
    behavior !== undefined &&
    center.behavior !== undefined &&
    center.behavior !== seed &&
    sourceContractTotal >= policy.tensions.minBehaviors &&
    share(behavior.sourceContract, sourceContractTotal) >=
      policy.tensions.minShare
  ) {
    tensions.push({
      kind: "seed-vs-behavior",
      observedPackage: behavior.package,
      seedPackage: seed,
      value: share(behavior.sourceContract, sourceContractTotal),
    });
  }
}

function assessOwnershipEntries3Entries2(
  representation:
    | {
        behaviors: number;
        contract: number;
        conversions: number;
        evolution: ConceptEvolutionEvidence | undefined;
        implementations: number;
        package: string;
        references: number;
        representations: number;
        seed: boolean;
        sourceContract: number;
        sourceRepresentations: number;
      }
    | undefined,
  center: ConceptOwnershipCenter,
  seed: string,
  sourceRepresentationTotal: number,
  policy: {
    candidates: {
      minReferenceShare: number;
      minRepresentations: number;
      minBehaviors: number;
    };
    support: { minReferences: number; minBehaviors: number };
    representationCenter: {
      minShare: number;
      minRepresentations: number;
      fileKinds: ChurnFileKind[];
    };
    usageCenter: { minShare: number; minReferences: number };
    behaviorCenter: {
      minShare: number;
      minBehaviors: number;
      fileKinds: ChurnFileKind[];
    };
    evolutionCenter: {
      minHistoricalSupport: number;
      couplingContexts: CouplingContext[];
    };
    tensions: {
      minShare: number;
      minRepresentations: number;
      minBehaviors: number;
      anchorMinConvergingDimensions: number;
    };
    report: { topConcepts: number };
  },
  tensions: ConceptOwnershipTension[]
) {
  if (
    representation !== undefined &&
    center.representation !== undefined &&
    center.representation !== seed &&
    sourceRepresentationTotal >= policy.tensions.minRepresentations &&
    share(representation.sourceRepresentations, sourceRepresentationTotal) >=
      policy.tensions.minShare
  ) {
    tensions.push({
      kind: "seed-vs-representation",
      observedPackage: representation.package,
      seedPackage: seed,
      value: share(
        representation.sourceRepresentations,
        sourceRepresentationTotal
      ),
    });
  }
}

function assessOwnershipEntries3Entries(
  facts: OwnershipFacts,
  tensions: ConceptOwnershipTension[],
  policy: {
    candidates: {
      minReferenceShare: number;
      minRepresentations: number;
      minBehaviors: number;
    };
    support: { minReferences: number; minBehaviors: number };
    representationCenter: {
      minShare: number;
      minRepresentations: number;
      fileKinds: ChurnFileKind[];
    };
    usageCenter: { minShare: number; minReferences: number };
    behaviorCenter: {
      minShare: number;
      minBehaviors: number;
      fileKinds: ChurnFileKind[];
    };
    evolutionCenter: {
      minHistoricalSupport: number;
      couplingContexts: CouplingContext[];
    };
    tensions: {
      minShare: number;
      minRepresentations: number;
      minBehaviors: number;
      anchorMinConvergingDimensions: number;
    };
    report: { topConcepts: number };
  },
  seed: string
) {
  if (facts.anchor !== undefined) {
    const converging = new Map<string, ConceptOwnershipTension[]>();
    const visitTension = (
      currentConverging: Map<string, ConceptOwnershipTension[]>
    ) => {
      for (const tension of tensions) {
        if (!tension.kind.startsWith("seed-vs-")) {
          continue;
        }
        const list = currentConverging.get(tension.observedPackage);
        if (list === undefined) {
          currentConverging.set(tension.observedPackage, [tension]);
        } else {
          list.push(tension);
        }
      }
    };
    visitTension(converging);
    const [observed] = [...converging.entries()]
      .filter(
        ([, list]) =>
          list.length >= policy.tensions.anchorMinConvergingDimensions
      )
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    if (observed !== undefined) {
      tensions.push({
        kind: "anchor-vs-observed-center",
        observedPackage: observed[0],
        seedPackage: seed,
        value: observed[1].length,
      });
    }
  }
}

function assessOwnershipEntries2(
  row: {
    behaviors: number;
    contract: number;
    conversions: number;
    evolution: ConceptEvolutionEvidence | undefined;
    implementations: number;
    package: string;
    references: number;
    representations: number;
    seed: boolean;
    sourceContract: number;
    sourceRepresentations: number;
  },
  push: (
    dimension: OwnershipDimension,
    metric: string,
    value: number | string | boolean
  ) => number
) {
  if (row.evolution !== undefined && row.evolution.support > 0) {
    push("evolution", "support", row.evolution.support);
    push("evolution", "commits", row.evolution.commits);
    if (row.evolution.hotspotRepresentations > 0) {
      push(
        "evolution",
        "hotspotRepresentations",
        row.evolution.hotspotRepresentations
      );
    }
    const [strongest] = row.evolution.couplings;
    if (strongest !== undefined) {
      push("evolution", "strongestCoupling", strongest.coChangeCommits);
      push("evolution", "strongestConditional", strongest.conditional);
      push("evolution", "strongestJaccard", strongest.jaccard);
      push("evolution", "strongestContext", strongest.context);
    }
  }
}

function assessOwnershipEntries(
  row: {
    behaviors: number;
    contract: number;
    conversions: number;
    evolution: ConceptEvolutionEvidence | undefined;
    implementations: number;
    package: string;
    references: number;
    representations: number;
    seed: boolean;
    sourceContract: number;
    sourceRepresentations: number;
  },
  push: (
    dimension: OwnershipDimension,
    metric: string,
    value: number | string | boolean
  ) => number,
  facts: OwnershipFacts,
  sourceContractTotal: number
) {
  if (row.behaviors > 0) {
    push("behavior", "count", row.behaviors);
    push("behavior", "share", share(row.behaviors, facts.behavior.total));
    push("behavior", "contract", row.contract);
    if (row.contract > 0) {
      push(
        "behavior",
        "contractShare",
        share(row.contract, facts.behavior.contractTotal)
      );
    }
    if (row.sourceContract > 0) {
      push("behavior", "sourceContract", row.sourceContract);
      push(
        "behavior",
        "sourceContractShare",
        share(row.sourceContract, sourceContractTotal)
      );
    }
  }
}

function isContractLike(node: Node | undefined): boolean {
  return (
    node !== undefined &&
    Node.isInterfaceDeclaration(node) &&
    node
      .getMembers()
      .some(
        (member) =>
          Node.isMethodSignature(member) ||
          (Node.isPropertySignature(member) &&
            Node.isFunctionTypeNode(member.getTypeNode()))
      )
  );
}

function isBodiedMember(node: Node): boolean {
  return (
    (Node.isMethodDeclaration(node) ||
      Node.isConstructorDeclaration(node) ||
      Node.isGetAccessorDeclaration(node) ||
      Node.isSetAccessorDeclaration(node)) &&
    node.getBody() !== undefined
  );
}

function isFunctionLike(node: Node): boolean {
  if (Node.isFunctionDeclaration(node)) {
    return true;
  }
  if (!Node.isVariableDeclaration(node)) {
    return false;
  }
  const initializer = node.getInitializer();
  return (
    initializer !== undefined &&
    (Node.isArrowFunction(initializer) ||
      Node.isFunctionExpression(initializer))
  );
}

interface BehaviorTally {
  constructors: number;
  contract: number;
  functions: number;
  implementation: number;
  kinds: Partial<
    Record<ChurnFileKind, { contract: number; implementation: number }>
  >;
  methods: number;
}

/**
 * Executable symbols explicitly attached to the family, by package. Only
 * files holding representations are opened, through a memoized top-level
 * index on the existing project; no new project and no reference search.
 */
function behaviorOf(
  family: ConceptFamily,
  indexFor: (relFile: string) => TopLevelIndex
): ConceptBehaviorDistribution {
  const linesBySymbol = new Map<string, number[]>();
  for (const item of family.evidence) {
    if (item.source === undefined || !BEHAVIOR_KINDS.has(item.kind)) {
      continue;
    }
    const lines = linesBySymbol.get(item.source.symbolId);
    if (lines === undefined) {
      linesBySymbol.set(item.source.symbolId, [item.line]);
    } else {
      lines.push(item.line);
    }
  }
  const implementing = new Set(
    family.representations
      .filter(
        (item) =>
          item.relationship === "implementation" ||
          (item.relationship === "extension" && family.seed.kind === "class")
      )
      .map((item) => item.symbolId)
  );
  const tallies = new Map<string, BehaviorTally>();
  const participants: ConceptBehaviorParticipant[] = [];
  const tally = (pkg: string): BehaviorTally => {
    let entry = tallies.get(pkg);
    if (entry === undefined) {
      entry = {
        constructors: 0,
        contract: 0,
        functions: 0,
        implementation: 0,
        kinds: {},
        methods: 0,
      };
      tallies.set(pkg, entry);
    }
    return entry;
  };
  const count = (
    entry: BehaviorTally,
    kind: ChurnFileKind,
    role: "contract" | "implementation"
  ) => {
    entry[role] += 1;
    entry.kinds[kind] ??= { contract: 0, implementation: 0 };
    const byKind = entry.kinds[kind];
    byKind[role] += 1;
  };
  const countMember = (
    entry: BehaviorTally,
    representation: ConceptRepresentation,
    kind: ChurnFileKind,
    member: Node,
    role: "contract" | "implementation"
  ) => {
    const currentConstructor = Node.isConstructorDeclaration(member);
    if (currentConstructor) {
      entry.constructors += 1;
    } else {
      entry.methods += 1;
    }
    count(entry, kind, role);
    participants.push({
      file: representation.file,
      kind,
      lines: {
        end: member.getEndLineNumber(),
        start: member.getStartLineNumber(),
      },
      member: currentConstructor ? "constructor" : "method",
      package: representation.package,
      role,
      symbol: `${representation.name}.${resolveSymbol(currentConstructor, member)}`,
    });
  };

  const seen = new Set<string>();
  behaviorOfRepresentation(
    family,
    seen,
    indexFor,
    linesBySymbol,
    implementing,
    tally,
    countMember,
    count,
    participants
  );
  participants.sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.symbol.localeCompare(b.symbol) ||
      a.role.localeCompare(b.role)
  );

  const byPackage = [...tallies.entries()].map(([pkg, entry]) => ({
    package: pkg,
    ...entry,
    total: entry.contract + entry.implementation,
  }));
  const total = byPackage.reduce((sum, row) => sum + row.total, 0);
  return {
    byPackage: byPackage
      .map(({ total: own, ...row }) => ({ ...row, share: share(own, total) }))
      .sort(
        (a, b) =>
          b.contract + b.implementation - (a.contract + a.implementation) ||
          a.package.localeCompare(b.package)
      ),
    contractTotal: byPackage.reduce((sum, row) => sum + row.contract, 0),
    participants,
    total,
  };
}

interface TemporalIndex {
  aggregators: Set<string>;
  commitsByFile: Map<string, number>;
  hotspots: Map<string, { commits: number; commitPercentile: number }>;
  pairsByFile: Map<string, FileChangeCouplingPair[]>;
  supportingContexts: Set<string>;
}

function resolveSymbol(currentConstructor: boolean, member: Node): string {
  if (currentConstructor) {
    return "constructor";
  }
  if (Node.hasName(member)) {
    return member.getName();
  }
  return "member";
}

function behaviorOfRepresentation(
  family: ConceptFamily,
  seen: Set<string>,
  indexFor: (relFile: string) => TopLevelIndex,
  linesBySymbol: Map<string, number[]>,
  implementing: Set<string>,
  tally: (pkg: string) => BehaviorTally,
  countMember: (
    entry: BehaviorTally,
    representation: ConceptRepresentation,
    kind: ChurnFileKind,
    member: Node,
    role: "contract" | "implementation"
  ) => void,
  count: (
    entry: BehaviorTally,
    kind: ChurnFileKind,
    role: "contract" | "implementation"
  ) => void,
  participants: ConceptBehaviorParticipant[]
) {
  const visitRepresentation = (representation: ConceptRepresentation) =>
    resolveVisitRepresentation(
      seen,
      indexFor,
      linesBySymbol,
      implementing,
      tally,
      countMember,
      count,
      participants,
      representation
    );
  for (const representation of family.representations) {
    visitRepresentation(representation);
  }
}

function behaviorOfRepresentationLine(
  lines: number[],
  members: ClassMemberTypes[],
  matched: Set<Node>
) {
  for (const line of lines) {
    const member = members.find(
      (candidate) =>
        candidate.getStartLineNumber() <= line &&
        line <= candidate.getEndLineNumber()
    );
    if (member !== undefined) {
      matched.add(member);
    }
  }
}
function resolveVisitRepresentation(
  seen: Set<string>,
  indexFor: (relFile: string) => TopLevelIndex,
  linesBySymbol: Map<string, number[]>,
  implementing: Set<string>,
  tally: (pkg: string) => BehaviorTally,
  countMember: (
    entry: BehaviorTally,
    representation: ConceptRepresentation,
    kind: ChurnFileKind,
    member: Node,
    role: "contract" | "implementation"
  ) => void,
  count: (
    entry: BehaviorTally,
    kind: ChurnFileKind,
    role: "contract" | "implementation"
  ) => void,
  participants: ConceptBehaviorParticipant[],
  representation: ConceptRepresentation
) {
  if (seen.has(representation.symbolId)) {
    return;
  }
  seen.add(representation.symbolId);
  const node = indexFor(representation.file).get(representation.name);
  if (node === undefined) {
    return;
  }
  const kind = classifyFile(representation.file);
  const lines = linesBySymbol.get(representation.symbolId) ?? [];
  if (Node.isClassDeclaration(node)) {
    const members = node.getMembers().filter(isBodiedMember);
    if (implementing.has(representation.symbolId)) {
      const entry = tally(representation.package);
      for (const member of members) {
        countMember(entry, representation, kind, member, "implementation");
      }
      return;
    }
    const matched = new Set<Node>();
    behaviorOfRepresentationLine(lines, members, matched);
    if (matched.size === 0) {
      return;
    }
    const entry = tally(representation.package);
    for (const member of matched) {
      countMember(entry, representation, kind, member, "contract");
    }
    return;
  }
  if (lines.length > 0 && isFunctionLike(node)) {
    const entry = tally(representation.package);
    entry.functions += 1;
    count(entry, kind, "contract");
    participants.push({
      file: representation.file,
      kind,
      lines: {
        end: node.getEndLineNumber(),
        start: node.getStartLineNumber(),
      },
      member: "function",
      package: representation.package,
      role: "contract",
      symbol: representation.name,
    });
  }
}

function evolutionOf(
  family: ConceptFamily,
  index: TemporalIndex
): ConceptEvolutionEvidence[] {
  const members = [
    {
      file: family.seed.declaration.file,
      name: family.seed.name,
      package: family.seed.declaration.package,
    },
    ...family.representations,
  ];
  const packageByFile = new Map<string, string>();
  const namesByFile = new Map<string, Set<string>>();
  for (const member of members) {
    packageByFile.set(member.file, member.package);
    const names = namesByFile.get(member.file);
    if (names === undefined) {
      namesByFile.set(member.file, new Set([member.name]));
    } else {
      names.add(member.name);
    }
  }
  const rows = new Map<string, ConceptEvolutionEvidence>();
  const row = (pkg: string): ConceptEvolutionEvidence => {
    let entry = rows.get(pkg);
    if (entry === undefined) {
      entry = {
        changedRepresentationFiles: 0,
        commits: 0,
        couplings: [],
        hotspotRepresentations: 0,
        hotspots: [],
        package: pkg,
        strongCouplingPairs: 0,
        support: 0,
        supportingCouplingPairs: 0,
      };
      rows.set(pkg, entry);
    }
    return entry;
  };
  const commitsByFile = new Map<string, number>();
  const seenPairs = new Set<FileChangeCouplingPair>();
  evolutionOfEntries(
    packageByFile,
    row,
    index,
    commitsByFile,
    namesByFile,
    seenPairs
  );
  for (const [file, commits] of commitsByFile) {
    const pkg = packageByFile.get(file);
    if (pkg !== undefined) {
      row(pkg).commits += commits;
    }
  }
  return [...rows.values()]
    .map((entry) => ({
      ...entry,
      couplings: [...entry.couplings].sort(
        (a, b) =>
          b.coChangeCommits - a.coChangeCommits ||
          b.conditional - a.conditional ||
          a.file.localeCompare(b.file) ||
          a.partnerFile.localeCompare(b.partnerFile)
      ),
      hotspots: [...entry.hotspots].sort((a, b) =>
        a.file.localeCompare(b.file)
      ),
      support:
        entry.changedRepresentationFiles +
        entry.hotspotRepresentations +
        entry.supportingCouplingPairs,
    }))
    .sort(
      (a, b) => b.support - a.support || a.package.localeCompare(b.package)
    );
}

function evolutionOfEntries(
  packageByFile: Map<string, string>,
  row: (pkg: string) => ConceptEvolutionEvidence,
  index: TemporalIndex,
  commitsByFile: Map<string, number>,
  namesByFile: Map<string, Set<string>>,
  seenPairs: Set<FileChangeCouplingPair>
) {
  for (const [file, pkg] of packageByFile) {
    const entry = row(pkg);
    const churn = index.commitsByFile.get(file);
    if (churn !== undefined) {
      entry.changedRepresentationFiles += 1;
      commitsByFile.set(file, churn);
    }
    const hotspot = index.hotspots.get(file);
    if (hotspot !== undefined) {
      entry.hotspotRepresentations += namesByFile.get(file)?.size ?? 0;
      entry.hotspots.push({ file, ...hotspot });
    }
    evolutionOfEntriesPair(
      index,
      file,
      seenPairs,
      packageByFile,
      commitsByFile,
      row
    );
  }
}

function evolutionOfEntriesPair(
  index: TemporalIndex,
  file: string,
  seenPairs: Set<FileChangeCouplingPair>,
  packageByFile: Map<string, string>,
  commitsByFile: Map<string, number>,
  row: (pkg: string) => ConceptEvolutionEvidence
) {
  for (const pair of index.pairsByFile.get(file) ?? []) {
    if (seenPairs.has(pair)) {
      continue;
    }
    if (!(packageByFile.has(pair.left) && packageByFile.has(pair.right))) {
      continue;
    }
    seenPairs.add(pair);
    for (const [side, commits] of [
      [pair.left, pair.leftCommits],
      [pair.right, pair.rightCommits],
    ] as const) {
      const known = commitsByFile.get(side);
      if (known === undefined || commits > known) {
        commitsByFile.set(side, commits);
      }
    }
    const supporting = index.supportingContexts.has(pair.context);
    const aggregatorMediated =
      index.aggregators.has(pair.left) || index.aggregators.has(pair.right);
    const sides = new Set([pair.left, pair.right]);
    evolutionOfEntriesPairSide(
      sides,
      packageByFile,
      pair,
      row,
      supporting,
      aggregatorMediated
    );
  }
}

function evolutionOfEntriesPairSide(
  sides: Set<string>,
  packageByFile: Map<string, string>,
  pair: FileChangeCouplingPair,
  row: (pkg: string) => ConceptEvolutionEvidence,
  supporting: boolean,
  aggregatorMediated: boolean
) {
  for (const side of sides) {
    const own = packageByFile.get(side);
    if (own === undefined) {
      continue;
    }
    const partner = side === pair.left ? pair.right : pair.left;
    const sideRow = row(own);
    // A same-package pair adds one to the package, whichever side is read.
    if (side === pair.right && own === packageByFile.get(pair.left)) {
      continue;
    }
    sideRow.strongCouplingPairs += 1;
    if (supporting) {
      sideRow.supportingCouplingPairs += 1;
    }
    const coupling: ConceptEvolutionCoupling = {
      aggregatorMediated,
      coChangeCommits: pair.coChangeCommits,
      conditional:
        side === pair.left ? pair.leftConditional : pair.rightConditional,
      context: pair.context,
      file: side,
      jaccard: pair.jaccard,
      partnerConditional:
        side === pair.left ? pair.rightConditional : pair.leftConditional,
      partnerFile: partner,
      partnerPackage: packageByFile.get(partner) ?? own,
      staticPath: pair.staticPath,
    };
    sideRow.couplings.push(coupling);
  }
}

/** Seed plus distinct representations by package and declaring-file kind; mirrors V7.1 members. */
function representationKindsOf(
  family: ConceptFamily
): ConceptRepresentationKinds[] {
  const rows = new Map<string, Partial<Record<ChurnFileKind, number>>>();
  const seen = new Set<string>([family.seed.id]);
  const add = (pkg: string, file: string) => {
    const kinds = rows.get(pkg) ?? {};
    const kind = classifyFile(file);
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    rows.set(pkg, kinds);
  };
  add(family.seed.declaration.package, family.seed.declaration.file);
  for (const representation of family.representations) {
    if (seen.has(representation.symbolId)) {
      continue;
    }
    seen.add(representation.symbolId);
    add(representation.package, representation.file);
  }
  return [...rows.entries()]
    .map(([pkg, kinds]) => ({ kinds, package: pkg }))
    .sort((a, b) => a.package.localeCompare(b.package));
}

/**
 * Where each family's centers sit. Composes V7.0–V7.2 and V6 output; the
 * only new work is behavior attribution over representation files.
 */
export function analyzeConceptOwnership(
  source: ConceptOwnershipSource,
  config: AnalysisConfig = ANALYSIS_CONFIG
): ConceptOwnershipReport {
  const { project, boundary } = source;
  const { root } = boundary;
  const indexes = new Map<string, TopLevelIndex>();
  const indexFor = (relFile: string): TopLevelIndex => {
    let index = indexes.get(relFile);
    if (index !== undefined) {
      return index;
    }
    index = new Map();
    const file = project.getSourceFile(join(root, relFile));
    for (const statement of file?.getStatements() ?? []) {
      if (Node.isVariableStatement(statement)) {
        for (const declaration of statement.getDeclarations()) {
          index.set(declaration.getName(), declaration);
        }
      } else if (Node.hasName(statement)) {
        index.set(statement.getName(), statement);
      }
    }
    indexes.set(relFile, index);
    return index;
  };

  let temporal: TemporalIndex | undefined;
  if (source.changeCoupling.available && source.hotspots.available) {
    const pairsByFile = new Map<string, FileChangeCouplingPair[]>();
    for (const pair of source.changeCoupling.filePairs) {
      for (const file of [pair.left, pair.right]) {
        const list = pairsByFile.get(file);
        if (list === undefined) {
          pairsByFile.set(file, [pair]);
        } else {
          list.push(pair);
        }
      }
    }
    temporal = {
      aggregators: new Set(
        source.dependencyGravity.modules
          .filter((module) => module.role?.kind === "aggregator")
          .map((module) => module.node.id)
      ),
      commitsByFile: new Map(
        source.churn.available
          ? source.churn.files.map((file) => [file.file, file.commits])
          : []
      ),
      hotspots: new Map(
        source.hotspots.files.map((file) => [
          file.file,
          {
            commitPercentile: file.evolution.commitPercentile,
            commits: file.evolution.commits,
          },
        ])
      ),
      pairsByFile,
      supportingContexts: new Set(
        config.conceptOwnership.evolutionCenter.couplingContexts
      ),
    };
  }

  const overlapBySeed = new Map<string, ConceptOwnershipOverlapContext[]>();
  const conversionsBySeed = new Map<string, Map<string, number>>();
  analyzeConceptOwnershipCandidate(
    source,
    root,
    conversionsBySeed,
    overlapBySeed
  );

  const architectureSignals = source.architecturalProfile.target.signals.map(
    (signal) => signal.signal
  );
  const targetName = boundary.packageName ?? boundary.relPath;

  const concepts = source.conceptInventory.families.map((family) => {
    const analysis = family.distributionAnalysis;
    if (analysis === undefined) {
      throw new Error(
        `concept distribution is not attached for ${family.seed.name}`
      );
    }
    const seedPackage = family.seed.declaration.package;
    const facts: OwnershipFacts = {
      behavior: behaviorOf(family, indexFor),
      concept: {
        file: family.seed.declaration.file,
        id: family.seed.id,
        inTarget: true,
        kind: family.seed.kind,
        name: family.seed.name,
        package: seedPackage,
      },
      contractLike: isContractLike(
        indexFor(family.seed.declaration.file).get(family.seed.name)
      ),
      conversions: [...(conversionsBySeed.get(family.seed.id) ?? [])]
        .map(([pkg, itemCount]) => ({ count: itemCount, package: pkg }))
        .sort(
          (a, b) => b.count - a.count || a.package.localeCompare(b.package)
        ),
      packages: analysis.packages,
      referenceTotal: analysis.references.total,
      representationKinds: representationKindsOf(family),
      representationTotal: analysis.representations.total,
      ...(temporal !== undefined && {
        evolution: evolutionOf(family, temporal),
      }),
      architectureSignals:
        seedPackage === targetName ? architectureSignals : [],
      ...(source.anchor?.target === seedPackage && {
        anchor: {
          ...(source.anchor.reason !== undefined && {
            reason: source.anchor.reason,
          }),
        },
      }),
      overlap: (overlapBySeed.get(family.seed.id) ?? []).sort((a, b) =>
        a.other.id.localeCompare(b.other.id)
      ),
    };
    return assessOwnership(facts, config);
  });

  const count = (alignment: OwnershipAlignment) =>
    concepts.filter((concept) => concept.alignment === alignment).length;
  return {
    concepts,
    summary: {
      aligned: count("aligned"),
      analyzed: concepts.length,
      distributed: count("distributed"),
      divergent: count("divergent"),
      insufficientEvidence: count("insufficient-evidence"),
      tensions: concepts.reduce(
        (sum, concept) => sum + concept.tensions.length,
        0
      ),
    },
    target: targetName,
  };
}

function analyzeConceptOwnershipCandidate(
  source: ConceptOwnershipSource,
  root: string,
  conversionsBySeed: Map<string, Map<string, number>>,
  overlapBySeed: Map<string, ConceptOwnershipOverlapContext[]>
) {
  for (const candidate of source.conceptOverlap.candidates) {
    for (const [mine, other] of [
      [candidate.left, candidate.right],
      [candidate.right, candidate.left],
    ] as const) {
      if (!mine.inTarget) {
        continue;
      }
      const packages = new Set<string>();
      for (const conversion of candidate.conversions) {
        const pkg = ownerBoundary(root, join(root, conversion.file));
        packages.add(pkg);
        let counts = conversionsBySeed.get(mine.id);
        if (counts === undefined) {
          counts = new Map();
          conversionsBySeed.set(mine.id, counts);
        }
        counts.set(pkg, (counts.get(pkg) ?? 0) + 1);
      }
      const context: ConceptOwnershipOverlapContext = {
        conversionPackages: [...packages].sort(),
        other,
        representationBoundary:
          other.package !== mine.package && packages.has(other.package),
      };
      const list = overlapBySeed.get(mine.id);
      if (list === undefined) {
        overlapBySeed.set(mine.id, [context]);
      } else {
        list.push(context);
      }
    }
  }
}
