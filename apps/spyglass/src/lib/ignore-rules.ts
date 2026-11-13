import ignore from "ignore";
import { relative } from "#path";

import { toPosix } from "./boundary-model";

// Gitignore answers over a reader of `.gitignore` texts. `ignore.ts` reads
// them from disk; `file-map-preparation.ts` from a recorded file map.

export interface Ignorer {
  /**
   * Whether git would ignore `rel`, a root-relative posix path. Pass a
   * trailing slash to ask about a directory (`dist/`), as gitignore's
   * directory-only patterns never match a bare name.
   */
  ignores(rel: string): boolean;
}

/**
 * Answers gitignore questions from the `.gitignore` texts `readRules`
 * returns for each root-relative posix directory (`""` for the root), the
 * way git resolves them: every file between the root and the path is
 * consulted, the deepest matching rule wins, and an ignored directory hides
 * everything below it. Only files under the root count (no global excludes,
 * no `.git/info/exclude`), so the answer needs no repository.
 */
export function createIgnorerFrom(
  readRules: (dir: string) => string | undefined
): Ignorer {
  const rules = new Map<string, ignore.Ignore | null>();
  const decided = new Map<string, boolean>();

  const rulesAt = (dir: string): ignore.Ignore | null => {
    let found = rules.get(dir);
    if (found === undefined) {
      const text = readRules(dir);
      found = text === undefined ? null : ignore().add(text);
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
    const visitDir = () => {
      verdict = ignoresDir(parent, verdict, rulesAt, rel);
    };
    visitDir();
    decided.set(rel, verdict);
    return verdict;
  };

  return { ignores };
}

function ignoresDir(
  parent: string,
  initialVerdict: boolean,
  rulesAt: (dir: string) => ignore.Ignore | null,
  rel: string
) {
  let verdict = initialVerdict;
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
  return verdict;
}

/** `ignores` for an absolute path under `root`. */
export function ignoresAbsolute(
  ignorer: Ignorer,
  root: string,
  file: string
): boolean {
  return ignorer.ignores(toPosix(relative(root, file)));
}
