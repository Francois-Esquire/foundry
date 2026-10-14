import { execFileSync } from "node:child_process";
import { Glob } from "bun";
import { lt, prerelease, rcompare, valid } from "semver";
import { libraryGroup } from "./library-group";
import {
  discoverWorkspaces,
  publicWorkspaces,
  type Workspace,
} from "./release";

export interface ReleasePackage {
  component: string;
  directory: string;
  name: string;
}

// Publication is opt-in even when another workspace has private: false.
const PUBLISH_PACKAGES: ReleasePackage[] = [
  {
    component: "marbles",
    directory: "apps/marbles",
    name: "@foundry.sh/marbles",
  },
  {
    component: "spyglass",
    directory: "apps/spyglass",
    name: "@foundry/spyglass",
  },
  { component: "libraries", directory: "packages", name: "libraries" },
];

export function selectReleaseWorkspaces(
  workspaces: Workspace[],
  target: ReleasePackage,
  version?: string
): Workspace[] {
  if (target.component === "libraries") {
    const group = libraryGroup(workspaces);
    if (group.publicPackages.length === 0) {
      throw new Error(
        "Libraries are private; there is no public library release"
      );
    }
    if (version && group.version !== version) {
      throw new Error(`Library group version must be ${version}`);
    }
    return publicWorkspaces(workspaces, group.publicPackages);
  }
  const workspace = workspaces.find(
    ({ directory }) => directory === target.directory
  );
  if (!workspace) {
    throw new Error(
      `Missing public package ${target.name} at ${target.directory}`
    );
  }
  validatePackageVersion(
    workspace.manifest,
    target,
    version ?? workspace.manifest.version
  );
  return publicWorkspaces(workspaces, [workspace]);
}

export interface GitHubRelease {
  draft: boolean;
  html_url: string;
  id: number;
  prerelease: boolean;
  published_at: string | null;
  tag_name: string;
}

export function resolvePackage(input: string): ReleasePackage {
  const target = PUBLISH_PACKAGES.find(
    (pkg) => pkg.component === input || pkg.name === input
  );
  if (!target) {
    throw new Error(`Package is not enabled for publication: ${input}`);
  }
  return target;
}

export function selectRelease(
  target: ReleasePackage,
  releases: GitHubRelease[],
  requestedVersion?: string
) {
  if (requestedVersion && valid(requestedVersion) !== requestedVersion) {
    throw new Error("Version must be an exact SemVer, or empty for latest");
  }
  const prefix = `${target.component}-v`;
  const candidates = releases.flatMap((release) => {
    if (
      release.draft ||
      !release.published_at ||
      !release.tag_name.startsWith(prefix)
    ) {
      return [];
    }
    const version = release.tag_name.slice(prefix.length);
    return valid(version) === version ? [{ release, version }] : [];
  });
  candidates.sort((a, b) => rcompare(a.version, b.version));
  const selected = requestedVersion
    ? candidates.find(({ version }) => version === requestedVersion)
    : candidates[0];
  if (!selected) {
    throw new Error(
      `No published GitHub release for ${target.name}@${requestedVersion || "latest"}`
    );
  }
  const alpha = lt(selected.version, "0.1.0-0");
  if ((alpha || prerelease(selected.version)) && !selected.release.prerelease) {
    throw new Error(
      `Release ${selected.release.tag_name} must be marked as a prerelease`
    );
  }
  let distTag = "latest";
  if (alpha) {
    distTag = "alpha";
  } else if (selected.release.prerelease) {
    distTag = "next";
  }
  return { ...selected, distTag };
}

export function selectReleaseGroup(
  target: ReleasePackage,
  workspaces: Workspace[],
  releases: GitHubRelease[],
  version?: string
) {
  if (target.component !== "libraries") {
    return [{ ...selectRelease(target, releases, version), target }];
  }
  const group = libraryGroup(workspaces);
  if (group.publicPackages.length === 0) {
    throw new Error(
      "Libraries are private; there is no public library release"
    );
  }
  const targets = group.publicPackages.map(({ directory, manifest }) => ({
    component: directory.slice("packages/".length),
    directory,
    name: manifest.name,
  }));
  const [first] = targets;
  if (!first) {
    throw new Error("No public libraries");
  }
  const selected = selectRelease(first, releases, version);
  return targets.map((member) => {
    const release = selectRelease(member, releases, selected.version);
    if (release.distTag !== selected.distTag) {
      throw new Error("Linked library release channels must match");
    }
    return { ...release, target: member };
  });
}

function validatePackageVersion(
  manifest: { name: string; version: string; private?: boolean },
  target: ReleasePackage,
  version: string
): void {
  if (
    manifest.private === true ||
    manifest.name !== target.name ||
    manifest.version !== version
  ) {
    throw new Error(`Release must contain public ${target.name}@${version}`);
  }
}

export function resolveGitHubRelease(
  root: string,
  input: string,
  version?: string
) {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) {
    throw new Error("GITHUB_REPOSITORY is required to resolve a release");
  }
  const target = resolvePackage(input);
  const pages = JSON.parse(
    execFileSync(
      "gh",
      [
        "api",
        "--paginate",
        "--slurp",
        `repos/${repository}/releases?per_page=100`,
      ],
      { encoding: "utf8" }
    )
  ) as GitHubRelease[][];
  const selections = selectReleaseGroup(
    target,
    discoverWorkspaces(root),
    pages.flat(),
    version
  );
  const releases = selections.map(({ target: member, ...selection }) => ({
    directory: member.directory,
    id: selection.release.id,
    name: member.name,
    prerelease: selection.release.prerelease,
    sha: resolveReleaseCommit(
      root,
      member,
      selection.release.tag_name,
      selection.version
    ),
    tag: selection.release.tag_name,
    version: selection.version,
  }));
  const [selected] = selections;
  const [first] = releases;
  if (!(selected && first)) {
    throw new Error("No selected releases");
  }
  if (releases.some((release) => release.sha !== first.sha)) {
    throw new Error("Linked library releases must identify the same commit");
  }
  const packages = releasedPackages(root, target, first.sha, selected.version);
  const names = (members: { name: string }[]) =>
    members
      .map(({ name }) => name)
      .sort()
      .join("\n");
  if (names(packages) !== names(releases)) {
    throw new Error(
      "Released library membership differs from the selected group"
    );
  }
  return { ...selected, packages, releases, sha: first.sha, target };
}

function releasedPackages(
  root: string,
  target: ReleasePackage,
  sha: string,
  version: string
) {
  const read = (path: string) =>
    execFileSync("git", ["show", `${sha}:${path}`], {
      cwd: root,
      encoding: "utf8",
    });
  if (target.component !== "libraries") {
    const manifest = JSON.parse(read(`${target.directory}/package.json`));
    validatePackageVersion(manifest, target, version);
    return [{ name: target.name, version }];
  }
  const { workspaces } = JSON.parse(read("package.json")) as {
    workspaces: string[];
  };
  const patterns = workspaces.map(
    (pattern) => new Glob(`${pattern}/package.json`)
  );
  const paths = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", sha, "packages"],
    { cwd: root, encoding: "utf8" }
  )
    .trim()
    .split("\n");
  const libraries = paths
    .filter((path) => patterns.some((pattern) => pattern.match(path)))
    .map((path) => ({
      directory: path.slice(0, -"/package.json".length),
      manifest: JSON.parse(read(path)),
    }));
  return selectReleaseWorkspaces(libraries, target, version).map(
    ({ manifest }) => ({ name: manifest.name, version: manifest.version })
  );
}

export function resolveReleaseCommit(
  root: string,
  target: ReleasePackage,
  tag: string,
  version: string
): string {
  const sha = execFileSync(
    "git",
    ["rev-parse", "--verify", `refs/tags/${tag}^{commit}`],
    { cwd: root, encoding: "utf8" }
  ).trim();
  execFileSync("git", ["merge-base", "--is-ancestor", sha, "origin/main"], {
    cwd: root,
  });
  releasedPackages(root, target, sha, version);
  return sha;
}
