import { promises as fs } from "fs";
import path from "path";

import type { Logger, TraverseFileSystemResult } from "./types";

export async function traverseFileSystem(
  dir: string,
  include: (relPath: string, entry: import("fs").Dirent) => boolean,
  rootDir: string,
  ignoredPaths: string[],
  logger: Logger,
): Promise<string[]> {
  let results: string[] = [];
  const list = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of list) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(rootDir, fullPath);
    // Always skip the .git directory itself
    if (relPath === ".git" || relPath.startsWith(".git/")) continue;
    // Always ignore node_modules
    if (relPath === "node_modules" || relPath.startsWith("node_modules/")) {
      ignoredPaths.push(relPath);
      continue;
    }
    if (!include(relPath, entry)) {
      ignoredPaths.push(relPath);
      continue;
    }
    results.push(fullPath);
    if (entry.isDirectory()) {
      const subResults = await traverseFileSystem(
        fullPath,
        include,
        rootDir,
        ignoredPaths,
        logger,
      );
      results = results.concat(subResults);
    }
  }
  return results;
}
