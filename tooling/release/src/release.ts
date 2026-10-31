import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { Glob } from "bun";
import { satisfies, valid } from "semver";
import {
  createReleaseArchives,
  type ReleaseArchives,
  verifyReleaseArchives,
} from "./archives";

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

export function publicWorkspaces(
  workspaces: Workspace[],
  selected?: Workspace[]
): Workspace[] {
  const packages =
    selected ?? workspaces.filter(({ manifest }) => manifest.private !== true);
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
  const names = new Set(packages.map(({ manifest }) => manifest.name));
  return ordered.filter(({ manifest }) => names.has(manifest.name));
}

export function packRelease(root: string, packages: Workspace[]): string[] {
  const destination = join(root, ".cache/release");
  mkdirSync(destination, { recursive: true });
  for (const entry of new Glob("packages/*/*.tgz").scanSync({
    cwd: destination,
  })) {
    throw new Error(`Remove .cache/release before packing again: ${entry}`);
  }
  const archives = packages.map((pkg, index) =>
    createReleaseArchives(
      join(root, pkg.directory),
      join(destination, "packages", String(index).padStart(3, "0"))
    )
  );
  return verifyReleasePackages(root, packages, archives);
}

/**
 * Bun packs `workspace:` ranges from bun.lock, which can keep a workspace's
 * previous version after a release bump. A packed dependency on a package
 * released alongside it must accept the version being released.
 */
function checkReleasedRanges(tarball: string, packages: Workspace[]): void {
  const packed = JSON.parse(
    execFileSync("tar", ["-xOzf", tarball, "package/package.json"], {
      encoding: "utf8",
    })
  ) as Manifest;
  const ranges = {
    ...packed.dependencies,
    ...packed.optionalDependencies,
    ...packed.peerDependencies,
  };
  for (const { manifest } of packages) {
    const range = ranges[manifest.name];
    if (range !== undefined && !satisfies(manifest.version, range)) {
      throw new Error(
        `${packed.name} requires ${manifest.name}@${range}, not the released ${manifest.version}`
      );
    }
  }
}

export function verifyReleasePackages(
  root: string,
  packages: Workspace[],
  archives: ReleaseArchives[]
): string[] {
  const destination = join(root, ".cache/release");
  const artifacts = packages.map((pkg, index) => {
    const archive = archives[index];
    if (!archive) {
      throw new Error(`Missing archives for ${pkg.manifest.name}`);
    }
    const identity = verifyReleaseArchives(archive);
    if (
      identity.name !== pkg.manifest.name ||
      identity.version !== pkg.manifest.version
    ) {
      throw new Error(
        `Archive identity differs from ${pkg.manifest.name}@${pkg.manifest.version}`
      );
    }
    checkReleasedRanges(archive.tarball, packages);
    return {
      archive: relative(destination, archive.tarball),
      directory: pkg.directory,
      name: identity.name,
      sha256: createHash("sha256")
        .update(readFileSync(archive.tarball))
        .digest("hex"),
      version: identity.version,
      zip: relative(destination, archive.zip),
      zipSha256: createHash("sha256")
        .update(readFileSync(archive.zip))
        .digest("hex"),
    };
  });
  const tarballs = Object.fromEntries(
    artifacts.map(({ name, archive }) => [name, join(destination, archive)])
  );
  for (const pkg of packages) {
    execFileSync("bun", ["run", "test:package"], {
      cwd: join(root, pkg.directory),
      env: {
        ...process.env,
        PACKAGE_TARBALL: tarballs[pkg.manifest.name],
        PACKAGE_TARBALLS: JSON.stringify(tarballs),
      },
      stdio: "inherit",
    });
  }
  for (const artifact of artifacts) {
    for (const [path, expected] of [
      [artifact.archive, artifact.sha256],
      [artifact.zip, artifact.zipSha256],
    ] as const) {
      if (
        createHash("sha256")
          .update(readFileSync(join(destination, path)))
          .digest("hex") !== expected
      ) {
        throw new Error(
          `Consumer check modified the tarball or ZIP for ${artifact.name}`
        );
      }
    }
  }
  writeFileSync(
    join(destination, "packages.json"),
    `${JSON.stringify(artifacts, null, 2)}\n`
  );
  return artifacts.map(({ sha256 }) => sha256);
}
