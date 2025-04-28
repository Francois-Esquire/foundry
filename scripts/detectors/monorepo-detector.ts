import { promises as fs } from "fs";
import path from "path";

import type { Logger, MonorepoDetectionResult } from "./types";

export async function detectMonorepo(
  rootDir: string,
  logger: Logger,
): Promise<MonorepoDetectionResult> {
  const warnings: string[] = [];
  let isMonorepo = false;
  let workspaces: string[] = [];
  let tools: string[] = [];
  // Check package.json workspaces
  try {
    const pkgPath = path.join(rootDir, "package.json");
    const pkgRaw = await fs.readFile(pkgPath, "utf8");
    const pkg: unknown = JSON.parse(pkgRaw);
    if (pkg && typeof pkg === "object" && "workspaces" in pkg) {
      const ws = (pkg as { workspaces?: unknown }).workspaces;
      isMonorepo = true;
      tools.push("npm/yarn workspaces");
      if (Array.isArray(ws)) {
        workspaces = ws.filter((w): w is string => typeof w === "string");
      } else if (ws && typeof ws === "object" && "packages" in ws) {
        const pkgs = (ws as { packages?: unknown }).packages;
        if (Array.isArray(pkgs)) {
          workspaces = pkgs.filter((w): w is string => typeof w === "string");
        }
      }
    }
  } catch (err) {
    // ignore if no package.json
  }
  // Check for lerna.json
  try {
    const lernaPath = path.join(rootDir, "lerna.json");
    const lernaRaw = await fs.readFile(lernaPath, "utf8");
    const lerna: unknown = JSON.parse(lernaRaw);
    isMonorepo = true;
    tools.push("lerna");
    if (lerna && typeof lerna === "object" && "packages" in lerna) {
      const pkgs = (lerna as { packages?: unknown }).packages;
      if (Array.isArray(pkgs)) {
        workspaces = workspaces.concat(
          pkgs.filter((w): w is string => typeof w === "string"),
        );
      }
    }
  } catch (err) {
    // ignore if no lerna.json
  }
  // Check for turbo.json
  try {
    const turboPath = path.join(rootDir, "turbo.json");
    await fs.access(turboPath);
    isMonorepo = true;
    tools.push("turborepo");
  } catch (err) {
    // ignore if no turbo.json
  }
  // Check for nx.json
  try {
    const nxPath = path.join(rootDir, "nx.json");
    await fs.access(nxPath);
    isMonorepo = true;
    tools.push("nx");
  } catch (err) {
    // ignore if no nx.json
  }
  if (isMonorepo && workspaces.length === 0) {
    warnings.push("Monorepo detected but no workspaces found");
  }
  return { isMonorepo, workspaces, tools, warnings };
}
