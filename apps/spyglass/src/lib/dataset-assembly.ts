import { basename } from "#path";
import type { DatasetTransport } from "./dataset";
import {
  DATASET_FILES,
  internalsFile,
  moduleEdgeShardFile,
  moduleShardFile,
  packageProjectionFile,
  packageReportFile,
} from "./dataset-layout";
import { datasetManifest } from "./dataset-manifest";
import type { DependencyInventory } from "./dependency-inventory-types";
import { enrichDependencyUsage } from "./dependency-usage";
import type { LensSettings } from "./lenses/lens-types";
import { writeLenses } from "./lenses/run";
import { computeModuleDataset } from "./module-dataset";
import type { PackageLocalReport } from "./package-local-types";
import type {
  DatasetManifest,
  DeclaredDiscovery,
  SemanticsConceptIndex,
  SemanticsGenerationInputs,
  SemanticsGenerationMode,
  SemanticsManifestPackage,
  SemanticsModuleEdge,
  SemanticsModuleEdgeShard,
  SemanticsModuleRecord,
  SemanticsPhase,
  SemanticsPhaseTiming,
  SemanticsWorkspaceUnit,
} from "./semantics-types";
import { DATASET_SCHEMA_VERSION } from "./semantics-types";
import type { SurfaceReport } from "./types";
import type { PreparedVisualization } from "./visualization/types";
import { writeVisualization } from "./visualization/write";
import { ingestWorkspaceReports } from "./workspace-ingest";
import { analyzeWorkspace } from "./workspace-intelligence";
import {
  createWorkspaceProjectionContext,
  listWorkspacePatterns,
  projectWorkspaceOverview,
  projectWorkspacePackage,
  workspaceProjectionManifest,
} from "./workspace-projection";
import {
  listConceptDirections,
  projectWorkspaceGraph,
  projectWorkspaceMatrix,
} from "./workspace-projection-views";
import type { WorkspaceReport } from "./workspace-types";

export interface DatasetAssemblyOutcome {
  error?: string;
  local?: PackageLocalReport;

  report?: SurfaceReport;
  unit: SemanticsWorkspaceUnit;
}

export interface DatasetArtifactSink {
  readonly files: readonly { reused: boolean }[];

  read: DatasetTransport;
  write(file: string, value: unknown): void;
}

type DatasetAssemblyPhase = <T>(
  name: SemanticsPhase,
  run: () => Promise<T> | T
) => Promise<T>;

export interface DatasetAssemblyInput {
  command: string;
  concurrency: number;

  derived: boolean;
  discovery: DeclaredDiscovery;

  inputs?: SemanticsGenerationInputs;

  internals?: (
    outcomes: readonly DatasetAssemblyOutcome[],
    write: (id: string, internals: unknown) => void
  ) => void;

  inventory: () => DependencyInventory;
  mode: SemanticsGenerationMode;

  now?: () => Date;

  outcomes: readonly DatasetAssemblyOutcome[];
  packagesAnalyzed: number;
  packagesReused: number;
  phase: DatasetAssemblyPhase;

  phases: SemanticsPhaseTiming[];

  previousVisualization?: () => Promise<PreparedVisualization | undefined>;

  root: string;
  settings: LensSettings;
  startedAt: Date;
  workspaceName: string | undefined;
}

export interface DatasetAssembly {
  concepts: SemanticsConceptIndex;

  manifest: DatasetManifest;
  modules: readonly SemanticsModuleRecord[];
  packages: SemanticsManifestPackage[];
  workspace: WorkspaceReport;
}

export async function assembleDataset(
  input: DatasetAssemblyInput,
  sink: DatasetArtifactSink
): Promise<DatasetAssembly> {
  const { outcomes, phase } = input;
  const clock = input.now ?? (() => new Date());
  const reports = outcomes.flatMap((o) =>
    o.report === undefined ? [] : [o.report]
  );
  const ingested = await phase("ingest", () =>
    ingestWorkspaceReports(reports, {
      root: input.workspaceName ?? basename(input.root),
    })
  );
  const workspace = await phase("intelligence", () =>
    analyzeWorkspace(ingested)
  );
  const context = createWorkspaceProjectionContext(workspace);

  const modules = buildModuleRecords(workspace, reports);
  const concepts = buildConceptIndex(workspace);
  const edgeShards = buildModuleEdgeShards(workspace, reports);

  await phase("project", () => {
    sink.write(
      DATASET_FILES.projections.manifest,
      workspaceProjectionManifest(context)
    );
    sink.write(
      DATASET_FILES.projections.overview,
      projectWorkspaceOverview(context)
    );
    sink.write(
      DATASET_FILES.projections.packageRoles,
      projectWorkspaceMatrix(context, { kind: "package-concept-roles" })
    );
    sink.write(
      DATASET_FILES.projections.directions,
      listConceptDirections(context)
    );
    sink.write(
      DATASET_FILES.projections.boundaries,
      projectWorkspaceMatrix(context, {
        kind: "boundary-concept-load",
        metric: "concepts",
      })
    );
    sink.write(
      DATASET_FILES.projections.dependencyGraph,
      projectWorkspaceGraph(context, "dependency-topology")
    );
    sink.write(
      DATASET_FILES.projections.implementationFlow,
      projectWorkspaceGraph(context, "implementation-flow")
    );
    sink.write(
      DATASET_FILES.projections.behaviorFlow,
      projectWorkspaceGraph(context, "behavior-flow")
    );
    sink.write(
      DATASET_FILES.projections.patterns,
      listWorkspacePatterns(context)
    );
    for (const { unit } of outcomes) {
      const projection = projectWorkspacePackage(context, unit.id);
      if (projection !== undefined) {
        sink.write(packageProjectionFile(unit.id), projection);
      }
    }
  });
  const byPackage = new Map<string, SemanticsModuleRecord[]>();
  for (const module of modules) {
    (
      byPackage.get(module.package) ??
      byPackage.set(module.package, []).get(module.package)
    )?.push(module);
  }

  const { internals } = input;
  await phase("write", () => {
    sink.write(
      DATASET_FILES.dependencyInventory,
      enrichDependencyUsage(
        input.inventory(),
        new Map(
          outcomes.flatMap((outcome) =>
            outcome.local === undefined
              ? []
              : [[outcome.unit.id, outcome.local]]
          )
        )
      )
    );
    sink.write(DATASET_FILES.workspace, workspace);
    sink.write(DATASET_FILES.conceptIndex, concepts);
    for (const shard of edgeShards) {
      sink.write(moduleEdgeShardFile(shard.package), shard);
    }
    const moduleDataset = computeModuleDataset(byPackage, edgeShards);
    for (const shard of moduleDataset.shards) {
      sink.write(moduleShardFile(shard.package), shard);
    }
    sink.write(DATASET_FILES.moduleIndex, moduleDataset.index);
    internals?.(outcomes, (id, value) => sink.write(internalsFile(id), value));
  });

  const workspacePackages = new Set(
    workspace.packages.packages.map((p) => p.id)
  );
  const packages: SemanticsManifestPackage[] = outcomes
    .map((outcome): SemanticsManifestPackage => {
      const { unit } = outcome;
      const count = byPackage.get(unit.id)?.length ?? 0;
      return {
        declaredDependencies: unit.declaredDependencies,
        id: unit.id,
        ...(internals !== undefined &&
          outcome.report !== undefined && {
            internals: internalsFile(unit.id),
          }),
        path: unit.path,
        status: outcome.report === undefined ? "failed" : "complete",
        ...(outcome.report !== undefined && {
          report: packageReportFile(unit.id),
        }),
        ...(workspacePackages.has(unit.id) && {
          projection: packageProjectionFile(unit.id),
        }),
        modules: {
          count,
          ...(count > 0 && { shard: moduleShardFile(unit.id) }),
        },
        ...(outcome.error !== undefined && { error: outcome.error }),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));

  const failures = packages.filter((p) => p.status === "failed").length;
  const partial = failures > 0 || !workspace.ingestion.coverage.complete;

  const manifestAt = (finishedAt: Date): DatasetManifest =>
    datasetManifest({
      command: input.command,
      concepts,
      concurrency: input.concurrency,
      context,
      derived: input.derived,
      discovery: input.discovery,
      files: sink.files,
      finishedAt,
      ...(input.inputs !== undefined && { inputs: input.inputs }),
      mode: input.mode,
      modules,
      packages,
      packagesAnalyzed: input.packagesAnalyzed,
      packagesReused: input.packagesReused,
      partial,
      phases: input.phases,
      root: input.root,
      startedAt: input.startedAt,
      workspaceName: input.workspaceName,
    });
  await phase("lenses", () =>
    writeLenses({
      draft: manifestAt(clock()),
      read: sink.read,
      settings: input.settings,
      write: (file, value) => sink.write(file, value),
    })
  );
  await phase("visualization", () =>
    writeVisualization({
      draft: manifestAt(clock()),
      ...(input.previousVisualization !== undefined && {
        previous: input.previousVisualization(),
      }),
      read: sink.read,
      write: (file, value) => sink.write(file, value),
    })
  );
  const manifest = manifestAt(clock());
  sink.write(DATASET_FILES.manifest, manifest);
  return { concepts, manifest, modules, packages, workspace };
}

export type ConceptRole = keyof SemanticsModuleRecord["concepts"];

export function moduleConceptRoles(
  reports: SurfaceReport[]
): Map<string, Record<ConceptRole, Set<string>>> {
  const roles = new Map<string, Record<ConceptRole, Set<string>>>();
  const add = (file: string, role: ConceptRole, concept: string): void => {
    let entry = roles.get(file);
    if (entry === undefined) {
      entry = {
        behavior: new Set(),
        conversion: new Set(),
        declared: new Set(),
        implementation: new Set(),
        representation: new Set(),
        usage: new Set(),
      };
      roles.set(file, entry);
    }
    entry[role].add(concept);
  };
  for (const report of reports) {
    moduleConceptRolesFamily(report, add);
    for (const locality of report.conceptBehavioralLocality.concepts) {
      for (const module of locality.behavior.byModule) {
        add(module.module, "behavior", locality.concept.id);
      }
    }
    for (const candidate of report.conceptOverlap.candidates) {
      for (const conversion of candidate.conversions) {
        add(conversion.file, "conversion", candidate.left.id);
        add(conversion.file, "conversion", candidate.right.id);
      }
    }
  }
  return roles;
}

function moduleConceptRolesFamily(
  report: SurfaceReport,
  add: (file: string, role: ConceptRole, concept: string) => void
) {
  for (const family of report.conceptInventory.families) {
    const { id } = family.seed;
    add(family.seed.declaration.file, "declared", id);
    for (const rep of family.representations) {
      add(
        rep.file,
        rep.relationship === "implementation"
          ? "implementation"
          : "representation",
        id
      );
    }
    for (const evidence of family.evidence) {
      if (
        evidence.kind !== "declaration" &&
        evidence.kind !== "implements" &&
        evidence.kind !== "extends" &&
        evidence.kind !== "alias"
      ) {
        add(evidence.file, "usage", id);
      }
    }
  }
}

function sortedList(values: Set<string> | undefined): string[] {
  return values === undefined ? [] : [...values].sort();
}

function buildModuleRecords(
  workspace: WorkspaceReport,
  reports: SurfaceReport[]
): SemanticsModuleRecord[] {
  const graph = workspace.intelligence?.graph;
  const analysis = new Map(
    (graph?.modules ?? []).map((module) => [module.module, module])
  );
  const roles = moduleConceptRoles(reports);
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const edge of workspace.graph.moduleEdges) {
    (
      outgoing.get(edge.from) ?? outgoing.set(edge.from, []).get(edge.from)
    )?.push(edge.to);
    (incoming.get(edge.to) ?? incoming.set(edge.to, []).get(edge.to))?.push(
      edge.from
    );
  }
  const churn = new Map(workspace.evolution.churn.map((c) => [c.file, c]));
  const hotspots = new Map(
    workspace.evolution.hotspots.map((h) => [h.file, h])
  );
  const couplings = new Map<string, string[]>();
  for (const pair of workspace.evolution.couplings) {
    for (const file of [pair.left, pair.right]) {
      (couplings.get(file) ?? couplings.set(file, []).get(file))?.push(pair.id);
    }
  }
  const analyzed = new Set(
    workspace.packages.packages.filter((p) => p.analyzed).map((p) => p.id)
  );
  return workspace.graph.modules
    .flatMap((module) =>
      module.package === undefined
        ? []
        : [{ ...module, package: module.package }]
    )
    .map((module): SemanticsModuleRecord => {
      const pkg = module.package;
      const facts = analysis.get(module.id);
      const conceptRoles = roles.get(module.id);
      const fileChurn = churn.get(module.id);
      const hotspot = hotspots.get(module.id);
      const cautions: string[] = [];
      if (!analyzed.has(pkg)) {
        cautions.push("package-not-analyzed");
      }
      if (module.gravity === undefined) {
        cautions.push("gravity-unobserved");
      }
      if (fileChurn === undefined) {
        cautions.push("evolution-unavailable");
      }
      return {
        id: module.id,
        package: pkg,
        path: module.id,
        ...(module.role !== undefined && { role: module.role.kind }),
        ...(module.fileKind !== undefined && { fileKind: module.fileKind }),
        ...(module.gravity !== undefined && { gravity: module.gravity }),
        ...(facts !== undefined && {
          graph: {
            cycle: facts.cycle,
            fanIn: facts.direct.fanIn,
            fanOut: facts.direct.fanOut,
            layer: facts.layer,
          },
        }),
        concepts: {
          behavior: sortedList(conceptRoles?.behavior),
          conversion: sortedList(conceptRoles?.conversion),
          declared: sortedList(conceptRoles?.declared),
          implementation: sortedList(conceptRoles?.implementation),
          representation: sortedList(conceptRoles?.representation),
          usage: sortedList(conceptRoles?.usage),
        },
        dependencies: {
          incoming: [...(incoming.get(module.id) ?? [])].sort(),
          outgoing: [...(outgoing.get(module.id) ?? [])].sort(),
        },
        ...(fileChurn !== undefined && {
          evolution: {
            authors: fileChurn.authors,
            commits: fileChurn.commits,
            linesChanged: fileChurn.linesChanged,
            ...(fileChurn.lastChangedAt !== undefined && {
              lastChangedAt: fileChurn.lastChangedAt,
            }),
            couplings: [...(couplings.get(module.id) ?? [])].sort(),
            hotspot: hotspot !== undefined,
            hotspotSignals: hotspot === undefined ? [] : [...hotspot.signals],
          },
        }),
        cautions,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function buildConceptIndex(workspace: WorkspaceReport): SemanticsConceptIndex {
  const placements = workspace.intelligence?.concepts?.concepts ?? [];
  return {
    concepts: placements
      .map((placement) => ({
        centers: {
          ...(placement.centers?.semantic !== undefined && {
            semantic: placement.centers.semantic,
          }),
          ...(placement.centers?.representation !== undefined && {
            representation: placement.centers.representation,
          }),
          ...(placement.centers?.usage !== undefined && {
            usage: placement.centers.usage,
          }),
          ...(placement.centers?.behavior !== undefined && {
            behavior: placement.centers.behavior,
          }),
        },
        coverage: placement.coverage,
        file: placement.concept.file,
        id: placement.concept.id,
        kind: placement.concept.kind,
        name: placement.concept.name,
        package: placement.concept.package,
        packages: placement.presence.packages,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    schemaVersion: DATASET_SCHEMA_VERSION,
  };
}

function buildModuleEdgeShards(
  workspace: WorkspaceReport,
  reports: SurfaceReport[]
): SemanticsModuleEdgeShard[] {
  const byPackage = new Map<string, SemanticsModuleEdge[]>();
  const push = (pkg: string, edge: SemanticsModuleEdge): void => {
    (byPackage.get(pkg) ?? byPackage.set(pkg, []).get(pkg))?.push(edge);
  };
  for (const report of reports) {
    const pkg = report.target.name ?? report.target.path;
    for (const edge of report.dependencyGravity.internalEdges) {
      push(pkg, {
        id: `${edge.fromFile}→${edge.toFile}`,
        relation: "dependency",
        scope: "intra-package",
        source: edge.fromFile,
        target: edge.toFile,
        ...(edge.typeOnly !== undefined && { typeOnly: edge.typeOnly }),
      });
    }
  }
  for (const edge of workspace.graph.moduleEdges) {
    push(edge.fromPackage, {
      id: edge.id,
      relation: "dependency",
      scope: "cross-package",
      source: edge.from,
      target: edge.to,
      ...(edge.typeOnly !== undefined && { typeOnly: edge.typeOnly }),
    });
  }
  return [...byPackage.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pkg, edges]) => ({
      edges: edges.sort((a, b) => a.id.localeCompare(b.id)),
      package: pkg,
    }));
}
