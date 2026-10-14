import type { Commit, Strategy } from "release-please";
import type {
  CandidateReleasePullRequest,
  RepositoryConfig,
} from "release-please/build/src/manifest";
import { ManifestPlugin } from "release-please/build/src/plugin";
import type { Release } from "release-please/build/src/release";
import type { Scm } from "release-please/build/src/scm";
import { RawContent } from "release-please/build/src/updaters/raw-content";
import { bundledPaths, readReleaseCommits } from "./history";
import { buildReleaseLockfile } from "./lockfile";
import { discoverWorkspaces } from "./release";

export class WorkspacePlugin extends ManifestPlugin {
  private readonly root: string;

  constructor(
    github: Scm,
    branch: string,
    config: RepositoryConfig,
    root: string
  ) {
    super(github, branch, config);
    this.root = root;
  }

  override async preconfigure(
    strategies: Record<string, Strategy>,
    commits: Record<string, Commit[]>,
    releases: Record<string, Release>
  ): Promise<Record<string, Strategy>> {
    const workspaces = discoverWorkspaces(this.root);
    for (const path of Object.keys(strategies)) {
      if (path.startsWith("apps/")) {
        // Libraries may have released since the app. Use the app's own boundary.
        commits[path] = readReleaseCommits(
          this.root,
          bundledPaths(path, workspaces),
          releases[path]?.sha
        );
      }
    }
    return strategies;
  }

  override async run(
    candidates: CandidateReleasePullRequest[]
  ): Promise<CandidateReleasePullRequest[]> {
    for (const { pullRequest } of candidates) {
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
      pullRequest.updates.push({
        createIfMissing: false,
        path: "bun.lock",
        updater: new RawContent(
          buildReleaseLockfile(this.root, pullRequest.updates)
        ),
      });
    }
    return candidates;
  }
}
