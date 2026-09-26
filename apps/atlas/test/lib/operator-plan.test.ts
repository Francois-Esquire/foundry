import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createOperatorContext,
  createRehomeBehaviorOperator,
  createRehomeConceptOperator,
} from "../../src/lib/architectural-operator";
import { composeArchitecturalOperators } from "../../src/lib/operator-composition";
import type { OperatorComposition } from "../../src/lib/operator-composition-types";
import { decomposeArchitecturalOperator } from "../../src/lib/operator-decomposition";
import {
  planArchitecturalOperator,
  planOperatorComposition,
  validateOperatorExecutionPlan,
} from "../../src/lib/operator-plan";
import type {
  OperatorExecutionPlan,
  OperatorExecutionPlanValidation,
} from "../../src/lib/operator-plan-types";
import {
  OPERATOR_PLAN_SCHEMA_VERSION,
  OPERATOR_PLANNING_POLICY_VERSION,
} from "../../src/lib/operator-plan-types";
import type { OperatorPlanningContext } from "../../src/lib/operator-planning-context";
import { createOperatorPlanningContext } from "../../src/lib/operator-planning-context";
import type {
  ArchitecturalOperator,
  OperatorContext,
} from "../../src/lib/operator-types";
import { renderOperatorExecutionPlan } from "../../src/lib/report-plan";
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
  SPRITE,
  STARRED,
  STATUS,
  planningSpec as spec,
  TOKEN,
  WIDGET,
} from "./helpers/planning-fixture";
import { workspace } from "./helpers/workspace-builder";

interface Planned {
  composition: OperatorComposition;
  operators: ArchitecturalOperator[];
  plan: OperatorExecutionPlan;
  validation: OperatorExecutionPlanValidation;
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

function planned(
  operators: ArchitecturalOperator[],
  planning: OperatorPlanningContext = context
): Planned {
  const decompositions = operators.map((o) =>
    decomposeArchitecturalOperator(o, facts)
  );
  const composition = composeArchitecturalOperators(
    operators,
    decompositions,
    facts
  );
  const plan = planOperatorComposition(composition, operators, planning, facts);
  const validation = validateOperatorExecutionPlan(
    plan,
    composition,
    operators,
    planning,
    facts
  );
  return { composition, operators, plan, validation };
}

const kinds = (plan: OperatorExecutionPlan) =>
  plan.transformations.map((t) => t.kind);
const ofKind = (plan: OperatorExecutionPlan, kind: string) =>
  plan.transformations.filter((t) => t.kind === kind);

describe("internalize plans (§91–92, §103)", () => {
  it("plans an exact export removal with nothing else touched", () => {
    const { plan, validation } = planned([internalize(HELPER, "@p/core")]);
    expect(plan.status).toBe("ready");
    expect(validation.status).toBe("valid");
    expect(kinds(plan).sort()).toEqual(["rewrite-import", "rewrite-reexport"]);
    expect(plan.targets.map((t) => t.file)).toEqual([
      "packages/core/src/index.ts",
      "packages/core/src/internal-user.ts",
    ]);
    const removal = ofKind(plan, "rewrite-reexport")[0];
    expect(removal?.before?.names).toEqual(["helperOnly"]);
    expect(removal?.after?.names).toEqual([]);
    expect(plan.realizations.every((r) => r.status === "realized")).toBe(true);
    expect(plan.blockers).toEqual([]);
  });

  it("redirects the internal entrypoint importer to the module before the exposure goes (V3 regression)", () => {
    const { plan } = planned([internalize(HELPER, "@p/core")]);
    const rewrite = ofKind(plan, "rewrite-import")[0];
    expect(rewrite?.file).toBe("packages/core/src/internal-user.ts");
    expect(rewrite?.before?.specifier).toBe("@p/core");
    expect(rewrite?.after?.specifier).toBe("./helper");
    const removal = ofKind(plan, "rewrite-reexport")[0];
    expect(plan.dependencies).toContainEqual(
      expect.objectContaining({
        after: removal?.id,
        before: rewrite?.id,
        kind: "preserve-before-remove",
      })
    );
  });

  it("leaves a star-exported symbol unsupported instead of guessing a rewrite", () => {
    const { plan } = planned([internalize(STARRED, "@p/core")]);
    expect(plan.status).toBe("unsupported");
    expect(plan.blockers.map((b) => b.kind)).toEqual([
      "unsupported-export-form",
    ]);
    expect(ofKind(plan, "remove-export")[0]?.status).toBe("unsupported");
    expect(plan.diagnostics.unsupportedForms).toEqual(["star-export"]);
  });

  it("is stale when a consumer still imports the symbol the operator calls unused", () => {
    const { plan } = planned([internalize(PANEL, "@p/core")]);
    expect(plan.status).toBe("stale");
    expect(plan.blockers[0]?.kind).toBe("source-state-mismatch");
    expect(plan.blockers[0]?.entities).toEqual(["packages/app/src/ns.ts"]);
  });

  it("is stale when the symbol is not declared where the operator says", () => {
    const { plan } = planned([
      internalize("packages/core/src/helper.ts#Missing", "@p/core"),
    ]);
    expect(plan.status).toBe("stale");
    expect(plan.blockers[0]?.kind).toBe("source-state-mismatch");
  });
});

describe("relocation plans (§93–99)", () => {
  it("moves a standalone factory into the concept's own module (§93)", () => {
    const { plan, validation } = planned([
      rehomeBehavior(STATUS, "@p/store", "@p/core"),
    ]);
    expect(plan.status).toBe("ready");
    expect(validation.status).toBe("valid");
    const move = ofKind(plan, "move-symbol")[0];
    expect(move?.subject?.symbolId).toBe(
      "packages/store/src/status-factory.ts#okStatus"
    );
    expect(move?.after?.module).toBe("packages/core/src/status.ts");
    const [relocation] = plan.relocations;
    expect(relocation?.targetResolution).toBe("concept-declaration-module");
    expect(relocation?.granularity).toBe("symbol");
    expect(relocation?.members).toEqual([
      {
        role: "factory",
        source: "behavior-participant",
        symbolId: "packages/store/src/status-factory.ts#okStatus",
      },
    ]);
    expect(relocation?.closure?.externalDependencies).toEqual([
      {
        class: "import-from-target-package",
        id: STATUS,
        name: "Status",
        package: "@p/core",
        typeOnly: true,
      },
    ]);
    expect(kinds(plan).sort()).toEqual([
      "delete-empty-module",
      "move-symbol",
      "rewrite-reexport",
    ]);
  });

  it("excludes parameter-only consumers from governing behavior (§47)", () => {
    const { plan } = planned([rehomeBehavior(STATUS, "@p/store", "@p/core")]);
    const moved = plan.transformations
      .filter((t) => t.kind === "move-symbol")
      .map((t) => t.subject?.symbolId);
    expect(moved).not.toContain("packages/store/src/repo.ts#StoreRepo");
    expect(moved).not.toContain("packages/store/src/save.ts#save");
  });

  it("moves a cohesive implementing class as one unit with its closure (§94, §97)", () => {
    const { plan } = planned([rehomeBehavior(SHAPE, "@p/store", "@p/core")]);
    expect(plan.status).toBe("ready");
    const [relocation] = plan.relocations;
    expect(relocation?.members[0]?.role).toBe("implementation");
    expect(relocation?.closure?.externalDependencies).toEqual([
      {
        class: "import-from-target-package",
        id: SHAPE,
        name: "Shape",
        package: "@p/core",
        typeOnly: true,
      },
      {
        class: "import-from-third-package",
        id: "packages/util/src/range.ts#Range",
        name: "Range",
        package: "@p/util",
        typeOnly: true,
      },
    ]);
    expect(ofKind(plan, "update-package-dependency")).toEqual([]);
    expect(
      plan.preserved.map((p) => `${p.preservationId}=${p.status}`)
    ).toContain("semantic-center:@p/core=proven");
  });

  it("moves only the concept out of a mixed module, never the whole file (§95)", () => {
    const { plan } = planned([open(rehome(SPRITE, "@p/store"))]);
    expect(plan.status).toBe("ready");
    expect(ofKind(plan, "move-module")).toEqual([]);
    expect(ofKind(plan, "delete-empty-module")).toEqual([]);
    const moves = ofKind(plan, "move-symbol").map((t) => t.subject?.symbolId);
    expect(moves).toEqual([SPRITE]);
    expect(plan.relocations[0]?.granularity).toBe("symbol");
    expect(plan.relocations[0]?.targetModule).toBe(
      "packages/store/src/sprite-impl.ts"
    );
  });

  it("leaves a helper shared with remaining code unresolved instead of duplicating it (§96)", () => {
    const { plan } = planned([open(rehome(REGISTRY, "@p/store"))]);
    expect(plan.status).toBe("partial");
    expect(ofKind(plan, "move-symbol")).toEqual([]);
    expect(plan.unresolved.map((g) => g.kind)).toContain("closure-incomplete");
    expect(plan.relocations[0]?.closure).toMatchObject({
      complete: false,
      requiredInternalSymbols: ["packages/core/src/registry.ts#shared"],
      sharedInternalSymbols: ["packages/core/src/registry.ts#shared"],
    });
    expect(plan.relocations[0]?.granularity).toBe("unresolved");
  });

  it("classifies every dependency of a moved class (§56, §97)", () => {
    const { plan } = planned([open(rehome(WIDGET, "@p/store"))]);
    const closure = plan.relocations[0]?.closure;
    expect(closure?.requiredInternalSymbols).toEqual([
      "packages/core/src/widget.ts#square",
    ]);
    expect(
      closure?.externalDependencies.map(
        (d) => `${d.name}:${d.class}:${d.typeOnly}`
      )
    ).toEqual([
      "Shape:import-from-source-package:true",
      "clamp:import-from-third-package:false",
      "Range:import-from-third-package:true",
    ]);
    expect(plan.relocations[0]?.granularity).toBe("module");
    expect(ofKind(plan, "move-module")[0]?.after?.module).toBe(
      "packages/store/src/widget.ts"
    );
  });

  it("records a type-only dependency becoming runtime (§66–67, §98)", () => {
    const { plan } = planned([open(rehome(WIDGET, "@p/store"))]);
    expect(plan.predicted).toContainEqual(
      expect.objectContaining({
        certainty: "certain",
        change: "runtime-dependency-escalation",
        dimension: "dependency",
        subjects: ["@p/store→@p/util"],
      })
    );
    expect(ofKind(plan, "update-package-dependency")).toEqual([]);
  });

  it("blocks a move that closes a package cycle (§57, §99)", () => {
    const { plan } = planned([open(rehome(RANGE, "@p/core"))]);
    expect(plan.status).toBe("blocked");
    const cycle = plan.blockers.find((b) => b.kind === "dependency-cycle-risk");
    expect(cycle?.entities).toEqual(["@p/core", "@p/util"]);
    expect(plan.dependencies.length).toBeGreaterThan(0);
  });

  it("blocks a compatibility export that would close a cycle (§57)", () => {
    const { plan } = planned([rehome(WIDGET, "@p/app")]);
    expect(plan.status).toBe("blocked");
    expect(plan.blockers.map((b) => b.kind)).toContain("dependency-cycle-risk");
  });
});

describe("surface and manifest plans (§100–108)", () => {
  it("adds the target's public exposure in its barrel, not in the module (§100, §107)", () => {
    const { plan } = planned([open(rehome(TOKEN, "@p/core"))]);
    const added = ofKind(plan, "add-export")[0];
    expect(added?.file).toBe("packages/core/src/index.ts");
    expect(added?.after).toEqual({
      exportForm: "type-reexport",
      module: "packages/core/src/index.ts",
      names: ["Token"],
      package: "@p/core",
      specifier: "./token",
    });
    expect(ofKind(plan, "move-module")[0]?.after?.module).toBe(
      "packages/core/src/token.ts"
    );
  });

  it("keeps the old import path through a compatibility re-export when the operator preserves it (§101)", () => {
    const { plan, validation } = planned([rehome(TOKEN, "@p/core")]);
    expect(plan.status).toBe("ready");
    expect(validation.status).toBe("valid");
    const compat = ofKind(plan, "preserve-compatibility-export")[0];
    expect(compat?.file).toBe("packages/store/src/index.ts");
    expect(compat?.after?.specifier).toBe("@p/core");
    expect(compat?.after?.exportForm).toBe("type-reexport");
    expect(plan.relocations[0]?.strategy).toBe("compatibility-reexport");
    expect(plan.preserved).toContainEqual(
      expect.objectContaining({
        preservationId: "consumer-import-path:@p/app,@p/cli",
        status: "transformed",
        transformations: [compat?.id],
      })
    );
    expect(ofKind(plan, "rewrite-reexport")).toEqual([]);
  });

  it("never chooses a breaking relocation when a consumer cannot be redirected (§102)", () => {
    const { plan } = planned([open(rehome(PANEL, "@p/store"))]);
    expect(plan.relocations[0]?.strategy).toBe("unresolved");
    expect(plan.unresolved.map((g) => g.kind)).toContain(
      "surface-strategy-unresolved"
    );
    expect(ofKind(plan, "rewrite-reexport")).toEqual([]);
    expect(ofKind(plan, "remove-export")).toEqual([]);
  });

  it("drops the old route only when every outside importer is redirected (§20)", () => {
    const { plan } = planned([open(rehome(TOKEN, "@p/core"))]);
    expect(plan.status).toBe("ready");
    expect(plan.relocations[0]?.strategy).toBe("direct-relocation");
    const removal = ofKind(plan, "rewrite-reexport")[0];
    expect(removal?.file).toBe("packages/store/src/index.ts");
    for (const rewrite of ofKind(plan, "rewrite-import")) {
      expect(plan.dependencies).toContainEqual(
        expect.objectContaining({ after: removal?.id, before: rewrite.id })
      );
    }
  });

  it("marks a namespace import unsupported (§24, §104)", () => {
    const { plan } = planned([open(rehome(PANEL, "@p/store"))]);
    expect(plan.status).toBe("unsupported");
    expect(plan.blockers.map((b) => b.kind)).toContain(
      "unsupported-import-form"
    );
    expect(plan.importRewrites).toContainEqual(
      expect.objectContaining({
        file: "packages/app/src/ns.ts",
        importKind: "namespace",
        status: "unsupported",
      })
    );
  });

  it("plans the exact manifest dependency a new import needs (§28, §105)", () => {
    const { plan } = planned([open(rehome(WIDGET, "@p/app"))]);
    expect(plan.status).toBe("ready");
    const manifest = ofKind(plan, "update-package-dependency")[0];
    expect(manifest?.file).toBe("packages/app/package.json");
    expect(manifest?.after?.dependency).toEqual({
      declared: true,
      package: "@p/util",
    });
    expect(manifest?.after?.runtime).toBe(true);
    const moves = ofKind(plan, "move-symbol");
    for (const move of moves) {
      expect(plan.dependencies).toContainEqual(
        expect.objectContaining({ after: move.id, before: manifest?.id })
      );
    }
  });

  it("rewrites a test import to the moved declaration (§69)", () => {
    const { plan } = planned([open(rehome(WIDGET, "@p/app"))]);
    const test = ofKind(plan, "update-test-import")[0];
    expect(test?.file).toBe("packages/app/test/main-check.ts");
    expect(test?.after?.specifier).toBe("../src/main");
    expect(plan.targets.find((t) => t.file === test?.file)?.kind).toBe("test");
  });

  it("removes a manifest dependency only when no import remains (§29, §106)", () => {
    const { plan } = planned([open(rehome(TOKEN, "@p/core"))]);
    const removals = ofKind(plan, "update-package-dependency").filter(
      (t) => t.after?.dependency?.declared === false
    );
    expect(removals.map((t) => t.file)).toEqual(["packages/cli/package.json"]);
    expect(removals[0]?.status).toBe("conditional");
    expect(removals[0]?.after?.dependency?.package).toBe("@p/store");
  });

  it("keeps a dependency whose import is only split, not removed (§29)", () => {
    const { plan } = planned([open(rehome(WIDGET, "@p/store"))]);
    const removals = ofKind(plan, "update-package-dependency").filter(
      (t) => t.after?.dependency?.declared === false
    );
    expect(removals).toEqual([]);
    expect(ofKind(plan, "rewrite-import")[0]?.detail).toContain(
      "formatStatus stay on the old import"
    );
  });

  it("blocks on a target name collision without renaming (§76, §108)", () => {
    const { plan } = planned([rehomeBehavior(SPRITE, "@p/store", "@p/core")]);
    expect(plan.status).toBe("blocked");
    expect(plan.blockers.map((b) => b.kind)).toContain(
      "target-module-collision"
    );
    expect(plan.conflicts[0]).toMatchObject({
      entities: ["packages/core/src/sprite.ts#SpriteImpl"],
      kind: "target-module-collision",
    });
    expect(plan.transformations).toEqual([]);
    expect(plan.relocations[0]?.granularity).toBe("unresolved");
  });
});

describe("staleness and fingerprint scope (§109–110)", () => {
  let copy: string;
  let copied: OperatorPlanningContext;

  beforeAll(() => {
    copy = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-surface-plan-"));
    fs.cpSync(root, copy, { recursive: true });
    copied = createOperatorPlanningContext({
      root: copy,
      tsconfig: "tsconfig.json",
    });
  });

  afterAll(() => {
    fs.rmSync(copy, { force: true, recursive: true });
  });

  it("goes stale when a planned file changes and stays current when an unrelated one does", () => {
    const first = planned([rehome(TOKEN, "@p/core")], copied);
    expect(first.validation.status).toBe("valid");
    const unrelated = path.join(copy, "packages/util/src/clamp.ts");
    fs.appendFileSync(unrelated, "\n// unrelated\n");
    const still = validateOperatorExecutionPlan(
      first.plan,
      first.composition,
      first.operators,
      copied,
      facts
    );
    expect(still.status).toBe("valid");
    expect(still.changedFiles).toEqual([]);
    const planned_ = path.join(copy, "packages/store/src/token.ts");
    fs.appendFileSync(planned_, "\n// moved\n");
    const stale = validateOperatorExecutionPlan(
      first.plan,
      first.composition,
      first.operators,
      copied,
      facts
    );
    expect(stale.status).toBe("stale");
    expect(stale.changedFiles).toEqual(["packages/store/src/token.ts"]);
  });

  it("fingerprints only planned files, manifests, and entrypoints (§35–36)", () => {
    const { plan } = planned([rehome(TOKEN, "@p/core")]);
    const files = plan.fingerprint.files.map((f) => f.file);
    expect(files).toContain("packages/store/src/token.ts");
    expect(files).toContain("packages/cli/package.json");
    expect(files).not.toContain("packages/util/src/clamp.ts");
    expect(files).not.toContain("packages/core/src/registry.ts");
    expect(plan.fingerprint.operatorCompositionFingerprint).toBe(
      plan.compositionId.length > 0
        ? plan.fingerprint.operatorCompositionFingerprint
        : ""
    );
  });
});

describe("coverage, verification, and graph (§111–115)", () => {
  it("accounts for every structural action and marks the unrealized ones partial (§111)", () => {
    const { plan, composition } = planned([open(rehome(REGISTRY, "@p/store"))]);
    expect(plan.realizations.map((r) => r.actionId).sort()).toEqual(
      composition.actions.map((a) => a.id).sort()
    );
    expect(plan.status).toBe("partial");
    expect(
      plan.realizations.find((r) => r.actionId.includes("relocate-semantic"))
        ?.status
    ).toBe("partial");
  });

  it("proves every composition preservation by a transformation or a check (§112)", () => {
    const keep = planned([rehome(TOKEN, "@p/core")]).plan;
    expect(keep.preserved.every((p) => p.status !== "unproven")).toBe(true);
    const behavior = planned([
      rehomeBehavior(SHAPE, "@p/store", "@p/core"),
    ]).plan;
    expect(
      behavior.preserved.map((p) => `${p.preservationId}=${p.status}`)
    ).toEqual([
      "consumer-import-path:@p/store=proven",
      "public-contract:@p/core=proven",
      "semantic-center:@p/core=proven",
    ]);
  });

  it("expands abstract verification into source-aware, ordered checks (§113)", () => {
    const { plan } = planned([rehomeBehavior(STATUS, "@p/store", "@p/core")]);
    const location = plan.verification.find(
      (v) => v.kind === "verify-symbol-location"
    );
    expect(location?.scope).toEqual([
      "packages/store/src/status-factory.ts#okStatus",
    ]);
    expect(location?.expected).toBe("packages/core/src/status.ts");
    expect(plan.verification.map((v) => v.kind)).toContain("analyze-workspace");
    const typecheck = plan.verification.find((v) => v.kind === "typecheck");
    const tests = plan.verification.find((v) => v.kind === "tests");
    expect(typecheck?.scope).toEqual(["@p/core", "@p/store"]);
    expect(tests?.dependsOn).toEqual([typecheck?.id]);
    expect(plan.verification.every((v) => v.scope.length > 0)).toBe(true);
  });

  it("orders transformations as a DAG: create, move, expose, redirect, then remove (§38, §114)", () => {
    const { plan, validation } = planned([open(rehome(TOKEN, "@p/core"))]);
    expect(validation.cycles).toEqual([]);
    const position = new Map(plan.transformations.map((t, i) => [t.kind, i]));
    expect(position.get("move-module")).toBeLessThan(
      position.get("add-export") ?? -1
    );
    expect(position.get("add-export")).toBeLessThan(
      position.get("rewrite-import") ?? -1
    );
    expect(position.get("rewrite-import")).toBeLessThan(
      position.get("rewrite-reexport") ?? -1
    );
    for (const d of plan.dependencies) {
      expect(plan.transformations.some((t) => t.id === d.before)).toBe(true);
      expect(plan.transformations.some((t) => t.id === d.after)).toBe(true);
    }
  });

  it("blocks when two actions rewrite one import toward different packages (§74, §115)", () => {
    const { plan } = planned([
      open(rehome(TOKEN, "@p/core")),
      {
        ...open(rehome(TOKEN, "@p/app")),
        id: "operator:rehome-concept:token:app",
      },
    ]);
    expect(plan.status).toBe("blocked");
    const conflictKinds = plan.conflicts.map((c) => c.kind);
    expect(conflictKinds).toContain("import-rewrite-conflict");
    expect(conflictKinds).toContain("same-symbol-multiple-destinations");
    const same = plan.conflicts.find(
      (c) => c.kind === "same-symbol-multiple-destinations"
    );
    expect(same?.entities).toEqual([TOKEN]);
    expect(same?.transformations.length).toBe(2);
  });
});

describe("composition (§72–73, §127)", () => {
  it("dedupes the old-exposure removal between the relocation and the internalize operator", () => {
    const { plan, composition } = planned([
      open(rehome(TOKEN, "@p/core")),
      internalize(TOKEN, "@p/store"),
    ]);
    expect(composition.status).toBe("partial");
    expect(plan.status).toBe("ready");
    expect(plan.relocations[0]?.strategy).toBe("target-public-old-internal");
    const removals = ofKind(plan, "rewrite-reexport");
    expect(removals).toHaveLength(1);
    expect(removals[0]?.actions.some((a) => a.includes("internalize"))).toBe(
      true
    );
    for (const rewrite of ofKind(plan, "rewrite-import")) {
      expect(plan.dependencies).toContainEqual(
        expect.objectContaining({
          after: removals[0]?.id,
          before: rewrite.id,
          kind: "preserve-before-remove",
        })
      );
    }
  });

  it("carries a composition conflict into a blocked plan", () => {
    const { plan, composition } = planned([
      rehome(TOKEN, "@p/core"),
      internalize(TOKEN, "@p/store"),
    ]);
    expect(composition.status).toBe("conflicted");
    expect(plan.status).toBe("blocked");
    expect(plan.blockers.every((b) => b.kind === "composition-conflict")).toBe(
      true
    );
  });

  it("realizes an inward redirect through the move that carries it", () => {
    const { plan } = planned([rehomeBehavior(SHAPE, "@p/store", "@p/core")]);
    const move = ofKind(plan, "move-symbol")[0];
    expect(move?.actions.some((a) => a.includes("redirect-concept"))).toBe(
      true
    );
    expect(plan.realizations.every((r) => r.status === "realized")).toBe(true);
  });
});

describe("identity, serialization, API (§78–84, §116–117)", () => {
  it("yields the same plan under input reordering (§116)", () => {
    const ops = [
      open(rehome(TOKEN, "@p/core")),
      internalize(TOKEN, "@p/store"),
    ];
    const a = planned(ops).plan;
    const b = planned([...ops].reverse()).plan;
    expect(b.id).toBe(a.id);
    expect(JSON.stringify(b.transformations)).toBe(
      JSON.stringify(a.transformations)
    );
    expect(JSON.stringify(b.dependencies)).toBe(JSON.stringify(a.dependencies));
  });

  it("round-trips through JSON and validates (§117)", () => {
    const { plan, composition, operators } = planned([
      rehome(TOKEN, "@p/core"),
    ]);
    const revived = JSON.parse(JSON.stringify(plan)) as OperatorExecutionPlan;
    expect(revived).toEqual(plan);
    expect(
      validateOperatorExecutionPlan(
        revived,
        composition,
        operators,
        context,
        facts
      ).status
    ).toBe("valid");
    expect(plan.schemaVersion).toBe(OPERATOR_PLAN_SCHEMA_VERSION);
    expect(plan.policyVersion).toBe(OPERATOR_PLANNING_POLICY_VERSION);
  });

  it("gives transformations content ids, never plan-prefixed ones (§78)", () => {
    const { plan } = planned([rehome(TOKEN, "@p/core")]);
    for (const t of plan.transformations) {
      expect(t.id).toMatch(/^transformation:[0-9a-f]{16}$/);
      expect(t.id).not.toContain(plan.id);
    }
    expect(plan.id).toMatch(/^plan:[0-9a-f]{16}$/);
  });

  it("reports a tampered record as invalid", () => {
    const { plan, composition, operators } = planned([
      rehome(TOKEN, "@p/core"),
    ]);
    const tampered = {
      ...plan,
      transformations: plan.transformations.slice(1),
    };
    const validation = validateOperatorExecutionPlan(
      tampered,
      composition,
      operators,
      context,
      facts
    );
    expect(validation.status).toBe("invalid");
    expect(validation.problems.some((p) => p.includes("transformations"))).toBe(
      true
    );
  });

  it("plans one operator through the same path as a composition (§84)", () => {
    const operator = rehome(TOKEN, "@p/core");
    const single = planArchitecturalOperator(
      operator,
      decomposeArchitecturalOperator(operator, facts),
      context,
      facts
    );
    expect(single.id).toBe(planned([operator]).plan.id);
  });

  it("renders the plan as text", () => {
    const { plan, validation } = planned([rehome(TOKEN, "@p/core")]);
    const text = renderOperatorExecutionPlan(plan, validation);
    expect(text).toContain("OPERATOR PLAN");
    expect(text).toContain("[1] move-module (required)");
    expect(text).toContain("Blockers\n  none");
    expect(text).toContain("valid");
  });
});

describe("guarantees (§37, §87, §118–119)", () => {
  const sources = [
    "operator-plan.ts",
    "operator-plan-source.ts",
    "operator-planning-context.ts",
    "operator-plan-types.ts",
    "report-plan.ts",
  ].map((f) => path.join(import.meta.dirname, "../../src/lib", f));

  it("never calls a write or an AST manipulation (§87)", () => {
    const forbidden =
      /\b(writeFile|writeFileSync|appendFile|renameSync|rename\(|unlink|rmSync|mkdirSync|\.save\(|saveSync|insertText|addImportDeclaration|addExportDeclaration|setIsExported|replaceWithText|\.remove\(|applyReductionPlan|from "\.\/apply")/;
    for (const file of sources) {
      const text = fs.readFileSync(file, "utf8");
      expect(text, file).not.toMatch(forbidden);
    }
  });

  it("carries no score, effort, rank, or priority", () => {
    const { plan } = planned([
      open(rehome(TOKEN, "@p/core")),
      internalize(TOKEN, "@p/store"),
    ]);
    const keys = new Set<string>();
    const walk = (value: unknown) => {
      if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (value !== null && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
          keys.add(k);
          walk(v);
        }
      }
    };
    walk(plan);
    for (const key of keys) {
      expect(key).not.toMatch(
        /^(score|priority|rank|effort|cost|risk|apply|execute|write|patch|edits?|ast|line|column|replacement)$/i
      );
    }
    expect(JSON.stringify(plan)).not.toMatch(
      /should |recommend|optimi[sz]|effort/
    );
  });
});
