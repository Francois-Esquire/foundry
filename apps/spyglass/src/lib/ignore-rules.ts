import ignore from "ignore";
import { relative } from "#path";

import { toPosix } from "./boundary-model";

export interface Ignorer {
  ignores(rel: string): boolean;
}

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

export function ignoresAbsolute(
  ignorer: Ignorer,
  root: string,
  file: string
): boolean {
  return ignorer.ignores(toPosix(relative(root, file)));
}
