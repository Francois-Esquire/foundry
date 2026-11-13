import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Ignorer } from "./ignore-rules";
import { createIgnorerFrom } from "./ignore-rules";

/**
 * Answers gitignore questions for a checkout rooted at `root` from the
 * `.gitignore` files on disk (see `createIgnorerFrom`). Only files under
 * `root` count, so the answer is the same on every machine and needs no
 * repository.
 */
export function createIgnorer(root: string): Ignorer {
  return createIgnorerFrom((dir) => {
    const file = join(root, dir, ".gitignore");
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  });
}
