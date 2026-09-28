import { createHash } from "node:crypto";

import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import { buildAdjacency, condense } from "./gravity";
import type {
  InternalResponsibilityReport,
  InternalResponsibilitySummary,
  ResponsibilityAffinity,
  ResponsibilityAmbiguity,
  ResponsibilityAmbiguityReason,
  ResponsibilityCandidate,
  ResponsibilityConceptEntry,
  ResponsibilityEvidenceKind,
  ResponsibilityJoin,
  ResponsibilityJoinReason,
  ResponsibilityLabelBasis,
  ResponsibilityModuleEvidence,
  ResponsibilityPathAgreement,
  ResponsibilityPathSeamComparison,
  ResponsibilityRegion,
  ResponsibilityRelationship,
  ResponsibilitySymbolContext,
  ResponsibilitySymbolLocality,
  ResponsibilityUnit,
} from "./internal-responsibility-types";
import { INTERNAL_RESPONSIBILITY_SCHEMA_VERSION } from "./internal-responsibility-types";
import type {
  InternalModuleEdge,
  InternalModuleNode,
  InternalModuleRole,
  InternalPackageTopology,
} from "./internal-topology-types";
import type {
  PackageLocalConceptSeed,
  PackageLocalReport,
} from "./package-local-types";
import type {
  SymbolLocalityFinding,
  SymbolLocalityReport,
} from "./symbol-locality-types";
import type { ConceptRelationshipKind } from "./types";

// V13.2 internal responsibility regions. A pure function of one package's
// local report, internal topology, and symbol locality: no file system, no
// program, no workspace, no Git. Cycles are atomic units; two units join
// only when an explicit rule fires on a direct edge between their
// non-connector modules; aggregators and high-fan modules are placed last,
// from the regions their edges reach, or left unresolved. Nothing here
// names a better place for anything.

const CONNECTOR_ROLES: InternalModuleRole[] = [
  "aggregator",
  "high-fan-in",
  "high-fan-out",
];
const JOIN_REASONS: ResponsibilityJoinReason[] = [
  "concept-flow",
  "directory-dependency",
  "directory-fallback",
];
const AMBIGUITY_REASONS: ResponsibilityAmbiguityReason[] = [
  "aggregator",
  "distributed-primitive",
  "wide-dependent",
  "bridge",
];
const PATH_AGREEMENTS: ResponsibilityPathAgreement[] = [
  "matches-path-region",
  "within-path-region",
  "spans-path-regions",
];
const LABEL_BASES: ResponsibilityLabelBasis[] = [
  "directory",
  "concept",
  "module",
];
const SYMBOL_LOCALITIES: ResponsibilitySymbolLocality[] = [
  "responsibility-local",
  "responsibility-crossing",
  "unplaced",
];

function share(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

function zeroRecord<K extends string>(keys: K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\n${b}` : `${b}\n${a}`;
}

function regionId(modules: string[]): string {
  const hash = createHash("sha256").update(modules.join("\n")).digest("hex");
  return `responsibility:${hash.slice(0, 12)}`;
}

/** Union-find over unit ids with deterministic representatives. */
class Groups {
  private readonly parent = new Map<string, string>();

  constructor(ids: Iterable<string>) {
    for (const id of ids) {
      this.parent.set(id, id);
    }
  }

  find(id: string): string {
    let current = id;
    while (this.parent.get(current) !== current) {
      const next = this.parent.get(current);
      if (next === undefined) {
        return current;
      }
      current = next;
    }
    return current;
  }

  union(a: string, b: string): void {
    const left = this.find(a);
    const right = this.find(b);
    if (left === right) {
      return;
    }
    // The smaller id leads, so grouping never depends on visit order.
    if (left < right) {
      this.parent.set(right, left);
    } else {
      this.parent.set(left, right);
    }
  }
}

interface PairEvidence {
  /** Localized concept seeds carried by direct edges. */
  concepts: Set<string>;
  /** Localized symbols carried by direct edges inside one directory below the root. */
  directorySymbols: Set<string>;
  edges: number;
  /** Every localized symbol carried. */
  localized: Set<string>;
}

export function analyzeInternalResponsibilities(
  report: PackageLocalReport,
  topology: InternalPackageTopology,
  locality: SymbolLocalityReport,
  config: AnalysisConfig = ANALYSIS_CONFIG
): InternalResponsibilityReport {
  const prefix = report.package.path === "" ? "" : `${report.package.path}/`;
  const relative = (rootRelative: string) =>
    rootRelative.startsWith(prefix)
      ? rootRelative.slice(prefix.length)
      : rootRelative;

  const moduleById = new Map(topology.modules.map((m) => [m.id, m]));
  const directoryById = new Map(topology.directories.map((d) => [d.id, d]));
  const rolesOf = new Map(topology.roles.map((r) => [r.module, r.roles]));
  const findingById = new Map(locality.symbols.map((f) => [f.symbolId, f]));
  const seedById = new Map(report.conceptSeeds.map((s) => [s.id, s]));
  const primaryModules = topology.modules
    .filter((m) => m.primary)
    .map((m) => m.id)
    .sort((a, b) => a.localeCompare(b));
  const primary = new Set(primaryModules);
  const primaryEdges = topology.edges.filter((edge) => edge.primary);

  const aboveRegions = (directory: string): boolean => {
    const node = directoryById.get(directory);
    if (node?.parent === undefined) {
      return true;
    }
    return node.depth === 1 && topology.policy.technicalRoots.includes(node.id);
  };
  const directoryOf = (module: string) =>
    moduleById.get(module)?.directory ?? ".";
  const pathRegionOf = (module: string) =>
    moduleById.get(module)?.region ?? ".";
  const isConnector = (module: string) =>
    (rolesOf.get(module) ?? []).some((role) => CONNECTOR_ROLES.includes(role));
  const cutoff = topology.summary.highFanCutoff.fanIn;
  const localizedFinding = (
    symbolId: string | undefined
  ): SymbolLocalityFinding | undefined => {
    if (symbolId === undefined) {
      return undefined;
    }
    const finding = findingById.get(symbolId);
    if (finding === undefined) {
      return undefined;
    }
    return finding.distribution !== "package-distributed" &&
      finding.placement !== "split" &&
      finding.consumers.modules < cutoff
      ? finding
      : undefined;
  };

  // Atomic units: nontrivial cycles, else single primary modules.
  const unitOf = new Map<string, string>();
  const units: ResponsibilityUnit[] = [];
  analyzeInternalResponsibilitiesCycle(topology, units, unitOf);
  analyzeInternalResponsibilitiesModule(primaryModules, unitOf, units);
  units.sort((a, b) => a.id.localeCompare(b.id));
  const unitById = new Map(units.map((unit) => [unit.id, unit]));

  // Evidence between units, from direct edges between non-connector modules.
  // A mediated symbol pairs the consumer with its declaring module, not the
  // forwarder it was imported through.
  const pairs = new Map<string, PairEvidence>();
  const evidenceFor = (a: string, b: string): PairEvidence => {
    const key = pairKey(a, b);
    const entry = pairs.get(key) ?? {
      concepts: new Set<string>(),
      directorySymbols: new Set<string>(),
      edges: 0,
      localized: new Set<string>(),
    };
    pairs.set(key, entry);
    return entry;
  };
  const sameDirectoryBelowRoot = (a: string, b: string) => {
    const directory = directoryOf(a);
    return directory === directoryOf(b) && !aboveRegions(directory);
  };
  const visitKey = () => {
    for (const key of [...pairs.keys()].sort((a, b) => a.localeCompare(b))) {
      const evidence = pairs.get(key);
      if (evidence === undefined) {
        continue;
      }
      const reasons: ResponsibilityJoinReason[] = [];
      if (evidence.concepts.size > 0) {
        reasons.push("concept-flow");
      }
      if (evidence.directorySymbols.size > 0) {
        reasons.push("directory-dependency");
      }
      if (reasons.length === 0) {
        continue;
      }
      const [left, right] = key.split("\n") as [string, string];
      groups.union(left, right);
      joinedUnits.add(left);
      joinedUnits.add(right);
      joins.push({
        left,
        reasons,
        right,
        symbols: sorted([...evidence.concepts, ...evidence.directorySymbols]),
      });
    }
  };
  analyzeInternalResponsibilitiesEdge(
    primaryEdges,
    isConnector,
    unitOf,
    localizedFinding,
    evidenceFor,
    sameDirectoryBelowRoot
  );

  const groups = new Groups(units.map((unit) => unit.id));
  const joins: ResponsibilityJoin[] = [];
  const joinedUnits = new Set<string>();
  const visitEdge4 = () => {
    for (const edge of primaryEdges) {
      if (!(primary.has(edge.source) && primary.has(edge.target))) {
        continue;
      }
      if (edge.source === edge.target) {
        continue;
      }
      const symbols = edgeLocalized(edge);
      noteNeighbor(edge.source, edge.target, symbols);
      noteNeighbor(edge.target, edge.source, symbols);
    }
  };
  visitKey();

  // Localized-symbol neighbors per module, either direction, both
  // non-connector; used for bridge detection and affinities.
  const localizedNeighbors = new Map<
    string,
    Map<string, { edges: number; symbols: Set<string>; concept: boolean }>
  >();
  const noteNeighbor = (
    module: string,
    partner: string,
    groupSymbols: SymbolLocalityFinding[]
  ) => {
    const byPartner =
      localizedNeighbors.get(module) ??
      new Map<
        string,
        { edges: number; symbols: Set<string>; concept: boolean }
      >();
    const entry = byPartner.get(partner) ?? {
      concept: false,
      edges: 0,
      symbols: new Set<string>(),
    };
    entry.edges += 1;
    for (const symbol of groupSymbols) {
      entry.symbols.add(symbol.symbolId);
      if (symbol.conceptSeed) {
        entry.concept = true;
      }
    }
    byPartner.set(partner, entry);
    localizedNeighbors.set(module, byPartner);
  };
  const edgeLocalized = (edge: InternalModuleEdge) =>
    edge.symbols
      .map((symbol) => localizedFinding(symbol.symbolId))
      .filter((finding) => finding !== undefined);
  visitEdge4();

  // Unclaimed single modules: a bridge with localized neighbors in several
  // groups is unresolved; the rest fall back to their shared directory.
  const visitUnit2 = () => {
    for (const unit of unclaimed) {
      const module = unit.modules[0] ?? "";
      const roles = rolesOf.get(module) ?? [];
      if (roles.includes("bridge")) {
        const candidates = neighborGroups(module, true).filter(
          (candidate) => candidate.region !== unit.id
        );
        if (candidates.length >= 2) {
          unresolved.push({ candidates, module, reason: "bridge", roles });
          unresolvedModules.add(module);
          continue;
        }
      }
      const directory = directoryOf(module);
      if (aboveRegions(directory)) {
        continue;
      }
      const list = fallbackByDirectory.get(directory) ?? [];
      list.push(unit);
      fallbackByDirectory.set(directory, list);
    }
  };
  const unresolved: ResponsibilityAmbiguity[] = [];
  const visitDirectory = () => {
    for (const directory of sorted(fallbackByDirectory.keys())) {
      const list = fallbackByDirectory.get(directory) ?? [];
      if (list.length < 2) {
        continue;
      }
      const [first, ...rest] = list;
      if (first === undefined) {
        continue;
      }
      for (const unit of rest) {
        groups.union(first.id, unit.id);
        joins.push({
          left: first.id,
          reasons: ["directory-fallback"],
          right: unit.id,
          symbols: [],
        });
      }
    }
  };
  const unresolvedModules = new Set<string>();
  const unclaimed = units.filter(
    (unit) =>
      unit.kind === "module" &&
      !joinedUnits.has(unit.id) &&
      !isConnector(unit.modules[0] ?? "")
  );
  const groupOfModule = (module: string): string | undefined => {
    const unit = unitOf.get(module);
    return unit === undefined ? undefined : groups.find(unit);
  };
  const visitUnit3 = () => {
    for (const unit of units) {
      const connectorUnit =
        unit.kind === "module" && isConnector(unit.modules[0] ?? "");
      if (connectorUnit) {
        continue;
      }
      if (unit.modules.some((module) => unresolvedModules.has(module))) {
        continue;
      }
      const group = groups.find(unit.id);
      const list = membersByGroup.get(group) ?? [];
      list.push(...unit.modules);
      membersByGroup.set(group, list);
      for (const module of unit.modules) {
        statusOf.set(module, "assigned");
      }
    }
  };
  /** Placed by construction: inside a cycle unit, or a non-connector module not left unresolved. */
  const placeable = (module: string) =>
    !unresolvedModules.has(module) &&
    (unitById.get(unitOf.get(module) ?? "")?.kind === "cycle" ||
      !isConnector(module));
  const neighborGroups = (
    module: string,
    localizedOnly: boolean
  ): ResponsibilityCandidate[] => {
    const tallies = new Map<string, ResponsibilityCandidate>();
    for (const [partner, entry] of localizedNeighbors.get(module) ?? []) {
      if (localizedOnly && entry.symbols.size === 0) {
        continue;
      }
      if (!placeable(partner)) {
        continue;
      }
      const group = groupOfModule(partner);
      if (group === undefined) {
        continue;
      }
      const candidate = tallies.get(group) ?? {
        edges: 0,
        localizedSymbols: 0,
        region: group,
      };
      candidate.edges += entry.edges;
      candidate.localizedSymbols += entry.symbols.size;
      tallies.set(group, candidate);
    }
    return [...tallies.values()].sort(
      (a, b) =>
        b.edges - a.edges ||
        b.localizedSymbols - a.localizedSymbols ||
        a.region.localeCompare(b.region)
    );
  };
  const fallbackByDirectory = new Map<string, ResponsibilityUnit[]>();
  visitUnit2();
  visitDirectory();

  // Base regions from non-connector units, then connector attachment.
  const membersByGroup = new Map<string, string[]>();
  const statusOf = new Map<string, "assigned" | "attached">();
  visitUnit3();
  const attachedByGroup = new Map<string, string[]>();
  const ambiguityReason = (
    roles: InternalModuleRole[]
  ): ResponsibilityAmbiguityReason => {
    if (roles.includes("aggregator")) {
      return "aggregator";
    }
    if (roles.includes("high-fan-in")) {
      return "distributed-primitive";
    }
    return "wide-dependent";
  };
  analyzeInternalResponsibilitiesUnit(
    units,
    isConnector,
    rolesOf,
    neighborGroups,
    attachedByGroup,
    statusOf,
    membersByGroup,
    unresolved,
    ambiguityReason,
    unresolvedModules
  );

  // Region membership and identity.
  const drafts: Draft[] = [];
  for (const [group, members] of membersByGroup) {
    const attached = (attachedByGroup.get(group) ?? []).sort((a, b) =>
      a.localeCompare(b)
    );
    const modules = sorted([...members, ...attached]);
    drafts.push({
      attached,
      group,
      modules,
      units: sorted(
        members.map((module) => unitOf.get(module) ?? `module:${module}`)
      ),
    });
  }
  drafts.sort(
    (a, b) =>
      b.modules.length - a.modules.length ||
      (a.modules[0] ?? "").localeCompare(b.modules[0] ?? "")
  );
  const idByGroup = new Map(
    drafts.map((draft) => [draft.group, regionId(draft.modules)])
  );
  const regionOfModule = new Map<string, string>();
  analyzeInternalResponsibilitiesDraft(drafts, idByGroup, regionOfModule);
  const renameGroup = (group: string) => idByGroup.get(group) ?? group;
  analyzeInternalResponsibilitiesAmbiguity(unresolved, renameGroup);

  // Module-indexed evidence: concepts, behavior, localized symbols.
  const seedsByModule = new Map<string, string[]>();
  for (const seed of report.conceptSeeds) {
    const module = relative(seed.file);
    const list = seedsByModule.get(module) ?? [];
    list.push(seed.id);
    seedsByModule.set(module, list);
  }
  const seedModule = (conceptId: string) => {
    const seed = seedById.get(conceptId);
    return seed === undefined ? undefined : relative(seed.file);
  };
  const participantsByConcept = new Map<string, Participation[]>();
  const participationByModule = new Map<string, Set<string>>();
  analyzeInternalResponsibilitiesEntry(
    report,
    relative,
    primary,
    seedModule,
    participantsByConcept,
    participationByModule
  );
  const statementsByModule = new Map<string, number>();
  const conceptOwnedByModule = new Map<string, number>();
  const ownersByModule = new Map<string, Set<string>>();
  analyzeInternalResponsibilitiesFn(
    report,
    relative,
    statementsByModule,
    seedById,
    conceptOwnedByModule,
    ownersByModule
  );
  const declaredFindingsByModule = new Map<string, SymbolLocalityFinding[]>();
  const consumedFindingsByModule = new Map<string, SymbolLocalityFinding[]>();
  analyzeInternalResponsibilitiesFinding(
    locality,
    declaredFindingsByModule,
    consumedFindingsByModule
  );
  const localizedDeclared = (module: string) =>
    (declaredFindingsByModule.get(module) ?? []).filter(
      (finding) => localizedFinding(finding.symbolId) !== undefined
    ).length;
  const localizedConsumed = (module: string) =>
    (consumedFindingsByModule.get(module) ?? []).filter(
      (finding) => localizedFinding(finding.symbolId) !== undefined
    ).length;

  const primaryModulesByPathRegion = new Map<string, number>();
  for (const module of primaryModules) {
    const region = pathRegionOf(module);
    primaryModulesByPathRegion.set(
      region,
      (primaryModulesByPathRegion.get(region) ?? 0) + 1
    );
  }

  const conceptEntry = (
    conceptId: string,
    inside: Set<string>
  ): ResponsibilityConceptEntry | undefined => {
    const seed = seedById.get(conceptId);
    if (seed === undefined) {
      return undefined;
    }
    const participants = (participantsByConcept.get(conceptId) ?? []).filter(
      (participation) => inside.has(participation.module)
    );
    return {
      conceptId,
      modules: participants.length,
      name: seed.name,
      relationships: sorted(
        participants.flatMap((participation) => participation.kinds)
      ) as ConceptRelationshipKind[],
    };
  };
  const byParticipantsThenId = (
    a: ResponsibilityConceptEntry,
    b: ResponsibilityConceptEntry
  ) => b.modules - a.modules || a.conceptId.localeCompare(b.conceptId);
  const visitEdge3 = () => {
    for (const edge of primaryEdges) {
      const from = pathRegionOf(edge.source);
      const to = pathRegionOf(edge.target);
      if (from === to) {
        continue;
      }
      const key = `${from}\n${to}`;
      const draft = pathSeamDrafts.get(key) ?? {
        acrossResponsibilities: 0,
        from,
        moduleEdges: 0,
        to,
        unresolved: 0,
        withinResponsibility: 0,
      };
      draft.moduleEdges += 1;
      const source = regionOfModule.get(edge.source);
      const target = regionOfModule.get(edge.target);
      if (source === undefined || target === undefined) {
        draft.unresolved += 1;
      } else if (source === target) {
        draft.withinResponsibility += 1;
      } else {
        draft.acrossResponsibilities += 1;
      }
      pathSeamDrafts.set(key, draft);
    }
  };

  const regions: ResponsibilityRegion[] = drafts.map((draft) =>
    analyzeInternalResponsibilitiesEntries(
      idByGroup,
      draft,
      directoryOf,
      pathRegionOf,
      primaryModulesByPathRegion,
      primaryEdges,
      moduleById,
      rolesOf,
      seedsByModule,
      conceptEntry,
      byParticipantsThenId,
      participationByModule,
      seedModule,
      localizedFinding,
      statementsByModule,
      config,
      ownersByModule,
      declaredFindingsByModule,
      consumedFindingsByModule,
      joins,
      groups,
      aboveRegions,
      unitById,
      conceptOwnedByModule
    )
  );
  const regionById = new Map(regions.map((region) => [region.id, region]));

  // Relationships between responsibilities, from primary edges whose
  // endpoints are both placed.
  const relationshipDrafts = new Map<string, RelationshipDraft>();
  analyzeInternalResponsibilitiesEdge2(
    primaryEdges,
    regionOfModule,
    relationshipDrafts
  );
  const relationships: ResponsibilityRelationship[] = [
    ...relationshipDrafts.values(),
  ]
    .map((draft) => {
      const symbolSites = new Map<
        string,
        { symbolId?: string; importSites: number }
      >();
      const concepts = new Set<string>();
      let importSites = 0;
      let within = 0;
      let mediatedEdges = 0;
      for (const edge of draft.edges) {
        importSites += edge.importSites;
        if (pathRegionOf(edge.source) === pathRegionOf(edge.target)) {
          within += 1;
        }
        if (edge.symbols.length > 0 && edge.symbols.every((s) => s.mediated)) {
          mediatedEdges += 1;
        }
        for (const symbol of edge.symbols) {
          const key = symbol.symbolId ?? `name:${symbol.name}`;
          const entry = symbolSites.get(key) ?? {
            ...(symbol.symbolId !== undefined && { symbolId: symbol.symbolId }),
            importSites: 0,
          };
          entry.importSites += symbol.importSites + symbol.namespaceSites;
          symbolSites.set(key, entry);
          if (
            symbol.symbolId !== undefined &&
            findingById.get(symbol.symbolId)?.conceptSeed
          ) {
            concepts.add(symbol.symbolId);
          }
        }
      }
      const dominantSymbols = [...symbolSites.entries()]
        .sort(
          (a, b) =>
            b[1].importSites - a[1].importSites || a[0].localeCompare(b[0])
        )
        .slice(0, config.internalResponsibilities.report.topSymbols)
        .map(([key, entry]) => ({
          name:
            entry.symbolId === undefined
              ? key.slice("name:".length)
              : (findingById.get(entry.symbolId)?.name ?? key),
          ...(entry.symbolId !== undefined && { symbolId: entry.symbolId }),
          importSites: entry.importSites,
        }));
      return {
        concepts: sorted(concepts),
        dominantSymbols,
        from: draft.from,
        importSites,
        mediatedEdges,
        moduleEdges: draft.edges.length,
        pathRegions: { across: draft.edges.length - within, within },
        sourceModules: sorted(draft.edges.map((edge) => edge.source)),
        symbolFlow: symbolSites.size,
        targetModules: sorted(draft.edges.map((edge) => edge.target)),
        to: draft.to,
      };
    })
    .sort(
      (a, b) =>
        b.moduleEdges - a.moduleEdges ||
        a.from.localeCompare(b.from) ||
        a.to.localeCompare(b.to)
    );

  const condensation = condense(
    buildAdjacency(
      regions.map((region) => region.id),
      relationships.map((relationship) => [relationship.from, relationship.to])
    )
  );
  const cycleMembers = new Map<string, string[]>();
  for (const [node, component] of condensation.componentOf) {
    const list = cycleMembers.get(component) ?? [];
    list.push(node);
    cycleMembers.set(component, list);
  }
  const regionCycles = [...cycleMembers.values()]
    .filter((members) => members.length > 1)
    .map((members) => sorted(members))
    .sort(
      (a, b) => b.length - a.length || (a[0] ?? "").localeCompare(b[0] ?? "")
    );

  // Path seams against responsibility membership.
  const pathSeamDrafts = new Map<string, ResponsibilityPathSeamComparison>();
  visitEdge3();
  const pathSeams = [...pathSeamDrafts.values()].sort(
    (a, b) =>
      b.moduleEdges - a.moduleEdges ||
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to)
  );

  // Symbol context over the V13.1 findings, by symbol id.
  const symbols: ResponsibilitySymbolContext[] = [...locality.symbols]
    .sort((a, b) => a.symbolId.localeCompare(b.symbolId))
    .map((finding) => {
      const declarationRegion = regionOfModule.get(finding.declaration.module);
      const consumerRegions = sorted(
        finding.consumerModules
          .map((consumer) => regionOfModule.get(consumer))
          .filter((region) => region !== undefined)
      );
      const unresolvedConsumers = finding.consumerModules.filter(
        (consumer) => !regionOfModule.has(consumer)
      ).length;
      let symbolLocality: ResponsibilitySymbolLocality;
      if (declarationRegion === undefined || consumerRegions.length === 0) {
        symbolLocality = "unplaced";
      } else if (
        consumerRegions.length === 1 &&
        consumerRegions[0] === declarationRegion &&
        unresolvedConsumers === 0
      ) {
        symbolLocality = "responsibility-local";
      } else {
        symbolLocality = "responsibility-crossing";
      }
      return {
        conceptSeed: finding.conceptSeed,
        kind: finding.kind,
        name: finding.name,
        symbolId: finding.symbolId,
        ...(declarationRegion !== undefined && { declarationRegion }),
        consumerModules: finding.consumers.modules,
        consumerRegions,
        locality: symbolLocality,
        unresolvedConsumers,
      };
    });

  // Per-module evidence.
  const modules: ResponsibilityModuleEvidence[] = primaryModules.map(
    (module) => {
      const region = regionOfModule.get(module);
      const status = unresolvedModules.has(module)
        ? "unresolved"
        : (statusOf.get(module) ?? "assigned");
      const affinityTallies = new Map<string, ResponsibilityAffinity>();
      collectEntries(
        localizedNeighbors,
        module,
        regionOfModule,
        region,
        affinityTallies
      );
      const affinities = [...affinityTallies.values()]
        .map((affinity) => ({ ...affinity, kinds: [...affinity.kinds].sort() }))
        .sort((a, b) => b.edges - a.edges || a.region.localeCompare(b.region));
      const owner = region === undefined ? undefined : regionById.get(region);
      const cycle = moduleById.get(module)?.cycle;
      return {
        module,
        status,
        unit: unitOf.get(module) ?? `module:${module}`,
        ...(region !== undefined && { region }),
        directory: directoryOf(module),
        pathRegion: pathRegionOf(module),
        ...(cycle !== undefined && { cycle }),
        behaviorMass: statementsByModule.get(module) ?? 0,
        concepts: {
          declared: seedsByModule.get(module)?.length ?? 0,
          participating: participationByModule.get(module)?.size ?? 0,
        },
        connector: isConnector(module),
        localizedSymbols: {
          consumed: localizedConsumed(module),
          declared: localizedDeclared(module),
        },
        roles: rolesOf.get(module) ?? [],
        ...(owner !== undefined && {
          pathAgreesWithRegion:
            directoryOf(module) === owner.path.dominantDirectory.id,
        }),
        affinities,
      };
    }
  );

  // Summary.
  const regionsByPathRegion = new Map<string, Set<string>>();
  for (const region of regions) {
    for (const pathRegion of region.path.pathRegions) {
      const set = regionsByPathRegion.get(pathRegion) ?? new Set<string>();
      set.add(region.id);
      regionsByPathRegion.set(pathRegion, set);
    }
  }
  const totalMass = regions.reduce(
    (sum, region) => sum + region.behavior.mass,
    0
  );
  const summary: InternalResponsibilitySummary = {
    assignedModules: modules.filter((m) => m.status === "assigned").length,
    attachedModules: modules.filter((m) => m.status === "attached").length,
    behaviorBearingRegions: regions.filter((r) => r.behavior.mass > 0).length,
    behaviorLightRegions: regions.filter((r) => r.behavior.mass === 0).length,
    behaviorMass: {
      topRegionShare: share(
        Math.max(0, ...regions.map((region) => region.behavior.mass)),
        totalMass
      ),
      total: totalMass,
    },
    byLabelBasis: zeroRecord(LABEL_BASES),
    byPathAgreement: zeroRecord(PATH_AGREEMENTS),
    connectors: primaryModules.filter(isConnector).length,
    cycleUnits: units.filter((unit) => unit.kind === "cycle").length,
    joinsByReason: zeroRecord(JOIN_REASONS),
    largestRegion: regions[0]?.modules.length ?? 0,
    multiModuleRegions: regions.filter((r) => r.modules.length > 1).length,
    pathRegionsSplit: [...regionsByPathRegion.values()].filter(
      (set) => set.size > 1
    ).length,
    pathSeamsCollapsed: pathSeams.filter(
      (seam) =>
        seam.acrossResponsibilities === 0 && seam.withinResponsibility > 0
    ).length,
    primaryModules: primaryModules.length,
    regionCycles: regionCycles.length,
    regions: regions.length,
    regionsWithDeclaredConcepts: regions.filter(
      (r) => r.concepts.declared.length > 0
    ).length,
    regionsWithoutConcepts: regions.filter(
      (r) => r.concepts.declared.length === 0
    ).length,
    regionsWithSeveralConcepts: regions.filter(
      (r) => r.concepts.declared.length > 1
    ).length,
    relationships: relationships.length,
    relationshipsHiddenInPathRegions: relationships.filter(
      (r) => r.pathRegions.across === 0
    ).length,
    responsibilitiesSpanningDirectories: regions.filter(
      (r) => r.path.directories.length > 1
    ).length,
    responsibilitiesSpanningPaths: regions.filter(
      (r) => r.path.pathRegions.length > 1
    ).length,
    singleModuleRegions: regions.filter((r) => r.modules.length === 1).length,
    symbols: zeroRecord(SYMBOL_LOCALITIES),
    units: units.length,
    unresolvedByReason: zeroRecord(AMBIGUITY_REASONS),
    unresolvedModules: unresolved.length,
  };
  for (const ambiguity of unresolved) {
    summary.unresolvedByReason[ambiguity.reason] += 1;
  }
  for (const join of joins) {
    for (const reason of join.reasons) {
      summary.joinsByReason[reason] += 1;
    }
  }
  for (const region of regions) {
    summary.byPathAgreement[region.path.agreement] += 1;
    summary.byLabelBasis[region.labelBasis] += 1;
  }
  for (const symbol of symbols) {
    summary.symbols[symbol.locality] += 1;
  }

  unresolved.sort((a, b) => a.module.localeCompare(b.module));

  return {
    limitations: [
      "behavior evidence profiles regions and is never a join reason",
      "anchors are package-level in the local report; no internal anchor constrains a join",
      "intra-module usage is not measured; a module's own symbols say nothing about its neighbors",
      "the root and technical roots carry no path evidence, so a flat package joins on concept flow alone",
    ],
    modules,
    package: { ...topology.package },
    pathSeams,
    policy: {
      attachment:
        "a connector joins the one region its localized-symbol edges reach, else the one region any edge reaches; several regions leave it unresolved",
      bridge:
        "a bridge-role module with no join and localized-symbol edges into several regions is unresolved",
      connectorRoles: [...CONNECTOR_ROLES],
      identity: "sha256 over the sorted member modules",
      joins: {
        "concept-flow":
          "a direct edge between non-connector modules carries a localized concept seed",
        "directory-dependency":
          "a direct edge between non-connector modules in one directory below the root carries a localized symbol",
        "directory-fallback":
          "single modules no rule claimed, grouped by their shared directory below the root",
      },
      label:
        "the shared directory below the root; else the declared concept with the most region participants; else the highest fan-in module",
      localizedSymbol:
        "a consumed symbol below the cutoff whose locality is neither package-distributed nor split",
      localizedSymbolCutoff: cutoff,
      order: "modules descending, then first module",
      technicalRoots: [...topology.policy.technicalRoots],
      unit: "nontrivial cycle, else one primary module",
    },
    regionCycles,
    regions,
    relationships,
    schemaVersion: INTERNAL_RESPONSIBILITY_SCHEMA_VERSION,
    summary,
    symbols,
    units,
    unresolved,
  };
}

function analyzeInternalResponsibilitiesEntries(
  idByGroup: Map<string, string>,
  draft: Draft,
  directoryOf: (module: string) => string,
  pathRegionOf: (module: string) => string,
  primaryModulesByPathRegion: Map<string, number>,
  primaryEdges: InternalModuleEdge[],
  moduleById: Map<string, InternalModuleNode>,
  rolesOf: Map<string, InternalModuleRole[]>,
  seedsByModule: Map<string, string[]>,
  conceptEntry: (
    conceptId: string,
    inside: Set<string>
  ) => ResponsibilityConceptEntry | undefined,
  byParticipantsThenId: (
    a: ResponsibilityConceptEntry,
    b: ResponsibilityConceptEntry
  ) => number,
  participationByModule: Map<string, Set<string>>,
  seedModule: (conceptId: string) => string | undefined,
  localizedFinding: (
    symbolId: string | undefined
  ) => SymbolLocalityFinding | undefined,
  statementsByModule: Map<string, number>,
  config: AnalysisConfig,
  ownersByModule: Map<string, Set<string>>,
  declaredFindingsByModule: Map<string, SymbolLocalityFinding[]>,
  consumedFindingsByModule: Map<string, SymbolLocalityFinding[]>,
  joins: ResponsibilityJoin[],
  groups: Groups,
  aboveRegions: (directory: string) => boolean,
  unitById: Map<string, ResponsibilityUnit>,
  conceptOwnedByModule: Map<string, number>
): {
  attached: string[];
  behavior: {
    bearingModules: number;
    conceptOwnedMass: number;
    conceptOwners: string[];
    dominantModules: { share: number; module: string; statements: number }[];
    mass: number;
  };
  concepts: {
    declared: ResponsibilityConceptEntry[];
    referenced: ResponsibilityConceptEntry[];
  };
  construction: {
    joins: ResponsibilityJoin[];
    joinsByReason: Record<ResponsibilityJoinReason, number>;
  };
  evidence: ResponsibilityEvidenceKind[];
  id: string;
  label: string;
  labelBasis: ResponsibilityLabelBasis;
  modules: string[];
  path: {
    agreement: ResponsibilityPathAgreement;
    directories: string[];
    dominantDirectory: { id: string; modules: number; share: number };
    pathRegions: string[];
  };
  symbols: {
    behaviorDisagreesWithUsage: number;
    consumedFromOutside: number;
    crossing: number;
    declared: number;
    distributedConsumed: number;
    local: number;
  };
  topology: {
    cycles: string[];
    dependencySinks: number;
    dependencySources: number;
    inboundEdges: number;
    internalEdges: number;
    layerSpan: { max: number; min: number };
    outboundEdges: number;
    roles: { [k: string]: number };
  };
  units: string[];
} {
  const id = idByGroup.get(draft.group) ?? draft.group;
  const inside = new Set(draft.modules);
  const directories = sorted(draft.modules.map(directoryOf));
  const pathRegions = sorted(draft.modules.map(pathRegionOf));
  const directoryCounts = new Map<string, number>();
  const visitModule3 = (module: string) => {
    const directory = directoryOf(module);
    directoryCounts.set(directory, (directoryCounts.get(directory) ?? 0) + 1);
  };
  for (const module of draft.modules) {
    visitModule3(module);
  }
  const [dominant] = [...directoryCounts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0])
  );
  const dominantDirectory = {
    id: dominant?.[0] ?? ".",
    modules: dominant?.[1] ?? 0,
    share: share(dominant?.[1] ?? 0, draft.modules.length),
  };

  const agreement: ResponsibilityPathAgreement =
    analyzeInternalResponsibilitiesEntriesEntries(
      pathRegions,
      draft,
      primaryModulesByPathRegion
    );

  let internalEdges = 0;
  let inboundEdges = 0;
  let outboundEdges = 0;
  const visitEdge = () => {
    for (const edge of primaryEdges) {
      const from = inside.has(edge.source);
      const to = inside.has(edge.target);
      if (from && to) {
        internalEdges += 1;
      } else if (to) {
        inboundEdges += 1;
      } else if (from) {
        outboundEdges += 1;
      }
    }
  };
  visitEdge();
  const layers = draft.modules.map(
    (module) => moduleById.get(module)?.layer ?? 0
  );
  const roles: Partial<Record<InternalModuleRole, number>> = {};
  analyzeInternalResponsibilitiesEntriesModule(draft, rolesOf, roles);

  const declaredSeeds = draft.modules.flatMap(
    (module) => seedsByModule.get(module) ?? []
  );
  const declared = declaredSeeds
    .map((conceptId) => conceptEntry(conceptId, inside))
    .filter((entry) => entry !== undefined)
    .filter((entry) => entry.modules > 0)
    .sort(byParticipantsThenId);
  const referencedIds = new Set<string>();
  const visitModule = () => {
    for (const module of draft.modules) {
      for (const conceptId of participationByModule.get(module) ?? []) {
        if (inside.has(seedModule(conceptId) ?? "")) {
          continue;
        }
        if (localizedFinding(conceptId) === undefined) {
          continue;
        }
        referencedIds.add(conceptId);
      }
    }
  };
  visitModule();
  const referenced = [...referencedIds]
    .map((conceptId) => conceptEntry(conceptId, inside))
    .filter((entry) => entry !== undefined)
    .sort(byParticipantsThenId);

  const statements = draft.modules.map((module) => ({
    module,
    statements: statementsByModule.get(module) ?? 0,
  }));
  const mass = statements.reduce((sum, entry) => sum + entry.statements, 0);
  const dominantModules = statements
    .filter((entry) => entry.statements > 0)
    .sort(
      (a, b) => b.statements - a.statements || a.module.localeCompare(b.module)
    )
    .slice(0, config.internalResponsibilities.report.topModules)
    .map((entry) => ({ ...entry, share: share(entry.statements, mass) }));
  const conceptOwners = sorted(
    draft.modules.flatMap((module) => [...(ownersByModule.get(module) ?? [])])
  );

  const declaredFindings = draft.modules.flatMap(
    (module) => declaredFindingsByModule.get(module) ?? []
  );
  const local = declaredFindings.filter((finding) =>
    finding.consumerModules.every((consumer) => inside.has(consumer))
  ).length;
  const consumedOutside = new Set<string>();
  const distributedConsumed = new Set<string>();
  const visitModule2 = () => {
    for (const module of draft.modules) {
      for (const finding of consumedFindingsByModule.get(module) ?? []) {
        if (inside.has(finding.declaration.module)) {
          continue;
        }
        consumedOutside.add(finding.symbolId);
        if (finding.distribution === "package-distributed") {
          distributedConsumed.add(finding.symbolId);
        }
      }
    }
  };
  visitModule2();

  const evidence: ResponsibilityRegion["evidence"] = [];
  const joinsHere = joins.filter(
    (join) => groups.find(join.left) === draft.group
  );
  const joinsByReason = zeroRecord(JOIN_REASONS);
  analyzeInternalResponsibilitiesEntriesJoin(joinsHere, joinsByReason);
  analyzeInternalResponsibilitiesEntriesEntries3(
    directories,
    aboveRegions,
    joinsByReason,
    evidence
  );
  if (internalEdges > 0) {
    evidence.push("dependency");
  }
  const cycles = sorted(
    draft.units
      .map((unit) => unitById.get(unit)?.cycle)
      .filter((cycle) => cycle !== undefined)
  );
  if (cycles.length > 0) {
    evidence.push("cycle");
  }
  if (declared.length > 0 || joinsByReason["concept-flow"] > 0) {
    evidence.push("concept");
  }
  if (mass > 0) {
    evidence.push("behavior");
  }
  if (local > 0) {
    evidence.push("symbol-flow");
  }
  if (inboundEdges > 0 || outboundEdges > 0) {
    evidence.push("seam");
  }

  const [topConcept] = declared;
  const {
    label,
    labelBasis,
  }: { label: string; labelBasis: ResponsibilityLabelBasis } =
    analyzeInternalResponsibilitiesEntriesEntries2(
      directories,
      aboveRegions,
      topConcept,
      draft,
      moduleById,
      id
    );

  return {
    attached: draft.attached,
    behavior: {
      bearingModules: statements.filter((entry) => entry.statements > 0).length,
      conceptOwnedMass: draft.modules.reduce(
        (sum, module) => sum + (conceptOwnedByModule.get(module) ?? 0),
        0
      ),
      conceptOwners,
      dominantModules,
      mass,
    },
    concepts: { declared, referenced },
    construction: {
      joins: joinsHere.sort(
        (a, b) => a.left.localeCompare(b.left) || a.right.localeCompare(b.right)
      ),
      joinsByReason,
    },
    evidence,
    id,
    label,
    labelBasis,
    modules: draft.modules,
    path: { agreement, directories, dominantDirectory, pathRegions },
    symbols: {
      behaviorDisagreesWithUsage: declaredFindings.filter(
        (finding) => finding.behavior.agreesWithUsage === false
      ).length,
      consumedFromOutside: consumedOutside.size,
      crossing: declaredFindings.length - local,
      declared: declaredFindings.length,
      distributedConsumed: distributedConsumed.size,
      local,
    },
    topology: {
      cycles,
      dependencySinks: roles["dependency-sink"] ?? 0,
      dependencySources: roles["dependency-source"] ?? 0,
      inboundEdges,
      internalEdges,
      layerSpan: {
        max: layers.length === 0 ? 0 : Math.max(...layers),
        min: layers.length === 0 ? 0 : Math.min(...layers),
      },
      outboundEdges,
      roles: Object.fromEntries(
        Object.entries(roles).sort(([a], [b]) => a.localeCompare(b))
      ),
    },
    units: draft.units,
  };
}

function analyzeInternalResponsibilitiesEntriesEntries3(
  directories: string[],
  aboveRegions: (directory: string) => boolean,
  joinsByReason: Record<ResponsibilityJoinReason, number>,
  evidence: (
    | "path"
    | "dependency"
    | "cycle"
    | "concept"
    | "behavior"
    | "symbol-flow"
    | "seam"
  )[]
) {
  if (
    (directories.length === 1 && !aboveRegions(directories[0] ?? ".")) ||
    joinsByReason["directory-dependency"] > 0 ||
    joinsByReason["directory-fallback"] > 0
  ) {
    evidence.push("path");
  }
}

function analyzeInternalResponsibilitiesEntriesEntries2(
  directories: string[],
  aboveRegions: (directory: string) => boolean,
  topConcept: ResponsibilityConceptEntry | undefined,
  draft: Draft,
  moduleById: Map<string, InternalModuleNode>,
  id: string
): { label: string; labelBasis: ResponsibilityLabelBasis } {
  let label: string;
  let labelBasis: ResponsibilityLabelBasis;
  if (directories.length === 1 && !aboveRegions(directories[0] ?? ".")) {
    label = directories[0] ?? ".";
    labelBasis = "directory";
  } else if (topConcept === undefined) {
    const [top] = [...draft.modules].sort(
      (a, b) =>
        (moduleById.get(b)?.fanIn ?? 0) - (moduleById.get(a)?.fanIn ?? 0) ||
        a.localeCompare(b)
    );
    label = top ?? id;
    labelBasis = "module";
  } else {
    label = topConcept.name;
    labelBasis = "concept";
  }
  return { label, labelBasis };
}

function analyzeInternalResponsibilitiesEntriesJoin(
  joinsHere: ResponsibilityJoin[],
  joinsByReason: Record<ResponsibilityJoinReason, number>
) {
  for (const join of joinsHere) {
    for (const reason of join.reasons) {
      joinsByReason[reason] += 1;
    }
  }
}

function analyzeInternalResponsibilitiesEntriesModule(
  draft: Draft,
  rolesOf: Map<string, InternalModuleRole[]>,
  roles: Partial<Record<InternalModuleRole, number>>
) {
  for (const module of draft.modules) {
    for (const role of rolesOf.get(module) ?? []) {
      roles[role] = (roles[role] ?? 0) + 1;
    }
  }
}

function analyzeInternalResponsibilitiesEntriesEntries(
  pathRegions: string[],
  draft: Draft,
  primaryModulesByPathRegion: Map<string, number>
): ResponsibilityPathAgreement {
  let agreement: ResponsibilityPathAgreement;
  if (pathRegions.length > 1) {
    agreement = "spans-path-regions";
  } else if (
    draft.modules.length ===
    (primaryModulesByPathRegion.get(pathRegions[0] ?? "") ?? 0)
  ) {
    agreement = "matches-path-region";
  } else {
    agreement = "within-path-region";
  }
  return agreement;
}

function analyzeInternalResponsibilitiesEdge2(
  primaryEdges: InternalModuleEdge[],
  regionOfModule: Map<string, string>,
  relationshipDrafts: Map<string, RelationshipDraft>
) {
  for (const edge of primaryEdges) {
    const from = regionOfModule.get(edge.source);
    const to = regionOfModule.get(edge.target);
    if (from === undefined || to === undefined || from === to) {
      continue;
    }
    const key = `${from}\n${to}`;
    const draft = relationshipDrafts.get(key) ?? { edges: [], from, to };
    draft.edges.push(edge);
    relationshipDrafts.set(key, draft);
  }
}

function analyzeInternalResponsibilitiesFinding(
  locality: SymbolLocalityReport,
  declaredFindingsByModule: Map<string, SymbolLocalityFinding[]>,
  consumedFindingsByModule: Map<string, SymbolLocalityFinding[]>
) {
  for (const finding of locality.symbols) {
    const list = declaredFindingsByModule.get(finding.declaration.module) ?? [];
    list.push(finding);
    declaredFindingsByModule.set(finding.declaration.module, list);
    for (const consumer of finding.consumerModules) {
      const consumed = consumedFindingsByModule.get(consumer) ?? [];
      consumed.push(finding);
      consumedFindingsByModule.set(consumer, consumed);
    }
  }
}

function analyzeInternalResponsibilitiesFn(
  report: PackageLocalReport,
  relative: (rootRelative: string) => string,
  statementsByModule: Map<string, number>,
  seedById: Map<string, PackageLocalConceptSeed>,
  conceptOwnedByModule: Map<string, number>,
  ownersByModule: Map<string, Set<string>>
) {
  for (const fn of report.localComplexity.functions) {
    const module = relative(fn.file);
    statementsByModule.set(
      module,
      (statementsByModule.get(module) ?? 0) + fn.metrics.statements
    );
    if (fn.ownerSymbolId !== undefined && seedById.has(fn.ownerSymbolId)) {
      conceptOwnedByModule.set(
        module,
        (conceptOwnedByModule.get(module) ?? 0) + fn.metrics.statements
      );
      const owners = ownersByModule.get(module) ?? new Set<string>();
      owners.add(fn.ownerSymbolId);
      ownersByModule.set(module, owners);
    }
  }
}

function analyzeInternalResponsibilitiesEntry(
  report: PackageLocalReport,
  relative: (rootRelative: string) => string,
  primary: Set<string>,
  seedModule: (conceptId: string) => string | undefined,
  participantsByConcept: Map<string, Participation[]>,
  participationByModule: Map<string, Set<string>>
) {
  for (const entry of report.conceptParticipation) {
    const module = relative(entry.module);
    if (!primary.has(module) || module === seedModule(entry.conceptId)) {
      continue;
    }
    const list = participantsByConcept.get(entry.conceptId) ?? [];
    list.push({
      kinds: Object.keys(
        entry.relationships
      ).sort() as ConceptRelationshipKind[],
      module,
    });
    participantsByConcept.set(entry.conceptId, list);
    const set = participationByModule.get(module) ?? new Set<string>();
    set.add(entry.conceptId);
    participationByModule.set(module, set);
  }
}

function analyzeInternalResponsibilitiesAmbiguity(
  unresolved: ResponsibilityAmbiguity[],
  renameGroup: (group: string) => string
) {
  for (const ambiguity of unresolved) {
    for (const candidate of ambiguity.candidates) {
      candidate.region = renameGroup(candidate.region);
    }
  }
}

function analyzeInternalResponsibilitiesDraft(
  drafts: Draft[],
  idByGroup: Map<string, string>,
  regionOfModule: Map<string, string>
) {
  for (const draft of drafts) {
    const id = idByGroup.get(draft.group) ?? draft.group;
    for (const module of draft.modules) {
      regionOfModule.set(module, id);
    }
  }
}

function analyzeInternalResponsibilitiesModule(
  primaryModules: string[],
  unitOf: Map<string, string>,
  units: ResponsibilityUnit[]
) {
  for (const module of primaryModules) {
    if (unitOf.has(module)) {
      continue;
    }
    const id = `module:${module}`;
    units.push({ id, kind: "module", modules: [module] });
    unitOf.set(module, id);
  }
}

function analyzeInternalResponsibilitiesCycle(
  topology: InternalPackageTopology,
  units: ResponsibilityUnit[],
  unitOf: Map<string, string>
) {
  for (const cycle of topology.cycles) {
    const id = `cycle:${cycle.id}`;
    const modules = [...cycle.modules].sort((a, b) => a.localeCompare(b));
    units.push({ cycle: cycle.id, id, kind: "cycle", modules });
    for (const module of modules) {
      unitOf.set(module, id);
    }
  }
}

function analyzeInternalResponsibilitiesEdge(
  primaryEdges: InternalModuleEdge[],
  isConnector: (module: string) => boolean,
  unitOf: Map<string, string>,
  localizedFinding: (
    symbolId: string | undefined
  ) => SymbolLocalityFinding | undefined,
  evidenceFor: (a: string, b: string) => PairEvidence,
  sameDirectoryBelowRoot: (a: string, b: string) => boolean
) {
  for (const edge of primaryEdges) {
    if (isConnector(edge.source)) {
      continue;
    }
    const sourceUnit = unitOf.get(edge.source);
    if (sourceUnit === undefined) {
      continue;
    }
    const touched = new Set<string>();
    analyzeInternalResponsibilitiesEdgeSymbol(
      edge,
      localizedFinding,
      unitOf,
      sourceUnit,
      isConnector,
      evidenceFor,
      touched,
      sameDirectoryBelowRoot
    );
  }
}

function analyzeInternalResponsibilitiesEdgeSymbol(
  edge: InternalModuleEdge,
  localizedFinding: (
    symbolId: string | undefined
  ) => SymbolLocalityFinding | undefined,
  unitOf: Map<string, string>,
  sourceUnit: string,
  isConnector: (module: string) => boolean,
  evidenceFor: (a: string, b: string) => PairEvidence,
  touched: Set<string>,
  sameDirectoryBelowRoot: (a: string, b: string) => boolean
) {
  for (const symbol of edge.symbols) {
    const finding = localizedFinding(symbol.symbolId);
    if (finding === undefined) {
      continue;
    }
    const partner =
      symbol.mediated && symbol.declarationModule !== undefined
        ? symbol.declarationModule
        : edge.target;
    const partnerUnit = unitOf.get(partner);
    if (
      partnerUnit === undefined ||
      partnerUnit === sourceUnit ||
      isConnector(partner)
    ) {
      continue;
    }
    const evidence = evidenceFor(sourceUnit, partnerUnit);
    if (!touched.has(partnerUnit)) {
      touched.add(partnerUnit);
      evidence.edges += 1;
    }
    evidence.localized.add(finding.symbolId);
    if (finding.conceptSeed) {
      evidence.concepts.add(finding.symbolId);
    }
    if (sameDirectoryBelowRoot(edge.source, partner)) {
      evidence.directorySymbols.add(finding.symbolId);
    }
  }
}

function analyzeInternalResponsibilitiesUnit(
  units: ResponsibilityUnit[],
  isConnector: (module: string) => boolean,
  rolesOf: Map<string, InternalModuleRole[]>,
  neighborGroups: (
    module: string,
    localizedOnly: boolean
  ) => ResponsibilityCandidate[],
  attachedByGroup: Map<string, string[]>,
  statusOf: Map<string, "assigned" | "attached">,
  membersByGroup: Map<string, string[]>,
  unresolved: ResponsibilityAmbiguity[],
  ambiguityReason: (
    roles: InternalModuleRole[]
  ) => ResponsibilityAmbiguityReason,
  unresolvedModules: Set<string>
) {
  for (const unit of units) {
    if (unit.kind !== "module") {
      continue;
    }
    const module = unit.modules[0] ?? "";
    if (!isConnector(module)) {
      continue;
    }
    const roles = rolesOf.get(module) ?? [];
    const localized = neighborGroups(module, true);
    const candidates =
      localized.length > 0 ? localized : neighborGroups(module, false);
    if (candidates.length === 1) {
      const group = candidates[0]?.region ?? unit.id;
      const list = attachedByGroup.get(group) ?? [];
      list.push(module);
      attachedByGroup.set(group, list);
      statusOf.set(module, "attached");
    } else if (candidates.length === 0) {
      membersByGroup.set(unit.id, [module]);
      statusOf.set(module, "assigned");
    } else {
      unresolved.push({
        candidates,
        module,
        reason: ambiguityReason(roles),
        roles,
      });
      unresolvedModules.add(module);
    }
  }
}

function collectEntries(
  localizedNeighbors: Map<
    string,
    Map<string, { edges: number; symbols: Set<string>; concept: boolean }>
  >,
  module: string,
  regionOfModule: Map<string, string>,
  region: string | undefined,
  affinityTallies: Map<string, ResponsibilityAffinity>
) {
  for (const [partner, entry] of localizedNeighbors.get(module) ?? []) {
    if (entry.symbols.size === 0) {
      continue;
    }
    const partnerRegion = regionOfModule.get(partner);
    if (partnerRegion === undefined || partnerRegion === region) {
      continue;
    }
    const affinity = affinityTallies.get(partnerRegion) ?? {
      edges: 0,
      kinds: [],
      region: partnerRegion,
    };
    affinity.edges += entry.edges;
    if (!affinity.kinds.includes("dependency")) {
      affinity.kinds.push("dependency");
    }
    if (entry.concept && !affinity.kinds.includes("concept")) {
      affinity.kinds.push("concept");
    }
    affinityTallies.set(partnerRegion, affinity);
  }
}

export function getResponsibilityRegion(
  report: InternalResponsibilityReport,
  id: string
): ResponsibilityRegion | undefined {
  return report.regions.find((region) => region.id === id);
}

export function getModuleResponsibility(
  report: InternalResponsibilityReport,
  module: string
): ResponsibilityModuleEvidence | undefined {
  return report.modules.find((entry) => entry.module === module);
}

/** Regions holding a module in the directory or path region. */
export function getRegionsByPath(
  report: InternalResponsibilityReport,
  path: string
): ResponsibilityRegion[] {
  return report.regions.filter(
    (region) =>
      region.path.directories.includes(path) ||
      region.path.pathRegions.includes(path)
  );
}

/** Regions declaring or referencing the concept. */
export function getRegionsByConcept(
  report: InternalResponsibilityReport,
  conceptId: string
): ResponsibilityRegion[] {
  return report.regions.filter(
    (region) =>
      region.concepts.declared.some((entry) => entry.conceptId === conceptId) ||
      region.concepts.referenced.some((entry) => entry.conceptId === conceptId)
  );
}

export function getResponsibilityRelationship(
  report: InternalResponsibilityReport,
  from: string,
  to: string
): ResponsibilityRelationship | undefined {
  return report.relationships.find(
    (relationship) => relationship.from === from && relationship.to === to
  );
}
interface RelationshipDraft {
  edges: InternalModuleEdge[];
  from: string;
  to: string;
}
interface Participation {
  kinds: ConceptRelationshipKind[];
  module: string;
}
interface Draft {
  attached: string[];
  group: string;
  modules: string[];
  units: string[];
}
