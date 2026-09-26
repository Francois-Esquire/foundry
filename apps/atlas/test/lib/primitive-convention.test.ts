import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";
import { analyzeInternalResponsibilities } from "../../src/lib/internal-responsibility";

import { analyzeInternalPackageTopology } from "../../src/lib/internal-topology";
import { analyzePackageLocal } from "../../src/lib/package-local";
import {
  analyzePrimitiveConventions,
  getConventions,
  getModulePrimitives,
  getSymbolRole,
  getSymbolsByRole,
} from "../../src/lib/primitive-convention";
import type {
  ArchitecturalRoleFinding,
  PrimitiveConventionReport,
} from "../../src/lib/primitive-convention-types";
import { PRIMITIVE_CONVENTION_SCHEMA_VERSION } from "../../src/lib/primitive-convention-types";
import { renderPrimitiveConventions } from "../../src/lib/report-primitive";
import { analyzeSymbolLocality } from "../../src/lib/symbol-locality";

// V13.3 primitive roles, responsibility scopes, module shapes, and placement
// conventions on synthetic packages. Each fixture is one package in a
// throwaway workspace; the high-fan cutoff floors at 3, so a module with
// three dependents is a connector and stays unresolved between regions, and
// the package-wide floor is 3 responsibilities.

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "primitive-"));
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

function derive(root: string): PrimitiveConventionReport {
  const local = analyzePackageLocal({ root, target: "packages/p" });
  const topology = analyzeInternalPackageTopology(local);
  const locality = analyzeSymbolLocality(local, topology);
  const responsibilities = analyzeInternalResponsibilities(
    local,
    topology,
    locality
  );
  return analyzePrimitiveConventions(
    local,
    topology,
    locality,
    responsibilities
  );
}

function primitivesOf(
  files: Record<string, string>,
  extra?: Record<string, string>
): PrimitiveConventionReport {
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

function symbol(
  report: PrimitiveConventionReport,
  module: string,
  name: string
): ArchitecturalRoleFinding {
  const finding = getSymbolRole(report, `packages/p/${module}#${name}`);
  if (finding === undefined) {
    throw new Error(`no finding: ${module}#${name}`);
  }
  return finding;
}

const ROLES_MODULE = `
import { z } from "zod";

export type UserId = string & { readonly __brand: "UserId" };
export type OrderId = string;
export type Token = string;
export type Shape = "circle" | "square";
export const MAX_RETRIES = 3;
export const COLORS = ["red", "blue"] as const;
export interface StoreOptions {
  retries: number;
}
export const DEFAULT_OPTIONS: StoreOptions = { retries: 3 };
export const LIMITS = { retries: 2 } as const;
export interface Store {
  get(id: UserId): string;
}
export interface Db {
  run(sql: string): void;
}
export interface Row {
  id: string;
  name: string;
}
export interface Marker {
  kind: "a";
}
export interface ExtendedRow extends Row {
  extra: string;
}
export class MemoryStore implements Store {
  get(id: UserId): string {
    return id;
  }
}
export class SqliteStore implements Store {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }
  get(id: UserId): string {
    this.db.run(id);
    return id;
  }
}
export class Tagged implements Marker {
  kind = "a" as const;
}
export class Counter {
  private n = 0;
  next(): number {
    this.n += 1;
    return this.n;
  }
}
export function createStore(): Store {
  return new MemoryStore();
}
export function makeRow(name: string): Row {
  return { id: "1", name };
}
export function loadRow(id: UserId): Row {
  return { id, name: id };
}
export class AppError extends Error {
  code = 1;
}
export function fail(): never {
  throw new AppError("x");
}
const shared = new MemoryStore();
export function currentStore(): MemoryStore {
  return shared;
}
export function trim(name: string): string {
  return name.trim();
}
export const FooConfig = (row: Row): number => row.id.length;
export const registry = new Map<string, string>();
export enum Mode {
  A,
  B,
}
export const UserSchema = z.object({ id: z.string() });
export const AdminSchema = UserSchema.extend({ admin: z.boolean() });
export type User = z.infer<typeof UserSchema>;
export namespace Ns {
  export const inside = 1;
}
const helper = (): number => 1;
export const useHelper = (row: Row): number => helper() + row.id.length;
`;

function rolesFixture(): Record<string, string> {
  const names =
    "UserId, OrderId, Token, Shape, MAX_RETRIES, COLORS, StoreOptions, DEFAULT_OPTIONS, LIMITS, Store, Db, Row, Marker, ExtendedRow, MemoryStore, SqliteStore, Tagged, Counter, createStore, makeRow, loadRow, trim, FooConfig, registry, Mode, UserSchema, AdminSchema, User, Ns, useHelper";
  const use = (file: string) =>
    importOf(file, "src/a/roles.ts", names) +
    "export const all = [MemoryStore, SqliteStore, Tagged, Counter, createStore, makeRow, loadRow, trim(''), FooConfig, registry, Mode, UserSchema, AdminSchema, Ns, useHelper, MAX_RETRIES, COLORS, DEFAULT_OPTIONS, LIMITS];\n" +
    "export type Uses = [UserId, OrderId, Token, Shape, StoreOptions, Store, Db, Row, Marker, ExtendedRow, User];\n";
  return {
    "src/a/roles.ts": ROLES_MODULE,
    "src/a/use1.ts": use("src/a/use1.ts"),
    "src/a/use2.ts": use("src/a/use2.ts"),
    "src/index.ts": 'export * from "./a/roles";\n',
  };
}

describe("roles", () => {
  const report = primitivesOf(rolesFixture());
  const role = (name: string) => symbol(report, "src/a/roles.ts", name);

  it("has its own schema", () => {
    expect(report.schemaVersion).toBe(PRIMITIVE_CONVENTION_SCHEMA_VERSION);
    expect(report.package).toEqual({ id: "@f/p", root: "packages/p" });
  });

  it("identifies branded and id-named scalar aliases, not plain scalars", () => {
    expect(role("UserId").primaryRole).toBe("identifier");
    expect(role("UserId").evidence.roles[0]?.kind).toBe("alias-shape");
    expect(role("OrderId").primaryRole).toBe("identifier");
    expect(role("Token").primaryRole).toBe("type");
    expect(role("Shape").primaryRole).toBe("type");
  });

  it("reads constants from initializers and enums", () => {
    expect(role("MAX_RETRIES").roles).toEqual(["constant"]);
    expect(role("COLORS").roles).toEqual(["constant"]);
    expect(role("Mode").roles).toEqual(["constant"]);
    expect(role("FooConfig").primaryRole).toBe("behavior");
  });

  it("tells configuration from constants by annotation and name", () => {
    expect(role("DEFAULT_OPTIONS").roles).toEqual([
      "configuration",
      "constant",
    ]);
    expect(role("DEFAULT_OPTIONS").primaryRole).toBe("configuration");
    expect(role("StoreOptions").primaryRole).toBe("configuration");
    expect(role("LIMITS").roles).toEqual(["constant"]);
  });

  it("names contracts by callable members or implementers; other interfaces stay types", () => {
    expect(role("Store").primaryRole).toBe("contract");
    expect(role("Marker").primaryRole).toBe("contract");
    expect(role("Row").primaryRole).toBe("type");
    expect(role("Store").relations.implementers).toEqual({
      colocated: 2,
      elsewhere: 0,
    });
  });

  it("classifies schemas from the library specifier and through chains", () => {
    expect(role("UserSchema").roles).toEqual(["schema"]);
    expect(role("AdminSchema").roles).toEqual(["schema"]);
    expect(role("User").primaryRole).toBe("representation");
    expect(role("UserSchema").relations.derivedTypes).toEqual({
      colocated: 1,
      elsewhere: 0,
    });
  });

  it("names factories by construction or return of a local concept, not by either alone", () => {
    expect(role("createStore").primaryRole).toBe("factory");
    expect(role("makeRow").primaryRole).toBe("factory");
    expect(role("loadRow").primaryRole).toBe("behavior");
    expect(role("fail").primaryRole).toBe("behavior");
    expect(role("currentStore").primaryRole).toBe("behavior");
  });

  it("separates implementation, adapter, and plain behavior classes", () => {
    expect(role("MemoryStore").roles).toEqual(["implementation"]);
    expect(role("SqliteStore").roles).toEqual(["implementation", "adapter"]);
    expect(role("SqliteStore").primaryRole).toBe("adapter");
    expect(role("Counter").primaryRole).toBe("behavior");
  });

  it("derives representations from extension and marks utilities conservatively", () => {
    expect(role("ExtendedRow").primaryRole).toBe("representation");
    expect(role("trim").primaryRole).toBe("utility");
    expect(role("useHelper").primaryRole).toBe("behavior");
  });

  it("keeps values and unknowns", () => {
    expect(role("registry").primaryRole).toBe("value");
    expect(role("Ns").primaryRole).toBe("unknown");
    expect(
      report.unresolved.filter((entry) => entry.reason === "no-role-evidence")
    ).toHaveLength(1);
  });

  it("records a naming disagreement without applying it", () => {
    const disagreements = report.unresolved.filter(
      (entry) => entry.reason === "naming-disagrees"
    );
    expect(disagreements.map((entry) => entry.symbolId)).toEqual([
      "packages/p/src/a/roles.ts#FooConfig",
    ]);
    expect(role("FooConfig").evidence.roles).toContainEqual({
      detail: "FooConfig",
      kind: "naming",
      role: "configuration",
    });
  });

  it("makes private declarations module-local", () => {
    const helper = symbol(report, "src/a/roles.ts", "helper");
    expect(helper.scope).toBe("module-local");
    expect(helper.evidence.scope).toBe("structural");
    expect(helper.limitations).toEqual(["intra-module-usage-unmeasured"]);
  });

  it("counts the module's roles and colocations", () => {
    const module = getModulePrimitives(report, "src/a/roles.ts");
    expect(module?.module.composition.roles).toBe("mixed-role");
    expect(module?.module.colocations).toEqual([
      "contract+implementation",
      "schema+type",
      "type+behavior",
      "constant+behavior",
    ]);
    expect(module?.symbols.length).toBe(module?.module.symbols);
  });
});

/**
 * Three directory regions a, b, c; a root hub with a localized symbol into
 * each (a connector with three candidate regions, unresolved); and a
 * wide-dependent app module drawing from all three (also unresolved).
 * `LOCAL_B` is a constant, not a seed, so its cross-directory edge joins
 * nothing.
 */
function scopeFixture(): Record<string, string> {
  return {
    "src/a/a1.ts":
      importOf(
        "src/a/a1.ts",
        "src/shared.ts",
        "LocalToA, Cross, Wide, WIDE_OPTIONS, wideUtil, WIDE_LIMIT"
      ) +
      importOf("src/a/a1.ts", "src/a/a2.ts", "A2") +
      "export type A1 = [LocalToA, Cross, Wide, A2];\n" +
      "export interface AppOnly { a: number }\n" +
      "const secret = 1;\nexport const a1 = secret;\n" +
      "export const a1w = wideUtil(WIDE_OPTIONS.w + WIDE_LIMIT);\n",
    "src/a/a2.ts":
      "export interface A2 { a: string }\nexport const LOCAL_B = 1;\n",
    "src/app.ts":
      importOf("src/app.ts", "src/a/a1.ts", "AppOnly") +
      importOf("src/app.ts", "src/b/b1.ts", "B1") +
      importOf("src/app.ts", "src/c/c1.ts", "C1") +
      importOf("src/app.ts", "src/shared.ts", "OnlyApp") +
      "export type App = [AppOnly, B1, C1, OnlyApp];\n",
    "src/b/b1.ts":
      importOf(
        "src/b/b1.ts",
        "src/shared.ts",
        "LocalToB, Cross, Wide, WIDE_OPTIONS, wideUtil, WIDE_LIMIT"
      ) +
      importOf("src/b/b1.ts", "src/a/a2.ts", "LOCAL_B") +
      importOf("src/b/b1.ts", "src/b/b2.ts", "B2") +
      "export type B1 = [LocalToB, Cross, Wide, B2];\nexport const b1 = LOCAL_B;\n" +
      "export const b1w = wideUtil(WIDE_OPTIONS.w + WIDE_LIMIT);\n",
    "src/b/b2.ts": "export interface B2 { b: string }\n",
    "src/c/c1.ts":
      importOf(
        "src/c/c1.ts",
        "src/shared.ts",
        "LocalToC, Wide, WIDE_OPTIONS, wideUtil"
      ) +
      importOf("src/c/c1.ts", "src/c/c2.ts", "C2") +
      "export type C1 = [LocalToC, Wide, C2];\n" +
      "export const c1w = wideUtil(WIDE_OPTIONS.w);\n",
    "src/c/c2.ts": "export interface C2 { c: string }\n",
    "src/index.ts": 'export * from "./a/a1";\n',
    "src/shared.ts":
      "export interface LocalToA { a: string }\n" +
      "export interface LocalToB { b: string }\n" +
      "export interface LocalToC { c: string }\n" +
      "export interface Cross { x: string }\n" +
      "export interface Wide { w: string }\n" +
      "export interface OnlyApp { o: string }\n" +
      "export interface Unused { u: string }\n" +
      "export interface WideOptions { w: number }\n" +
      "export const WIDE_OPTIONS: WideOptions = { w: 1 };\n" +
      "export function wideUtil(n: number): number { return n + 1; }\n" +
      "export const WIDE_LIMIT = 3;\n",
  };
}

describe("scope", () => {
  const report = primitivesOf(scopeFixture());
  const shared = (name: string) => symbol(report, "src/shared.ts", name);

  it("leaves the hub unresolved and measures its symbols' consumer scope anyway", () => {
    expect(shared("Wide").declaration.placed).toBe(false);
    expect(shared("Wide").declaration.status).toBe("unresolved");
    expect(shared("Wide").scope).toBe("package-wide");
    expect(shared("Wide").consumers.responsibilities).toHaveLength(3);
    expect(shared("Cross").scope).toBe("cross-responsibility");
    expect(shared("Cross").consumers.responsibilities).toHaveLength(2);
    expect(shared("LocalToA").scope).toBe("responsibility-local");
    expect(shared("LocalToA").served?.declarationAgrees).toBe(false);
    expect(shared("LocalToA").limitations).toEqual(["declaration-unplaced"]);
    expect(report.policy.packageWide.threshold).toBe(3);
  });

  it("scopes configuration, utility, and constant primitives the same way", () => {
    expect(shared("WIDE_OPTIONS").roles).toEqual(["configuration", "constant"]);
    expect(shared("WIDE_OPTIONS").scope).toBe("package-wide");
    expect(shared("WideOptions").primaryRole).toBe("configuration");
    expect(shared("wideUtil").primaryRole).toBe("utility");
    expect(shared("wideUtil").scope).toBe("package-wide");
    expect(shared("WIDE_LIMIT").primaryRole).toBe("constant");
    expect(shared("WIDE_LIMIT").scope).toBe("cross-responsibility");
    expect(report.summary.matrix.configuration["package-wide"]).toBe(1);
    expect(report.summary.matrix.utility["package-wide"]).toBe(1);
    expect(report.summary.matrix.constant["cross-responsibility"]).toBe(1);
  });

  it("keeps V13.2's own label beside the measured scope", () => {
    expect(shared("Wide").responsibilityContext).toBe("unplaced");
    expect(shared("LocalToA").responsibilityContext).toBe("unplaced");
  });

  it("is unplaced only when neither the declaration nor any consumer is placed", () => {
    expect(shared("OnlyApp").scope).toBe("unplaced");
    expect(shared("OnlyApp").consumers.unresolvedModules).toBe(1);
    expect(shared("OnlyApp").evidence.scope).toBe("none");
  });

  it("is unclear without internal or placed consumers", () => {
    expect(shared("Unused").scope).toBe("unclear");
    expect(shared("Unused").limitations).toContain("no-internal-consumers");
    const appOnly = symbol(report, "src/a/a1.ts", "AppOnly");
    expect(appOnly.declaration.placed).toBe(true);
    expect(appOnly.scope).toBe("unclear");
    expect(appOnly.limitations).toEqual(["unresolved-consumers"]);
    const reasons = report.unresolved
      .filter(
        (entry) =>
          entry.symbolId.endsWith("#Unused") ||
          entry.symbolId.endsWith("#AppOnly")
      )
      .map((entry) => entry.reason);
    expect(reasons).toEqual(["no-placed-consumers", "no-internal-consumers"]);
  });

  it("sees a symbol declared in one responsibility and used in another as local to the consumer", () => {
    const localB = symbol(report, "src/a/a2.ts", "LOCAL_B");
    expect(localB.scope).toBe("responsibility-local");
    expect(localB.declaration.placed).toBe(true);
    expect(localB.served?.declarationAgrees).toBe(false);
    expect(localB.served?.responsibility).not.toBe(
      localB.declaration.responsibility
    );
    expect(localB.placement.directory).toBe("outside-responsibility");
    const a2 = symbol(report, "src/a/a2.ts", "A2");
    expect(a2.served?.declarationAgrees).toBe(true);
    expect(a2.evidence.scope).toBe("complete");
  });

  it("describes the hub as a mixed-scope primitive hub with a role basename", () => {
    const hub = getModulePrimitives(report, "src/shared.ts")?.module;
    expect(hub?.status).toBe("unresolved");
    expect(hub?.ambiguity).toBe("distributed-primitive");
    expect(hub?.composition).toMatchObject({
      roles: "mixed-role",
      scopeGroups: 5,
      scopes: "mixed-scope",
    });
    expect(hub?.shapes).toEqual(["primitive-hub"]);
    expect(hub?.fragmentation).toEqual({
      crossResponsibility: 2,
      localGroups: 3,
      packageWide: 3,
      unclear: 2,
      unplaced: 1,
    });
    expect(hub?.roleBasename).toBe(true);
    expect(report.summary.misleadingRoleBasenames).toBe(1);
    expect(report.summary.unresolvedModules).toMatchObject({
      explained: 1,
      mixedScope: 1,
      total: 2,
      unexplained: 1,
    });
  });

  it("keeps an aggregator an aggregator", () => {
    const index = getModulePrimitives(report, "src/index.ts")?.module;
    expect(index?.shapes).toEqual(["aggregator"]);
  });

  it("fills the role × scope matrix", () => {
    expect(report.summary.matrix.type["package-wide"]).toBe(1);
    expect(report.summary.matrix.type["cross-responsibility"]).toBe(1);
    expect(report.summary.byScope["module-local"]).toBe(1);
    expect(report.summary.byScope.unplaced).toBe(1);
  });
});

/**
 * Seven directory regions. In a, b, c, g the contract sits in a dedicated
 * `contracts.ts` (g's one directory deeper); in d, e, f it sits beside its
 * implementation. One schema alone is insufficient evidence.
 */
function conventionFixture(): Record<string, string> {
  const files: Record<string, string> = {
    "src/index.ts": 'export * from "./a/use";\n',
  };
  for (const dir of ["a", "b", "c", "g"]) {
    const contracts =
      dir === "g" ? `src/${dir}/inner/contracts.ts` : `src/${dir}/contracts.ts`;
    files[contracts] = `export interface Port${dir} { run(): void }\n`;
    files[`src/${dir}/impl.ts`] =
      importOf(`src/${dir}/impl.ts`, contracts, `Port${dir}`) +
      `export class Impl${dir} implements Port${dir} { run(): void {} }\n`;
    files[`src/${dir}/use.ts`] =
      importOf(`src/${dir}/use.ts`, contracts, `Port${dir}`) +
      importOf(`src/${dir}/use.ts`, `src/${dir}/impl.ts`, `Impl${dir}`) +
      `export const use${dir}: Port${dir} = new Impl${dir}();\n`;
  }
  for (const dir of ["d", "e", "f"]) {
    files[`src/${dir}/impl.ts`] =
      `export interface Port${dir} { run(): void }\n` +
      `export class Impl${dir} implements Port${dir} { run(): void {} }\n`;
    files[`src/${dir}/use.ts`] =
      importOf(
        `src/${dir}/use.ts`,
        `src/${dir}/impl.ts`,
        `Port${dir}, Impl${dir}`
      ) + `export const use${dir}: Port${dir} = new Impl${dir}();\n`;
  }
  files["src/f/schema.ts"] =
    'import { z } from "zod";\nexport const OnlySchema = z.object({});\n';
  files["src/f/use.ts"] =
    (files["src/f/use.ts"] ?? "") +
    importOf("src/f/use.ts", "src/f/schema.ts", "OnlySchema") +
    "export const parsed = OnlySchema.parse({});\n";
  return files;
}

describe("conventions", () => {
  const report = primitivesOf(conventionFixture());

  it("finds competing module placements for responsibility-local contracts", () => {
    const group = report.conventionGroups.find(
      (entry) =>
        entry.role === "contract" && entry.scope === "responsibility-local"
    );
    expect(group?.symbols).toBe(7);
    expect(group?.dimensions.module.status).toBe("competing");
    expect(group?.dimensions.module.values).toEqual([
      { symbols: 4, value: "dedicated-role-module" },
      { symbols: 3, value: "mixed-role-module" },
    ]);
    const dedicated = getConventions(
      report,
      "contract",
      "responsibility-local"
    ).find((convention) => convention.value === "dedicated-role-module");
    expect(dedicated?.support).toMatchObject({
      modules: 4,
      responsibilities: 4,
      symbols: 4,
    });
    expect(dedicated?.exceptions.symbols).toBe(3);
    expect(dedicated?.provenance.basenames).toEqual([
      { basename: "contracts", symbols: 4 },
    ]);
  });

  it("finds one directory convention with one clear exception", () => {
    const group = report.conventionGroups.find(
      (entry) =>
        entry.role === "contract" && entry.scope === "responsibility-local"
    );
    expect(group?.dimensions.directory.status).toBe("convention");
    // g's contract sits alone in `g/inner`, a directory dedicated to contracts.
    expect(group?.dimensions.directory.values).toEqual([
      { symbols: 6, value: "responsibility-root" },
      { symbols: 1, value: "dedicated-role-directory" },
    ]);
    const convention = report.conventions.find(
      (entry) =>
        entry.id ===
        "contract/responsibility-local/directory=responsibility-root"
    );
    expect(convention?.exceptions).toEqual({
      symbolIds: ["packages/p/src/g/inner/contracts.ts#Portg"],
      symbols: 1,
    });
  });

  it("names colocation with behavior as a separate dimension", () => {
    const group = report.conventionGroups.find(
      (entry) =>
        entry.role === "contract" && entry.scope === "responsibility-local"
    );
    expect(group?.dimensions.colocation.status).toBe("competing");
    expect(getSymbolsByRole(report, "implementation")).toHaveLength(7);
  });

  it("leaves one example as insufficient evidence", () => {
    const group = report.conventionGroups.find(
      (entry) =>
        entry.role === "schema" && entry.scope === "responsibility-local"
    );
    expect(group?.symbols).toBe(1);
    expect(group?.dimensions.module.status).toBe("insufficient-evidence");
    expect(group?.dimensions.module.conventions).toEqual([]);
  });

  it("groups by role alone as well, for comparison", () => {
    const alone = report.conventionGroups.find(
      (entry) => entry.role === "contract" && entry.scope === "any"
    );
    expect(alone?.symbols).toBe(7);
    expect(report.summary.conventions.roleAlone.observed).toBeGreaterThan(0);
    expect(report.summary.conventions.roleAndScope.observed).toBeGreaterThan(0);
  });

  it("renders", () => {
    const text = renderPrimitiveConventions(report);
    expect(text).toContain("PRIMITIVES & CONVENTIONS");
    expect(text).toContain("ROLE × SCOPE");
    expect(text).toContain("STRONGEST CONVENTIONS");
    expect(text).toContain(
      "contract · responsibility-local · directory = responsibility-root"
    );
    expect(text).not.toContain("responsibilitys");
  });
});

describe("independence", () => {
  const files = scopeFixture();

  it("is byte-identical across workspaces, consumers, Git histories, and clocks", () => {
    const alone = JSON.stringify(primitivesOf(files));
    const crowded = JSON.stringify(
      primitivesOf(files, {
        "packages/q/package.json": JSON.stringify({ name: "@f/q" }),
        "packages/q/src/index.ts":
          'import { a1 } from "@f/p";\nexport const q = a1;\n',
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
    const responsibilities = analyzeInternalResponsibilities(
      local,
      topology,
      locality
    );
    const first = JSON.stringify(
      analyzePrimitiveConventions(local, topology, locality, responsibilities)
    );
    expect(
      JSON.stringify(
        analyzePrimitiveConventions(local, topology, locality, responsibilities)
      )
    ).toBe(first);
    const shuffled = JSON.stringify(
      analyzePrimitiveConventions(
        {
          ...local,
          conceptSeeds: [...local.conceptSeeds].reverse(),
          declarations: [...local.declarations].reverse(),
          localComplexity: {
            ...local.localComplexity,
            functions: [...local.localComplexity.functions].reverse(),
          },
          symbols: [...local.symbols].reverse(),
        },
        { ...topology, directories: [...topology.directories].reverse() },
        { ...locality, symbols: [...locality.symbols].reverse() },
        {
          ...responsibilities,
          modules: [...responsibilities.modules].reverse(),
          regions: [...responsibilities.regions].reverse(),
          symbols: [...responsibilities.symbols].reverse(),
          unresolved: [...responsibilities.unresolved].reverse(),
        }
      )
    );
    expect(shuffled).toBe(first);
    expect(first).not.toContain(root);
    expect(first).not.toContain(os.tmpdir());
  });

  it("leaves its inputs untouched", () => {
    const root = workspace(files);
    const local = analyzePackageLocal({ root, target: "packages/p" });
    const topology = analyzeInternalPackageTopology(local);
    const locality = analyzeSymbolLocality(local, topology);
    const responsibilities = analyzeInternalResponsibilities(
      local,
      topology,
      locality
    );
    const before = [local, topology, locality, responsibilities].map((input) =>
      JSON.stringify(input)
    );
    analyzePrimitiveConventions(local, topology, locality, responsibilities);
    expect(
      [local, topology, locality, responsibilities].map((input) =>
        JSON.stringify(input)
      )
    ).toEqual(before);
  });
});
