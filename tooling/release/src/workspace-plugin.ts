import type { Commit, Strategy } from "release-please";
import type {
  CandidateReleasePullRequest,
  RepositoryConfig,
} from "release-please/build/src/manifest";
import { ManifestPlugin } from "release-please/build/src/plugin";
import { LinkedVersions } from "release-please/build/src/plugins/linked-versions";
import type { Release } from "release-please/build/src/release";
import type { Scm } from "release-please/build/src/scm";
import { PackageJson } from "release-please/build/src/updaters/node/package-json";
import { bundledPaths, readReleaseCommits } from "./history";
import { libraryGroup } from "./library-group";
import { discoverWorkspaces } from "./release";

export class WorkspacePlugin extends ManifestPlugin {
  private readonly root: string;
  private readonly libraries: LinkedVersions;

  constructor(
    github: Scm,
    branch: string,
    config: RepositoryConfig,
    root: string
  ) {
    super(github, branch, config);
    this.root = root;
    this.libraries = new LinkedVersions(
      github,
      branch,
      config,
      "libraries",
      Object.entries(config).flatMap(([path, entry]) =>
        path.startsWith("packages/") && entry.component ? [entry.component] : []
      )
    );
  }

  override async preconfigure(
    strategies: Record<string, Strategy>,
    commits: Record<string, Commit[]>,
    releases: Record<string, Release>
  ): Promise<Record<string, Strategy>> {
    const workspaces = discoverWorkspaces(this.root);
    for (const path of Object.keys(strategies)) {
      const workspace = workspaces.find(({ directory }) => directory === path);
      if (
        !(
          (path.startsWith("apps/") || path.startsWith("packages/")) &&
          workspace
        ) ||
        workspace.manifest.private === true
      ) {
        throw new Error(
          `Release component ${path} must be a public app or library workspace`
        );
      }
      // Bundled library changes belong to the app's own release history.
      commits[path] = readReleaseCommits(
        this.root,
        path.startsWith("packages/")
          ? ["packages"]
          : bundledPaths(path, workspaces),
        releases[path]?.sha
      );
    }
    return this.libraries.preconfigure(strategies, commits, releases);
  }

  override async run(
    candidates: CandidateReleasePullRequest[]
  ): Promise<CandidateReleasePullRequest[]> {
    const libraryRelease = candidates.find(({ path }) =>
      path.startsWith("packages/")
    )?.pullRequest;
    if (libraryRelease?.version) {
      const group = libraryGroup(discoverWorkspaces(this.root));
      for (const workspace of group.packages.filter(
        ({ manifest }) => manifest.private === true
      )) {
        libraryRelease.updates.push({
          createIfMissing: false,
          path: `${workspace.directory}/package.json`,
          updater: new PackageJson({ version: libraryRelease.version }),
        });
      }
    }
    const releases = await this.libraries.run(candidates);
    for (const { pullRequest } of releases) {
      const manifest = pullRequest.updates.find(
        (update) => update.path === ".release-please-manifest.json"
      );
      if (manifest) {
        const { updater } = manifest;
        // Release Please infers compact formatting from the initial empty {}.
        manifest.updater = {
          updateContent: (content) =>
            `${JSON.stringify(JSON.parse(updater.updateContent(content)), null, 2)}\n`,
        };
      }
    }
    return releases;
  }
}
