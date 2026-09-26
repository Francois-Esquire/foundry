import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import type {
  InternalModuleNode,
  InternalPackageTopology,
} from "./internal-topology-types";
import { count, percent, plural } from "./render/format";

// V13.0 CLI view of an internal package topology. Top facts only; the JSON
// carries the full graph.

function topModules(
  topology: InternalPackageTopology,
  metric: (module: InternalModuleNode) => number,
  limit: number
): InternalModuleNode[] {
  return topology.modules
    .filter((module) => module.primary && metric(module) > 0)
    .sort((a, b) => metric(b) - metric(a) || a.id.localeCompare(b.id))
    .slice(0, limit);
}

export function renderInternalTopology(
  topology: InternalPackageTopology,
  config: AnalysisConfig = ANALYSIS_CONFIG
): string {
  const { summary, policy } = topology;
  const limits = config.internalTopology.report;
  const lines: string[] = [];
  lines.push("INTERNAL TOPOLOGY");
  lines.push("═".repeat(17));
  lines.push(`Package  ${topology.package.id}`);
  lines.push(
    `Primary  source-kind modules and the edges between them; ${plural(summary.modules - summary.primaryModules, "test/story/config module")} kept as context`
  );
  lines.push("");
  lines.push(
    `Modules          ${count(summary.primaryModules)} primary · ${count(summary.modules)} total`
  );
  lines.push(
    `Internal edges   ${count(summary.primaryEdges)} primary · ${count(summary.edges)} total${summary.selfImports > 0 ? ` · ${plural(summary.selfImports, "self-import")}` : ""}`
  );
  lines.push(
    `Directories      ${count(summary.directories)} · ${plural(summary.regions, "path region")}`
  );
  lines.push(`Layers           ${count(summary.layers)} (${policy.layer})`);
  lines.push(
    `Cycles           ${count(summary.cycles)} · ${plural(summary.cycleMembers, "member")} · largest ${count(summary.largestCycle)} · cross-region ${count(summary.crossRegionCycles)}`
  );
  lines.push(`Seams            ${count(summary.seams)} region pairs`);
  lines.push(
    `Connectivity     ${plural(summary.weakComponents, "weak component")} · ${count(summary.isolated)} isolated · ${count(summary.dependencySources)} sources · ${count(summary.dependencySinks)} sinks · ${plural(summary.bridges, "bridge")} (${policy.structuralConnectivity})`
  );
  lines.push(
    `Roles            ${count(summary.aggregators)} aggregators · ${count(summary.highFanIn)} high-fan-in (≥${count(summary.highFanCutoff.fanIn)}) · ${count(summary.highFanOut)} high-fan-out (≥${count(summary.highFanCutoff.fanOut)}) · ${count(summary.satellites)} satellites`
  );
  const dist = summary.distributions;
  lines.push(
    `Fan-in           min ${dist.fanIn.min} · median ${dist.fanIn.median} · p90 ${dist.fanIn.p90} · max ${dist.fanIn.max}`
  );
  lines.push(
    `Fan-out          min ${dist.fanOut.min} · median ${dist.fanOut.median} · p90 ${dist.fanOut.p90} · max ${dist.fanOut.max}`
  );

  const rolesOf = new Map(
    topology.roles.map((assignment) => [assignment.module, assignment.roles])
  );
  const moduleLine = (module: InternalModuleNode) =>
    `    fan-in ${module.fanIn} · fan-out ${module.fanOut} · ${plural(module.providedSymbols, "provided symbol")} · layer ${module.layer ?? 0}${module.cycle === undefined ? "" : ` · ${module.cycle}`}${(rolesOf.get(module.id) ?? []).length > 0 ? ` · ${(rolesOf.get(module.id) ?? []).join(", ")}` : ""}`;

  const sections: [string, (module: InternalModuleNode) => number][] = [
    ["HIGH FAN-IN", (module) => module.fanIn],
    ["HIGH FAN-OUT", (module) => module.fanOut],
  ];
  for (const [title, metric] of sections) {
    const top = topModules(topology, metric, limits.topModules);
    if (top.length === 0) {
      continue;
    }
    lines.push("");
    lines.push(title);
    for (const module of top) {
      lines.push(`  ${module.id}`);
      lines.push(moduleLine(module));
    }
  }

  const aggregators = topology.modules.filter(
    (module) =>
      module.primary && (rolesOf.get(module.id) ?? []).includes("aggregator")
  );
  if (aggregators.length > 0) {
    lines.push("");
    lines.push("AGGREGATORS");
    for (const module of aggregators.slice(0, limits.topModules)) {
      lines.push(
        `  ${module.id}${module.syntacticRole.entrypoint ? " (entrypoint)" : ""}`
      );
      lines.push(
        `    ${plural(module.syntacticRole.reExports, "re-export")} · ${plural(module.syntacticRole.ownDeclarations, "own declaration")} · fan-in ${module.fanIn} · fan-out ${module.fanOut}`
      );
    }
  }

  const bridges = topology.modules.filter(
    (module) =>
      module.primary && (rolesOf.get(module.id) ?? []).includes("bridge")
  );
  if (bridges.length > 0) {
    lines.push("");
    lines.push("STRUCTURAL BRIDGES (undirected projection)");
    for (const module of bridges.slice(0, limits.topModules)) {
      lines.push(`  ${module.id}`);
      lines.push(moduleLine(module));
    }
  }

  if (topology.cycles.length > 0) {
    lines.push("");
    lines.push("CYCLES");
    for (const cycle of topology.cycles.slice(0, limits.topCycles)) {
      lines.push(
        `  ${cycle.id} · ${plural(cycle.modules.length, "module")} · ${plural(cycle.internalEdges, "internal edge")} · ${cycle.scope} · entry ${cycle.entryEdges} · exit ${cycle.exitEdges}`
      );
      lines.push(`    ${cycle.modules.join(" · ")}`);
      if (cycle.topSymbols.length > 0) {
        lines.push(
          `    symbols: ${cycle.topSymbols.map((symbol) => symbol.name).join(", ")}`
        );
      }
    }
  }

  if (topology.seams.length > 0) {
    lines.push("");
    lines.push("INTERNAL SEAMS (path region → path region)");
    for (const seam of topology.seams.slice(0, limits.topSeams)) {
      lines.push(
        `  ${seam.from} → ${seam.to} · ${plural(seam.moduleEdges, "module edge")} · ${plural(seam.importSites, "import site")} · ${plural(seam.symbolFlow, "symbol")}`
      );
      lines.push(
        `    ${seam.sourceModules.length}/${percent(seam.sourceParticipation)} of source modules · ${seam.targetModules.length}/${percent(seam.targetParticipation)} of target modules · aggregator targets ${percent(seam.aggregatorTargetShare)}`
      );
      lines.push(
        `    top source ${seam.topSource.module} (${percent(seam.topSource.share)}) · top target ${seam.topTarget.module} (${percent(seam.topTarget.share)})${seam.topSymbol === undefined ? "" : ` · top symbol ${seam.topSymbol.name} (${percent(seam.topSymbol.share)})`}`
      );
    }
  }

  const distributed = topology.consumedSurface.slice(0, limits.topSymbols);
  if (distributed.length > 0) {
    lines.push("");
    lines.push("MOST DISTRIBUTED INTERNAL SYMBOLS");
    for (const symbol of distributed) {
      lines.push(
        `  ${symbol.name} (${symbol.declarationModule}) · ${plural(symbol.consumerModules, "consumer module")} · ${plural(symbol.consumerRegions.length, "region")} · ${plural(symbol.importSites, "import site")}`
      );
    }
  }

  return lines.join("\n");
}
