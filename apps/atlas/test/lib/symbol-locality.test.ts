import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";
import { analyzeInternalPackageTopology } from "../../src/lib/internal-topology";
import { analyzePackageLocal } from "../../src/lib/package-local";
import {
  analyzeSymbolLocality,
  getSymbolLocality,
  getSymbolsByDistribution,
  getSymbolsByPlacement,
  getSymbolsByRegion,
} from "../../src/lib/symbol-locality";
import type {
  SymbolLocalityFinding,
  SymbolLocalityReport,
} from "../../src/lib/symbol-locality-types";
import { SYMBOL_LOCALITY_SCHEMA_VERSION } from "../../src/lib/symbol-locality-types";

const specifierPattern = /\.tsx?$/;

// V13.1 symbol locality on synthetic packages. Each fixture is one package in
// a throwaway workspace; the report must be a pure function of that package's
// own files, so the independence tests perturb everything else.

const tempRoots: string[] = [];

afterAll(() => {
  for (const dir of tempRoots) {
    rmSync(dir, { force: true, recursive: true });
  }
});

/** A workspace holding `packages/p` (name `@f/p`) with the given package-relative files. */
function workspace(
  files: Record<string, string>,
  extra: Record<string, string> = {}
): string {
  const dir = mkdtempSync(join(tmpdir(), "symbol-locality-"));
  const root = realpathSync(dir);
  tempRoots.push(root);
  const write = (file: string, text: string) => {
    const target = join(root, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, text);
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
    write(join("packages/p", file), text);
  }
  for (const [file, text] of Object.entries(extra)) {
    write(file, text);
  }
  return root;
}

function localityOf(
  files: Record<string, string>,
  extra?: Record<string, string>
): SymbolLocalityReport {
  const root = workspace(files, extra);
  const local = analyzePackageLocal({ root, target: "packages/p" });
  return analyzeSymbolLocality(local, analyzeInternalPackageTopology(local));
}

/** `import { X } from "<relative>"` from one package-relative file to another. */
function importOf(from: string, to: string, name = "X"): string {
  let specifier = posix.relative(
    posix.dirname(from),
    to.replace(specifierPattern, "")
  );
  if (!specifier.startsWith(".")) {
    specifier = `./${specifier}`;
  }
  return `import { ${name} } from "${specifier}";\n`;
}

/** One consumer per path, each importing `X` from `declaration` and binding it once. */
function consumers(
  declaration: string,
  paths: string[],
  body = (name: string) => `export const ${name} = X;\n`
): Record<string, string> {
  return Object.fromEntries(
    paths.map((file, index) => [
      file,
      importOf(file, declaration) + body(`v${index}`),
    ])
  );
}

function finding(
  report: SymbolLocalityReport,
  symbolId: string
): SymbolLocalityFinding {
  const found = getSymbolLocality(report, symbolId);
  if (found === undefined) {
    throw new Error(`no finding: ${symbolId}`);
  }
  return found;
}

const X = "packages/p/src/shared/x.ts#X";

describe("directory-localized: consumers in one directory", () => {
  const report = localityOf({
    "src/feature/a.ts": "export const X = 1;\n",
    ...consumers("src/feature/a.ts", ["src/feature/b.ts", "src/feature/c.ts"]),
  });
  const x = finding(report, "packages/p/src/feature/a.ts#X");

  it("has the schema version and package identity", () => {
    expect(report.schemaVersion).toBe(SYMBOL_LOCALITY_SCHEMA_VERSION);
    expect(report.package).toEqual({ id: "@f/p", root: "packages/p" });
  });

  it("scopes to the directory and reads as aligned", () => {
    expect(x.distribution).toBe("directory-localized");
    expect(x.commonScope).toEqual({
      id: "directory:src/feature",
      kind: "directory",
      path: "src/feature",
    });
    expect(x.commonDirectory).toEqual({ depth: 2, path: "src/feature" });
    expect(x.directoryRelationship).toBe("same");
    expect(x.placement).toBe("aligned");
    expect(x.consumers).toMatchObject({
      directories: 1,
      modules: 2,
      regions: 1,
    });
    expect(x.evidence).toBe("complete");
    expect(x.limitations).toEqual([]);
  });
});

describe("region-localized: consumers across a region's subdirectories", () => {
  const report = localityOf({
    "src/canvas/x.ts": "export const X = 1;\n",
    ...consumers("src/canvas/x.ts", [
      "src/canvas/editor/a.ts",
      "src/canvas/runtime/b.ts",
      "src/canvas/tools/c.ts",
    ]),
  });
  const x = finding(report, "packages/p/src/canvas/x.ts#X");

  it("keeps the region and the region's directory as common scope", () => {
    expect(x.distribution).toBe("region-localized");
    expect(x.commonScope.id).toBe("directory:src/canvas");
    expect(x.dominantRegion).toMatchObject({ id: "canvas", share: 1 });
    expect(x.placement).toBe("aligned");
    expect(x.seams.crossed).toEqual([]);
  });
});

describe("package-distributed: a root primitive used by independent regions", () => {
  const report = localityOf({
    "src/util.ts": "export const X = 1;\n",
    ...consumers("src/util.ts", [
      "src/canvas/a.ts",
      "src/tasks/b.ts",
      "src/agents/c.ts",
      "src/models/d.ts",
    ]),
  });
  const x = finding(report, "packages/p/src/util.ts#X");

  it("reads as distributed, not as an over-promoted root symbol", () => {
    expect(x.distribution).toBe("package-distributed");
    expect(x.placement).toBe("distributed");
    expect(x.commonScope).toEqual({
      id: "package:@f/p",
      kind: "package",
      path: "@f/p",
    });
    expect(x.dominantRegion).toBeUndefined();
    expect(x.significantRegions).toBe(4);
    expect(x.regions.map((r) => r.id)).toEqual([
      "agents",
      "canvas",
      "models",
      "tasks",
    ]);
    expect(x.seams.crossed).toEqual([
      "agents→.",
      "canvas→.",
      "models→.",
      "tasks→.",
    ]);
  });
});

describe("cross-region declaration: shared/ symbol consumed 90% by canvas/", () => {
  const report = localityOf({
    "src/shared/x.ts": "export const X = 1;\n",
    ...consumers("src/shared/x.ts", [
      ...Array.from({ length: 9 }, (_, i) => `src/canvas/c${i}.ts`),
      "src/tasks/t.ts",
    ]),
  });
  const x = finding(report, X);

  it("names the dominant region and the placement", () => {
    expect(x.dominantRegion).toMatchObject({
      id: "canvas",
      modules: 9,
      share: 0.9,
    });
    expect(x.distribution).toBe("multi-region");
    expect(x.placement).toBe("cross-region");
    expect(x.directoryRelationship).toBe("descendant");
    expect(x.seams).toEqual({
      crossed: ["canvas→shared", "tasks→shared"],
      crossRegionConsumers: 10,
      crossRegionShare: 1,
    });
  });
});

describe("split locality: two significant regions, none dominant", () => {
  const report = localityOf({
    "src/shared/x.ts": "export const X = 1;\n",
    ...consumers("src/shared/x.ts", [
      ...Array.from({ length: 10 }, (_, i) => `src/canvas/c${i}.ts`),
      ...Array.from({ length: 10 }, (_, i) => `src/tasks/t${i}.ts`),
      "src/other/o.ts",
    ]),
  });
  const x = finding(report, X);

  it("does not force a center", () => {
    expect(x.dominantRegion).toBeUndefined();
    expect(x.topRegion).toMatchObject({ id: "canvas", modules: 10 });
    expect(x.significantRegions).toBe(2);
    expect(x.distribution).toBe("multi-region");
    expect(x.placement).toBe("split");
  });

  it("stays split at 55/42", () => {
    const uneven = localityOf({
      "src/shared/x.ts": "export const X = 1;\n",
      ...consumers("src/shared/x.ts", [
        ...Array.from({ length: 11 }, (_, i) => `src/canvas/c${i}.ts`),
        ...Array.from({ length: 8 }, (_, i) => `src/tasks/t${i}.ts`),
        "src/other/o.ts",
      ]),
    });
    expect(finding(uneven, X).placement).toBe("split");
  });

  it("is distributed, not split, when two significant regions sit over a long tail", () => {
    const tail = localityOf({
      "src/shared/x.ts": "export const X = 1;\n",
      ...consumers("src/shared/x.ts", [
        ...Array.from({ length: 3 }, (_, i) => `src/canvas/c${i}.ts`),
        ...Array.from({ length: 2 }, (_, i) => `src/tasks/t${i}.ts`),
        ...Array.from({ length: 8 }, (_, i) => `src/r${i}/m.ts`),
      ]),
    });
    const findingX = finding(tail, X);
    expect(findingX.significantRegions).toBe(2);
    expect(findingX.distribution).toBe("package-distributed");
    expect(findingX.placement).toBe("distributed");
  });
});

describe("narrower than consumers: declared in one branch, consumed by three regions", () => {
  const report = localityOf({
    "src/canvas/types.ts": "export interface X { id: string }\n",
    ...consumers(
      "src/canvas/types.ts",
      [
        "src/canvas/a.ts",
        "src/canvas/b.ts",
        "src/canvas/c.ts",
        "src/tasks/t.ts",
        "src/models/m.ts",
      ],
      (name) => `export const ${name}: X = { id: "" };\n`
    ),
  });
  const x = finding(report, "packages/p/src/canvas/types.ts#X");

  it("is dominant in its own region yet significant elsewhere", () => {
    expect(x.dominantRegion).toMatchObject({ id: "canvas", share: 0.6 });
    expect(x.significantRegions).toBe(3);
    expect(x.directoryRelationship).toBe("descendant");
    expect(x.placement).toBe("narrower-than-consumers");
    expect(x.conceptSeed).toBe(true);
    expect(x.kind).toBe("interface");
    expect(x.behavior.declarationShape).toBe("contract");
  });
});

describe("root narrow primitive: declared at the root, consumed inside one nested directory", () => {
  const report = localityOf({
    "src/constants.ts": "export const X = 1;\n",
    ...consumers("src/constants.ts", [
      "src/canvas/runtime/a.ts",
      "src/canvas/runtime/b.ts",
      "src/canvas/runtime/c.ts",
    ]),
  });
  const x = finding(report, "packages/p/src/constants.ts#X");

  it("is broader than its consumers", () => {
    expect(x.declaration).toMatchObject({
      depth: 1,
      directory: "src",
      region: ".",
    });
    expect(x.commonDirectory).toEqual({ depth: 3, path: "src/canvas/runtime" });
    expect(x.directoryRelationship).toBe("ancestor");
    expect(x.distribution).toBe("directory-localized");
    expect(x.placement).toBe("broader-than-consumers");
  });
});

describe("cross-directory: a sibling directory inside the same region", () => {
  const report = localityOf({
    "src/canvas/shared/x.ts": "export const X = 1;\n",
    ...consumers("src/canvas/shared/x.ts", [
      "src/canvas/editor/a.ts",
      "src/canvas/editor/b.ts",
    ]),
  });

  it("is disjoint at directory level and aligned at region level", () => {
    const x = finding(report, "packages/p/src/canvas/shared/x.ts#X");
    expect(x.directoryRelationship).toBe("disjoint");
    expect(x.placement).toBe("cross-directory");
    expect(x.dominantRegion?.id).toBe("canvas");
  });
});

describe("barrel mediation", () => {
  const report = localityOf({
    "src/feature/x.ts": "export const X = 1;\n",
    "src/index.ts": 'export { X } from "./feature/x";\n',
    ...consumers("src/index.ts", ["src/canvas/a.ts", "src/tasks/b.ts"]),
  });

  it("attributes gravity to the declaration, not the barrel", () => {
    const x = finding(report, "packages/p/src/feature/x.ts#X");
    expect(x.declaration.module).toBe("src/feature/x.ts");
    expect(x.consumers.mediated).toBe(2);
    expect(x.consumerModules).toEqual(["src/canvas/a.ts", "src/tasks/b.ts"]);
    expect(report.symbols.map((s) => s.declaration.module)).not.toContain(
      "src/index.ts"
    );
  });
});

describe("default exports", () => {
  const report = localityOf({
    "src/canvas/a.ts":
      'import Foo from "../feature/foo";\nimport Bar from "../feature/bar";\nimport Baz from "../feature/baz";\nimport anon from "../feature/anon";\nexport const a = Foo() + Bar + Baz + anon();\n',
    "src/canvas/b.ts":
      'import Foo from "../feature/index";\nimport Bar from "../feature/bar";\nexport const b = Foo() + Bar;\n',
    "src/feature/anon.ts": "export default function () {\n  return 4;\n}\n",
    "src/feature/bar.ts": "const Bar = 2;\nexport { Bar as default };\n",
    "src/feature/baz.ts": "export const Baz = 3;\nexport default Baz;\n",
    "src/feature/foo.ts": "export default function Foo() {\n  return 1;\n}\n",
    "src/feature/index.ts": 'export { default } from "./foo";\n',
  });

  it("resolves every named default form to its declaration", () => {
    expect(finding(report, "packages/p/src/feature/foo.ts#Foo")).toMatchObject({
      behavior: { declarationFunctions: 1, declarationShape: "behavior" },
      consumers: { mediated: 1, modules: 2 },
      kind: "function",
      name: "Foo",
    });
    expect(
      finding(report, "packages/p/src/feature/bar.ts#Bar").consumers.modules
    ).toBe(2);
    expect(
      finding(report, "packages/p/src/feature/baz.ts#Baz").consumers.modules
    ).toBe(1);
  });

  it("leaves the anonymous default unresolved rather than naming it after the file", () => {
    expect(
      report.symbols.some((s) => s.declaration.module === "src/feature/anon.ts")
    ).toBe(false);
    expect(report.summary.anonymousDefaultExports).toBe(1);
    expect(report.summary.unresolvedDefaultImportSites).toBe(1);
  });
});

describe("namespace imports", () => {
  const module = {
    "src/feature/m.ts":
      "export function a() {\n  return 1;\n}\nexport function b() {\n  return 2;\n}\nexport const c = 3;\nexport interface Shape { id: string }\n",
  };

  it("counts only the members accessed through the binding", () => {
    const report = localityOf({
      ...module,
      "src/canvas/use.ts":
        'import * as m from "../feature/m";\nexport const v = m.a() + m.b() + m.a();\nexport type T = m.Shape;\n',
    });
    const a = finding(report, "packages/p/src/feature/m.ts#a");
    expect(a.consumers).toMatchObject({
      bindingOccurrences: 2,
      importSites: 0,
      namespaceSites: 1,
    });
    expect(a.limitations).toEqual([
      "single-consumer",
      "namespace-member-derived",
    ]);
    expect(a.evidence).toBe("limited");
    expect(
      finding(report, "packages/p/src/feature/m.ts#b").consumers
        .bindingOccurrences
    ).toBe(1);
    expect(finding(report, "packages/p/src/feature/m.ts#Shape").usage).toBe(
      "value"
    );
    expect(
      getSymbolLocality(report, "packages/p/src/feature/m.ts#c")
    ).toBeUndefined();
  });

  it("never fans a bare namespace use across the module's exports", () => {
    const report = localityOf({
      ...module,
      "src/canvas/bare.ts":
        'import * as m from "../feature/m";\nexport const all = Object.keys(m);\n',
      "src/tasks/named.ts":
        'import { a } from "../feature/m";\nexport const v = a();\n',
    });
    expect(report.symbols.map((s) => s.name)).toEqual(["a"]);
    expect(report.summary.bareNamespaceSites).toBe(1);
    expect(
      finding(report, "packages/p/src/feature/m.ts#a").limitations
    ).toEqual(["single-consumer", "namespace-bare-use"]);
  });
});

describe("type-only and value consumers", () => {
  const report = localityOf({
    "src/canvas/a.ts":
      'import type { X } from "../shared/x";\nexport const a: X = { id: "" };\n',
    "src/canvas/b.ts":
      'import { X, Y } from "../shared/x";\nexport const b: X = { id: String(Y) };\n',
    "src/shared/x.ts":
      "export interface X { id: string }\nexport const Y = 1;\n",
    "src/tasks/c.ts": 'import { Y } from "../shared/x";\nexport const c = Y;\n',
  });

  it("keeps type usage distinct from value usage", () => {
    expect(finding(report, X)).toMatchObject({
      consumers: { modules: 2, typeOnly: 1 },
      usage: "both",
    });
    expect(finding(report, "packages/p/src/shared/x.ts#Y").usage).toBe("value");
    expect(report.summary.byUsage).toEqual({ both: 1, type: 0, value: 1 });
  });
});

describe("one heavy consumer beside one light consumer", () => {
  const report = localityOf({
    "src/canvas/heavy.ts":
      importOf("src/canvas/heavy.ts", "src/shared/x.ts") +
      `export const heavy = [${Array.from({ length: 100 }, () => "X").join(", ")}];\n`,
    "src/shared/x.ts": "export const X = 1;\n",
    "src/tasks/light.ts":
      importOf("src/tasks/light.ts", "src/shared/x.ts") +
      "export const light = X;\n",
  });
  const x = finding(report, X);

  it("preserves both the binding share and the module count", () => {
    expect(x.dominantModule).toMatchObject({
      bindingOccurrences: 100,
      id: "src/canvas/heavy.ts",
      modules: 1,
      share: 0.5,
    });
    expect(x.dominantModule.bindingShare).toBeCloseTo(100 / 101);
    expect(x.consumers).toMatchObject({ bindingOccurrences: 101, modules: 2 });
    expect(x.topRegion).toMatchObject({
      bindingShare: 100 / 101,
      id: "canvas",
      share: 0.5,
    });
    expect(x.placement).toBe("split");
  });
});

describe("many import sites, few bindings", () => {
  const report = localityOf({
    "src/canvas/a.ts":
      'import { X } from "../shared/x";\nimport { X as X2 } from "../shared/x";\nexport const a = X2;\n',
    "src/canvas/b.ts": `${importOf("src/canvas/b.ts", "src/shared/x.ts")}export const b = X;\n`,
    "src/shared/x.ts": "export const X = 1;\n",
  });

  it("reports both dimensions", () => {
    const x = finding(report, X);
    expect(x.consumers).toMatchObject({
      bindingOccurrences: 2,
      importSites: 3,
    });
    expect(x.dominantModule).toMatchObject({
      bindingOccurrences: 1,
      id: "src/canvas/a.ts",
      importSites: 2,
    });
  });
});

describe("flat directory: everything under src/", () => {
  const report = localityOf({
    "src/a.ts":
      'import { X } from "./x";\nimport { b } from "./b";\nexport const a = X + b;\n',
    "src/b.ts":
      'import { X } from "./x";\nimport { c } from "./c";\nexport const b = X + c;\n',
    "src/c.ts": 'import { X } from "./x";\nexport const c = X;\n',
    "src/x.ts": "export const X = 1;\n",
  });
  const x = finding(report, "packages/p/src/x.ts#X");

  it("says little by path and keeps the graph evidence", () => {
    expect(x.distribution).toBe("directory-localized");
    expect(x.commonScope).toEqual({
      id: "region:.",
      kind: "region",
      path: ".",
    });
    expect(x.placement).toBe("aligned");
    expect(x.structure.consumerComponents).toBe(1);
    expect(x.structure.layerSpan).toEqual({ max: 3, min: 1 });
  });
});

describe("technical root beside a sibling top-level directory", () => {
  const report = localityOf({
    "src/types.ts": "export interface X { id: string }\n",
    ...consumers(
      "src/types.ts",
      ["src/a.ts", "src/b.ts", "src/c.ts", "scripts/run.ts"],
      (name) => `export const ${name}: X = { id: "" };\n`
    ),
  });

  it("does not read src/ as narrower than a root-level common directory", () => {
    const x = finding(report, "packages/p/src/types.ts#X");
    expect(x.commonDirectory.path).toBe(".");
    expect(x.directoryRelationship).toBe("same");
    expect(x.placement).toBe("aligned");
  });
});

describe("cycle-localized consumers", () => {
  const report = localityOf({
    "src/canvas/a.ts":
      'import { X } from "../shared/x";\nimport { b } from "../tasks/b";\nexport const a = X + b;\n',
    "src/shared/x.ts": "export const X = 1;\n",
    "src/tasks/b.ts":
      'import { X } from "../shared/x";\nimport { a } from "../canvas/a";\nexport const b = X + (a as number);\n',
  });

  it("records the cycle holding the consumers", () => {
    const x = finding(report, X);
    expect(x.structure.cycle).toEqual({
      consumerShare: 1,
      declarationMember: false,
      id: "cycle-1",
    });
    expect(x.structure.consumerComponents).toBe(1);
  });
});

describe("disconnected consumer groups", () => {
  const report = localityOf({
    "src/canvas/a1.ts":
      'import { X } from "../shared/x";\nimport { a2 } from "./a2";\nexport const a1 = X + a2;\n',
    "src/canvas/a2.ts":
      'import { X } from "../shared/x";\nexport const a2 = X;\n',
    "src/shared/x.ts": "export const X = 1;\n",
    "src/tasks/b1.ts":
      'import { X } from "../shared/x";\nimport { b2 } from "./b2";\nexport const b1 = X + b2;\n',
    "src/tasks/b2.ts":
      'import { X } from "../shared/x";\nexport const b2 = X;\n',
  });

  it("counts two consumer neighborhoods", () => {
    const x = finding(report, X);
    expect(x.structure.consumerComponents).toBe(2);
    expect(x.placement).toBe("split");
  });
});

describe("behavior beside usage", () => {
  const report = localityOf({
    "src/canvas/a.ts": `${importOf("src/canvas/a.ts", "src/shared/x.ts")}export const a = X;\n`,
    "src/canvas/b.ts": `${importOf("src/canvas/b.ts", "src/shared/x.ts")}export const b = X;\n`,
    "src/shared/x.ts": "export const X = 1;\n",
    "src/tasks/c.ts":
      importOf("src/tasks/c.ts", "src/shared/x.ts") +
      "export function run() {\n  const y = X + 1;\n  if (y > 1) return y;\n  return 0;\n}\n",
  });

  it("separates the module-heaviest region from the behavior-heaviest one", () => {
    const x = finding(report, X);
    expect(x.topRegion.id).toBe("canvas");
    expect(x.behavior).toMatchObject({
      agreesWithUsage: false,
      consumerStatements: 4,
      declarationShape: "value",
      dominantBehaviorRegion: { id: "tasks", share: 1 },
    });
    expect(report.summary.behaviorDisagreesWithUsage).toBe(1);
  });
});

describe("threshold boundaries", () => {
  const withRegions = (canvas: number, tasks: number, extra: string[] = []) =>
    finding(
      localityOf({
        "src/shared/x.ts": "export const X = 1;\n",
        ...consumers("src/shared/x.ts", [
          ...Array.from({ length: canvas }, (_, i) => `src/canvas/c${i}.ts`),
          ...Array.from({ length: tasks }, (_, i) => `src/tasks/t${i}.ts`),
          ...extra,
        ]),
      }),
      X
    );

  it("dominance is inclusive at exactly 60%", () => {
    expect(withRegions(3, 2).dominantRegion?.share).toBe(0.6);
    expect(withRegions(5, 4).dominantRegion).toBeUndefined();
  });

  it("significance is inclusive at exactly 10%", () => {
    expect(withRegions(9, 1).significantRegions).toBe(2);
    expect(withRegions(10, 1).significantRegions).toBe(1);
  });

  it("placement is unclear below two consumers", () => {
    expect(withRegions(1, 0)).toMatchObject({
      distribution: "module-localized",
      evidence: "limited",
      limitations: ["single-consumer"],
      placement: "unclear",
    });
    expect(withRegions(2, 0).placement).toBe("cross-region");
  });
});

describe("scopes and query helpers", () => {
  const report = localityOf({
    "src/shared/x.ts": "export const X = 1;\n",
    ...consumers("src/shared/x.ts", ["src/canvas/a.ts", "src/canvas/b.ts"]),
  });

  it("builds the scope hierarchy with parents", () => {
    const byId = new Map(report.scopes.map((scope) => [scope.id, scope]));
    expect(byId.get("package:@f/p")?.kind).toBe("package");
    expect(byId.get("package:@f/p")?.parent).toBeUndefined();
    expect(byId.get("region:canvas")).toMatchObject({
      modules: ["src/canvas/a.ts", "src/canvas/b.ts"],
      parent: "package:@f/p",
    });
    expect(byId.get("directory:src/canvas")).toMatchObject({
      parent: "directory:src",
    });
    expect(byId.get("directory:.")).toMatchObject({ parent: "package:@f/p" });
    expect(byId.get("module:src/shared/x.ts")).toMatchObject({
      parent: "directory:src/shared",
    });
  });

  it("answers by id, region, placement, and distribution", () => {
    expect(getSymbolsByRegion(report, "shared").map((s) => s.name)).toEqual([
      "X",
    ]);
    expect(getSymbolsByPlacement(report, "cross-region").length).toBe(1);
    expect(getSymbolsByDistribution(report, "directory-localized").length).toBe(
      1
    );
    expect(getSymbolsByPlacement(report, "aligned")).toEqual([]);
  });

  it("echoes its policy and global limitations", () => {
    expect(report.policy).toMatchObject({
      dominanceDenominator: "consumer modules",
      dominantShareThreshold: 0.6,
      minimumConsumers: 2,
      significantShareThreshold: 0.1,
      technicalRoots: ["src", "source", "lib"],
    });
    expect(report.limitations.length).toBe(3);
  });
});

describe("independence", () => {
  const files = {
    "src/shared/x.ts": "export const X = 1;\n",
    ...consumers("src/shared/x.ts", [
      "src/canvas/a.ts",
      "src/tasks/b.ts",
      "src/models/c.ts",
    ]),
  };

  it("is byte-identical across workspaces, consumers, Git histories, and clocks", () => {
    const alone = JSON.stringify(localityOf(files));
    const crowded = JSON.stringify(
      localityOf(files, {
        "packages/q/package.json": JSON.stringify({ name: "@f/q" }),
        "packages/q/src/index.ts":
          'import { X } from "@f/p";\nexport const q = X;\n',
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
      const local = analyzePackageLocal({ root, target: "packages/p" });
      const versioned = JSON.stringify(
        analyzeSymbolLocality(local, analyzeInternalPackageTopology(local))
      );
      expect(versioned).toBe(alone);
    } finally {
      vi.useRealTimers();
    }
  });

  it("is deterministic and carries no absolute path", () => {
    const root = workspace(files);
    const local = analyzePackageLocal({ root, target: "packages/p" });
    const topology = analyzeInternalPackageTopology(local);
    const first = JSON.stringify(analyzeSymbolLocality(local, topology));
    expect(JSON.stringify(analyzeSymbolLocality(local, topology))).toBe(first);
    expect(first).not.toContain(root);
    expect(first).not.toContain(tmpdir());
  });
});
