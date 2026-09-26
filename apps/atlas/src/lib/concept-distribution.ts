import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import type {
  BoundaryDistribution,
  ConceptDistributionAnalysis,
  ConceptDistributionReport,
  ConceptDistributionShape,
  ConceptFamily,
  ConceptInventoryReport,
  ConceptPackagePresence,
  ConceptRelationshipKind,
  ConceptRepresentationKind,
  FileChangeCouplingPair,
  ReferenceDistribution,
  RelationshipDistribution,
  RepresentationDistribution,
  SurfaceReport,
  TemporalConceptContext,
  TemporalMemberCoupling,
} from "./types";

export type ConceptDistributionSource = Pick<
  SurfaceReport,
  "churn" | "hotspots" | "changeCoupling"
>;

const RELATIONSHIP_ORDER: ConceptRelationshipKind[] = [
  "implements",
  "extends",
  "alias",
  "type-reference",
  "parameter-type",
  "return-type",
  "property-type",
  "constructs",
];

const REPRESENTATION_KIND_ORDER: ConceptRepresentationKind[] = [
  "seed",
  "implementation",
  "extension",
  "alias",
  "factory",
  "type-user",
  "other",
];

interface Member {
  file: string;
  kinds: Set<ConceptRepresentationKind>;
  name: string;
  package: string;
}

function tally<K>(map: Map<K, number>, key: K, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function share(part: number, total: number): number {
  return total === 0 ? 0 : part / total;
}

/** Distinct symbols attached to the family, seed first, keyed by symbol id. */
function members(family: ConceptFamily): Map<string, Member> {
  const result = new Map<string, Member>();
  result.set(family.seed.id, {
    file: family.seed.declaration.file,
    kinds: new Set(["seed"]),
    name: family.seed.name,
    package: family.seed.declaration.package,
  });
  for (const representation of family.representations) {
    const existing = result.get(representation.symbolId);
    if (existing !== undefined) {
      existing.kinds.add(representation.relationship);
      continue;
    }
    result.set(representation.symbolId, {
      file: representation.file,
      kinds: new Set([representation.relationship]),
      name: representation.name,
      package: representation.package,
    });
  }
  return result;
}

function distributeRepresentations(
  family: ConceptFamily,
  byId: Map<string, Member>
): RepresentationDistribution {
  const perPackage = new Map<
    string,
    { representations: number; kinds: Set<ConceptRepresentationKind> }
  >();
  const modules = new Set<string>();
  const implementationPackages = new Set<string>();
  const implementationModules = new Set<string>();
  for (const member of byId.values()) {
    modules.add(member.file);
    let entry = perPackage.get(member.package);
    if (entry === undefined) {
      entry = { kinds: new Set(), representations: 0 };
      perPackage.set(member.package, entry);
    }
    entry.representations += 1;
    for (const kind of member.kinds) {
      entry.kinds.add(kind);
    }
    if (member.kinds.has("implementation")) {
      implementationPackages.add(member.package);
      implementationModules.add(member.file);
    }
  }
  const packages = [...perPackage.entries()]
    .map(([name, entry]) => ({
      kinds: REPRESENTATION_KIND_ORDER.filter((kind) => entry.kinds.has(kind)),
      package: name,
      representations: entry.representations,
    }))
    .sort(
      (a, b) =>
        b.representations - a.representations ||
        a.package.localeCompare(b.package)
    );
  const total = byId.size;
  const primary = packages[0];
  return {
    moduleCount: modules.size,
    packageCount: packages.length,
    packages,
    total,
    ...(primary !== undefined && { primaryPackage: primary.package }),
    implementationModules: implementationModules.size,
    implementationPackages: implementationPackages.size,
    primaryShare:
      primary === undefined ? null : share(primary.representations, total),
  };
}

function distributeReferences(family: ConceptFamily): ReferenceDistribution {
  const perPackage = new Map<
    string,
    { references: number; modules: Set<string> }
  >();
  const perModule = new Map<string, { package: string; references: number }>();
  let total = 0;
  for (const item of family.evidence) {
    if (item.kind === "declaration") {
      continue;
    }
    total += 1;
    let entry = perPackage.get(item.package);
    if (entry === undefined) {
      entry = { modules: new Set(), references: 0 };
      perPackage.set(item.package, entry);
    }
    entry.references += 1;
    entry.modules.add(item.file);
    const module = perModule.get(item.file);
    if (module === undefined) {
      perModule.set(item.file, { package: item.package, references: 1 });
    } else {
      module.references += 1;
    }
  }
  const byPackage = [...perPackage.entries()]
    .map(([name, entry]) => ({
      modules: entry.modules.size,
      package: name,
      references: entry.references,
      share: share(entry.references, total),
    }))
    .sort(
      (a, b) =>
        b.references - a.references || a.package.localeCompare(b.package)
    );
  const byModule = [...perModule.entries()]
    .map(([name, entry]) => ({
      module: name,
      package: entry.package,
      references: entry.references,
      share: share(entry.references, total),
    }))
    .sort(
      (a, b) => b.references - a.references || a.module.localeCompare(b.module)
    );
  const primary = byPackage[0];
  return {
    byModule,
    byPackage,
    packageCount: byPackage.length,
    total,
    ...(primary !== undefined && { primaryPackage: primary.package }),
    primaryShare: primary === undefined ? null : primary.share,
  };
}

function distributeRelationships(
  family: ConceptFamily
): RelationshipDistribution {
  const byKind = new Map<ConceptRelationshipKind, Map<string, number>>();
  for (const item of family.evidence) {
    if (item.kind === "declaration") {
      continue;
    }
    let packages = byKind.get(item.kind);
    if (packages === undefined) {
      packages = new Map();
      byKind.set(item.kind, packages);
    }
    tally(packages, item.package);
  }
  return {
    byKind: RELATIONSHIP_ORDER.flatMap((relationship) => {
      const packages = byKind.get(relationship);
      if (packages === undefined) {
        return [];
      }
      const entries = [...packages.entries()]
        .map(([name, count]) => ({ count, package: name }))
        .sort(
          (a, b) => b.count - a.count || a.package.localeCompare(b.package)
        );
      return [
        {
          packages: entries,
          relationship,
          total: entries.reduce((sum, entry) => sum + entry.count, 0),
        },
      ];
    }),
  };
}

function presence(
  family: ConceptFamily,
  byId: Map<string, Member>,
  references: ReferenceDistribution
): ConceptPackagePresence[] {
  const rows = new Map<string, ConceptPackagePresence>();
  const row = (name: string): ConceptPackagePresence => {
    let entry = rows.get(name);
    if (entry === undefined) {
      entry = {
        implementations: 0,
        package: name,
        references: 0,
        relationshipKinds: [],
        representations: 0,
        seed: name === family.seed.declaration.package,
      };
      rows.set(name, entry);
    }
    return entry;
  };
  for (const member of byId.values()) {
    const entry = row(member.package);
    entry.representations += 1;
    if (member.kinds.has("implementation")) {
      entry.implementations += 1;
    }
  }
  const kinds = new Map<string, Set<ConceptRelationshipKind>>();
  for (const item of family.evidence) {
    if (item.kind === "declaration") {
      continue;
    }
    let set = kinds.get(item.package);
    if (set === undefined) {
      set = new Set();
      kinds.set(item.package, set);
    }
    set.add(item.kind);
  }
  for (const entry of references.byPackage) {
    row(entry.package).references = entry.references;
  }
  for (const [name, set] of kinds) {
    row(name).relationshipKinds = RELATIONSHIP_ORDER.filter((kind) =>
      set.has(kind)
    );
  }
  return [...rows.values()].sort(
    (a, b) =>
      b.references - a.references ||
      b.representations - a.representations ||
      a.package.localeCompare(b.package)
  );
}

function shapesOf(
  family: ConceptFamily,
  representations: RepresentationDistribution,
  references: ReferenceDistribution,
  config: AnalysisConfig
): ConceptDistributionShape[] {
  const policy = config.conceptDistribution;
  const shapes: ConceptDistributionShape[] = [
    family.distribution.packageCount > 1 ? "cross-package" : "local",
  ];
  if (representations.implementationPackages >= 2) {
    shapes.push("implementation-split");
  }
  if (
    references.packageCount >= policy.referenceDistributed.minPackages &&
    references.primaryShare !== null &&
    references.primaryShare <=
      policy.referenceDistributed.maxPrimaryReferenceShare
  ) {
    shapes.push("reference-distributed");
  }
  if (
    references.packageCount >= 2 &&
    representations.total >=
      policy.representationConcentrated.minRepresentations &&
    representations.primaryShare !== null &&
    representations.primaryShare >=
      policy.representationConcentrated.minPrimaryShare
  ) {
    shapes.push("representation-concentrated");
  }
  return shapes;
}

interface TemporalIndex {
  churnFiles: Set<string>;
  hotspotFiles: Set<string>;
  pairsByFile: Map<string, FileChangeCouplingPair[]>;
}

function indexTemporal(
  source: ConceptDistributionSource
): TemporalIndex | undefined {
  if (!(source.changeCoupling.available && source.hotspots.available)) {
    return undefined;
  }
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
  return {
    churnFiles: new Set(
      source.churn.available ? source.churn.files.map((file) => file.file) : []
    ),
    hotspotFiles: new Set(source.hotspots.files.map((file) => file.file)),
    pairsByFile,
  };
}

function temporalContext(
  byId: Map<string, Member>,
  index: TemporalIndex
): TemporalConceptContext {
  const namesByFile = new Map<string, string[]>();
  for (const member of byId.values()) {
    const names = namesByFile.get(member.file);
    if (names === undefined) {
      namesByFile.set(member.file, [member.name]);
    } else {
      names.push(member.name);
    }
  }
  const seen = new Set<FileChangeCouplingPair>();
  const couplings: TemporalMemberCoupling[] = [];
  for (const file of namesByFile.keys()) {
    for (const pair of index.pairsByFile.get(file) ?? []) {
      if (seen.has(pair)) {
        continue;
      }
      seen.add(pair);
      const left = namesByFile.get(pair.left);
      const right = namesByFile.get(pair.right);
      if (left === undefined || right === undefined) {
        continue;
      }
      couplings.push({
        coChangeCommits: pair.coChangeCommits,
        context: pair.context,
        jaccard: pair.jaccard,
        left: { file: pair.left, representations: left },
        leftConditional: pair.leftConditional,
        right: { file: pair.right, representations: right },
        rightConditional: pair.rightConditional,
        staticPath: pair.staticPath,
      });
    }
  }
  couplings.sort(
    (a, b) =>
      b.coChangeCommits - a.coChangeCommits ||
      a.left.file.localeCompare(b.left.file) ||
      a.right.file.localeCompare(b.right.file)
  );
  return {
    hotspotRepresentations: [...byId.values()]
      .filter((member) => index.hotspotFiles.has(member.file))
      .map((member) => member.name),
    representedFilesWithChurn: [...namesByFile.keys()].filter((file) =>
      index.churnFiles.has(file)
    ).length,
    strongMemberCouplings: couplings,
  };
}

function analyzeFamily(
  family: ConceptFamily,
  index: TemporalIndex | undefined,
  config: AnalysisConfig
): ConceptDistributionAnalysis {
  const byId = members(family);
  const representations = distributeRepresentations(family, byId);
  const references = distributeReferences(family);
  const boundaries: BoundaryDistribution = {
    moduleCount: family.distribution.moduleCount,
    packageSpan: family.distribution.packageCount - 1,
    referencePackages: references.byPackage
      .map((entry) => entry.package)
      .sort(),
    representationPackages: representations.packages
      .map((entry) => entry.package)
      .sort(),
    seedPackage: family.seed.declaration.package,
  };
  return {
    boundaries,
    packages: presence(family, byId, references),
    references,
    relationships: distributeRelationships(family),
    representations,
    seed: {
      id: family.seed.id,
      kind: family.seed.kind,
      name: family.seed.name,
      package: family.seed.declaration.package,
    },
    shapes: shapesOf(family, representations, references, config),
    ...(index !== undefined && { temporal: temporalContext(byId, index) }),
  };
}

/**
 * Distribute every V7.0 family across packages, modules, representations,
 * and references, and annotate members with V6 history. Pure aggregation
 * over family evidence: no TypeScript rescan, no Git reparse, and history
 * never adds a member.
 */
export function analyzeConceptDistribution(
  inventory: ConceptInventoryReport,
  source: ConceptDistributionSource,
  config: AnalysisConfig = ANALYSIS_CONFIG
): ConceptDistributionReport {
  const index = indexTemporal(source);
  const families = inventory.families.map((family) =>
    analyzeFamily(family, index, config)
  );
  const withShape = (shape: ConceptDistributionShape) =>
    families.filter((family) => family.shapes.includes(shape)).length;
  return {
    families,
    summary: {
      crossPackage: withShape("cross-package"),
      families: families.length,
      implementationSplit: withShape("implementation-split"),
      local: withShape("local"),
      referenceDistributed: withShape("reference-distributed"),
      representationConcentrated: withShape("representation-concentrated"),
      temporallyCoupled: families.filter(
        (family) => (family.temporal?.strongMemberCouplings.length ?? 0) > 0
      ).length,
    },
    target: inventory.target,
  };
}

/** Attach each analysis to its family and the shape summary to the inventory. */
export function attachConceptDistribution(
  inventory: ConceptInventoryReport,
  report: ConceptDistributionReport
): void {
  const byId = new Map(report.families.map((item) => [item.seed.id, item]));
  for (const family of inventory.families) {
    const analysis = byId.get(family.seed.id);
    if (analysis !== undefined) {
      family.distributionAnalysis = analysis;
    }
  }
  inventory.distribution = report.summary;
}
