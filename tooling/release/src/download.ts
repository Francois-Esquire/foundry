import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { verifyReleasePackages, type Workspace } from "./release";
import type { resolveGitHubRelease } from "./resolve";

export function downloadReleasePackages(
  root: string,
  packages: Workspace[],
  releases: ReturnType<typeof resolveGitHubRelease>["releases"]
): string[] {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) {
    throw new Error("GITHUB_REPOSITORY is required");
  }
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
