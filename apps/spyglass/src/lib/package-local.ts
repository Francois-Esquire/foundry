import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  boundaryEntrypoints,
  findRepoRoot,
  ownerBoundary,
  packagePathAliases,
  resolveBoundary,
} from "./boundary";
import { ownerResult } from "./boundary-model";
import type { AnalysisConfig } from "./config";
import type { PreparedPackageSource } from "./package-local-analysis";
import {
  analyzePreparedPackageLocal,
  tsconfigPathsInto,
} from "./package-local-analysis";
import type { PackageLocalReport } from "./package-local-types";
import { packageSourceFiles } from "./project";

export interface AnalyzePackageLocalOptions {
  config?: AnalysisConfig;
  root?: string;
  target: string;

  tsconfig?: string;
}

const readText = (file: string): string => readFileSync(file, "utf8");

export function preparePackageLocalSource(
  options: Omit<AnalyzePackageLocalOptions, "config">
): PreparedPackageSource {
  const root = realpathSync(
    options.root ? resolve(options.root) : findRepoRoot(process.cwd())
  );
  const boundary = resolveBoundary(root, options.target);
  const ownTsconfig = join(boundary.dir, "tsconfig.json");
  return {
    boundary,
    compilerPaths: {
      ...packagePathAliases(boundary.dir),
      ...(existsSync(ownTsconfig) &&
        tsconfigPathsInto(root, ownTsconfig, boundary, readText)),
      ...(options.tsconfig !== undefined &&
        tsconfigPathsInto(root, options.tsconfig, boundary, readText)),
    },
    entrypoints: boundaryEntrypoints(boundary),
    files: packageSourceFiles(root, boundary).map((path) => ({
      ...ownerResult((file) => ownerBoundary(root, file), path),
      path,
      text: readFileSync(path, "utf8"),
    })),
    root,
  };
}

export function analyzePackageLocal(
  options: AnalyzePackageLocalOptions
): PackageLocalReport {
  return analyzePreparedPackageLocal(
    preparePackageLocalSource(options),
    options.config
  );
}
