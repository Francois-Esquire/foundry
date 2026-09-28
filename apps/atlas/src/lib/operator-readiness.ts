import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, posix, relative, resolve, sep } from "node:path";

import { ts } from "ts-morph";

import type { MutationCapabilityRegistry } from "./mutation-capabilities";
import {
  capabilityFingerprint,
  DEFAULT_MUTATION_CAPABILITIES,
  lookupCapability,
} from "./mutation-capabilities";
import type {
  CompositionPreservation,
  OperatorComposition,
} from "./operator-composition-types";
import {
  comparePlans,
  planOperatorComposition,
  transformationCycles,
} from "./operator-plan";
import {
  cyclesThrough,
  hasSideEffects,
  type PackageImportEdge,
  packageImportEdges,
} from "./operator-plan-source";
import type {
  OperatorExecutionPlan,
  OperatorPlanBlocker,
  OperatorPlanFileHash,
  PlannedTransformation,
  PlannedVerificationKind,
} from "./operator-plan-types";
import type { OperatorPlanningContext } from "./operator-planning-context";
import {
  hashFile,
  locateSymbol,
  packageOfFile,
  sourceFileOf,
} from "./operator-planning-context";
import type {
  AuthorizedMutationPlan,
  MutationAuthorization,
  MutationAuthorizationFingerprint,
  MutationCoverageRequirement,
  MutationCoverageScope,
  OperatorPlanReadiness,
  ReadinessArchitecturalAssertion,
  ReadinessBaselineCheck,
  ReadinessBlocker,
  ReadinessBlockerKind,
  ReadinessCaution,
  ReadinessCommand,
  ReadinessCommandResult,
  ReadinessCompleteness,
  ReadinessConditionalResolution,
  ReadinessConsistency,
  ReadinessConstraintCheck,
  ReadinessConstraintKind,
  ReadinessConstraintResult,
  ReadinessConstraintStatus,
  ReadinessFileState,
  ReadinessIntentCoverage,
  ReadinessMutationCapability,
  ReadinessPreservationResult,
  ReadinessPreservationState,
  ReadinessPreservationStatus,
  ReadinessRealizability,
  ReadinessRisk,
  ReadinessRiskKind,
  ReadinessRollbackContract,
  ReadinessSourceState,
  ReadinessUnsupportedForm,
  ReadinessVerificationStatus,
  ReadinessVerificationStep,
  RollbackFile,
  VerificationBaselineAllowance,
} from "./operator-readiness-types";
import {
  OPERATOR_READINESS_POLICY_VERSION,
  OPERATOR_READINESS_SCHEMA_VERSION,
} from "./operator-readiness-types";
import type {
  ArchitecturalOperator,
  ArchitecturalOperatorKind,
  OperatorContext,
  OperatorFact,
  OperatorVerificationKind,
} from "./operator-types";
import type { WorkspaceCoverage } from "./workspace-types";

const extractFailuresPattern = /\s+/g;
const gitDirtyPattern = /^.* -> /;

// V11.4 readiness assessment. Reads the plan, the repository, and the
// mutator's capability registry; runs read-only baseline checks; answers
// with one authorization. It never repairs the plan and never writes.

export type ReadinessCommandRunner = (
  command: ReadinessCommand,
  root: string
) => { exitCode: number; output: string };

export interface OperatorReadinessContext {
  allowances?: VerificationBaselineAllowance[];
  capabilities?: MutationCapabilityRegistry;
  composition: OperatorComposition;
  facts: OperatorContext;
  /** Consult git for working-tree state; default true. */
  git?: boolean;
  operators: readonly ArchitecturalOperator[];
  planning: OperatorPlanningContext;
  /** Runs baseline commands; default spawns them with `CI=1`. */
  runner?: ReadinessCommandRunner;
}

/** Packages that must be analyzed before a mutation of this kind is authorized. */
const MUTATION_COVERAGE_REQUIREMENTS: MutationCoverageRequirement[] = [
  { kind: "internalize", requiredPackages: "subject-only" },
  { kind: "move", requiredPackages: "source-target-consumers" },
  { kind: "rehome-concept", requiredPackages: "source-target-consumers" },
  { kind: "rehome-behavior", requiredPackages: "source-target-consumers" },
  { kind: "redirect-dependency", requiredPackages: "source-target" },
  { kind: "preserve-boundary", requiredPackages: "all-participating" },
];

const V12_CONTRACT: string[] = [
  "V12 revalidates the authorization fingerprint immediately before the first write and aborts on any mismatch.",
  "V12 executes the authorized transformations only; it adds none, changes no destination, and chooses no compatibility strategy.",
  "V12 executes the plan as one transaction: a failed verification restores every snapshotted byte, deletes every created file, and recreates every deleted one.",
  "V12 runs the verification sequence exactly as resolved here and treats a failed or skipped required step as a failed mutation.",
  "A mismatch of any kind returns to planning and readiness; V12 never repairs a plan.",
];

const MOVE_KINDS = new Set<PlannedTransformation["kind"]>([
  "move-symbol",
  "move-module",
]);
const IMPORT_KINDS = new Set<PlannedTransformation["kind"]>([
  "rewrite-import",
  "update-test-import",
]);
const EXPOSURE_ADD_KINDS = new Set<PlannedTransformation["kind"]>([
  "add-export",
  "preserve-compatibility-export",
]);
const EXPOSURE_REMOVE_KINDS = new Set<PlannedTransformation["kind"]>([
  "remove-export",
  "rewrite-reexport",
]);

const REQUIREMENT_STEPS: Record<
  OperatorVerificationKind,
  PlannedVerificationKind[]
> = {
  "anchor-preserved": ["verify-anchor"],
  "behavior-location": ["verify-symbol-location"],
  "boundary-interaction": ["analyze-workspace", "analyze-package"],
  "concept-center": ["verify-symbol-location", "analyze-package"],
  "dependency-edge": ["verify-dependency", "verify-imports"],
  "public-surface": ["verify-public-surface"],
  tests: ["tests"],
  typecheck: ["typecheck"],
};

function hash16(parts: unknown[]): string {
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 16);
}

function byId(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function uniq(values: string[]): string[] {
  return [...new Set(values)].sort(byId);
}

function isManifest(file: string): boolean {
  return posix.basename(file) === "package.json";
}

function names(t: PlannedTransformation): string[] {
  return uniq([...(t.before?.names ?? []), ...(t.after?.names ?? [])]);
}

function symbolName(id: string): string {
  return id.slice(id.lastIndexOf("#") + 1);
}

class Findings {
  readonly blockers: ReadinessBlocker[] = [];
  readonly cautions: ReadinessCaution[] = [];
  readonly risks: ReadinessRisk[] = [];
  readonly checks: ReadinessConstraintCheck[] = [];

  block(kind: ReadinessBlockerKind, entities: string[], detail: string): void {
    if (!this.blockers.some((b) => b.kind === kind && b.detail === detail)) {
      this.blockers.push({ detail, entities: uniq(entities), kind });
    }
  }

  caution(
    kind: ReadinessCaution["kind"],
    entities: string[],
    detail: string
  ): void {
    if (!this.cautions.some((c) => c.kind === kind && c.detail === detail)) {
      this.cautions.push({ detail, entities: uniq(entities), kind });
    }
  }

  risk(
    kind: ReadinessRiskKind,
    entities: string[],
    detail: string,
    blocking: boolean
  ): void {
    if (!this.risks.some((r) => r.kind === kind && r.detail === detail)) {
      this.risks.push({ blocking, detail, entities: uniq(entities), kind });
    }
  }

  check(
    kind: ReadinessConstraintKind,
    status: ReadinessConstraintCheck["status"],
    entities: string[],
    detail: string
  ): void {
    this.checks.push({ detail, entities: uniq(entities), kind, status });
  }

  has(kind: ReadinessBlockerKind): boolean {
    return this.blockers.some((b) => b.kind === kind);
  }
}

interface Assessment {
  context: OperatorReadinessContext;
  /** Files the plan creates from nothing. */
  created: string[];
  /** Files the plan removes. */
  deleted: string[];
  findings: Findings;
  /** The same composition planned again now; absent when the sources moved. Compared, never returned. */
  fresh?: OperatorExecutionPlan;
  operators: Map<string, ArchitecturalOperator>;
  plan: OperatorExecutionPlan;
  registry: MutationCapabilityRegistry;
}

function createdFiles(plan: OperatorExecutionPlan): string[] {
  return uniq(
    plan.transformations.flatMap((t) => {
      if (t.kind === "create-module") {
        return [t.file];
      }
      if (t.kind === "move-module" && t.after?.module !== undefined) {
        return [t.after.module];
      }
      return [];
    })
  );
}

function deletedFiles(plan: OperatorExecutionPlan): string[] {
  return uniq(
    plan.transformations.flatMap((t) =>
      t.kind === "delete-empty-module" || t.kind === "move-module"
        ? [t.file]
        : []
    )
  );
}

// ---------------------------------------------------------------------------
// Source state

/** Root-relative dirty files (porcelain paths are repository-relative, so they are re-based); undefined without git. */
function gitDirty(root: string, enabled: boolean): string[] | undefined {
  if (!enabled) {
    return undefined;
  }
  try {
    const run = (args: string[]) =>
      execFileSync("git", args, {
        cwd: root,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
    const top = realpathSync(run(["rev-parse", "--show-toplevel"]));
    return run(["status", "--porcelain", "--untracked-files=all"])
      .split("\n")
      .filter((line) => line.length > 3)
      .map((line) => line.slice(3).trim().replace(gitDirtyPattern, ""))
      .map((file) => relative(root, join(top, file)).split(sep).join("/"))
      .filter((file) => !file.startsWith("../"));
  } catch {
    return undefined;
  }
}

function sourceState(a: Assessment): ReadinessSourceState {
  const { plan, context } = a;
  const states: ReadinessFileState[] = plan.fingerprint.files.map((f) => {
    const actual = hashFile(context.planning, f.file);
    return {
      actual,
      expected: f.hash,
      file: f.file,
      status: resolveStatus(actual, f),
    };
  });
  const fingerprinted = new Set(states.map((s) => s.file));
  for (const file of a.created) {
    if (fingerprinted.has(file)) {
      continue;
    }
    const actual = hashFile(context.planning, file);
    states.push({
      actual,
      expected: "absent",
      file,
      status: actual === "missing" ? "unchanged" : "unexpected",
    });
  }
  states.sort((x, y) => byId(x.file, y.file));
  const dirty = gitDirty(context.planning.root, context.git !== false);
  const planned = new Set(states.map((s) => s.file));
  const plannedDirty =
    dirty === undefined
      ? []
      : uniq(
          dirty.filter(
            (f) =>
              planned.has(f) &&
              states.find((s) => s.file === f)?.status === "unchanged"
          )
        );
  const staleFiles = states
    .filter((s) => s.status === "changed")
    .map((s) => s.file);
  const missingFiles = states
    .filter((s) => s.status === "missing")
    .map((s) => s.file);
  const unexpectedFiles = states
    .filter((s) => s.status === "unexpected")
    .map((s) => s.file);
  return {
    expectedFiles: states.filter((s) => !isManifest(s.file)),
    expectedManifests: states.filter((s) => isManifest(s.file)),
    git: {
      available: dirty !== undefined,
      plannedDirty,
      unplannedDirty:
        dirty === undefined
          ? 0
          : new Set(dirty.filter((f) => !planned.has(f))).size,
    },
    missingFiles,
    staleFiles,
    unchanged: states.every((s) => s.status === "unchanged"),
    unexpectedFiles,
  };
}

function resolveStatus(
  actual: string,
  f: OperatorPlanFileHash
): "unchanged" | "missing" | "changed" {
  if (actual === f.hash) {
    return "unchanged";
  }
  if (actual === "missing") {
    return "missing";
  }
  return "changed";
}

// ---------------------------------------------------------------------------
// Completeness

function completeness(a: Assessment): ReadinessCompleteness {
  const { plan, context, findings } = a;
  const { composition } = context;
  const required = composition.actions.filter(
    (x) => x.status === "required" || x.status === "conditional"
  );
  const realized = required.filter((x) =>
    plan.realizations.some(
      (r) => r.actionId === x.id && r.status === "realized"
    )
  );
  for (const action of required) {
    if (!realized.includes(action)) {
      findings.block(
        "plan-incomplete",
        [action.id],
        `${action.id} is ${plan.realizations.find((r) => r.actionId === action.id)?.status ?? "unrealized"}: no source transformation realizes it`
      );
    }
  }
  const covered = plan.preserved.filter((p) => p.status !== "unproven");
  const effects = composition.effects.filter(
    (e) => e.relation !== "conflicting"
  );
  const coveredEffects = plan.predicted.filter(
    (d) =>
      d.sourceTransformations.length > 0 &&
      effects.some((e) => e.dimension === d.dimension && e.change === d.change)
  );
  const stepKinds = new Set(plan.verification.map((s) => s.kind));
  const plannedRequirements = composition.verification.filter((v) =>
    REQUIREMENT_STEPS[v.kind].some((k) => stepKinds.has(k))
  );
  for (const v of composition.verification) {
    if (!plannedRequirements.includes(v)) {
      findings.block(
        "verification-incomplete",
        [v.kind],
        `the composition requires ${v.kind} verification and the plan has no step for it`
      );
    }
  }
  const conditional = plan.transformations
    .filter((t) => t.status === "conditional")
    .map((t): ReadinessConditionalResolution => {
      const holds =
        a.fresh?.transformations.some((f) => f.id === t.id) ?? false;
      return {
        detail: holds
          ? "fresh planning against the unchanged sources still yields this transformation; the condition holds and V12 executes it as required"
          : "fresh planning no longer yields this transformation; the condition cannot be settled here",
        resolution: holds ? "required" : "unresolved",
        transformationId: t.id,
      };
    });
  for (const c of conditional) {
    if (c.resolution === "unresolved") {
      findings.block(
        "plan-incomplete",
        [c.transformationId],
        `${c.transformationId} is conditional and its condition cannot be settled against the current sources`
      );
    }
  }
  const gaps = uniq([
    ...plan.unresolved.map((g) => `${g.kind}:${g.entities.join(",")}`),
    ...composition.unresolved
      .filter((g) => g.blocking)
      .map((g) => `${g.kind}:${g.entities.join(",")}`),
  ]);
  for (const gap of gaps) {
    findings.block("plan-incomplete", [gap], `unresolved planning gap ${gap}`);
  }
  return {
    complete:
      realized.length === required.length &&
      plannedRequirements.length === composition.verification.length &&
      conditional.every((c) => c.resolution === "required") &&
      gaps.length === 0,
    conditionalTransformations: conditional,
    coveredEffects: coveredEffects.length,
    coveredPreservations: covered.length,
    expectedEffects: effects.length,
    plannedVerificationRequirements: plannedRequirements.length,
    preservations: composition.preservations.length,
    realizedActions: realized.length,
    requiredActions: required.length,
    unresolvedGaps: gaps,
    verificationRequirements: composition.verification.length,
  };
}

// ---------------------------------------------------------------------------
// Structural consistency

function overlapping(a: string[], b: string[]): boolean {
  return a.some((x) => b.includes(x));
}

function consistency(a: Assessment): ReadinessConsistency {
  const { plan, context, findings } = a;
  const ids = plan.transformations.map((t) => t.id);
  const idSet = new Set(ids);
  const noDuplicates = idSet.size === ids.length;
  if (!noDuplicates) {
    findings.block(
      "transformation-conflict",
      ids.filter((id, i) => ids.indexOf(id) !== i),
      "the plan lists a transformation id twice"
    );
  }
  let acyclic = true;
  for (const d of plan.dependencies) {
    if (!(idSet.has(d.before) && idSet.has(d.after))) {
      acyclic = false;
      findings.block(
        "transformation-conflict",
        [d.before, d.after],
        `dependency ${d.before} → ${d.after} names a transformation the plan does not contain`
      );
    }
  }
  const cycle = transformationCycles(ids, plan.dependencies);
  if (cycle.length > 0) {
    acyclic = false;
    findings.block(
      "transformation-conflict",
      cycle,
      `the transformation graph is cyclic through ${cycle.join(", ")}`
    );
  }

  let noDestination = true;
  const moves = plan.transformations.filter((t) => MOVE_KINDS.has(t.kind));
  const visitM2 = () => {
    for (const m of moves) {
      const key = m.subject?.symbolId ?? m.subject?.moduleId;
      const other = moves.find(
        (o) =>
          o !== m &&
          (o.subject?.symbolId ?? o.subject?.moduleId) === key &&
          o.after?.module !== m.after?.module
      );
      if (other !== undefined && key !== undefined) {
        noDestination = false;
        findings.block(
          "transformation-conflict",
          [m.id, other.id],
          `${key} moves to both ${m.after?.module ?? "?"} and ${other.after?.module ?? "?"}`
        );
      }
      if (
        m.kind === "move-symbol" &&
        m.after?.module !== undefined &&
        !a.created.includes(m.after.module) &&
        m.subject?.symbolId !== undefined
      ) {
        const located = locateSymbol(
          context.planning,
          `${m.after.module}#${symbolName(m.subject.symbolId)}`
        );
        if (located.status !== "missing") {
          noDestination = false;
          findings.block(
            "transformation-conflict",
            [m.id, m.after.module],
            `${m.after.module} already declares ${symbolName(m.subject.symbolId)}; the move would collide`
          );
        }
      }
    }
  };
  visitM2();

  let noImports = true;
  const imports = plan.transformations.filter((t) => IMPORT_KINDS.has(t.kind));
  for (const t of imports) {
    const clash = imports.find(
      (o) =>
        o !== t &&
        o.file === t.file &&
        o.before?.specifier === t.before?.specifier &&
        o.after?.specifier !== t.after?.specifier &&
        overlapping(o.before?.names ?? [], t.before?.names ?? [])
    );
    if (clash !== undefined) {
      noImports = false;
      findings.block(
        "transformation-conflict",
        [t.id, clash.id],
        `${t.file} rewrites the same import of ${(t.before?.names ?? []).join(", ")} to two different specifiers`
      );
    }
  }

  let noExports = true;
  const added = plan.transformations.filter((t) =>
    EXPOSURE_ADD_KINDS.has(t.kind)
  );
  const removed = plan.transformations.filter((t) =>
    EXPOSURE_REMOVE_KINDS.has(t.kind)
  );
  for (const add of added) {
    const clash = removed.find(
      (r) =>
        r.file === add.file && overlapping(names(r), add.after?.names ?? [])
    );
    if (clash !== undefined) {
      noExports = false;
      findings.block(
        "transformation-conflict",
        [add.id, clash.id],
        `${add.file} both adds and removes an export of ${(add.after?.names ?? []).join(", ")}`
      );
    }
  }

  let noManifests = true;
  const manifests = plan.transformations.filter(
    (t) => t.kind === "update-package-dependency"
  );
  const visitM = () => {
    for (const m of manifests) {
      const dependency = m.after?.dependency;
      if (dependency === undefined) {
        continue;
      }
      const clash = manifests.find(
        (o) =>
          o !== m &&
          o.file === m.file &&
          o.after?.dependency?.package === dependency.package &&
          o.after.dependency.declared !== dependency.declared
      );
      if (clash !== undefined) {
        noManifests = false;
        findings.block(
          "transformation-conflict",
          [m.id, clash.id],
          `${m.file} both adds and removes the dependency on ${dependency.package}`
        );
      }
      const pkg = [...context.planning.packages.values()].find(
        (p) => p.manifest === m.file
      );
      if (pkg === undefined) {
        continue;
      }
      const declared = pkg.dependencies.includes(dependency.package);
      if (declared === dependency.declared && m.status !== "conditional") {
        noManifests = false;
        findings.block(
          "transformation-conflict",
          [m.id, m.file],
          `${m.file} ${declared ? "already declares" : "does not declare"} ${dependency.package}; the manifest change no longer applies`
        );
      }
    }
  };
  visitM();

  let noCoverage = plan.conflicts.length === 0;
  for (const c of plan.conflicts) {
    findings.block(
      "transformation-conflict",
      [...c.transformations, ...c.entities],
      `${c.kind}: ${c.detail}`
    );
  }
  const visitR4 = () => {
    for (const r of plan.realizations) {
      for (const id of r.transformations) {
        if (!idSet.has(id)) {
          noCoverage = false;
          findings.block(
            "transformation-conflict",
            [r.actionId, id],
            `realization of ${r.actionId} names ${id}, which the plan does not contain`
          );
        }
      }
    }
  };
  visitR4();

  const problems =
    a.fresh === undefined ? ["no fresh plan"] : comparePlans(plan, a.fresh);
  const matchesFresh = problems.length === 0;
  if (!matchesFresh) {
    findings.block(
      "plan-incomplete",
      [plan.id],
      `the plan no longer matches fresh planning against the current sources: ${problems.join("; ")}`
    );
  }

  return {
    consistent:
      acyclic &&
      noDuplicates &&
      noDestination &&
      noImports &&
      noExports &&
      noManifests &&
      noCoverage &&
      matchesFresh,
    matchesFreshPlanning: matchesFresh,
    noActionCoverageConflict: noCoverage,
    noDestinationConflicts: noDestination,
    noDuplicateConflicts: noDuplicates,
    noExportConflicts: noExports,
    noImportConflicts: noImports,
    noManifestConflicts: noManifests,
    transformationDagAcyclic: acyclic,
  };
}

// ---------------------------------------------------------------------------
// Constraints

function operatorsOf(
  a: Assessment,
  t: PlannedTransformation
): ArchitecturalOperator[] {
  const ids = uniq(
    t.actions.flatMap(
      (id) =>
        a.context.composition.actions.find((x) => x.id === id)
          ?.sourceOperators ?? []
    )
  );
  return ids.flatMap((id) => {
    const op = a.operators.get(id);
    return op === undefined ? [] : [op];
  });
}

function movedEntities(t: PlannedTransformation): string[] {
  return uniq([
    ...(t.subject?.symbolId === undefined ? [] : [t.subject.symbolId]),
    ...(t.subject?.moduleId === undefined ? [] : [t.subject.moduleId]),
    ...(t.subject?.conceptId === undefined ? [] : [t.subject.conceptId]),
    t.file,
  ]);
}

function preservationChecks(a: Assessment): void {
  const { plan, context, findings } = a;
  const moves = plan.transformations.filter((t) => MOVE_KINDS.has(t.kind));
  preservationChecksKind(context, findings, moves, plan);
  for (const op of a.operators.values()) {
    for (const c of op.constraints) {
      if (c.kind === "anchor" && c.effect === "blocking") {
        findings.block("anchor-violation", c.entityIds, c.detail);
      }
    }
  }
}

function preservationChecksKind(
  context: OperatorReadinessContext,
  findings: Findings,
  moves: PlannedTransformation[],
  plan: OperatorExecutionPlan
) {
  for (const kind of [
    "anchor",
    "representation-boundary",
    "implementation-split",
  ] as const) {
    const preservations = context.composition.preservations.filter(
      (p) => p.kind === kind
    );
    if (preservations.length === 0) {
      findings.check(kind, "not-applicable", [], `no ${kind} preservation`);
      continue;
    }
    const violated: string[] = [];
    preservationChecksKindP(preservations, moves, violated, kind, plan);
    const entities = uniq(violated);
    findings.check(
      kind,
      entities.length === 0 ? "pass" : "fail",
      entities,
      entities.length === 0
        ? `no transformation moves a ${kind} entity`
        : `${entities.length} transformation(s) move an entity the ${kind} preservation keeps in place`
    );
    if (entities.length > 0) {
      findings.block(
        kind === "anchor" ? "anchor-violation" : "preservation-violation",
        entities,
        `the exact plan moves what the ${kind} preservation says stays: ${entities.join(", ")}`
      );
    }
  }
}

function preservationChecksKindP(
  preservations: CompositionPreservation[],
  moves: PlannedTransformation[],
  violated: string[],
  kind: string,
  plan: OperatorExecutionPlan
) {
  for (const p of preservations) {
    for (const m of moves) {
      if (overlapping(movedEntities(m), p.entityIds)) {
        violated.push(`${p.preservationId}←${m.id}`);
      }
    }
    if (kind === "implementation-split") {
      for (const r of plan.relocations) {
        if (
          r.conceptId !== undefined &&
          p.entityIds.includes(r.conceptId) &&
          r.members.some((m) => m.role === "implementation")
        ) {
          violated.push(`${p.preservationId}←${r.actionId}`);
        }
      }
    }
  }
}

function isEntrypoint(a: Assessment, file: string): boolean {
  const pkg = packageOfFile(a.context.planning, file);
  if (pkg === undefined) {
    return false;
  }
  return (
    a.context.planning.packages
      .get(pkg)
      ?.entrypoints.some((e) => e.file === file) ?? false
  );
}

function surfaceChecks(a: Assessment): void {
  const { plan, findings } = a;
  const removals = plan.transformations.filter(
    (t) =>
      EXPOSURE_REMOVE_KINDS.has(t.kind) &&
      isEntrypoint(a, t.file) &&
      (t.before?.names?.length ?? 0) > (t.after?.names?.length ?? 0)
  );
  const compat = plan.transformations.filter((t) =>
    EXPOSURE_ADD_KINDS.has(t.kind)
  );
  const unresolved: string[] = [];
  const breaking: string[] = [];
  const visitR2 = () => {
    for (const r of removals) {
      const symbol = r.subject?.symbolId;
      // Only a compatibility export at the old route, or a new export in the
      // same barrel, keeps the old path alive; an export in the target's
      // barrel is the new path, not the old one.
      const preservedElsewhere = compat.some(
        (c) =>
          (c.kind === "preserve-compatibility-export" || c.file === r.file) &&
          (c.subject?.symbolId === symbol ||
            overlapping(c.after?.names ?? [], r.before?.names ?? []))
      );
      if (preservedElsewhere) {
        continue;
      }
      const operators = operatorsOf(a, r);
      const intended = operators.some(
        (op) =>
          op.kind === "internalize" ||
          !op.preservations.some(
            (p) =>
              (p.kind === "consumer-import-path" ||
                p.kind === "public-contract") &&
              (symbol === undefined || p.entityIds.includes(symbol))
          )
      );
      if (intended) {
        breaking.push(r.id);
      } else {
        unresolved.push(r.id);
      }
    }
  };
  visitR2();
  const visitR3 = () => {
    for (const r of plan.relocations) {
      if (r.strategy === "breaking-relocation") {
        unresolved.push(r.actionId);
      }
      if (r.strategy === "unresolved") {
        findings.block(
          "plan-incomplete",
          [r.actionId],
          `${r.actionId} has no surface strategy yet`
        );
      }
    }
  };
  visitR3();
  findings.check(
    "public-surface",
    resolveSurfaceChecks(removals, plan, unresolved),
    uniq([...unresolved, ...breaking]),
    resolveSurfaceChecks2(unresolved, breaking)
  );
  for (const id of unresolved) {
    findings.block(
      "public-surface-unresolved",
      [id],
      `${id} removes a package-public exposure that no operator intends to break and no compatibility export re-establishes`
    );
  }
  if (breaking.length > 0) {
    findings.risk(
      "breaking-public-surface",
      breaking,
      `${breaking.length} package-public exposure(s) disappear as the operator intends`,
      false
    );
  }

  const paths = a.context.composition.preservations.filter(
    (p) => p.kind === "consumer-import-path"
  );
  if (paths.length === 0) {
    findings.check(
      "consumer-compatibility",
      "not-applicable",
      [],
      "no consumer-import-path preservation"
    );
  } else {
    const missing = paths.filter(
      (p) =>
        plan.preserved.find((x) => x.preservationId === p.preservationId)
          ?.status === "unproven"
    );
    findings.check(
      "consumer-compatibility",
      missing.length === 0 ? "pass" : "fail",
      missing.map((p) => p.preservationId),
      missing.length === 0
        ? "every preserved import path is carried by a compatibility export or proven untouched"
        : `${missing.length} preserved import path(s) have neither a compatibility export nor a proof`
    );
    for (const p of missing) {
      findings.block(
        "public-surface-unresolved",
        [p.preservationId],
        `${p.preservationId} is preserved by the operator but the plan carries no compatibility export for it`
      );
    }
  }
}

function resolveSurfaceChecks2(
  unresolved: string[],
  breaking: string[]
): string {
  if (unresolved.length === 0) {
    if (breaking.length === 0) {
      return "every removed exposure is re-established by a compatibility export or the plan touches no entrypoint";
    }
    return `${breaking.length} exposure(s) leave the public surface by operator intent`;
  }
  return `${unresolved.length} exposure(s) disappear without operator intent or compatibility export`;
}

function resolveSurfaceChecks(
  removals: PlannedTransformation[],
  plan: OperatorExecutionPlan,
  unresolved: string[]
): ReadinessConstraintResult {
  if (removals.length === 0 && plan.relocations.length === 0) {
    return "not-applicable";
  }
  if (unresolved.length === 0) {
    return "pass";
  }
  return "fail";
}

function dependencyChecks(a: Assessment): void {
  const { plan, context, findings } = a;
  const { planning } = context;

  const mismatched = plan.transformations.filter(
    (t) =>
      IMPORT_KINDS.has(t.kind) &&
      t.before?.importKind !== undefined &&
      t.after?.importKind !== undefined &&
      t.before.importKind !== t.after.importKind
  );
  const escalations = plan.predicted.filter(
    (d) => d.change === "runtime-dependency-escalation"
  );
  const unbacked = escalations.filter(
    (d) =>
      !context.composition.effects.some(
        (e) =>
          e.dimension === "dependency" &&
          e.relation !== "conflicting" &&
          e.subjects.some((s) => d.subjects.includes(s))
      )
  );
  findings.check(
    "type-value-dependency",
    mismatched.length === 0 && unbacked.length === 0 ? "pass" : "fail",
    uniq([
      ...mismatched.map((t) => t.id),
      ...unbacked.flatMap((d) => d.subjects),
    ]),
    mismatched.length === 0 && unbacked.length === 0
      ? "every rewritten import keeps its type or value kind and every runtime escalation is an operator effect"
      : `${mismatched.length} import(s) change kind; ${unbacked.length} runtime escalation(s) have no operator effect behind them`
  );
  for (const t of mismatched) {
    findings.block(
      "transformation-conflict",
      [t.id],
      `${t.file}: the rewritten import changes from ${t.before?.importKind ?? "?"} to ${t.after?.importKind ?? "?"}`
    );
  }
  for (const d of unbacked) {
    findings.block(
      "dependency-unexpected",
      d.subjects,
      `the plan introduces a runtime dependency ${d.subjects.join(", ")} that no operator effect predicts`
    );
  }
  for (const d of escalations) {
    findings.risk(
      "runtime-dependency-change",
      d.subjects,
      `${d.subjects.join(", ")} becomes a runtime dependency`,
      unbacked.includes(d)
    );
  }

  const additions = plan.transformations.filter(
    (t) =>
      t.kind === "update-package-dependency" &&
      t.after?.dependency?.declared === true
  );
  const addedEdges = additions.flatMap((t) => {
    const from = [...planning.packages.values()].find(
      (p) => p.manifest === t.file
    )?.id;
    const to = t.after?.dependency?.package;
    return from === undefined || to === undefined ? [] : [{ from, to }];
  });
  const missing: string[] = [];
  const visitT = () => {
    for (const t of plan.transformations) {
      if (!IMPORT_KINDS.has(t.kind)) {
        continue;
      }
      const from = packageOfFile(planning, t.file);
      const to = t.after?.package;
      if (from === undefined || to === undefined || from === to) {
        continue;
      }
      const declared =
        planning.packages.get(from)?.dependencies.includes(to) ?? false;
      if (
        !(declared || addedEdges.some((e) => e.from === from && e.to === to))
      ) {
        missing.push(`${from}→${to}`);
      }
    }
  };
  visitT();
  const removals = plan.transformations.filter(
    (t) =>
      t.kind === "update-package-dependency" &&
      t.after?.dependency?.declared === false &&
      t.status === "required"
  );
  const stillImported: string[] = [];
  const edges = packageImportEdges(planning);
  const visitT2 = () => {
    for (const t of removals) {
      const from = [...planning.packages.values()].find(
        (p) => p.manifest === t.file
      )?.id;
      const to = t.after?.dependency?.package;
      if (from === undefined || to === undefined) {
        continue;
      }
      const sites =
        edges.find((e) => e.from === from && e.to === to)?.sites ?? 0;
      const rewritten = plan.transformations.filter(
        (x) =>
          IMPORT_KINDS.has(x.kind) &&
          packageOfFile(planning, x.file) === from &&
          x.before?.package === to &&
          x.after?.package !== to
      ).length;
      if (sites > rewritten) {
        stillImported.push(`${from}→${to}`);
      }
    }
  };
  visitT2();
  collectCycles(findings, missing, stillImported, edges, addedEdges, plan);

  const moduleCycles: string[] = [];
  const visitR = () => {
    for (const r of plan.relocations) {
      if (
        r.sourceModule === undefined ||
        r.targetModule === undefined ||
        r.closure === undefined ||
        a.created.includes(r.targetModule)
      ) {
        continue;
      }
      const needsSource = r.closure.externalDependencies.some(
        (d) =>
          d.class === "import-from-source-package" &&
          d.id.startsWith(`${r.sourceModule ?? ""}#`)
      );
      if (!needsSource) {
        continue;
      }
      const target = sourceFileOf(planning, r.targetModule);
      const source = sourceFileOf(planning, r.sourceModule);
      if (target === undefined || source === undefined) {
        continue;
      }
      const imports = target
        .getImportDeclarations()
        .some((d) => d.getModuleSpecifierSourceFile() === source);
      if (imports) {
        moduleCycles.push(`${r.sourceModule}↔${r.targetModule}`);
      }
    }
  };
  visitR();
  const deletedTargets = plan.transformations.filter(
    (t) =>
      IMPORT_KINDS.has(t.kind) &&
      t.after?.module !== undefined &&
      a.deleted.includes(t.after.module)
  );
  findings.check(
    "module-cycle",
    resolveDependencyChecks2(plan, deletedTargets, moduleCycles),
    uniq([...moduleCycles, ...deletedTargets.map((t) => t.id)]),
    moduleCycles.length === 0 && deletedTargets.length === 0
      ? "no relocation closes a module cycle and no import lands on a deleted module"
      : `${moduleCycles.length} module cycle(s); ${deletedTargets.length} import(s) land on a deleted module`
  );
  for (const cycle of uniq(moduleCycles)) {
    findings.block(
      "dependency-cycle",
      cycle.split("↔"),
      `the moved declarations still need ${cycle.split("↔")[0] ?? ""} while ${cycle.split("↔")[1] ?? ""} already imports it: a module cycle`
    );
  }
  for (const t of deletedTargets) {
    findings.block(
      "transformation-conflict",
      [t.id],
      `${t.file} would import ${t.after?.module ?? ""}, which the plan deletes`
    );
  }
  if (moduleCycles.length > 0) {
    findings.risk(
      "module-cycle-change",
      uniq(moduleCycles.flatMap((c) => c.split("↔"))),
      "the relocation would close a module cycle",
      true
    );
  }
}

function collectCycles(
  findings: Findings,
  missing: string[],
  stillImported: string[],
  edges: PackageImportEdge[],
  addedEdges: { from: string; to: string }[],
  plan: OperatorExecutionPlan
) {
  findings.check(
    "package-dependency",
    missing.length === 0 && stillImported.length === 0 ? "pass" : "fail",
    uniq([...missing, ...stillImported]),
    missing.length === 0 && stillImported.length === 0
      ? "every rewritten import lands on a declared or added dependency; no removed dependency is still imported"
      : `${missing.length} edge(s) undeclared; ${stillImported.length} removed dependency(ies) still imported`
  );
  for (const edge of uniq(missing)) {
    findings.block(
      "dependency-unexpected",
      [edge],
      `${edge} is imported after the plan but declared by no manifest and added by no transformation`
    );
  }
  for (const edge of uniq(stillImported)) {
    findings.block(
      "transformation-conflict",
      [edge],
      `${edge} is removed from the manifest while imports of it remain`
    );
  }

  const cycles = cyclesThrough(edges, addedEdges).filter(
    (c) => c.length > 1 || addedEdges.some((e) => e.from === e.to)
  );
  const planCycle = plan.blockers.filter(
    (b) => b.kind === "dependency-cycle-risk"
  );
  findings.check(
    "package-cycle",
    resolveDependencyChecks(addedEdges, planCycle, cycles),
    uniq([...cycles.flat(), ...planCycle.flatMap((b) => b.entities)]),
    cycles.length === 0 && planCycle.length === 0
      ? "the added package edges close no cycle"
      : `${cycles.length + planCycle.length} package cycle(s) through the added edges`
  );
  for (const cycle of cycles) {
    findings.block(
      "dependency-cycle",
      cycle,
      `package cycle ${cycle.join(" → ")} through an added dependency`
    );
  }
  for (const b of planCycle) {
    findings.block("dependency-cycle", b.entities, b.detail);
  }
  if (cycles.length > 0 || planCycle.length > 0) {
    findings.risk(
      "package-cycle-change",
      uniq([...cycles.flat(), ...planCycle.flatMap((b) => b.entities)]),
      "the plan would close a package cycle",
      true
    );
  }
}

function resolveDependencyChecks2(
  plan: OperatorExecutionPlan,
  deletedTargets: PlannedTransformation[],
  moduleCycles: string[]
): ReadinessConstraintResult {
  if (plan.relocations.length === 0 && deletedTargets.length === 0) {
    return "not-applicable";
  }
  if (moduleCycles.length === 0 && deletedTargets.length === 0) {
    return "pass";
  }
  return "fail";
}

function resolveDependencyChecks(
  addedEdges: { from: string; to: string }[],
  planCycle: OperatorPlanBlocker[],
  cycles: string[][]
): ReadinessConstraintResult {
  if (addedEdges.length === 0 && planCycle.length === 0) {
    return "not-applicable";
  }
  if (cycles.length === 0 && planCycle.length === 0) {
    return "pass";
  }
  return "fail";
}

function sideEffectChecks(a: Assessment): string[] {
  const { plan, context, findings } = a;
  const modules = uniq(
    plan.transformations
      .filter((t) => MOVE_KINDS.has(t.kind))
      .map((t) => t.file)
  );
  const affected = modules.filter((file) => {
    const source = sourceFileOf(context.planning, file);
    return source !== undefined && hasSideEffects(source);
  });
  findings.check(
    "side-effects",
    resolveSideEffectChecks(modules, affected),
    affected,
    affected.length === 0
      ? "no moved declaration leaves a module with top-level execution"
      : `${affected.length} moved-from module(s) execute at load time; relocation may change initialization order`
  );
  for (const file of affected) {
    findings.block(
      "side-effect-module",
      [file],
      `${file} runs code at module load; moving declarations out of it is not modeled`
    );
    findings.risk(
      "side-effect-module",
      [file],
      `${file} executes at load time`,
      true
    );
  }
  return affected;
}

function resolveSideEffectChecks(
  modules: string[],
  affected: string[]
): ReadinessConstraintResult {
  if (modules.length === 0) {
    return "not-applicable";
  }
  if (affected.length === 0) {
    return "pass";
  }
  return "fail";
}

function subjectPackages(op: ArchitecturalOperator): string[] {
  const { subject } = op;
  switch (subject.kind) {
    case "symbol":
      return [subject.package];
    case "package":
      return [subject.packageId];
    case "boundary":
      return [subject.from, subject.to];
    case "behavior":
      return [...subject.packages];
    case "concept":
      return op.placement.current?.package === undefined
        ? []
        : [op.placement.current.package];
    default:
      throw new Error("Unexpected subject.kind.");
  }
}

function requiredPackages(
  a: Assessment,
  op: ArchitecturalOperator,
  scope: MutationCoverageScope
): string[] {
  const { plan, context } = a;
  const subject = subjectPackages(op);
  const targets = uniq([
    ...(op.placement.target?.package === undefined
      ? []
      : [op.placement.target.package]),
    ...plan.relocations.flatMap((r) => [r.sourcePackage, r.targetPackage]),
  ]);
  const consumers = uniq(
    plan.transformations
      .filter((t) => IMPORT_KINDS.has(t.kind))
      .flatMap((t) => {
        const pkg = packageOfFile(context.planning, t.file);
        return pkg === undefined ? [] : [pkg];
      })
  );
  const participating = uniq([
    ...plan.targets.flatMap((t) =>
      t.package === undefined ? [] : [t.package]
    ),
    ...plan.transformations.flatMap((t) => [
      ...(t.before?.package === undefined ? [] : [t.before.package]),
      ...(t.after?.package === undefined ? [] : [t.after.package]),
    ]),
  ]);
  const base = subject;
  switch (scope) {
    case "subject-only":
      return uniq(base);
    case "source-target":
      return uniq([...base, ...targets]);
    case "source-target-consumers":
      return uniq([...base, ...targets, ...consumers]);
    case "all-participating":
      return uniq([...base, ...targets, ...consumers, ...participating]);
    case "workspace":
      return uniq(
        context.facts.projection.workspace.packages.packages.map((p) => p.id)
      );
    default:
      throw new Error("Unexpected scope.");
  }
}

function coverageChecks(a: Assessment): void {
  const { context, findings } = a;
  const known = context.facts.projection.workspace.packages.packages;
  const { coverage } = context.facts.projection.workspace.ingestion;
  const unanalyzed: string[] = [];
  for (const op of a.operators.values()) {
    const scope =
      MUTATION_COVERAGE_REQUIREMENTS.find((r) => r.kind === op.kind)
        ?.requiredPackages ?? "workspace";
    for (const pkg of requiredPackages(a, op, scope)) {
      if (known.find((p) => p.id === pkg)?.analyzed !== true) {
        unanalyzed.push(pkg);
      }
    }
  }
  const missing = uniq(unanalyzed);
  findings.check(
    "coverage",
    missing.length === 0 ? "pass" : "fail",
    missing,
    resolveCoverageChecks(missing, coverage)
  );
  for (const pkg of missing) {
    findings.block(
      "coverage-insufficient",
      [pkg],
      `${pkg} participates in the mutation and has no analysis`
    );
  }
  if (!coverage.complete) {
    findings.caution(
      "coverage-partial",
      coverage.missingPackages,
      `workspace coverage is partial (${coverage.packagesAnalyzed} of ${coverage.packagesKnown} packages analyzed)`
    );
    findings.risk(
      "partial-workspace-coverage",
      coverage.missingPackages,
      `${coverage.packagesKnown - coverage.packagesAnalyzed} known package(s) unanalyzed`,
      missing.length > 0
    );
  }
}

const CONFORMANCE_BLOCKING_KINDS = new Set<ArchitecturalOperatorKind>([
  "rehome-concept",
  "rehome-behavior",
  "move",
]);

function resolveCoverageChecks(
  missing: string[],
  coverage: WorkspaceCoverage
): string {
  if (missing.length === 0) {
    if (coverage.complete) {
      return "every workspace package is analyzed";
    }
    return "every package the operators require is analyzed; workspace coverage is partial elsewhere";
  }
  return `${missing.join(", ")} must be analyzed for this operator kind and are not`;
}

function conformanceChecks(a: Assessment): void {
  const { findings } = a;
  const blocking: string[] = [];
  const observed: string[] = [];
  const visitOp = () => {
    for (const op of a.operators.values()) {
      for (const c of op.constraints) {
        if (c.kind !== "structural-conformance-unknown") {
          continue;
        }
        if (
          c.effect === "blocking" ||
          CONFORMANCE_BLOCKING_KINDS.has(op.kind)
        ) {
          blocking.push(...c.entityIds);
        } else {
          observed.push(...c.entityIds);
        }
      }
    }
  };
  visitOp();
  for (const b of a.plan.blockers) {
    if (b.kind === "structural-conformance-unknown") {
      blocking.push(...b.entities);
    }
  }
  const entities = uniq([...blocking, ...observed]);
  findings.check(
    "structural-conformance",
    resolveConformanceChecks(entities, blocking),
    entities,
    resolveConformanceChecks2(entities, blocking)
  );
  for (const entity of uniq(blocking)) {
    findings.block(
      "structural-conformance-unknown",
      [entity],
      `${entity} has no observed implementation; object-literal conformance may be unseen and the relocation would miss it`
    );
  }
  for (const entity of uniq(observed)) {
    findings.caution(
      "structural-conformance-unobserved",
      [entity],
      `${entity} has no observed implementation; internalization does not depend on it`
    );
  }
  if (entities.length > 0) {
    findings.risk(
      "structural-conformance-gap",
      entities,
      "interface conformance is unobserved for a participating concept",
      blocking.length > 0
    );
  }
}

function resolveConformanceChecks2(
  entities: string[],
  blocking: string[]
): string {
  if (entities.length === 0) {
    return "no operator depends on unobserved interface conformance";
  }
  if (blocking.length === 0) {
    return "conformance is unobserved but the operator kind does not depend on it";
  }
  return `${uniq(blocking).join(", ")} may have unseen structural implementations the relocation would miss`;
}

function resolveConformanceChecks(
  entities: string[],
  blocking: string[]
): ReadinessConstraintResult {
  if (entities.length === 0) {
    return "not-applicable";
  }
  if (blocking.length === 0) {
    return "pass";
  }
  return "fail";
}

function carryPlanBlockers(a: Assessment): void {
  const { plan, findings } = a;
  for (const b of plan.blockers) {
    switch (b.kind) {
      case "source-state-mismatch":
        findings.block("source-stale", b.entities, b.detail);
        break;
      case "anchor-violation":
        findings.block("anchor-violation", b.entities, b.detail);
        break;
      case "dependency-cycle-risk":
      case "structural-conformance-unknown":
        break;
      case "coverage-incomplete":
        findings.block("coverage-insufficient", b.entities, b.detail);
        break;
      case "unsupported-export-form":
      case "unsupported-import-form":
        findings.block("unsupported-syntax", b.entities, b.detail);
        break;
      case "unsupported-realization":
        findings.block("unsupported-transformation", b.entities, b.detail);
        break;
      case "ambiguous-symbol":
      case "target-module-unresolved":
      case "module-mixed-responsibility":
      case "package-export-strategy-unresolved":
        findings.block("plan-incomplete", b.entities, `${b.kind}: ${b.detail}`);
        break;
      case "target-module-collision":
      case "composition-conflict":
        findings.block(
          "transformation-conflict",
          b.entities,
          `${b.kind}: ${b.detail}`
        );
        break;
      default:
        throw new Error("Unexpected b.kind.");
    }
  }
  if (plan.status === "stale" && !findings.has("source-stale")) {
    findings.block(
      "source-stale",
      [plan.id],
      "the plan was already stale when it was made"
    );
  }
}

function constraints(a: Assessment): ReadinessConstraintStatus {
  preservationChecks(a);
  surfaceChecks(a);
  dependencyChecks(a);
  coverageChecks(a);
  conformanceChecks(a);
  const checks = [...a.findings.checks].sort((x, y) => byId(x.kind, y.kind));
  return {
    checks,
    compatible: checks.every((c) => c.status !== "fail"),
  };
}

// ---------------------------------------------------------------------------
// Realizability

function realizability(
  a: Assessment,
  sideEffectModules: string[]
): ReadinessRealizability {
  const { plan, registry, findings } = a;
  const matrix = new Map<string, ReadinessMutationCapability>();
  const unsupported: ReadinessRealizability["unsupportedSyntaxForms"] = [];
  const supportedForms = new Set<string>();
  let supported = 0;
  supported = realizabilityT(
    plan,
    registry,
    matrix,
    unsupported,
    findings,
    supported,
    supportedForms
  );
  const closures = plan.relocations.map((r) => ({
    actionId: r.actionId,
    complete: r.closure?.complete ?? r.granularity !== "unresolved",
    sharedInternalSymbols: r.closure?.sharedInternalSymbols ?? [],
  }));
  for (const c of closures) {
    if (!c.complete) {
      findings.block(
        "plan-incomplete",
        [c.actionId, ...c.sharedInternalSymbols],
        `${c.actionId}: the movement closure is incomplete (${c.sharedInternalSymbols.join(", ") || "unresolved target"})`
      );
    }
  }
  return {
    closures: closures.sort((x, y) => byId(x.actionId, y.actionId)),
    mutationCapabilities: [...matrix.values()].sort(
      (x, y) =>
        byId(x.transformationKind, y.transformationKind) || byId(x.form, y.form)
    ),
    realizable:
      unsupported.length === 0 &&
      closures.every((c) => c.complete) &&
      sideEffectModules.length === 0,
    sideEffectModules,
    supportedSyntaxForms: uniq([...supportedForms]),
    supportedTransformations: supported,
    unsupportedSyntaxForms: unsupported.sort((x, y) =>
      byId(x.transformationId, y.transformationId)
    ),
    unsupportedTransformations: unsupported.length,
  };
}

function realizabilityT(
  plan: OperatorExecutionPlan,
  registry: MutationCapabilityRegistry,
  matrix: Map<string, ReadinessMutationCapability>,
  unsupported: ReadinessUnsupportedForm[],
  findings: Findings,
  initialSupported: number,
  supportedForms: Set<string>
) {
  let supported = initialSupported;
  for (const t of plan.transformations) {
    const form = t.form ?? "(none)";
    const lookup = lookupCapability(registry, t.kind, t.form);
    const key = `${t.kind}:${form}`;
    const row = matrix.get(key) ?? {
      atomic: lookup.atomic,
      form,
      occurrences: 0,
      reversible: lookup.reversible,
      supported: lookup.supported,
      transformationKind: t.kind,
    };
    row.occurrences += 1;
    matrix.set(key, row);
    if (t.status === "unsupported") {
      unsupported.push({
        kind: t.kind,
        transformationId: t.id,
        ...(t.form !== undefined && { form: t.form }),
        reason: "the planner could not plan this transformation exactly",
      });
      findings.block(
        "unsupported-transformation",
        [t.id],
        `${t.id} (${t.kind}) is unsupported in the plan itself`
      );
      continue;
    }
    if (!lookup.supported) {
      unsupported.push({
        kind: t.kind,
        transformationId: t.id,
        ...(t.form !== undefined && { form: t.form }),
        reason: lookup.reason ?? "unsupported",
      });
      findings.block(
        registry.capabilities.some((c) => c.transformationKind === t.kind)
          ? "unsupported-syntax"
          : "unsupported-transformation",
        [t.id],
        `${t.kind} in ${t.file}: ${lookup.reason ?? "no mutator"}`
      );
      continue;
    }
    if (!lookup.reversible) {
      findings.block(
        "rollback-incomplete",
        [t.id],
        `${t.kind} is executable but not reversible by byte restore`
      );
    }
    supported += 1;
    supportedForms.add(form);
  }
  return supported;
}

// ---------------------------------------------------------------------------
// Preservation

function preservation(a: Assessment): ReadinessPreservationStatus {
  const { plan, context, findings } = a;
  const violated = new Set(
    findings.blockers
      .filter(
        (b) =>
          b.kind === "anchor-violation" || b.kind === "preservation-violation"
      )
      .flatMap((b) => b.entities.map((e) => e.split("←")[0] ?? e))
  );
  const states: ReadinessPreservationState[] =
    context.composition.preservations.map((p) => {
      const planned = plan.preserved.find(
        (x) => x.preservationId === p.preservationId
      );
      const status: ReadinessPreservationState["status"] = violated.has(
        p.preservationId
      )
        ? "violated"
        : (planned?.status ?? "unproven");
      if (status === "unproven") {
        findings.block(
          "verification-incomplete",
          [p.preservationId],
          `${p.preservationId} is neither carried by a transformation nor proven by a verification step`
        );
      }
      return {
        detail: resolveDetail(status),
        kind: p.kind,
        preservationId: p.preservationId,
        status,
        transformations: planned?.transformations ?? [],
        verification: planned?.verification ?? [],
      };
    });
  const runtime = states.filter((s) => s.kind === "runtime-behavior");
  if (
    runtime.length > 0 &&
    !plan.verification.some((v) => v.kind === "tests")
  ) {
    findings.risk(
      "test-coverage-limited",
      runtime.map((s) => s.preservationId),
      "runtime behavior is preserved by intent but no test step verifies it",
      false
    );
  }
  return {
    covered: states.every(
      (s) => s.status === "transformed" || s.status === "proven"
    ),
    preservations: states.sort((x, y) =>
      byId(x.preservationId, y.preservationId)
    ),
  };
}

// ---------------------------------------------------------------------------
// Verification

interface ManifestScripts {
  scripts?: Record<string, string>;
}

function resolveDetail(
  status: ReadinessPreservationResult
):
  | "a planned transformation moves what this preservation keeps"
  | "carried out by a transformation"
  | "proven by a verification step"
  | "no transformation and no proof" {
  if (status === "violated") {
    return "a planned transformation moves what this preservation keeps";
  }
  if (status === "transformed") {
    return "carried out by a transformation";
  }
  if (status === "proven") {
    return "proven by a verification step";
  }
  return "no transformation and no proof";
}

function hasScript(
  a: Assessment,
  pkg: string,
  script: string
): { cwd: string } | undefined {
  const entry = a.context.planning.packages.get(pkg);
  if (entry === undefined) {
    return undefined;
  }
  const manifest = JSON.parse(
    readFileSync(join(entry.dir, "package.json"), "utf8")
  ) as ManifestScripts;
  return manifest.scripts?.[script] === undefined
    ? undefined
    : { cwd: entry.relPath };
}

function resolveSteps(a: Assessment): ReadinessVerificationStep[] {
  const steps: ReadinessVerificationStep[] = [];
  for (const step of a.plan.verification) {
    const base = {
      dependsOn: step.dependsOn,
      expected: step.expected,
      kind: step.kind,
      scope: step.scope,
    };
    switch (step.kind) {
      case "tests": {
        for (const pkg of step.scope) {
          const script = hasScript(a, pkg, "test");
          steps.push({
            id: `${step.id}:${pkg}`,
            ...base,
            scope: [pkg],
            ...(script === undefined
              ? {
                  detail: `${pkg} has no test script`,
                  mode: "unresolvable" as const,
                }
              : {
                  command: {
                    args: ["run", "test"],
                    cwd: script.cwd,
                    executable: "bun",
                    expectedExitCode: 0,
                  },
                  mode: "command" as const,
                }),
          });
        }
        break;
      }
      case "typecheck": {
        // The package's own script carries its own compiler options; project
        // diagnostics inherit the planning project's and are the fallback.
        for (const pkg of step.scope) {
          const script = hasScript(a, pkg, "typecheck");
          steps.push({
            id: `${step.id}:${pkg}`,
            ...base,
            scope: [pkg],
            ...(script === undefined
              ? { mode: "analyzer" as const, query: `diagnostics:${pkg}` }
              : {
                  command: {
                    args: ["run", "typecheck"],
                    cwd: script.cwd,
                    executable: "bun",
                    expectedExitCode: 0,
                  },
                  mode: "command" as const,
                }),
          });
        }
        break;
      }
      case "analyze-package":
      case "analyze-workspace":
      case "verify-symbol-location":
      case "verify-public-surface":
      case "verify-imports":
      case "verify-dependency":
      case "verify-anchor":
        steps.push({
          id: step.id,
          ...base,
          mode: "analyzer",
          query: `${step.kind}:${step.scope.join(",")}`,
        });
        break;
      default:
        throw new Error("Unexpected step.kind.");
    }
  }
  const ids = new Set(steps.map((s) => s.id));
  for (const s of steps) {
    s.dependsOn = uniq(
      s.dependsOn.flatMap((d) =>
        ids.has(d) ? [d] : [...ids].filter((id) => id.startsWith(`${d}:`))
      )
    );
  }
  return steps;
}

function diagnosticKeys(a: Assessment, packages: string[]): string[] {
  const { planning } = a.context;
  const prefixes = packages.flatMap((pkg) => {
    const entry = planning.packages.get(pkg);
    return entry === undefined ? [] : [`${entry.relPath}/`];
  });
  const keys: string[] = [];
  for (const [file] of planning.moduleIndex) {
    if (!prefixes.some((p) => file.startsWith(p))) {
      continue;
    }
    const source = sourceFileOf(planning, file);
    if (source === undefined) {
      continue;
    }
    for (const d of source.getPreEmitDiagnostics()) {
      if (d.getCategory() === ts.DiagnosticCategory.Error) {
        keys.push(`${file}|TS${d.getCode()}`);
      }
    }
  }
  return uniq(keys);
}

const FAILURE_LINE = /(^|\s)(FAIL|×|✗)\s/;
const TSC_LINE = /^(.+?)\(\d+,\d+\): error (TS\d+)/;

/** Failure identities in a command's output: `<file>|TS####` for tsc, the failing test line for vitest. */
function extractFailures(
  output: string,
  kind: PlannedVerificationKind,
  cwd: string
): string[] {
  const lines = output.split("\n");
  if (kind === "typecheck") {
    return uniq(
      lines.flatMap((line) => {
        const match = TSC_LINE.exec(line.trim());
        return match === null
          ? []
          : [`${posix.join(cwd, match[1] ?? "")}|${match[2] ?? ""}`];
      })
    );
  }
  return uniq(
    lines
      .filter((line) => FAILURE_LINE.test(line))
      .map((line) => line.trim().replace(extractFailuresPattern, " "))
  );
}

function spawnRunner(
  command: ReadinessCommand,
  root: string
): { exitCode: number; output: string } {
  try {
    const output = execFileSync(command.executable, command.args, {
      cwd: resolve(root, command.cwd),
      env: { ...process.env, CI: "1" },
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 600_000,
    }).toString();
    return { exitCode: 0, output };
  } catch (error) {
    const failed = error as {
      status?: number | null;
      stdout?: Buffer | string;
      stderr?: Buffer | string;
    };
    return {
      exitCode: failed.status ?? 1,
      output: `${failed.stdout?.toString() ?? ""}\n${failed.stderr?.toString() ?? ""}`,
    };
  }
}

function allowanceFor(
  allowances: VerificationBaselineAllowance[],
  step: ReadinessVerificationStep,
  failures: string[]
): VerificationBaselineAllowance | undefined {
  return allowances.find(
    (x) =>
      x.allowed &&
      (x.check === step.id || x.check === step.kind) &&
      failures.every((f) => x.knownFailures.includes(f))
  );
}

function baseline(
  a: Assessment,
  steps: ReadinessVerificationStep[]
): ReadinessBaselineCheck[] {
  const { findings } = a;
  const allowances = a.context.allowances ?? [];
  const runner = a.context.runner ?? spawnRunner;
  const checks: ReadinessBaselineCheck[] = [];
  baselineStep(steps, checks, a, runner, allowances, findings);
  return checks;
}

function baselineStep(
  steps: ReadinessVerificationStep[],
  checks: ReadinessBaselineCheck[],
  a: Assessment,
  runner: ReadinessCommandRunner,
  allowances: VerificationBaselineAllowance[],
  findings: Findings
) {
  for (const step of steps) {
    if (step.kind !== "typecheck" && step.kind !== "tests") {
      continue;
    }
    if (step.mode === "unresolvable") {
      checks.push({
        detail: step.detail ?? "the step cannot run here",
        id: step.id,
        kind: step.kind,
        status: "skipped",
      });
      continue;
    }
    let result: ReadinessCommandResult;
    if (step.mode === "analyzer") {
      const failures = diagnosticKeys(a, step.scope);
      result = { exitCode: failures.length === 0 ? 0 : 1, failures };
    } else if (step.command === undefined) {
      continue;
    } else {
      const ran = runner(step.command, a.context.planning.root);
      const extracted = extractFailures(
        ran.output,
        step.kind,
        step.command.cwd
      );

      const failures: string[] = baselineStepEntries(ran, extracted);
      result = { exitCode: ran.exitCode, failures };
    }
    if (result.exitCode === 0) {
      checks.push({
        detail: `${step.kind} is green over ${step.scope.join(", ")}`,
        id: step.id,
        kind: step.kind,
        result,
        status: "pass",
      });
      continue;
    }
    const allowance = allowanceFor(allowances, step, result.failures);
    if (allowance !== undefined) {
      checks.push({
        allowance: allowance.provenance,
        detail: `${result.failures.length} known failure(s) allowed by ${allowance.provenance}`,
        id: step.id,
        kind: step.kind,
        result,
        status: "allowed-failure",
      });
      findings.caution(
        "allowed-baseline-failure",
        result.failures,
        `${step.id}: ${result.failures.length} pre-existing failure(s) allowed by ${allowance.provenance}`
      );
      continue;
    }
    checks.push({
      detail: `${step.kind} fails before mutation: ${result.failures.slice(0, 5).join("; ")}${result.failures.length > 5 ? "; …" : ""}`,
      id: step.id,
      kind: step.kind,
      result,
      status: "fail",
    });
    findings.block(
      "baseline-verification-failed",
      [step.id, ...result.failures.slice(0, 5)],
      `${step.kind} over ${step.scope.join(", ")} already fails (${result.failures.length} failure(s) without allowance); post-mutation failures could not be attributed`
    );
  }
}

function baselineStepEntries(
  ran: { exitCode: number; output: string },
  extracted: string[]
): string[] {
  let failures: string[];
  if (ran.exitCode === 0) {
    failures = [];
  } else if (extracted.length > 0) {
    failures = extracted;
  } else {
    failures = [`exit ${ran.exitCode}`];
  }
  return failures;
}

function assertions(a: Assessment): ReadinessArchitecturalAssertion[] {
  const { plan, context } = a;
  return plan.predicted
    .map((d) => {
      const effect = context.composition.effects.find(
        (e) =>
          e.dimension === d.dimension &&
          e.change === d.change &&
          e.subjects.some((s) => d.subjects.includes(s))
      );
      const before: OperatorFact = effect?.changes[0]?.from ?? null;
      return {
        before,
        dimension: d.dimension,
        expectedAfter: d.predicted,
        source: {
          operatorEffectIds: uniq(
            (effect?.sourceOperators ?? []).map(
              (o) => `${o}/${d.dimension}:${d.change}`
            )
          ),
          planTransformationIds: uniq(d.sourceTransformations),
        },
        verificationQuery: `${d.dimension}:${d.change}:${d.subjects.join(",")}`,
      };
    })
    .sort((x, y) => byId(x.verificationQuery, y.verificationQuery));
}

/** Structure always; baseline commands only when asked, since they are the expensive part. */
function verification(
  a: Assessment,
  runBaseline: boolean
): ReadinessVerificationStatus {
  const { findings } = a;
  const steps = resolveSteps(a);
  for (const s of steps) {
    if (s.mode === "unresolvable") {
      findings.block(
        "verification-incomplete",
        [s.id],
        `${s.kind} is required and cannot run: ${s.detail ?? "unresolvable"}`
      );
    }
  }
  const stepIds = new Set(steps.map((s) => s.id));
  const cyclic = steps.filter((s) =>
    s.dependsOn.some((d) => !stepIds.has(d) || d === s.id)
  );
  const verifyCycle = transformationCycles(
    [...stepIds],
    steps.flatMap((s) =>
      s.dependsOn.map((d) => ({
        after: s.id,
        before: d,
        kind: "requires" as const,
        reason: "",
      }))
    )
  );
  for (const s of cyclic) {
    findings.block(
      "verification-incomplete",
      [s.id],
      `${s.id} depends on a step that does not exist`
    );
  }
  if (verifyCycle.length > 0) {
    findings.block(
      "verification-incomplete",
      verifyCycle,
      `the verification sequence is cyclic through ${verifyCycle.join(", ")}`
    );
  }
  const baselineChecks = runBaseline ? baseline(a, steps) : [];
  const executable =
    steps.every((s) => s.mode !== "unresolvable") &&
    cyclic.length === 0 &&
    verifyCycle.length === 0;
  return {
    allowances: [...(a.context.allowances ?? [])].sort(
      (x, y) => byId(x.check, y.check) || byId(x.provenance, y.provenance)
    ),
    assertions: assertions(a),
    baselineChecks,
    complete:
      executable &&
      runBaseline &&
      baselineChecks.every(
        (c) => c.status === "pass" || c.status === "allowed-failure"
      ) &&
      !findings.has("verification-incomplete"),
    executable,
    steps,
  };
}

// ---------------------------------------------------------------------------
// Rollback

function readable(absolute: string): boolean {
  try {
    accessSync(absolute, constants.R_OK);
    return statSync(absolute).isFile();
  } catch {
    return false;
  }
}

function writableAncestor(absolute: string): boolean {
  let dir = dirname(absolute);
  for (;;) {
    if (existsSync(dir)) {
      try {
        accessSync(dir, constants.W_OK);
        return true;
      } catch {
        return false;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return false;
    }
    dir = parent;
  }
}

function rollback(a: Assessment): ReadinessRollbackContract {
  const { plan, context, findings } = a;
  const { root } = context.planning;
  const files: RollbackFile[] = [];
  const seen = new Set<string>();
  const add = (file: string, action: RollbackFile["action"]) => {
    if (seen.has(file)) {
      return;
    }
    seen.add(file);
    const absolute = resolve(root, file);
    const hash = hashFile(context.planning, file);
    if (action === "delete") {
      const absent = hash === "missing";
      const ok = absent && writableAncestor(absolute);
      files.push({
        action,
        file,
        hash: "absent",
        restorable: ok,
        ...resolveAdd(ok, absent),
      });
      return;
    }
    const ok =
      hash !== "missing" && readable(absolute) && writableAncestor(absolute);
    files.push({
      action,
      file,
      hash,
      restorable: ok,
      ...resolveAdd2(ok, hash),
    });
  };
  for (const file of a.deleted) {
    add(file, "recreate");
  }
  for (const file of a.created) {
    add(file, "delete");
  }
  for (const target of plan.targets) {
    add(target.file, "restore");
  }
  for (const t of plan.transformations) {
    if (t.kind === "verify-only") {
      continue;
    }
    add(t.file, "restore");
    if (MOVE_KINDS.has(t.kind) && t.after?.module !== undefined) {
      add(t.after.module, "restore");
    }
  }
  files.sort((x, y) => byId(x.file, y.file));
  for (const f of files) {
    if (!f.restorable) {
      findings.block(
        "rollback-incomplete",
        [f.file],
        `${f.file}: ${f.detail ?? "not restorable"}`
      );
    }
  }
  const complete = files.every((f) => f.restorable);
  return {
    complete,
    createdFiles: a.created,
    deletedFiles: a.deleted,
    files: files.filter((f) => !isManifest(f.file)),
    manifests: files.filter((f) => isManifest(f.file)),
    strategy: complete ? "byte-snapshot" : "unsupported",
  };
}

function resolveAdd2(ok: boolean, hash: string): { detail?: string } {
  if (ok) {
    return {};
  }
  return {
    detail:
      hash === "missing"
        ? "the file does not exist, so its bytes cannot be snapshotted"
        : "the file or its directory is not accessible for restore",
  };
}

function resolveAdd(ok: boolean, absent: boolean): { detail?: string } {
  if (ok) {
    return {};
  }
  return {
    detail: absent
      ? "no writable ancestor directory"
      : "the file already exists, so deleting it would not restore the prior state",
  };
}

// ---------------------------------------------------------------------------
// Intent coverage, risks, authorization

function intents(a: Assessment): ReadinessIntentCoverage[] {
  const { plan, context } = a;
  return [...a.operators.values()]
    .map((op) => {
      const actions = context.composition.actions.filter((x) =>
        x.sourceOperators.includes(op.id)
      );
      const preservationIds = op.preservations.map(
        (p) => `${p.kind}:${p.entityIds.join(",")}`
      );
      return {
        effectsCovered: op.expectedEffects.every((e) =>
          plan.predicted.some(
            (d) => d.dimension === e.dimension && d.change === e.change
          )
        ),
        operatorId: op.id,
        preconditionsCovered: actions.every((x) =>
          x.preconditions.every((p) =>
            op.preconditions.some((q) => q.kind === p.kind)
          )
        ),
        preservationsCovered: preservationIds.every(
          (id) =>
            plan.preserved.find((p) => p.preservationId === id)?.status !==
              "unproven" && plan.preserved.some((p) => p.preservationId === id)
        ),
        verificationCovered: op.verification.every((v) =>
          REQUIREMENT_STEPS[v.kind].some((k) =>
            plan.verification.some((s) => s.kind === k)
          )
        ),
      };
    })
    .sort((x, y) => byId(x.operatorId, y.operatorId));
}

function consumerRisk(a: Assessment): void {
  const { plan, context, findings } = a;
  const packages = uniq(
    plan.transformations
      .filter((t) => IMPORT_KINDS.has(t.kind))
      .flatMap((t) => {
        const pkg = packageOfFile(context.planning, t.file);
        return pkg === undefined ? [] : [pkg];
      })
  );
  if (packages.length >= 3) {
    findings.risk(
      "broad-consumer-impact",
      packages,
      `imports are rewritten in ${packages.length} packages`,
      false
    );
    findings.caution(
      "broad-consumer-impact",
      packages,
      `${packages.length} consumer packages change`
    );
  }
}

const BLOCKED_KINDS = new Set<ReadinessBlockerKind>([
  "transformation-conflict",
  "anchor-violation",
  "preservation-violation",
  "public-surface-unresolved",
  "dependency-cycle",
  "dependency-unexpected",
  "side-effect-module",
  "coverage-insufficient",
  "structural-conformance-unknown",
  "baseline-verification-failed",
  "rollback-incomplete",
]);

function authorization(findings: Findings): MutationAuthorization {
  if (findings.has("source-stale")) {
    return "stale";
  }
  if (
    findings.has("unsupported-transformation") ||
    findings.has("unsupported-syntax")
  ) {
    return "unsupported";
  }
  if (findings.blockers.some((b) => BLOCKED_KINDS.has(b.kind))) {
    return "blocked";
  }
  if (findings.blockers.length > 0) {
    return "not-authorized";
  }
  return "authorized";
}

function fingerprint(
  plan: OperatorExecutionPlan,
  registry: MutationCapabilityRegistry,
  source: ReadinessSourceState,
  verify: ReadinessVerificationStatus,
  back: ReadinessRollbackContract
): MutationAuthorizationFingerprint {
  const sourceFingerprint = hash16(
    [...source.expectedFiles, ...source.expectedManifests].map(
      (f) => `${f.file}=${f.actual}`
    )
  );
  const verificationFingerprint = hash16([
    verify.steps.map((s) => ({
      command: s.command ?? null,
      id: s.id,
      mode: s.mode,
      query: s.query ?? null,
    })),
    verify.baselineChecks.map((c) => `${c.id}=${c.status}`),
    verify.allowances,
  ]);
  const rollbackFingerprint = hash16(
    [...back.files, ...back.manifests].map(
      (f) => `${f.file}:${f.action}=${f.hash}`
    )
  );
  const parts = {
    capabilityFingerprint: capabilityFingerprint(registry),
    planFingerprint: plan.fingerprint.hash,
    rollbackFingerprint,
    sourceFingerprint,
    verificationFingerprint,
  };
  return {
    ...parts,
    hash: `auth:${hash16([
      parts.planFingerprint,
      parts.sourceFingerprint,
      parts.capabilityFingerprint,
      parts.verificationFingerprint,
      parts.rollbackFingerprint,
      OPERATOR_READINESS_SCHEMA_VERSION,
      OPERATOR_READINESS_POLICY_VERSION,
    ])}`,
  };
}

/**
 * Judge one execution plan against the repository as it is now. Source
 * fingerprints are checked first and short-circuit every source-reading
 * check; baseline commands run only when the structure holds up. Nothing
 * here writes, repairs, or chooses.
 */
export function assessOperatorPlanReadiness(
  plan: OperatorExecutionPlan,
  context: OperatorReadinessContext
): OperatorPlanReadiness {
  const registry = context.capabilities ?? DEFAULT_MUTATION_CAPABILITIES;
  const findings = new Findings();
  const a: Assessment = {
    context,
    created: createdFiles(plan),
    deleted: deletedFiles(plan),
    findings,
    operators: new Map(context.operators.map((o) => [o.id, o])),
    plan,
    registry,
  };

  const t0 = performance.now();
  const source = sourceState(a);
  for (const file of source.staleFiles) {
    findings.block("source-stale", [file], `${file} changed since planning`);
  }
  for (const file of source.missingFiles) {
    findings.block("source-stale", [file], `${file} no longer exists`);
  }
  for (const file of source.unexpectedFiles) {
    findings.block(
      "source-stale",
      [file],
      `${file} exists now; the plan creates it from nothing`
    );
  }
  if (source.git.plannedDirty.length > 0) {
    findings.caution(
      "planned-file-dirty",
      source.git.plannedDirty,
      `${source.git.plannedDirty.length} planned file(s) have uncommitted changes whose bytes still match the plan`
    );
  }
  if (source.git.unplannedDirty > 0) {
    findings.caution(
      "unplanned-files-dirty",
      [],
      `${source.git.unplannedDirty} dirty file(s) outside the plan; not a gate`
    );
  }
  if (!source.git.available) {
    findings.caution(
      "environment-unverified",
      [],
      "git is unavailable; working-tree state was not inspected"
    );
  }
  const t1 = performance.now();

  carryPlanBlockers(a);
  const stale = findings.has("source-stale");
  if (!stale) {
    a.fresh = planOperatorComposition(
      context.composition,
      context.operators,
      context.planning,
      context.facts
    );
  }
  const complete = completeness(a);
  const consistent: ReadinessConsistency = stale
    ? {
        consistent: false,
        matchesFreshPlanning: false,
        noActionCoverageConflict: plan.conflicts.length === 0,
        noDestinationConflicts: true,
        noDuplicateConflicts: true,
        noExportConflicts: true,
        noImportConflicts: true,
        noManifestConflicts: true,
        transformationDagAcyclic:
          transformationCycles(
            plan.transformations.map((t) => t.id),
            plan.dependencies
          ).length === 0,
      }
    : consistency(a);
  const sideEffects = stale ? [] : sideEffectChecks(a);
  const constraintStatus = stale
    ? { checks: [], compatible: false }
    : constraints(a);
  const realizable = realizability(a, sideEffects);
  const preserved = preservation(a);
  const t2 = performance.now();
  // Baseline commands are the expensive part; they run only for a plan that
  // is otherwise clean, so a blocked plan never spends minutes in vitest.
  const verify = verification(a, findings.blockers.length === 0);
  const t3 = performance.now();
  const back = rollback(a);
  consumerRisk(a);

  const status = authorization(findings);
  return {
    authorization: status,
    blockers: [...findings.blockers].sort(
      (x, y) => byId(x.kind, y.kind) || byId(x.detail, y.detail)
    ),
    capabilityVersion: registry.version,
    cautions: [...findings.cautions].sort(
      (x, y) => byId(x.kind, y.kind) || byId(x.detail, y.detail)
    ),
    completeness: complete,
    consistency: consistent,
    constraints: constraintStatus,
    contract: V12_CONTRACT,
    fingerprint: fingerprint(plan, registry, source, verify, back),
    intents: intents(a),
    planFingerprint: plan.fingerprint.hash,
    planId: plan.id,
    policyVersion: OPERATOR_READINESS_POLICY_VERSION,
    preservation: preserved,
    realizability: realizable,
    risks: [...findings.risks].sort(
      (x, y) => byId(x.kind, y.kind) || byId(x.detail, y.detail)
    ),
    rollback: back,
    schemaVersion: OPERATOR_READINESS_SCHEMA_VERSION,
    sourceState: source,
    timings: {
      baselineMs: Math.round((t3 - t2) * 10) / 10,
      sourceMs: Math.round((t1 - t0) * 10) / 10,
      structuralMs: Math.round((t2 - t1) * 10) / 10,
    },
    verification: verify,
  };
}

/** The V12 handoff record: ids and fingerprints only, never a plan copy. */
export function authorizeMutationPlan(
  plan: OperatorExecutionPlan,
  context: OperatorReadinessContext
): { readiness: OperatorPlanReadiness; authorized?: AuthorizedMutationPlan } {
  const readiness = assessOperatorPlanReadiness(plan, context);
  if (readiness.authorization !== "authorized") {
    return { readiness };
  }
  return {
    authorized: {
      authorization: "authorized",
      authorizationFingerprint: readiness.fingerprint,
      planId: plan.id,
      readinessFingerprint: readiness.fingerprint.hash,
      schemaVersion: OPERATOR_READINESS_SCHEMA_VERSION,
    },
    readiness,
  };
}
