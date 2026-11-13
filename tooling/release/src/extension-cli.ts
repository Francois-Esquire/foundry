import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { valid } from "semver";
import { selectReleaseBuild, type WorkflowRun } from "./download";
import { missingExtensionAssets, verifyExtension } from "./extension";

/** The artifact name `ci.yml` uploads the extension's VSIX and record under. */
const EXTENSION_BUILD_ARTIFACT = "release-extension";

const repository = process.env.GITHUB_REPOSITORY;
const version = process.env.RELEASE_VERSION;
if (!(repository && version) || valid(version) !== version) {
  throw new Error(
    "GITHUB_REPOSITORY and an exact RELEASE_VERSION are required"
  );
}
const tag = `vscode-extension-v${version}`;
function gh(...args: string[]): string {
  return execFileSync("gh", args, { encoding: "utf8" }).trim();
}
const release = JSON.parse(
  gh("api", `repos/${repository}/releases/tags/${tag}`)
);
if (release.draft || !release.published_at || release.tag_name !== tag) {
  throw new Error("Expected a published extension GitHub release");
}
const sha = gh("api", `repos/${repository}/commits/${tag}`, "--jq", ".sha");
// Throws unless the tagged commit belongs to main.
execFileSync("git", ["merge-base", "--is-ancestor", sha, "origin/main"]);

const destination = resolve(".cache/extension-release");
if (existsSync(destination)) {
  throw new Error("Remove .cache/extension-release before collecting");
}
// Attached files are the release: once both exist they are verified on
// their own, so recovery does not depend on CI's expiring artifact.
const missing = missingExtensionAssets(release.assets);
let built: string | undefined;
if (missing.length > 0) {
  const runs = JSON.parse(
    gh(
      "api",
      `repos/${repository}/actions/workflows/ci.yml/runs?head_sha=${sha}&status=success&per_page=100`,
      "--jq",
      ".workflow_runs"
    )
  ) as WorkflowRun[];
  const build = selectReleaseBuild(runs, repository, sha);
  const [artifact] = JSON.parse(
    gh(
      "api",
      `repos/${repository}/actions/runs/${build.id}/artifacts?name=${EXTENSION_BUILD_ARTIFACT}`,
      "--jq",
      ".artifacts"
    )
  ) as { expired: boolean }[];
  if (!artifact || artifact.expired) {
    throw new Error(
      `The VSIX of ${build.html_url} is missing or expired; dispatch CI at ${tag}, then retry`
    );
  }
  const ci = join(destination, "ci");
  mkdirSync(ci, { recursive: true });
  gh(
    "run",
    "download",
    String(build.id),
    "--repo",
    repository,
    "--name",
    EXTENSION_BUILD_ARTIFACT,
    "--dir",
    ci
  );
  built = verifyExtension(ci, version, sha);
  for (const name of missing) {
    gh("release", "upload", tag, join(ci, name), "--repo", repository);
  }
}
const attached = join(destination, "attached");
mkdirSync(attached, { recursive: true });
gh(
  "release",
  "download",
  tag,
  "--repo",
  repository,
  "--dir",
  attached,
  "--pattern",
  "prompts.vsix",
  "--pattern",
  "extension.json"
);
const sha256 = verifyExtension(attached, version, sha);
if (built && built !== sha256) {
  throw new Error("Attached VSIX differs from CI's tested archive");
}
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `sha=${sha}\nsha256=${sha256}\ntag=${tag}\n`
  );
}
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `${missing.length > 0 ? `Attached ${missing.join(", ")} to` : "Verified the existing assets of"} \`${tag}\` (${sha}).\n\nVSIX SHA-256: \`${sha256}\`\n`
  );
}
