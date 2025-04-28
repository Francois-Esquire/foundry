import { promises as fs } from "fs";

import type { Logger, ProjectTypeResult } from "./types";

export async function detectProjectType(
  rootDir: string,
  logger: Logger,
): Promise<ProjectTypeResult> {
  const files = await fs.readdir(rootDir);
  const details: Record<string, boolean> = {
    hasPackageJson: files.includes("package.json"),
    hasBunConfig: files.includes("bun.lockb") || files.includes("bunfig.toml"),
    hasYarnLock: files.includes("yarn.lock"),
    hasPnpmLock: files.includes("pnpm-lock.yaml"),
    hasNpmLock: files.includes("package-lock.json"),
    hasTsConfig: files.includes("tsconfig.json"),
  };
  let type = "unknown";
  if (details.hasPackageJson) type = "node";
  if (details.hasBunConfig) type = "bun";
  return { type, details };
}
