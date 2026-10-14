import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeSurface } from "../../src/lib/analyze";
import { applyReductionPlan } from "../../src/lib/apply";
import { createOperatorContext } from "../../src/lib/architectural-operator";
import { executionPlanFor } from "../../src/lib/execution-plan";
import { composeArchitecturalOperators } from "../../src/lib/operator-composition";
import { decomposeArchitecturalOperator } from "../../src/lib/operator-decomposition";
import { planOperatorComposition } from "../../src/lib/operator-plan";
import type { OperatorPlanningContext } from "../../src/lib/operator-planning-context";
import { createOperatorPlanningContext } from "../../src/lib/operator-planning-context";
import type { ReadinessCommandRunner } from "../../src/lib/operator-readiness";
import { authorizeMutationPlan } from "../../src/lib/operator-readiness";
import type { OperatorContext } from "../../src/lib/operator-types";
import type { InternalizeSymbolPlan, SurfaceReport } from "../../src/lib/types";
import { ingestWorkspaceReports } from "../../src/lib/workspace-ingest";
import { analyzeWorkspace } from "../../src/lib/workspace-intelligence";
import { createWorkspaceProjectionContext } from "../../src/lib/workspace-projection";
import { importerFixture, PACKAGE } from "./helpers/importer-fixture";
import { internalizeOperator, planningRoot } from "./helpers/planning-fixture";

// The package's own importers of an entrypoint (3.8 (a)): which ones a plan
// repoints, which ones block it, and that the operator side agrees.

const INDEX = "packages/a/src/index.ts";
const MODEL = "packages/a/src/model.ts";
const SUB = "packages/a/src/sub.ts";
const USER = "packages/a/src/user.ts";
const JS_USER = "packages/a/src/js-user.ts";

const SHAPES = {
  "src/hidden.ts":
    "function hidden(): number {\n  return 1;\n}\nexport { hidden as shown };\n",
  "src/index.ts": [
    'export { make } from "./model";',
    'export { split, kept } from "./model";',
    'export type { Shape } from "./model";',
    'export type { Inline } from "./model";',
    'export { aliased } from "./model";',
    'export { renamedSource as renamed } from "./model";',
    'export { viaPackage } from "./model";',
    'export { defaulted as default } from "./model";',
    'export { reexported } from "./model";',
    'export { tested } from "./model";',
    'export { mixed } from "./model";',
    'export { beside } from "./model";',
    'export { untouched } from "./model";',
    'export { already } from "./model";',
    'export { ownName } from "./own";',
    'export { shown } from "./hidden";',
    'export { subDirect } from "./sub";',
    "export function direct(): number {\n  return 0;\n}",
    "",
  ].join("\n"),
  "src/js-user.ts": [
    'import { make } from "./index.js";',
    'import { subMarker } from "./sub.js";',
    "",
    "export const jsUse = make() + subMarker;",
    "",
  ].join("\n"),
  "src/model.ts": [
    "make",
    "split",
    "kept",
    "aliased",
    "renamedSource",
    "viaPackage",
    "viaSubpath",
    "defaulted",
    "reexported",
    "tested",
    "mixed",
    "beside",
    "untouched",
    "already",
    "neighbour",
  ]
    .map(
      (name, i) => `export function ${name}(): number {\n  return ${i};\n}\n`
    )
    .concat(
      "export interface Shape {\n  id: string;\n}\n",
      "export interface Inline {\n  id: string;\n}\n"
    )
    .join(""),
  "src/own.ts": [
    'import { ownName as viaEntry } from "./index";',
    "",
    "export function ownName(): number {\n  return 1;\n}",
    "",
    "export function callOwn(): number {\n  return viaEntry();\n}",
    "",
  ].join("\n"),
  "src/relay.ts": 'export { reexported, mixed } from "./index";\n',
  "src/sub.ts": [
    'export { viaSubpath } from "./model";',
    "export const subMarker = 1;",
    "export function subDirect(): number {\n  return 2;\n}",
    "",
  ].join("\n"),
  "src/user.ts": [
    'import "./index";',
    'import theDefault, { make } from "./index";',
    'import { split, kept } from "./index";',
    'import type { Shape } from "./index";',
    'import { type Inline } from "./index";',
    'import { aliased as localAlias } from "./index";',
    'import { renamed } from "./index";',
    `import { viaPackage } from "${PACKAGE}";`,
    `import { viaSubpath } from "${PACKAGE}/sub";`,
    'import { direct } from "./index";',
    'import { beside } from "./index";',
    'import { already } from "./index";',
    'import { neighbour } from "./model";',
    'import { shown } from "./index";',
    'import { subDirect } from "./index";',
    "",
    "export function use(shape: Shape, inline: Inline): number {",
    "  return (",
    "    theDefault() + make() + split() + kept() + localAlias() + renamed() +",
    "    viaPackage() + viaSubpath() + direct() + beside() + already() +",
    "    neighbour() + shown() + subDirect() + shape.id.length + inline.id.length",
    "  );",
    "}",
    "",
  ].join("\n"),
  "test/tested.test.ts": [
    'import { mixed, tested } from "../src/index";',
    "",
    "export const results = [tested(), mixed()];",
    "",
  ].join("\n"),
};

const roots: string[] = [];

function fixture(files: Record<string, string>): string {
  const root = importerFixture(files);
  roots.push(root);
  return root;
}

function analyze(root: string): Promise<SurfaceReport> {
  return analyzeSurface({ root, target: PACKAGE });
}

function planFor(report: SurfaceReport, name: string): InternalizeSymbolPlan {
  const plan = report.plans.find(
    (entry): entry is InternalizeSymbolPlan =>
      entry.operation === "internalize-symbol" && entry.subject.name === name
  );
  if (plan === undefined) {
    throw new Error(`No plan for ${name}`);
  }
  return plan;
}

const reasons = (plan: InternalizeSymbolPlan) =>
  [...new Set(plan.blockers.map((blocker) => blocker.reason))].sort();
const changes = (plan: InternalizeSymbolPlan) =>
  plan.plannedChanges.map((change) => `${change.kind} ${change.file}`);
const rewrite = (name: string, file: string, binding = name) => ({
  description: `Import ${binding} from ${MODEL} instead of the entrypoint ${file}.`,
  kind: "rewrite-import",
});

let shapesRoot: string;
let shapes: SurfaceReport;

beforeAll(async () => {
  shapesRoot = fixture(SHAPES);
  shapes = await analyze(shapesRoot);
});

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("plans that repoint the package's own importers", () => {
  it("repoints a named import before the re-export goes", () => {
    const plan = planFor(shapes, "make");
    expect(plan.status).toBe("ready");
    expect(plan.blockers).toEqual([]);
    expect(plan.plannedChanges).toEqual([
      {
        description: 'Remove the statement: export { make } from "./model";',
        file: INDEX,
        kind: "remove-public-export",
      },
      { ...rewrite("make", INDEX), file: JS_USER },
      { ...rewrite("make", INDEX), file: USER },
    ]);
    expect(plan.preservedBehavior).toEqual([
      `Declaration remains in ${MODEL}`,
      `${JS_USER}, ${USER} import make from ${MODEL} instead of the entrypoint`,
      "Other internal imports and references remain unchanged",
      "Internal module exports remain unchanged",
      "Runtime behavior unchanged",
    ]);
    expect(plan.predictedDelta.exportedSymbols).toBe(-1);
  });

  it("repoints a name that shares its import with others, which a split keeps", () => {
    const plan = planFor(shapes, "split");
    expect(plan.status).toBe("ready");
    expect(changes(plan)).toEqual([
      `rewrite-public-export ${INDEX}`,
      `rewrite-import ${USER}`,
    ]);
  });

  it("repoints type imports, inline type specifiers, and aliased imports", () => {
    for (const name of ["Shape", "Inline", "aliased"]) {
      const plan = planFor(shapes, name);
      expect(plan.status, name).toBe("ready");
      expect(changes(plan), name).toEqual([
        `remove-public-export ${INDEX}`,
        `rewrite-import ${USER}`,
      ]);
    }
  });

  it("names the declaration when the entrypoint exposes it under an alias", () => {
    const plan = planFor(shapes, "renamedSource");
    expect(plan.status).toBe("ready");
    expect(plan.plannedChanges).toContainEqual({
      ...rewrite("renamed", INDEX, "renamedSource (exposed as renamed)"),
      file: USER,
    });
  });

  it("repoints importers however the specifier is spelled: package, subpath, relative, .js", () => {
    expect(planFor(shapes, "viaPackage").plannedChanges).toContainEqual({
      ...rewrite("viaPackage", INDEX),
      file: USER,
    });
    const subpath = planFor(shapes, "viaSubpath");
    expect(subpath.status).toBe("ready");
    expect(subpath.plannedChanges).toEqual([
      {
        description:
          'Remove the statement: export { viaSubpath } from "./model";',
        file: SUB,
        kind: "remove-public-export",
      },
      { ...rewrite("viaSubpath", SUB), file: USER },
    ]);
    expect(changes(planFor(shapes, "make"))).toContain(
      `rewrite-import ${JS_USER}`
    );
  });

  it("leaves a side-effect import beside the repointed one out of the plan", () => {
    const plan = planFor(shapes, "beside");
    expect(plan.status).toBe("ready");
    expect(changes(plan)).toEqual([
      `remove-public-export ${INDEX}`,
      `rewrite-import ${USER}`,
    ]);
  });

  it("keeps a plan without internal importers as it was", () => {
    const plan = planFor(shapes, "untouched");
    expect(plan.status).toBe("ready");
    expect(changes(plan)).toEqual([`remove-public-export ${INDEX}`]);
    expect(plan.preservedBehavior).toContain(
      "Internal imports and references remain unchanged"
    );
  });
});

describe("importers a plan cannot repoint", () => {
  const blocked = (name: string) => {
    const plan = planFor(shapes, name);
    expect(plan.status, name).toBe("unsupported");
    expect(plan.predictedDelta.exportedSymbols, name).toBe(0);
    return plan;
  };

  it("blocks a default import", () => {
    const plan = blocked("defaulted");
    expect(plan.blockers).toEqual([
      {
        detail: `${USER} default-imports default from the entrypoint ${INDEX}; only named imports are repointed.`,
        reason: "internal-entrypoint-import",
      },
    ]);
  });

  it("blocks a re-export of the entrypoint inside the package", () => {
    expect(blocked("reexported").blockers).toEqual([
      {
        detail: `packages/a/src/relay.ts re-exports reexported from the entrypoint ${INDEX}; re-exports inside the package are not repointed.`,
        reason: "internal-entrypoint-import",
      },
    ]);
  });

  it("blocks the declaration file importing its own symbol from the entrypoint", () => {
    expect(blocked("ownName").blockers).toEqual([
      {
        detail: `packages/a/src/own.ts declares ownName and imports ownName from the entrypoint ${INDEX}; it cannot import the symbol from itself.`,
        reason: "internal-entrypoint-import",
      },
    ]);
  });

  it("blocks a declaration file that does not export the symbol under its own name", () => {
    expect(reasons(blocked("hidden"))).toEqual(["internal-entrypoint-import"]);
    expect(planFor(shapes, "hidden").blockers[0]?.detail).toContain(
      "does not export hidden under that name"
    );
  });

  it("blocks a re-export of a declaration whose own entrypoint export the plan removes", () => {
    const plan = blocked("subDirect");
    expect(plan.blockers).toEqual([
      {
        detail: `${SUB} is itself an entrypoint declaring subDirect, and the plan removes that export, so the importers of subDirect cannot import it from there.`,
        reason: "internal-entrypoint-import",
      },
    ]);
  });

  it("gives tests their own reason when they are the only obstacle", () => {
    expect(blocked("tested").blockers).toEqual([
      {
        detail: `tested is imported from the entrypoint ${INDEX} by the test packages/a/test/tested.test.ts; repointing a test at ${MODEL} would keep it passing while it no longer checks the entrypoint.`,
        reason: "internal-entrypoint-test-import",
      },
    ]);
    expect(reasons(blocked("mixed"))).toEqual(["internal-entrypoint-import"]);
  });

  it("keeps a direct declaration's gate as it was", () => {
    expect(blocked("direct").blockers).toEqual([
      {
        detail:
          "direct is imported from the entrypoint by other modules in the package; removing its public export would break them.",
        reason: "internal-entrypoint-import",
      },
    ]);
  });
});

describe("the whole entrypoint used inside the package", () => {
  const ENTRY = {
    "src/index.ts":
      'export { make } from "./model";\nexport function direct(): number {\n  return 0;\n}\n',
    "src/model.ts": "export function make(): number {\n  return 1;\n}\n",
  };

  it("blocks every route when a module star re-exports the entrypoint", async () => {
    const report = await analyze(
      fixture({ ...ENTRY, "src/relay.ts": 'export * from "./index";\n' })
    );
    for (const name of ["make", "direct"]) {
      expect(planFor(report, name).status, name).toBe("unsupported");
      expect(planFor(report, name).blockers, name).toEqual([
        {
          detail: `packages/a/src/relay.ts re-exports everything from the entrypoint ${INDEX}; removing ${name} would break their importers.`,
          reason: "internal-entrypoint-import",
        },
      ]);
    }
  });

  it("blocks every route when a module re-exports the entrypoint as a namespace", async () => {
    const report = await analyze(
      fixture({ ...ENTRY, "src/relay.ts": 'export * as all from "./index";\n' })
    );
    expect(reasons(planFor(report, "make"))).toEqual([
      "internal-entrypoint-import",
    ]);
    expect(reasons(planFor(report, "direct"))).toEqual([
      "internal-entrypoint-import",
    ]);
  });

  it("keeps a namespace import's own reason", async () => {
    const report = await analyze(
      fixture({
        ...ENTRY,
        "src/user.ts":
          'import * as all from "./index";\n\nexport const used = all.make();\n',
      })
    );
    expect(reasons(planFor(report, "make"))).toEqual(["namespace-import"]);
  });
});

describe("analysis stability", () => {
  it("fingerprints every plan alike across two analyses", async () => {
    const again = await analyze(shapesRoot);
    const fingerprints = (report: SurfaceReport) =>
      Object.fromEntries(
        report.plans.map((plan) => [
          plan.id,
          `${plan.status} ${plan.fingerprint}`,
        ])
      );
    expect(fingerprints(again)).toEqual(fingerprints(shapes));
  });

  it("plans every deps fixture symbol as before 3.8, fingerprint for fingerprint", async () => {
    const root = join(import.meta.dirname, "fixtures", "deps");
    const targets = [
      "@deps/plans",
      "@deps/plans-multi",
      "@deps/plans-pub",
      "@deps/plans-star",
      "@deps/plans-wild",
      "@deps/satellite",
      "@deps/shared",
    ];
    const reports = await Promise.all(
      targets.map((target) => analyzeSurface({ root, target }))
    );
    const planned = Object.fromEntries(
      reports.flatMap((report) =>
        report.plans.flatMap((plan) =>
          plan.operation === "internalize-symbol"
            ? [[plan.subject.id, `${plan.status} ${plan.fingerprint}`]]
            : []
        )
      )
    );
    // Computed at 461822b, before the importer scan: unchanged by it.
    expect(planned).toEqual({
      "packages/plans-multi/src/core.ts#PlanShared": "ready 7fdf76015a1dde18",
      "packages/plans-multi/src/extra.ts#PlanExtraOnly":
        "ready 0e18f84c1841ad0b",
      "packages/plans-pub/src/index.ts#PlanPublic": "blocked 73799944a8465bdb",
      "packages/plans-star/src/hidden.ts#PlanHidden":
        "unsupported 0833caa455cbf4b6",
      "packages/plans-wild/src/index.ts#PlanWild":
        "unsupported 63bbe19149c0068f",
      "packages/plans/src/bar.ts#PlanBeta": "ready 19ac6cada8c9c9b5",
      "packages/plans/src/bar.ts#PlanBetaExtra": "ready a02c207b67171a2e",
      "packages/plans/src/deep.ts#PlanChained": "ready 9807498486218e54",
      "packages/plans/src/foo.ts#PlanAlpha": "ready 58d232897d2dd876",
      "packages/plans/src/index.ts#PlanDirect": "ready 7a03ff513dd37788",
      "packages/plans/src/index.ts#PlanDirectUsed":
        "unsupported 1c63ddd07e870ff4",
      "packages/satellite/src/index.ts#recalibrate": "ready 1cb2cb2e29fe244a",
    });
  });
});

describe("the planning fixture's helperOnly", () => {
  it("is ready now, repointing the importer the operator side always rewrote", async () => {
    const report = await analyzeSurface({
      root: planningRoot,
      target: "@p/core",
      tsconfig: "tsconfig.json",
    });
    // Unsupported (internal-entrypoint-import) before 3.8; operator-plan.test
    // plans the same two files, the importer's specifier "@p/core" → "./helper".
    expect(planFor(report, "helperOnly").plannedChanges).toEqual([
      {
        description:
          'Remove the statement: export { helperOnly } from "./helper";',
        file: "packages/core/src/index.ts",
        kind: "remove-public-export",
      },
      {
        description:
          "Import helperOnly from packages/core/src/helper.ts instead of the entrypoint packages/core/src/index.ts.",
        file: "packages/core/src/internal-user.ts",
        kind: "rewrite-import",
      },
    ]);
    expect(planFor(report, "helperOnly").status).toBe("ready");
  });
});

describe("plan scale", () => {
  it("counts the importers a plan repoints", async () => {
    const plan = planFor(shapes, "make");
    const { intelligence } = plan;
    expect(intelligence?.scale.files).toEqual({
      config: 0,
      other: 0,
      source: 3,
      test: 0,
      total: 3,
    });
    expect(intelligence?.scale.imports).toEqual({ moduleEdges: 2, sites: 2 });
    const untouched = planFor(shapes, "untouched").intelligence;
    expect(untouched?.scale.imports).toEqual({ moduleEdges: 0, sites: 0 });
    expect(untouched?.scale.files.total).toBe(1);
  });
});

describe("the operator side", () => {
  let planning: OperatorPlanningContext;
  let facts: OperatorContext;

  beforeAll(() => {
    planning = createOperatorPlanningContext({ root: shapesRoot });
    facts = createOperatorContext(
      createWorkspaceProjectionContext(
        analyzeWorkspace(ingestWorkspaceReports([shapes], { root: "shapes" }))
      ),
      [shapes]
    );
  });

  const executionOf = (name: string) =>
    executionPlanFor(facts, planning, planFor(shapes, name).id);
  /** A manual operator: a saved plan that is not ready plans nothing. */
  const manual = (name: string, file: string) => {
    const operator = internalizeOperator(`${file}#${name}`, PACKAGE);
    const composition = composeArchitecturalOperators(
      [operator],
      [decomposeArchitecturalOperator(operator, facts)],
      facts
    );
    return {
      plan: planOperatorComposition(composition, [operator], planning, facts),
    };
  };
  const rewrites = (name: string) =>
    executionOf(name).plan.transformations.filter(
      (t) => t.kind === "rewrite-import" || t.kind === "update-test-import"
    );

  it("rewrites the same importers, relative ones included, in each importer's own style", () => {
    expect(
      rewrites("make").map((t) => `${t.file} ${t.after?.specifier}`)
    ).toEqual([`${JS_USER} ./model.js`, `${USER} ./model`]);
    expect(
      rewrites("viaPackage").map(
        (t) => `${t.before?.specifier} → ${t.after?.specifier}`
      )
    ).toEqual([`${PACKAGE} → ./model`]);
    expect(
      rewrites("viaSubpath").map(
        (t) => `${t.before?.specifier} → ${t.after?.specifier}`
      )
    ).toEqual([`${PACKAGE}/sub → ./model`]);
  });

  it("blocks a re-export of the entrypoint inside the package", () => {
    const { plan } = manual("reexported", MODEL);
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({
        entities: ["packages/a/src/relay.ts"],
        kind: "unsupported-realization",
      })
    );
  });

  it("blocks a direct route only for its own importers", () => {
    expect(manual("direct", INDEX).plan.blockers).toEqual([
      expect.objectContaining({
        entities: [INDEX],
        kind: "unsupported-realization",
      }),
    ]);
    expect(manual("subDirect", SUB).plan.blockers).toEqual([
      expect.objectContaining({
        entities: [USER],
        kind: "unsupported-realization",
      }),
    ]);
    expect(manual("untouched", MODEL).plan.blockers).toEqual([]);
  });

  it("passes import rewrites to readiness under the package's permit", () => {
    const { composition, operators, plan } = executionOf("make");
    const pass: ReadinessCommandRunner = () => ({ exitCode: 0, output: "" });
    const authorized = authorizeMutationPlan(
      plan,
      { composition, facts, git: false, operators, planning, runner: pass },
      [{ effect: "permit", operator: "internalize", subject: "packages/a" }]
    );
    expect(authorized.kind).toBe("readiness");
    if (authorized.kind === "readiness") {
      expect(
        authorized.readiness.realizability.mutationCapabilities.every(
          (capability) => capability.supported
        )
      ).toBe(true);
      expect(
        authorized.readiness.blockers.map((blocker) => blocker.kind)
      ).toEqual(["verification-incomplete"]);
    }
  });

  it("rewrites a site once when one entrypoint exposes the symbol under two names", async () => {
    const root = fixture({
      "src/index.ts": 'export { make, make as build } from "./model";\n',
      "src/model.ts": "export function make(): number {\n  return 1;\n}\n",
      "src/user.ts":
        'import { make } from "./index";\n\nexport const used = make();\n',
    });
    const report = await analyze(root);
    const plan = planFor(report, "make");
    expect(plan.status).toBe("ready");
    expect(changes(plan)).toEqual([
      `rewrite-public-export ${INDEX}`,
      `rewrite-public-export ${INDEX}`,
      `rewrite-import ${USER}`,
    ]);
    const twice = executionPlanFor(
      createOperatorContext(
        createWorkspaceProjectionContext(
          analyzeWorkspace(ingestWorkspaceReports([report], { root: "twice" }))
        ),
        [report]
      ),
      createOperatorPlanningContext({ root }),
      plan.id
    );
    expect(
      twice.plan.transformations
        .filter((t) => t.kind === "rewrite-import")
        .map((t) => t.file)
    ).toEqual([USER]);
  });
});

describe("apply with internal import rewrites", () => {
  it("previews the route and both importer files without writing", async () => {
    const plan = planFor(shapes, "make");
    const original = [INDEX, USER, JS_USER].map((file) =>
      readFileSync(join(shapesRoot, file))
    );
    const result = await applyReductionPlan(plan, {
      before: shapes,
      root: shapesRoot,
    });
    expect(result.status).toBe("preview");
    expect(result.changedFiles).toEqual([INDEX, JS_USER, USER]);
    expect(result.edits?.map((edit) => edit.file)).toEqual([
      JS_USER,
      USER,
      INDEX,
    ]);
    expect(
      [INDEX, USER, JS_USER].map((file) => readFileSync(join(shapesRoot, file)))
    ).toEqual(original);
  });
});
