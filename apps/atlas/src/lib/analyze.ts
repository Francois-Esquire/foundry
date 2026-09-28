import type { AnalyzeSurfaceOptions, SurfaceReport } from "./types";

import { analyzeWorkspaceSurfaces } from "./workspace-surface";

/**
 * One package's report. Since V12.6 a single-target call into the batch
 * path: package-local analysis of the target, one workspace derivation for
 * it, assembly. The report is the same one a workspace sweep produces.
 */
export async function analyzeSurface(
  options: AnalyzeSurfaceOptions
): Promise<SurfaceReport> {
  const { reports } = await analyzeWorkspaceSurfaces({
    ...(options.root !== undefined && { root: options.root }),
    targets: [options.target],
    ...(options.tsconfig !== undefined && { tsconfig: options.tsconfig }),
    ...(options.config !== undefined && { config: options.config }),
    ...(options.now !== undefined && { now: options.now }),
    ...(options.profile !== undefined && { profile: options.profile }),
  });
  const [report] = reports;
  if (report === undefined) {
    throw new Error(`no report for ${options.target}`);
  }
  return report;
}
