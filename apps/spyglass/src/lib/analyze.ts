import type { AnalyzeSurfaceOptions, SurfaceReport } from "./types";

import { analyzeWorkspaceSurfaces } from "./workspace-surface";

/**
 * One package's report, using the batch path. It is the same report a
 * workspace sweep produces.
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
