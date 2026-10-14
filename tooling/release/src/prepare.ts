import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { GitHub, Manifest } from "release-please";
import { configureLibraryGroup } from "./library-group";
import { discoverWorkspaces } from "./release";
import { WorkspacePlugin } from "./workspace-plugin";

const root = resolve(import.meta.dirname, "../../..");
const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
const token = process.env.GH_TOKEN;
if (!(owner && repo && token)) {
  throw new Error("GITHUB_REPOSITORY and GH_TOKEN are required");
}
const github = await GitHub.create({ owner, repo, token });
const manifest = await Manifest.fromManifest(github, "main");
configureLibraryGroup(manifest, discoverWorkspaces(root));
manifest.plugins.push(
  new WorkspacePlugin(github, "main", manifest.repositoryConfig, root)
);

function assertCurrentCheckout(): void {
  const head = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  const main = execFileSync(
    "gh",
    ["api", `repos/${owner}/${repo}/commits/main`, "--jq", ".sha"],
    { encoding: "utf8" }
  ).trim();
  if (head !== main) {
    throw new Error(
      "main moved after checkout; rerun release preparation on its current commit"
    );
  }
}

assertCurrentCheckout();
if (process.argv.includes("--dry-run")) {
  const proposals = await manifest.buildPullRequests();
  process.stdout.write(
    `${JSON.stringify(
      proposals.map((proposal) => ({
        body: proposal.body.toString(),
        files: proposal.updates.map((update) => update.path),
        title: proposal.title.toString(),
        version: proposal.version?.toString(),
      })),
      null,
      2
    )}\n`
  );
} else {
  const releases = await manifest.createReleases();
  if (process.env.GITHUB_OUTPUT) {
    const groups = new Map<string, string>();
    for (const release of releases) {
      if (release) {
        groups.set(
          release.path.startsWith("packages/")
            ? "libraries"
            : release.path.slice("apps/".length),
          release.version.toString()
        );
      }
    }
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `assets=${JSON.stringify([...groups].map(([pkg, version]) => ({ package: pkg, version })))}\n`
    );
  }
  assertCurrentCheckout();
  const proposals = await manifest.createPullRequests();
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Prepared ${proposals.filter(Boolean).length} release PR(s); created ${releases.filter(Boolean).length} GitHub release(s).\n\nThis workflow does not publish to npm. Review releases, then dispatch Publish Package separately.\n`
    );
  }
}
