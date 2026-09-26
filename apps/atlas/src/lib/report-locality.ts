import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import { count, percent, plural } from "./render/format";
import type {
  SymbolLocalityFinding,
  SymbolLocalityReport,
} from "./symbol-locality-types";

// V13.1 CLI view of symbol locality. Top facts per placement shape; the JSON
// carries every finding.

const byBreadth = (a: SymbolLocalityFinding, b: SymbolLocalityFinding) =>
  b.consumers.modules - a.consumers.modules ||
  b.consumers.regions - a.consumers.regions ||
  a.symbolId.localeCompare(b.symbolId);

export function renderSymbolLocality(
  report: SymbolLocalityReport,
  config: AnalysisConfig = ANALYSIS_CONFIG
): string {
  const { summary, policy } = report;
  const limit = config.internalLocality.report.topSymbols;
  const lines: string[] = [];
  lines.push("SYMBOL LOCALITY");
  lines.push("═".repeat(15));
  lines.push(`Package  ${report.package.id}`);
  lines.push(
    `Shares   over consumer modules · dominant ≥ ${percent(policy.dominantShareThreshold)} · significant ≥ ${percent(policy.significantShareThreshold)} · unclear below ${count(policy.minimumConsumers)} consumers`
  );
  lines.push("");
  const d = summary.byDistribution;
  const p = summary.byPlacement;
  lines.push(`Consumed symbols         ${count(summary.symbols)}`);
  lines.push(
    `Distribution             ${count(d["module-localized"])} module · ${count(d["directory-localized"])} directory · ${count(d["region-localized"])} region · ${count(d["multi-region"])} multi-region · ${count(d["package-distributed"])} package-distributed`
  );
  lines.push(
    `Placement                ${count(p.aligned)} aligned · ${count(p["broader-than-consumers"])} broader · ${count(p["narrower-than-consumers"])} narrower · ${count(p["cross-region"])} cross-region · ${count(p["cross-directory"])} cross-directory · ${count(p.split)} split · ${count(p.distributed)} distributed · ${count(p.unclear)} unclear`
  );
  lines.push(
    `Usage                    ${count(summary.byUsage.value)} value · ${count(summary.byUsage.type)} type · ${count(summary.byUsage.both)} both · ${count(summary.conceptSeeds)} concept seeds · ${count(summary.packagePublic)} package-public`
  );
  lines.push(
    `Behavior                 ${count(summary.byDeclarationShape.behavior)} behavior · ${count(summary.byDeclarationShape.contract)} contract · ${count(summary.byDeclarationShape.value)} value · ${count(summary.behaviorDisagreesWithUsage)} where the behavior-heaviest region differs from the module-heaviest`
  );
  lines.push(
    `Seams                    ${plural(summary.crossSeamSymbols, "symbol")} consumed across a region seam`
  );
  const dist = summary.distributions;
  lines.push(
    `Consumer modules         median ${dist.consumerModules.median} · p90 ${dist.consumerModules.p90} · max ${dist.consumerModules.max}`
  );
  lines.push(
    `Consumer regions         median ${dist.consumerRegions.median} · p90 ${dist.consumerRegions.p90} · max ${dist.consumerRegions.max}`
  );
  lines.push(
    `Top-region share         median ${dist.topRegionShare.median}% · p90 ${dist.topRegionShare.p90}% · max ${dist.topRegionShare.max}%`
  );
  const gaps: string[] = [];
  if (summary.unresolvedDefaultImportSites > 0) {
    gaps.push(
      plural(
        summary.unresolvedDefaultImportSites,
        "unresolved default import site"
      )
    );
  }
  if (summary.anonymousDefaultExports > 0) {
    gaps.push(
      plural(summary.anonymousDefaultExports, "anonymous default export")
    );
  }
  if (summary.bareNamespaceSites > 0) {
    gaps.push(plural(summary.bareNamespaceSites, "bare namespace site"));
  }
  if (gaps.length > 0) {
    lines.push(`Identity gaps            ${gaps.join(" · ")}`);
  }

  const line = (finding: SymbolLocalityFinding) => {
    const region = finding.dominantRegion ?? finding.topRegion;
    return [
      `  ${finding.name} (${finding.declaration.module})`,
      `    ${plural(finding.consumers.modules, "consumer module")} · ${plural(finding.consumers.regions, "region")} · top region ${region.id} ${percent(region.share)} · scope ${finding.commonScope.id} · ${finding.distribution}${finding.seams.crossed.length > 0 ? ` · ${plural(finding.seams.crossed.length, "seam")}` : ""}${finding.behavior.agreesWithUsage === false ? ` · behavior leans ${finding.behavior.dominantBehaviorRegion?.id ?? ""}` : ""}`,
    ];
  };
  const section = (
    title: string,
    findings: SymbolLocalityFinding[],
    order: (a: SymbolLocalityFinding, b: SymbolLocalityFinding) => number
  ) => {
    if (findings.length === 0) {
      return;
    }
    lines.push("");
    lines.push(`${title} (${count(findings.length)})`);
    for (const finding of [...findings].sort(order).slice(0, limit)) {
      lines.push(...line(finding));
    }
  };
  const placed = (placement: SymbolLocalityFinding["placement"]) =>
    report.symbols.filter((finding) => finding.placement === placement);

  section(
    "NARROW CONSUMER SCOPE · declared above its consumers",
    placed("broader-than-consumers"),
    byBreadth
  );
  section(
    "CROSS-REGION DECLARATIONS · dominant consumer region elsewhere",
    placed("cross-region"),
    byBreadth
  );
  section(
    "BROAD CONSUMER SCOPE · declared inside one consumer branch",
    placed("narrower-than-consumers"),
    byBreadth
  );
  section(
    "SPLIT LOCALITY · two significant regions, none dominant",
    placed("split"),
    byBreadth
  );
  section("DISTRIBUTED SYMBOLS", placed("distributed"), byBreadth);
  section(
    "LARGEST SEAM CROSSERS",
    report.symbols.filter((finding) => finding.seams.crossed.length > 0),
    (a, b) =>
      b.seams.crossed.length - a.seams.crossed.length ||
      b.seams.crossRegionConsumers - a.seams.crossRegionConsumers ||
      a.symbolId.localeCompare(b.symbolId)
  );
  return lines.join("\n");
}
