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
