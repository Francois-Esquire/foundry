import { join } from "node:path";
import { expect, it } from "vitest";
import {
  importSites,
  REPO_ROOT,
  readManifest,
  sourceFiles,
} from "./helpers/boundary-scan";

it("depends only on Core and Lib within the workspace", () => {
  const manifest = readManifest(
    join(REPO_ROOT, "packages/sandbox/package.json")
  );
  expect(
    [...manifest.dependencyNames]
      .filter((name) => name.startsWith("@foundry/"))
      .sort()
  ).toEqual(["@foundry/core", "@foundry/lib", "@foundry/tsconfig"]);
  for (const name of ["core", "lib"]) {
    expect(
      readManifest(
        join(REPO_ROOT, `packages/${name}/package.json`)
      ).dependencyNames.has("@foundry/sandbox")
    ).toBe(false);
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
  const manifest = readManifest(
    join(REPO_ROOT, "packages/sandbox/package.json")
  );
  expect(
    [...manifest.dependencyNames].filter((name) => forbidden.has(name))
  ).toEqual([]);
  const files = sourceFiles(join(REPO_ROOT, "packages/sandbox/src"));
  expect(files.length).toBeGreaterThan(0);
  expect(
    importSites(files).filter((site) => forbidden.has(site.import.specifier))
  ).toEqual([]);
});
