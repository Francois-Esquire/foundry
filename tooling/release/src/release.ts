import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { valid } from "semver";

interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  name: string;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  private?: boolean;
  scripts?: Record<string, string>;
  version: string;
  workspaces?: string[];
}

export interface Workspace {
  directory: string;
  manifest: Manifest;
}

function readManifest(path: string): Manifest {
  return JSON.parse(readFileSync(path, "utf8")) as Manifest;
}

export function discoverWorkspaces(root: string): Workspace[] {
  const { workspaces } = readManifest(join(root, "package.json"));
  if (!Array.isArray(workspaces)) {
    throw new Error("Expected workspace patterns in the root package.json");
  }
  const paths = new Set(
    workspaces.flatMap((pattern) =>
      [...new Glob(`${pattern}/package.json`).scanSync({ cwd: root })].sort()
    )
  );
  return [...paths].map((path) => ({
    directory: path.slice(0, -"/package.json".length),
    manifest: readManifest(join(root, path)),
  }));
}

export function publicWorkspaces(workspaces: Workspace[]): Workspace[] {
  const packages = workspaces.filter(
    ({ manifest }) => manifest.private !== true
  );
  if (packages.length === 0) {
    throw new Error("No non-private workspaces to release");
  }
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const ordered: Workspace[] = [];
  const byName = new Map(workspaces.map((pkg) => [pkg.manifest.name, pkg]));
  function visit(pkg: Workspace): void {
    const { manifest } = pkg;
    if (visited.has(manifest.name)) {
      return;
    }
    if (visiting.has(manifest.name)) {
      throw new Error(`Cyclic public dependency: ${manifest.name}`);
    }
    if (valid(manifest.version) !== manifest.version) {
      throw new Error(`Invalid version for ${manifest.name}`);
    }
    if (!manifest.scripts?.["test:package"]) {
      throw new Error(`${manifest.name} needs a test:package consumer check`);
    }
    visiting.add(manifest.name);
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    };
    for (const name of Object.keys(dependencies)) {
      const dependency = byName.get(name);
      if (!dependency) {
        continue;
      }
      if (dependency.manifest.private === true) {
        throw new Error(`${manifest.name} depends on private package ${name}`);
      }
      visit(dependency);
    }
    visiting.delete(manifest.name);
    visited.add(manifest.name);
    ordered.push(pkg);
  }
  for (const pkg of packages) {
    visit(pkg);
  }
  return ordered;
}

export function packRelease(root: string, packages: Workspace[]): string[] {
  const destination = join(root, ".cache/release");
  mkdirSync(destination, { recursive: true });
  // Refuse leftovers so a removed public package cannot enter a later release.
  for (const entry of new Glob("packages/*/package.tgz").scanSync({
    cwd: destination,
  })) {
    throw new Error(`Remove .cache/release before packing again: ${entry}`);
  }
  const digests: string[] = [];
  for (const [index, pkg] of packages.entries()) {
    const directory = join(
      destination,
      "packages",
      String(index).padStart(3, "0")
    );
    mkdirSync(directory, { recursive: true });
    const tarball = join(directory, "package.tgz");
    execFileSync(
      "bun",
      ["pm", "pack", "--ignore-scripts", "--filename", tarball],
      {
        cwd: join(root, pkg.directory),
        stdio: "inherit",
      }
    );
    const digest = createHash("sha256")
      .update(readFileSync(tarball))
      .digest("hex");
    execFileSync("bun", ["run", "test:package"], {
      cwd: join(root, pkg.directory),
      env: { ...process.env, PACKAGE_TARBALL: tarball },
      stdio: "inherit",
    });
    if (
      createHash("sha256").update(readFileSync(tarball)).digest("hex") !==
      digest
    ) {
      throw new Error(
        `Consumer check modified the tarball for ${pkg.manifest.name}`
      );
    }
    digests.push(digest);
  }
  writeFileSync(
    join(destination, "packages.json"),
    `${JSON.stringify(
      packages.map(({ directory, manifest }) => ({
        directory,
        name: manifest.name,
        version: manifest.version,
      })),
      null,
      2
    )}\n`
  );
  return digests;
}
