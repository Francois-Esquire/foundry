import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import type {
  InternalResponsibilityReport,
  ResponsibilityModuleEvidence,
  ResponsibilitySymbolContext,
} from "./internal-responsibility-types";
import type { InternalPackageTopology } from "./internal-topology-types";
import type {
  PackageLocalDeclaration,
  PackageLocalReport,
  PackageLocalSymbol,
} from "./package-local-types";
import type {
  ArchitecturalRole,
  ArchitecturalRoleFinding,
  ArchitecturalScopeClass,
  ColocationPattern,
  ConventionDimension,
  ConventionGroup,
  ConventionStatus,
  PlacementColocationShape,
  PlacementConvention,
  PlacementDirectoryShape,
  PlacementModuleShape,
  PrimitiveAmbiguity,
  PrimitiveAmbiguityReason,
  PrimitiveConventionReport,
  PrimitiveConventionSummary,
  PrimitiveLimitation,
  PrimitiveModuleFinding,
  PrimitiveModuleShape,
  RoleEvidence,
  ScopeEvidence,
} from "./primitive-convention-types";
import { PRIMITIVE_CONVENTION_SCHEMA_VERSION } from "./primitive-convention-types";
import type {
  SymbolLocalityFinding,
  SymbolLocalityReport,
} from "./symbol-locality-types";
import type { SymbolKind } from "./types";

// V13.3 primitive and convention intelligence. A pure function of one
// package's local report, topology, locality, and responsibility regions:
// no file system, no program, no workspace. Roles come from declaration
// shape and explicit concept relationships; naming only supports and never
// decides. Scope comes from which V13.2 responsibilities consume the symbol,
// so a symbol inside an unresolved hub still gets a measured consumer scope.
// Conventions are counts of recurring placement values; nothing here says a
// symbol should move.

const ROLES: ArchitecturalRole[] = [
  "identifier",
  "constant",
  "configuration",
  "contract",
  "schema",
  "factory",
  "adapter",
  "implementation",
  "representation",
  "utility",
  "behavior",
  "type",
  "value",
  "unknown",
];

/** The first of a symbol's roles in this order is its primary role. */
const ROLE_PRECEDENCE: ArchitecturalRole[] = [
  "identifier",
  "schema",
  "configuration",
  "constant",
  "contract",
  "adapter",
  "factory",
  "implementation",
  "representation",
  "utility",
  "behavior",
  "type",
  "value",
  "unknown",
];

const SCOPES: ArchitecturalScopeClass[] = [
  "module-local",
  "responsibility-local",
  "cross-responsibility",
  "package-wide",
  "unplaced",
  "unclear",
];

const MODULE_SHAPES: PrimitiveModuleShape[] = [
  "primitive-hub",
  "contract-hub",
  "configuration-hub",
  "implementation-module",
  "aggregator",
];

const COLOCATIONS: ColocationPattern[] = [
  "contract+implementation",
  "schema+type",
  "type+behavior",
  "constant+behavior",
];

const DIMENSIONS: ConventionDimension[] = ["module", "directory", "colocation"];

const AMBIGUITY_REASONS: PrimitiveAmbiguityReason[] = [
  "no-role-evidence",
  "naming-disagrees",
  "no-placed-consumers",
  "no-internal-consumers",
];

const LIMITATIONS: PrimitiveLimitation[] = [
  "intra-module-usage-unmeasured",
  "unresolved-consumers",
  "no-internal-consumers",
  "declaration-unplaced",
  "namespace-derived",
];

const CONVENTION_STATUSES: ConventionStatus[] = [
  "convention",
  "competing",
  "insufficient-evidence",
];

/** Roles whose symbols are structural primitives rather than executable units. */
const PRIMITIVE_ROLES: ArchitecturalRole[] = [
  "identifier",
  "constant",
  "configuration",
  "contract",
  "type",
  "schema",
  "utility",
];

const EXECUTABLE_ROLES: ArchitecturalRole[] = [
  "factory",
  "adapter",
  "implementation",
  "behavior",
  "utility",
];

const TYPE_FAMILY: ArchitecturalRole[] = [
  "contract",
  "type",
  "representation",
  "identifier",
  "configuration",
  "schema",
];

const ROLE_DEFINITIONS: Record<ArchitecturalRole, string> = {
  adapter:
    "an implementation holding another local contract as a property type",
  behavior: "any other executable declaration",
  configuration:
    "a constant object or array annotated with, or named as, a config, options, settings, or policy type; and the data-only type such a value is annotated with",
  constant:
    "an enum, or a const whose initializer is a literal, array, or object",
  contract:
    "an interface or abstract class with callable members, or one that a local declaration implements",
  factory:
    "a function that constructs the local class it returns, or that constructs or returns a local seed under a create/make/build name",
  identifier:
    "a type alias branding a primitive, or a scalar alias named as an id",
  implementation:
    "a class implementing or extending a local seed, or an object annotated with a local contract",
  representation:
    "a data-only type derived from a local seed by extension or alias, or from a schema through typeof",
  schema:
    "a const initialized by calling a known schema library, or by calling another schema",
  type: "any other type-level declaration",
  unknown: "a namespace or a declaration with no role evidence",
  utility:
    "a free function without JSX, with no concept relationship, few statements, and several consumer modules",
  value: "any other runtime value: instances, call results, references",
};

const SCOPE_DEFINITIONS: Record<ArchitecturalScopeClass, string> = {
  "cross-responsibility":
    "placed consumers in several responsibilities, below the package-wide threshold",
  "module-local": "not exported from its module",
  "package-wide":
    "placed consumers in at least the threshold's responsibilities",
  "responsibility-local": "every placed consumer sits in one responsibility",
  unclear: "exported with no internal consumer, or no placed consumer",
  unplaced:
    "declaring module unresolved in V13.2 and no consumer placed either",
};

/** Supporting naming patterns, each read only on the declaration kinds it could describe. */
const NAMING_HINTS: {
  pattern: RegExp;
  role: ArchitecturalRole;
  kinds: SymbolKind[];
}[] = [
  { kinds: ["type", "interface"], pattern: /(Id|ID)$/, role: "identifier" },
  {
    kinds: ["variable", "type", "interface"],
    pattern: /(_CONFIG|Config|Options|Settings|Policy)$/,
    role: "configuration",
  },
  { kinds: ["variable"], pattern: /^DEFAULT_/, role: "configuration" },
  {
    kinds: ["variable"],
    pattern: /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/,
    role: "constant",
  },
  {
    kinds: ["function", "variable"],
    pattern: /^(create|make|build)[A-Z]/,
    role: "factory",
  },
  { kinds: ["class", "variable"], pattern: /Adapter$/, role: "adapter" },
  { kinds: ["variable"], pattern: /Schema$/, role: "schema" },
];

const CONFIGURATION_NAME =
  /(_CONFIG|Config|Options|Settings|Policy)$|^DEFAULT_/;
const FACTORY_NAME = /^(create|make|build)[A-Z]/;
const IDENTIFIER_NAME = /(Id|ID)$/;

const ROOT_DIRECTORY = ".";

function zeroRecord<K extends string>(keys: K[]): Record<K, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<K, number>;
}

function share(part: number, whole: number): number {
  return whole === 0 ? 0 : part / whole;
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function increment<K extends string>(
  record: Partial<Record<K, number>>,
  key: K
): void {
  record[key] = (record[key] ?? 0) + 1;
}

function sortedPartial<K extends string>(
  record: Partial<Record<K, number>>
): Partial<Record<K, number>> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b))
  ) as Partial<Record<K, number>>;
}

function basenameOf(module: string): string {
  const slash = module.lastIndexOf("/");
  const file = slash === -1 ? module : module.slice(slash + 1);
  const dot = file.indexOf(".");
  return dot === -1 ? file : file.slice(0, dot);
}

function directoryOf(module: string): string {
  const slash = module.lastIndexOf("/");
  return slash === -1 ? ROOT_DIRECTORY : module.slice(0, slash);
}

function depthOf(directory: string): number {
  return directory === ROOT_DIRECTORY ? 0 : directory.split("/").length;
}

interface SymbolFacts {
  context?: ResponsibilitySymbolContext;
  declaration: PackageLocalDeclaration;
  finding?: SymbolLocalityFinding;
  functions: number;
  module: string;
  statements: number;
  symbol: PackageLocalSymbol;
}

interface RoleResult {
  evidence: RoleEvidence[];
  roles: ArchitecturalRole[];
}

export function analyzePrimitiveConventions(
  report: PackageLocalReport,
  topology: InternalPackageTopology,
  locality: SymbolLocalityReport,
  responsibilities: InternalResponsibilityReport,
  config: AnalysisConfig = ANALYSIS_CONFIG
): PrimitiveConventionReport {
  const policy = config.primitiveConventions;
  const root = responsibilities.package.root;
  const prefix = root === "" || root === "." ? "" : `${root}/`;
  const packageRelative = (file: string) =>
    file.startsWith(prefix) ? file.slice(prefix.length) : file;

  const declarationById = new Map(
    report.declarations.map((declaration) => [
      declaration.symbolId,
      declaration,
    ])
  );
  const findingById = new Map(
    locality.symbols.map((finding) => [finding.symbolId, finding])
  );
  const contextById = new Map(
    responsibilities.symbols.map((context) => [context.symbolId, context])
  );
  const moduleEvidence = new Map(
    responsibilities.modules.map((module) => [module.module, module])
  );
  const regionById = new Map(
    responsibilities.regions.map((region) => [region.id, region])
  );
  const ambiguityByModule = new Map(
    responsibilities.unresolved.map((entry) => [entry.module, entry.reason])
  );
  const directoryNode = new Map(
    topology.directories.map((directory) => [directory.id, directory])
  );
  const aboveRegions = (directory: string): boolean => {
    const node = directoryNode.get(directory);
    if (node === undefined) {
      return directory === ROOT_DIRECTORY;
    }
    if (node.parent === undefined) {
      return true;
    }
    return node.depth === 1 && topology.policy.technicalRoots.includes(node.id);
  };
  const statementsByOwner = new Map<
    string,
    { statements: number; functions: number }
  >();
  for (const fn of report.localComplexity.functions) {
    if (fn.ownerSymbolId === undefined) {
      continue;
    }
    const entry = statementsByOwner.get(fn.ownerSymbolId) ?? {
      functions: 0,
      statements: 0,
    };
    entry.statements += fn.metrics.statements;
    entry.functions += 1;
    statementsByOwner.set(fn.ownerSymbolId, entry);
  }

  const seedKind = new Map(
    report.conceptSeeds.map((seed) => [seed.id, seed.kind])
  );
  // The universe is the primary modules' top-level declarations, as in
  // V13.1 and V13.2: tests, stories, and fixtures are not architecture.
  const facts: SymbolFacts[] = report.symbols
    .map<SymbolFacts | undefined>((symbol) => {
      const declaration = declarationById.get(symbol.id);
      const module = packageRelative(symbol.declarationFile);
      if (declaration === undefined || !moduleEvidence.has(module)) {
        return;
      }
      const owned = statementsByOwner.get(symbol.id);
      return {
        context: contextById.get(symbol.id),
        declaration,
        finding: findingById.get(symbol.id),
        functions: owned?.functions ?? 0,
        module,
        statements: owned?.statements ?? 0,
        symbol,
      };
    })
    .filter((entry): entry is SymbolFacts => entry !== undefined)
    .sort((a, b) => a.symbol.id.localeCompare(b.symbol.id));
  const factsById = new Map(facts.map((entry) => [entry.symbol.id, entry]));

  // Which seeds are implemented by some local declaration, and by whom: the
  // consumer-side half of contract evidence. A class extending a seed
  // implements it; an interface extending one merely derives from it.
  const implementersOf = new Map<string, string[]>();
  for (const entry of facts) {
    for (const concept of entry.declaration.concepts) {
      const r = concept.relationships;
      if (
        (r.implements ?? 0) > 0 ||
        ((r.extends ?? 0) > 0 && entry.symbol.kind === "class")
      ) {
        const list = implementersOf.get(concept.conceptId) ?? [];
        list.push(entry.symbol.id);
        implementersOf.set(concept.conceptId, list);
      }
    }
  }

  const isSchemaLibrary = (specifier: string) =>
    policy.schemaLibraries.some(
      (library) => specifier === library || specifier.startsWith(`${library}/`)
    );
  const hasCallableMembers = (declaration: PackageLocalDeclaration) =>
    (declaration.members?.methods ?? 0) > 0;
  const isContractSeed = (id: string) => {
    const target = factsById.get(id);
    if (target === undefined) {
      return false;
    }
    const kind = target.symbol.kind;
    return (
      (kind === "interface" || kind === "class" || kind === "type") &&
      (hasCallableMembers(target.declaration) ||
        target.declaration.abstract === true ||
        implementersOf.has(id))
    );
  };

  // Pass one: runtime declarations. Schemas chain through local callees, so
  // that pass iterates to a fixed point.
  const roleOf = new Map<string, RoleResult>();
  const schemaSymbols = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of facts) {
      const { declaration, symbol } = entry;
      if (symbol.kind !== "variable" || schemaSymbols.has(symbol.id)) {
        continue;
      }
      if (
        declaration.initializer !== "call" ||
        declaration.callee === undefined
      ) {
        continue;
      }
      const callee = declaration.callee;
      if (
        (callee.specifier !== undefined && isSchemaLibrary(callee.specifier)) ||
        (callee.symbolId !== undefined && schemaSymbols.has(callee.symbolId))
      ) {
        schemaSymbols.add(symbol.id);
        changed = true;
      }
    }
  }

  const classifyRuntime = (entry: SymbolFacts): RoleResult => {
    const { symbol, declaration } = entry;
    const roles: ArchitecturalRole[] = [];
    const evidence: RoleEvidence[] = [];
    const add = (
      role: ArchitecturalRole,
      kind: RoleEvidence["kind"],
      detail: string
    ) => {
      if (!roles.includes(role)) {
        roles.push(role);
      }
      evidence.push({ detail, kind, role });
    };
    const concepts = declaration.concepts;
    const relationship = (
      kind: keyof PackageLocalDeclaration["concepts"][number]["relationships"]
    ) => concepts.filter((c) => (c.relationships[kind] ?? 0) > 0);
    const isFunction =
      symbol.kind === "function" ||
      (symbol.kind === "variable" && declaration.initializer === "function");

    if (symbol.kind === "enum") {
      add("constant", "declaration-kind", "enum");
      return { evidence, roles };
    }
    if (symbol.kind === "class") {
      const implemented = [
        ...relationship("implements"),
        ...relationship("extends"),
      ];
      if (declaration.abstract === true) {
        add("contract", "declaration-kind", "abstract class");
      }
      if (implemented.length > 0) {
        add(
          "implementation",
          "concept-relationship",
          `implements/extends ${sorted(implemented.map((c) => c.conceptId)).join(", ")}`
        );
        const held = relationship("property-type").filter(
          (c) =>
            !implemented.some((i) => i.conceptId === c.conceptId) &&
            isContractSeed(c.conceptId)
        );
        if (held.length > 0) {
          add(
            "adapter",
            "concept-relationship",
            `holds ${sorted(held.map((c) => c.conceptId)).join(", ")} as property type`
          );
        }
      }
      if (roles.length === 0) {
        if (hasCallableMembers(declaration) || entry.functions > 0) {
          add(
            "behavior",
            "members",
            `${declaration.members?.methods ?? 0} methods`
          );
        } else {
          add("value", "members", "data-only class");
        }
      }
      return { evidence, roles };
    }
    if (isFunction) {
      // Construction alone is not a factory (a thrower constructs errors),
      // nor is a return type alone (a getter returns an instance): the
      // function must construct what it returns, or be named as a factory
      // and do one of the two.
      const constructs = relationship("constructs").filter(
        (c) => seedKind.get(c.conceptId) === "class"
      );
      const returns = relationship("return-type").filter((c) =>
        seedKind.has(c.conceptId)
      );
      const constructsAndReturns = constructs.filter((c) =>
        returns.some((r) => r.conceptId === c.conceptId)
      );
      const named = FACTORY_NAME.test(symbol.name);
      if (constructsAndReturns.length > 0) {
        add(
          "factory",
          "concept-relationship",
          `constructs and returns ${sorted(constructsAndReturns.map((c) => c.conceptId)).join(", ")}`
        );
      } else if (named && (constructs.length > 0 || returns.length > 0)) {
        add(
          "factory",
          "concept-relationship",
          constructs.length > 0
            ? `constructs ${sorted(constructs.map((c) => c.conceptId)).join(", ")}`
            : `returns ${sorted(returns.map((c) => c.conceptId)).join(", ")}`
        );
        evidence.push({ detail: symbol.name, kind: "naming", role: "factory" });
      }
      if (roles.length === 0) {
        const consumers = entry.finding?.consumers.modules ?? 0;
        if (
          concepts.length === 0 &&
          declaration.jsx !== true &&
          consumers >= policy.utility.minimumConsumers &&
          entry.statements <= policy.utility.maximumStatements
        ) {
          add(
            "utility",
            "behavior",
            `${entry.statements} statements, no concept relationship`
          );
          evidence.push({
            detail: `${consumers} consumer modules`,
            kind: "usage",
            role: "utility",
          });
        } else {
          add(
            "behavior",
            "declaration-kind",
            symbol.kind === "function" ? "function" : "function-valued const"
          );
        }
      }
      return { evidence, roles };
    }
    if (symbol.kind === "variable") {
      const initializer = declaration.initializer ?? "none";
      if (schemaSymbols.has(symbol.id)) {
        const callee = declaration.callee;
        add(
          "schema",
          "schema-library",
          callee?.specifier === undefined
            ? `${callee?.name ?? "?"} chains a schema`
            : `${callee.name} from ${callee.specifier}`
        );
        return { evidence, roles };
      }
      const annotation = declaration.annotation;
      const annotated =
        annotation === undefined ? undefined : factsById.get(annotation);
      if (
        initializer === "object" &&
        annotation !== undefined &&
        isContractSeed(annotation)
      ) {
        add(
          "implementation",
          "annotation",
          `object annotated with contract ${annotation}`
        );
        return { evidence, roles };
      }
      if (
        initializer === "literal" ||
        initializer === "array" ||
        initializer === "object"
      ) {
        const configurationByAnnotation =
          annotated !== undefined &&
          CONFIGURATION_NAME.test(annotated.symbol.name);
        const configurationByName = CONFIGURATION_NAME.test(symbol.name);
        if (
          initializer !== "literal" &&
          (configurationByAnnotation || configurationByName)
        ) {
          add(
            "configuration",
            configurationByAnnotation ? "annotation" : "naming",
            configurationByAnnotation
              ? `annotated with ${annotation}`
              : symbol.name
          );
        }
        add(
          "constant",
          "initializer",
          `${initializer}${declaration.asConst === true ? " as const" : ""}`
        );
        return { evidence, roles };
      }
      add("value", "initializer", initializer);
      return { evidence, roles };
    }
    return { evidence, roles };
  };

  for (const entry of facts) {
    if (
      entry.symbol.kind === "variable" ||
      entry.symbol.kind === "function" ||
      entry.symbol.kind === "class" ||
      entry.symbol.kind === "enum"
    ) {
      roleOf.set(entry.symbol.id, classifyRuntime(entry));
    }
  }

  // Configuration values name their contract: the annotated type of a
  // configuration constant is itself configuration.
  const configurationTypes = new Set<string>();
  for (const entry of facts) {
    const result = roleOf.get(entry.symbol.id);
    if (
      result?.roles.includes("configuration") &&
      entry.declaration.annotation !== undefined
    ) {
      configurationTypes.add(entry.declaration.annotation);
    }
  }

  const classifyType = (entry: SymbolFacts): RoleResult => {
    const { symbol, declaration } = entry;
    const roles: ArchitecturalRole[] = [];
    const evidence: RoleEvidence[] = [];
    const add = (
      role: ArchitecturalRole,
      kind: RoleEvidence["kind"],
      detail: string
    ) => {
      if (!roles.includes(role)) {
        roles.push(role);
      }
      evidence.push({ detail, kind, role });
    };
    const dataOnly = !hasCallableMembers(declaration);
    const derivedFromSeed = declaration.concepts.filter(
      (c) =>
        (c.relationships.extends ?? 0) > 0 || (c.relationships.alias ?? 0) > 0
    );
    const implementers = implementersOf.get(symbol.id) ?? [];
    if (symbol.kind === "type") {
      const shape = declaration.aliasShape ?? "other";
      if (shape === "brand") {
        add("identifier", "alias-shape", "branded primitive");
        return { evidence, roles };
      }
      if (shape === "scalar" && IDENTIFIER_NAME.test(symbol.name)) {
        add("identifier", "alias-shape", "scalar alias");
        evidence.push({
          detail: symbol.name,
          kind: "naming",
          role: "identifier",
        });
        return { evidence, roles };
      }
      const schemaQueries = (declaration.typeQueries ?? []).filter((id) =>
        schemaSymbols.has(id)
      );
      if (schemaQueries.length > 0) {
        add(
          "representation",
          "type-query",
          `derived from ${schemaQueries.join(", ")}`
        );
        return { evidence, roles };
      }
    }
    if (symbol.kind === "interface" || symbol.kind === "type") {
      if (!dataOnly) {
        add(
          "contract",
          "members",
          `${declaration.members?.methods ?? 0} callable members`
        );
        return { evidence, roles };
      }
      if (implementers.length > 0 && symbol.kind === "interface") {
        add(
          "contract",
          "concept-relationship",
          `implemented by ${implementers.length}`
        );
        return { evidence, roles };
      }
      if (configurationTypes.has(symbol.id)) {
        add("configuration", "annotation", "annotates a configuration value");
        return { evidence, roles };
      }
      if (CONFIGURATION_NAME.test(symbol.name)) {
        add("configuration", "naming", symbol.name);
        return { evidence, roles };
      }
      if (derivedFromSeed.length > 0) {
        add(
          "representation",
          "concept-relationship",
          `derived from ${sorted(derivedFromSeed.map((c) => c.conceptId)).join(", ")}`
        );
        return { evidence, roles };
      }
      add("type", "declaration-kind", symbol.kind);
      return { evidence, roles };
    }
    return { evidence, roles };
  };

  for (const entry of facts) {
    if (entry.symbol.kind === "interface" || entry.symbol.kind === "type") {
      roleOf.set(entry.symbol.id, classifyType(entry));
    }
  }

  const placedRegions = responsibilities.regions.length;
  const packageWideThreshold = Math.max(
    policy.packageWide.minimumResponsibilities,
    Math.ceil(policy.packageWide.responsibilityShare * placedRegions)
  );

  // A responsibility's root is its shallowest directory below the package
  // root; an attached aggregator at the root does not move it.
  const regionRoot = new Map<string, string>();
  for (const region of responsibilities.regions) {
    const below = region.path.directories.filter((d) => !aboveRegions(d));
    const shallowest = (
      below.length > 0 ? below : region.path.directories
    ).sort((a, b) => depthOf(a) - depthOf(b) || a.localeCompare(b))[0];
    regionRoot.set(region.id, shallowest ?? ROOT_DIRECTORY);
  }

  interface Classified {
    consumerResponsibilities: string[];
    facts: SymbolFacts;
    limitations: PrimitiveLimitation[];
    moduleEvidence?: ResponsibilityModuleEvidence;
    namingDisagrees?: ArchitecturalRole;
    primaryRole: ArchitecturalRole;
    roleEvidence: RoleEvidence[];
    roles: ArchitecturalRole[];
    scope: ArchitecturalScopeClass;
    scopeEvidence: ScopeEvidence;
    served?: { responsibility: string; declarationAgrees: boolean };
    unresolvedConsumers: number;
  }

  const classified: Classified[] = facts.map((entry) => {
    const result = roleOf.get(entry.symbol.id) ?? { evidence: [], roles: [] };
    const roles =
      result.roles.length === 0
        ? (["unknown"] as ArchitecturalRole[])
        : result.roles;
    const primaryRole =
      ROLE_PRECEDENCE.find((role) => roles.includes(role)) ?? "unknown";
    const evidence = [...result.evidence];
    let namingDisagrees: ArchitecturalRole | undefined;
    for (const hint of NAMING_HINTS) {
      if (
        !(
          hint.kinds.includes(entry.symbol.kind) &&
          hint.pattern.test(entry.symbol.name)
        )
      ) {
        continue;
      }
      if (!evidence.some((e) => e.kind === "naming" && e.role === hint.role)) {
        evidence.push({
          detail: entry.symbol.name,
          kind: "naming",
          role: hint.role,
        });
      }
      if (
        !roles.includes(hint.role) &&
        primaryRole !== "unknown" &&
        namingDisagrees === undefined
      ) {
        namingDisagrees = hint.role;
      }
    }

    const module = moduleEvidence.get(entry.module);
    const placed = module?.region !== undefined;
    const limitations: PrimitiveLimitation[] = [];
    let scope: ArchitecturalScopeClass;
    let scopeEvidence: ScopeEvidence;
    let served: Classified["served"];
    const consumerResponsibilities = entry.context?.consumerRegions ?? [];
    const unresolvedConsumers = entry.context?.unresolvedConsumers ?? 0;
    if (!entry.symbol.exported) {
      scope = "module-local";
      scopeEvidence = "structural";
      limitations.push("intra-module-usage-unmeasured");
    } else if (entry.context === undefined) {
      scope = "unclear";
      scopeEvidence = "none";
      limitations.push("no-internal-consumers");
    } else if (consumerResponsibilities.length === 0) {
      scope = placed ? "unclear" : "unplaced";
      scopeEvidence = "none";
      if (unresolvedConsumers > 0) {
        limitations.push("unresolved-consumers");
      }
    } else {
      const count = consumerResponsibilities.length;
      if (count >= packageWideThreshold) {
        scope = "package-wide";
      } else if (count >= 2) {
        scope = "cross-responsibility";
      } else {
        scope = "responsibility-local";
        const responsibility = consumerResponsibilities[0] ?? "";
        served = {
          declarationAgrees: module?.region === responsibility,
          responsibility,
        };
      }
      scopeEvidence = unresolvedConsumers > 0 ? "partial" : "complete";
      if (unresolvedConsumers > 0) {
        limitations.push("unresolved-consumers");
      }
    }
    if (entry.symbol.exported && !placed) {
      limitations.push("declaration-unplaced");
    }
    if (
      entry.finding?.limitations.some(
        (l) => l === "namespace-member-derived" || l === "namespace-bare-use"
      )
    ) {
      limitations.push("namespace-derived");
    }
    return {
      facts: entry,
      primaryRole,
      roleEvidence: evidence,
      roles,
      scope,
      scopeEvidence,
      ...(served !== undefined && { served }),
      consumerResponsibilities,
      limitations,
      unresolvedConsumers,
      ...(module !== undefined && { moduleEvidence: module }),
      ...(namingDisagrees !== undefined && { namingDisagrees }),
    };
  });

  // Modules: composition over exported classified symbols.
  const byModule = new Map<string, Classified[]>();
  for (const entry of classified) {
    const list = byModule.get(entry.facts.module) ?? [];
    list.push(entry);
    byModule.set(entry.facts.module, list);
  }
  const scopeGroupOf = (entry: Classified): string | undefined => {
    if (entry.scope === "responsibility-local") {
      return `responsibility-local:${entry.served?.responsibility ?? ""}`;
    }
    if (
      entry.scope === "cross-responsibility" ||
      entry.scope === "package-wide"
    ) {
      return entry.scope;
    }
    return undefined;
  };
  const responsibilitiesServed = (entry: Classified): string[] =>
    entry.scope === "responsibility-local"
      ? [entry.served?.responsibility ?? ""]
      : entry.scope === "cross-responsibility" || entry.scope === "package-wide"
        ? entry.consumerResponsibilities
        : [];

  interface ModuleComposition {
    dedicatedRole?: ArchitecturalRole;
    exportsBehavior: boolean;
    exportsTypes: boolean;
    finding: PrimitiveModuleFinding;
  }
  const compositions = new Map<string, ModuleComposition>();
  const isAggregator = (module: string) =>
    report.moduleRoles[module]?.kind === "aggregator" ||
    (moduleEvidence.get(module)?.roles ?? []).includes("aggregator");

  for (const module of sorted([...byModule.keys(), ...moduleEvidence.keys()])) {
    const entries = byModule.get(module) ?? [];
    const exported = entries.filter((e) => e.facts.symbol.exported);
    const classifiedExported = exported.filter(
      (e) => e.primaryRole !== "unknown"
    );
    const roles: Partial<Record<ArchitecturalRole, number>> = {};
    const scopes: Partial<Record<ArchitecturalScopeClass, number>> = {};
    for (const entry of entries) {
      increment(roles, entry.primaryRole);
      increment(scopes, entry.scope);
    }
    const roleCounts = new Map<ArchitecturalRole, number>();
    for (const entry of classifiedExported) {
      roleCounts.set(
        entry.primaryRole,
        (roleCounts.get(entry.primaryRole) ?? 0) + 1
      );
    }
    const dominant = [...roleCounts.entries()].sort(
      (a, b) =>
        b[1] - a[1] ||
        ROLE_PRECEDENCE.indexOf(a[0]) - ROLE_PRECEDENCE.indexOf(b[0])
    )[0];
    const dominantShare =
      dominant === undefined
        ? 0
        : share(dominant[1], classifiedExported.length);
    const rolesShape: PrimitiveModuleFinding["composition"]["roles"] =
      classifiedExported.length === 0
        ? "none"
        : dominantShare >= policy.dedicatedRoleShare
          ? "single-role"
          : "mixed-role";
    const groups = new Set<string>();
    for (const entry of exported) {
      const group = scopeGroupOf(entry);
      if (group !== undefined) {
        groups.add(group);
      }
    }
    const scopesShape: PrimitiveModuleFinding["composition"]["scopes"] =
      groups.size === 0
        ? "none"
        : groups.size === 1
          ? "single-scope"
          : "mixed-scope";
    const served = new Map<string, number>();
    for (const entry of exported) {
      for (const id of responsibilitiesServed(entry)) {
        served.set(id, (served.get(id) ?? 0) + 1);
      }
    }
    const responsibilityList = [...served.entries()]
      .map(([id, symbols]) => ({ id, symbols }))
      .sort((a, b) => b.symbols - a.symbols || a.id.localeCompare(b.id));
    const localGroups = new Set(
      exported
        .filter((e) => e.scope === "responsibility-local")
        .map((e) => e.served?.responsibility ?? "")
    ).size;
    const countScope = (scope: ArchitecturalScopeClass) =>
      exported.filter((e) => e.scope === scope).length;
    const hubRoles = (candidates: ArchitecturalRole[]) => {
      const members = exported.filter((e) =>
        candidates.includes(e.primaryRole)
      );
      const regions = new Set(members.flatMap(responsibilitiesServed));
      return (
        members.length >= policy.hub.minimumSymbols &&
        regions.size >= policy.hub.minimumResponsibilities
      );
    };
    const shapes: PrimitiveModuleShape[] = [];
    if (isAggregator(module)) {
      shapes.push("aggregator");
    } else {
      if (hubRoles(PRIMITIVE_ROLES)) {
        shapes.push("primitive-hub");
      }
      if (hubRoles(["contract"])) {
        shapes.push("contract-hub");
      }
      if (hubRoles(["configuration"])) {
        shapes.push("configuration-hub");
      }
      const executable = classifiedExported.filter((e) =>
        EXECUTABLE_ROLES.includes(e.primaryRole)
      ).length;
      if (
        classifiedExported.length > 0 &&
        share(executable, classifiedExported.length) >=
          policy.dedicatedRoleShare
      ) {
        shapes.push("implementation-module");
      }
    }
    const colocations: ColocationPattern[] = [];
    const has = (predicate: (e: Classified) => boolean) =>
      entries.some(predicate);
    const contracts = entries.filter((e) => e.roles.includes("contract"));
    if (
      contracts.some((contract) =>
        (implementersOf.get(contract.facts.symbol.id) ?? []).some(
          (id) => factsById.get(id)?.module === module
        )
      )
    ) {
      colocations.push("contract+implementation");
    }
    if (
      has(
        (e) =>
          e.facts.symbol.kind === "type" &&
          (e.facts.declaration.typeQueries ?? []).some(
            (id) =>
              schemaSymbols.has(id) && factsById.get(id)?.module === module
          )
      )
    ) {
      colocations.push("schema+type");
    }
    const exportsBehavior = exported.some((e) =>
      EXECUTABLE_ROLES.includes(e.primaryRole)
    );
    const exportsTypes = exported.some((e) =>
      TYPE_FAMILY.includes(e.primaryRole)
    );
    if (exportsTypes && exportsBehavior) {
      colocations.push("type+behavior");
    }
    if (exported.some((e) => e.primaryRole === "constant") && exportsBehavior) {
      colocations.push("constant+behavior");
    }
    const evidence = moduleEvidence.get(module);
    const basename = basenameOf(module);
    const finding: PrimitiveModuleFinding = {
      basename,
      directory: evidence?.directory ?? directoryOf(module),
      module,
      pathRegion: evidence?.pathRegion ?? ROOT_DIRECTORY,
      ...(evidence?.region !== undefined && {
        responsibility: evidence.region,
      }),
      status: evidence?.status ?? "unresolved",
      ...(ambiguityByModule.has(module) && {
        ambiguity: ambiguityByModule.get(module),
      }),
      colocations,
      composition: {
        roles: rolesShape,
        scopes: scopesShape,
        ...(dominant !== undefined && {
          dominantRole: { role: dominant[0], share: dominantShare },
        }),
        scopeGroups: groups.size,
      },
      exportedSymbols: exported.length,
      fragmentation: {
        crossResponsibility: countScope("cross-responsibility"),
        localGroups,
        packageWide: countScope("package-wide"),
        unclear: countScope("unclear"),
        unplaced: countScope("unplaced"),
      },
      responsibilities: responsibilityList,
      roleBasename: policy.roleBasenames.includes(basename),
      roles: sortedPartial(roles),
      scopes: sortedPartial(scopes),
      shapes,
      symbols: entries.length,
      unresolvedSymbols: countScope("unplaced") + countScope("unclear"),
    };
    compositions.set(module, {
      finding,
      ...(rolesShape === "single-role" &&
        dominant !== undefined && { dedicatedRole: dominant[0] }),
      exportsBehavior,
      exportsTypes,
    });
  }

  // A directory is dedicated to a role when every module in it that exports
  // classified symbols is dedicated to that same role.
  const dedicatedDirectory = new Map<string, ArchitecturalRole>();
  const modulesByDirectory = new Map<string, ModuleComposition[]>();
  for (const composition of compositions.values()) {
    const list = modulesByDirectory.get(composition.finding.directory) ?? [];
    list.push(composition);
    modulesByDirectory.set(composition.finding.directory, list);
  }
  for (const [directory, list] of modulesByDirectory) {
    const contributing = list.filter(
      (c) => c.finding.composition.roles !== "none"
    );
    if (contributing.length === 0) {
      continue;
    }
    const role = contributing[0]?.dedicatedRole;
    if (
      role !== undefined &&
      contributing.every((c) => c.dedicatedRole === role)
    ) {
      dedicatedDirectory.set(directory, role);
    }
  }

  const placementOf = (
    entry: Classified
  ): ArchitecturalRoleFinding["placement"] => {
    const module = entry.facts.module;
    const composition = compositions.get(module);
    const directory = composition?.finding.directory ?? directoryOf(module);
    const moduleShape: PlacementModuleShape =
      composition?.dedicatedRole === entry.primaryRole
        ? "dedicated-role-module"
        : "mixed-role-module";
    const relative =
      entry.scope === "responsibility-local"
        ? entry.served?.responsibility
        : entry.moduleEvidence?.region;
    let directoryShape: PlacementDirectoryShape;
    if (aboveRegions(directory)) {
      directoryShape = "package-root";
    } else if (dedicatedDirectory.get(directory) === entry.primaryRole) {
      directoryShape = "dedicated-role-directory";
    } else if (relative === undefined) {
      directoryShape = "no-responsibility";
    } else if (
      !(regionById.get(relative)?.path.directories.includes(directory) ?? false)
    ) {
      directoryShape = "outside-responsibility";
    } else if (regionRoot.get(relative) === directory) {
      directoryShape = "responsibility-root";
    } else {
      directoryShape = "inside-responsibility";
    }
    const behaviorFamily = EXECUTABLE_ROLES.includes(entry.primaryRole);
    const colocation: PlacementColocationShape = behaviorFamily
      ? composition?.exportsTypes === true
        ? "with-types"
        : "without-types"
      : composition?.exportsBehavior === true
        ? "with-behavior"
        : "without-behavior";
    return {
      aggregatorExposed: (entry.facts.finding?.consumers.mediated ?? 0) > 0,
      basename: basenameOf(module),
      colocation,
      directory: directoryShape,
      module: moduleShape,
    };
  };

  const symbols: ArchitecturalRoleFinding[] = classified.map((entry) => {
    const { symbol, finding, context } = entry.facts;
    const module = entry.moduleEvidence;
    const relations: ArchitecturalRoleFinding["relations"] = {};
    if (entry.roles.includes("contract")) {
      const implementers = implementersOf.get(symbol.id) ?? [];
      const colocated = implementers.filter(
        (id) => factsById.get(id)?.module === entry.facts.module
      ).length;
      relations.implementers = {
        colocated,
        elsewhere: implementers.length - colocated,
      };
    }
    if (entry.roles.includes("schema")) {
      const derived = facts.filter(
        (other) =>
          other.symbol.kind === "type" &&
          (other.declaration.typeQueries ?? []).includes(symbol.id)
      );
      const colocated = derived.filter(
        (other) => other.module === entry.facts.module
      ).length;
      relations.derivedTypes = {
        colocated,
        elsewhere: derived.length - colocated,
      };
    }
    return {
      conceptSeed: seedKind.has(symbol.id),
      consumers: {
        modules: context?.consumerModules ?? finding?.consumers.modules ?? 0,
        pathRegions: finding?.consumers.regions ?? 0,
        responsibilities: entry.consumerResponsibilities,
        unresolvedModules: entry.unresolvedConsumers,
      },
      declaration: {
        directory: module?.directory ?? directoryOf(entry.facts.module),
        module: entry.facts.module,
        pathRegion: module?.pathRegion ?? ROOT_DIRECTORY,
        ...(module?.region !== undefined && { responsibility: module.region }),
        placed: module?.region !== undefined,
        status: module?.status ?? "unresolved",
      },
      exported: symbol.exported,
      kind: symbol.kind,
      name: symbol.name,
      primaryRole: entry.primaryRole,
      roles: entry.roles,
      scope: entry.scope,
      symbolId: symbol.id,
      ...(entry.served !== undefined && { served: entry.served }),
      ...(finding !== undefined && {
        locality: {
          distribution: finding.distribution,
          placement: finding.placement,
          usage: finding.usage,
        },
      }),
      ...(context !== undefined && { responsibilityContext: context.locality }),
      evidence: { roles: entry.roleEvidence, scope: entry.scopeEvidence },
      limitations: entry.limitations,
      placement: placementOf(entry),
      relations,
    };
  });

  // Conventions: per role and scope (and per role alone), per dimension.
  const conventionSymbols = symbols.filter(
    (s) =>
      s.primaryRole !== "unknown" &&
      (s.scope === "responsibility-local" ||
        s.scope === "cross-responsibility" ||
        s.scope === "package-wide")
  );
  const valueOf = (
    symbol: ArchitecturalRoleFinding,
    dimension: ConventionDimension
  ) =>
    dimension === "module"
      ? symbol.placement.module
      : dimension === "directory"
        ? symbol.placement.directory
        : symbol.placement.colocation;
  const conventions: PlacementConvention[] = [];
  const conventionGroups: ConventionGroup[] = [];
  const groupKeys = new Map<
    string,
    {
      role: ArchitecturalRole;
      scope: ArchitecturalScopeClass | "any";
      members: ArchitecturalRoleFinding[];
    }
  >();
  for (const symbol of conventionSymbols) {
    for (const scope of [symbol.scope, "any"] as (
      | ArchitecturalScopeClass
      | "any"
    )[]) {
      const key = `${symbol.primaryRole}/${scope}`;
      const group = groupKeys.get(key) ?? {
        members: [],
        role: symbol.primaryRole,
        scope,
      };
      group.members.push(symbol);
      groupKeys.set(key, group);
    }
  }
  for (const group of [...groupKeys.values()].sort(
    (a, b) =>
      ROLE_PRECEDENCE.indexOf(a.role) - ROLE_PRECEDENCE.indexOf(b.role) ||
      a.scope.localeCompare(b.scope)
  )) {
    const dimensions = {} as ConventionGroup["dimensions"];
    for (const dimension of DIMENSIONS) {
      const byValue = new Map<string, ArchitecturalRoleFinding[]>();
      for (const member of group.members) {
        const value = valueOf(member, dimension);
        const list = byValue.get(value) ?? [];
        list.push(member);
        byValue.set(value, list);
      }
      const values = [...byValue.entries()]
        .map(([value, members]) => ({ symbols: members.length, value }))
        .sort(
          (a, b) => b.symbols - a.symbols || a.value.localeCompare(b.value)
        );
      const qualifying = values.filter(
        (v) => v.symbols >= policy.conventions.minimumSupport
      );
      const ids: string[] = [];
      for (const { value } of qualifying) {
        const members = byValue.get(value) ?? [];
        const others = group.members.filter(
          (m) => valueOf(m, dimension) !== value
        );
        const basenames = new Map<string, number>();
        for (const member of members) {
          basenames.set(
            member.placement.basename,
            (basenames.get(member.placement.basename) ?? 0) + 1
          );
        }
        const responsibilityIds = sorted(
          members.flatMap((m) =>
            m.scope === "responsibility-local"
              ? [m.served?.responsibility ?? ""]
              : m.consumers.responsibilities
          )
        );
        const id = `${group.role}/${group.scope}/${dimension}=${value}`;
        ids.push(id);
        conventions.push({
          dimension,
          exceptions: {
            symbolIds: sorted(others.map((m) => m.symbolId)),
            symbols: others.length,
          },
          id,
          provenance: {
            basenames: [...basenames.entries()]
              .map(([basename, count]) => ({ basename, symbols: count }))
              .sort(
                (a, b) =>
                  b.symbols - a.symbols || a.basename.localeCompare(b.basename)
              )
              .slice(0, policy.report.topConventions),
          },
          role: group.role,
          scope: group.scope,
          support: {
            moduleIds: sorted(members.map((m) => m.declaration.module)),
            modules: new Set(members.map((m) => m.declaration.module)).size,
            responsibilities: responsibilityIds.length,
            responsibilityIds,
            symbolIds: sorted(members.map((m) => m.symbolId)),
            symbols: members.length,
          },
          value,
        });
      }
      dimensions[dimension] = {
        conventions: ids,
        status:
          qualifying.length === 0
            ? "insufficient-evidence"
            : qualifying.length === 1
              ? "convention"
              : "competing",
        values,
      };
    }
    conventionGroups.push({
      dimensions,
      role: group.role,
      scope: group.scope,
      symbols: group.members.length,
    });
  }
  conventions.sort(
    (a, b) => b.support.symbols - a.support.symbols || a.id.localeCompare(b.id)
  );

  const unresolved: PrimitiveAmbiguity[] = [];
  for (const entry of classified) {
    const id = entry.facts.symbol.id;
    if (entry.primaryRole === "unknown") {
      unresolved.push({
        detail: entry.facts.symbol.kind,
        reason: "no-role-evidence",
        symbolId: id,
      });
    }
    if (entry.namingDisagrees !== undefined) {
      unresolved.push({
        detail: `name suggests ${entry.namingDisagrees}; structure says ${entry.primaryRole}`,
        reason: "naming-disagrees",
        symbolId: id,
      });
    }
    if (entry.scope === "unclear") {
      unresolved.push({
        detail:
          entry.facts.context === undefined
            ? entry.facts.symbol.packagePublic
              ? "package-public, no internal consumer"
              : "exported, no internal consumer"
            : `${entry.unresolvedConsumers} unresolved consumers`,
        reason:
          entry.facts.context === undefined
            ? "no-internal-consumers"
            : "no-placed-consumers",
        symbolId: id,
      });
    }
  }
  unresolved.sort(
    (a, b) =>
      a.symbolId.localeCompare(b.symbolId) ||
      AMBIGUITY_REASONS.indexOf(a.reason) - AMBIGUITY_REASONS.indexOf(b.reason)
  );

  const modules = [...compositions.values()]
    .map((c) => c.finding)
    .sort((a, b) => a.module.localeCompare(b.module));

  const summary = summarize(
    symbols,
    modules,
    conventionGroups,
    unresolved,
    responsibilities
  );

  return {
    conventionGroups,
    conventions,
    limitations: [
      "use of a symbol inside its own module is not measured, so module-local says only that nothing else can reach it",
      "external consumers are outside the package boundary; a package-public symbol with no internal consumer is unclear, not package-wide",
      "adapter evidence is limited to a held contract property type; conversion behavior is not recognized",
      "representation reuses the V7 relationship kinds (extension, alias, typeof a schema); row, record, and DTO shapes without such a relationship stay type",
      "configuration is told from constant by the annotated type's name or the value's name; there is no structural signature for settings",
    ],
    modules,
    package: responsibilities.package,
    policy: {
      conventions: policy.conventions,
      dedicatedRoleShare: policy.dedicatedRoleShare,
      hub: policy.hub,
      moduleShapeUniverse:
        "exported symbols; private declarations count in totals only",
      naming:
        "supporting evidence only; a disagreement with structural evidence is recorded, never applied",
      packageWide: {
        minimumResponsibilities: policy.packageWide.minimumResponsibilities,
        responsibilityShare: policy.packageWide.responsibilityShare,
        threshold: packageWideThreshold,
      },
      roleBasenames: policy.roleBasenames,
      roleDefinitions: ROLE_DEFINITIONS,
      rolePrecedence: ROLE_PRECEDENCE,
      roles: ROLES,
      schemaLibraries: policy.schemaLibraries,
      scopeDefinitions: SCOPE_DEFINITIONS,
      scopes: SCOPES,
      symbolUniverse: "top-level declarations of primary modules",
      technicalRoots: topology.policy.technicalRoots,
      utility: policy.utility,
    },
    schemaVersion: PRIMITIVE_CONVENTION_SCHEMA_VERSION,
    summary,
    symbols,
    unresolved,
  };
}

function summarize(
  symbols: ArchitecturalRoleFinding[],
  modules: PrimitiveModuleFinding[],
  groups: ConventionGroup[],
  unresolved: PrimitiveAmbiguity[],
  responsibilities: InternalResponsibilityReport
): PrimitiveConventionSummary {
  const byRole = zeroRecord(ROLES);
  const byScope = zeroRecord(SCOPES);
  const matrix = Object.fromEntries(
    ROLES.map((role) => [role, zeroRecord(SCOPES)])
  ) as PrimitiveConventionSummary["matrix"];
  const limitations = zeroRecord(LIMITATIONS);
  let multiRole = 0;
  for (const symbol of symbols) {
    byRole[symbol.primaryRole] += 1;
    byScope[symbol.scope] += 1;
    matrix[symbol.primaryRole][symbol.scope] += 1;
    if (symbol.roles.length > 1) {
      multiRole += 1;
    }
    for (const limitation of symbol.limitations) {
      limitations[limitation] += 1;
    }
  }
  const byModuleShape = zeroRecord(MODULE_SHAPES);
  const byColocation = zeroRecord(COLOCATIONS);
  const rolesComposition = zeroRecord([
    "single-role",
    "mixed-role",
    "none",
  ] as const);
  const scopesComposition = zeroRecord([
    "single-scope",
    "mixed-scope",
    "none",
  ] as const);
  let misleading = 0;
  for (const module of modules) {
    rolesComposition[module.composition.roles] += 1;
    scopesComposition[module.composition.scopes] += 1;
    for (const shape of module.shapes) {
      byModuleShape[shape] += 1;
    }
    for (const pattern of module.colocations) {
      byColocation[pattern] += 1;
    }
    if (module.roleBasename && module.composition.scopes === "mixed-scope") {
      misleading += 1;
    }
  }
  const conventionCounts = (scoped: boolean) => {
    const counts = { ...zeroRecord(CONVENTION_STATUSES), observed: 0 };
    for (const group of groups) {
      if ((group.scope === "any") === scoped) {
        continue;
      }
      for (const dimension of DIMENSIONS) {
        const entry = group.dimensions[dimension];
        counts[entry.status] += 1;
        counts.observed += entry.conventions.length;
      }
    }
    return counts;
  };
  const unresolvedModules = new Set(
    responsibilities.unresolved.map((u) => u.module)
  );
  const unresolvedByShape = zeroRecord(MODULE_SHAPES);
  let explained = 0;
  let mixedScope = 0;
  for (const module of modules) {
    if (!unresolvedModules.has(module.module)) {
      continue;
    }
    const isMixed = module.composition.scopes === "mixed-scope";
    if (isMixed) {
      mixedScope += 1;
    }
    for (const shape of module.shapes) {
      unresolvedByShape[shape] += 1;
    }
    if (isMixed || module.shapes.length > 0) {
      explained += 1;
    }
  }
  const byAmbiguity = zeroRecord(AMBIGUITY_REASONS);
  for (const entry of unresolved) {
    byAmbiguity[entry.reason] += 1;
  }
  return {
    byAmbiguity,
    byColocation,
    byModuleComposition: { roles: rolesComposition, scopes: scopesComposition },
    byModuleShape,
    byRole,
    byScope,
    conventions: {
      roleAlone: conventionCounts(false),
      roleAndScope: conventionCounts(true),
    },
    exportedSymbols: symbols.filter((s) => s.exported).length,
    limitations,
    matrix,
    misleadingRoleBasenames: misleading,
    modules: modules.length,
    multiRoleSymbols: multiRole,
    symbols: symbols.length,
    unresolvedModules: {
      byShape: unresolvedByShape,
      explained,
      mixedScope,
      total: unresolvedModules.size,
      unexplained: unresolvedModules.size - explained,
    },
  };
}

export function getSymbolRole(
  report: PrimitiveConventionReport,
  symbolId: string
): ArchitecturalRoleFinding | undefined {
  return report.symbols.find((symbol) => symbol.symbolId === symbolId);
}

export function getModulePrimitives(
  report: PrimitiveConventionReport,
  module: string
):
  | {
      module: PrimitiveModuleFinding;
      symbols: ArchitecturalRoleFinding[];
    }
  | undefined {
  const finding = report.modules.find((entry) => entry.module === module);
  if (finding === undefined) {
    return undefined;
  }
  return {
    module: finding,
    symbols: report.symbols.filter(
      (symbol) => symbol.declaration.module === module
    ),
  };
}

export function getSymbolsByRole(
  report: PrimitiveConventionReport,
  role: ArchitecturalRole,
  scope?: ArchitecturalScopeClass
): ArchitecturalRoleFinding[] {
  return report.symbols.filter(
    (symbol) =>
      symbol.primaryRole === role &&
      (scope === undefined || symbol.scope === scope)
  );
}

export function getConventions(
  report: PrimitiveConventionReport,
  role: ArchitecturalRole,
  scope: ArchitecturalScopeClass | "any" = "any"
): PlacementConvention[] {
  return report.conventions.filter(
    (convention) => convention.role === role && convention.scope === scope
  );
}
