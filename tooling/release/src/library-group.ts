import type { Manifest } from "release-please";
import { valid } from "semver";
import type { Workspace } from "./release";

export function libraryGroup(workspaces: Workspace[]) {
  const packages = workspaces.filter(({ directory }) =>
    directory.startsWith("packages/")
  );
  const version = packages[0]?.manifest.version;
  if (
    !version ||
    valid(version) !== version ||
    packages.some(({ manifest }) => manifest.version !== version)
  ) {
    throw new Error(
      "All libraries must have the same version (a valid SemVer)"
    );
  }
  return {
    packages,
    publicPackages: packages.filter(
      ({ manifest }) => manifest.private !== true
    ),
    version,
  };
}

export function configureLibraryGroup(
  manifest: Manifest,
  workspaces: Workspace[]
): void {
  const group = libraryGroup(workspaces);
  for (const { directory, manifest: pkg } of group.packages) {
    // Private libraries never get release components, tags, or GitHub Releases.
    if (pkg.private === true) {
      delete manifest.repositoryConfig[directory];
    } else {
      manifest.repositoryConfig[directory] = {
        component: directory.slice("packages/".length),
        includeComponentInTag: true,
        initialVersion: group.version,
        releaseType: "node",
      };
    }
  }
}
