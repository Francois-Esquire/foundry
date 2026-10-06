import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

export const DEFAULT_SOURCE = "./.foundry/marbles";
const MODULE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]);
const DECLARATION_FILE = /\.d\.(?:ts|mts|cts)$/;

export function isModulePath(path: string): boolean {
  return MODULE_EXTENSIONS.has(extname(path));
}

/** Discovery belongs to the CLI host, never the engine. Symlinks are not followed. */
export function sourceFiles(path: string): readonly string[] | undefined {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    return undefined;
  }
  if (statSync(absolute).isFile()) {
    return [absolute];
  }
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (
        entry.name.startsWith("_") ||
        entry.name.startsWith(".") ||
        entry.name === "node_modules"
      ) {
        continue;
      }
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(file);
      } else if (
        entry.isFile() &&
        MODULE_EXTENSIONS.has(extname(file)) &&
        !DECLARATION_FILE.test(file)
      ) {
        files.push(file);
      }
    }
  };
  visit(absolute);
  return files.sort();
}

/** Conventional authoring folders operate on the project above .foundry. */
export function sourceRoot(path: string): string {
  const absolute = resolve(path);
  const isDirectory = existsSync(absolute) && statSync(absolute).isDirectory();
  const directory =
    isDirectory || !isModulePath(absolute) ? absolute : dirname(absolute);
  let ancestor = directory;
  while (dirname(ancestor) !== ancestor) {
    if (
      basename(ancestor) === "marbles" &&
      basename(dirname(ancestor)) === ".foundry"
    ) {
      return dirname(dirname(ancestor));
    }
    ancestor = dirname(ancestor);
  }
  return isDirectory ? absolute : dirname(absolute);
}

/** Existing single-file consumers remain available through --config. */
export function resolveSource(path: string): string {
  const absolute = resolve(path);
  const legacy = resolve("marbles.config.ts");
  return path === DEFAULT_SOURCE && !existsSync(absolute) && existsSync(legacy)
    ? legacy
    : absolute;
}
