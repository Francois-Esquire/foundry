import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Update } from "release-please/build/src/update";
import { discoverWorkspaces } from "./release";

export function buildReleaseLockfile(root: string, updates: Update[]): string {
  const directory = mkdtempSync(join(tmpdir(), "foundry-release-lock-"));
  try {
    const manifests = [
      "package.json",
      ...discoverWorkspaces(root).map(
        (workspace) => `${workspace.directory}/package.json`
      ),
    ];
    for (const path of [...manifests, "bun.lock", "bunfig.toml"]) {
      const source = join(root, path);
      if (!existsSync(source)) {
        continue;
      }
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      copyFileSync(source, join(directory, path));
    }
    for (const update of updates) {
      if (manifests.includes(update.path)) {
        const path = join(directory, update.path);
        writeFileSync(
          path,
          update.updater.updateContent(readFileSync(path, "utf8"))
        );
      }
    }
    // Only manifests are copied; no repository source, credentials, or lifecycle scripts run.
    execFileSync("bun", ["install", "--lockfile-only", "--ignore-scripts"], {
      cwd: directory,
      env: {
        ...process.env,
        GH_TOKEN: undefined,
        GITHUB_TOKEN: undefined,
        NODE_AUTH_TOKEN: undefined,
        NPM_TOKEN: undefined,
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    return readFileSync(join(directory, "bun.lock"), "utf8");
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
}
