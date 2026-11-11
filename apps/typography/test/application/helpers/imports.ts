/** Following imports through the source, for the tests that guard a boundary. */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const SRC = path.join(import.meta.dirname, "../../../src");

const IMPORT = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
const ENDINGS = ["", ".ts", ".tsx", "/index.ts"];

const fileFor = (from: string, specifier: string): string | undefined => {
  let base: string | undefined;
  if (specifier.startsWith("~/")) {
    base = path.join(SRC, specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    base = path.join(path.dirname(from), specifier);
  }
  if (base === undefined) {
    return;
  }
  const clean = base.split("?")[0] ?? base;
  return ENDINGS.map((ending) => `${clean}${ending}`).find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile()
  );
};

/** What one module imports itself: the source files, and the packages by name. */
export const importsOf = (file: string) => {
  const files: string[] = [];
  const packages: string[] = [];
  for (const [, specifier = ""] of readFileSync(file, "utf8").matchAll(
    IMPORT
  )) {
    const next = fileFor(file, specifier);
    if (next) {
      files.push(next);
    } else if (!(specifier.startsWith(".") || specifier.startsWith("~/"))) {
      packages.push(specifier);
    }
  }
  return { files, packages };
};

/** Every module reachable from a file, and every package named on the way. */
export const reach = (entry: string) => {
  const files = new Set<string>();
  const packages = new Set<string>();
  const waiting = [entry];
  for (let file = waiting.pop(); file; file = waiting.pop()) {
    if (files.has(file)) {
      continue;
    }
    files.add(file);
    if (!(file.endsWith(".ts") || file.endsWith(".tsx"))) {
      continue;
    }
    const found = importsOf(file);
    waiting.push(...found.files);
    for (const name of found.packages) {
      packages.add(name);
    }
  }
  return { files, packages };
};

/** A source file as the tests name it: src/application/places.ts. */
export const named = (file: string) => `src/${path.relative(SRC, file)}`;

export const relative = (files: Iterable<string>) => [...files].map(named);

/** Every TypeScript module under a directory of the source, by its path on disk. */
export const modulesUnder = (directory: string): string[] =>
  readdirSync(path.join(SRC, directory), {
    recursive: true,
    withFileTypes: true,
  })
    .filter(
      (entry) =>
        entry.isFile() &&
        (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
    )
    .map((entry) => path.join(entry.parentPath, entry.name));
