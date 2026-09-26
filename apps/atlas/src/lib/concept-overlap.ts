import * as path from "node:path";
import type { Project, Type } from "ts-morph";

import { Node, SyntaxKind, ts } from "ts-morph";

import type { Boundary } from "./boundary";
import { ownerBoundary, toPosix } from "./boundary";
import type { AnalysisConfig } from "./config";
import { ANALYSIS_CONFIG } from "./config";
import type { CollectedSymbol } from "./symbols";
import type {
  ChangeCouplingReport,
  ConceptAssignability,
  ConceptConversion,
  ConceptFamily,
  ConceptIdentity,
  ConceptInventoryReport,
  ConceptNameAffinity,
  ConceptOverlapCandidate,
  ConceptOverlapDimension,
  ConceptOverlapDistributionContext,
  ConceptOverlapEvidence,
  ConceptOverlapReport,
  ConceptOverlapShape,
  ConceptOverlapTemporalContext,
  ConceptOverlapUsageContext,
  ConceptPropertyOverlap,
  ConceptSeedKind,
  ConceptShape,
  FileChangeCouplingPair,
} from "./types";

export interface ConceptOverlapSource {
  boundary: Boundary;
  changeCoupling: ChangeCouplingReport;
  conceptInventory: ConceptInventoryReport;
  project: Project;
  /** Target symbol inventory with declaration nodes; seeds are matched by id. */
  symbols: CollectedSymbol[];
}

/** Everything the gate needs about one pair; produced by extraction, or by tests. */
export interface OverlapFacts {
  assignability?: ConceptAssignability;
  conversions: ConceptConversion[];
  distributionContext?: ConceptOverlapDistributionContext;
  left: ConceptIdentity;
  name?: ConceptNameAffinity;
  right: ConceptIdentity;
  structure?: ConceptPropertyOverlap;
  temporalContext?: ConceptOverlapTemporalContext;
  usage?: ConceptOverlapUsageContext;
}

const DIMENSION_ORDER: ConceptOverlapDimension[] = [
  "name",
  "structure",
  "usage",
  "conversion",
  "distribution",
  "temporal",
];

/** Split camelCase, PascalCase, snake_case, and kebab-case into lowercase tokens. */
export function nameTokens(name: string): string[] {
  return name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(" ")
    .filter((token) => token !== "");
}

function keyTokens(name: string, generic: Set<string>): string[] {
  return [...new Set(nameTokens(name).filter((token) => !generic.has(token)))];
}

export function nameAffinity(
  left: string,
  right: string,
  config: AnalysisConfig = ANALYSIS_CONFIG
): ConceptNameAffinity | undefined {
  const generic = new Set(config.conceptOverlap.name.genericTokens);
  const a = keyTokens(left, generic);
  const b = new Set(keyTokens(right, generic));
  const shared = a.filter((token) => b.has(token)).sort();
  if (shared.length === 0) {
    return undefined;
  }
  const union = new Set([...a, ...b]).size;
  return { jaccard: shared.length / union, sharedTokens: shared };
}

function jaccard(shared: number, left: number, right: number): number {
  const union = left + right - shared;
  return union === 0 ? 0 : shared / union;
}

/**
 * Decide whether the facts about one pair make an overlap candidate, and
 * describe it. Pure policy: dimensions count distinct evidence dimensions,
 * name alone never qualifies, history alone never qualifies.
 */
export function assessOverlap(
  facts: OverlapFacts,
  config: AnalysisConfig = ANALYSIS_CONFIG
): ConceptOverlapCandidate | undefined {
  const policy = config.conceptOverlap;
  const evidence: ConceptOverlapEvidence[] = [];

  if (
    facts.name !== undefined &&
    facts.name.jaccard >= policy.name.minJaccard
  ) {
    evidence.push({
      dimension: "name",
      kind: "name-token-overlap",
      value: facts.name.sharedTokens,
    });
  }

  const structure = facts.structure;
  // Base Error properties are shared by every error; only own properties
  // say anything about the pair.
  const meaningfulShared =
    structure === undefined
      ? 0
      : structure.shared.length - structure.baseShared.length;
  const propertyGate =
    structure !== undefined &&
    meaningfulShared >= policy.properties.minSharedProperties &&
    structure.jaccard >= policy.properties.minJaccard;
  if (structure !== undefined && propertyGate) {
    evidence.push({
      dimension: "structure",
      kind: "property-overlap",
      value: structure.jaccard,
    });
  }
  const errorsWithoutOwnOverlap =
    structure !== undefined &&
    structure.baseShared.length > 0 &&
    meaningfulShared === 0;
  const assignable =
    facts.assignability !== undefined &&
    facts.assignability !== "neither" &&
    !errorsWithoutOwnOverlap;
  if (facts.assignability !== undefined && assignable) {
    evidence.push({
      dimension: "structure",
      kind: "assignability",
      value: facts.assignability,
    });
  }

  for (const conversion of facts.conversions) {
    evidence.push({
      dimension: "conversion",
      kind: "conversion",
      value: `${conversion.function}: ${conversion.from} → ${conversion.to}`,
    });
  }

  if (
    facts.usage !== undefined &&
    (facts.usage.sharedConsumers.length > 0 ||
      facts.usage.sharedModules.length > 0)
  ) {
    evidence.push({
      dimension: "usage",
      kind: "shared-consumer",
      value:
        facts.usage.sharedConsumers.length > 0
          ? facts.usage.sharedConsumers
          : facts.usage.sharedModules,
    });
  }

  if (
    facts.distributionContext !== undefined &&
    facts.distributionContext.sharedPackages.length >= 2
  ) {
    evidence.push({
      dimension: "distribution",
      kind: "distribution-overlap",
      value: facts.distributionContext.sharedPackages,
    });
  }

  if (facts.temporalContext !== undefined) {
    evidence.push({
      dimension: "temporal",
      kind: "temporal-coupling",
      value: facts.temporalContext.coChangeCommits,
    });
  }

  const dimensions = DIMENSION_ORDER.filter((dimension) =>
    evidence.some((item) => item.dimension === dimension)
  );
  const hasConversion = facts.conversions.length > 0;
  if (
    dimensions.length < policy.gates.minEvidenceDimensions ||
    !(propertyGate || assignable || hasConversion)
  ) {
    return undefined;
  }

  const shapes: ConceptOverlapShape[] = [];
  // Mutual assignability of `{ status }` with `{ status }` is not equivalence
  // of ideas; the shape has to carry enough own properties to mean something.
  const nearEquivalent =
    meaningfulShared >= policy.shapes.minSharedProperties &&
    (facts.assignability === "both" ||
      (structure !== undefined &&
        structure.jaccard >= policy.shapes.nearEquivalentMinJaccard &&
        structure.compatibleShared.length === structure.shared.length));
  if (nearEquivalent) {
    shapes.push("near-equivalent");
  }
  // Subset share is over type-compatible shared properties: the smaller
  // shape must exist inside the larger one, not merely reuse its names.
  const smaller =
    structure === undefined
      ? 0
      : Math.min(
          structure.shared.length + structure.leftOnly.length,
          structure.shared.length + structure.rightOnly.length
        );
  const subsetShare =
    structure === undefined || smaller === 0
      ? 0
      : structure.compatibleShared.length / smaller;
  const projectionLike =
    !nearEquivalent &&
    ((facts.assignability !== undefined &&
      facts.assignability !== "both" &&
      facts.assignability !== "neither") ||
      (structure !== undefined &&
        meaningfulShared >= policy.shapes.minSharedProperties &&
        subsetShare >= policy.shapes.projectionMinSubsetShare));
  if (projectionLike) {
    shapes.push("projection-like");
  }
  if (hasConversion) {
    shapes.push("conversion-pair");
  }
  if ((propertyGate || assignable) && !nearEquivalent && !projectionLike) {
    shapes.push("structurally-overlapping");
  }

  const forward = new Set(
    facts.conversions.map((item) => `${item.from}>${item.to}`)
  );
  const bidirectionalConversion = facts.conversions.some((item) =>
    forward.has(`${item.to}>${item.from}`)
  );

  return {
    crossPackage: facts.left.package !== facts.right.package,
    dimensions,
    evidence,
    left: facts.left,
    right: facts.right,
    shapes,
    ...(facts.name !== undefined && { name: facts.name }),
    ...(structure !== undefined && { structure }),
    ...(facts.assignability !== undefined && {
      assignability: facts.assignability,
    }),
    bidirectionalConversion,
    conversions: facts.conversions,
    ...(facts.usage !== undefined && { usage: facts.usage }),
    ...(facts.distributionContext !== undefined && {
      distributionContext: facts.distributionContext,
    }),
    ...(facts.temporalContext !== undefined && {
      temporalContext: facts.temporalContext,
    }),
  };
}

export function sortCandidates(
  candidates: ConceptOverlapCandidate[]
): ConceptOverlapCandidate[] {
  return [...candidates].sort(
    (a, b) =>
      b.dimensions.length - a.dimensions.length ||
      (b.structure?.jaccard ?? -1) - (a.structure?.jaccard ?? -1) ||
      Number(b.conversions.length > 0) - Number(a.conversions.length > 0) ||
      a.left.id.localeCompare(b.left.id) ||
      a.right.id.localeCompare(b.right.id)
  );
}

interface Declaration {
  /** Identity with `inTarget` false; the per-target pass sets it. */
  identity: ConceptIdentity;
  keyTokens: string[];
  node: Node;
  /** Targets this declaration seeds; empty for every other workspace declaration. */
  seedOf: string[];
  /** Property names read from syntax; drives the index without the checker. */
  syntaxProperties: string[];
}

function seedKindOf(node: Node): ConceptSeedKind | undefined {
  if (Node.isInterfaceDeclaration(node)) {
    return "interface";
  }
  if (Node.isTypeAliasDeclaration(node)) {
    return "type";
  }
  if (Node.isClassDeclaration(node)) {
    return "class";
  }
  if (Node.isEnumDeclaration(node)) {
    return "enum";
  }
  return undefined;
}

/**
 * A property keyed by a unique symbol is named `__@name@<symbol id>` by the
 * checker, and the id is an allocation counter of the program that resolved
 * it — different for every program, meaningless to a reader. Only the name
 * is a fact about the type. Applied to the report only: matching and
 * lookups keep the checker's name, since the id is what tells two unique
 * symbols with the same name apart.
 */
function stablePropertyName(name: string): string {
  return name.replace(/^(__@[^@]+)@\d+$/, "$1");
}

function syntaxProperties(node: Node): string[] {
  const names: string[] = [];
  const push = (member: Node) => {
    if (Node.hasName(member)) {
      names.push(member.getName());
    }
  };
  if (Node.isInterfaceDeclaration(node)) {
    for (const member of node.getMembers()) {
      push(member);
    }
  } else if (Node.isClassDeclaration(node)) {
    for (const member of node.getMembers()) {
      push(member);
    }
  } else if (Node.isTypeAliasDeclaration(node)) {
    const typeNode = node.getTypeNode();
    if (typeNode !== undefined && Node.isTypeLiteral(typeNode)) {
      for (const member of typeNode.getMembers()) {
        push(member);
      }
    }
  }
  return [...new Set(names)];
}

function unwrap(type: Type, wrappers: Set<string>): Type {
  let current = type;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current.isArray()) {
      const element = current.getArrayElementType();
      if (element === undefined) {
        return current;
      }
      current = element;
      continue;
    }
    const name =
      current.getSymbol()?.getName() ?? current.getAliasSymbol()?.getName();
    const args = current.getTypeArguments();
    const aliasArgs = current.getAliasTypeArguments();
    if (name !== undefined && wrappers.has(name)) {
      const inner = args[0] ?? aliasArgs[0];
      if (inner === undefined) {
        return current;
      }
      current = inner;
      continue;
    }
    return current;
  }
  return current;
}

/**
 * Overlap candidates between the target's seeds and any type-like declaration
 * in the workspace. Pairs come from four deterministic indexes (name tokens,
 * property names, converter signatures, coupled declaration files); only
 * proposed pairs are compared, and the pure gate decides. Families are never
 * merged: a strong candidate is still two families plus one candidate.
 */
export function analyzeConceptOverlap(
  source: ConceptOverlapSource,
  config: AnalysisConfig = ANALYSIS_CONFIG
): ConceptOverlapReport {
  const { boundary } = source;
  const target = boundary.packageName ?? boundary.relPath;
  const familyIds = new Set(
    source.conceptInventory.families.map((family) => family.seed.id)
  );
  const seedTargets = new Map<ts.Node, string[]>();
  for (const symbol of source.symbols) {
    if (familyIds.has(symbol.id)) {
      seedTargets.set(symbol.node.compilerNode, [target]);
    }
  }
  const index = buildConceptOverlapIndex(
    source.project,
    boundary.root,
    seedTargets,
    config
  );
  return analyzeConceptOverlapFromIndex(index, source, config);
}

/**
 * The workspace half of overlap analysis, built once and shared by every
 * target: every type-like declaration with its name-token and property
 * indexes, every converter signature, and the shape/assignability caches.
 * `seedTargets` names which declarations seed which targets.
 */
export interface ConceptOverlapIndex {
  assignable: (from: Type, to: Type) => boolean;
  byFile: Map<string, Declaration[]>;
  conversionIndex: Map<string, ConceptConversion[]>;
  conversionPartners: Map<Declaration, Set<Declaration>>;
  declarations: Declaration[];
  isErrorLike: (declaration: Declaration) => boolean;
  nameIndex: Map<string, Declaration[]>;
  propertyIndex: Map<string, Declaration[]>;
  root: string;
  /** Memoized per declaration; a shape does not depend on the target asking. */
  shapeOf: (declaration: Declaration) => ConceptShape | undefined;
  typeOf: (declaration: Declaration) => Type;
}

export function buildConceptOverlapIndex(
  project: Project,
  root: string,
  seedTargets: Map<ts.Node, string[]>,
  config: AnalysisConfig = ANALYSIS_CONFIG
): ConceptOverlapIndex {
  const policy = config.conceptOverlap;
  const generic = new Set(policy.name.genericTokens);
  const common = new Set(policy.properties.commonNames);
  const wrappers = new Set(policy.conversion.wrappers);
  const checker = project.getTypeChecker();

  const declarations: Declaration[] = [];
  const byNode = new Map<unknown, Declaration>();
  const byFile = new Map<string, Declaration[]>();
  const nameIndex = new Map<string, Declaration[]>();
  const propertyIndex = new Map<string, Declaration[]>();
  const conversionIndex = new Map<string, ConceptConversion[]>();
  const conversionPartners = new Map<Declaration, Set<Declaration>>();

  const files = project
    .getSourceFiles()
    .filter(
      (file) =>
        !(
          file.isDeclarationFile() ||
          file.getFilePath().includes("/node_modules/")
        )
    );

  for (const file of files) {
    const filePath = file.getFilePath();
    const relFile = toPosix(path.relative(root, filePath));
    const owner = ownerBoundary(root, filePath);
    const nodes: Node[] = [
      ...file.getInterfaces(),
      ...file.getTypeAliases(),
      ...file.getClasses(),
      ...file.getEnums(),
    ];
    for (const node of nodes) {
      const kind = seedKindOf(node);
      if (kind === undefined || !Node.hasName(node)) {
        continue;
      }
      const name = node.getName();
      const id = `${relFile}#${name}`;
      const declaration: Declaration = {
        identity: {
          file: relFile,
          id,
          inTarget: false,
          kind,
          name,
          package: owner,
        },
        keyTokens: keyTokens(name, generic),
        node,
        seedOf: seedTargets.get(node.compilerNode) ?? [],
        syntaxProperties: syntaxProperties(node),
      };
      declarations.push(declaration);
      byNode.set(node.compilerNode, declaration);
      const inFile = byFile.get(relFile);
      if (inFile === undefined) {
        byFile.set(relFile, [declaration]);
      } else {
        inFile.push(declaration);
      }
      for (const token of declaration.keyTokens) {
        const bucket = nameIndex.get(token);
        if (bucket === undefined) {
          nameIndex.set(token, [declaration]);
        } else {
          bucket.push(declaration);
        }
      }
      for (const property of declaration.syntaxProperties) {
        if (common.has(property)) {
          continue;
        }
        const bucket = propertyIndex.get(property);
        if (bucket === undefined) {
          propertyIndex.set(property, [declaration]);
        } else {
          bucket.push(declaration);
        }
      }
    }
  }

  const declarationOfType = (type: Type): Declaration | undefined => {
    const inner = unwrap(type, wrappers);
    const symbol = inner.getAliasSymbol() ?? inner.getSymbol();
    for (const declaration of symbol?.getDeclarations() ?? []) {
      const found = byNode.get(declaration.compilerNode);
      if (found !== undefined) {
        return found;
      }
    }
    return undefined;
  };

  const recordConversion = (
    label: string,
    relFile: string,
    parameters: Node[],
    returnType: Type
  ) => {
    const to = declarationOfType(returnType);
    if (to === undefined) {
      return;
    }
    for (const parameter of parameters) {
      const from = declarationOfType(parameter.getType());
      if (from === undefined || from === to) {
        continue;
      }
      if (from.seedOf.length === 0 && to.seedOf.length === 0) {
        continue;
      }
      const key = `${from.identity.id}|${to.identity.id}`;
      const conversion: ConceptConversion = {
        file: relFile,
        from: from.identity.id,
        function: label,
        to: to.identity.id,
      };
      const list = conversionIndex.get(key);
      if (list === undefined) {
        conversionIndex.set(key, [conversion]);
      } else {
        list.push(conversion);
      }
      for (const [a, b] of [
        [from, to],
        [to, from],
      ] as const) {
        const partners = conversionPartners.get(a);
        if (partners === undefined) {
          conversionPartners.set(a, new Set([b]));
        } else {
          partners.add(b);
        }
      }
    }
  };

  for (const file of files) {
    const relFile = toPosix(path.relative(root, file.getFilePath()));
    for (const fn of file.getFunctions()) {
      const name = fn.getName();
      if (name === undefined) {
        continue;
      }
      recordConversion(name, relFile, fn.getParameters(), fn.getReturnType());
    }
    for (const cls of file.getClasses()) {
      const className = cls.getName();
      if (className === undefined) {
        continue;
      }
      for (const method of cls.getMethods()) {
        recordConversion(
          `${className}.${method.getName()}`,
          relFile,
          method.getParameters(),
          method.getReturnType()
        );
      }
    }
    for (const variable of file.getVariableDeclarations()) {
      const initializer = variable.getInitializer();
      if (
        initializer === undefined ||
        !(
          Node.isArrowFunction(initializer) ||
          Node.isFunctionExpression(initializer)
        )
      ) {
        continue;
      }
      recordConversion(
        variable.getName(),
        relFile,
        initializer.getParameters(),
        initializer.getReturnType()
      );
    }
  }

  const shapes = new Map<Declaration, ConceptShape | undefined>();
  const typeOf = (declaration: Declaration): Type => declaration.node.getType();
  const errorLike = new Map<Declaration, boolean>();
  const derivesFromError = (type: Type, depth = 0): boolean =>
    depth < 8 &&
    type
      .getBaseTypes()
      .some(
        (base) =>
          base.getSymbol()?.getName() === "Error" ||
          derivesFromError(base, depth + 1)
      );
  const isErrorLike = (declaration: Declaration): boolean => {
    let known = errorLike.get(declaration);
    if (known === undefined) {
      known = derivesFromError(typeOf(declaration));
      errorLike.set(declaration, known);
    }
    return known;
  };
  const objectLike = (type: Type): boolean => {
    if (type.isObject()) {
      return true;
    }
    const flags = type.compilerType.flags;
    if (flags & ts.TypeFlags.Union) {
      return type.getUnionTypes().every(objectLike);
    }
    if (flags & ts.TypeFlags.Intersection) {
      return type.getIntersectionTypes().every(objectLike);
    }
    return false;
  };
  const shapeOf = (declaration: Declaration): ConceptShape | undefined => {
    if (shapes.has(declaration)) {
      return shapes.get(declaration);
    }
    let shape: ConceptShape | undefined;
    if (
      declaration.identity.kind !== "enum" &&
      objectLike(typeOf(declaration))
    ) {
      const type = typeOf(declaration);
      // The checker lists properties in resolution order, which depends on
      // what was resolved before; name order is the same on every program.
      const properties = type
        .getProperties()
        .map((property) => {
          const propertyDeclaration = property.getDeclarations()[0];
          const propertyType = property.getTypeAtLocation(declaration.node);
          return {
            callable: propertyType.getCallSignatures().length > 0,
            name: property.getName(),
            optional: property.isOptional(),
            readonly:
              propertyDeclaration !== undefined &&
              Node.isModifierable(propertyDeclaration) &&
              propertyDeclaration.hasModifier(SyntaxKind.ReadonlyKeyword),
            typeFingerprint: propertyType.getText(declaration.node),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      if (properties.length > 0) {
        shape = { properties };
      }
    }
    shapes.set(declaration, shape);
    return shape;
  };
  const assignable = (from: Type, to: Type): boolean =>
    checker.compilerObject.isTypeAssignableTo(
      from.compilerType,
      to.compilerType
    );

  return {
    assignable,
    byFile,
    conversionIndex,
    conversionPartners,
    declarations,
    isErrorLike,
    nameIndex,
    propertyIndex,
    root,
    shapeOf,
    typeOf,
  };
}

/** Overlap candidates for one target against a prebuilt workspace index. */
export function analyzeConceptOverlapFromIndex(
  index: ConceptOverlapIndex,
  source: Pick<
    ConceptOverlapSource,
    "boundary" | "conceptInventory" | "changeCoupling"
  >,
  config: AnalysisConfig = ANALYSIS_CONFIG
): ConceptOverlapReport {
  const policy = config.conceptOverlap;
  const { boundary } = source;
  const target = boundary.packageName ?? boundary.relPath;
  const common = new Set(policy.properties.commonNames);
  const {
    declarations,
    byFile,
    nameIndex,
    propertyIndex,
    conversionIndex,
    conversionPartners,
    typeOf,
    shapeOf,
    isErrorLike,
    assignable,
  } = index;
  const inTarget = (declaration: Declaration): boolean =>
    declaration.seedOf.includes(target);
  const identityOf = (declaration: Declaration): ConceptIdentity => ({
    ...declaration.identity,
    inTarget: inTarget(declaration),
  });
  const familyById = new Map(
    source.conceptInventory.families.map((family) => [family.seed.id, family])
  );

  const couplingByFile = new Map<string, FileChangeCouplingPair[]>();
  if (source.changeCoupling.available) {
    for (const pair of source.changeCoupling.filePairs) {
      for (const file of [pair.left, pair.right]) {
        const list = couplingByFile.get(file);
        if (list === undefined) {
          couplingByFile.set(file, [pair]);
        } else {
          list.push(pair);
        }
      }
    }
  }

  const familyMembers = (family: ConceptFamily | undefined): Set<string> =>
    new Set(
      (family?.representations ?? [])
        .filter(
          (item) =>
            item.relationship === "implementation" ||
            item.relationship === "extension" ||
            item.relationship === "alias"
        )
        .map((item) => item.symbolId)
    );

  // Two implementations of one contract share its shape by construction;
  // such siblings are the contract's family, not an overlap between concepts.
  const familiesOfMember = new Map<string, Set<string>>();
  for (const family of source.conceptInventory.families) {
    for (const member of familyMembers(family)) {
      const set = familiesOfMember.get(member);
      if (set === undefined) {
        familiesOfMember.set(member, new Set([family.seed.id]));
      } else {
        set.add(family.seed.id);
      }
    }
  }
  const siblings = (a: Declaration, b: Declaration): boolean => {
    const left = familiesOfMember.get(a.identity.id);
    const right = familiesOfMember.get(b.identity.id);
    if (left === undefined || right === undefined) {
      return false;
    }
    return [...left].some((id) => right.has(id));
  };

  const seeds = declarations.filter(inTarget);
  const generated = { conversion: 0, name: 0, property: 0, temporal: 0 };
  const pairs = new Map<string, [Declaration, Declaration]>();
  const propose = (
    left: Declaration,
    right: Declaration,
    generator: keyof typeof generated
  ) => {
    if (left === right) {
      return;
    }
    generated[generator] += 1;
    const [a, b] =
      inTarget(right) && right.identity.id < left.identity.id
        ? [right, left]
        : [left, right];
    const key = `${a.identity.id}|${b.identity.id}`;
    if (pairs.has(key)) {
      return;
    }
    if (
      familyMembers(familyById.get(a.identity.id)).has(b.identity.id) ||
      familyMembers(familyById.get(b.identity.id)).has(a.identity.id) ||
      siblings(a, b)
    ) {
      return;
    }
    pairs.set(key, [a, b]);
  };

  for (const seed of seeds) {
    for (const token of seed.keyTokens) {
      const bucket = nameIndex.get(token) ?? [];
      if (bucket.length > policy.generation.maxIndexFanout) {
        continue;
      }
      for (const other of bucket) {
        propose(seed, other, "name");
      }
    }
    const sharedCounts = new Map<Declaration, number>();
    for (const property of seed.syntaxProperties) {
      if (common.has(property)) {
        continue;
      }
      const bucket = propertyIndex.get(property) ?? [];
      if (bucket.length > policy.generation.maxIndexFanout) {
        continue;
      }
      for (const other of bucket) {
        sharedCounts.set(other, (sharedCounts.get(other) ?? 0) + 1);
      }
    }
    for (const [other, count] of sharedCounts) {
      if (count >= policy.properties.minSharedProperties) {
        propose(seed, other, "property");
      }
    }
    for (const other of conversionPartners.get(seed) ?? []) {
      propose(seed, other, "conversion");
    }
    for (const pair of couplingByFile.get(seed.identity.file) ?? []) {
      const otherFile =
        pair.left === seed.identity.file ? pair.right : pair.left;
      for (const other of byFile.get(otherFile) ?? []) {
        propose(seed, other, "temporal");
      }
    }
  }

  const errorBase = new Set(policy.properties.errorBaseNames);

  const dataLike = (shape: ConceptShape | undefined): boolean =>
    shape?.properties.some((property) => !property.callable) ?? false;

  const compare = (left: Declaration, right: Declaration): OverlapFacts => {
    const leftShape = shapeOf(left);
    const rightShape = shapeOf(right);
    // A signature taking a contract and returning an entity is an accessor,
    // not a representation change; conversions need data shapes on both sides.
    const conversions =
      dataLike(leftShape) && dataLike(rightShape)
        ? [
            ...(conversionIndex.get(
              `${left.identity.id}|${right.identity.id}`
            ) ?? []),
            ...(conversionIndex.get(
              `${right.identity.id}|${left.identity.id}`
            ) ?? []),
          ]
        : [];
    const facts: OverlapFacts = {
      conversions,
      left: identityOf(left),
      right: identityOf(right),
    };
    const affinity = nameAffinity(
      left.identity.name,
      right.identity.name,
      config
    );
    if (affinity !== undefined) {
      facts.name = affinity;
    }

    if (leftShape !== undefined && rightShape !== undefined) {
      const rightByName = new Map(
        rightShape.properties.map((property) => [property.name, property])
      );
      const shared: string[] = [];
      const compatibleShared: string[] = [];
      const leftOnly: string[] = [];
      for (const property of leftShape.properties) {
        const match = rightByName.get(property.name);
        if (match === undefined) {
          leftOnly.push(property.name);
          continue;
        }
        shared.push(property.name);
        if (property.typeFingerprint === match.typeFingerprint) {
          compatibleShared.push(property.name);
          continue;
        }
        const leftType = typeOf(left)
          .getProperty(property.name)
          ?.getTypeAtLocation(left.node);
        const rightType = typeOf(right)
          .getProperty(property.name)
          ?.getTypeAtLocation(right.node);
        if (
          leftType !== undefined &&
          rightType !== undefined &&
          (assignable(leftType, rightType) || assignable(rightType, leftType))
        ) {
          compatibleShared.push(property.name);
        }
      }
      const sharedSet = new Set(shared);
      const rightOnly = rightShape.properties
        .map((property) => property.name)
        .filter((name) => !sharedSet.has(name));
      const baseShared =
        isErrorLike(left) && isErrorLike(right)
          ? shared.filter((name) => errorBase.has(name))
          : [];
      facts.structure = {
        baseShared: baseShared.map(stablePropertyName),
        compatibleShared: compatibleShared.map(stablePropertyName),
        jaccard: jaccard(
          shared.length,
          leftShape.properties.length,
          rightShape.properties.length
        ),
        leftOnly: leftOnly.map(stablePropertyName),
        rightOnly: rightOnly.map(stablePropertyName),
        shared: shared.map(stablePropertyName),
        sharedOverLeft: shared.length / leftShape.properties.length,
        sharedOverRight: shared.length / rightShape.properties.length,
      };
      const leftToRight = assignable(typeOf(left), typeOf(right));
      const rightToLeft = assignable(typeOf(right), typeOf(left));
      facts.assignability =
        leftToRight && rightToLeft
          ? "both"
          : leftToRight
            ? "left-to-right"
            : rightToLeft
              ? "right-to-left"
              : "neither";
    }

    const leftFamily = familyById.get(left.identity.id);
    const rightFamily = familyById.get(right.identity.id);
    if (leftFamily !== undefined && rightFamily !== undefined) {
      // The converter itself references both sides; it is conversion evidence,
      // not an independent shared consumer.
      const exclude = new Set([
        left.identity.id,
        right.identity.id,
        ...conversions.flatMap((item) => [
          `${item.file}#${item.function}`,
          `${item.file}#${item.function.split(".")[0] ?? item.function}`,
        ]),
      ]);
      const sources = (family: ConceptFamily) =>
        new Set(
          family.evidence
            .filter((item) => item.source !== undefined)
            .map((item) => item.source?.symbolId ?? "")
            .filter((id) => !exclude.has(id))
        );
      const rightSources = sources(rightFamily);
      const sharedConsumers = [...sources(leftFamily)]
        .filter((id) => rightSources.has(id))
        .sort();
      const declarationFiles = new Set([
        left.identity.file,
        right.identity.file,
      ]);
      const rightModules = new Set(rightFamily.distribution.modules);
      const sharedModules = leftFamily.distribution.modules
        .filter((file) => rightModules.has(file) && !declarationFiles.has(file))
        .sort();
      facts.usage = { sharedConsumers, sharedModules };
      const rightPackages = new Set(rightFamily.distribution.packages);
      const sharedPackages = leftFamily.distribution.packages
        .filter((name) => rightPackages.has(name))
        .sort();
      facts.distributionContext = {
        packageJaccard: jaccard(
          sharedPackages.length,
          leftFamily.distribution.packages.length,
          rightFamily.distribution.packages.length
        ),
        sharedModules: leftFamily.distribution.modules
          .filter((file) => rightModules.has(file))
          .sort(),
        sharedPackages,
      };
    }

    if (left.identity.file !== right.identity.file) {
      const pair = (couplingByFile.get(left.identity.file) ?? []).find(
        (item) =>
          item.left === right.identity.file ||
          item.right === right.identity.file
      );
      if (pair !== undefined) {
        const leftIsLeft = pair.left === left.identity.file;
        facts.temporalContext = {
          coChangeCommits: pair.coChangeCommits,
          context: pair.context,
          jaccard: pair.jaccard,
          leftConditional: leftIsLeft
            ? pair.leftConditional
            : pair.rightConditional,
          rightConditional: leftIsLeft
            ? pair.rightConditional
            : pair.leftConditional,
          staticPath: pair.staticPath,
        };
      }
    }
    return facts;
  };

  const candidates: ConceptOverlapCandidate[] = [];
  for (const [left, right] of pairs.values()) {
    const candidate = assessOverlap(compare(left, right), config);
    if (candidate !== undefined) {
      candidates.push(candidate);
    }
  }
  const sorted = sortCandidates(candidates);
  const withShape = (shape: ConceptOverlapShape) =>
    sorted.filter((candidate) => candidate.shapes.includes(shape)).length;

  return {
    candidates: sorted,
    generation: {
      candidates: sorted.length,
      indexedDeclarations: declarations.length,
      pairsCompared: pairs.size,
      pairsGenerated: { ...generated, total: pairs.size },
      seeds: seeds.length,
    },
    summary: {
      bidirectionalConversionPairs: sorted.filter(
        (item) => item.bidirectionalConversion
      ).length,
      candidates: sorted.length,
      conversionPairs: withShape("conversion-pair"),
      crossPackageCandidates: sorted.filter((item) => item.crossPackage).length,
      nearEquivalent: withShape("near-equivalent"),
      projectionLike: withShape("projection-like"),
      structurallyOverlapping: withShape("structurally-overlapping"),
    },
    target,
  };
}
