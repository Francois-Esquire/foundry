import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { discoverWorkspaces, packRelease, publicWorkspaces } from "./release";
import {
  resolveGitHubRelease,
  resolvePackage,
  validatePackageVersion,
} from "./resolve";

const root = resolve(import.meta.dirname, "../../..");
const { values, positionals } = parseArgs({
  allowPositionals: true,
  args: process.argv.slice(2),
  options: { package: { type: "string" }, version: { type: "string" } },
});

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
    prerelease: String(selected.release.prerelease),
    release_id: String(selected.release.id),
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
} else if (command === "check" || command === "pack") {
  const publicPackages = publicWorkspaces(discoverWorkspaces(root));
  const target = values.package ? resolvePackage(values.package) : undefined;
  const packages = target
    ? publicPackages.filter(({ manifest }) => manifest.name === target.name)
    : publicPackages;
  if (target) {
    const [pkg] = packages;
    if (!pkg || pkg.directory !== target.directory) {
      throw new Error(
        `Missing public package ${target.name} at ${target.directory}`
      );
    }
    validatePackageVersion(
      pkg.manifest,
      target,
      values.version ?? pkg.manifest.version
    );
  } else if (values.version) {
    throw new Error("An expected version requires --package");
  }
  if (command === "pack") {
    const digests = packRelease(root, packages);
    if (digests.length === 1 && digests[0]) {
      output({ sha256: digests[0] });
    }
  }
  process.stdout.write(
    `${packages.map(({ manifest }) => `${manifest.name}@${manifest.version}`).join("\n")}\n`
  );
} else {
  throw new Error("Expected check, resolve, or pack");
}
