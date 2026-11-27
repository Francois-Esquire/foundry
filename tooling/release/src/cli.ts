import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DAEMON_TARGETS, readDaemonVersion } from "./daemon";
import {
  collectReleaseBuild,
  downloadDaemonPackages,
  downloadReleasePackages,
} from "./download";
import {
  discoverWorkspaces,
  packDaemonRelease,
  packRelease,
  publicWorkspaces,
} from "./release";
import {
  resolveGitHubRelease,
  resolvePackage,
  selectReleaseWorkspaces,
} from "./resolve";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  args: process.argv.slice(2),
  options: {
    "daemon-binaries": { type: "string" },
    package: { type: "string" },
    packages: { type: "string" },
    releases: { type: "string" },
    root: { type: "string" },
    sha: { type: "string" },
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
      `Selected **${selected.target.name}@${selected.version}** from [${selected.release.tag_name}](${selected.release.html_url}).\n\nCommit: \`${selected.sha}\`\n`
    );
  }
} else if (command === "collect") {
  const collected = collectReleaseBuild(
    root,
    values.sha ?? "",
    JSON.parse(values.packages ?? "[]")
  );
  process.stdout.write(
    `${collected.map(({ name, version }) => `${name}@${version}`).join("\n")}\n`
  );
} else if (command === "check" || command === "pack" || command === "fetch") {
  const daemonBinariesDir =
    values["daemon-binaries"] ?? process.env.DAEMON_BINARIES_DIR;
  const target = values.package ? resolvePackage(values.package) : undefined;
  if (!target && values.version) {
    throw new Error("An expected version requires --package");
  }
  if (target?.component === "marbles-daemon") {
    const version = readDaemonVersion(root);
    if (values.version && version !== values.version) {
      throw new Error(
        `marbles-daemon version must be ${values.version} (found ${version})`
      );
    }
    if (command === "pack") {
      if (!daemonBinariesDir) {
        throw new Error(
          "--daemon-binaries or DAEMON_BINARIES_DIR is required to pack marbles-daemon"
        );
      }
      packDaemonRelease(root, daemonBinariesDir, values.version);
    } else if (command === "fetch") {
      downloadDaemonPackages(
        root,
        values.version ?? version,
        JSON.parse(values.releases ?? "[]")
      );
    }
    if (command !== "check") {
      output({
        manifest_sha256: createHash("sha256")
          .update(readFileSync(join(root, ".cache/release/packages.json")))
          .digest("hex"),
      });
    }
    process.stdout.write(
      `${DAEMON_TARGETS.map(({ name }) => `${name}@${version}`).join("\n")}\n`
    );
  } else {
    const workspaces = discoverWorkspaces(root);
    const packages = target
      ? selectReleaseWorkspaces(workspaces, target, values.version)
      : publicWorkspaces(workspaces);
    const daemonVersion = target ? undefined : readDaemonVersion(root);
    if (command !== "check") {
      const digests =
        command === "fetch"
          ? downloadReleasePackages(
              root,
              packages,
              JSON.parse(values.releases ?? "[]")
            )
          : packRelease(root, packages, {
              daemonBinariesDir: target ? undefined : daemonBinariesDir,
            });
      output({
        manifest_sha256: createHash("sha256")
          .update(readFileSync(join(root, ".cache/release/packages.json")))
          .digest("hex"),
      });
      if (digests.length === 1 && digests[0]) {
        output({ sha256: digests[0] });
      }
    }
    const lines = [
      ...(daemonVersion && (command === "check" || daemonBinariesDir)
        ? DAEMON_TARGETS.map(({ name }) => `${name}@${daemonVersion}`)
        : []),
      ...packages.map(({ manifest }) => `${manifest.name}@${manifest.version}`),
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
  }
} else {
  throw new Error("Expected check, resolve, pack, fetch, or collect");
}
