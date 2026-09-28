import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";
import { classifyFile } from "./file-kind";
import { composeArchitecturalOperators } from "./operator-composition";
import type {
  ComposedStructuralAction,
  CompositionPreservation,
  OperatorComposition,
} from "./operator-composition-types";
import { layers } from "./operator-decomposition";
import type { OperatorDecomposition } from "./operator-decomposition-types";
import type { ExposureRoutes, ImportSite } from "./operator-plan-source";
import {
  cyclesThrough,
  exposureRoutes,
  hasSideEffects,
  importSitesOf,
  movementClosure,
  packageImportEdges,
  relativeSpecifier,
  remainingDeclarations,
} from "./operator-plan-source";
import type {
  OperatorExecutionPlan,
  OperatorExecutionPlanStatus,
  OperatorExecutionPlanValidation,
  OperatorPlanBlocker,
  OperatorPlanBlockerKind,
  OperatorPlanConflict,
  OperatorPlanDiagnostics,
  OperatorPlanFingerprint,
  OperatorPlanGap,
  OperatorPlanGapKind,
  OperatorPlanTarget,
  PlannedArchitecturalDelta,
  PlannedBehaviorMember,
  PlannedBehaviorMemberRole,
  PlannedDeltaDimension,
  PlannedImportRewrite,
  PlannedMovementClosure,
  PlannedMovementGranularity,
  PlannedPreservation,
  PlannedRelocation,
  PlannedSourceState,
  PlannedTransformation,
  PlannedTransformationDependency,
  PlannedTransformationDependencyKind,
  PlannedTransformationKind,
  PlannedVerificationKind,
  PlannedVerificationStep,
  StructuralActionRealization,
} from "./operator-plan-types";
import {
  OPERATOR_PLAN_SCHEMA_VERSION,
  OPERATOR_PLANNING_POLICY_VERSION,
} from "./operator-plan-types";
import type {
  LocatedSymbol,
  OperatorPlanningContext,
  OperatorPlanningPackage,
} from "./operator-planning-context";
import {
  exportedNamesOf,
  hashFile,
  locateSymbol,
  packageOfFile,
  sourceFileOf,
} from "./operator-planning-context";
import type {
  ArchitecturalOperator,
  OperatorContext,
  OperatorEffectDimension,
  OperatorFact,
} from "./operator-types";
import { topLevelDeclarations } from "./symbols";
import type { ConceptFamily, PublicExposureRoute } from "./types";
import { byId, sorted } from "./workspace-projection";

// V11.3 planner: walks a composition's actions in graph order and resolves
// each against the shared project into exact transformations. Every
// resolution rule that chooses a file or a surface strategy lives in one
// named function here; nothing chooses architecture, and nothing writes.

function hash16(parts: unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 16);
}

function uniq(values: string[]): string[] {
  return sorted(values);
}

function isTestFile(file: string): boolean {
  return classifyFile(file) === "test";
}

function isManifest(file: string): boolean {
  return file.endsWith("package.json");
}

const SOURCE_ONLY_KINDS = new Set<PlannedTransformationKind>(["verify-only"]);

// ---------------------------------------------------------------------------
// Assembly

interface TransformationInput {
  action: ComposedStructuralAction;
  after?: PlannedSourceState;
  before?: PlannedSourceState;
  detail: string;
  file: string;
  form?: string;
  kind: PlannedTransformationKind;
  /** Extra preservation ids beyond the action's own. */
  preserves?: string[];
  status?: PlannedTransformation["status"];
  subject?: PlannedTransformation["subject"];
}

interface Landing {
  file: string;
  package: string;
  symbol: LocatedSymbol;
}

interface AddedEdge {
  actions: string[];
  from: string;
  runtime: boolean;
  to: string;
  transformations: string[];
}

class Assembly {
  readonly transformations = new Map<string, PlannedTransformation>();
  readonly dependencies: PlannedTransformationDependency[] = [];
  readonly relocations: PlannedRelocation[] = [];
  readonly importRewrites: PlannedImportRewrite[] = [];
  readonly blockers: OperatorPlanBlocker[] = [];
  readonly conflicts: OperatorPlanConflict[] = [];
  readonly gaps: OperatorPlanGap[] = [];
  readonly filesRead = new Set<string>();
  readonly addedEdges: AddedEdge[] = [];
  /** `${from}→${to}` → import sites the plan rewrites away, with the rewrites. */
  readonly removedSites = new Map<
    string,
    { count: number; transformations: string[]; actions: string[] }
  >();
  /** Preservation id → verification steps that prove it, registered by realizers. */
  readonly proofs = new Map<string, string[]>();
  readonly forms = new Map<string, number>();
  readonly unsupportedForms = new Set<string>();
  readonly byAction = new Map<string, Set<string>>();
  /** Concept id → relocation records, filled by the placement pass. */
  readonly relocationsByConcept = new Map<string, PlannedRelocation[]>();
  /** Symbol id → where it lands; several entries when actions disagree, which is a conflict. */
  readonly landing = new Map<string, Landing[]>();

  land(symbolId: string, landing: Landing): void {
    const list = this.landing.get(symbolId) ?? [];
    if (!list.some((l) => l.file === landing.file)) {
      list.push(landing);
    }
    this.landing.set(symbolId, list);
  }

  landings(symbolId: string): Landing[] {
    return this.landing.get(symbolId) ?? [];
  }

  landingIn(symbolId: string, pkg: string): Landing | undefined {
    return this.landings(symbolId).find((l) => l.package === pkg);
  }

  landed(symbolId: string): boolean {
    return this.landings(symbolId).length > 0;
  }

  add(input: TransformationInput): PlannedTransformation {
    const id = `transformation:${hash16([
      input.kind,
      input.file,
      input.subject ?? null,
      input.before ?? null,
      input.after ?? null,
    ])}`;
    const resultStatus3 = input.status ?? actionStatus(input.action);
    const existing = this.transformations.get(id);
    const preserves = uniq([
      ...input.action.preserves,
      ...(input.preserves ?? []),
    ]);
    if (existing === undefined) {
      this.transformations.set(id, {
        file: input.file,
        id,
        kind: input.kind,
        ...(input.subject !== undefined && { subject: input.subject }),
        ...(input.before !== undefined && { before: input.before }),
        ...(input.after !== undefined && { after: input.after }),
        detail: input.detail,
        ...(input.form !== undefined && { form: input.form }),
        actions: [input.action.id],
        evidence: [...input.action.evidence],
        preconditions: input.action.preconditions.map((p) => ({
          entityIds: [...p.entityIds],
          kind: p.kind,
        })),
        preserves,
        status: resultStatus3,
      });
    } else {
      existing.actions = uniq([...existing.actions, input.action.id]);
      existing.preserves = uniq([...existing.preserves, ...preserves]);
      existing.status = strongerStatus(existing.status, resultStatus3);
      for (const e of input.action.evidence) {
        if (
          !existing.evidence.some(
            (x) =>
              x.source === e.source &&
              x.entityIds.join(",") === e.entityIds.join(",")
          )
        ) {
          existing.evidence.push(e);
        }
      }
    }
    this.filesRead.add(input.file);
    this.link(input.action.id, id);
    if (input.form !== undefined) {
      this.form(input.form);
    }
    if (resultStatus3 === "unsupported" && input.form !== undefined) {
      this.unsupportedForms.add(input.form);
    }
    const transformation = this.transformations.get(id);
    if (transformation === undefined) {
      throw new Error("unreachable");
    }
    return transformation;
  }

  link(actionId: string, transformationId: string): void {
    const set = this.byAction.get(actionId) ?? new Set<string>();
    set.add(transformationId);
    this.byAction.set(actionId, set);
  }

  form(form: string): void {
    this.forms.set(form, (this.forms.get(form) ?? 0) + 1);
  }

  depend(
    before: string,
    after: string,
    kind: PlannedTransformationDependencyKind,
    reason: string
  ): void {
    if (before === after) {
      return;
    }
    if (
      this.dependencies.some((d) => d.before === before && d.after === after)
    ) {
      return;
    }
    this.dependencies.push({ after, before, kind, reason });
  }

  block(
    kind: OperatorPlanBlockerKind,
    actions: string[],
    entities: string[],
    detail: string
  ): void {
    if (
      this.blockers.some(
        (b) =>
          b.kind === kind &&
          b.entities.join(",") === uniq(entities).join(",") &&
          b.detail === detail
      )
    ) {
      const existing = this.blockers.find(
        (b) =>
          b.kind === kind &&
          b.entities.join(",") === uniq(entities).join(",") &&
          b.detail === detail
      );
      if (existing !== undefined) {
        existing.actions = uniq([...existing.actions, ...actions]);
      }
      return;
    }
    this.blockers.push({
      actions: uniq(actions),
      detail,
      entities: uniq(entities),
      kind,
    });
  }

  gap(
    kind: OperatorPlanGapKind,
    actions: string[],
    entities: string[],
    detail: string
  ): void {
    if (
      this.gaps.some(
        (g) =>
          g.kind === kind &&
          g.entities.join(",") === uniq(entities).join(",") &&
          g.detail === detail
      )
    ) {
      return;
    }
    this.gaps.push({
      actions: uniq(actions),
      detail,
      entities: uniq(entities),
      kind,
    });
  }

  edge(
    from: string,
    to: string,
    runtime: boolean,
    transformation: string,
    action: string
  ): void {
    if (from === to) {
      return;
    }
    const existing = this.addedEdges.find(
      (e) => e.from === from && e.to === to
    );
    if (existing === undefined) {
      this.addedEdges.push({
        actions: [action],
        from,
        runtime,
        to,
        transformations: [transformation],
      });
      return;
    }
    existing.runtime = existing.runtime || runtime;
    existing.transformations = uniq([
      ...existing.transformations,
      transformation,
    ]);
    existing.actions = uniq([...existing.actions, action]);
  }

  removeSite(
    from: string,
    to: string,
    transformation: string,
    action: string
  ): void {
    if (from === to) {
      return;
    }
    const id = `${from}→${to}`;
    const entry = this.removedSites.get(id) ?? {
      actions: [],
      count: 0,
      transformations: [],
    };
    entry.count += 1;
    entry.transformations = uniq([...entry.transformations, transformation]);
    entry.actions = uniq([...entry.actions, action]);
    this.removedSites.set(id, entry);
  }
}

function actionStatus(
  action: ComposedStructuralAction
): PlannedTransformation["status"] {
  return action.status === "conditional" ? "conditional" : "required";
}

function strongerStatus(
  a: PlannedTransformation["status"],
  b: PlannedTransformation["status"]
): PlannedTransformation["status"] {
  const order = ["required", "conditional", "unsupported"];
  return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

// ---------------------------------------------------------------------------
// Planner state

interface Planner {
  acc: Assembly;
  composition: OperatorComposition;
  context: OperatorPlanningContext;
  facts: OperatorContext;
  operators: Map<string, ArchitecturalOperator>;
}

function packageOf(
  planner: Planner,
  id: string | undefined
): OperatorPlanningPackage | undefined {
  return id === undefined ? undefined : planner.context.packages.get(id);
}

function rootEntrypoint(
  pkg: OperatorPlanningPackage
): { entrypoint: string; file: string } | undefined {
  return (
    pkg.entrypoints.find((e) => e.entrypoint === pkg.id) ?? pkg.entrypoints[0]
  );
}

function conceptOf(action: ComposedStructuralAction): string | undefined {
  const { subject } = action;
  switch (subject.kind) {
    case "concept":
    case "behavior":
      return subject.conceptId;
    case "exposure":
    case "dependency":
    case "boundary":
      return subject.conceptId;
    case "symbol":
    case "package":
      return undefined;
    default:
      throw new Error("Unexpected subject.kind.");
  }
}

function symbolOf(
  planner: Planner,
  id: string,
  action: ComposedStructuralAction
): LocatedSymbol | undefined {
  const located = locateSymbol(planner.context, id);
  if (located.status === "located") {
    planner.acc.filesRead.add(located.symbol.file);
    return located.symbol;
  }
  planner.acc.block(
    located.status === "ambiguous"
      ? "ambiguous-symbol"
      : "source-state-mismatch",
    [action.id],
    [id],
    located.detail
  );
  return undefined;
}

// ---------------------------------------------------------------------------
// Behavior members

function referencesSymbol(node: Node | undefined, target: Node): boolean {
  if (node === undefined) {
    return false;
  }
  return node
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .concat(Node.isIdentifier(node) ? [node] : [])
    .some((identifier) => {
      const symbol = identifier.getSymbol();
      if (symbol === undefined) {
        return false;
      }
      const resolved = symbol.getAliasedSymbol() ?? symbol;
      return resolved.getDeclarations().includes(target);
    });
}

/**
 * Governing behavior of a concept in one package, from the sources: classes
 * implementing the concept and functions returning it. Functions that only
 * take the concept as a parameter are generic consumers and stay.
 */
function behaviorMembers(
  planner: Planner,
  concept: LocatedSymbol,
  pkg: OperatorPlanningPackage
): { members: PlannedBehaviorMember[]; symbols: LocatedSymbol[] } {
  const members: PlannedBehaviorMember[] = [];
  const symbols: LocatedSymbol[] = [];
  const files = [...planner.context.moduleIndex]
    .filter(([file, owner]) => owner === pkg.id && !isTestFile(file))
    .map(([file]) => file)
    .sort(byId);
  for (const file of files) {
    const sourceFile = sourceFileOf(planner.context, file);
    if (sourceFile === undefined) {
      continue;
    }
    behaviorMembersDeclaration(
      sourceFile,
      concept,
      file,
      planner,
      members,
      symbols
    );
  }
  return { members, symbols };
}

// ---------------------------------------------------------------------------
// Target module resolution (§10–13): one ordered rule list, no name similarity.

interface TargetResolution {
  candidates: string[];
  isNew: boolean;
  module?: string;
  rule: string;
}

function behaviorMembersDeclaration(
  sourceFile: SourceFile,
  concept: LocatedSymbol,
  file: string,
  planner: Planner,
  members: PlannedBehaviorMember[],
  symbols: LocatedSymbol[]
) {
  for (const declaration of topLevelDeclarations(sourceFile)) {
    if (!Node.hasName(declaration)) {
      continue;
    }

    const {
      role,
      source,
    }: {
      role: PlannedBehaviorMember["role"] | undefined;
      source: PlannedBehaviorMember["source"] | undefined;
    } = behaviorMembersDeclarationEntries(
      declaration,
      concept,
      undefined,
      undefined
    );
    if (role === undefined || source === undefined) {
      continue;
    }
    const id = `${file}#${declaration.getName()}`;
    const located = locateSymbol(planner.context, id);
    if (located.status !== "located") {
      continue;
    }
    members.push({ role, source, symbolId: id });
    symbols.push(located.symbol);
  }
}

function behaviorMembersDeclarationEntries(
  declaration: Node & { getName(): string; getNameNode(): Node },
  concept: LocatedSymbol,
  initialRole: PlannedBehaviorMemberRole | undefined,
  initialSource:
    | "concept-declaration"
    | "behavior-participant"
    | "representation"
    | undefined
): {
  role: PlannedBehaviorMemberRole | undefined;
  source:
    | "concept-declaration"
    | "behavior-participant"
    | "representation"
    | undefined;
} {
  let source = initialSource;
  let role = initialRole;
  if (Node.isClassDeclaration(declaration)) {
    const implementsConcept = declaration
      .getImplements()
      .some((clause) => referencesSymbol(clause, concept.node));
    if (implementsConcept) {
      role = "implementation";
      source = "behavior-participant";
    }
  } else if (Node.isFunctionDeclaration(declaration)) {
    if (referencesSymbol(declaration.getReturnTypeNode(), concept.node)) {
      role = "factory";
      source = "behavior-participant";
    }
  } else if (Node.isVariableDeclaration(declaration)) {
    const initializer = declaration.getInitializer();
    if (
      initializer !== undefined &&
      (Node.isArrowFunction(initializer) ||
        Node.isFunctionExpression(initializer)) &&
      referencesSymbol(initializer.getReturnTypeNode(), concept.node)
    ) {
      role = "factory";
      source = "behavior-participant";
    }
  }
  return { role, source };
}

function resolveTargetModule(
  planner: Planner,
  input: {
    conceptId?: string;
    concept?: LocatedSymbol;
    target: OperatorPlanningPackage;
    source: OperatorPlanningPackage;
    sourceFile: string;
  }
): TargetResolution {
  const { context, facts } = planner;
  const inTarget = (file: string) =>
    packageOfFile(context, file) === input.target.id && !isTestFile(file);
  const entrypointFiles = new Set(input.target.entrypoints.map((e) => e.file));

  // 1. The concept's own declaring module, when it sits in the target.
  if (input.conceptId !== undefined) {
    const concept = facts.projection.lookup.conceptById.get(input.conceptId);
    if (
      concept?.package === input.target.id &&
      inTarget(concept.file) &&
      sourceFileOf(context, concept.file) !== undefined
    ) {
      return {
        candidates: [concept.file],
        isNew: false,
        module: concept.file,
        rule: "concept-declaration-module",
      };
    }
    // 2. Modules in the target holding representations of the concept (V7 family).
    const home = concept?.package;
    const family =
      home === undefined
        ? undefined
        : facts.reportsByPackage
            .get(home)
            ?.conceptInventory.families.find(
              (f) => f.seed.id === input.conceptId
            );
    if (family !== undefined) {
      const resolution = resolveRepresentationModule(
        family,
        inTarget,
        entrypointFiles
      );
      if (resolution !== undefined) {
        return resolution;
      }
    }
  }
  // 3. The single non-entrypoint module in the target that imports the concept today.
  if (input.concept !== undefined) {
    const importers = uniq(
      importSitesOf(context, input.concept)
        .filter(
          (s) =>
            s.form === "import" &&
            inTarget(s.file) &&
            !entrypointFiles.has(s.file)
        )
        .map((s) => s.file)
    );
    if (importers.length === 1) {
      return {
        candidates: importers,
        isNew: false,
        module: importers[0],
        rule: "importer-module",
      };
    }
    if (importers.length > 1) {
      return {
        candidates: importers,
        isNew: false,
        rule: "importer-modules-ambiguous",
      };
    }
  }
  // 4. A new module mirroring the source module's path under the target's source dir.
  if (input.target.sourceDir !== undefined) {
    const { sourceDir } = input.source;
    const relative = resolveTargetModuleEntries(sourceDir, input);
    const candidate = `${input.target.sourceDir}/${relative}`;
    if (sourceFileOf(context, candidate) === undefined) {
      return {
        candidates: [candidate],
        isNew: true,
        module: candidate,
        rule: "mirrored-new-module",
      };
    }
    return {
      candidates: [candidate],
      isNew: false,
      rule: "mirrored-module-exists",
    };
  }
  return { candidates: [], isNew: false, rule: "no-source-dir" };
}

// ---------------------------------------------------------------------------
// Relocation

interface RelocationInput {
  action: ComposedStructuralAction;
  concept?: LocatedSymbol;
  conceptId?: string;
  members: PlannedBehaviorMember[];
  source: OperatorPlanningPackage;
  symbols: LocatedSymbol[];
  target: OperatorPlanningPackage;
}

function resolveTargetModuleEntries(
  sourceDir: string | undefined,
  input: {
    conceptId?: string;
    concept?: LocatedSymbol;
    target: OperatorPlanningPackage;
    source: OperatorPlanningPackage;
    sourceFile: string;
  }
) {
  return sourceDir !== undefined && input.sourceFile.startsWith(`${sourceDir}/`)
    ? input.sourceFile.slice(sourceDir.length + 1)
    : posix.basename(input.sourceFile);
}

function resolveTargetModuleRep(
  family: ConceptFamily,
  inTarget: (file: string) => boolean,
  entrypointFiles: Set<string>,
  counts: Map<string, number>
) {
  for (const rep of family.representations) {
    if (!inTarget(rep.file) || entrypointFiles.has(rep.file)) {
      continue;
    }
    counts.set(rep.file, (counts.get(rep.file) ?? 0) + 1);
  }
}

function realizeRelocation(planner: Planner, input: RelocationInput): void {
  const { acc, context } = planner;
  const { action } = input;
  const byFile = new Map<string, LocatedSymbol[]>();
  for (const symbol of input.symbols) {
    const list = byFile.get(symbol.file) ?? [];
    list.push(symbol);
    byFile.set(symbol.file, list);
  }
  const movingFiles = new Set(byFile.keys());
  const records: PlannedRelocation[] = [];

  realizeRelocationEntries(
    byFile,
    acc,
    context,
    input,
    planner,
    action,
    records,
    movingFiles
  );
  if (input.conceptId !== undefined) {
    const list = acc.relocationsByConcept.get(input.conceptId) ?? [];
    list.push(...records);
    acc.relocationsByConcept.set(input.conceptId, list);
  }
  acc.relocations.push(...records);
}

function realizeRelocationEntries(
  byFile: Map<string, LocatedSymbol[]>,
  acc: Assembly,
  context: OperatorPlanningContext,
  input: RelocationInput,
  planner: Planner,
  action: ComposedStructuralAction,
  records: PlannedRelocation[],
  movingFiles: Set<string>
) {
  for (const [file, symbols] of [...byFile].sort(([a], [b]) => byId(a, b))) {
    const sourceFile = symbols[0]?.sourceFile;
    if (sourceFile === undefined) {
      continue;
    }
    acc.filesRead.add(file);
    const { closure, internalNodes } = movementClosure(context, {
      roots: symbols,
      sourcePackage: input.source.id,
      targetPackage: input.target.id,
    });
    const resolution = resolveTargetModule(
      planner,
      realizeRelocationEntriesEntries2(input, file)
    );
    const moving = new Set<Node>([
      ...symbols.map((s) => s.node),
      ...internalNodes,
    ]);
    const remaining = remainingDeclarations(sourceFile, moving);
    const sideEffects = hasSideEffects(sourceFile);
    let granularity: PlannedMovementGranularity = "unresolved";
    const record: PlannedRelocation = realizeRelocationEntriesEntries3(
      action,
      input,
      file,
      resolution,
      closure,
      granularity
    );
    records.push(record);

    if (resolution.module === undefined) {
      acc.gap(
        "target-module-unresolved",
        [action.id],
        [input.target.id, ...resolution.candidates],
        resolution.candidates.length === 0
          ? `${input.target.id} has no module the ${resolution.rule} rule can pick for ${file}`
          : `${resolution.rule}: ${resolution.candidates.join(", ")}`
      );
      continue;
    }
    if (!closure.complete) {
      acc.gap(
        "closure-incomplete",
        [action.id],
        closure.sharedInternalSymbols,
        `${closure.sharedInternalSymbols.join(", ")} stay in ${file} for the remaining code and are needed by the moved code; extraction or an export is a separate decision`
      );
      continue;
    }
    if (sideEffects) {
      acc.block(
        "module-mixed-responsibility",
        [action.id],
        [file],
        `${file} runs code on load (a bare import or a top-level statement); moving declarations out cannot prove the execution order holds`
      );
      continue;
    }
    const targetModule = resolution.module;
    const wholeModule = remaining.length === 0 && resolution.isNew;
    granularity = resolveRealizeRelocationEntries(wholeModule, resolution);

    const targetFile = sourceFileOf(context, targetModule);
    if (targetFile !== undefined) {
      acc.filesRead.add(targetModule);
      const declared = new Set(
        topLevelDeclarations(targetFile)
          .filter((d) => Node.hasName(d))
          .map((d) => (Node.hasName(d) ? d.getName() : ""))
      );
      const colliding = [...moving]
        .filter((n) => Node.hasName(n) && declared.has(n.getName()))
        .map((n) => (Node.hasName(n) ? n.getName() : ""))
        .sort(byId);
      if (colliding.length > 0) {
        acc.conflicts.push({
          actions: [action.id],
          detail: `${targetModule} already declares ${colliding.join(", ")}; a different symbol under the same name cannot land there without a rename, which is a separate intent`,
          entities: colliding.map((n) => `${targetModule}#${n}`),
          kind: "target-module-collision",
          transformations: [],
        });
        acc.block(
          "target-module-collision",
          [action.id],
          colliding.map((n) => `${targetModule}#${n}`),
          `${targetModule} already declares ${colliding.join(", ")}`
        );
        continue;
      }
    }
    record.granularity = granularity;

    const subject = (symbolId: string) => ({
      symbolId,
      ...(input.conceptId !== undefined && { conceptId: input.conceptId }),
    });

    const created: PlannedTransformation | undefined =
      realizeRelocationEntriesEntries4(
        resolution,
        wholeModule,
        undefined,
        acc,
        action,
        targetModule,
        input,
        symbols,
        file
      );
    const moves: PlannedTransformation[] = [];
    realizeRelocationEntriesEntries(
      wholeModule,
      acc,
      action,
      targetModule,
      input,
      file,
      moves,
      symbols,
      internalNodes,
      sourceFile,
      subject,
      created,
      remaining
    );
    for (const symbol of symbols) {
      acc.land(symbol.id, {
        file: targetModule,
        package: input.target.id,
        symbol,
      });
    }

    // Closure: what the moved code imports from where it lands.
    realizeRelocationEntriesDependency(
      closure,
      context,
      input,
      acc,
      action,
      moves
    );

    // Import sites: target-package importers become local; what stays behind
    // in the source imports the target; consumers belong to redirect actions.
    realizeRelocationEntriesSymbol(
      symbols,
      context,
      movingFiles,
      acc,
      input,
      planner,
      action,
      moves,
      targetModule
    );
  }
}

function realizeRelocationEntriesEntries4(
  resolution: TargetResolution,
  wholeModule: boolean,
  initialCreated: PlannedTransformation | undefined,
  acc: Assembly,
  action: ComposedStructuralAction,
  targetModule: string,
  input: RelocationInput,
  symbols: LocatedSymbol[],
  file: string
) {
  let created = initialCreated;
  if (resolution.isNew && !wholeModule) {
    created = acc.add({
      action,
      after: { module: targetModule, package: input.target.id },
      detail: `create ${targetModule} in ${input.target.id} for ${symbols.map((s) => s.name).join(", ")} (mirrors ${file}; no existing module holds the concept)`,
      file: targetModule,
      form: "new-module",
      kind: "create-module",
      subject: { moduleId: targetModule, packageId: input.target.id },
    });
  }
  return created;
}

function realizeRelocationEntriesEntries3(
  action: ComposedStructuralAction,
  input: RelocationInput,
  file: string,
  resolution: TargetResolution,
  closure: PlannedMovementClosure,
  granularity: PlannedRelocation["granularity"]
): PlannedRelocation {
  return {
    actionId: action.id,
    ...(input.conceptId !== undefined && { conceptId: input.conceptId }),
    members: input.members.filter((m) => m.symbolId.startsWith(`${file}#`)),
    sourceModule: file,
    sourcePackage: input.source.id,
    targetPackage: input.target.id,
    ...(resolution.module !== undefined && {
      targetModule: resolution.module,
    }),
    closure,
    granularity,
    strategy: "unresolved",
    targetResolution: resolution.rule,
  };
}

function realizeRelocationEntriesEntries2(
  input: RelocationInput,
  file: string
): {
  conceptId?: string;
  concept?: LocatedSymbol;
  target: OperatorPlanningPackage;
  source: OperatorPlanningPackage;
  sourceFile: string;
} {
  return {
    ...(input.conceptId !== undefined && { conceptId: input.conceptId }),
    ...(input.concept !== undefined && { concept: input.concept }),
    source: input.source,
    sourceFile: file,
    target: input.target,
  };
}

function realizeRelocationEntriesDependency(
  closure: PlannedMovementClosure,
  context: OperatorPlanningContext,
  input: RelocationInput,
  acc: Assembly,
  action: ComposedStructuralAction,
  moves: PlannedTransformation[]
) {
  for (const dependency of closure.externalDependencies) {
    switch (dependency.class) {
      case "import-from-target-package":
      case "external":
        break;
      case "import-from-source-package": {
        const located = locateSymbol(context, dependency.id);
        const exposed =
          located.status === "located" &&
          exposureRoutes(context, input.source, located.symbol).routes.length >
            0;
        if (!exposed && located.status === "located") {
          acc.block(
            "package-export-strategy-unresolved",
            [action.id],
            [dependency.id],
            `the moved code needs ${dependency.name} from ${input.source.id}, which no entrypoint of ${input.source.id} exposes; exposing it widens the surface, a separate intent`
          );
        }
        for (const move of moves) {
          acc.edge(
            input.target.id,
            input.source.id,
            !dependency.typeOnly,
            move.id,
            action.id
          );
        }
        break;
      }
      case "import-from-third-package":
        if (dependency.package !== undefined) {
          for (const move of moves) {
            acc.edge(
              input.target.id,
              dependency.package,
              !dependency.typeOnly,
              move.id,
              action.id
            );
          }
        }
        break;
      case "move-with":
        break;
      default:
        throw new Error("Unexpected dependency.class.");
    }
  }
}

function realizeRelocationEntriesSymbol(
  symbols: LocatedSymbol[],
  context: OperatorPlanningContext,
  movingFiles: Set<string>,
  acc: Assembly,
  input: RelocationInput,
  planner: Planner,
  action: ComposedStructuralAction,
  moves: PlannedTransformation[],
  targetModule: string
) {
  for (const symbol of symbols) {
    realizeRelocationEntriesSymbolSite(
      context,
      symbol,
      movingFiles,
      acc,
      input,
      planner,
      action,
      moves,
      targetModule
    );
  }
}

function realizeRelocationEntriesSymbolSite(
  context: OperatorPlanningContext,
  symbol: LocatedSymbol,
  movingFiles: Set<string>,
  acc: Assembly,
  input: RelocationInput,
  planner: Planner,
  action: ComposedStructuralAction,
  moves: PlannedTransformation[],
  targetModule: string
) {
  const visitSite = (site: ImportSite) =>
    resolveVisitSite(
      movingFiles,
      acc,
      input,
      planner,
      action,
      moves,
      targetModule,
      symbol,
      site
    );
  for (const site of importSitesOf(context, symbol)) {
    visitSite(site);
  }
}

function realizeRelocationEntriesEntries(
  wholeModule: boolean,
  acc: Assembly,
  action: ComposedStructuralAction,
  targetModule: string,
  input: RelocationInput,
  file: string,
  moves: PlannedTransformation[],
  symbols: LocatedSymbol[],
  internalNodes: Node[],
  sourceFile: SourceFile,
  subject: (symbolId: string) => {
    conceptId?: string | undefined;
    symbolId: string;
  },
  created: PlannedTransformation | undefined,
  remaining: Node[]
) {
  if (wholeModule) {
    const move = acc.add({
      action,
      after: { module: targetModule, package: input.target.id },
      before: { module: file, package: input.source.id },
      detail: `move ${file} whole to ${targetModule}: every declaration belongs to the relocation`,
      file,
      form: "module-move",
      kind: "move-module",
      subject: {
        moduleId: file,
        packageId: input.source.id,
        ...(input.conceptId !== undefined && { conceptId: input.conceptId }),
      },
    });
    moves.push(move);
  } else {
    realizeRelocationEntriesEntriesNode(
      symbols,
      internalNodes,
      file,
      acc,
      action,
      targetModule,
      input,
      sourceFile,
      subject,
      moves,
      created
    );
    if (remaining.length === 0) {
      const remove = acc.add({
        action,
        before: { module: file, package: input.source.id },
        detail: `${file} holds nothing once its declarations move`,
        file,
        form: "empty-module",
        kind: "delete-empty-module",
        subject: { moduleId: file, packageId: input.source.id },
      });
      for (const move of moves) {
        acc.depend(
          move.id,
          remove.id,
          "requires",
          "the module empties before it goes"
        );
      }
    }
  }
}

function realizeRelocationEntriesEntriesNode(
  symbols: LocatedSymbol[],
  internalNodes: Node[],
  file: string,
  acc: Assembly,
  action: ComposedStructuralAction,
  targetModule: string,
  input: RelocationInput,
  sourceFile: SourceFile,
  subject: (symbolId: string) => {
    conceptId?: string | undefined;
    symbolId: string;
  },
  moves: PlannedTransformation[],
  created: PlannedTransformation | undefined
) {
  for (const node of [...symbols.map((s) => s.node), ...internalNodes]) {
    const name = Node.hasName(node) ? node.getName() : "";
    const symbolId = `${file}#${name}`;
    const isRoot = symbols.some((s) => s.node === node);
    const move = acc.add({
      action,
      after: {
        module: targetModule,
        names: [name],
        package: input.target.id,
        ...(isRoot && { exportForm: "named-export" as const }),
      },
      before: {
        module: file,
        names: [name],
        package: input.source.id,
        ...(exportedNamesOf(sourceFile, node).length > 0 && {
          exportForm: "named-export" as const,
        }),
      },
      detail: isRoot
        ? `move the declaration of ${name} from ${file} to ${targetModule}`
        : `move the module-local ${name} with the declarations that need it (not exported; nothing else in ${file} uses it)`,
      file,
      form: isRoot ? "symbol-move" : "internal-symbol-move",
      kind: "move-symbol",
      subject: subject(symbolId),
    });
    moves.push(move);
    if (created !== undefined) {
      acc.depend(
        created.id,
        move.id,
        "requires",
        "the module exists before code lands in it"
      );
    }
  }
}

function resolveRealizeRelocationEntries(
  wholeModule: boolean,
  resolution: TargetResolution
): PlannedMovementGranularity {
  if (wholeModule) {
    return "module";
  }
  if (resolution.isNew) {
    return "new-module";
  }
  return "symbol";
}

function inwardRedirect(
  planner: Planner,
  consumer: string,
  provider: string,
  conceptId: string | undefined
): ComposedStructuralAction | undefined {
  return planner.composition.actions.find(
    (a) =>
      a.kind === "redirect-concept-dependency" &&
      a.subject.kind === "dependency" &&
      a.subject.consumer === consumer &&
      a.subject.provider === provider &&
      a.subject.conceptId === conceptId
  );
}

interface RewriteInput {
  action: ComposedStructuralAction;
  moves?: PlannedTransformation[];
  site: ImportSite;
  /** New specifier; undefined when the import becomes local to the site's own module. */
  specifier: string | undefined;
  symbol: LocatedSymbol;
  toPackage: string;
}

function rewriteSite(
  planner: Planner,
  input: RewriteInput
): PlannedTransformation | undefined {
  const { acc } = planner;
  const { site, action, symbol } = input;
  const fromPackage =
    packageOfFile(planner.context, site.resolvedFile) ?? site.package ?? "?";
  const kind: PlannedTransformationKind =
    site.fileKind === "test" ? "update-test-import" : "rewrite-import";
  const supported = site.kind === "named" || site.kind === "type";
  const form = `${site.kind}-import${site.viaPackage ? "" : "-relative"}`;
  const transformation = acc.add({
    action,
    after: {
      module: site.file,
      ...(input.specifier !== undefined && { specifier: input.specifier }),
      importKind: site.kind,
      names: [...site.names],
      ...(site.package !== undefined && { package: site.package }),
    },
    before: {
      importKind: site.kind,
      module: site.file,
      names: [...site.names],
      specifier: site.specifier,
      ...(site.package !== undefined && { package: site.package }),
    },
    detail: resolveDetail(supported, input, site, symbol),
    file: site.file,
    kind,
    subject: { symbolId: symbol.id },
    ...(!supported && { status: "unsupported" as const }),
    form,
  });
  if (!supported) {
    acc.block(
      "unsupported-import-form",
      [action.id],
      [site.file],
      transformation.detail
    );
  }
  acc.importRewrites.push({
    file: site.file,
    fromPackage,
    importedSymbolId: symbol.id,
    importKind: site.kind,
    moduleSpecifier: site.specifier,
    status: supported ? "supported" : "unsupported",
    toPackage: input.toPackage,
    transformationId: transformation.id,
  });
  for (const move of input.moves ?? []) {
    acc.depend(
      move.id,
      transformation.id,
      "requires",
      "the declaration lands before imports follow it"
    );
  }
  return transformation;
}

function resolveDetail(
  supported: boolean,
  input: RewriteInput,
  site: ImportSite,
  symbol: LocatedSymbol
): string {
  if (supported) {
    if (input.specifier === undefined) {
      return `${site.file}: ${site.names.join(", ")} is declared here after the move; drop the import from "${site.specifier}"`;
    }
    return `${site.file}: import ${site.names.join(", ")} from "${input.specifier}" instead of "${site.specifier}"${site.otherNames.length === 0 ? "" : ` (${site.otherNames.join(", ")} stay on the old import)`}`;
  }
  if (site.kind === "namespace") {
    return `${site.file}: ${site.names.map((n) => `${site.specifier}.${n}`).join(", ")} is reached through a namespace import; no exact rewrite splits a namespace`;
  }
  return `${site.file}: default import of ${symbol.name} has no exact named rewrite`;
}

// ---------------------------------------------------------------------------
// Exposure

function realizeExposure(
  planner: Planner,
  action: ComposedStructuralAction
): void {
  const { acc, context } = planner;
  if (action.subject.kind !== "exposure") {
    return;
  }
  const target = packageOf(planner, action.subject.package);
  if (target === undefined) {
    acc.block(
      "source-state-mismatch",
      [action.id],
      [action.subject.package],
      `${action.subject.package} is not a workspace package`
    );
    return;
  }
  const { conceptId } = action.subject;
  if (conceptId === undefined && action.subject.symbolId === undefined) {
    const root = rootEntrypoint(target);
    acc.add({
      action,
      detail: `${target.id} must expose what the redirected consumer needs; the composition does not name the concepts, so nothing exact is planned`,
      file: root?.file ?? target.manifest,
      form: "verify-only",
      kind: "verify-only",
      subject: { packageId: target.id },
    });
    acc.gap(
      "dependency-target-unresolved",
      [action.id],
      [target.id],
      `which symbols ${target.id} must expose is not specified`
    );
    return;
  }
  const landings =
    conceptId === undefined
      ? []
      : [...acc.landing.values()]
          .flat()
          .filter(
            (l) =>
              l.package === target.id &&
              acc.relocationsByConcept
                .get(conceptId)
                ?.some((r) => r.targetModule === l.file)
          );
  const symbols: { symbol: LocatedSymbol; module: string }[] = landings.map(
    (l) => ({ module: l.file, symbol: l.symbol })
  );
  if (symbols.length === 0) {
    const symbol = resolveExistingExposure(
      planner,
      action,
      target,
      conceptId,
      action.subject.symbolId
    );
    if (symbol === undefined) {
      return;
    }
    symbols.push({ module: symbol.file, symbol });
  }
  const root = rootEntrypoint(target);
  if (root === undefined) {
    acc.block(
      "package-export-strategy-unresolved",
      [action.id],
      [target.id],
      `${target.id} declares no TypeScript entrypoint to expose ${symbols.map((s) => s.symbol.name).join(", ")} through`
    );
    return;
  }
  const entryFile = sourceFileOf(context, root.file);
  if (entryFile === undefined) {
    acc.block(
      "package-export-strategy-unresolved",
      [action.id],
      [root.file],
      `${root.file} is not in the project`
    );
    return;
  }
  acc.filesRead.add(root.file);
  realizeExposureEntries(
    symbols,
    root,
    acc,
    action,
    target,
    conceptId,
    entryFile,
    context
  );
}

function realizeExposureEntries(
  symbols: { symbol: LocatedSymbol; module: string }[],
  root: { entrypoint: string; file: string },
  acc: Assembly,
  action: ComposedStructuralAction,
  target: OperatorPlanningPackage,
  conceptId: string | undefined,
  entryFile: SourceFile,
  context: OperatorPlanningContext
) {
  for (const { symbol, module } of symbols) {
    const typeOnly = symbol.kind === "interface" || symbol.kind === "type";
    if (module === root.file) {
      acc.add({
        action,
        after: {
          exportForm: "named-export",
          module: root.file,
          names: [symbol.name],
          package: target.id,
        },
        detail: `${root.file} is the ${root.entrypoint} entrypoint; ${symbol.name} is exported where it is declared`,
        file: root.file,
        form: "named-export",
        kind: "add-export",
        subject: {
          symbolId: symbol.id,
          ...(conceptId !== undefined && { conceptId }),
        },
      });
      continue;
    }
    const starred = entryFile
      .getExportDeclarations()
      .some(
        (d) =>
          d.getNamedExports().length === 0 &&
          d.getModuleSpecifierSourceFile() === sourceFileOf(context, module)
      );
    if (starred && sourceFileOf(context, module) !== undefined) {
      acc.add({
        action,
        after: {
          exportForm: "star-export",
          module: root.file,
          names: [symbol.name],
          package: target.id,
        },
        detail: `${root.file} already re-exports everything from ${module}; ${symbol.name} is public once it lands there`,
        file: root.file,
        form: "star-export",
        kind: "verify-only",
        subject: {
          symbolId: symbol.id,
          ...(conceptId !== undefined && { conceptId }),
        },
      });
      continue;
    }
    const exported = acc.add({
      action,
      after: {
        exportForm: typeOnly ? "type-reexport" : "named-reexport",
        module: root.file,
        names: [symbol.name],
        package: target.id,
        specifier: relativeSpecifier(root.file, module),
      },
      detail: `${root.file}: add \`export ${typeOnly ? "type " : ""}{ ${symbol.name} } from "${relativeSpecifier(root.file, module)}"\` so ${root.entrypoint} exposes it`,
      file: root.file,
      form: typeOnly ? "type-reexport" : "named-reexport",
      kind: "add-export",
      subject: {
        symbolId: symbol.id,
        ...(conceptId !== undefined && { conceptId }),
      },
    });
    realizeExposureEntriesEntries(acc, symbol, exported);
  }
}

function realizeExposureEntriesEntries(
  acc: Assembly,
  symbol: LocatedSymbol,
  exported: PlannedTransformation
) {
  if (acc.landed(symbol.id)) {
    for (const t of acc.transformations.values()) {
      if (
        (t.kind === "move-symbol" || t.kind === "move-module") &&
        t.subject?.symbolId === symbol.id
      ) {
        acc.depend(
          t.id,
          exported.id,
          "requires",
          "the entrypoint exports what the module declares"
        );
      }
    }
  }
}
function resolveRepresentationModule(
  family: Parameters<typeof resolveTargetModuleRep>[0],
  inTarget: (file: string) => boolean,
  entrypointFiles: Set<string>
): TargetResolution | undefined {
  const counts = new Map<string, number>();
  resolveTargetModuleRep(family, inTarget, entrypointFiles, counts);
  const candidates = [...counts.keys()].sort(byId);
  if (candidates.length === 1) {
    return {
      candidates,
      isNew: false,
      module: candidates[0],
      rule: "representation-module",
    };
  }
  if (candidates.length > 1) {
    const max = Math.max(...counts.values());
    const top = candidates.filter((c) => counts.get(c) === max);
    if (top.length === 1) {
      return {
        candidates,
        isNew: false,
        module: top[0],
        rule: "representation-module",
      };
    }
    return {
      candidates,
      isNew: false,
      rule: "representation-modules-tie",
    };
  }
  return undefined;
}
function resolveExistingExposure(
  planner: Planner,
  action: ComposedStructuralAction,
  target: OperatorPlanningPackage,
  conceptId: string | undefined,
  symbolId: string | undefined
): LocatedSymbol | undefined {
  const { acc } = planner;
  const id = symbolId ?? conceptId;
  const symbol = id === undefined ? undefined : symbolOf(planner, id, action);
  if (symbol === undefined) {
    return;
  }
  if (symbol.package !== target.id) {
    const relocation =
      conceptId === undefined
        ? undefined
        : acc.relocationsByConcept.get(conceptId);
    // The relocation carries its own gap or blocker; nothing lands, so nothing is exposed.
    if (relocation !== undefined && relocation.length > 0) {
      return;
    }
    acc.block(
      "source-state-mismatch",
      [action.id],
      [symbol.id],
      `${symbol.name} is declared in ${symbol.package ?? "?"}, not ${target.id}`
    );
    return;
  }
  return symbol;
}

// ---------------------------------------------------------------------------
// Compatibility export

function realizeCompatibility(
  planner: Planner,
  action: ComposedStructuralAction
): void {
  const { acc, context } = planner;
  if (action.subject.kind !== "exposure") {
    return;
  }
  const current = packageOf(planner, action.subject.package);
  const conceptId = action.subject.conceptId ?? action.subject.symbolId;
  if (current === undefined || conceptId === undefined) {
    return;
  }
  const symbol = symbolOf(planner, conceptId, action);
  if (symbol === undefined) {
    return;
  }
  const [landing] = acc.landings(symbol.id);
  if (landing === undefined) {
    acc.add({
      action,
      detail: `${symbol.name} stays declared in ${current.id}; the exposure is unchanged`,
      file: symbol.file,
      form: "verify-only",
      kind: "verify-only",
      subject: { symbolId: symbol.id },
    });
    return;
  }
  const target = packageOf(planner, landing.package);
  const root = target === undefined ? undefined : rootEntrypoint(target);
  if (target === undefined || root === undefined) {
    acc.block(
      "package-export-strategy-unresolved",
      [action.id],
      [landing.package],
      `${landing.package} declares no entrypoint the old path can forward to`
    );
    return;
  }
  const typeOnly = symbol.kind === "interface" || symbol.kind === "type";
  const exposure = exposureRoutes(context, current, symbol);
  for (const e of current.entrypoints) {
    acc.filesRead.add(e.file);
  }
  if (exposure.routes.length === 0) {
    acc.block(
      "source-state-mismatch",
      [action.id],
      [symbol.id],
      `${current.id} does not expose ${symbol.name} today; there is no path to keep`
    );
    return;
  }
  const originalConceptId = action.subject.conceptId;
  realizeCompatibilityEntries(
    exposure,
    symbol,
    current,
    acc,
    action,
    typeOnly,
    root,
    originalConceptId,
    target
  );
  for (const r of acc.relocationsByConcept.get(symbol.id) ?? []) {
    r.strategy = "compatibility-reexport";
  }
}

function realizeCompatibilityEntries(
  exposure: ExposureRoutes,
  symbol: LocatedSymbol,
  current: OperatorPlanningPackage,
  acc: Assembly,
  action: ComposedStructuralAction,
  typeOnly: boolean,
  root: { entrypoint: string; file: string },
  originalConceptId: string | undefined,
  target: OperatorPlanningPackage
) {
  for (const { route } of exposure.routes) {
    const file = route.kind === "star-export" ? symbol.file : route.file;

    const before: PlannedSourceState = realizeCompatibilityEntriesEntries(
      route,
      symbol,
      current
    );
    const transformation = acc.add({
      action,
      after: {
        exportForm: typeOnly ? "type-reexport" : "named-reexport",
        module: file,
        names: [route.exportedName],
        package: current.id,
        specifier: root.entrypoint,
      },
      before,
      detail: `${file}: keep \`${route.exportedName}\` reachable from ${route.entrypoint} by re-exporting it from ${root.entrypoint} (\`export ${typeOnly ? "type " : ""}{ ${symbol.name}${route.exportedName === symbol.name ? "" : ` as ${route.exportedName}`} } from "${root.entrypoint}"\`)`,
      file,
      form:
        route.kind === "star-export" ? "compat-in-module" : "compat-at-route",
      kind: "preserve-compatibility-export",
      subject: {
        symbolId: symbol.id,
        ...(originalConceptId !== undefined && {
          conceptId: originalConceptId,
        }),
      },
    });
    acc.edge(current.id, target.id, !typeOnly, transformation.id, action.id);
    for (const t of acc.transformations.values()) {
      if (
        (t.kind === "move-symbol" || t.kind === "move-module") &&
        t.subject?.symbolId === symbol.id
      ) {
        acc.depend(
          t.id,
          transformation.id,
          "requires",
          "the old path forwards to a declaration that exists"
        );
      }
    }
  }
}

function realizeCompatibilityEntriesEntries(
  route: PublicExposureRoute,
  symbol: LocatedSymbol,
  current: OperatorPlanningPackage
): PlannedSourceState {
  let before: PlannedSourceState;
  if (route.kind === "star-export") {
    before = {
      exportForm: "named-export",
      module: symbol.file,
      names: [symbol.name],
      package: current.id,
    };
  } else if (route.kind === "named-export" || route.kind === "subpath-export") {
    before = {
      exportForm: "named-export",
      module: route.file,
      names: [route.exportedName],
      package: current.id,
    };
  } else {
    before = {
      exportForm:
        route.kind === "type-export" ? "type-reexport" : "named-reexport",
      module: route.file,
      names: [route.exportedName],
      package: current.id,
      specifier:
        route.chain[1] === undefined
          ? undefined
          : relativeSpecifier(route.file, route.chain[1]),
    };
  }
  return before;
}

// ---------------------------------------------------------------------------
// Internalize

function realizeInternalize(
  planner: Planner,
  action: ComposedStructuralAction
): void {
  const { acc, context } = planner;
  if (action.subject.kind !== "exposure") {
    return;
  }
  const pkg = packageOf(planner, action.subject.package);
  const id = action.subject.symbolId ?? action.subject.conceptId;
  if (pkg === undefined || id === undefined) {
    return;
  }
  const symbol = symbolOf(planner, id, action);
  if (symbol === undefined) {
    return;
  }
  for (const e of pkg.entrypoints) {
    acc.filesRead.add(e.file);
  }
  const [landing] = acc.landings(symbol.id);
  const exposure = exposureRoutes(context, pkg, symbol);
  if (exposure.unresolvedEntrypoints.length > 0) {
    acc.block(
      "package-export-strategy-unresolved",
      [action.id],
      exposure.unresolvedEntrypoints,
      `entrypoints ${exposure.unresolvedEntrypoints.join(", ")} are not in the project; the public routes cannot be enumerated`
    );
  }
  if (exposure.routes.length === 0 && landing === undefined) {
    acc.block(
      "source-state-mismatch",
      [action.id],
      [symbol.id],
      `${symbol.name} is not exposed by any entrypoint of ${pkg.id} today`
    );
    return;
  }
  const sites = importSitesOf(context, symbol);
  const external = sites.filter(
    (s) =>
      s.form === "import" &&
      s.package !== pkg.id &&
      (landing === undefined || s.package !== landing.package)
  );
  if (external.length > 0 && landing === undefined) {
    acc.block(
      "source-state-mismatch",
      [action.id],
      external.map((s) => s.file),
      `${external.map((s) => s.file).join(", ")} still import ${symbol.name} from ${pkg.id}; the operator's external-usage precondition no longer holds`
    );
  }
  realizeInternalizeEntries(
    exposure,
    landing,
    acc,
    action,
    symbol,
    pkg,
    planner,
    sites
  );
  if (landing !== undefined) {
    for (const r of acc.relocationsByConcept.get(symbol.id) ?? []) {
      r.strategy = "target-public-old-internal";
    }
  }
}

function realizeInternalizeEntries(
  exposure: ExposureRoutes,
  landing: Landing | undefined,
  acc: Assembly,
  action: ComposedStructuralAction,
  symbol: LocatedSymbol,
  pkg: OperatorPlanningPackage,
  planner: Planner,
  sites: ImportSite[]
) {
  for (const { route } of exposure.routes) {
    if (route.kind === "star-export") {
      if (landing !== undefined) {
        acc.add({
          action,
          detail: `${route.file} re-exports everything from ${symbol.file}; once ${symbol.name} moves out, the star no longer carries it`,
          file: route.file,
          form: "star-export",
          kind: "verify-only",
          subject: { symbolId: symbol.id },
        });
        continue;
      }
      acc.add(realizeInternalizeEntriesEntries2(action, route, symbol, pkg));
      acc.block(
        "unsupported-export-form",
        [action.id],
        [route.file],
        `${symbol.name} is exposed through a star export in ${route.file}`
      );
      continue;
    }
    if (route.kind === "named-export" || route.kind === "subpath-export") {
      if (exposure.internalEntrypointImporters) {
        acc.block(
          "unsupported-realization",
          [action.id],
          [route.file],
          `${symbol.name} is declared in the entrypoint ${route.file} and package-internal modules import it through ${route.entrypoint}; removing the export modifier would break them`
        );
      }
      const remove = acc.add({
        action,
        after: { module: route.file, names: [], package: pkg.id },
        before: {
          exportForm: "named-export",
          module: route.file,
          names: [route.exportedName],
          package: pkg.id,
        },
        detail: `${route.file}: remove the export modifier from the declaration of ${symbol.name}`,
        file: route.file,
        form: "named-export",
        kind: "remove-export",
        subject: { symbolId: symbol.id },
      });
      internalImporters(planner, action, pkg, symbol, sites, remove);
      continue;
    }
    if (route.kind === "named-reexport" || route.kind === "type-export") {
      const [, chainNext] = route.chain;
      const specifier =
        chainNext === undefined
          ? undefined
          : relativeSpecifier(route.file, chainNext);
      const transformation = acc.add(
        realizeInternalizeEntriesEntries(
          action,
          route,
          pkg,
          specifier,
          landing,
          symbol
        )
      );
      internalImporters(planner, action, pkg, symbol, sites, transformation);
      continue;
    }
    acc.add({
      action,
      detail: `${route.file}: ${symbol.name} is exposed in a form the planner does not model (${route.kind})`,
      file: route.file,
      form: route.kind,
      kind: "remove-export",
      status: "unsupported",
      subject: { symbolId: symbol.id },
    });
    acc.block(
      "unsupported-export-form",
      [action.id],
      [route.file],
      `${symbol.name} is exposed through ${route.kind} in ${route.file}`
    );
  }
}

function realizeInternalizeEntriesEntries2(
  action: ComposedStructuralAction,
  route: PublicExposureRoute,
  symbol: LocatedSymbol,
  pkg: OperatorPlanningPackage
): TransformationInput {
  return {
    action,
    before: {
      exportForm: "star-export",
      module: route.file,
      names: [symbol.name],
      package: pkg.id,
      specifier:
        route.chain[1] === undefined
          ? undefined
          : relativeSpecifier(route.file, route.chain[1]),
    },
    detail: `${route.file}: ${symbol.name} is exposed through \`${route.statement ?? "export *"}\`; taking one name out of a star export has no exact rewrite`,
    file: route.file,
    form: "star-export",
    kind: "remove-export",
    status: "unsupported",
    subject: { symbolId: symbol.id },
  };
}

function realizeInternalizeEntriesEntries(
  action: ComposedStructuralAction,
  route: PublicExposureRoute,
  pkg: OperatorPlanningPackage,
  specifier: string | undefined,
  landing: Landing | undefined,
  symbol: LocatedSymbol
): TransformationInput {
  return {
    action,
    after: { module: route.file, names: [], package: pkg.id },
    before: {
      exportForm:
        route.kind === "type-export" ? "type-reexport" : "named-reexport",
      module: route.file,
      package: pkg.id,
      ...(specifier !== undefined && { specifier }),
      names: [route.exportedName],
    },
    detail: `${route.file}: drop \`${route.exportedName}\` from \`${route.statement ?? ""}\`${landing === undefined ? `; ${symbol.file} keeps its own export for internal use` : ""}`,
    file: route.file,
    form: route.kind === "type-export" ? "type-reexport" : "named-reexport",
    kind: "rewrite-reexport",
    subject: { symbolId: symbol.id },
  };
}

/** Package-internal modules importing through the entrypoint get a module import before the exposure goes. */
function internalImporters(
  planner: Planner,
  action: ComposedStructuralAction,
  pkg: OperatorPlanningPackage,
  symbol: LocatedSymbol,
  sites: ImportSite[],
  removal: PlannedTransformation
): void {
  const { acc } = planner;
  for (const site of sites) {
    if (site.form !== "import" || site.package !== pkg.id || !site.viaPackage) {
      continue;
    }
    if (acc.landed(symbol.id)) {
      continue;
    }
    const rewrite = rewriteSite(planner, {
      action,
      site,
      specifier: relativeSpecifier(site.file, symbol.file),
      symbol,
      toPackage: pkg.id,
    });
    if (rewrite !== undefined) {
      acc.depend(
        rewrite.id,
        removal.id,
        "preserve-before-remove",
        "internal importers reach the module directly before the entrypoint stops exposing it"
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Redirect

function realizeRedirect(
  planner: Planner,
  action: ComposedStructuralAction
): void {
  const { acc, context } = planner;
  if (action.subject.kind !== "dependency") {
    return;
  }
  const consumer = packageOf(planner, action.subject.consumer);
  const provider = packageOf(planner, action.subject.provider);
  const target = packageOf(planner, action.target?.package);
  const { conceptId } = action.subject;
  if (
    consumer === undefined ||
    provider === undefined ||
    target === undefined
  ) {
    acc.block(
      "source-state-mismatch",
      [action.id],
      [
        action.subject.consumer,
        action.subject.provider,
        action.target?.package ?? "?",
      ],
      `a package of the ${action.subject.consumer}→${action.subject.provider} dependency is not in the workspace`
    );
    return;
  }
  if (conceptId === undefined) {
    acc.add({
      action,
      detail: `${consumer.id} should depend on ${target.id} instead of ${provider.id}; without the concepts involved no import is named`,
      file: consumer.manifest,
      form: "verify-only",
      kind: "verify-only",
      subject: { packageId: consumer.id },
    });
    acc.gap(
      "dependency-target-unresolved",
      [action.id],
      [`${consumer.id}→${provider.id}`],
      `which imports of ${consumer.id} from ${provider.id} move to ${target.id} is not specified`
    );
    return;
  }
  const concept = symbolOf(planner, conceptId, action);
  if (concept === undefined) {
    return;
  }
  const relocated = acc.relocationsByConcept.get(conceptId) ?? [];
  const movedSymbols = [...acc.landing.values()]
    .flat()
    .filter(
      (l) =>
        l.package === target.id &&
        relocated.some((r) => r.targetModule === l.file)
    )
    .map((l) => l.symbol);
  const symbols = movedSymbols.length > 0 ? movedSymbols : [concept];
  if (movedSymbols.length === 0 && relocated.length > 0) {
    acc.gap(
      "target-module-unresolved",
      [action.id],
      [target.id],
      `${concept.name} has no resolved module in ${target.id}; the consumer's imports cannot be pointed at it`
    );
    return;
  }
  if (movedSymbols.length === 0) {
    const { routes } = exposureRoutes(context, target, concept);
    if (concept.package !== target.id && routes.length === 0) {
      acc.block(
        "package-export-strategy-unresolved",
        [action.id],
        [target.id, concept.id],
        `${target.id} does not expose ${concept.name}; the consumer cannot import it from there`
      );
      return;
    }
  }
  const root = rootEntrypoint(target);
  if (root === undefined) {
    acc.block(
      "package-export-strategy-unresolved",
      [action.id],
      [target.id],
      `${target.id} declares no TypeScript entrypoint`
    );
    return;
  }
  const inTarget = consumer.id === target.id;
  let any = false;
  const visitSymbol = () => {
    any = realizeRedirectSymbol(
      symbols,
      context,
      consumer,
      provider,
      any,
      acc,
      target,
      inTarget,
      root,
      planner,
      action
    );
  };
  visitSymbol();
  if (any) {
    return;
  }
  // The dependency travels inside moved code: the moved members import the
  // concept from the target, so the move itself carries the redirect.
  const carried = relocated
    .filter(
      (r) =>
        r.sourcePackage === consumer.id &&
        r.closure?.externalDependencies.some(
          (d) => d.class === "import-from-target-package"
        ) === true
    )
    .flatMap((r) => [...(acc.byAction.get(r.actionId) ?? [])])
    .map((id) => acc.transformations.get(id))
    .filter(
      (t): t is PlannedTransformation =>
        t?.kind === "move-symbol" || t?.kind === "move-module"
    );
  if (carried.length > 0) {
    for (const t of carried) {
      acc.link(action.id, t.id);
      t.actions = uniq([...t.actions, action.id]);
    }
    return;
  }
  acc.add({
    action,
    detail: `${consumer.id} holds no import of ${concept.name} from ${provider.id} today; nothing to redirect`,
    file: consumer.manifest,
    form: "verify-only",
    kind: "verify-only",
    subject: { conceptId, packageId: consumer.id },
  });
}

function realizeRedirectSymbol(
  symbols: LocatedSymbol[],
  context: OperatorPlanningContext,
  consumer: OperatorPlanningPackage,
  provider: OperatorPlanningPackage,
  initialAny: boolean,
  acc: Assembly,
  target: OperatorPlanningPackage,
  inTarget: boolean,
  root: { entrypoint: string; file: string },
  planner: Planner,
  action: ComposedStructuralAction
) {
  let any = initialAny;
  for (const symbol of symbols) {
    any = realizeRedirectSymbolSite(
      context,
      symbol,
      consumer,
      provider,
      any,
      acc,
      target,
      inTarget,
      root,
      planner,
      action
    );
  }
  return any;
}

function realizeRedirectSymbolSite(
  context: OperatorPlanningContext,
  symbol: LocatedSymbol,
  consumer: OperatorPlanningPackage,
  provider: OperatorPlanningPackage,
  initialAny: boolean,
  acc: Assembly,
  target: OperatorPlanningPackage,
  inTarget: boolean,
  root: { entrypoint: string; file: string },
  planner: Planner,
  action: ComposedStructuralAction
) {
  let any = initialAny;
  for (const site of importSitesOf(context, symbol)) {
    if (site.form !== "import" || site.package !== consumer.id) {
      continue;
    }
    const resolvedPackage = packageOfFile(context, site.resolvedFile);
    if (
      resolvedPackage !== provider.id &&
      !(resolvedPackage === undefined && site.viaPackage)
    ) {
      continue;
    }
    any = true;
    const landing = acc.landingIn(symbol.id, target.id);

    const specifier: string | undefined = realizeRedirectSymbolSiteEntries(
      inTarget,
      landing,
      site,
      undefined,
      root
    );
    const rewrite = rewriteSite(planner, {
      action,
      site,
      specifier,
      symbol,
      toPackage: target.id,
    });
    if (rewrite === undefined) {
      continue;
    }
    if (site.otherNames.length === 0) {
      acc.removeSite(consumer.id, provider.id, rewrite.id, action.id);
    }
    if (!inTarget) {
      acc.edge(consumer.id, target.id, !site.typeOnly, rewrite.id, action.id);
    }
    for (const t of acc.transformations.values()) {
      if (
        t.kind === "add-export" &&
        t.subject?.symbolId === symbol.id &&
        t.after?.package === target.id
      ) {
        acc.depend(
          t.id,
          rewrite.id,
          "requires",
          "consumers import what the target exposes"
        );
      }
    }
  }
  return any;
}

function realizeRedirectSymbolSiteEntries(
  inTarget: boolean,
  landing: Landing | undefined,
  site: ImportSite,
  initialSpecifier: string | undefined,
  root: { entrypoint: string; file: string }
): string | undefined {
  let specifier = initialSpecifier;
  if (inTarget && landing !== undefined) {
    if (site.file === landing.file) {
      specifier = undefined;
    } else {
      specifier = relativeSpecifier(site.file, landing.file);
    }
  } else {
    specifier = root.entrypoint;
  }
  return specifier;
}

// ---------------------------------------------------------------------------
// Preservation-only actions

function realizeVerifyOnly(
  planner: Planner,
  action: ComposedStructuralAction
): void {
  const { acc } = planner;
  const { subject } = action;
  let pkgId: string | undefined;
  if (subject.kind === "package") {
    pkgId = subject.packageId;
  } else if (subject.kind === "boundary") {
    [pkgId] = subject.boundaryId.split("→");
  } else {
    pkgId = action.current?.package ?? action.target?.package;
  }
  const pkg = packageOf(planner, pkgId);
  acc.add({
    action,
    detail: action.intent.summary,
    file: pkg?.manifest ?? "package.json",
    form: "verify-only",
    kind: "verify-only",
    subject: {
      ...(pkg !== undefined && { packageId: pkg.id }),
      ...(conceptOf(action) !== undefined && { conceptId: conceptOf(action) }),
    },
  });
}

// ---------------------------------------------------------------------------
// Surface strategy (§20–22): derived from the actions present, never chosen.

function rewritten(acc: Assembly, site: ImportSite): boolean {
  return [...acc.transformations.values()].some(
    (t) =>
      (t.kind === "rewrite-import" || t.kind === "update-test-import") &&
      t.status !== "unsupported" &&
      t.file === site.file &&
      t.before?.specifier === site.specifier &&
      site.names.every((n) => t.before?.names?.includes(n) ?? false)
  );
}

/**
 * A relocation whose old exposure no action keeps or removes: when every
 * outside importer of the moved symbols is redirected by a planned rewrite
 * (or there is none), the old routes are dropped and the relocation is
 * direct. Otherwise the old path's fate is an open intent and the plan
 * stays partial; a breaking relocation is never the default.
 */
function settleStrategies(planner: Planner): void {
  const { acc, composition, context } = planner;
  for (const r of acc.relocations) {
    if (r.strategy !== "unresolved" || r.granularity === "unresolved") {
      continue;
    }
    const sourcePackage = context.packages.get(r.sourcePackage);
    const action = composition.actions.find((a) => a.id === r.actionId);
    if (sourcePackage === undefined || action === undefined) {
      continue;
    }
    const members = r.members
      .map((m) => locateSymbol(context, m.symbolId))
      .flatMap((l) => (l.status === "located" ? [l.symbol] : []));
    const outside = members.flatMap((m) =>
      importSitesOf(context, m).filter(
        (s) =>
          s.form === "import" &&
          s.package !== r.sourcePackage &&
          s.package !== r.targetPackage
      )
    );
    const open = outside.filter((s) => !rewritten(acc, s));
    if (open.length > 0) {
      const from = uniq(open.map((s) => s.package ?? s.file));
      acc.gap(
        "surface-strategy-unresolved",
        [r.actionId],
        [r.sourcePackage, ...from],
        `${from.join(", ")} import ${uniq(open.flatMap((s) => s.names)).join(", ")} from ${r.sourcePackage}; no action keeps, forwards, or removes that path, and a breaking relocation is never chosen by default`
      );
      continue;
    }
    r.strategy = "direct-relocation";
    settleStrategiesMember(
      members,
      context,
      sourcePackage,
      acc,
      action,
      r,
      outside
    );
  }
}

function settleStrategiesMember(
  members: LocatedSymbol[],
  context: OperatorPlanningContext,
  sourcePackage: OperatorPlanningPackage,
  acc: Assembly,
  action: ComposedStructuralAction,
  r: PlannedRelocation,
  outside: ImportSite[]
) {
  for (const member of members) {
    for (const { route } of exposureRoutes(context, sourcePackage, member)
      .routes) {
      if (route.kind !== "named-reexport" && route.kind !== "type-export") {
        continue;
      }
      acc.add({
        action,
        after: { module: route.file, names: [], package: r.sourcePackage },
        before: {
          exportForm:
            route.kind === "type-export" ? "type-reexport" : "named-reexport",
          module: route.file,
          names: [route.exportedName],
          package: r.sourcePackage,
        },
        detail: `${route.file}: drop \`${route.exportedName}\` from \`${route.statement ?? ""}\`; ${outside.length === 0 ? `nothing outside ${r.sourcePackage} imports it from here` : "every outside importer is redirected"}`,
        file: route.file,
        form: route.kind === "type-export" ? "type-reexport" : "named-reexport",
        kind: "rewrite-reexport",
        subject: {
          symbolId: member.id,
          ...(r.conceptId !== undefined && { conceptId: r.conceptId }),
        },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Finalization: manifests, cycles, conflicts, dependencies

function finalizeManifests(planner: Planner): void {
  const { acc, context } = planner;
  const edges = packageImportEdges(context);
  const existing = new Map(edges.map((e) => [`${e.from}→${e.to}`, e]));
  finalizeManifestsAdded(acc, context, planner);
  // Removals: only when every import site carrying the edge is rewritten away.
  for (const [id, removed] of [...acc.removedSites].sort(([a], [b]) =>
    byId(a, b)
  )) {
    const edge = existing.get(id);
    if (edge === undefined || removed.count < edge.sites) {
      continue;
    }
    if (acc.addedEdges.some((e) => `${e.from}→${e.to}` === id)) {
      continue;
    }
    const from = context.packages.get(edge.from);
    if (from?.dependencies.includes(edge.to) !== true) {
      continue;
    }
    const rewrites = removed.transformations
      .map((tid) => acc.transformations.get(tid))
      .filter(
        (transformation2): transformation2 is PlannedTransformation =>
          transformation2 !== undefined
      );
    const action = planner.composition.actions.find((a) =>
      removed.actions.includes(a.id)
    );
    if (action === undefined) {
      continue;
    }
    const t = acc.add({
      action,
      after: {
        dependency: { declared: false, package: edge.to },
        package: from.id,
      },
      before: {
        dependency: { declared: true, package: edge.to },
        package: from.id,
      },
      detail: `${from.manifest}: ${edge.to} can leave the dependencies once the ${edge.sites} import${edge.sites === 1 ? "" : "s"} carrying it are rewritten; nothing else in ${from.id} imports it`,
      file: from.manifest,
      form: "manifest-dependency-removal",
      kind: "update-package-dependency",
      status: "conditional",
      subject: { packageId: from.id },
    });
    for (const r of rewrites) {
      acc.depend(
        r.id,
        t.id,
        "requires",
        "imports leave before the dependency does"
      );
    }
  }
}

function finalizeManifestsAdded(
  acc: Assembly,
  context: OperatorPlanningContext,
  planner: Planner
) {
  for (const added of [...acc.addedEdges].sort(
    (a, b) => byId(a.from, b.from) || byId(a.to, b.to)
  )) {
    const from = context.packages.get(added.from);
    if (from === undefined) {
      continue;
    }
    acc.filesRead.add(from.manifest);
    const action = planner.composition.actions.find((a) =>
      added.actions.includes(a.id)
    );
    if (action === undefined) {
      continue;
    }
    if (!from.dependencies.includes(added.to)) {
      const t = acc.add({
        action,
        after: {
          dependency: { declared: true, package: added.to },
          package: from.id,
          runtime: added.runtime,
        },
        before: {
          dependency: { declared: false, package: added.to },
          package: from.id,
        },
        detail: `${from.manifest}: declare ${added.to} as a dependency; ${added.transformations.length} planned import${added.transformations.length === 1 ? "" : "s"} in ${from.id} reach it`,
        file: from.manifest,
        form: "manifest-dependency",
        kind: "update-package-dependency",
        subject: { packageId: from.id },
      });
      for (const id of added.transformations) {
        acc.depend(
          t.id,
          id,
          "requires",
          "the manifest declares the package before imports reach it"
        );
      }
      for (const other of added.actions) {
        acc.link(other, t.id);
      }
      t.actions = uniq([...t.actions, ...added.actions]);
    }
  }
}

function finalizeCycles(planner: Planner): void {
  const { acc, context } = planner;
  const edges = packageImportEdges(context);
  const remaining = edges.filter(
    (e) => (acc.removedSites.get(`${e.from}→${e.to}`)?.count ?? 0) < e.sites
  );
  const added = acc.addedEdges.filter(
    (e) => !remaining.some((r) => r.from === e.from && r.to === e.to)
  );
  for (const cycle of cyclesThrough(remaining, added)) {
    const involved = added.filter(
      (e) => cycle.includes(e.from) && cycle.includes(e.to)
    );
    acc.block(
      "dependency-cycle-risk",
      involved.flatMap((e) => e.actions),
      cycle,
      `the plan adds ${involved.map((e) => `${e.from}→${e.to}`).join(", ")}, closing the package cycle ${[...cycle, cycle[0] ?? ""].join(" → ")}`
    );
  }
}

function finalizeConflicts(planner: Planner): void {
  const { acc } = planner;
  const rewrites = [...acc.transformations.values()].filter(
    (t) => t.kind === "rewrite-import" || t.kind === "update-test-import"
  );
  const groups = new Map<string, PlannedTransformation[]>();
  for (const t of rewrites) {
    const key = `${t.file}|${t.before?.specifier ?? ""}|${(t.before?.names ?? []).join(",")}`;
    const list = groups.get(key) ?? [];
    list.push(t);
    groups.set(key, list);
  }
  for (const [key, list] of [...groups].sort(([a], [b]) => byId(a, b))) {
    const targets = uniq(list.map((t) => t.after?.specifier ?? "(local)"));
    if (targets.length < 2) {
      continue;
    }
    const [file] = key.split("|");
    acc.conflicts.push({
      actions: uniq(list.flatMap((t) => t.actions)),
      detail: `${file}: the same import is rewritten to ${targets.join(" and ")}`,
      entities: [file ?? ""],
      kind: "import-rewrite-conflict",
      transformations: list.map((t) => t.id).sort(byId),
    });
    acc.block(
      "unsupported-realization",
      uniq(list.flatMap((t) => t.actions)),
      [file ?? ""],
      `${file}: one import cannot be rewritten to ${targets.join(" and ")} at once`
    );
  }
  for (const [id, landings] of [...acc.landing].sort(([a], [b]) =>
    byId(a, b)
  )) {
    if (landings.length < 2) {
      continue;
    }
    const destinations = landings.map((l) => l.file).sort(byId);
    const relocations = acc.relocations.filter((r) =>
      r.members.some((m) => m.symbolId === id)
    );
    const actions = uniq(relocations.map((r) => r.actionId));
    const moves = uniq(
      actions.flatMap((a) => [...(acc.byAction.get(a) ?? [])])
    ).filter((t) => {
      const kind = acc.transformations.get(t)?.kind;
      return kind === "move-symbol" || kind === "move-module";
    });
    acc.conflicts.push({
      actions,
      detail: `${id} is moved to ${destinations.join(" and ")}`,
      entities: [id],
      kind: "same-symbol-multiple-destinations",
      transformations: moves,
    });
    acc.block(
      "unsupported-realization",
      actions,
      [id],
      `${id} cannot land in ${destinations.join(" and ")} at once`
    );
  }
}

const KIND_ORDER: PlannedTransformationKind[] = [
  "create-module",
  "move-module",
  "move-symbol",
  "add-export",
  "update-package-export",
  "update-package-dependency",
  "rewrite-import",
  "update-test-import",
  "preserve-compatibility-export",
  "rewrite-reexport",
  "remove-export",
  "delete-empty-module",
  "verify-only",
];

function finalizeDependencies(planner: Planner): void {
  const { acc, composition } = planner;
  const all = [...acc.transformations.values()];
  const same = (a: PlannedTransformation, b: PlannedTransformation) =>
    a.subject?.symbolId !== undefined &&
    a.subject.symbolId === b.subject?.symbolId;
  for (const a of all) {
    for (const b of all) {
      if (a === b || !same(a, b)) {
        continue;
      }
      const rank = (t: PlannedTransformation) => KIND_ORDER.indexOf(t.kind);
      if (
        (a.kind === "move-symbol" || a.kind === "move-module") &&
        (b.kind === "rewrite-import" ||
          b.kind === "update-test-import" ||
          b.kind === "add-export" ||
          b.kind === "preserve-compatibility-export" ||
          b.kind === "rewrite-reexport")
      ) {
        acc.depend(a.id, b.id, "requires", "the declaration lands first");
      }
      if (
        (a.kind === "rewrite-import" || a.kind === "update-test-import") &&
        (b.kind === "remove-export" || b.kind === "rewrite-reexport") &&
        rank(a) < rank(b)
      ) {
        acc.depend(
          a.id,
          b.id,
          "preserve-before-remove",
          "consumers are redirected before the old exposure goes"
        );
      }
    }
  }
  // Action order carries over: every establishing realization of A precedes
  // every realization of B. Cleanup steps of A (old exposure gone, module
  // emptied, dependency dropped) come after everything and carry no order.
  // A transformation shared by actions at different depths sits at the
  // deepest one, so edges only ever point deeper.
  const { layer } = layers(composition.actions, composition.dependencies);
  const depth = (t: PlannedTransformation) =>
    Math.max(...t.actions.map((id) => layer.get(id) ?? 0));
  finalizeDependenciesDep(composition, acc, depth);
}

function finalizeDependenciesDep(
  composition: OperatorComposition,
  acc: Assembly,
  depth: (t: PlannedTransformation) => number
) {
  for (const dep of composition.dependencies) {
    const before = acc.byAction.get(dep.before);
    const after = acc.byAction.get(dep.after);
    if (before === undefined || after === undefined) {
      continue;
    }
    for (const a of before) {
      const first = acc.transformations.get(a);
      if (first === undefined || unordered(first) || isCleanup(first)) {
        continue;
      }
      for (const b of after) {
        const second = acc.transformations.get(b);
        if (
          a !== b &&
          second !== undefined &&
          !unordered(second) &&
          depth(first) < depth(second)
        ) {
          acc.depend(a, b, "action-order", `${dep.kind}: ${dep.reason}`);
        }
      }
    }
  }
}

/** Steps whose place comes only from their own `requires` edges: manifests serve several actions at once. */
function unordered(t: PlannedTransformation): boolean {
  return t.kind === "verify-only" || t.kind === "update-package-dependency";
}

function isCleanup(t: PlannedTransformation): boolean {
  switch (t.kind) {
    case "remove-export":
    case "delete-empty-module":
      return true;
    case "rewrite-reexport":
      return (t.after?.names ?? []).length === 0;
    case "update-package-dependency":
      return t.after?.dependency?.declared === false;
    case "rewrite-import":
    case "move-symbol":
    case "move-module":
    case "create-module":
    case "add-export":
    case "update-package-export":
    case "preserve-compatibility-export":
    case "update-test-import":
    case "verify-only":
      return false;
    default:
      throw new Error("Unexpected t.kind.");
  }
}

/** Transformations on at least one cycle, after peeling every node lacking an in- or out-edge. */
export function transformationCycles(
  ids: string[],
  dependencies: PlannedTransformationDependency[]
): string[] {
  const members = new Set(ids);
  const edges = dependencies.filter(
    (d) => members.has(d.before) && members.has(d.after)
  );
  let pruned = true;
  while (pruned) {
    pruned = false;
    for (const id of [...members]) {
      const hasIn = edges.some((d) => d.after === id && members.has(d.before));
      const hasOut = edges.some((d) => d.before === id && members.has(d.after));
      if (!(hasIn && hasOut)) {
        members.delete(id);
        pruned = true;
      }
    }
  }
  return [...members].sort(byId);
}

function layerOf(
  ids: string[],
  dependencies: PlannedTransformationDependency[]
): Map<string, number> {
  const layer = new Map<string, number>();
  const incoming = new Map<string, string[]>();
  for (const id of ids) {
    incoming.set(id, []);
  }
  for (const d of dependencies) {
    incoming.get(d.after)?.push(d.before);
  }
  let changed = true;
  let guard = 0;
  while (changed && guard < ids.length + 1) {
    changed = false;
    guard += 1;
    for (const id of ids) {
      const preds = incoming.get(id) ?? [];
      const value =
        preds.length === 0
          ? 0
          : Math.max(...preds.map((p) => (layer.get(p) ?? 0) + 1));
      if (layer.get(id) !== value) {
        layer.set(id, value);
        changed = true;
      }
    }
  }
  return layer;
}

// ---------------------------------------------------------------------------
// Coverage, preservation, deltas, verification

function realizations(planner: Planner): StructuralActionRealization[] {
  const { acc, composition } = planner;
  return composition.actions.map((action) => {
    const ids = [...(acc.byAction.get(action.id) ?? [])].sort(byId);
    const blocked = acc.blockers.filter((b) => b.actions.includes(action.id));
    const gaps = acc.gaps.filter((g) => g.actions.includes(action.id));
    const unsupported = ids.some(
      (id) => acc.transformations.get(id)?.status === "unsupported"
    );
    let resultStatus2: StructuralActionRealization["status"] = "realized";
    let detail: string | undefined;
    if (blocked.length > 0 || unsupported) {
      resultStatus2 = "blocked";
      detail = blocked[0]?.detail ?? "a transformation has no exact form";
    } else if (gaps.length > 0) {
      resultStatus2 = "partial";
      detail = gaps[0]?.detail;
    } else if (ids.length === 0) {
      resultStatus2 = "partial";
      detail = "no transformation realizes the action";
    }
    return {
      actionId: action.id,
      status: resultStatus2,
      transformations: ids,
      ...(detail !== undefined && { detail }),
    };
  });
}

const VERIFY_ORDER: PlannedVerificationKind[] = [
  "verify-symbol-location",
  "verify-public-surface",
  "verify-imports",
  "verify-dependency",
  "verify-anchor",
  "typecheck",
  "tests",
  "analyze-package",
  "analyze-workspace",
];

class Verification {
  readonly steps = new Map<string, PlannedVerificationStep>();
  add(
    kind: PlannedVerificationKind,
    scope: string[],
    expected: OperatorFact,
    transformations: string[]
  ): PlannedVerificationStep | undefined {
    if (scope.filter((s) => s !== "").length === 0) {
      return undefined;
    }
    const id = `verify:${kind}:${hash16([kind, uniq(scope), expected])}`;
    const existing = this.steps.get(id);
    if (existing !== undefined) {
      existing.transformations = uniq([
        ...existing.transformations,
        ...transformations,
      ]);
      return existing;
    }
    const step: PlannedVerificationStep = {
      dependsOn: [],
      expected,
      id,
      kind,
      scope: uniq(scope),
      transformations: uniq(transformations),
    };
    this.steps.set(id, step);
    return step;
  }
  ordered(): PlannedVerificationStep[] {
    const steps = [...this.steps.values()].sort(
      (a, b) =>
        VERIFY_ORDER.indexOf(a.kind) - VERIFY_ORDER.indexOf(b.kind) ||
        byId(a.id, b.id)
    );
    for (const step of steps) {
      const rank = VERIFY_ORDER.indexOf(step.kind);
      const previous = steps.filter((s) => VERIFY_ORDER.indexOf(s.kind) < rank);
      const nearest =
        previous.length === 0
          ? -1
          : Math.max(...previous.map((s) => VERIFY_ORDER.indexOf(s.kind)));
      step.dependsOn = previous
        .filter((s) => VERIFY_ORDER.indexOf(s.kind) === nearest)
        .map((s) => s.id)
        .sort(byId);
    }
    return steps;
  }
}

function buildVerification(planner: Planner): PlannedVerificationStep[] {
  const { acc, composition, context } = planner;
  const v = new Verification();
  const all = [...acc.transformations.values()];
  const packages = uniq(
    all
      .flatMap((t) => [
        t.before?.package,
        t.after?.package,
        packageOfFile(context, t.file),
      ])
      .filter((p): p is string => p !== undefined)
  );
  const source = all
    .filter((t) => !SOURCE_ONLY_KINDS.has(t.kind))
    .map((t) => t.id);
  for (const t of all) {
    switch (t.kind) {
      case "move-symbol":
      case "move-module":
        v.add(
          "verify-symbol-location",
          [t.subject?.symbolId ?? t.subject?.moduleId ?? t.file],
          t.after?.module ?? null,
          [t.id]
        );
        break;
      case "add-export":
        v.add(
          "verify-public-surface",
          [t.after?.package ?? "", t.subject?.symbolId ?? ""],
          "package-public",
          [t.id]
        );
        break;
      case "remove-export":
      case "rewrite-reexport":
        v.add(
          "verify-public-surface",
          [t.before?.package ?? "", t.subject?.symbolId ?? ""],
          "internal",
          [t.id]
        );
        break;
      case "preserve-compatibility-export":
        v.add(
          "verify-public-surface",
          [t.before?.package ?? "", t.subject?.symbolId ?? ""],
          "package-public",
          [t.id]
        );
        break;
      case "rewrite-import":
      case "update-test-import":
        v.add("verify-imports", [t.file], t.after?.specifier ?? "(local)", [
          t.id,
        ]);
        break;
      case "update-package-dependency":
        v.add(
          "verify-dependency",
          [t.after?.package ?? "", t.after?.dependency?.package ?? ""],
          t.after?.dependency?.declared ?? null,
          [t.id]
        );
        break;
      case "create-module":
      case "update-package-export":
      case "delete-empty-module":
      case "verify-only":
        break;
      default:
        throw new Error("Unexpected t.kind.");
    }
  }
  buildVerificationP(composition, v, context, acc);
  const visitReq = () => {
    for (const req of composition.verification) {
      switch (req.kind) {
        case "typecheck":
          v.add("typecheck", packages, true, source);
          break;
        case "tests":
          v.add("tests", packages, true, source);
          break;
        case "public-surface":
          break;
        case "anchor-preserved":
          v.add(
            "verify-anchor",
            Array.isArray(req.expected) ? req.expected : packages,
            true,
            []
          );
          break;
        case "concept-center":
        case "behavior-location":
        case "dependency-edge":
        case "boundary-interaction":
          v.add("analyze-workspace", packages, req.expected, source);
          break;
        default:
          throw new Error("Unexpected req.kind.");
      }
    }
  };
  visitReq();
  if (source.length > 0) {
    v.add("typecheck", packages, true, source);
    v.add("tests", packages, true, source);
    for (const p of packages) {
      v.add("analyze-package", [p], true, source);
    }
  }
  return v.ordered();
}

function buildVerificationP(
  composition: OperatorComposition,
  v: Verification,
  context: OperatorPlanningContext,
  acc: Assembly
) {
  for (const p of composition.preservations) {
    if (p.kind === "anchor") {
      v.add("verify-anchor", p.entityIds, true, []);
    }
    if (p.kind === "semantic-center" || p.kind === "runtime-behavior") {
      for (const id of p.entityIds) {
        const located = locateSymbol(context, id);
        if (located.status === "located" && !acc.landed(id)) {
          v.add("verify-symbol-location", [id], located.symbol.file, []);
        }
      }
    }
    if (p.kind === "public-contract") {
      for (const id of p.entityIds) {
        v.add("verify-public-surface", [id], "unchanged", []);
      }
    }
    // A path is kept when the concept it names never left its home.
    buildVerificationPEntries(p, composition, context, acc, v);
  }
}

function buildVerificationPEntries(
  p: CompositionPreservation,
  composition: OperatorComposition,
  context: OperatorPlanningContext,
  acc: Assembly,
  v: Verification
) {
  if (p.kind === "consumer-import-path" || p.kind === "public-contract") {
    for (const conceptId of uniq(
      composition.actions.flatMap((a) => conceptOf(a) ?? [])
    )) {
      const located = locateSymbol(context, conceptId);
      if (
        located.status !== "located" ||
        acc.landed(conceptId) ||
        located.symbol.package === undefined
      ) {
        continue;
      }
      const step = v.add(
        "verify-public-surface",
        [located.symbol.package, conceptId],
        "package-public",
        []
      );
      if (step !== undefined) {
        acc.proofs.set(
          p.preservationId,
          uniq([...(acc.proofs.get(p.preservationId) ?? []), step.id])
        );
      }
    }
  }
}

function preservations(
  planner: Planner,
  steps: PlannedVerificationStep[]
): PlannedPreservation[] {
  const { acc, composition } = planner;
  return composition.preservations.map((p) => {
    const transformations = [...acc.transformations.values()]
      .filter(
        (t) =>
          t.preserves.includes(p.preservationId) && t.kind !== "verify-only"
      )
      .map((t) => t.id)
      .sort(byId);
    const proof = steps
      .filter((s) => {
        switch (p.kind) {
          case "anchor":
            return (
              s.kind === "verify-anchor" &&
              p.entityIds.some((e) => s.scope.includes(e))
            );
          case "consumer-import-path":
          case "public-contract":
            return (
              s.kind === "verify-public-surface" &&
              (p.entityIds.some((e) => s.scope.includes(e)) ||
                transformations.some((t) => s.transformations.includes(t)))
            );
          case "semantic-center":
          case "runtime-behavior":
          case "implementation-split":
            return (
              (s.kind === "verify-symbol-location" &&
                p.entityIds.some((e) => s.scope.includes(e))) ||
              s.kind === "tests"
            );
          case "representation-boundary":
            return (
              s.kind === "analyze-package" || s.kind === "analyze-workspace"
            );
          default:
            throw new Error("Unexpected p.kind.");
        }
      })
      .map((s) => s.id);
    const verification = uniq([
      ...proof,
      ...(acc.proofs.get(p.preservationId) ?? []),
    ]);
    let resultStatus: PlannedPreservation["status"];
    if (transformations.length > 0) {
      resultStatus = "transformed";
    } else if (verification.length > 0) {
      resultStatus = "proven";
    } else {
      resultStatus = "unproven";
    }
    return {
      preservationId: p.preservationId,
      status: resultStatus,
      transformations,
      verification,
    };
  });
}

const DIMENSIONS: Record<OperatorEffectDimension, PlannedDeltaDimension> = {
  behavior: "behavior",
  boundary: "boundary",
  dependency: "dependency",
  locality: "module",
  ownership: "package",
  representation: "package",
  surface: "surface",
};

function isOperatorDimension(value: string): value is OperatorEffectDimension {
  return Object.hasOwn(DIMENSIONS, value);
}

function deltaDimension(value: string): PlannedDeltaDimension {
  return isOperatorDimension(value) ? DIMENSIONS[value] : "package";
}

function deltas(planner: Planner): PlannedArchitecturalDelta[] {
  const { acc, composition, context } = planner;
  const result: PlannedArchitecturalDelta[] = composition.effects.map((e) => {
    const actions = composition.actions.filter((a) =>
      a.expectedEffects.some(
        (x) => x.dimension === e.dimension && x.change === e.change
      )
    );
    const transformations = uniq(
      actions.flatMap((a) => [...(acc.byAction.get(a.id) ?? [])])
    );
    const [first] = e.changes;
    return {
      certainty:
        e.changes.every((c) => c.certainty === "certain") &&
        transformations.length > 0
          ? "certain"
          : "conditional",
      change: e.change,
      dimension: deltaDimension(e.dimension),
      predicted: first?.to ?? null,
      sourceTransformations: transformations,
      subjects: [...e.subjects],
    };
  });
  const edges = packageImportEdges(context);
  for (const added of acc.addedEdges) {
    const existing = edges.find(
      (x) => x.from === added.from && x.to === added.to
    );
    if (added.runtime && existing?.runtimeSites === 0) {
      result.push({
        certainty: "certain",
        change: "runtime-dependency-escalation",
        dimension: "dependency",
        predicted: "runtime",
        sourceTransformations: added.transformations,
        subjects: [`${added.from}→${added.to}`],
      });
    }
  }
  return result.sort(
    (a, b) =>
      byId(a.dimension, b.dimension) ||
      byId(a.change, b.change) ||
      byId(a.subjects.join(","), b.subjects.join(","))
  );
}

// ---------------------------------------------------------------------------
// Blocked and unsupported composition actions

function carryCompositionState(planner: Planner): void {
  const { acc, composition, operators } = planner;
  for (const action of composition.actions) {
    if (action.status === "unsupported") {
      acc.block(
        "unsupported-realization",
        [action.id],
        [action.kind],
        `${action.kind} has no source realization`
      );
      continue;
    }
    if (action.status !== "blocked") {
      continue;
    }
    const constraints = action.sourceOperators.flatMap(
      (id) =>
        operators.get(id)?.constraints.filter((c) => c.effect === "blocking") ??
        []
    );
    for (const c of constraints) {
      let kind: OperatorPlanBlockerKind;
      if (c.kind === "anchor") {
        kind = "anchor-violation";
      } else if (c.kind === "coverage-incomplete") {
        kind = "coverage-incomplete";
      } else if (c.kind === "structural-conformance-unknown") {
        kind = "structural-conformance-unknown";
      } else {
        kind = "unsupported-realization";
      }
      acc.block(kind, [action.id], c.entityIds, c.detail);
    }
    if (constraints.length === 0) {
      acc.block(
        "unsupported-realization",
        [action.id],
        [],
        `${action.id} is blocked by its operator`
      );
    }
  }
  for (const conflict of composition.conflicts) {
    acc.block(
      "composition-conflict",
      conflict.actions,
      conflict.entities,
      `${conflict.kind}: ${conflict.detail}`
    );
  }
}

// ---------------------------------------------------------------------------
// Entry points

function packageOfOperator(
  operator: ArchitecturalOperator | undefined
): string | undefined {
  if (operator === undefined) {
    return undefined;
  }
  const { subject } = operator;
  switch (subject.kind) {
    case "symbol":
      return subject.package;
    case "package":
      return subject.packageId;
    case "boundary":
      return subject.from;
    case "behavior":
      return subject.packages[0];
    case "concept":
      return operator.placement.current?.package;
    default:
      throw new Error("Unexpected subject.kind.");
  }
}

function status(
  planner: Planner,
  real: StructuralActionRealization[]
): OperatorExecutionPlanStatus {
  const { acc, composition } = planner;
  if (
    composition.status === "stale" ||
    acc.blockers.some((b) => b.kind === "source-state-mismatch")
  ) {
    return "stale";
  }
  if (
    composition.status === "unsupported" ||
    [...acc.transformations.values()].some((t) => t.status === "unsupported")
  ) {
    return "unsupported";
  }
  if (acc.blockers.length > 0 || acc.conflicts.length > 0) {
    return "blocked";
  }
  if (
    acc.gaps.length > 0 ||
    real.some((r) => r.status !== "realized") ||
    composition.unresolved.some((g) => g.blocking)
  ) {
    return "partial";
  }
  return "ready";
}

function fingerprintOf(
  planner: Planner,
  files: string[]
): OperatorPlanFingerprint {
  const { context, composition } = planner;
  const hashes = uniq(files).map((file) => ({
    file,
    hash: hashFile(context, file),
  }));
  const factsHash = hash16(composition.fingerprint.facts);
  return {
    factsHash,
    files: hashes,
    hash: hash16([
      composition.fingerprint.hash,
      factsHash,
      hashes.map((h) => `${h.file}=${h.hash}`),
    ]),
    operatorCompositionFingerprint: composition.fingerprint.hash,
  };
}

function targetsOf(
  transformations: PlannedTransformation[],
  context: OperatorPlanningContext
): OperatorPlanTarget[] {
  const byFile = new Map<string, string[]>();
  for (const t of transformations) {
    if (t.kind === "verify-only") {
      continue;
    }
    const list = byFile.get(t.file) ?? [];
    list.push(t.id);
    byFile.set(t.file, list);
  }
  return [...byFile]
    .sort(([a], [b]) => byId(a, b))
    .map(([file, ids]) => {
      const pkg =
        packageOfFile(context, file) ??
        [...context.packages.values()].find((p) =>
          file.startsWith(`${p.relPath}/`)
        )?.id;
      return {
        file,
        ...(pkg !== undefined && { package: pkg }),
        kind: resolveKind(file),
        transformations: ids.sort(byId),
      };
    });
}

function resolveKind(file: string): "manifest" | "test" | "source" {
  if (isManifest(file)) {
    return "manifest";
  }
  if (isTestFile(file)) {
    return "test";
  }
  return "source";
}

function diagnostics(
  acc: Assembly,
  transformations: PlannedTransformation[],
  targets: OperatorPlanTarget[]
): OperatorPlanDiagnostics {
  return {
    exportChanges: transformations.filter(
      (t) =>
        t.kind === "add-export" ||
        t.kind === "remove-export" ||
        t.kind === "rewrite-reexport" ||
        t.kind === "preserve-compatibility-export"
    ).length,
    files: targets.length,
    importRewrites: transformations.filter(
      (t) => t.kind === "rewrite-import" || t.kind === "update-test-import"
    ).length,
    kinds: uniq(
      transformations.map((t) => t.kind)
    ) as PlannedTransformationKind[],
    manifestChanges: transformations.filter(
      (t) =>
        t.kind === "update-package-dependency" ||
        t.kind === "update-package-export"
    ).length,
    manifests: targets.filter((t) => t.kind === "manifest").length,
    sourceFiles: targets.filter((t) => t.kind === "source").length,
    sourceForms: [...acc.forms]
      .sort(([a], [b]) => byId(a, b))
      .map(([form, count]) => ({ count, form })),
    testFiles: targets.filter((t) => t.kind === "test").length,
    transformations: transformations.length,
    unsupportedForms: uniq([...acc.unsupportedForms]),
  };
}

/**
 * Resolve a composition against the sources. Placement actions are planned
 * first so exposure, redirect, and compatibility actions can see where
 * declarations land; then manifests, cycles, and conflicts are settled over
 * the whole set. Nothing here writes; the project is read and left as is.
 */
export function planOperatorComposition(
  composition: OperatorComposition,
  operators: readonly ArchitecturalOperator[],
  context: OperatorPlanningContext,
  facts: OperatorContext
): OperatorExecutionPlan {
  const planner: Planner = {
    acc: new Assembly(),
    composition,
    context,
    facts,
    operators: new Map(operators.map((o) => [o.id, o])),
  };
  const { acc } = planner;
  carryCompositionState(planner);
  const placement = composition.actions.filter(
    (a) =>
      a.kind === "relocate-semantic-declaration" ||
      a.kind === "relocate-behavior-responsibility"
  );
  const rest = composition.actions.filter((a) => !placement.includes(a));
  planOperatorCompositionAction(placement, planner, acc);
  for (const action of rest) {
    if (action.status === "unsupported") {
      continue;
    }
    switch (action.kind) {
      case "establish-target-exposure":
        realizeExposure(planner, action);
        break;
      case "preserve-public-exposure":
        realizeCompatibility(planner, action);
        break;
      case "internalize-old-exposure":
        realizeInternalize(planner, action);
        break;
      case "redirect-concept-dependency":
        realizeRedirect(planner, action);
        break;
      case "relocate-semantic-declaration":
      case "relocate-behavior-responsibility":
        break;
      case "preserve-representation-boundary":
      case "preserve-implementation-split":
      case "remove-boundary-participation":
      case "preserve-anchor-boundary":
        realizeVerifyOnly(planner, action);
        break;
      default:
        throw new Error("Unexpected action.kind.");
    }
  }
  settleStrategies(planner);
  finalizeManifests(planner);
  finalizeCycles(planner);
  finalizeConflicts(planner);
  finalizeDependencies(planner);

  const ids = [...acc.transformations.keys()].sort(byId);
  const cycles = transformationCycles(ids, acc.dependencies);
  if (cycles.length > 0) {
    acc.block(
      "unsupported-realization",
      uniq(cycles.flatMap((id) => acc.transformations.get(id)?.actions ?? [])),
      cycles,
      `transformation order is cyclic: ${cycles.join(", ")}`
    );
  }
  const layer = layerOf(ids, acc.dependencies);
  const transformations = ids
    .map((id) => acc.transformations.get(id))
    .filter((t): t is PlannedTransformation => t !== undefined)
    .sort(
      (a, b) =>
        (layer.get(a.id) ?? 0) - (layer.get(b.id) ?? 0) ||
        KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) ||
        byId(a.file, b.file) ||
        byId(a.id, b.id)
    );
  const real = realizations(planner);
  const verification = buildVerification(planner);
  const preserved = preservations(planner, verification);
  const predicted = deltas(planner);
  const targets = targetsOf(transformations, context);
  const files = uniq([...acc.filesRead, ...targets.map((t) => t.file)]);
  const fingerprint = fingerprintOf(planner, files);
  const planStatus = status(planner, real);
  const idHash = hash16([
    composition.id,
    composition.fingerprint.hash,
    ids,
    fingerprint.files.map((f) => `${f.file}=${f.hash}`),
    OPERATOR_PLAN_SCHEMA_VERSION,
    OPERATOR_PLANNING_POLICY_VERSION,
  ]);
  return {
    blockers: [...acc.blockers].sort(
      (a, b) =>
        byId(a.kind, b.kind) || byId(a.entities.join(","), b.entities.join(","))
    ),
    compositionId: composition.id,
    conflicts: [...acc.conflicts].sort(
      (a, b) =>
        byId(a.kind, b.kind) || byId(a.entities.join(","), b.entities.join(","))
    ),
    dependencies: [...acc.dependencies].sort(
      (a, b) => byId(a.before, b.before) || byId(a.after, b.after)
    ),
    diagnostics: diagnostics(acc, transformations, targets),
    fingerprint,
    id: `plan:${idHash}`,
    importRewrites: [...acc.importRewrites].sort(
      (a, b) =>
        byId(a.file, b.file) ||
        byId(a.importedSymbolId, b.importedSymbolId) ||
        byId(a.transformationId, b.transformationId)
    ),
    inputs: composition.operators.map((id) => {
      const pkg = packageOfOperator(planner.operators.get(id));
      return { operatorId: id, ...(pkg !== undefined && { package: pkg }) };
    }),
    policyVersion: OPERATOR_PLANNING_POLICY_VERSION,
    predicted,
    preserved,
    realizations: real,
    relocations: [...acc.relocations].sort(
      (a, b) =>
        byId(a.actionId, b.actionId) ||
        byId(a.sourceModule ?? "", b.sourceModule ?? "")
    ),
    schemaVersion: OPERATOR_PLAN_SCHEMA_VERSION,
    status: planStatus,
    targets,
    transformations,
    unresolved: [...acc.gaps].sort(
      (a, b) =>
        byId(a.kind, b.kind) || byId(a.entities.join(","), b.entities.join(","))
    ),
    verification,
  };
}

function planOperatorCompositionAction(
  placement: ComposedStructuralAction[],
  planner: Planner,
  acc: Assembly
) {
  const visitAction = (action: ComposedStructuralAction) =>
    resolveVisitAction(planner, acc, action);
  for (const action of placement) {
    visitAction(action);
  }
}

/** Convenience for one operator: composes it alone, then plans the composition. */
export function planArchitecturalOperator(
  operator: ArchitecturalOperator,
  decomposition: OperatorDecomposition,
  context: OperatorPlanningContext,
  facts: OperatorContext
): OperatorExecutionPlan {
  const composition = composeArchitecturalOperators(
    [operator],
    [decomposition],
    facts
  );
  return planOperatorComposition(composition, [operator], context, facts);
}

const COMPARED: (keyof OperatorExecutionPlan)[] = [
  "targets",
  "transformations",
  "dependencies",
  "relocations",
  "importRewrites",
  "realizations",
  "preserved",
  "predicted",
  "verification",
  "blockers",
  "conflicts",
  "unresolved",
  "status",
];

/** Sections of `plan` that differ from `current`, a fresh plan of the same composition; empty when they agree. */
export function comparePlans(
  plan: OperatorExecutionPlan,
  current: OperatorExecutionPlan
): string[] {
  const problems = COMPARED.filter(
    (key) => JSON.stringify(plan[key]) !== JSON.stringify(current[key])
  ).map((key) => `${key} differs from a fresh plan`);
  if (plan.id !== current.id) {
    problems.push(`plan id ${plan.id} is not ${current.id}`);
  }
  return problems;
}

/**
 * Re-plan and compare. `stale` when a fingerprinted file's bytes changed;
 * `invalid` when the record disagrees with what planning yields now or its
 * graph is cyclic.
 */
export function validateOperatorExecutionPlan(
  plan: OperatorExecutionPlan,
  composition: OperatorComposition,
  operators: readonly ArchitecturalOperator[],
  context: OperatorPlanningContext,
  facts: OperatorContext
): OperatorExecutionPlanValidation {
  const problems: string[] = [];
  const changedFiles = plan.fingerprint.files
    .filter((f) => hashFile(context, f.file) !== f.hash)
    .map((f) => f.file);
  if (plan.compositionId !== composition.id) {
    problems.push(`plan is for ${plan.compositionId}, not ${composition.id}`);
  }
  if (
    plan.fingerprint.operatorCompositionFingerprint !==
    composition.fingerprint.hash
  ) {
    problems.push("the composition fingerprint moved");
  }
  const ids = new Set(plan.transformations.map((t) => t.id));
  for (const d of plan.dependencies) {
    if (!(ids.has(d.before) && ids.has(d.after))) {
      problems.push(
        `dependency ${d.before} → ${d.after} names an unknown transformation`
      );
    }
  }
  const cycle = transformationCycles([...ids], plan.dependencies);
  if (cycle.length > 0) {
    problems.push(`cyclic: ${cycle.join(", ")}`);
  }
  for (const r of plan.realizations) {
    for (const id of r.transformations) {
      if (!ids.has(id)) {
        problems.push(`realization of ${r.actionId} names unknown ${id}`);
      }
    }
  }
  if (changedFiles.length > 0) {
    return {
      changedFiles,
      cycles: cycle.length > 0 ? [cycle] : [],
      fingerprint: plan.fingerprint.hash,
      planId: plan.id,
      problems,
      status: "stale",
    };
  }
  const current = planOperatorComposition(
    composition,
    operators,
    context,
    facts
  );
  problems.push(...comparePlans(plan, current));
  return {
    changedFiles,
    currentFingerprint: current.fingerprint.hash,
    cycles: cycle.length > 0 ? [cycle] : [],
    fingerprint: plan.fingerprint.hash,
    planId: plan.id,
    problems,
    status: problems.length === 0 ? "valid" : "invalid",
  };
}
function resolveVisitAction(
  planner: Planner,
  acc: Assembly,
  action: ComposedStructuralAction
) {
  if (action.status === "unsupported") {
    return;
  }
  const source = packageOf(planner, action.current?.package);
  const target = packageOf(planner, action.target?.package);
  const conceptId = conceptOf(action);
  if (source === undefined || target === undefined || conceptId === undefined) {
    acc.block(
      "source-state-mismatch",
      [action.id],
      [action.current?.package ?? "?", action.target?.package ?? "?"],
      `${action.current?.package ?? "?"} or ${action.target?.package ?? "?"} is not a workspace package`
    );
    return;
  }
  const concept = symbolOf(planner, conceptId, action);
  if (concept === undefined) {
    return;
  }
  if (action.kind === "relocate-semantic-declaration") {
    if (concept.package !== source.id) {
      acc.block(
        "source-state-mismatch",
        [action.id],
        [concept.id],
        `${concept.name} is declared in ${concept.package ?? "?"}, not ${source.id}`
      );
      return;
    }
    realizeRelocation(planner, {
      action,
      concept,
      conceptId,
      members: [
        {
          role: "governing",
          source: "concept-declaration",
          symbolId: concept.id,
        },
      ],
      source,
      symbols: [concept],
      target,
    });
  } else {
    const { members, symbols } = behaviorMembers(planner, concept, source);
    if (members.length === 0) {
      acc.gap(
        "behavior-members-unresolved",
        [action.id],
        [conceptId, source.id],
        `no class in ${source.id} implements ${concept.name} and no function returns it; the governing behavior cannot be named from the sources`
      );
      return;
    }
    realizeRelocation(planner, {
      action,
      concept,
      conceptId,
      members,
      source,
      symbols,
      target,
    });
  }
}
function resolveVisitSite(
  movingFiles: Set<string>,
  acc: Assembly,
  input: RelocationInput,
  planner: Planner,
  action: ComposedStructuralAction,
  moves: PlannedTransformation[],
  targetModule: string,
  symbol: LocatedSymbol,
  site: ImportSite
) {
  if (movingFiles.has(site.file)) {
    acc.form("co-moved-import");
    return;
  }
  if (site.form !== "import") {
    return;
  }
  if (site.package === input.target.id) {
    const local = rewriteSite(planner, {
      action,
      moves,
      site,
      specifier:
        site.file === targetModule
          ? undefined
          : relativeSpecifier(site.file, targetModule),
      symbol,
      toPackage: input.target.id,
    });
    // A split import keeps its declaration for the other names; the edge stays.
    if (local !== undefined && site.otherNames.length === 0) {
      acc.removeSite(input.target.id, input.source.id, local.id, action.id);
    }
  } else if (site.package === input.source.id) {
    const root = rootEntrypoint(input.target);
    if (root === undefined) {
      acc.block(
        "package-export-strategy-unresolved",
        [action.id],
        [input.target.id],
        `${input.target.id} declares no TypeScript entrypoint; ${site.file} cannot import ${symbol.name} from it`
      );
      return;
    }
    const inward = inwardRedirect(
      planner,
      input.source.id,
      input.target.id,
      input.conceptId
    );
    const rewrite = rewriteSite(planner, {
      action,
      moves,
      site,
      specifier: root.entrypoint,
      symbol,
      toPackage: input.target.id,
    });
    if (inward !== undefined && rewrite !== undefined) {
      acc.link(inward.id, rewrite.id);
      rewrite.actions = uniq([...rewrite.actions, inward.id]);
    }
    if (rewrite !== undefined) {
      acc.edge(
        input.source.id,
        input.target.id,
        !site.typeOnly,
        rewrite.id,
        action.id
      );
    }
  }
}
