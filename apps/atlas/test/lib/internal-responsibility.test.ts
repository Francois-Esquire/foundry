import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";
import {
  analyzeInternalResponsibilities,
  getModuleResponsibility,
  getRegionsByConcept,
  getRegionsByPath,
  getResponsibilityRegion,
  getResponsibilityRelationship,
} from "../../src/lib/internal-responsibility";
import type {
  InternalResponsibilityReport,
  ResponsibilityRegion,
} from "../../src/lib/internal-responsibility-types";
import { INTERNAL_RESPONSIBILITY_SCHEMA_VERSION } from "../../src/lib/internal-responsibility-types";
import { analyzeInternalPackageTopology } from "../../src/lib/internal-topology";
import { analyzePackageLocal } from "../../src/lib/package-local";
import { renderInternalResponsibilities } from "../../src/lib/report-responsibility";
import { analyzeSymbolLocality } from "../../src/lib/symbol-locality";

// V13.2 responsibility regions on synthetic packages. Each fixture is one
// package in a throwaway workspace; the high-fan cutoff floors at 3, so a
// symbol with two consumers is localized and a module with three dependents
// is a connector.

const tempRoots: string[] = [];

afterAll(() => {
  for (const dir of tempRoots) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

function workspace(
  files: Record<string, string>,
  extra: Record<string, string> = {}
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "responsibility-"));
  const root = fs.realpathSync(dir);
  tempRoots.push(root);
  const write = (file: string, text: string) => {
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  };
  write(
    "package.json",
    JSON.stringify({ name: "root", workspaces: ["packages/*"] })
  );
  write(
    "packages/p/package.json",
    JSON.stringify({ exports: { ".": "./src/index.ts" }, name: "@f/p" })
  );
  for (const [file, text] of Object.entries(files)) {
    write(path.join("packages/p", file), text);
  }
  for (const [file, text] of Object.entries(extra)) {
    write(file, text);
  }
  return root;
}

function derive(root: string): InternalResponsibilityReport {
  const local = analyzePackageLocal({ root, target: "packages/p" });
  const topology = analyzeInternalPackageTopology(local);
  const locality = analyzeSymbolLocality(local, topology);
  return analyzeInternalResponsibilities(local, topology, locality);
}

function responsibilitiesOf(
  files: Record<string, string>,
  extra?: Record<string, string>
): InternalResponsibilityReport {
  return derive(workspace(files, extra));
}

/** `import { names } from "<relative>"` from one package-relative file to another. */
function importOf(from: string, to: string, names: string): string {
  let specifier = path.posix.relative(
    path.posix.dirname(from),
    to.replace(/\.tsx?$/, "")
  );
  if (!specifier.startsWith(".")) {
    specifier = `./${specifier}`;
  }
  return `import { ${names} } from "${specifier}";\n`;
}

function regionOf(
  report: InternalResponsibilityReport,
  module: string
): ResponsibilityRegion {
  const evidence = getModuleResponsibility(report, module);
  if (evidence?.region === undefined) {
    throw new Error(`unplaced: ${module}`);
  }
  const region = getResponsibilityRegion(report, evidence.region);
  if (region === undefined) {
    throw new Error(`no region: ${evidence.region}`);
  }
  return region;
}

const CONCEPT = (name: string) =>
  `export interface ${name} { id: string }\nexport function make${name}(id: string): ${name} { return { id }; }\n`;
const USES = (name: string, from: string, at: string) =>
  `${importOf(at, from, name)}export function use${name.toLowerCase()}(value: ${name}): string { return value.id; }\n`;

describe("perfect path region", () => {
  const report = responsibilitiesOf({
    "src/canvas/a.ts": CONCEPT("Canvas"),
    "src/canvas/b.ts": USES("Canvas", "src/canvas/a.ts", "src/canvas/b.ts"),
    "src/canvas/c.ts": USES("Canvas", "src/canvas/a.ts", "src/canvas/c.ts"),
  });

  it("has the schema version and package identity", () => {
    expect(report.schemaVersion).toBe(INTERNAL_RESPONSIBILITY_SCHEMA_VERSION);
    expect(report.package).toEqual({ id: "@f/p", root: "packages/p" });
  });

  it("is one responsibility matching the canvas path region", () => {
    expect(report.regions).toHaveLength(1);
    const [region] = report.regions;
    expect(region?.modules).toEqual([
      "src/canvas/a.ts",
      "src/canvas/b.ts",
      "src/canvas/c.ts",
    ]);
    expect(region?.path.agreement).toBe("matches-path-region");
    expect(region?.label).toBe("src/canvas");
    expect(region?.labelBasis).toBe("directory");
    expect(region?.construction.joinsByReason).toEqual({
      "concept-flow": 2,
      "directory-dependency": 2,
      "directory-fallback": 0,
    });
    expect(region?.evidence).toEqual([
      "path",
      "dependency",
      "concept",
      "behavior",
      "symbol-flow",
    ]);
    expect(region?.concepts.declared[0]).toMatchObject({
      modules: 2,
      name: "Canvas",
      relationships: ["parameter-type"],
    });
    expect(report.summary.unresolvedModules).toBe(0);
    expect(report.summary.byPathAgreement["matches-path-region"]).toBe(1);
  });
});

describe("one path region holding two responsibilities", () => {
  const report = responsibilitiesOf({
    "src/app/featureA/a1.ts": CONCEPT("Alpha"),
    "src/app/featureA/a2.ts": USES(
      "Alpha",
      "src/app/featureA/a1.ts",
      "src/app/featureA/a2.ts"
    ),
    "src/app/featureB/b1.ts": CONCEPT("Beta"),
    "src/app/featureB/b2.ts": USES(
      "Beta",
      "src/app/featureB/b1.ts",
      "src/app/featureB/b2.ts"
    ),
  });

  it("splits the path region without a relationship between the halves", () => {
    expect(report.regions.map((r) => r.label)).toEqual([
      "src/app/featureA",
      "src/app/featureB",
    ]);
    expect(
      report.regions.every((r) => r.path.agreement === "within-path-region")
    ).toBe(true);
    expect(report.summary.pathRegionsSplit).toBe(1);
    expect(report.relationships).toEqual([]);
  });
});

describe("one responsibility spanning directories", () => {
  const report = responsibilitiesOf({
    "src/editor/e.ts": CONCEPT("Editor"),
    "src/preview/p.ts": USES("Editor", "src/editor/e.ts", "src/preview/p.ts"),
    "src/preview/q.ts": USES("Editor", "src/editor/e.ts", "src/preview/q.ts"),
  });

  it("joins on concept flow into the neighboring path region", () => {
    expect(report.regions).toHaveLength(1);
    const [region] = report.regions;
    expect(region?.path.pathRegions).toEqual(["editor", "preview"]);
    expect(region?.path.agreement).toBe("spans-path-regions");
    expect(region?.label).toBe("Editor");
    expect(region?.labelBasis).toBe("concept");
    expect(region?.construction.joinsByReason["concept-flow"]).toBe(2);
    expect(region?.construction.joinsByReason["directory-dependency"]).toBe(0);
    expect(report.summary.responsibilitiesSpanningPaths).toBe(1);
  });

  it("treats a concept split evenly between two path regions as a boundary, not a join", () => {
    const split = responsibilitiesOf({
      "src/editor/e.ts": CONCEPT("Editor"),
      "src/editor/f.ts": USES("Editor", "src/editor/e.ts", "src/editor/f.ts"),
      "src/preview/p.ts": USES("Editor", "src/editor/e.ts", "src/preview/p.ts"),
    });
    const editor = regionOf(split, "src/editor/e.ts");
    expect(editor.modules).toEqual(["src/editor/e.ts", "src/editor/f.ts"]);
    expect(editor.construction.joins[0]?.reasons).toEqual([
      "directory-fallback",
    ]);
    expect(regionOf(split, "src/preview/p.ts").modules).toEqual([
      "src/preview/p.ts",
    ]);
    expect(split.symbols.find((s) => s.name === "Editor")?.locality).toBe(
      "responsibility-crossing"
    );
    expect(
      getResponsibilityRelationship(
        split,
        regionOf(split, "src/preview/p.ts").id,
        regionOf(split, "src/editor/e.ts").id
      )
    ).toMatchObject({
      concepts: ["packages/p/src/editor/e.ts#Editor"],
      moduleEdges: 1,
    });
  });
});

describe("flat src", () => {
  const report = responsibilitiesOf({
    "src/a.ts": CONCEPT("Alpha"),
    "src/a2.ts": USES("Alpha", "src/a.ts", "src/a2.ts"),
    "src/b.ts": CONCEPT("Beta"),
    "src/b2.ts": USES("Beta", "src/b.ts", "src/b2.ts"),
    "src/c.ts": "export const c = 1;\n",
  });

  it("finds two concept neighborhoods and never groups the rest by the technical root", () => {
    expect(regionOf(report, "src/a.ts").modules).toEqual([
      "src/a.ts",
      "src/a2.ts",
    ]);
    expect(regionOf(report, "src/b.ts").modules).toEqual([
      "src/b.ts",
      "src/b2.ts",
    ]);
    const lone = regionOf(report, "src/c.ts");
    expect(lone.modules).toEqual(["src/c.ts"]);
    expect(lone.labelBasis).toBe("module");
    expect(lone.evidence).toEqual([]);
    expect(report.summary.joinsByReason["directory-fallback"]).toBe(0);
    expect(report.summary.regions).toBe(3);
  });
});

describe("cycles", () => {
  it("keeps a cycle together even when only functions cross", () => {
    const report = responsibilitiesOf({
      "src/x/a.ts":
        'import { fb } from "./b";\nexport function fa(): number { return fb() + 1; }\n',
      "src/x/b.ts":
        'import { fa } from "./a";\nexport function fb(): number { return 1; }\nexport function fc(): number { return fa(); }\n',
    });
    expect(report.regions).toHaveLength(1);
    expect(report.regions[0]?.units).toEqual(["cycle:cycle-1"]);
    expect(report.regions[0]?.evidence).toContain("cycle");
    expect(report.summary.cycleUnits).toBe(1);
  });

  it("does not split a cycle whose members reach two distinct concepts", () => {
    const report = responsibilitiesOf({
      "src/p/pa.ts": CONCEPT("PA"),
      "src/q/qb.ts": CONCEPT("QB"),
      "src/x/a.ts":
        'import { fb } from "./b";\n' +
        importOf("src/x/a.ts", "src/p/pa.ts", "PA") +
        "export function fa(value: PA): number { return fb() + value.id.length; }\n",
      "src/x/b.ts":
        'import { fa } from "./a";\n' +
        importOf("src/x/b.ts", "src/q/qb.ts", "QB") +
        "export function fb(): number { return 1; }\nexport function fc(value: QB): number { return fa({ id: value.id }); }\n",
    });
    expect(report.regions).toHaveLength(1);
    const [region] = report.regions;
    expect(region?.modules).toEqual([
      "src/p/pa.ts",
      "src/q/qb.ts",
      "src/x/a.ts",
      "src/x/b.ts",
    ]);
    expect(region?.concepts.declared.map((c) => c.name)).toEqual(["PA", "QB"]);
    expect(region?.evidence).toContain("cycle");
    expect(report.summary.regionsWithSeveralConcepts).toBe(1);
  });
});

/** Two concept regions in `a/` and `b/` plus whatever the caller adds. */
function twoRegions(extra: Record<string, string>): Record<string, string> {
  return {
    "src/a/a1.ts": CONCEPT("Alpha"),
    "src/a/a2.ts": USES("Alpha", "src/a/a1.ts", "src/a/a2.ts"),
    "src/b/b1.ts": CONCEPT("Beta"),
    "src/b/b2.ts": USES("Beta", "src/b/b1.ts", "src/b/b2.ts"),
    ...extra,
  };
}

describe("distributed primitive", () => {
  const cn = (at: string) =>
    `${importOf(at, "src/util.ts", "cn")}export const ${path.basename(at, ".ts")}Class = cn("x");\n`;
  const report = responsibilitiesOf(
    twoRegions({
      "src/a/a3.ts": cn("src/a/a3.ts"),
      "src/a/a4.ts": cn("src/a/a4.ts"),
      "src/b/b3.ts": cn("src/b/b3.ts"),
      "src/b/b4.ts": cn("src/b/b4.ts"),
      "src/util.ts":
        "export function cn(value: string): string { return value; }\n",
    })
  );

  it("never merges the regions it is consumed from", () => {
    expect(regionOf(report, "src/a/a1.ts").id).not.toBe(
      regionOf(report, "src/b/b1.ts").id
    );
    expect(report.unresolved).toHaveLength(1);
    expect(report.unresolved[0]).toMatchObject({
      module: "src/util.ts",
      reason: "distributed-primitive",
    });
    expect(report.unresolved[0]?.candidates).toHaveLength(2);
    expect(report.summary.unresolvedByReason["distributed-primitive"]).toBe(1);
    const symbol = report.symbols.find((s) => s.name === "cn");
    expect(symbol).toMatchObject({
      consumerModules: 4,
      locality: "unplaced",
    });
    expect(symbol?.consumerRegions).toHaveLength(2);
  });

  it("folds the untouched a3/a4 into the directory beside the concept region", () => {
    const a3 = getModuleResponsibility(report, "src/a/a3.ts");
    const a4 = getModuleResponsibility(report, "src/a/a4.ts");
    expect(a3?.region).toBe(a4?.region);
    expect(a3?.region).not.toBe(regionOf(report, "src/a/a1.ts").id);
    expect(regionOf(report, "src/a/a3.ts").construction.joinsByReason).toEqual({
      "concept-flow": 0,
      "directory-dependency": 0,
      "directory-fallback": 1,
    });
    expect(regionOf(report, "src/a/a3.ts").evidence).toEqual(["path", "seam"]);
  });
});

describe("aggregator", () => {
  const report = responsibilitiesOf(
    twoRegions({
      "src/index.ts":
        'export { makeAlpha } from "./a/a1";\nexport { makeBeta } from "./b/b1";\n',
    })
  );

  it("creates no cohesion between what it forwards", () => {
    expect(report.regions).toHaveLength(2);
    expect(report.unresolved[0]).toMatchObject({
      module: "src/index.ts",
      reason: "aggregator",
    });
    expect(report.unresolved[0]?.candidates.map((c) => c.edges)).toEqual([
      1, 1,
    ]);
  });
});

describe("bridge module", () => {
  const report = responsibilitiesOf(
    twoRegions({
      "src/bridge/m.ts":
        importOf("src/bridge/m.ts", "src/a/a1.ts", "makeAlpha") +
        importOf("src/bridge/m.ts", "src/b/b1.ts", "makeBeta") +
        "export function both(): string { return makeAlpha('a').id + makeBeta('b').id; }\n",
    })
  );

  it("leaves the regions separate and the bridge explicit", () => {
    expect(report.regions).toHaveLength(2);
    expect(report.unresolved).toEqual([
      {
        candidates: [
          {
            edges: 1,
            localizedSymbols: 1,
            region: regionOf(report, "src/a/a1.ts").id,
          },
          {
            edges: 1,
            localizedSymbols: 1,
            region: regionOf(report, "src/b/b1.ts").id,
          },
        ],
        module: "src/bridge/m.ts",
        reason: "bridge",
        roles: ["dependency-source", "bridge"],
      },
    ]);
  });
});

describe("shared directory", () => {
  const report = responsibilitiesOf({
    "src/shared/a.ts": CONCEPT("SA"),
    "src/shared/b.ts": CONCEPT("SB"),
    "src/x/x1.ts": USES("SA", "src/shared/a.ts", "src/x/x1.ts"),
    "src/y/y1.ts": USES("SB", "src/shared/b.ts", "src/y/y1.ts"),
  });

  it("does not force shared/ into one responsibility", () => {
    expect(regionOf(report, "src/shared/a.ts").modules).toEqual([
      "src/shared/a.ts",
      "src/x/x1.ts",
    ]);
    expect(regionOf(report, "src/shared/b.ts").modules).toEqual([
      "src/shared/b.ts",
      "src/y/y1.ts",
    ]);
    expect(getRegionsByPath(report, "src/shared")).toHaveLength(2);
    expect(getRegionsByPath(report, "shared")).toHaveLength(2);
  });
});

describe("contract and implementations", () => {
  const report = responsibilitiesOf({
    "src/foo/foo-memory.ts":
      'import type { Foo } from "./foo";\nexport class MemoryFoo implements Foo { run(): void { return; } }\n',
    "src/foo/foo-runtime.ts":
      'import type { Foo } from "./foo";\nexport class RuntimeFoo implements Foo { run(): void { return; } }\n',
    "src/foo/foo.ts": "export interface Foo { run(): void }\n",
  });

  it("is one responsibility with the implementation role on the concept", () => {
    expect(report.regions).toHaveLength(1);
    expect(report.regions[0]?.concepts.declared).toEqual([
      {
        conceptId: "packages/p/src/foo/foo.ts#Foo",
        modules: 2,
        name: "Foo",
        relationships: ["implements"],
      },
    ]);
    expect(
      getRegionsByConcept(report, "packages/p/src/foo/foo.ts#Foo")
    ).toHaveLength(1);
  });
});

describe("behavior-light contract region", () => {
  const report = responsibilitiesOf({
    "src/t/a.ts": "export interface A { id: string }\n",
    "src/t/b.ts": 'import type { A } from "./a";\nexport type B = A[];\n',
  });

  it("forms without behavior mass", () => {
    expect(report.regions).toHaveLength(1);
    expect(report.regions[0]?.behavior).toMatchObject({
      bearingModules: 0,
      mass: 0,
    });
    expect(report.regions[0]?.evidence).not.toContain("behavior");
    expect(report.summary.behaviorLightRegions).toBe(1);
  });
});

describe("procedural responsibility", () => {
  const report = responsibilitiesOf({
    "src/proc/a.ts": "export function fa(): number { return 1; }\n",
    "src/proc/b.ts":
      'import { fa } from "./a";\nexport function fb(): number { return fa() + 1; }\n',
  });

  it("emerges from directory dependency alone", () => {
    expect(report.regions).toHaveLength(1);
    const [region] = report.regions;
    expect(region?.construction.joins[0]?.reasons).toEqual([
      "directory-dependency",
    ]);
    expect(region?.concepts.declared).toEqual([]);
    expect(region?.evidence).toEqual([
      "path",
      "dependency",
      "behavior",
      "symbol-flow",
    ]);
    expect(report.summary.regionsWithoutConcepts).toBe(1);
  });
});

describe("usage beside behavior", () => {
  const report = responsibilitiesOf({
    "src/a/a1.ts":
      importOf("src/a/a1.ts", "src/s/x.ts", "X") + "export const a = X;\n",
    "src/b/b1.ts":
      importOf("src/b/b1.ts", "src/s/x.ts", "X") +
      "export function heavy(): number { let t = X; t += 1; t += 2; t += 3; return t; }\n",
    "src/s/x.ts": "export const X = 1;\n",
  });

  it("keeps the disagreement on the declaring region and both consumers as crossing", () => {
    const declaring = regionOf(report, "src/s/x.ts");
    expect(declaring.symbols.behaviorDisagreesWithUsage).toBe(1);
    const symbol = report.symbols.find((s) => s.name === "X");
    expect(symbol?.locality).toBe("responsibility-crossing");
    expect(symbol?.consumerRegions).toHaveLength(2);
    expect(
      getResponsibilityRelationship(
        report,
        regionOf(report, "src/b/b1.ts").id,
        declaring.id
      )
    ).toMatchObject({ moduleEdges: 1, pathRegions: { across: 1, within: 0 } });
  });
});

describe("single module", () => {
  const report = responsibilitiesOf({
    "src/only.ts": "export const one = 1;\n",
  });

  it("is one stable responsibility", () => {
    expect(report.regions).toHaveLength(1);
    expect(report.regions[0]).toMatchObject({
      label: "src/only.ts",
      labelBasis: "module",
      modules: ["src/only.ts"],
      units: ["module:src/only.ts"],
    });
    expect(report.summary).toMatchObject({
      regions: 1,
      relationships: 0,
      singleModuleRegions: 1,
      unresolvedModules: 0,
    });
  });
});

describe("path-only fallback", () => {
  const report = responsibilitiesOf({
    "src/alone/d.ts": "export const d = 4;\n",
    "src/misc/a.ts": "export const a = 1;\n",
    "src/misc/b.ts": "export const b = 2;\n",
    "src/misc/c.ts": "export const c = 3;\n",
  });

  it("groups unclaimed siblings by directory and leaves a lone module alone", () => {
    expect(report.regions.map((r) => r.modules)).toEqual([
      ["src/misc/a.ts", "src/misc/b.ts", "src/misc/c.ts"],
      ["src/alone/d.ts"],
    ]);
    expect(report.regions[0]?.evidence).toEqual(["path"]);
    expect(report.regions[0]?.construction.joins).toHaveLength(2);
    expect(report.summary.joinsByReason["directory-fallback"]).toBe(2);
  });
});

describe("conflicting evidence", () => {
  it("lets concept flow win over the shared directory and records the disagreement", () => {
    const report = responsibilitiesOf({
      "src/p/a.ts": CONCEPT("Alpha"),
      "src/p/b.ts": "export const b = 1;\n",
      "src/q/c.ts": USES("Alpha", "src/p/a.ts", "src/q/c.ts"),
    });
    expect(regionOf(report, "src/p/a.ts").modules).toEqual([
      "src/p/a.ts",
      "src/q/c.ts",
    ]);
    expect(regionOf(report, "src/p/b.ts").modules).toEqual(["src/p/b.ts"]);
    expect(
      getModuleResponsibility(report, "src/q/c.ts")?.pathAgreesWithRegion
    ).toBe(false);
    expect(
      getModuleResponsibility(report, "src/p/a.ts")?.pathAgreesWithRegion
    ).toBe(true);
  });

  it("keeps both join reasons when dependency and concept pull one module two ways", () => {
    const report = responsibilitiesOf({
      "src/d/m.ts":
        'import { fn } from "./n";\n' +
        importOf("src/d/m.ts", "src/e/e1.ts", "Echo") +
        "export function fm(value: Echo): number { return fn() + value.id.length; }\n",
      "src/d/n.ts": "export function fn(): number { return 1; }\n",
      "src/e/e1.ts": CONCEPT("Echo"),
    });
    expect(report.regions).toHaveLength(1);
    const [region] = report.regions;
    expect(region?.path.agreement).toBe("spans-path-regions");
    expect(region?.construction.joins.map((j) => j.reasons)).toEqual([
      ["directory-dependency"],
      ["concept-flow"],
    ]);
  });
});

describe("connector attachment", () => {
  const report = responsibilitiesOf({
    "src/f/f1.ts": "export function f1(): number { return 1; }\n",
    "src/f/f2.ts": "export function f2(): number { return 2; }\n",
    "src/f/f3.ts": "export function f3(): number { return 3; }\n",
    "src/page/p.ts":
      importOf("src/page/p.ts", "src/f/f1.ts", "f1") +
      importOf("src/page/p.ts", "src/f/f2.ts", "f2") +
      importOf("src/page/p.ts", "src/f/f3.ts", "f3") +
      "export const total = f1() + f2() + f3();\n",
  });

  it("attaches a high-fan-out module to the one region its edges reach", () => {
    expect(report.regions).toHaveLength(1);
    expect(report.regions[0]?.attached).toEqual(["src/page/p.ts"]);
    expect(getModuleResponsibility(report, "src/page/p.ts")).toMatchObject({
      connector: true,
      roles: ["dependency-source", "high-fan-out", "bridge"],
      status: "attached",
    });
    expect(report.summary.attachedModules).toBe(1);
  });
});

describe("localized cutoff boundary", () => {
  const consumersOf = (count: number) =>
    Object.fromEntries(
      Array.from({ length: count }, (_, index) => [
        `src/c/use${index}.ts`,
        USES("Alpha", "src/a/a1.ts", `src/c/use${index}.ts`),
      ])
    );

  it("joins two consumers below the cutoff", () => {
    const report = responsibilitiesOf({
      "src/a/a1.ts": CONCEPT("Alpha"),
      ...consumersOf(2),
    });
    expect(report.policy.localizedSymbolCutoff).toBe(3);
    expect(report.regions).toHaveLength(1);
    expect(report.regions[0]?.modules).toHaveLength(3);
  });

  it("stops at three consumers, where the declaring module is a hub attached afterwards", () => {
    const report = responsibilitiesOf({
      "src/a/a1.ts": CONCEPT("Alpha"),
      ...consumersOf(3),
    });
    expect(report.policy.localizedSymbolCutoff).toBe(3);
    expect(report.regions).toHaveLength(1);
    expect(report.regions[0]).toMatchObject({
      attached: ["src/a/a1.ts"],
      label: "Alpha",
      labelBasis: "concept",
    });
    expect(report.regions[0]?.construction.joinsByReason).toEqual({
      "concept-flow": 0,
      "directory-dependency": 0,
      "directory-fallback": 2,
    });
    expect(getModuleResponsibility(report, "src/a/a1.ts")).toMatchObject({
      roles: ["dependency-sink", "high-fan-in", "bridge"],
      status: "attached",
    });
  });
});

describe("render", () => {
  const report = responsibilitiesOf(
    twoRegions({
      "src/a/a3.ts": `${importOf("src/a/a3.ts", "src/util.ts", "cn")}export const k = cn("x");\n`,
      "src/b/b3.ts": `${importOf("src/b/b3.ts", "src/util.ts", "cn")}export const l = cn("y");\n`,
      "src/b/b4.ts": `${importOf("src/b/b4.ts", "src/util.ts", "cn")}export const m = cn("z");\n`,
      "src/util.ts":
        "export function cn(value: string): string { return value; }\n",
    })
  );

  it("names regions by label and short id and lists what stayed unresolved", () => {
    const text = renderInternalResponsibilities(report);
    expect(text).toContain("INTERNAL RESPONSIBILITIES");
    expect(text).toContain("LARGEST RESPONSIBILITIES");
    expect(text).toContain("UNRESOLVED MODULES (1)");
    expect(text).toContain("src/util.ts · distributed-primitive");
    expect(text).not.toContain("responsibility:");
  });
});

describe("independence", () => {
  const files = twoRegions({
    "src/a/a3.ts":
      importOf("src/a/a3.ts", "src/shared/x.ts", "X") +
      "export const a3 = X;\n",
    "src/b/b3.ts":
      importOf("src/b/b3.ts", "src/shared/x.ts", "X") +
      "export const b3 = X;\n",
    "src/shared/x.ts": "export const X = 1;\n",
  });

  it("is byte-identical across workspaces, consumers, Git histories, and clocks", () => {
    const alone = JSON.stringify(responsibilitiesOf(files));
    const crowded = JSON.stringify(
      responsibilitiesOf(files, {
        "packages/q/package.json": JSON.stringify({ name: "@f/q" }),
        "packages/q/src/index.ts":
          'import { makeAlpha } from "@f/p";\nexport const q = makeAlpha("q");\n',
      })
    );
    expect(crowded).toBe(alone);

    const root = workspace(files);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync(
      "git",
      ["-c", "user.email=a@b", "-c", "user.name=a", "add", "."],
      { cwd: root }
    );
    execFileSync(
      "git",
      ["-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "init"],
      { cwd: root }
    );
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2031-01-01T00:00:00Z"));
    try {
      expect(JSON.stringify(derive(root))).toBe(alone);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is deterministic, order-independent, and carries no absolute path", () => {
    const root = workspace(files);
    const local = analyzePackageLocal({ root, target: "packages/p" });
    const topology = analyzeInternalPackageTopology(local);
    const locality = analyzeSymbolLocality(local, topology);
    const first = JSON.stringify(
      analyzeInternalResponsibilities(local, topology, locality)
    );
    expect(
      JSON.stringify(analyzeInternalResponsibilities(local, topology, locality))
    ).toBe(first);
    const shuffled = JSON.stringify(
      analyzeInternalResponsibilities(
        {
          ...local,
          conceptParticipation: [...local.conceptParticipation].reverse(),
          conceptSeeds: [...local.conceptSeeds].reverse(),
          localComplexity: {
            ...local.localComplexity,
            functions: [...local.localComplexity.functions].reverse(),
          },
        },
        {
          ...topology,
          cycles: [...topology.cycles].reverse(),
          edges: [...topology.edges].reverse(),
          modules: [...topology.modules].reverse(),
          roles: [...topology.roles].reverse(),
        },
        { ...locality, symbols: [...locality.symbols].reverse() }
      )
    );
    expect(shuffled).toBe(first);
    expect(first).not.toContain(root);
    expect(first).not.toContain(os.tmpdir());
  });

  it("keeps a region's id when an unrelated module is added elsewhere", () => {
    const before = regionOf(responsibilitiesOf(files), "src/a/a1.ts").id;
    const after = regionOf(
      responsibilitiesOf({ ...files, "src/z/z.ts": "export const z = 1;\n" }),
      "src/a/a1.ts"
    ).id;
    expect(after).toBe(before);
  });
});
