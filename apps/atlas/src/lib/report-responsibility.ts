import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import type {
  InternalResponsibilityReport,
  ResponsibilityRegion,
} from "./internal-responsibility-types";
import { count, percent, plural } from "./render/format";

const shortIdPattern = /^responsibility:/;

// V13.2 CLI view of internal responsibility regions. Counts, the largest
// regions, where paths and responsibilities disagree, the strongest
// relationships, and what stayed unresolved; the JSON carries every region.

const EVIDENCE_KINDS: ResponsibilityRegion["evidence"] = [
  "path",
  "dependency",
  "cycle",
  "concept",
  "behavior",
  "symbol-flow",
  "seam",
];

function shortId(id: string): string {
  return id.replace(shortIdPattern, "");
}

export function renderInternalResponsibilities(
  report: InternalResponsibilityReport,
  config: AnalysisConfig = ANALYSIS_CONFIG
): string {
  const { summary, policy } = report;
  const limits = config.internalResponsibilities.report;
  const labelOf = new Map(
    report.regions.map((region) => [region.id, region.label])
  );
  const name = (id: string) => `${labelOf.get(id) ?? id} [${shortId(id)}]`;
  const lines: string[] = [];
  lines.push("INTERNAL RESPONSIBILITIES");
  lines.push("═".repeat(25));
  lines.push(`Package  ${report.package.id}`);
  lines.push(
    `Joins    concept flow · directory dependency · directory fallback · localized below ${count(policy.localizedSymbolCutoff)} consumers · connectors: ${policy.connectorRoles.join(", ")}`
  );
  lines.push("");
  lines.push(
    `Primary modules          ${count(summary.primaryModules)} · ${plural(summary.units, "unit")} (${count(summary.cycleUnits)} cycles) · ${plural(summary.connectors, "connector")}`
  );
  lines.push(
    `Responsibility regions   ${count(summary.regions)} · ${count(summary.multiModuleRegions)} multi-module · ${count(summary.singleModuleRegions)} single-module · largest ${count(summary.largestRegion)}`
  );
  lines.push(
    `Modules                  ${count(summary.assignedModules)} assigned · ${count(summary.attachedModules)} attached · ${count(summary.unresolvedModules)} unresolved`
  );
  const j = summary.joinsByReason;
  lines.push(
    `Joins                    ${count(j["concept-flow"])} concept flow · ${count(j["directory-dependency"])} directory dependency · ${count(j["directory-fallback"])} directory fallback`
  );
  const a = summary.byPathAgreement;
  lines.push(
    `Path agreement           ${count(a["matches-path-region"])} match one path region · ${count(a["within-path-region"])} sit inside one · ${count(a["spans-path-regions"])} span several · ${plural(summary.pathRegionsSplit, "path region")} split`
  );
  lines.push(
    `Concepts                 ${count(summary.regionsWithDeclaredConcepts)} regions with declared concepts · ${count(summary.regionsWithSeveralConcepts)} with several · ${count(summary.regionsWithoutConcepts)} without`
  );
  lines.push(
    `Behavior                 ${count(summary.behaviorBearingRegions)} bearing · ${count(summary.behaviorLightRegions)} light · top region holds ${percent(summary.behaviorMass.topRegionShare)} of ${plural(summary.behaviorMass.total, "statement")}`
  );
  lines.push(
    `Relationships            ${count(summary.relationships)} · ${plural(summary.regionCycles, "cycle")} among regions · ${count(summary.relationshipsHiddenInPathRegions)} hidden inside one path region · ${plural(summary.pathSeamsCollapsed, "path seam")} collapsed inside one region`
  );
  const s = summary.symbols;
  lines.push(
    `Symbols                  ${count(s["responsibility-local"])} responsibility-local · ${count(s["responsibility-crossing"])} crossing · ${count(s.unplaced)} unplaced`
  );

  const regionLine = (region: ResponsibilityRegion) => {
    const missing = EVIDENCE_KINDS.filter(
      (kind) => !region.evidence.includes(kind)
    );
    const concepts = region.concepts.declared
      .slice(0, 3)
      .map((entry) => entry.name);
    return [
      `  ${region.label} [${shortId(region.id)}]`,
      `    ${plural(region.modules.length, "module")} · ${count(region.path.directories.length)} ${region.path.directories.length === 1 ? "directory" : "directories"} · ${region.path.pathRegions.join(", ")} · ${region.path.agreement}${region.attached.length > 0 ? ` · ${count(region.attached.length)} attached` : ""}`,
      `    ${count(region.topology.internalEdges)} internal · ${count(region.topology.inboundEdges)} in · ${count(region.topology.outboundEdges)} out · ${plural(region.behavior.mass, "statement")} · ${count(region.symbols.local)} local / ${count(region.symbols.crossing)} crossing symbols${concepts.length > 0 ? ` · concepts ${concepts.join(", ")}` : ""}`,
      `    evidence ${region.evidence.join(", ")}${missing.length > 0 ? ` · missing ${missing.join(", ")}` : ""}`,
    ];
  };
  const section = (title: string, regions: ResponsibilityRegion[]) => {
    if (regions.length === 0) {
      return;
    }
    lines.push("");
    lines.push(`${title} (${count(regions.length)})`);
    for (const region of regions.slice(0, limits.topRegions)) {
      lines.push(...regionLine(region));
    }
  };

  section("LARGEST RESPONSIBILITIES", report.regions);
  section(
    "RESPONSIBILITIES SPANNING PATH REGIONS",
    report.regions.filter((r) => r.path.agreement === "spans-path-regions")
  );
  const splitPathRegions = new Map<string, ResponsibilityRegion[]>();
  for (const region of report.regions) {
    if (region.path.pathRegions.length !== 1) {
      continue;
    }
    const pathRegion = region.path.pathRegions[0] ?? "";
    const list = splitPathRegions.get(pathRegion) ?? [];
    list.push(region);
    splitPathRegions.set(pathRegion, list);
  }
  const split = [...splitPathRegions.entries()]
    .filter(([, regions]) => regions.length > 1)
    .sort(
      (leftEntry, b) =>
        b[1].length - leftEntry[1].length || leftEntry[0].localeCompare(b[0])
    );
  if (split.length > 0) {
    lines.push("");
    lines.push(
      `PATH REGIONS HOLDING SEVERAL RESPONSIBILITIES (${count(split.length)})`
    );
    for (const [pathRegion, regions] of split.slice(0, limits.topRegions)) {
      const multi = regions.filter((r) => r.modules.length > 1);
      lines.push(
        `  ${pathRegion}: ${count(regions.length)} responsibilities · ${count(multi.length)} multi-module · ${regions
          .slice(0, 4)
          .map((r) => `${r.label} (${count(r.modules.length)})`)
          .join(", ")}${regions.length > 4 ? ", …" : ""}`
      );
    }
  }

  if (report.relationships.length > 0) {
    lines.push("");
    lines.push(
      `STRONGEST RELATIONSHIPS (${count(report.relationships.length)})`
    );
    for (const relationship of report.relationships.slice(
      0,
      limits.topRelationships
    )) {
      lines.push(`  ${name(relationship.from)} → ${name(relationship.to)}`);
      lines.push(
        `    ${plural(relationship.moduleEdges, "module edge")} · ${plural(relationship.symbolFlow, "symbol")} · ${count(relationship.pathRegions.within)} inside one path region · top ${relationship.dominantSymbols.map((symbol) => symbol.name).join(", ")}`
      );
    }
  }

  if (report.unresolved.length > 0) {
    lines.push("");
    lines.push(`UNRESOLVED MODULES (${count(report.unresolved.length)})`);
    const u = summary.unresolvedByReason;
    lines.push(
      `  ${count(u.aggregator)} aggregator · ${count(u["distributed-primitive"])} distributed primitive · ${count(u["wide-dependent"])} wide dependent · ${count(u.bridge)} bridge`
    );
    const ranked = [...report.unresolved].sort(
      (leftEntry2, b) =>
        b.candidates.length - leftEntry2.candidates.length ||
        leftEntry2.module.localeCompare(b.module)
    );
    for (const ambiguity of ranked.slice(0, limits.topRegions)) {
      lines.push(
        `  ${ambiguity.module} · ${ambiguity.reason} · ${plural(ambiguity.candidates.length, "candidate region")} · top ${ambiguity.candidates
          .slice(0, 3)
          .map((candidate) => labelOf.get(candidate.region) ?? candidate.region)
          .join(", ")}`
      );
    }
  }
  return lines.join("\n");
}
