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
    paths: { ...workspacePathAliases(root), ...existing.paths },
  });

  project.addSourceFilesAtPaths(workspaceSourceFiles(root, project));
  return project;
}

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
    `!${posixRoot}/**/*.config.{ts,tsx,mts,cts}`
  );
  const ignorer = createIgnorer(root);
  return project
    .getFileSystem()
    .globSync([...includes, ...excludes])
    .filter((file) => !ignoresAbsolute(ignorer, root, file))
    .sort();
}
