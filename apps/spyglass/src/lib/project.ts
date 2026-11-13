import { resolve } from "node:path";

import { Project } from "ts-morph";
import { workspacePathAliases, workspacePatterns } from "./boundary";
import type { Boundary } from "./boundary-model";
import { createIgnorer } from "./ignore";
import {
  defaultWorkspaceCompilerOptions,
  globSources,
  packageSourceGlobs,
  workspaceProgramPaths,
  workspaceSourceGlobs,
} from "./source-files";

/** The shared workspace program: every workspace source, every package alias. */
export function createProject(root: string, tsconfig?: string): Project {
  const project = tsconfig
    ? new Project({
        skipAddingFilesFromTsConfig: true,
        tsConfigFilePath: resolve(root, tsconfig),
      })
    : new Project({ compilerOptions: defaultWorkspaceCompilerOptions() });

  project.compilerOptions.set(
    workspaceProgramPaths(
      root,
      project.getCompilerOptions(),
      workspacePathAliases(root)
    )
  );

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
  return globSources(
    root,
    workspaceSourceGlobs(root, workspacePatterns(root)),
    project.getFileSystem(),
    createIgnorer(root)
  );
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
  return globSources(
    root,
    packageSourceGlobs(boundary),
    project.getFileSystem(),
    createIgnorer(root)
  );
}
