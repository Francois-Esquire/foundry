import { cruise } from "dependency-cruiser";
import type { CruisedModule } from "./module-graph";
import { EXCLUDE_PATTERNS } from "./module-graph";

// The one dependency-cruiser invocation every module graph comes from: a
// native workspace on disk (`dependencies.ts`) and a file map in the
// isolated engine's private volume (`file-map-cruise-engine.ts`). Both pass
// the same options, so the two graphs differ only in the bytes and the
// tsconfig they cruise.

/**
 * Cruise `entries` (root-relative) under `root` with Spyglass's options:
 * node_modules is resolved but not followed, `EXCLUDE_PATTERNS` are left
 * out, `tsconfigFile` drives path resolution and `transpileTsConfig`
 * (a parsed tsconfig, or `{ options }`) the extractor. Entries that do not
 * exist are skipped by the caller.
 */
export async function cruiseEntries(
  root: string,
  entries: readonly string[],
  tsconfigFile: string,
  transpileTsConfig: unknown
): Promise<CruisedModule[]> {
  const result = await cruise(
    [...entries],
    {
      baseDir: root,
      doNotFollow: { path: "node_modules" },
      exclude: { path: EXCLUDE_PATTERNS },
      tsConfig: { fileName: tsconfigFile },
      tsPreCompilationDeps: true,
    },
    undefined,
    { tsConfig: transpileTsConfig }
  );
  if (typeof result.output === "string") {
    throw new Error("dependency-cruiser returned an unexpected string output");
  }
  return result.output.modules;
}
