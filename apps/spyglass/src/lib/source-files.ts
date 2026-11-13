import type { CompilerOptions } from "ts-morph";
import { ts } from "ts-morph";
import type { Boundary } from "./boundary-model";
import { EXCLUDED_DIRS, FIXTURE_DIR, toPosix } from "./boundary-model";
import type { Ignorer } from "./ignore-rules";
import { ignoresAbsolute } from "./ignore-rules";

// Which TypeScript sources the analyzer loads and how the shared program is
// configured: the include globs for a workspace or one package, the shared
// excludes and the gitignore filter, the default compiler options and the
// workspace alias merge.
// The glob itself is a ts-morph file system's: fast-glob on the native
// file system, minimatch over an in-memory one.

/** The one file-system question source enumeration asks. */
export interface SourceGlobber {
  globSync(patterns: string[]): string[];
}

/** Include globs for every workspace source below `root`. */
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

/** Include globs for the sources below one boundary. */
export function packageSourceGlobs(boundary: Boundary): string[] {
  return [`${toPosix(boundary.dir)}/**/*.{ts,tsx}`];
}

/**
 * The sources `includes` match, absolute and sorted, minus generated
 * directories, fixtures, declaration files, tooling configuration and
 * gitignored paths.
 */
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
    // tooling configuration is not part of a package's semantic surface;
    // keep in step with EXCLUDE_PATTERNS in module-graph.ts
    `!${posixRoot}/**/*.config.{ts,tsx,mts,cts}`
  );
  return fileSystem
    .globSync([...includes, ...excludes])
    .filter((file) => !ignoresAbsolute(ignorer, root, file))
    .sort();
}

/** The shared program's compiler options when no tsconfig is given. */
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

/**
 * The shared program's `baseUrl` and `paths`: the tsconfig's own when it
 * sets them, else the root, with every workspace alias the tsconfig does not
 * override.
 */
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
