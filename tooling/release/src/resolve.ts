import { execFileSync } from "node:child_process";
import { lt, prerelease, rcompare, valid } from "semver";

export interface ReleasePackage {
  component: string;
  directory: string;
  name: string;
}

// Publication is opt-in even when another workspace has private: false.
const PUBLISH_PACKAGES: ReleasePackage[] = [
  { component: "marbles", directory: "apps/marbles", name: "@foundry/marbles" },
];

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

export function validatePackageVersion(
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
  const selected = selectRelease(target, pages.flat(), version);
  const sha = resolveReleaseCommit(
    root,
    target,
    selected.release.tag_name,
    selected.version
  );
  return { ...selected, sha, target };
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
  const manifest = JSON.parse(
    execFileSync("git", ["show", `${sha}:${target.directory}/package.json`], {
      cwd: root,
      encoding: "utf8",
    })
  );
  validatePackageVersion(manifest, target, version);
  return sha;
}
