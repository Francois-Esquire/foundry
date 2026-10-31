import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { verifyReleaseArchives } from "./archives";
import { verifyReleasePackages, type Workspace } from "./release";
import type { resolveGitHubRelease } from "./resolve";

/** The workflow whose main builds and manual recoveries produce release archives. */
export const RELEASE_BUILD_WORKFLOW = ".github/workflows/ci.yml";
/** The artifact name `ci.yml` uploads `.cache/release` under. */
const RELEASE_BUILD_ARTIFACT = "release-packages";

const COMMIT = /^[0-9a-f]{40}$/;
const ARCHIVE_PATH = /^packages\/\d{3,}\/[a-zA-Z0-9._+-]+\.(?:tgz|zip)$/;

export interface WorkflowRun {
  conclusion: string | null;
  created_at: string;
  event: string;
  head_branch: string | null;
  head_repository: { full_name: string } | null;
  head_sha: string;
  html_url: string;
  id: number;
  path: string;
}

interface BuiltPackage {
  archive: string;
  directory: string;
  name: string;
  sha256: string;
  version: string;
  zip: string;
  zipSha256: string;
}

function requireRepository(): string {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) {
    throw new Error("GITHUB_REPOSITORY is required");
  }
  return repository;
}

/**
 * A successful main push or manual CI recovery at `sha`. Manual CI checks
 * that the commit belongs to main. Pull request runs never qualify.
 */
export function selectReleaseBuild(
  runs: WorkflowRun[],
  repository: string,
  sha: string
): WorkflowRun {
  const [build] = runs
    .filter(
      (run) =>
        ((run.event === "push" && run.head_branch === "main") ||
          run.event === "workflow_dispatch") &&
        run.head_sha === sha &&
        run.path === RELEASE_BUILD_WORKFLOW &&
        run.conclusion === "success" &&
        run.head_repository?.full_name === repository
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (!build) {
    throw new Error(
      `No successful CI build at ${sha}; use main CI or dispatch CI at the release tag`
    );
  }
  return build;
}

/**
 * Checks the CI-built archives in `destination` against the released
 * package identities, and narrows `packages.json` to those packages.
 */
export function verifyBuiltPackages(
  destination: string,
  expected: { name: string; version: string }[]
): BuiltPackage[] {
  if (expected.length === 0) {
    throw new Error("No released packages to collect");
  }
  const built = JSON.parse(
    readFileSync(join(destination, "packages.json"), "utf8")
  ) as BuiltPackage[];
  const selected = expected.map(({ name, version }) => {
    const artifact = built.find((pkg) => pkg.name === name);
    if (artifact?.version !== version) {
      throw new Error(`The CI build did not package ${name}@${version}`);
    }
    for (const [path, digest] of [
      [artifact.archive, artifact.sha256],
      [artifact.zip, artifact.zipSha256],
    ] as const) {
      if (
        !ARCHIVE_PATH.test(path) ||
        createHash("sha256")
          .update(readFileSync(join(destination, path)))
          .digest("hex") !== digest
      ) {
        throw new Error(`Built archive changed for ${name}@${version}`);
      }
    }
    const identity = verifyReleaseArchives({
      tarball: join(destination, artifact.archive),
      zip: join(destination, artifact.zip),
    });
    if (identity.name !== name || identity.version !== version) {
      throw new Error(`Built archive identity differs from ${name}@${version}`);
    }
    return artifact;
  });
  writeFileSync(
    join(destination, "packages.json"),
    `${JSON.stringify(selected, null, 2)}\n`
  );
  return selected;
}

/** Downloads and verifies the archives CI built and tested at `sha`. */
export function collectReleaseBuild(
  root: string,
  sha: string,
  expected: { name: string; version: string }[]
): BuiltPackage[] {
  const repository = requireRepository();
  if (!COMMIT.test(sha)) {
    throw new Error("Expected a full commit SHA");
  }
  const destination = join(root, ".cache/release");
  if (existsSync(destination)) {
    throw new Error("Remove .cache/release before collecting a build");
  }
  const runs = JSON.parse(
    execFileSync(
      "gh",
      [
        "api",
        `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&status=success&per_page=100`,
        "--jq",
        ".workflow_runs",
      ],
      { encoding: "utf8" }
    )
  ) as WorkflowRun[];
  const build = selectReleaseBuild(runs, repository, sha);
  const [artifact] = JSON.parse(
    execFileSync(
      "gh",
      [
        "api",
        `repos/${repository}/actions/runs/${build.id}/artifacts?name=${RELEASE_BUILD_ARTIFACT}`,
        "--jq",
        ".artifacts",
      ],
      { encoding: "utf8" }
    )
  ) as { expired: boolean }[];
  if (!artifact || artifact.expired) {
    throw new Error(
      `The release archives of ${build.html_url} are missing or expired; dispatch CI at the release tag, then retry attachment`
    );
  }
  mkdirSync(destination, { recursive: true });
  execFileSync(
    "gh",
    [
      "run",
      "download",
      String(build.id),
      "--repo",
      repository,
      "--name",
      RELEASE_BUILD_ARTIFACT,
      "--dir",
      destination,
    ],
    { stdio: "inherit" }
  );
  return verifyBuiltPackages(destination, expected);
}

export function downloadReleasePackages(
  root: string,
  packages: Workspace[],
  releases: ReturnType<typeof resolveGitHubRelease>["releases"]
): string[] {
  const repository = requireRepository();
  const archives = packages.map((pkg, index) => {
    const release = releases.find(({ name }) => name === pkg.manifest.name);
    if (!release || release.version !== pkg.manifest.version) {
      throw new Error(`Missing release for ${pkg.manifest.name}`);
    }
    const destination = join(
      root,
      ".cache/release/packages",
      String(index).padStart(3, "0")
    );
    mkdirSync(destination, { recursive: true });
    const basename = `${release.name.replace("@", "").replace("/", "-")}-${release.version}`;
    execFileSync(
      "gh",
      [
        "release",
        "download",
        release.tag,
        "--repo",
        repository,
        "--dir",
        destination,
        "--pattern",
        `${basename}.tgz`,
        "--pattern",
        `${basename}.zip`,
      ],
      { stdio: "inherit" }
    );
    return {
      tarball: join(destination, `${basename}.tgz`),
      zip: join(destination, `${basename}.zip`),
    };
  });
  return verifyReleasePackages(root, packages, archives);
}
