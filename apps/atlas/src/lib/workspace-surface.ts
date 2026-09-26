import * as fs from "node:fs";
import * as path from "node:path";
import { assembleSurfaceReport } from "./assemble";
import { findRepoRoot } from "./boundary";
import type { AnalysisConfig } from "./config";
import { analyzePackageLocal } from "./package-local";
import type { PackageLocalReport } from "./package-local-types";
import type { AnalysisProfile, SurfaceReport } from "./types";
import { deriveWorkspaceSurface } from "./workspace-derive";
import type { WorkspaceSurfaceDerivation } from "./workspace-derive-types";

// V12.6 batch orchestrator: package-local analysis per target, one
// workspace derivation, one assembly per target. This is the only path that
// produces a SurfaceReport; `analyzeSurface` is a single-target call into
// it, and the materializer runs the same three steps with caching between.

export interface AnalyzeWorkspaceSurfacesOptions {
  config?: AnalysisConfig;
  /** Already-analyzed local reports, by target as given; the rest are analyzed here. */
  locals?: Map<string, PackageLocalReport>;
  now?: Date;
  profile?: AnalysisProfile;
  root?: string;
  /** Directory paths (relative to root) or workspace package names. */
  targets: string[];
  tsconfig?: string;
}

export interface WorkspaceSurfaces {
  derivation: WorkspaceSurfaceDerivation;
  locals: PackageLocalReport[];
  reports: SurfaceReport[];
}

export async function analyzeWorkspaceSurfaces(
  options: AnalyzeWorkspaceSurfacesOptions
): Promise<WorkspaceSurfaces> {
  const root = fs.realpathSync(
    options.root ? path.resolve(options.root) : findRepoRoot(process.cwd())
  );
  const locals = options.targets.map(
    (target) =>
      options.locals?.get(target) ??
      analyzePackageLocal({
        root,
        target,
        ...(options.config !== undefined && { config: options.config }),
        ...(options.tsconfig !== undefined && { tsconfig: options.tsconfig }),
      })
  );
  const derivation = await deriveWorkspaceSurface(locals, {
    root,
    ...(options.now !== undefined && { now: options.now }),
    ...(options.profile !== undefined && { profile: options.profile }),
    ...(options.config !== undefined && { config: options.config }),
    ...(options.tsconfig !== undefined && { tsconfig: options.tsconfig }),
  });
  const reports = locals.map((local) => {
    const derived = derivation.packages[local.package.path];
    if (derived === undefined) {
      throw new Error(`no derived facts for ${local.package.path}`);
    }
    return assembleSurfaceReport(local, derived);
  });
  return { derivation, locals, reports };
}
