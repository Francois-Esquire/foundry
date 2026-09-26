import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";
import { assembleSurfaceReport } from "../../src/lib/assemble";
import { resolveBoundary, toPosix } from "../../src/lib/boundary";
import {
  SURFACE_SUMMARY_FIELD_SCOPES,
  SURFACE_SYMBOL_FIELD_SCOPES,
  WORKSPACE_DERIVED_KEYS,
} from "../../src/lib/fact-scope";
import { analyzePackageLocal } from "../../src/lib/package-local";
import type { PackageLocalReport } from "../../src/lib/package-local-types";
import { PACKAGE_LOCAL_REPORT_SCHEMA_VERSION } from "../../src/lib/package-local-types";
import {
  packageSourceFiles,
  workspaceSourceFiles,
} from "../../src/lib/project";
import { canonicalizeSemanticsArtifact } from "../../src/lib/semantics-equivalence";
import type { SurfaceReport } from "../../src/lib/types";
import { deriveWorkspaceSurface } from "../../src/lib/workspace-derive";
import { analyzeWorkspaceSurfaces } from "../../src/lib/workspace-surface";

// V12.6 package-local invariance on the semantics fixture. The package-local
// report is what a package *is*; nothing about consumers, neighbours, Git,
// or the clock may reach it. Each test perturbs one of those and expects the
// serialized report to stay byte-identical.

const fixture = path.join(import.meta.dirname, "fixtures", "semantics");
const now = new Date("2027-01-01T00:00:00Z");
const tempRoots: string[] = [];

afterAll(() => {
  for (const dir of tempRoots) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

function copyFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "package-local-"));
  fs.cpSync(fixture, dir, { recursive: true });
  const root = fs.realpathSync(dir);
  tempRoots.push(root);
  return root;
}

function write(root: string, file: string, text: string): void {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}

function local(root: string, target: string): string {
  return JSON.stringify(
    analyzePackageLocal({ root, target, tsconfig: "tsconfig.json" })
  );
}

function walk(
  value: unknown,
  visit: (key: string, value: unknown) => void
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      walk(item, visit);
    }
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      visit(key, inner);
      walk(inner, visit);
    }
  }
}

describe("package-local report", () => {
  it("is independent of the workspace around the package", () => {
    const quiet = copyFixture();
    const busy = copyFixture();
    // a new consumer, a heavier existing consumer, a provider change in a
    // neighbour, a workspace-wide config file, and a Git history
    write(
      busy,
      "packages/z/package.json",
      '{\n  "name": "@s/z",\n  "private": true,\n  "dependencies": { "@s/b": "workspace:*" }\n}\n'
    );
    write(
      busy,
      "packages/z/src/index.ts",
      'import { area, perimeter } from "@s/b";\n\nexport const both = (w: number, h: number): number =>\n  area({ width: w, height: h }) + perimeter({ width: w, height: h });\n'
    );
    write(
      busy,
      "apps/a/src/index.ts",
      'import type { Shape } from "@s/b";\n\nimport { area, perimeter } from "@s/b";\n\nexport function describe(shape: Shape): string {\n  return `${String(area(shape))}/${String(perimeter(shape))}`;\n}\n'
    );
    write(
      busy,
      "tooling/c/src/index.ts",
      "export const fence = (): number => 0;\n"
    );
    write(
      busy,
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          baseUrl: ".",
          module: "ESNext",
          moduleResolution: "Bundler",
          paths: {
            "@s/a": ["apps/a/src/index.ts"],
            "@s/b": ["packages/b/src/index.ts"],
            "@s/c": ["tooling/c/src/index.ts"],
            "@s/z": ["packages/z/src/index.ts"],
          },
          skipLibCheck: true,
          strict: true,
          target: "ES2022",
        },
      })
    );
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: busy });
    execFileSync("git", ["add", "-A"], { cwd: busy });
    execFileSync(
      "git",
      ["-c", "user.name=f", "-c", "user.email=f@e.test", "commit", "-qm", "x"],
      { cwd: busy }
    );

    expect(local(busy, "packages/b")).toBe(local(quiet, "packages/b"));
  });

  it("does not change when a provider the package imports changes", () => {
    const root = copyFixture();
    const before = local(root, "apps/a");
    write(
      root,
      "packages/b/src/shape.ts",
      "export interface Shape {\n  width: number;\n  height: number;\n  depth?: number;\n}\n\nexport function area(shape: Shape): number {\n  return shape.width * shape.height;\n}\n\nexport function perimeter(shape: Shape): number {\n  return 2 * (shape.width + shape.height);\n}\n\nexport function volume(shape: Shape): number {\n  return area(shape) * (shape.depth ?? 1);\n}\n"
    );
    expect(local(root, "apps/a")).toBe(before);
  });

  it("changes when the package's own sources change", () => {
    const root = copyFixture();
    const before = local(root, "packages/b");
    write(
      root,
      "packages/b/src/shape.ts",
      `${fs.readFileSync(path.join(root, "packages/b/src/shape.ts"), "utf8")}\nexport const unit = 1;\n`
    );
    expect(local(root, "packages/b")).not.toBe(before);
  });

  it("is independent of the clock", () => {
    const root = copyFixture();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2020-01-01T00:00:00Z"));
      const early = local(root, "packages/b");
      vi.setSystemTime(new Date("2031-06-01T00:00:00Z"));
      expect(local(root, "packages/b")).toBe(early);
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes deterministically", () => {
    const root = copyFixture();
    expect(local(root, "tooling/c")).toBe(local(root, "tooling/c"));
  });

  it("carries no workspace-derived fact, foreign path, absolute path, or timestamp", () => {
    const root = copyFixture();
    const report = analyzePackageLocal({
      root,
      target: "apps/a",
      tsconfig: "tsconfig.json",
    });
    expect(report.schemaVersion).toBe(PACKAGE_LOCAL_REPORT_SCHEMA_VERSION);
    const keys = new Set<string>();
    const strings: string[] = [];
    walk(report, (key, value) => {
      keys.add(key);
      if (typeof value === "string") {
        strings.push(value);
      }
    });
    for (const derived of WORKSPACE_DERIVED_KEYS) {
      expect(keys.has(derived)).toBe(false);
    }
    for (const [field, scope] of Object.entries(SURFACE_SYMBOL_FIELD_SCOPES)) {
      if (scope === "workspace-derived") {
        expect(keys.has(field)).toBe(false);
      }
    }
    for (const [field, scope] of Object.entries(SURFACE_SUMMARY_FIELD_SCOPES)) {
      expect(field in report.summary).toBe(scope === "package-local");
    }
    const foreign = strings.filter(
      (s) =>
        /^(packages|tooling|libraries|services)\//.test(s) || s.includes(root)
    );
    expect(foreign).toEqual([]);
    expect(strings.filter((s) => /^\d{4}-\d{2}-\d{2}T/.test(s))).toEqual([]);
    // the import of @s/b is recorded as an address, never a resolution
    const external = report.imports.filter((i) => i.scope === "external");
    expect(external.length).toBeGreaterThan(0);
    expect(new Set(external.map((i) => i.specifier))).toEqual(
      new Set(["@s/b"])
    );
  });

  it("enumerates exactly the package-owned subset of the workspace sources", () => {
    const root = copyFixture();
    const boundary = resolveBoundary(root, "tooling/c");
    const owned = workspaceSourceFiles(root).filter((file) =>
      toPosix(file).startsWith(`${toPosix(boundary.dir)}/`)
    );
    expect(packageSourceFiles(root, boundary)).toEqual(owned);
    expect(owned.length).toBeGreaterThan(0);
  });

  it("records each module's relationships to the package's own concept seeds", () => {
    const root = copyFixture();
    write(
      root,
      "packages/b/src/store.ts",
      'import type { Shape } from "./index";\n\nexport interface Store { get(): Shape }\nexport class MemoryStore implements Store {\n  get(): Shape {\n    return { width: 1, height: 1 };\n  }\n}\n'
    );
    write(
      root,
      "packages/b/src/use.ts",
      'import type { Store } from "./store";\n\nexport function read(store: Store): number {\n  return store.get().width;\n}\n'
    );
    const report = analyzePackageLocal({ root, target: "packages/b" });
    const store = "packages/b/src/store.ts#Store";
    expect(
      report.conceptParticipation.filter((p) => p.conceptId === store)
    ).toEqual([
      {
        conceptId: store,
        module: "packages/b/src/store.ts",
        relationships: { implements: 1 },
        symbols: ["packages/b/src/store.ts#MemoryStore"],
      },
      {
        conceptId: store,
        module: "packages/b/src/use.ts",
        relationships: { "parameter-type": 1 },
        symbols: ["packages/b/src/use.ts#read"],
      },
    ]);
    expect(
      report.conceptParticipation.every((p) =>
        p.module.startsWith("packages/b/")
      )
    ).toBe(true);
  });

  it("records each declaration's shape and its own seed relationships", () => {
    const root = copyFixture();
    write(
      root,
      "packages/b/src/decl.ts",
      'import { z } from "zod";\nimport type { Shape } from "./index";\n\nexport const SETTINGS: Shape = { width: 1, height: 1 };\nexport const NAMES = ["a", "b"] as const;\nexport const ShapeSchema = z.object({ width: z.number() });\nexport const Wider = ShapeSchema.extend({});\nexport type ShapeId = string & { readonly __brand: "ShapeId" };\nexport type FromSchema = z.infer<typeof ShapeSchema>;\nexport interface Reader { read(): Shape; size: number }\nexport abstract class Base implements Reader {\n  size = 0;\n  abstract read(): Shape;\n}\nexport const make = (): Shape => ({ width: 1, height: 1 });\n'
    );
    const report = analyzePackageLocal({ root, target: "packages/b" });
    const byId = new Map(report.declarations.map((d) => [d.symbolId, d]));
    const id = (name: string) => `packages/b/src/decl.ts#${name}`;
    expect(report.declarations.map((d) => d.symbolId)).toEqual(
      report.symbols.map((s) => s.id)
    );
    expect(byId.get(id("SETTINGS"))).toEqual({
      annotation: "packages/b/src/shape.ts#Shape",
      concepts: [
        {
          conceptId: "packages/b/src/shape.ts#Shape",
          relationships: { "type-reference": 1 },
        },
      ],
      initializer: "object",
      symbolId: id("SETTINGS"),
    });
    expect(byId.get(id("NAMES"))).toMatchObject({
      asConst: true,
      initializer: "array",
    });
    expect(byId.get(id("ShapeSchema"))).toMatchObject({
      callee: { name: "z", specifier: "zod" },
      initializer: "call",
    });
    expect(byId.get(id("Wider"))).toMatchObject({
      callee: { name: "ShapeSchema", symbolId: id("ShapeSchema") },
      initializer: "call",
    });
    expect(byId.get(id("ShapeId"))).toMatchObject({ aliasShape: "brand" });
    expect(byId.get(id("FromSchema"))).toMatchObject({
      aliasShape: "reference",
      typeQueries: [id("ShapeSchema")],
    });
    expect(byId.get(id("Reader"))).toMatchObject({
      members: { methods: 1, properties: 1 },
    });
    expect(byId.get(id("Base"))).toMatchObject({
      abstract: true,
      concepts: [
        { conceptId: id("Reader"), relationships: { implements: 1 } },
        {
          conceptId: "packages/b/src/shape.ts#Shape",
          relationships: { "return-type": 1 },
        },
      ],
      members: { methods: 1, properties: 1 },
    });
    expect(byId.get(id("make"))).toMatchObject({ initializer: "function" });
  });

  it("records how each internal value binding is used", () => {
    const root = copyFixture();
    write(
      root,
      "packages/b/src/decl.ts",
      'import type { Shape } from "./index";\n\nexport interface Reader { read(): Shape }\nexport abstract class Base implements Reader { abstract read(): Shape; }\nexport const make = (): Shape => ({ width: 1, height: 1 });\n'
    );
    write(
      root,
      "packages/b/src/wiring.tsx",
      'import { Base, make, Reader } from "./decl";\nimport type { Shape } from "./index";\nimport { area } from "./index";\nimport { z } from "zod";\n\nclass Impl extends Base { read(): Shape { return make(); } }\nexport const registry = { Impl, make, list: [Base, make] };\nexport const built = new Impl();\nexport const total = area(make()) + z.number().parse(1);\nexport const view = <Base />;\nexport const named = make.name;\nexport const shape: Reader | undefined = undefined;\n'
    );
    const report = analyzePackageLocal({ root, target: "packages/b" });
    const sites = report.imports.filter(
      (site) => site.sourceModule === "packages/b/src/wiring.tsx"
    );
    const usesOf = (name: string) =>
      sites.find((site) => site.importedName === name)?.uses;
    expect(usesOf("Base")).toEqual({
      argument: 0,
      called: 0,
      collected: 1,
      constructed: 0,
      rendered: 1,
    });
    expect(usesOf("make")).toEqual({
      argument: 0,
      called: 2,
      collected: 2,
      constructed: 0,
      rendered: 0,
    });
    expect(usesOf("area")).toEqual({
      argument: 0,
      called: 1,
      collected: 0,
      constructed: 0,
      rendered: 0,
    });
    // Type-only bindings and external bindings carry no uses.
    expect(usesOf("Reader")).toBeUndefined();
    expect(usesOf("Shape")).toBeUndefined();
    expect(usesOf("z")).toBeUndefined();
  });
});

describe("assembly", () => {
  it("joins the local report with the derived facts field for field", async () => {
    const root = copyFixture();
    const locals: PackageLocalReport[] = ["apps/a", "packages/b"].map(
      (target) =>
        analyzePackageLocal({ root, target, tsconfig: "tsconfig.json" })
    );
    const derivation = await deriveWorkspaceSurface(locals, {
      now,
      root,
      tsconfig: "tsconfig.json",
    });
    const reports: SurfaceReport[] = locals.map((l) => {
      const derived = derivation.packages[l.package.path];
      if (derived === undefined) {
        throw new Error(l.package.path);
      }
      return assembleSurfaceReport(l, derived);
    });
    const whole = await analyzeWorkspaceSurfaces({
      now,
      root,
      targets: ["apps/a", "packages/b"],
      tsconfig: "tsconfig.json",
    });
    const canonical = (report: SurfaceReport) =>
      canonicalizeSemanticsArtifact("packages/x.json", report);
    expect(reports.map(canonical)).toEqual(whole.reports.map(canonical));

    const [a, b] = reports;
    const [localA, localB] = locals;
    if (
      a === undefined ||
      b === undefined ||
      localA === undefined ||
      localB === undefined
    ) {
      throw new Error("two reports expected");
    }
    expect(a.symbols.map((s) => s.id)).toEqual(localA.symbols.map((s) => s.id));
    expect(a.summary).toMatchObject(localA.summary);
    expect(a.symbols.every((s) => s.consumers.length === 0)).toBe(true);
    const area = b.symbols.find((s) => s.name === "area");
    expect(area?.consumerPackages).toEqual(["@s/a"]);
    expect(area?.packagePublic).toBe(
      localB.symbols.find((s) => s.name === "area")?.packagePublic
    );
    const derivedB = derivation.packages["packages/b"];
    if (derivedB === undefined) {
      throw new Error("packages/b not derived");
    }
    expect(() => assembleSurfaceReport(localA, derivedB)).toThrow(
      /derived facts belong to packages\/b/
    );
  });
});
