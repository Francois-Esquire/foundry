import * as fs from "node:fs";
import * as path from "node:path";

import ignore from "ignore";

import { toPosix } from "./boundary";

export interface Ignorer {
  /**
   * Whether git would ignore `rel`, a root-relative posix path. Pass a
   * trailing slash to ask about a directory (`dist/`), as gitignore's
   * directory-only patterns never match a bare name.
   */
  ignores(rel: string): boolean;
}

/**
 * Answers gitignore questions for a checkout rooted at `root` from the
 * `.gitignore` files on disk, the way git resolves them: every file between
 * the root and the path is consulted, the deepest matching rule wins, and an
 * ignored directory hides everything below it. Only files under `root` count
 * (no global excludes, no `.git/info/exclude`), so the answer is the same on
 * every machine and needs no repository.
 */
export function createIgnorer(root: string): Ignorer {
  const rules = new Map<string, ignore.Ignore | null>();
  const decided = new Map<string, boolean>();

  const rulesAt = (dir: string): ignore.Ignore | null => {
    let found = rules.get(dir);
    if (found === undefined) {
      const file = path.join(root, dir, ".gitignore");
      found = fs.existsSync(file)
        ? ignore().add(fs.readFileSync(file, "utf8"))
        : null;
      rules.set(dir, found);
    }
    return found;
  };

  const ignores = (rel: string): boolean => {
    if (rel === "" || rel === "/") {
      return false;
    }
    const known = decided.get(rel);
    if (known !== undefined) {
      return known;
    }
    const trimmed = rel.endsWith("/") ? rel.slice(0, -1) : rel;
    const cut = trimmed.lastIndexOf("/");
    const parent = cut === -1 ? "" : trimmed.slice(0, cut);
    let verdict = parent !== "" && ignores(`${parent}/`);
    for (let dir = parent; !verdict; ) {
      const file = rulesAt(dir);
      if (file !== null) {
        const result = file.test(dir === "" ? rel : rel.slice(dir.length + 1));
        if (result.ignored || result.unignored) {
          verdict = result.ignored;
          break;
        }
      }
      if (dir === "") {
        break;
      }
      const up = dir.lastIndexOf("/");
      dir = up === -1 ? "" : dir.slice(0, up);
    }
    decided.set(rel, verdict);
    return verdict;
  };

  return { ignores };
}

/** `ignores` for an absolute path under `root`. */
export function ignoresAbsolute(
  ignorer: Ignorer,
  root: string,
  file: string
): boolean {
  return ignorer.ignores(toPosix(path.relative(root, file)));
}
