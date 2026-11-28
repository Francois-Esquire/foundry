import { existsSync } from "node:fs";
import { resolve } from "node:path";

export function allowedMountRoots(roots: readonly string[]): string[] {
  return [...new Set(roots.map((root) => resolve(root)))].filter((dir) =>
    existsSync(dir)
  );
}
