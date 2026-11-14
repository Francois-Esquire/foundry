import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ignorer } from "./ignore-rules";
import { createIgnorerFrom } from "./ignore-rules";

export function createIgnorer(root: string): Ignorer {
  return createIgnorerFrom((dir) => {
    const file = join(root, dir, ".gitignore");
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  });
}
