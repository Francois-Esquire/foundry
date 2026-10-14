import { execFileSync } from "node:child_process";
import type { Commit } from "release-please";
import type { Workspace } from "./release";

export function bundledPaths(
  directory: string,
  workspaces: Workspace[]
): string[] {
  const app = workspaces.find((workspace) => workspace.directory === directory);
  if (!app) {
    throw new Error(`Missing release workspace: ${directory}`);
  }
  const byName = new Map(
    workspaces.map((workspace) => [workspace.manifest.name, workspace])
  );
  const paths = new Set([directory]);
  function visit(dependencies: Record<string, string>): void {
    for (const name of Object.keys(dependencies)) {
      const workspace = byName.get(name);
      if (
        !workspace?.directory.startsWith("packages/") ||
        paths.has(workspace.directory)
      ) {
        continue;
      }
      paths.add(workspace.directory);
      visit({
        ...workspace.manifest.dependencies,
        ...workspace.manifest.optionalDependencies,
      });
    }
  }
  visit({ ...app.manifest.devDependencies, ...app.manifest.dependencies });
  return [...paths];
}

export function readReleaseCommits(
  root: string,
  paths: string[],
  since?: string
): Commit[] {
  const history = execFileSync(
    "git",
    [
      "log",
      "--format=%H%x00%B%x00",
      "--topo-order",
      since ? `${since}..HEAD` : "HEAD",
      "--",
      ...paths,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  const fields = history.split("\0");
  const commits: Commit[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const sha = fields[index]?.trim();
    const message = fields[index + 1]?.trim();
    if (sha && message) {
      commits.push({ message, sha });
    }
  }
  return commits;
}
