import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { downloadReleasePackages } from "./download";
import { discoverWorkspaces, packRelease, publicWorkspaces } from "./release";
import {
  resolveGitHubRelease,
  resolvePackage,
  selectReleaseWorkspaces,
} from "./resolve";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  args: process.argv.slice(2),
  options: {
    package: { type: "string" },
    releases: { type: "string" },
    root: { type: "string" },
    version: { type: "string" },
  },
});
const root = values.root
  ? resolve(values.root)
  : resolve(import.meta.dirname, "../../..");

function output(entries: Record<string, string>): void {
  const content = Object.entries(entries)
    .map(([key, value]) => `${key}=${value}\n`)
    .join("");
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, content);
  }
  process.stdout.write(content);
}

const [command] = positionals;
if (command === "resolve") {
  const selected = resolveGitHubRelease(
    root,
    values.package ?? "",
    values.version
  );
  output({
    component: selected.target.component,
    directory: selected.target.directory,
    dist_tag: selected.distTag,
    name: selected.target.name,
    packages: JSON.stringify(selected.packages),
    prerelease: String(selected.release.prerelease),
    release_id: String(selected.release.id),
    releases: JSON.stringify(selected.releases),
    sha: selected.sha,
    tag: selected.release.tag_name,
    version: selected.version,
  });
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `Selected **${selected.target.name}@${selected.version}** from [${selected.release.tag_name}](${selected.release.html_url}).\n\nCommit: \`${selected.sha}\`\n\nRequested npm channel: \`${selected.distTag}\`.\n`
    );
  }
} else if (command === "check" || command === "pack" || command === "fetch") {
  const workspaces = discoverWorkspaces(root);
  const target = values.package ? resolvePackage(values.package) : undefined;
  const packages = target
    ? selectReleaseWorkspaces(workspaces, target, values.version)
    : publicWorkspaces(workspaces);
  if (!target && values.version) {
    throw new Error("An expected version requires --package");
  }
  if (command !== "check") {
    const digests =
      command === "fetch"
        ? downloadReleasePackages(
            root,
            packages,
            JSON.parse(values.releases ?? "[]")
          )
        : packRelease(root, packages);
    output({
      manifest_sha256: createHash("sha256")
        .update(readFileSync(join(root, ".cache/release/packages.json")))
        .digest("hex"),
    });
    if (digests.length === 1 && digests[0]) {
      output({ sha256: digests[0] });
    }
  }
  process.stdout.write(
    `${packages.map(({ manifest }) => `${manifest.name}@${manifest.version}`).join("\n")}\n`
  );
} else {
  throw new Error("Expected check, resolve, pack, or fetch");
}
