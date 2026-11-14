import type { CompilerOptions } from "ts-morph";
import { ts } from "ts-morph";
import type { Boundary } from "./boundary-model";
import { EXCLUDED_DIRS, FIXTURE_DIR, toPosix } from "./boundary-model";
import type { Ignorer } from "./ignore-rules";
import { ignoresAbsolute } from "./ignore-rules";

export interface SourceGlobber {
  globSync(patterns: string[]): string[];
}

export function workspaceSourceGlobs(
  root: string,
  patterns: readonly string[]
): string[] {
  const posixRoot = toPosix(root);
  return (patterns.length > 0 ? patterns : [""]).map((pattern) =>
    pattern === ""
      ? `${posixRoot}/**/*.{ts,tsx}`
      : `${posixRoot}/${pattern}/**/*.{ts,tsx}`
  );
}

export function packageSourceGlobs(boundary: Boundary): string[] {
  return [`${toPosix(boundary.dir)}/**/*.{ts,tsx}`];
}

export function globSources(
  root: string,
  includes: string[],
  fileSystem: SourceGlobber,
  ignorer: Ignorer
): string[] {
  const posixRoot = toPosix(root);
  const excludes = EXCLUDED_DIRS.map(
    (dir) => `!${posixRoot}/**/${dir}/**`
  ).concat(
    `!${posixRoot}/**/${FIXTURE_DIR}/**`,
    `!${posixRoot}/**/*.d.ts`,

    `!${posixRoot}/**/*.config.{ts,tsx,mts,cts}`
  );
  return fileSystem
    .globSync([...includes, ...excludes])
    .filter((file) => !ignoresAbsolute(ignorer, root, file))
    .sort();
}

export function defaultWorkspaceCompilerOptions(): CompilerOptions {
  return {
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    skipLibCheck: true,
    strict: false,
    target: ts.ScriptTarget.ES2022,
  };
}

export function workspaceProgramPaths(
  root: string,
  existing: CompilerOptions,
  aliases: Record<string, string[]>
): Pick<CompilerOptions, "baseUrl" | "paths"> {
  return {
    baseUrl: existing.baseUrl ?? root,
    paths: { ...aliases, ...existing.paths },
  };
}
