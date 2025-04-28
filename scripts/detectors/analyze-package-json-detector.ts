import { promises as fs } from "fs";
import path from "path";

import type { AnalyzePackageJsonResult, Logger } from "./types";

export async function analyzePackageJson(
  rootDir: string,
  logger: Logger,
): Promise<AnalyzePackageJsonResult> {
  const warnings: string[] = [];
  let pkg: unknown = null;
  let pkgPath = path.join(rootDir, "package.json");
  let dependencies: Record<string, string> = {},
    devDependencies: Record<string, string> = {},
    peerDependencies: Record<string, string> = {},
    optionalDependencies: Record<string, string> = {},
    scripts: Record<string, string> = {},
    engines: Record<string, string> = {},
    frameworks: string[] = [];
  let typescript = false;
  let detectedRunner = "unknown";
  let lockFiles: string[] = [];

  // Scan for lock files
  const files = await fs.readdir(rootDir);
  if (files.includes("package-lock.json")) lockFiles.push("package-lock.json");
  if (files.includes("yarn.lock")) lockFiles.push("yarn.lock");
  if (files.includes("pnpm-lock.yaml")) lockFiles.push("pnpm-lock.yaml");
  if (files.includes("bun.lockb")) lockFiles.push("bun.lockb");

  // Detect ambiguity in lock files
  if (lockFiles.length > 1) {
    const msg = `Multiple lock files detected: ${lockFiles.join(", ")}`;
    warnings.push(msg);
    logger.warn(msg);
  }

  // Try to read and parse package.json
  try {
    const pkgRaw = await fs.readFile(pkgPath, "utf8");
    pkg = JSON.parse(pkgRaw);
    // Defensive: Only assign if type is object
    if (typeof pkg === "object" && pkg !== null) {
      const obj = pkg as Record<string, unknown>;
      dependencies =
        typeof obj.dependencies === "object" && obj.dependencies !== null
          ? (obj.dependencies as Record<string, string>)
          : {};
      devDependencies =
        typeof obj.devDependencies === "object" && obj.devDependencies !== null
          ? (obj.devDependencies as Record<string, string>)
          : {};
      peerDependencies =
        typeof obj.peerDependencies === "object" &&
        obj.peerDependencies !== null
          ? (obj.peerDependencies as Record<string, string>)
          : {};
      optionalDependencies =
        typeof obj.optionalDependencies === "object" &&
        obj.optionalDependencies !== null
          ? (obj.optionalDependencies as Record<string, string>)
          : {};
      scripts =
        typeof obj.scripts === "object" && obj.scripts !== null
          ? (obj.scripts as Record<string, string>)
          : {};
      engines =
        typeof obj.engines === "object" && obj.engines !== null
          ? (obj.engines as Record<string, string>)
          : {};
    }
    // Detect frameworks/tools
    const allDeps = { ...dependencies, ...devDependencies };
    if (allDeps["react"]) frameworks.push("react");
    if (allDeps["next"]) frameworks.push("next");
    if (allDeps["express"]) frameworks.push("express");
    if (allDeps["vue"]) frameworks.push("vue");
    if (allDeps["svelte"]) frameworks.push("svelte");
    if (allDeps["@nestjs/core"]) frameworks.push("nestjs");
    if (allDeps["typescript"]) typescript = true;
    if (files.includes("tsconfig.json")) typescript = true;
    // Detect runner
    if (lockFiles.includes("bun.lockb")) detectedRunner = "bun";
    else if (lockFiles.includes("yarn.lock")) detectedRunner = "yarn";
    else if (lockFiles.includes("pnpm-lock.yaml")) detectedRunner = "pnpm";
    else if (lockFiles.includes("package-lock.json")) detectedRunner = "npm";
    // Check for engines field
    if (engines.bun) detectedRunner = "bun";
    else if (engines.yarn) detectedRunner = "yarn";
    else if (engines.pnpm) detectedRunner = "pnpm";
    else if (engines.npm) detectedRunner = "npm";
    // Check scripts for runner usage
    const scriptStr = JSON.stringify(scripts);
    if (/bun /.test(scriptStr)) detectedRunner = "bun";
    else if (/yarn /.test(scriptStr)) detectedRunner = "yarn";
    else if (/pnpm /.test(scriptStr)) detectedRunner = "pnpm";
    else if (/npm /.test(scriptStr)) detectedRunner = "npm";
  } catch (err: any) {
    const msg = "Could not read or parse package.json: " + err.message;
    warnings.push(msg);
    logger.error(msg);
  }

  return {
    dependencies,
    devDependencies,
    peerDependencies,
    optionalDependencies,
    scripts,
    engines,
    detectedRunner,
    lockFiles,
    frameworks,
    typescript,
    warnings,
  };
}
