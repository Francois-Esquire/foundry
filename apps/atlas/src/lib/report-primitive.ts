import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import type {
  ArchitecturalRoleFinding,
  ArchitecturalScopeClass,
  PrimitiveConventionReport,
  PrimitiveModuleFinding,
} from "./primitive-convention-types";
import { count, percent, plural } from "./render/format";

// V13.3 CLI view of primitive and convention intelligence. Distributions,
// the role × scope matrix, package-wide primitives, mixed-scope modules,
// hubs, the strongest conventions, and a symbol-by-symbol microscope on the
// modules that most need one; the JSON carries every finding.

const SCOPE_COLUMNS: { scope: ArchitecturalScopeClass; label: string }[] = [
  { label: "mod-local", scope: "module-local" },
  { label: "resp-local", scope: "responsibility-local" },
  { label: "cross-resp", scope: "cross-responsibility" },
  { label: "pkg-wide", scope: "package-wide" },
  { label: "unplaced", scope: "unplaced" },
  { label: "unclear", scope: "unclear" },
];

function shortId(id: string | undefined): string {
  return id === undefined ? "—" : id.replace(/^responsibility:/, "");
}

function responsibilities(value: number): string {
  return `${count(value)} ${value === 1 ? "responsibility" : "responsibilities"}`;
}

function pad(value: string, width: number): string {
  return value.length >= width
    ? value
    : value + " ".repeat(width - value.length);
}

function padLeft(value: string, width: number): string {
  return value.length >= width
    ? value
    : " ".repeat(width - value.length) + value;
}

function distribution<K extends string>(
  record: Partial<Record<K, number>>,
  order: K[]
): string {
  return order
    .filter((key) => (record[key] ?? 0) > 0)
    .map((key) => `${key} ${count(record[key] ?? 0)}`)
    .join(" · ");
}

export function renderPrimitiveConventions(
  report: PrimitiveConventionReport,
  config: AnalysisConfig = ANALYSIS_CONFIG
): string {
  const { summary, policy } = report;
  const limits = config.primitiveConventions.report;
  const lines: string[] = [];
  lines.push("PRIMITIVES & CONVENTIONS");
  lines.push("═".repeat(24));
  lines.push(`Package  ${report.package.id}`);
  lines.push(
    `Rules    package-wide at ${responsibilities(policy.packageWide.threshold)} · dedicated role at ${percent(policy.dedicatedRoleShare)} · hub ${count(policy.hub.minimumSymbols)}+ symbols over ${count(policy.hub.minimumResponsibilities)}+ responsibilities · convention at ${plural(policy.conventions.minimumSupport, "symbol")}`
  );
  lines.push("");
  lines.push(
    `Symbols      ${count(summary.symbols)} · ${count(summary.exportedSymbols)} exported · ${count(summary.multiRoleSymbols)} multi-role`
  );
  lines.push(`Roles        ${distribution(summary.byRole, policy.roles)}`);
  lines.push(`Scopes       ${distribution(summary.byScope, policy.scopes)}`);
  const c = summary.byModuleComposition;
  lines.push(
    `Modules      ${count(summary.modules)} · ${count(c.roles["single-role"])} single-role · ${count(c.roles["mixed-role"])} mixed-role · ${count(c.scopes["single-scope"])} single-scope · ${count(c.scopes["mixed-scope"])} mixed-scope`
  );
  const s = summary.byModuleShape;
  lines.push(
    `Shapes       ${count(s["primitive-hub"])} primitive hubs · ${count(s["contract-hub"])} contract hubs · ${count(s["configuration-hub"])} configuration hubs · ${count(s["implementation-module"])} implementation modules · ${count(s.aggregator)} aggregators · ${count(summary.misleadingRoleBasenames)} role-named modules mixing scopes`
  );
  const k = summary.conventions;
  lines.push(
    `Conventions  role+scope: ${count(k.roleAndScope.observed)} observed · ${count(k.roleAndScope.competing)} competing groups · ${count(k.roleAndScope["insufficient-evidence"])} insufficient · role alone: ${count(k.roleAlone.observed)} observed · ${count(k.roleAlone.competing)} competing · ${count(k.roleAlone["insufficient-evidence"])} insufficient`
  );
  const u = summary.unresolvedModules;
  lines.push(
    `Unresolved   ${count(u.explained)} of ${plural(u.total, "V13.2 module")} explained · ${count(u.byShape["primitive-hub"])} primitive hubs · ${count(u.byShape["contract-hub"])} contract hubs · ${count(u.byShape["configuration-hub"])} configuration hubs · ${count(u.byShape.aggregator)} aggregators · ${count(u.mixedScope)} mixed-scope · ${count(u.unexplained)} unexplained`
  );

  lines.push("");
  lines.push("ROLE × SCOPE");
  lines.push(
    `  ${pad("", 15)}${SCOPE_COLUMNS.map((column) => padLeft(column.label, 11)).join("")}`
  );
  for (const role of policy.roles) {
    if (summary.byRole[role] === 0) {
      continue;
    }
    const row = summary.matrix[role];
    lines.push(
      `  ${pad(role, 15)}${SCOPE_COLUMNS.map((column) => padLeft(count(row[column.scope]), 11)).join("")}`
    );
  }

  const symbolLine = (symbol: ArchitecturalRoleFinding) =>
    `  ${symbol.name} · ${symbol.primaryRole}${symbol.roles.length > 1 ? ` (${symbol.roles.join(", ")})` : ""} · ${symbol.scope} · ${symbol.declaration.module} · ${plural(symbol.consumers.modules, "consumer")} in ${responsibilities(symbol.consumers.responsibilities.length)}${symbol.consumers.unresolvedModules > 0 ? ` (+${count(symbol.consumers.unresolvedModules)} unresolved)` : ""}${symbol.served !== undefined && !symbol.served.declarationAgrees ? " · declared outside" : ""}`;
  const symbolSection = (
    title: string,
    symbols: ArchitecturalRoleFinding[]
  ) => {
    if (symbols.length === 0) {
      return;
    }
    lines.push("");
    lines.push(`${title} (${count(symbols.length)})`);
    for (const symbol of symbols.slice(0, limits.topSymbols)) {
      lines.push(symbolLine(symbol));
    }
  };
  const byReach = (a: ArchitecturalRoleFinding, b: ArchitecturalRoleFinding) =>
    b.consumers.responsibilities.length - a.consumers.responsibilities.length ||
    b.consumers.modules - a.consumers.modules ||
    a.symbolId.localeCompare(b.symbolId);
  symbolSection(
    "PACKAGE-WIDE PRIMITIVES",
    report.symbols
      .filter((symbol) => symbol.scope === "package-wide")
      .sort(byReach)
  );
  symbolSection(
    "CROSS-RESPONSIBILITY PRIMITIVES",
    report.symbols
      .filter(
        (symbol) =>
          symbol.scope === "cross-responsibility" &&
          symbol.primaryRole !== "behavior"
      )
      .sort(byReach)
  );
  symbolSection(
    "RESPONSIBILITY-LOCAL SYMBOLS DECLARED ELSEWHERE",
    report.symbols
      .filter(
        (symbol) =>
          symbol.served !== undefined && !symbol.served.declarationAgrees
      )
      .sort(byReach)
  );

  const moduleLine = (module: PrimitiveModuleFinding) => [
    `  ${module.module}${module.roleBasename ? " · role-named" : ""} · ${module.status}${module.ambiguity === undefined ? "" : ` (${module.ambiguity})`} · ${module.composition.roles} · ${module.composition.scopes}${module.shapes.length > 0 ? ` · ${module.shapes.join(", ")}` : ""}`,
    `    ${plural(module.exportedSymbols, "exported symbol")} of ${count(module.symbols)} · ${plural(module.composition.scopeGroups, "scope group")} · ${count(module.fragmentation.localGroups)} local responsibilities · ${count(module.fragmentation.crossResponsibility)} cross · ${count(module.fragmentation.packageWide)} package-wide · ${count(module.unresolvedSymbols)} unresolved · roles ${distribution(module.roles, policy.roles)}`,
  ];
  const moduleSection = (title: string, modules: PrimitiveModuleFinding[]) => {
    if (modules.length === 0) {
      return;
    }
    lines.push("");
    lines.push(`${title} (${count(modules.length)})`);
    for (const module of modules.slice(0, limits.topModules)) {
      lines.push(...moduleLine(module));
    }
  };
  const byFragmentation = (
    a: PrimitiveModuleFinding,
    b: PrimitiveModuleFinding
  ) =>
    b.composition.scopeGroups - a.composition.scopeGroups ||
    b.exportedSymbols - a.exportedSymbols ||
    a.module.localeCompare(b.module);
  moduleSection(
    "MIXED-SCOPE MODULES",
    report.modules
      .filter((module) => module.composition.scopes === "mixed-scope")
      .sort(byFragmentation)
  );
  moduleSection(
    "HUBS",
    report.modules
      .filter((module) => module.shapes.some((shape) => shape.endsWith("-hub")))
      .sort(byFragmentation)
  );

  const scoped = report.conventions.filter(
    (convention) => convention.scope !== "any"
  );
  if (scoped.length > 0) {
    lines.push("");
    lines.push(`STRONGEST CONVENTIONS (${count(scoped.length)})`);
    for (const convention of scoped.slice(0, limits.topConventions)) {
      const basenames = convention.provenance.basenames
        .slice(0, 3)
        .map((entry) => `${entry.basename} ${count(entry.symbols)}`)
        .join(", ");
      lines.push(
        `  ${convention.role} · ${convention.scope} · ${convention.dimension} = ${convention.value}`
      );
      lines.push(
        `    ${plural(convention.support.symbols, "symbol")} in ${plural(convention.support.modules, "module")} over ${responsibilities(convention.support.responsibilities)} · ${plural(convention.exceptions.symbols, "exception")}${basenames.length > 0 ? ` · basenames ${basenames}` : ""}`
      );
    }
  }

  const microscope = report.modules
    .filter(
      (module) =>
        module.status === "unresolved" ||
        module.composition.scopes === "mixed-scope"
    )
    .sort(byFragmentation)
    .slice(0, limits.microscopeModules);
  if (microscope.length > 0) {
    lines.push("");
    lines.push("MODULE MICROSCOPE");
    for (const module of microscope) {
      lines.push("");
      lines.push(`  ${module.module}`);
      lines.push(
        `    V13.2  ${module.status}${module.ambiguity === undefined ? "" : ` · ${module.ambiguity}`}${module.responsibility === undefined ? "" : ` · ${shortId(module.responsibility)}`}`
      );
      lines.push(`    ROLES  ${distribution(module.roles, policy.roles)}`);
      lines.push(`    SCOPES ${distribution(module.scopes, policy.scopes)}`);
      if (module.responsibilities.length > 0) {
        lines.push(
          `    SERVES ${module.responsibilities
            .slice(0, 6)
            .map((entry) => `${shortId(entry.id)} (${count(entry.symbols)})`)
            .join(", ")}${module.responsibilities.length > 6 ? ", …" : ""}`
        );
      }
      const symbols = report.symbols
        .filter(
          (symbol) =>
            symbol.declaration.module === module.module && symbol.exported
        )
        .sort(byReach)
        .slice(0, limits.topSymbols);
      for (const symbol of symbols) {
        lines.push(
          `      ${pad(symbol.name, 28)} ${pad(symbol.primaryRole, 15)} ${pad(symbol.scope, 22)} ${responsibilities(symbol.consumers.responsibilities.length)}${symbol.served === undefined ? "" : ` → ${shortId(symbol.served.responsibility)}`}`
        );
      }
    }
  }
  return lines.join("\n");
}
