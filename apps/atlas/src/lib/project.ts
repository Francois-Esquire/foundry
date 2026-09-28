import { resolve } from "node:path";

import { Project, ts } from "ts-morph";

import type { Boundary } from "./boundary";

import {
  EXCLUDED_DIRS,
  FIXTURE_DIR,
  toPosix,
  workspacePathAliases,
  workspacePatterns,
} from "./boundary";
import { createIgnorer, ignoresAbsolute } from "./ignore";

/** The shared workspace program: every workspace source, every package alias. */
export function createProject(root: string, tsconfig?: string): Project {
  const project = tsconfig
    ? new Project({
        skipAddingFilesFromTsConfig: true,
        tsConfigFilePath: resolve(root, tsconfig),
      })
    : new Project({
        compilerOptions: {
          jsx: ts.JsxEmit.ReactJSX,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          skipLibCheck: true,
          strict: false,
          target: ts.ScriptTarget.ES2022,
        },
      });

  const existing = project.getCompilerOptions();
  project.compilerOptions.set({
    baseUrl: existing.baseUrl ?? root,
    paths: { ...workspacePathAliases(root), ...existing.paths },
  });

  project.addSourceFilesAtPaths(workspaceSourceFiles(root, project));
  return project;
}

/**
 * Every TypeScript source the analyzer loads for a workspace, absolute and
 * sorted: the workspace patterns minus generated directories, fixtures,
 * declaration files, tooling configuration, and gitignored paths. The V12.5
 * fingerprint enumerates through the same function, so the two can't drift.
 */
export function workspaceSourceFiles(
  root: string,
  project: Project = new Project({ skipFileDependencyResolution: true })
): string[] {
  const posixRoot = toPosix(root);
  const patterns = workspacePatterns(root);
  const includes = (patterns.length > 0 ? patterns : [""]).map((pattern) =>
    pattern === ""
      ? `${posixRoot}/**/*.{ts,tsx}`
      : `${posixRoot}/${pattern}/**/*.{ts,tsx}`
  );
  return globSources(root, includes, project);
}

/**
 * The package-owned subset of `workspaceSourceFiles`: the same rules applied
 * below the boundary directory alone. This is the one definition of "package
 * semantic input" — local analysis, the local fingerprint, and the leak tests
 * all enumerate through it.
 */
export function packageSourceFiles(
  root: string,
  boundary: Boundary,
  project: Project = new Project({ skipFileDependencyResolution: true })
): string[] {
  return globSources(root, [`${toPosix(boundary.dir)}/**/*.{ts,tsx}`], project);
}

function globSources(
  root: string,
  includes: string[],
  project: Project
): string[] {
  const posixRoot = toPosix(root);
  const excludes = EXCLUDED_DIRS.map(
    (dir) => `!${posixRoot}/**/${dir}/**`
  ).concat(
    `!${posixRoot}/**/${FIXTURE_DIR}/**`,
    `!${posixRoot}/**/*.d.ts`,
    // tooling configuration is not part of a package's semantic surface;
    // keep in step with EXCLUDE_PATTERNS in dependencies.ts
    `!${posixRoot}/**/*.config.{ts,tsx,mts,cts}`
  );
  const ignorer = createIgnorer(root);
  return project
    .getFileSystem()
    .globSync([...includes, ...excludes])
    .filter((file) => !ignoresAbsolute(ignorer, root, file))
    .sort();
}
