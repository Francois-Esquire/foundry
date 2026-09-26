import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createOperatorContext,
  createRehomeBehaviorOperator,
  createRehomeConceptOperator,
} from "../../src/lib/architectural-operator";
import type { MutationCapabilityRegistry } from "../../src/lib/mutation-capabilities";
import { DEFAULT_MUTATION_CAPABILITIES } from "../../src/lib/mutation-capabilities";
import { composeArchitecturalOperators } from "../../src/lib/operator-composition";
import type { OperatorComposition } from "../../src/lib/operator-composition-types";
import { decomposeArchitecturalOperator } from "../../src/lib/operator-decomposition";
import { planOperatorComposition } from "../../src/lib/operator-plan";
import type { OperatorExecutionPlan } from "../../src/lib/operator-plan-types";
import type { OperatorPlanningContext } from "../../src/lib/operator-planning-context";
import { createOperatorPlanningContext } from "../../src/lib/operator-planning-context";
import type {
  OperatorReadinessContext,
  ReadinessCommandRunner,
} from "../../src/lib/operator-readiness";
import {
  assessOperatorPlanReadiness,
  authorizeMutationPlan,
} from "../../src/lib/operator-readiness";
import type { OperatorPlanReadiness } from "../../src/lib/operator-readiness-types";
import {
  OPERATOR_READINESS_POLICY_VERSION,
  OPERATOR_READINESS_SCHEMA_VERSION,
} from "../../src/lib/operator-readiness-types";
import type {
  ArchitecturalOperator,
  OperatorContext,
} from "../../src/lib/operator-types";
import { renderOperatorPlanReadiness } from "../../src/lib/report-readiness";
import { analyzeWorkspace } from "../../src/lib/workspace-intelligence";
import { createWorkspaceProjectionContext } from "../../src/lib/workspace-projection";
import {
  HELPER,
  hashTree,
  internalizeOperator as internalize,
  openOperator as open,
  PANEL,
  RANGE,
  REGISTRY,
  planningRoot as root,
  SHAPE,
  STATUS,
  planningSpec as spec,
  TOKEN,
  WIDGET,
} from "./helpers/planning-fixture";
import type { Spec } from "./helpers/workspace-builder";
import { workspace } from "./helpers/workspace-builder";

const OK_STATUS = "packages/store/src/status-factory.ts#okStatus";
const CIRCLE = "packages/store/src/shape-impl.ts#Circle";

/** Every kind executable and reversible: what a finished V12 would register. */
const permissive: MutationCapabilityRegistry = {
  capabilities: [
    ...DEFAULT_MUTATION_CAPABILITIES.capabilities,
    ...(
      [
        "move-symbol",
        "move-module",
        "create-module",
        "delete-empty-module",
        "add-export",
        "update-package-dependency",
      ] as const
    ).map((transformationKind) => ({
      atomic: true,
      reversible: true,
      supportedForms: ["*"],
      transformationKind,
    })),
  ],
  version: 99,
};

const pass: ReadinessCommandRunner = () => ({ exitCode: 0, output: "" });

interface Planned {
  composition: OperatorComposition;
  operators: ArchitecturalOperator[];
  plan: OperatorExecutionPlan;
}

let facts: OperatorContext;
let context: OperatorPlanningContext;
let before: Map<string, string>;

beforeAll(() => {
  before = hashTree(root);
  facts = createOperatorContext(
    createWorkspaceProjectionContext(analyzeWorkspace(workspace(spec())))
  );
  context = createOperatorPlanningContext({ root, tsconfig: "tsconfig.json" });
});

afterAll(() => {
  expect([...hashTree(root)]).toEqual([...before]);
});

function factsFor(extra: Partial<Spec>): OperatorContext {
  return createOperatorContext(
    createWorkspaceProjectionContext(
      analyzeWorkspace(workspace({ ...spec(), ...extra }))
    )
  );
}

function planned(
  operators: ArchitecturalOperator[],
  planning: OperatorPlanningContext = context,
  withFacts: OperatorContext = facts
): Planned {
  const decompositions = operators.map((o) =>
    decomposeArchitecturalOperator(o, withFacts)
  );
  const composition = composeArchitecturalOperators(
    operators,
    decompositions,
    withFacts
  );
  const plan = planOperatorComposition(
    composition,
    operators,
    planning,
    withFacts
  );
  return { composition, operators, plan };
}

function assess(
  p: Planned,
  overrides: Partial<OperatorReadinessContext> = {},
  plan: OperatorExecutionPlan = p.plan
): OperatorPlanReadiness {
  return assessOperatorPlanReadiness(plan, {
    composition: p.composition,
    facts,
    git: false,
    operators: p.operators,
    planning: context,
    runner: pass,
    ...overrides,
  });
}

function rehome(conceptId: string, to: string): ArchitecturalOperator {
  return createRehomeConceptOperator(facts, { conceptId, to });
}

function rehomeBehavior(
  conceptId: string,
  from: string,
  to: string
): ArchitecturalOperator {
  return createRehomeBehaviorOperator(facts, { conceptId, from: [from], to });
}

function withPreservation(
  operator: ArchitecturalOperator,
  kind: ArchitecturalOperator["preservations"][number]["kind"],
  entityIds: string[]
): ArchitecturalOperator {
  return {
    ...operator,
    preservations: [...operator.preservations, { entityIds, kind }],
  };
}

function copyFixture(): { dir: string; planning: OperatorPlanningContext } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-surface-ready-"));
  fs.cpSync(root, dir, { recursive: true });
  return {
    dir,
    planning: createOperatorPlanningContext({
      root: dir,
      tsconfig: "tsconfig.json",
    }),
  };
}

const blockerKinds = (r: OperatorPlanReadiness) =>
  [...new Set(r.blockers.map((b) => b.kind))].sort();

describe("an authorized internalize (§95, §4, §41–43, §47)", () => {
  it("authorizes the exact export removal with the real baseline runner", () => {
    const p = planned([internalize(HELPER, "@p/core")]);
    expect(p.plan.status).toBe("ready");
    const r = assess(p, { runner: undefined });
    expect(r.authorization).toBe("authorized");
    expect(r.blockers).toEqual([]);
    expect(r.sourceState.unchanged).toBe(true);
    expect(r.completeness.complete).toBe(true);
    expect(r.consistency.consistent).toBe(true);
    expect(r.constraints.compatible).toBe(true);
    expect(r.realizability.realizable).toBe(true);
    expect(r.preservation.covered).toBe(true);
    expect(r.verification.complete).toBe(true);
    expect(
      r.verification.baselineChecks.map((c) => `${c.kind}=${c.status}`)
    ).toEqual(["typecheck=pass", "tests=pass"]);
    expect(r.rollback).toMatchObject({
      complete: true,
      createdFiles: [],
      deletedFiles: [],
      strategy: "byte-snapshot",
    });
    expect(r.rollback.files.map((f) => `${f.action}:${f.file}`)).toEqual([
      "restore:packages/core/src/index.ts",
      "restore:packages/core/src/internal-user.ts",
    ]);
    expect(r.rollback.files.every((f) => /^[0-9a-f]{64}$/.test(f.hash))).toBe(
      true
    );
    expect(r.fingerprint.hash).toMatch(/^auth:[0-9a-f]{16}$/);
    expect(r.schemaVersion).toBe(OPERATOR_READINESS_SCHEMA_VERSION);
    expect(r.policyVersion).toBe(OPERATOR_READINESS_POLICY_VERSION);
  });

  it("resolves the verification steps into structured commands and analyzer queries", () => {
    const r = assess(planned([internalize(HELPER, "@p/core")]));
    const tests = r.verification.steps.find((s) => s.kind === "tests");
    expect(tests).toMatchObject({
      command: {
        args: ["run", "test"],
        cwd: "packages/core",
        executable: "bun",
        expectedExitCode: 0,
      },
      mode: "command",
    });
    expect(
      r.verification.steps.find((s) => s.kind === "typecheck")
    ).toMatchObject({ mode: "analyzer", query: "diagnostics:@p/core" });
    expect(
      r.verification.steps.find((s) => s.kind === "verify-public-surface")
        ?.query
    ).toMatch(/^verify-public-surface:/);
    expect(r.verification.assertions[0]).toMatchObject({
      before: "package-public",
      dimension: "surface",
      expectedAfter: "internal",
    });
    expect(
      r.verification.assertions[0]?.source.planTransformationIds.length
    ).toBeGreaterThan(0);
  });

  it("hands V12 an authorization record of ids and fingerprints, never a plan copy", () => {
    const p = planned([internalize(HELPER, "@p/core")]);
    const { readiness, authorized } = authorizeMutationPlan(p.plan, {
      composition: p.composition,
      facts,
      git: false,
      operators: p.operators,
      planning: context,
      runner: pass,
    });
    expect(authorized).toEqual({
      authorization: "authorized",
      authorizationFingerprint: readiness.fingerprint,
      planId: p.plan.id,
      readinessFingerprint: readiness.fingerprint.hash,
      schemaVersion: OPERATOR_READINESS_SCHEMA_VERSION,
    });
    expect(readiness.contract.join(" ")).toContain("revalidates");
    expect(readiness.contract.join(" ")).toContain("adds none");
  });
});

describe("source state (§6–10, §96–97)", () => {
  let copy: string;
  let copied: OperatorPlanningContext;

  beforeAll(() => {
    ({ dir: copy, planning: copied } = copyFixture());
  });

  afterAll(() => {
    fs.rmSync(copy, { force: true, recursive: true });
  });

  it("is stale when a planned file changes and current when an unrelated one does", () => {
    const p = planned([internalize(HELPER, "@p/core")], copied);
    expect(assess(p, { planning: copied }).authorization).toBe("authorized");
    fs.appendFileSync(path.join(copy, "packages/util/src/clamp.ts"), "\n//\n");
    const still = assess(p, { planning: copied });
    expect(still.authorization).toBe("authorized");
    expect(still.sourceState.unchanged).toBe(true);
    fs.appendFileSync(path.join(copy, "packages/core/src/index.ts"), "\n//\n");
    const stale = assess(p, { planning: copied });
    expect(stale.authorization).toBe("stale");
    expect(stale.sourceState.staleFiles).toEqual([
      "packages/core/src/index.ts",
    ]);
    expect(blockerKinds(stale)).toEqual(["source-stale"]);
    expect(stale.verification.baselineChecks).toEqual([]);
  });

  it("treats a dirty planned file whose bytes still match as a caution, not a gate", () => {
    const { dir, planning } = copyFixture();
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
      const p = planned([internalize(HELPER, "@p/core")], planning);
      const r = assess(p, { git: true, planning });
      expect(r.sourceState.git.available).toBe(true);
      expect(r.sourceState.git.plannedDirty).toContain(
        "packages/core/src/index.ts"
      );
      expect(r.cautions.map((c) => c.kind)).toContain("planned-file-dirty");
      expect(r.authorization).toBe("authorized");
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("reports git as unavailable outside a repository without failing", () => {
    const p = planned([internalize(HELPER, "@p/core")], copied);
    const r = assess(p, { git: true, planning: copied });
    expect(r.sourceState.git.available).toBe(false);
    expect(r.cautions.map((c) => c.kind)).toContain("environment-unverified");
  });
});

describe("completeness (§11–14, §98–99)", () => {
  it("refuses a plan whose required action has no realization", () => {
    const p = planned([internalize(HELPER, "@p/core")]);
    const tampered: OperatorExecutionPlan = {
      ...p.plan,
      realizations: p.plan.realizations.map((r, i) =>
        i === 0 ? { ...r, status: "partial", transformations: [] } : r
      ),
    };
    const r = assess(p, {}, tampered);
    expect(r.authorization).toBe("not-authorized");
    expect(blockerKinds(r)).toEqual(["plan-incomplete"]);
    expect(r.completeness.realizedActions).toBeLessThan(
      r.completeness.requiredActions
    );
  });

  it("settles inherited conditional transformations against fresh planning and refuses an unsettled one", () => {
    const keep = planned([rehome(TOKEN, "@p/core")]);
    const settled = assess(keep, { capabilities: permissive });
    expect(
      settled.completeness.conditionalTransformations.length
    ).toBeGreaterThan(0);
    expect(
      settled.completeness.conditionalTransformations.every(
        (c) => c.resolution === "required"
      )
    ).toBe(true);
    expect(settled.authorization).toBe("authorized");

    const p = planned([internalize(HELPER, "@p/core")]);
    const ghost = {
      ...p.plan.transformations[0],
      id: "transformation:0000000000000000",
      kind: "verify-only" as const,
      status: "conditional" as const,
    } as OperatorExecutionPlan["transformations"][number];
    const r = assess(
      p,
      {},
      {
        ...p.plan,
        transformations: [...p.plan.transformations, ghost],
      }
    );
    expect(r.authorization).toBe("not-authorized");
    expect(r.completeness.conditionalTransformations).toContainEqual(
      expect.objectContaining({
        resolution: "unresolved",
        transformationId: ghost.id,
      })
    );
  });

  it("refuses a plan with an unresolved planning gap", () => {
    const p = planned([open(rehome(REGISTRY, "@p/store"))]);
    expect(p.plan.status).toBe("partial");
    const r = assess(p, { capabilities: permissive });
    expect(r.authorization).toBe("not-authorized");
    expect(r.completeness.unresolvedGaps.join(" ")).toContain(
      "closure-incomplete"
    );
    expect(r.realizability.closures[0]?.complete).toBe(false);
  });
});

describe("realizability (§18–21, §59, §100–101)", () => {
  it("reports unsupported when the registry has no mutator for a planned kind", () => {
    const p = planned([rehomeBehavior(STATUS, "@p/store", "@p/core")]);
    expect(p.plan.status).toBe("ready");
    const r = assess(p);
    expect(r.authorization).toBe("unsupported");
    expect(
      r.realizability.unsupportedSyntaxForms.map((u) => u.kind).sort()
    ).toEqual(["delete-empty-module", "move-symbol"]);
    expect(
      r.realizability.mutationCapabilities.find(
        (m) => m.transformationKind === "move-symbol"
      )
    ).toMatchObject({ form: "symbol-move", occurrences: 1, supported: false });
    expect(r.verification.baselineChecks).toEqual([]);
  });

  it("authorizes the same relocation once the registry supports every planned form (§133)", () => {
    const p = planned([rehomeBehavior(STATUS, "@p/store", "@p/core")]);
    const r = assess(p, { capabilities: permissive });
    expect(r.authorization).toBe("authorized");
    expect(r.rollback.deletedFiles).toEqual([
      "packages/store/src/status-factory.ts",
    ]);
    expect(r.rollback.files.map((f) => `${f.action}:${f.file}`)).toEqual([
      "restore:packages/core/src/status.ts",
      "restore:packages/store/src/index.ts",
      "recreate:packages/store/src/status-factory.ts",
    ]);
  });

  it("distinguishes a supported syntax form from an unsupported one of the same kind", () => {
    const p = planned([internalize(HELPER, "@p/core")]);
    expect(assess(p).realizability.supportedSyntaxForms).toEqual([
      "named-import",
      "named-reexport",
    ]);
    const narrow: MutationCapabilityRegistry = {
      capabilities: DEFAULT_MUTATION_CAPABILITIES.capabilities.map((c) =>
        c.transformationKind === "rewrite-import"
          ? { ...c, supportedForms: ["type-import"] }
          : c
      ),
      version: 2,
    };
    const r = assess(p, { capabilities: narrow });
    expect(r.authorization).toBe("unsupported");
    expect(blockerKinds(r)).toEqual(["unsupported-syntax"]);
    expect(r.realizability.unsupportedSyntaxForms[0]).toMatchObject({
      form: "named-import",
      kind: "rewrite-import",
    });
  });

  it("carries a namespace import the planner could not rewrite as unsupported", () => {
    const p = planned([open(rehome(PANEL, "@p/store"))]);
    expect(p.plan.status).toBe("unsupported");
    const r = assess(p, { capabilities: permissive });
    expect(r.authorization).toBe("unsupported");
    expect(r.blockers.map((b) => b.kind)).toContain("unsupported-syntax");
  });
});

describe("constraints (§24–33, §105–111)", () => {
  it("blocks when a preserved consumer import path has no compatibility export (§105)", () => {
    const p = planned([rehome(TOKEN, "@p/core")]);
    const tampered: OperatorExecutionPlan = {
      ...p.plan,
      preserved: p.plan.preserved.map((x) =>
        x.preservationId.startsWith("consumer-import-path")
          ? { ...x, status: "unproven", transformations: [], verification: [] }
          : x
      ),
    };
    const r = assess(p, { capabilities: permissive }, tampered);
    expect(r.authorization).toBe("blocked");
    expect(r.blockers.map((b) => b.kind)).toContain(
      "public-surface-unresolved"
    );
    expect(
      r.constraints.checks.find((c) => c.kind === "consumer-compatibility")
        ?.status
    ).toBe("fail");
  });

  it("authorizes an explicitly breaking relocation and names the risk (§106)", () => {
    const p = planned([open(rehome(TOKEN, "@p/core"))]);
    const r = assess(p, { capabilities: permissive });
    expect(r.authorization).toBe("authorized");
    expect(r.risks.map((k) => k.kind)).toContain("breaking-public-surface");
    expect(
      r.constraints.checks.find((c) => c.kind === "public-surface")?.status
    ).toBe("pass");
    expect(
      r.constraints.checks.find((c) => c.kind === "consumer-compatibility")
        ?.status
    ).toBe("not-applicable");
  });

  it("blocks a plan that moves an anchored declaration (§107)", () => {
    const p = planned([
      withPreservation(
        rehomeBehavior(STATUS, "@p/store", "@p/core"),
        "anchor",
        [OK_STATUS]
      ),
    ]);
    const r = assess(p, { capabilities: permissive });
    expect(r.authorization).toBe("blocked");
    expect(r.blockers.map((b) => b.kind)).toContain("anchor-violation");
    expect(
      r.preservation.preservations.find((x) => x.kind === "anchor")?.status
    ).toBe("violated");
  });

  it("blocks a plan that moves an implementation the split keeps in place (§108)", () => {
    const p = planned([
      withPreservation(
        rehomeBehavior(SHAPE, "@p/store", "@p/core"),
        "implementation-split",
        [SHAPE]
      ),
    ]);
    const r = assess(p, { capabilities: permissive });
    expect(r.authorization).toBe("blocked");
    expect(r.blockers.map((b) => b.kind)).toContain("preservation-violation");
    expect(
      r.constraints.checks.find((c) => c.kind === "implementation-split")
        ?.status
    ).toBe("fail");
  });

  it("blocks a plan that moves a preserved representation (§109)", () => {
    const p = planned([
      withPreservation(
        rehomeBehavior(SHAPE, "@p/store", "@p/core"),
        "representation-boundary",
        [CIRCLE]
      ),
    ]);
    const r = assess(p, { capabilities: permissive });
    expect(r.authorization).toBe("blocked");
    expect(
      r.constraints.checks.find((c) => c.kind === "representation-boundary")
        ?.status
    ).toBe("fail");
  });

  it("blocks a package cycle (§110)", () => {
    const p = planned([open(rehome(RANGE, "@p/core"))]);
    const r = assess(p, { capabilities: permissive });
    expect(r.authorization).toBe("blocked");
    expect(r.blockers.map((b) => b.kind)).toContain("dependency-cycle");
    expect(r.risks).toContainEqual(
      expect.objectContaining({ blocking: true, kind: "package-cycle-change" })
    );
  });

  it("blocks a runtime dependency no operator effect predicts (§111)", () => {
    const p = planned([open(rehome(WIDGET, "@p/store"))]);
    expect(p.plan.status).toBe("ready");
    const r = assess(p, { capabilities: permissive });
    expect(r.authorization).toBe("blocked");
    expect(r.blockers).toContainEqual(
      expect.objectContaining({
        entities: ["@p/store→@p/util"],
        kind: "dependency-unexpected",
      })
    );
    expect(
      r.constraints.checks.find((c) => c.kind === "type-value-dependency")
        ?.status
    ).toBe("fail");
  });
});

describe("verification baseline (§34–43, §85, §112–116)", () => {
  it("refuses when the required typecheck already fails and accepts an exact allowance (§112–113)", () => {
    const { dir } = copyFixture();
    try {
      fs.appendFileSync(
        path.join(dir, "packages/core/src/panel.ts"),
        '\nexport const broken: number = "x";\n'
      );
      const planning = createOperatorPlanningContext({
        root: dir,
        tsconfig: "tsconfig.json",
      });
      const p = planned([internalize(HELPER, "@p/core")], planning);
      const failed = assess(p, { planning });
      expect(failed.authorization).toBe("blocked");
      expect(blockerKinds(failed)).toEqual(["baseline-verification-failed"]);
      const check = failed.verification.baselineChecks.find(
        (c) => c.kind === "typecheck"
      );
      expect(check?.status).toBe("fail");
      expect(check?.result?.failures).toEqual([
        "packages/core/src/panel.ts|TS2322",
      ]);

      const allowed = assess(p, {
        allowances: [
          {
            allowed: true,
            check: "typecheck",
            knownFailures: ["packages/core/src/panel.ts|TS2322"],
            provenance: "test baseline",
          },
        ],
        planning,
      });
      expect(allowed.authorization).toBe("authorized");
      expect(
        allowed.verification.baselineChecks.find((c) => c.kind === "typecheck")
      ).toMatchObject({
        allowance: "test baseline",
        status: "allowed-failure",
      });
      expect(allowed.cautions.map((c) => c.kind)).toContain(
        "allowed-baseline-failure"
      );

      fs.appendFileSync(
        path.join(dir, "packages/core/src/registry.ts"),
        '\nexport const alsoBroken: number = "y";\n'
      );
      const again = createOperatorPlanningContext({
        root: dir,
        tsconfig: "tsconfig.json",
      });
      const p2 = planned([internalize(HELPER, "@p/core")], again);
      const unexpected = assess(p2, {
        allowances: [
          {
            allowed: true,
            check: "typecheck",
            knownFailures: ["packages/core/src/panel.ts|TS2322"],
            provenance: "test baseline",
          },
        ],
        planning: again,
      });
      expect(unexpected.authorization).toBe("blocked");
      expect(blockerKinds(unexpected)).toEqual([
        "baseline-verification-failed",
      ]);
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("refuses when a required targeted test fails (§114)", () => {
    const p = planned([internalize(HELPER, "@p/core")]);
    const r = assess(p, {
      runner: () => ({
        exitCode: 1,
        output: " FAIL  test/helper.test.ts > helperOnly > works\n",
      }),
    });
    expect(r.authorization).toBe("blocked");
    expect(blockerKinds(r)).toEqual(["baseline-verification-failed"]);
    expect(
      r.verification.baselineChecks.find((c) => c.kind === "tests")?.result
    ).toEqual({
      exitCode: 1,
      failures: ["FAIL test/helper.test.ts > helperOnly > works"],
    });
  });

  it("refuses when a required verification step cannot run here (§115)", () => {
    const { dir } = copyFixture();
    try {
      const manifest = path.join(dir, "packages/core/package.json");
      const parsed = JSON.parse(fs.readFileSync(manifest, "utf8")) as Record<
        string,
        unknown
      >;
      delete parsed.scripts;
      fs.writeFileSync(manifest, JSON.stringify(parsed, null, 2));
      const planning = createOperatorPlanningContext({
        root: dir,
        tsconfig: "tsconfig.json",
      });
      const p = planned([internalize(HELPER, "@p/core")], planning);
      const r = assess(p, { planning });
      expect(r.authorization).toBe("not-authorized");
      expect(blockerKinds(r)).toEqual(["verification-incomplete"]);
      expect(
        r.verification.baselineChecks.find((c) => c.kind === "tests")?.status
      ).toBe("skipped");
      expect(r.verification.executable).toBe(false);
    } finally {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  it("ignores a failing test outside the verification scope (§116)", () => {
    const p = planned([internalize(HELPER, "@p/core")]);
    const r = assess(p, {
      runner: (command) =>
        command.cwd === "packages/app"
          ? { exitCode: 1, output: " FAIL  app\n" }
          : { exitCode: 0, output: "" },
    });
    expect(r.authorization).toBe("authorized");
    expect(r.verification.steps.map((s) => s.command?.cwd)).not.toContain(
      "packages/app"
    );
  });

  it("runs baseline commands only for a plan that is otherwise clean", () => {
    let calls = 0;
    const p = planned([open(rehome(RANGE, "@p/core"))]);
    assess(p, {
      capabilities: permissive,
      runner: () => {
        calls += 1;
        return { exitCode: 0, output: "" };
      },
    });
    expect(calls).toBe(0);
  });
});

describe("coverage and structural conformance (§55–58, §117–118)", () => {
  it("authorizes internalize under partial coverage and blocks a relocation whose consumer is unanalyzed (§117)", () => {
    const partial = factsFor({ missing: ["@p/cli"] });
    const internal = planned(
      [internalize(HELPER, "@p/core")],
      context,
      partial
    );
    const r = assess(internal, { facts: partial });
    expect(r.authorization).toBe("authorized");
    expect(r.cautions.map((c) => c.kind)).toContain("coverage-partial");
    expect(r.risks).toContainEqual(
      expect.objectContaining({
        blocking: false,
        kind: "partial-workspace-coverage",
      })
    );

    const move = planned(
      [
        open(
          createRehomeConceptOperator(partial, {
            conceptId: TOKEN,
            to: "@p/core",
          })
        ),
      ],
      context,
      partial
    );
    const blocked = assess(move, { capabilities: permissive, facts: partial });
    expect(blocked.authorization).toBe("blocked");
    expect(blocked.blockers).toContainEqual(
      expect.objectContaining({
        entities: ["@p/cli"],
        kind: "coverage-insufficient",
      })
    );
  });

  it("blocks a relocation that depends on unobserved conformance and only cautions internalize (§118)", () => {
    const constraint = {
      detail: "Status has no observed implementation",
      effect: "constraining" as const,
      entityIds: [STATUS],
      kind: "structural-conformance-unknown" as const,
    };
    const move = rehomeBehavior(STATUS, "@p/store", "@p/core");
    const r = assess(
      planned([{ ...move, constraints: [...move.constraints, constraint] }]),
      { capabilities: permissive }
    );
    expect(r.authorization).toBe("blocked");
    expect(r.blockers.map((b) => b.kind)).toContain(
      "structural-conformance-unknown"
    );

    const internal = internalize(HELPER, "@p/core");
    const ok = assess(planned([{ ...internal, constraints: [constraint] }]));
    expect(ok.authorization).toBe("authorized");
    expect(ok.cautions.map((c) => c.kind)).toContain(
      "structural-conformance-unobserved"
    );
  });
});

describe("graphs and composition (§15–16, §72–73, §119–121)", () => {
  it("refuses a composed plan as a whole when one transformation is unsupported (§119)", () => {
    const p = planned([
      internalize(HELPER, "@p/core"),
      rehomeBehavior(STATUS, "@p/store", "@p/core"),
    ]);
    const r = assess(p);
    expect(r.authorization).toBe("unsupported");
    expect(r.realizability.supportedTransformations).toBeGreaterThan(0);
    expect(r.realizability.unsupportedTransformations).toBeGreaterThan(0);
    expect(
      authorizeMutationPlan(p.plan, {
        composition: p.composition,
        facts,
        git: false,
        operators: p.operators,
        planning: context,
        runner: pass,
      }).authorized
    ).toBeUndefined();
  });

  it("blocks a transformation graph with a dangling dependency (§120)", () => {
    const p = planned([internalize(HELPER, "@p/core")]);
    const first = p.plan.transformations[0];
    if (first === undefined) {
      throw new Error("no transformation");
    }
    const r = assess(
      p,
      {},
      {
        ...p.plan,
        dependencies: [
          ...p.plan.dependencies,
          {
            after: first.id,
            before: "transformation:ffffffffffffffff",
            kind: "requires",
            reason: "tampered",
          },
        ],
      }
    );
    expect(r.authorization).toBe("blocked");
    expect(r.consistency.transformationDagAcyclic).toBe(false);
    expect(r.blockers.map((b) => b.kind)).toContain("transformation-conflict");
  });

  it("refuses a cyclic verification sequence (§121)", () => {
    const p = planned([internalize(HELPER, "@p/core")]);
    const r = assess(
      p,
      {},
      {
        ...p.plan,
        verification: p.plan.verification.map((v, i) =>
          i === 0 ? { ...v, dependsOn: [v.id] } : v
        ),
      }
    );
    expect(r.authorization).toBe("not-authorized");
    expect(r.blockers.map((b) => b.kind)).toContain("verification-incomplete");
    expect(r.verification.executable).toBe(false);
  });
});

describe("rollback (§47–52, §102–104)", () => {
  it("blocks a transformation whose original bytes cannot be snapshotted (§102)", () => {
    const p = planned([internalize(HELPER, "@p/core")]);
    const first = p.plan.transformations[0];
    if (first === undefined) {
      throw new Error("no transformation");
    }
    const r = assess(
      p,
      {},
      {
        ...p.plan,
        transformations: [
          ...p.plan.transformations,
          {
            ...first,
            file: "packages/core/src/ghost.ts",
            id: "transformation:eeeeeeeeeeeeeeee",
          },
        ],
      }
    );
    expect(r.authorization).toBe("blocked");
    expect(r.rollback.strategy).toBe("unsupported");
    expect(r.rollback.files).toContainEqual(
      expect.objectContaining({
        file: "packages/core/src/ghost.ts",
        restorable: false,
      })
    );
    expect(r.blockers.map((b) => b.kind)).toContain("rollback-incomplete");
  });

  it("fingerprints a created file as absent and a deleted file by its bytes (§103–104)", () => {
    const p = planned([rehome(TOKEN, "@p/core")]);
    const r = assess(p, { capabilities: permissive });
    expect(r.rollback.createdFiles).toEqual(["packages/core/src/token.ts"]);
    expect(r.rollback.deletedFiles).toEqual(["packages/store/src/token.ts"]);
    expect(r.rollback.files).toContainEqual({
      action: "delete",
      file: "packages/core/src/token.ts",
      hash: "absent",
      restorable: true,
    });
    expect(
      r.rollback.files.find((f) => f.file === "packages/store/src/token.ts")
    ).toMatchObject({ action: "recreate", restorable: true });
    expect(r.sourceState.expectedFiles).toContainEqual(
      expect.objectContaining({
        expected: "absent",
        file: "packages/core/src/token.ts",
        status: "unchanged",
      })
    );
    expect(r.rollback.complete).toBe(true);
  });

  it("blocks a deletion the mutator cannot reverse (§104)", () => {
    const irreversible: MutationCapabilityRegistry = {
      capabilities: permissive.capabilities.map((c) =>
        c.transformationKind === "delete-empty-module"
          ? { ...c, reversible: false }
          : c
      ),
      version: 3,
    };
    const p = planned([rehomeBehavior(STATUS, "@p/store", "@p/core")]);
    const r = assess(p, { capabilities: irreversible });
    expect(r.authorization).toBe("blocked");
    expect(r.blockers.map((b) => b.kind)).toContain("rollback-incomplete");
  });
});

describe("identity and serialization (§60–65, §93, §122–124)", () => {
  const strip = (r: OperatorPlanReadiness) => ({ ...r, timings: undefined });

  it("yields the same record and fingerprint under input reordering (§122)", () => {
    const a = planned([
      internalize(HELPER, "@p/core"),
      open(rehome(TOKEN, "@p/core")),
    ]);
    const b = planned([
      open(rehome(TOKEN, "@p/core")),
      internalize(HELPER, "@p/core"),
    ]);
    const ra = assess(a, { capabilities: permissive });
    const rb = assess(b, { capabilities: permissive });
    expect(strip(ra)).toEqual(strip(rb));
    expect(ra.fingerprint).toEqual(rb.fingerprint);
    expect(strip(assess(a, { capabilities: permissive }))).toEqual(strip(ra));
  });

  it("changes the authorization fingerprint when the mutator's capabilities change (§123)", () => {
    const p = planned([internalize(HELPER, "@p/core")]);
    const one = assess(p);
    const two = assess(p, {
      capabilities: {
        capabilities: [
          ...DEFAULT_MUTATION_CAPABILITIES.capabilities,
          {
            atomic: true,
            reversible: true,
            supportedForms: ["symbol-move"],
            transformationKind: "move-symbol",
          },
        ],
        version: DEFAULT_MUTATION_CAPABILITIES.version + 1,
      },
    });
    expect(two.fingerprint.capabilityFingerprint).not.toBe(
      one.fingerprint.capabilityFingerprint
    );
    expect(two.fingerprint.hash).not.toBe(one.fingerprint.hash);
    expect(two.fingerprint.planFingerprint).toBe(
      one.fingerprint.planFingerprint
    );
    expect(two.fingerprint.sourceFingerprint).toBe(
      one.fingerprint.sourceFingerprint
    );
    expect(two.capabilityVersion).toBe(
      DEFAULT_MUTATION_CAPABILITIES.version + 1
    );
  });

  it("round-trips through JSON (§124)", () => {
    const r = assess(planned([internalize(HELPER, "@p/core")]));
    expect(JSON.parse(JSON.stringify(r))).toEqual(r);
  });

  it("renders the readiness as text", () => {
    const text = renderOperatorPlanReadiness(
      assess(planned([internalize(HELPER, "@p/core")]))
    );
    expect(text).toContain("OPERATOR READINESS");
    expect(text).toContain("Mutation support");
    expect(text).toContain("AUTHORIZED");
    expect(text).toContain("V12 must revalidate");
    const blocked = renderOperatorPlanReadiness(
      assess(planned([rehomeBehavior(STATUS, "@p/store", "@p/core")]))
    );
    expect(blocked).toContain("UNSUPPORTED");
    expect(blocked).toContain("move-symbol (symbol-move)");
  });
});

describe("guarantees (§74, §125–127, §143)", () => {
  function keysOf(value: unknown, into: Set<string>): Set<string> {
    if (Array.isArray(value)) {
      for (const v of value) {
        keysOf(v, into);
      }
    } else if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        into.add(k);
        keysOf(v, into);
      }
    }
    return into;
  }

  it("carries no apply, write, patch, or mutated field", () => {
    const r = assess(planned([internalize(HELPER, "@p/core")]));
    const keys = [...keysOf(r, new Set())];
    expect(keys.filter((k) => /apply|write|patch|mutated/i.test(k))).toEqual(
      []
    );
  });

  it("carries no score, confidence, priority, effort, or rank", () => {
    const r = assess(planned([open(rehome(TOKEN, "@p/core"))]), {
      capabilities: permissive,
    });
    const keys = [...keysOf(r, new Set())];
    expect(
      keys.filter((k) => /score|confidence|priority|effort|rank/i.test(k))
    ).toEqual([]);
  });

  it("never calls a write in its own source", () => {
    for (const name of [
      "operator-readiness.ts",
      "mutation-capabilities.ts",
      "report-readiness.ts",
    ]) {
      const text = fs.readFileSync(
        path.join(import.meta.dirname, "../../src/lib", name),
        "utf8"
      );
      expect(text).not.toMatch(
        /writeFileSync|saveSync|rmSync|mkdirSync|renameSync|--fix|--write/
      );
    }
  });
});
