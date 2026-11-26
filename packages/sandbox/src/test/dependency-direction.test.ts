import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseModuleImports, sourceFiles } from "@foundry/lib/testing/seam";
import { expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

function dependencyNames(packageName: string): string[] {
  const manifest = JSON.parse(
    readFileSync(
      join(REPO_ROOT, `packages/${packageName}/package.json`),
      "utf8"
    )
  ) as Partial<
    Record<(typeof DEPENDENCY_FIELDS)[number], Record<string, string>>
  >;
  return [
    ...new Set(
      DEPENDENCY_FIELDS.flatMap((field) => Object.keys(manifest[field] ?? {}))
    ),
  ];
}

it("depends only on Core and Lib within the workspace", () => {
  expect(
    dependencyNames("sandbox")
      .filter((name) => name.startsWith("@foundry/"))
      .sort()
  ).toEqual(["@foundry/core", "@foundry/lib", "@foundry/tsconfig"]);
  for (const name of ["core", "lib"]) {
    expect(dependencyNames(name)).not.toContain("@foundry/sandbox");
  }
});

it("keeps browser and daemon providers out of the portable sandbox", () => {
  const forbidden = new Set([
    "@webcontainer/api",
    "dockerode",
    "tar-stream",
    "@types/dockerode",
    "@types/tar-stream",
  ]);
  expect(
    dependencyNames("sandbox").filter((name) => forbidden.has(name))
  ).toEqual([]);
  const files = sourceFiles(join(REPO_ROOT, "packages/sandbox/src"));
  expect(files.length).toBeGreaterThan(0);
  expect(
    files.flatMap((path) =>
      parseModuleImports(path)
        .filter(({ specifier }) => forbidden.has(specifier))
        .map(({ line, specifier }) => `${path}:${line} imports ${specifier}`)
    )
  ).toEqual([]);
});
