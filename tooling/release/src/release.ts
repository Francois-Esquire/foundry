import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Glob } from "bun";
import { ConventionalChangelog } from "conventional-changelog";
import conventionalCommits from "conventional-changelog-conventionalcommits";
import { valid } from "semver";

interface Manifest {
  dependencies?: Record<string, string>;
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

const RELEASE_HEADING = /^#{1,2}\s+\[?([^\]\s(]+)/;
const SECTION_HEADING = /^#{1,2}\s/;
const REPOSITORY = "https://github.com/Francois-Esquire/foundry";

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

export function releaseVersion(packages: Workspace[]): string {
  const version = packages[0]?.manifest.version;
  if (!version || packages.some((pkg) => pkg.manifest.version !== version)) {
    throw new Error("All public packages must share the release version");
  }
  return version;
}

export function validateTag(
  version: string,
  refType?: string,
  tag?: string
): void {
  if (refType !== "tag" || tag !== `v${version}`) {
    throw new Error(`Run this workflow from the release tag v${version}`);
  }
}

export function extractReleaseNotes(
  changelog: string,
  version: string
): string {
  const lines = changelog.split("\n");
  const start = lines.findIndex(
    (line) => RELEASE_HEADING.exec(line)?.[1] === version
  );
  if (start < 0) {
    throw new Error(`No changelog entry for ${version}`);
  }
  const next = lines.findIndex(
    (line, index) => index > start && SECTION_HEADING.test(line)
  );
  const section = lines.slice(start, next < 0 ? undefined : next);
  if (!section.slice(1).join("\n").trim()) {
    throw new Error(`Empty changelog entry for ${version}`);
  }
  return `${section.join("\n").trim()}\n`;
}

export async function generateChangelog(
  root: string,
  packages: Workspace[]
): Promise<void> {
  const generator = new ConventionalChangelog(root)
    .config(conventionalCommits())
    .package({ version: releaseVersion(packages) })
    .context({
      host: "https://github.com",
      owner: "Francois-Esquire",
      repository: "foundry",
    })
    .repository(`${REPOSITORY}.git`)
    .tags({ prefix: "v" })
    .options({ releaseCount: 0 });
  let changelog = "";
  for await (const section of generator.write()) {
    changelog += section;
  }
  extractReleaseNotes(changelog, releaseVersion(packages));
  writeFileSync(join(root, "CHANGELOG.md"), changelog);
  for (const pkg of packages) {
    writeFileSync(join(root, pkg.directory, "CHANGELOG.md"), changelog);
  }
}

export function packRelease(root: string, packages: Workspace[]): void {
  const destination = join(root, ".cache/release");
  mkdirSync(destination, { recursive: true });
  // Refuse leftovers so a removed public package cannot enter a later release.
  for (const entry of new Glob("packages/*/package.tgz").scanSync({
    cwd: destination,
  })) {
    throw new Error(`Remove .cache/release before packing again: ${entry}`);
  }
  writeFileSync(
    join(destination, "release-notes.md"),
    extractReleaseNotes(
      readFileSync(join(root, "CHANGELOG.md"), "utf8"),
      releaseVersion(packages)
    )
  );
  for (const [index, pkg] of packages.entries()) {
    const directory = join(
      destination,
      "packages",
      String(index).padStart(3, "0")
    );
    mkdirSync(directory, { recursive: true });
    execFileSync(
      "bun",
      [
        "pm",
        "pack",
        "--ignore-scripts",
        "--filename",
        join(directory, "package.tgz"),
      ],
      {
        cwd: join(root, pkg.directory),
        stdio: "inherit",
      }
    );
    execFileSync("bun", ["run", "test:package"], {
      cwd: join(root, pkg.directory),
      env: { ...process.env, PACKAGE_TARBALL: join(directory, "package.tgz") },
      stdio: "inherit",
    });
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
}
