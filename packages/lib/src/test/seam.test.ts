import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import libPackageJson from "../../package.json";
import {
  assertWebStandardExports,
  auditWebStandardExports,
} from "../testing/seam";

const LIB_DIR = resolve(import.meta.dirname, "../..");
const CORE_DIR = resolve(LIB_DIR, "../core");
const PROMPTS_DIR = resolve(LIB_DIR, "../prompts");
const TASKS_DIR = resolve(LIB_DIR, "../tasks");
const WORKFLOWS_DIR = resolve(LIB_DIR, "../workflows");

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

describe("@foundry/lib/testing/seam", () => {
  it("passes on all @foundry/core subpaths", () => {
    expect(() =>
      assertWebStandardExports(CORE_DIR, [
        "./agents",
        "./pagination",
        "./storage",
        "./testing/storage",
      ])
    ).not.toThrow();
  });

  it("passes on all portable @foundry/lib subpaths (including conditional async-scope and turns)", () => {
    const portableSubpaths = Object.keys(libPackageJson.exports).filter(
      (subpath) =>
        !(subpath.startsWith("./node/") || subpath.startsWith("./testing/"))
    );
    expect(portableSubpaths).toContain("./async-scope");
    expect(portableSubpaths).toContain("./emitter");
    expect(portableSubpaths).toContain("./turns");
    expect(() =>
      assertWebStandardExports(LIB_DIR, portableSubpaths)
    ).not.toThrow();
  });

  it("passes on @foundry/prompts, @foundry/tasks, and @foundry/workflows portable subpaths", () => {
    expect(() => assertWebStandardExports(PROMPTS_DIR, ["."])).not.toThrow();
    expect(() =>
      assertWebStandardExports(TASKS_DIR, [".", "./store", "./store/memory"])
    ).not.toThrow();
    expect(() =>
      assertWebStandardExports(WORKFLOWS_DIR, [
        ".",
        "./workflow",
        "./step",
        "./queue-handler",
      ])
    ).not.toThrow();
  });

  it("flags wildcard exports, node:* imports, /node subpaths, and unguarded globals while ignoring typeof guards", () => {
    const dir = mkdtempSync(join(tmpdir(), "seam-audit-"));
    tempDirs.push(dir);
    writeFileSync(
      join(dir, "src-helper.ts"),
      `import { readFileSync } from "node:fs";
import { thisProcess } from "@foundry/lib/node/process-identity";
export const guarded = typeof process !== "undefined" && process.env.OK === "1";
export const unguarded = process.env.SECRET;
export const buf = Buffer.from("x");
export { readFileSync, thisProcess };
`
    );
    writeFileSync(
      join(dir, "index.ts"),
      `export * from "./src-helper";\nexport * from "./missing-file";\nexport * from "@foundry/core/does-not-exist";\n`
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({
        exports: {
          ".": { default: "./index.ts", import: "./index.ts" },
          "./*": "./*.ts",
        },
        name: "@foundry/fake-pkg",
      })
    );

    const violations = auditWebStandardExports(dir, ["."]);
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('wildcard export "./*"'),
        expect.stringContaining('forbidden node:* import "node:fs"'),
        expect.stringContaining(
          'forbidden /node subpath import "@foundry/lib/node/process-identity"'
        ),
        expect.stringContaining('unguarded Node/Bun global "process"'),
        expect.stringContaining('unguarded Node/Bun global "Buffer"'),
        expect.stringContaining('unresolved relative import "./missing-file"'),
        expect.stringContaining(
          'unresolved workspace import "@foundry/core/does-not-exist"'
        ),
      ])
    );
    expect(
      violations.filter((entry) => entry.includes('"process"'))
    ).toHaveLength(1);
    expect(() => assertWebStandardExports(dir, ["."])).toThrow(
      "Web-standard export seam violations:"
    );
  });
});
